"""Deterministic mock engine for development and tests.

Behavior (see .agent/PLAN.md M1 and .agent/API.md):
- validates the FEN with python-chess,
- picks the first legal move (deterministic order: sorted by UCI),
- returns canned analysis text and a 3-step critical line with valid FENs.

Env vars:
- MOCK_DELAY_MS: sleep (ms) inside analyze before doing the work (default 0).
- MOCK_LOAD_MS: sleep (ms) inside load, so the app reports "loading"
  and /api/analyze returns 503 for that long after startup (default 0).

Must not import torch, vLLM, or anything from the model dir.
"""
from __future__ import annotations

import os
import time

import chess

from .base import Engine


def _first_legal_moves(board: chess.Board) -> list[chess.Move]:
    """Legal moves in deterministic (sorted UCI) order."""
    return sorted(board.legal_moves, key=lambda m: m.uci())


class MockEngine(Engine):
    name = "mock"

    def load(self) -> None:
        ms = int(os.environ.get("MOCK_LOAD_MS", "0") or 0)
        if ms > 0:
            time.sleep(ms / 1000.0)

    def analyze(
        self,
        fen: str,
        history: list[str],
        seed: int,
        temperature: float,
        game_id: int = 0,
    ) -> dict:
        delay_ms = int(os.environ.get("MOCK_DELAY_MS", "0") or 0)
        if delay_ms > 0:
            time.sleep(delay_ms / 1000.0)

        board = chess.Board(fen)
        if board is None:
            raise ValueError(f"invalid FEN: {fen!r}")

        moves = _first_legal_moves(board)
        best = moves[0] if moves else None

        # Critical line: up to 3 moves, each the first legal move at that
        # point. steps[*].fen is the position BEFORE the move of that step.
        steps: list[dict] = []
        probe = board.copy()
        ply = 1
        for _ in range(3):
            probe_moves = _first_legal_moves(probe)
            if not probe_moves:
                break
            steps.append({"ply": ply, "uci": probe_moves[0].uci(), "fen": probe.fen()})
            probe.push(probe_moves[0])
            ply += 1

        if best is None:
            move_source = "no_legal_moves"
            text = "Mock analysis: the game is over; there are no legal moves."
        else:
            move_source = "best_move"
            text = (
                "Mock analysis: I recommend {uci} here. "
                "This is canned deterministic text from the mock engine; "
                "it is not a real QUEEN evaluation.".format(uci=best.uci())
            )

        return {
            "fen": board.fen(),
            "text": text,
            "best_move_uci": best.uci() if best else None,
            "move_source": move_source,
            "finish_reason": "stop",
            "generated_tokens": 64,
            "critical_line": {"steps": steps, "illegal_at": None},
        }
