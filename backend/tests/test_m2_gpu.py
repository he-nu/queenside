# M2 GPU tests -- RUN BY THE HUMAN ONLY (see .agent/AGENTS.md GPU policy).
#
# Prerequisites (human):
#   - the local coding model (Ollama llama-server) is STOPPED, >= 15 GiB free
#   - `nvidia-smi` snapshotted before and after the run
#
# Command:
#   ENGINE=queen .venv/bin/pytest backend -m gpu -v -s
#
# Pass criteria (PLAN.md M2, in order of importance):
#   1. startpos t0 run twice -> identical responses
#   2. schema per API.md; best_move_uci legal or null; critical_line fens valid
#   3. middle-game position with history (black to move) returns a legal move
#   4. SECONDARY: compare against tests/fixtures/startpos_cli_t0.json and
#      REPORT any difference. The human decides whether it matters. This test
#      never fails on a difference (tiny bf16 differences are possible:
#      max_num_seqs 1 here vs 32 in the CLI fixture generation).

from __future__ import annotations

import json
import time
from pathlib import Path

import chess
import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app

pytestmark = pytest.mark.gpu

REPO = Path(__file__).resolve().parents[2]
START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
# VALIDATION.json black_history_test: after 1.e4 e5 2.Nf3 Nc6 3.Bc4, black to move
MID_FEN = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"
MOVE_SOURCES = {
    "best_move", "critical_line", "promising_or_analysis",
    "no_legal_moves", "random_legal_fallback",
}


@pytest.fixture(scope="module")
def client():
    app = create_app()
    assert app.state.engine.name == "queen", (
        "run with ENGINE=queen (see plan)"
    )
    # Generous timeouts: load ~35 s+, one generate ~25 s+.
    with TestClient(app) as c:
        print("waiting for engine load (~35 s+; vLLM + weights can take minutes)...")
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            status = c.get("/api/health").json()
            if status["status"] == "ready":
                print("engine ready:", status)
                break
            time.sleep(5)
        assert c.get("/api/health").json()["status"] == "ready", (
            "engine was not ready within 900 s (see server log / nvidia-smi)"
        )
        yield c
        print("GPU test session finished; check nvidia-smi, then stop the engine.")


def _check_critical_line(body: dict) -> None:
    line = body["critical_line"]
    assert isinstance(line["steps"], list)
    ia = line["illegal_at"]
    assert ia is None or (
        isinstance(ia.get("ply"), int) and isinstance(ia.get("reason"), str)
    ), ia
    # steps must be a fully legal prefix chained from the root position, and
    # every step fen a valid FEN equal to the chain position.
    b = chess.Board(body["fen"])
    for i, step in enumerate(line["steps"]):
        assert step["ply"] == i + 1, step
        fb = chess.Board(step["fen"])  # raises if it does not parse
        assert b.fen() == fb.fen(), f"step {i} fen is not the pre-move position"
        m = chess.Move.from_uci(step["uci"])
        assert b.is_legal(m), f"step {i} uci {step['uci']} illegal"
        b.push(m)


def test_startpos_t0_two_runs_identical(client: TestClient):
    # Criterion 1: engine level (no app cache between the two calls), then
    # API level. temperature 0 must be deterministic.
    engine = client.app.state.engine
    r1 = engine.analyze(START_FEN, [], 20260823, 0.0)
    r2 = engine.analyze(START_FEN, [], 20260823, 0.0)
    assert r1 == r2, (
        "two identical t0 engine.analyze calls differ:\n"
        f"run1: {r1}\nrun2: {r2}"
    )
    payload = {"fen": START_FEN, "history": [], "temperature": 0}
    a1 = client.post("/api/analyze", json=payload)
    assert a1.status_code == 200, a1.text
    a2 = client.post("/api/analyze", json=payload)
    assert a2.status_code == 200, a2.text
    b1, b2 = a1.json(), a2.json()
    assert b1 == {**b2, "cached": False}
    print("startpos t0 (engine level):", b1["best_move_uci"], b1["move_source"])


def test_response_schema_and_legality(client: TestClient):
    # Criterion 2.
    r = client.post("/api/analyze", json={"fen": START_FEN, "history": []})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {
        "fen", "text", "best_move_uci", "move_source", "finish_reason",
        "generated_tokens", "critical_line", "elapsed_ms", "cached",
    }, body.keys()
    assert body["fen"] == chess.Board(START_FEN).fen()
    assert isinstance(body["text"], str) and body["text"]
    assert body["move_source"] in MOVE_SOURCES
    assert body["finish_reason"] in ("stop", "length")
    assert isinstance(body["generated_tokens"], int) and body["generated_tokens"] > 0
    assert "<SQUARE_" not in body["text"] and "<PIECE_" not in body["text"]
    board = chess.Board(body["fen"])
    if body["best_move_uci"] is not None:
        assert board.is_legal(chess.Move.from_uci(body["best_move_uci"]))
    if body["move_source"] == "no_legal_moves":
        assert body["best_move_uci"] is None
        assert not board.legal_moves
    _check_critical_line(body)
    print("startpos t0.6:", body["best_move_uci"], body["move_source"],
          body["finish_reason"], body["generated_tokens"], "tokens")


def test_middle_game_black_to_move_with_history(client: TestClient):
    # Criterion 3: the VALIDATION.json black-to-move case with real history.
    b = chess.Board()
    history = [b.fen()]
    for uci in ("e2e4", "e7e5", "g1f3", "b8c6", "f1c4"):
        b.push_uci(uci)
        history.append(b.fen())
    assert b.fen() == MID_FEN
    r = client.post("/api/analyze", json={"fen": MID_FEN, "history": history})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["best_move_uci"] is not None, (
        f"expected a legal move in this middlegame, got none "
        f"(move_source={body['move_source']})"
    )
    assert b.is_legal(chess.Move.from_uci(body["best_move_uci"]))
    print("middlegame black to move:", body["best_move_uci"], body["move_source"])


def _load_reference_fixture(ref_path: Path) -> dict:
    text = ref_path.read_text()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # The M0 redirect (`infer.py ... > fixture`) also captured vLLM's stdout
    # log lines BEFORE the JSON dump (their logs go to stdout, not stderr).
    # The JSON is dumped with indent=2, so the document starts at the first
    # line that is exactly "{" and runs to end of file.
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.rstrip() == "{":
            return json.loads("\n".join(lines[i:]))
    raise ValueError(f"no JSON document found in {ref_path}")


def test_reference_fixture_secondary(client: TestClient):
    # Criterion 4 (SECONDARY): compare with the CLI reference run. Report
    # differences; this test NEVER fails on a difference -- the human decides
    # whether it matters. Never edit this test to force a match.
    ref_path = REPO / "tests" / "fixtures" / "startpos_cli_t0.json"
    ref = _load_reference_fixture(ref_path)
    r = client.post(
        "/api/analyze", json={"fen": START_FEN, "history": [], "temperature": 0}
    )
    assert r.status_code == 200, r.text
    resp = r.json()

    print("\n" + "=" * 70)
    print("SECONDARY comparison vs tests/fixtures/startpos_cli_t0.json")
    print("(generated with infer.py at max_num_seqs=32; this run uses 1 --")
    print("tiny bf16 differences are possible; the human decides if they matter)")
    print("=" * 70)
    ref_steps = [
        {"ply": s["ply"], "uci": s["uci"], "fen": s["fen"]}
        for s in ref.get("critical_line", {}).get("legal_steps", [])
    ]
    comparisons = {
        "best_move_uci": (ref.get("best_move_uci"), resp.get("best_move_uci")),
        "move_source": (ref.get("move_source"), resp.get("move_source")),
        "finish_reason": (ref.get("finish_reason"), resp.get("finish_reason")),
        "generated_tokens": (ref.get("generated_tokens"),
                             resp.get("generated_tokens")),
        "critical_line.steps(ply,uci,fen)": (ref_steps,
                                             resp["critical_line"]["steps"]),
        "text": (ref.get("text"), resp.get("text")),
    }
    for field, (rv, pv) in comparisons.items():
        if rv == pv:
            print(f"  MATCH   {field}")
        else:
            print(f"  DIFFERS {field}")
            r_s, p_s = str(rv), str(pv)
            print(f"    ref : {r_s[:400]}{'...' if len(r_s) > 400 else ''}")
            print(f"    ours: {p_s[:400]}{'...' if len(p_s) > 400 else ''}")
    print("=" * 70)
    print("End of SECONDARY report. No failure is raised from differences.")
