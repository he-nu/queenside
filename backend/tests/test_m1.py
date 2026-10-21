"""M1 acceptance tests (run with: .venv/bin/pytest backend -m "not gpu")."""
from __future__ import annotations

import sys
import threading
import time

import chess
import pytest
from fastapi.testclient import TestClient

from backend.app.engine.mock import MockEngine
from backend.app.main import create_app

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
FEN_AFTER_1E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
FOOLS_MATE = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"  # white mated


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("MOCK_DELAY_MS", raising=False)
    monkeypatch.delenv("MOCK_LOAD_MS", raising=False)
    app = create_app()
    with TestClient(app) as c:
        _wait_ready(c)
        yield c


def _legal_analyze_body(client: TestClient, fen: str, **extra) -> dict:
    r = client.post(
        "/api/analyze", json={"fen": fen, "history": [], **extra}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    board = chess.Board(body["fen"])
    assert board is not None and board.is_valid()
    assert body["finish_reason"] == "stop"
    assert body["critical_line"]["illegal_at"] is None
    # critical line steps chain legally
    prev_fen = fen
    for step in body["critical_line"]["steps"]:
        b = chess.Board(prev_fen)
        move = chess.Move.from_uci(step["uci"])
        assert b.is_legal(move), f"illegal step uci {step['uci']}"
        assert b.fen() == chess.Board(step["fen"]).fen()
        b.push(move)
        prev_fen = b.fen()
    return body


def test_health_ready(client: TestClient):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ready", "engine": "mock"}


def test_analyze_valid(client: TestClient):
    body = _legal_analyze_body(client, START_FEN)
    assert body["fen"] == START_FEN
    assert body["move_source"] == "best_move"
    assert body["best_move_uci"] is not None
    assert body["cached"] is False
    assert body["elapsed_ms"] >= 1
    # mock: first legal move of the start position
    first_uci = sorted(chess.Board(START_FEN).legal_moves, key=lambda m: m.uci())[0].uci()
    assert body["best_move_uci"] == first_uci
    assert len(body["critical_line"]["steps"]) == 3


def test_analyze_mate_position_null_move(client: TestClient):
    # Fool's mate: white to move and checkmated → no legal moves.
    assert not chess.Board(FOOLS_MATE).legal_moves
    body = _legal_analyze_body(client, FOOLS_MATE)
    assert body["best_move_uci"] is None
    assert body["move_source"] == "no_legal_moves"
    assert body["critical_line"]["steps"] == []


def test_invalid_fen(client: TestClient):
    # unparseable
    r = client.post("/api/analyze", json={"fen": "not a fen", "history": []})
    assert r.status_code == 400
    assert r.json() == {"detail": "invalid FEN"}
    # parses (white king missing) but is not a valid position
    r = client.post(
        "/api/analyze",
        json={"fen": "7k/8/8/8/8/8/8/8 w - - 0 1", "history": []},
    )
    assert r.status_code == 400
    assert r.json() == {"detail": "invalid FEN"}


def test_invalid_history_fen(client: TestClient):
    r = client.post(
        "/api/analyze",
        json={"fen": START_FEN, "history": [FEN_AFTER_1E4, "garbage"]},
    )
    assert r.status_code == 400
    assert r.json() == {"detail": "invalid history FEN at index 1"}


def test_history_too_long(client: TestClient):
    r = client.post(
        "/api/analyze",
        json={"fen": START_FEN, "history": [START_FEN] * 513},
    )
    assert r.status_code == 400
    assert r.json() == {"detail": "history too long (max 512)"}
    # 512 is allowed
    r = client.post(
        "/api/analyze",
        json={"fen": START_FEN, "history": [START_FEN] * 512},
    )
    assert r.status_code == 200


def _legal_fen_chain(n: int) -> list[str]:
    """n FENs along a fixed legal move sequence."""
    seq = ["e2e4", "e7e5", "d2d4", "d7d5", "g1f3", "b8c6",
           "f1d3", "c8g4", "c1f4", "f8e7", "e1g1", "g8f6"]
    board = chess.Board()
    fens = [board.fen()]
    for uci in seq[: n - 1]:
        board.push_uci(uci)
        fens.append(board.fen())
    return fens


def test_history_truncation_cache_key(client: TestClient):
    fens = _legal_fen_chain(10)  # 10 fens, 9 full-history entries
    cur = fens[-1]
    full = fens[:-1]  # 9 entries
    assert len(full) > 7
    r1 = client.post("/api/analyze", json={"fen": cur, "history": full})
    assert r1.status_code == 200 and r1.json()["cached"] is False
    # Same request but history already truncated to the last 7 -> cache hit.
    r2 = client.post("/api/analyze", json={"fen": cur, "history": full[-7:]})
    assert r2.status_code == 200
    b2 = r2.json()
    assert b2["cached"] is True
    assert b2["elapsed_ms"] == r1.json()["elapsed_ms"]
    for k in ("fen", "text", "best_move_uci", "critical_line"):
        assert b2[k] == r1.json()[k]


def test_cache_hit(client: TestClient):
    payload = {"fen": FEN_AFTER_1E4, "history": [START_FEN]}
    r1 = client.post("/api/analyze", json=payload)
    r2 = client.post("/api/analyze", json=payload)
    assert r1.status_code == 200 and r2.status_code == 200
    b1, b2 = r1.json(), r2.json()
    assert b1["cached"] is False
    assert b2["cached"] is True
    b2_copy = {**b2, "cached": False}
    assert b2_copy == b1


def test_503_during_mock_load_ms(monkeypatch):
    monkeypatch.setenv("MOCK_LOAD_MS", "800")
    monkeypatch.delenv("MOCK_DELAY_MS", raising=False)
    app = create_app()
    with TestClient(app) as c:
        assert c.get("/api/health").json()["status"] == "loading"
        r = c.post("/api/analyze", json={"fen": START_FEN, "history": []})
        assert r.status_code == 503
        assert r.json() == {"detail": "engine loading"}
        # after load finishes it is ready
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if c.get("/api/health").json()["status"] == "ready":
                break
            time.sleep(0.05)
        assert c.get("/api/health").json()["status"] == "ready"
        assert c.post("/api/analyze", json={"fen": START_FEN, "history": []}).status_code == 200


def test_429_second_concurrent_request(monkeypatch):
    monkeypatch.setenv("MOCK_DELAY_MS", "300")
    monkeypatch.delenv("MOCK_LOAD_MS", raising=False)
    app = create_app()
    fens = _legal_fen_chain(12)
    with TestClient(app) as c:
        codes: list[int] = []
        lock = threading.Lock()
        barrier = threading.Barrier(2)
        stop = threading.Event()

        def worker(fens_part):
            barrier.wait()
            for fen in fens_part:
                if stop.is_set():
                    return
                r = c.post("/api/analyze", json={"fen": fen, "history": []})
                with lock:
                    codes.append(r.status_code)
                if r.status_code == 429:
                    assert r.json() == {"detail": "engine busy"}
                    stop.set()
                    return

        # Two threads hammer distinct FENs concurrently; with a 300 ms mock
        # delay one of them must observe the busy lock (429) while the other
        # holds it, and both eventually get 200s.
        ta = threading.Thread(target=worker, args=(fens[::2],))
        tb = threading.Thread(target=worker, args=(fens[1::2],))
        ta.start(); tb.start()
        ta.join(15); tb.join(15)
        assert 429 in codes, f"no 429 observed: {codes}"
        assert 200 in codes, f"no 200 observed: {codes}"


def test_mock_does_not_import_torch(monkeypatch):
    saved = sys.modules.get("torch")
    if saved is not None:
        # ensure a clean check
        pytest.skip("torch already imported in this test process")
    app = create_app()
    with TestClient(app) as c:
        _wait_ready(c)
    assert "torch" not in sys.modules


def test_default_engine_is_mock():
    import os

    old = os.environ.pop("ENGINE", None)
    try:
        app = create_app()
    finally:
        if old is not None:
            os.environ["ENGINE"] = old
    assert app.title  # app builds
    with TestClient(app) as c:
        _wait_ready(c)
        assert c.get("/api/health").json() == {"status": "ready", "engine": "mock"}


def _wait_ready(c: TestClient):
    deadline = time.monotonic() + 5
    while c.get("/api/health").json()["status"] != "ready":
        assert time.monotonic() < deadline, "engine did not become ready"
        time.sleep(0.02)
