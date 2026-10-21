"""M3 non-GPU tests: the real engine wired through the API app layer.

These tests construct a REAL QueenEngine (safe: importing/constructing it
never imports torch and never loads the model) but replace the in-worker
``_bootstrap`` / ``_analyze_impl`` with fakes. That lets the tests prove the
app-level wiring required by PLAN M3 without a GPU:

- lifespan calls engine.load(), which runs the bootstrap in the engine's ONE
  dedicated worker thread (named "queen-engine"),
- analyze() runs in that same, single worker thread,
- the M1 app-layer behavior (loading -> 503, busy -> 429, cache) applies to
  the real engine path as well.

Run with: .venv/bin/pytest backend -m "not gpu"
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import chess
import pytest
from fastapi.testclient import TestClient

from backend.app.engine.queen import QueenEngine
from backend.app.main import build_engine, create_app

REPO = Path(__file__).resolve().parents[2]
START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def _fake_analyze_result(fen: str, slow: float) -> dict:
    if slow:
        time.sleep(slow)
    board = chess.Board(fen)
    moves = sorted(board.legal_moves, key=lambda m: m.uci())
    best = moves[0] if moves else None
    return {
        "fen": board.fen(),
        "text": "FAKE ANALYSIS",
        "best_move_uci": best.uci() if best else None,
        "move_source": "best_move" if best else "no_legal_moves",
        "finish_reason": "stop",
        "generated_tokens": 8,
        "critical_line": {"steps": [], "illegal_at": None},
    }


def _make_wired_queen(slow_load_s: float = 0.0, slow_analyze_s: float = 0.0):
    """A real QueenEngine whose in-worker functions are fakes (no torch).

    Returns (engine, seen) where ``seen`` records the threads load/analyze
    actually ran on.
    """
    eng = QueenEngine(REPO / "queen_pawn-8")
    seen: dict = {"threads": []}
    load_gate = threading.Event()

    def fake_bootstrap() -> None:
        seen["load_thread"] = threading.current_thread()
        if slow_load_s:
            load_gate.wait(timeout=30)
            load_gate.set()
        eng._generator = object()  # marks load complete

    def fake_analyze_impl(fen, history, seed, temperature, game_id=0) -> dict:
        seen["threads"].append(threading.current_thread())
        return _fake_analyze_result(fen, slow_analyze_s)

    # Instance attributes: load()/analyze() submit self._bootstrap /
    # self._analyze_impl, so the fakes run INSIDE the real worker thread.
    eng._bootstrap = fake_bootstrap
    eng._analyze_impl = fake_analyze_impl
    return eng, seen, load_gate


def _wait_status(c: TestClient, status: str, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if c.get("/api/health").json()["status"] == status:
            return
        time.sleep(0.02)
    pytest.fail(f"engine did not reach status {status!r}")


def test_build_engine_selects_queen_without_loading():
    # build_engine("queen") must give a real QueenEngine; merely constructing
    # it (no load) must not import torch.
    # Resolve the class from the canonical module at RUNTIME: test_m2 pops
    # and re-imports backend.app.engine.queen, which would make the class
    # bound at this module's import time a different object.
    import importlib
    import sys

    qmod = importlib.import_module("backend.app.engine.queen")
    eng = build_engine("queen")
    assert isinstance(eng, qmod.QueenEngine)
    assert eng.name == "queen"
    assert "torch" not in sys.modules


def test_queen_wired_through_app_in_one_worker_thread():
    eng, seen, _ = _make_wired_queen()
    app = create_app(engine=eng)
    with TestClient(app) as c:
        _wait_status(c, "ready")
        assert c.get("/api/health").json() == {"status": "ready", "engine": "queen"}

        r1 = c.post("/api/analyze", json={"fen": START_FEN, "history": []})
        assert r1.status_code == 200, r1.text
        b1 = r1.json()
        assert b1["fen"] == START_FEN
        assert b1["best_move_uci"] is not None
        assert b1["move_source"] == "best_move"
        assert b1["finish_reason"] == "stop"
        assert b1["cached"] is False
        assert b1["elapsed_ms"] >= 1
        # App layer must not leak internals into the cached/returned body.
        assert set(b1) == {
            "fen", "text", "best_move_uci", "move_source", "finish_reason",
            "generated_tokens", "critical_line", "elapsed_ms", "cached",
        }

        # Same request again -> cache hit (app-layer cache on the queen path).
        b2 = c.post("/api/analyze", json={"fen": START_FEN, "history": []}).json()
        assert b2["cached"] is True
        assert b2["elapsed_ms"] == b1["elapsed_ms"]
        assert {**b2, "cached": False} == b1

        # Validation errors still apply before the engine is ever reached.
        assert c.post("/api/analyze",
                      json={"fen": "garbage", "history": []}).json() == {
            "detail": "invalid FEN"}

    # load() ran in the engine's dedicated worker thread...
    work_thread = eng._worker._thread
    assert seen["load_thread"] is work_thread
    assert work_thread.name == "queen-engine"
    # ...and EVERY analyze ran in that SAME single thread.
    assert seen["threads"], "no analyze ran"
    assert all(t is work_thread for t in seen["threads"])


def test_queen_503_while_loading_then_429_when_busy():
    slow = 0.4
    eng, seen, load_gate = _make_wired_queen(slow_load_s=60, slow_analyze_s=slow)
    app = create_app(engine=eng)
    with TestClient(app) as c:
        # While load() still runs (on the dedicated worker thread): health
        # says loading and analyze 503s, exactly like the mock path.
        _wait_status(c, "loading", timeout=3)
        r = c.post("/api/analyze", json={"fen": START_FEN, "history": []})
        assert r.status_code == 503
        assert r.json() == {"detail": "engine loading"}

        load_gate.set()  # let the (fake) bootstrap finish
        _wait_status(c, "ready")

        # Busy lock: a second concurrent request must 429 while one analyze
        # (slow on the worker thread) holds the lock. No barrier here: the
        # first request is started on a thread, given a short head start, and
        # the second is sent from the main thread while the first still holds
        # the lock. (Thread is a daemon with a join timeout so a regression
        # here can never wedge the interpreter at shutdown.)
        codes: dict[str, int] = {}

        def worker():
            r = c.post("/api/analyze", json={"fen": START_FEN, "history": []})
            codes["a"] = r.status_code
            if r.status_code == 429:
                assert r.json() == {"detail": "engine busy"}

        ta = threading.Thread(target=worker, daemon=True)
        ta.start()
        time.sleep(0.1)  # A reaches the busy lock before B is sent
        rb = c.post("/api/analyze", json={"fen": START_FEN, "history": []})
        ta.join(slow * 10 + 10)
        assert not ta.is_alive(), "first request did not finish (deadlock?)"
        codes["b"] = rb.status_code

        assert codes == {"a": 200, "b": 429}, codes
        assert c.post("/api/analyze", json={"fen": START_FEN, "history": []}).status_code == 200
