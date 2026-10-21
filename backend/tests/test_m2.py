"""M2 non-GPU tests for the queen wrapper (no torch, no model load).

Run with: .venv/bin/pytest backend -m "not gpu"
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from backend.app.main import build_engine

REPO = Path(__file__).resolve().parents[2]


def test_unknown_engine_rejected():
    with pytest.raises(ValueError):
        build_engine("dragon")


def test_queen_env_vars_installed_without_torch():
    # Importing the queen module must set the vLLM/torch env vars (they have
    # to precede any torch import) but must NOT import torch itself.
    had_torch = sys.modules.pop("torch", None)
    sys.modules.pop("backend.app.engine.queen", None)
    try:
        import importlib

        mod = importlib.import_module("backend.app.engine.queen")
        assert "torch" not in sys.modules
        assert os.environ["PYTHONPATH"].endswith("queen_pawn-8")
        assert os.environ["VLLM_ENABLE_V1_MULTIPROCESSING"] == "0"
        assert os.environ["VLLM_USE_FLASHINFER_SAMPLER"] == "0"
        assert os.environ["VLLM_DISABLE_REQUEST_ID_RANDOMIZATION"] == "1"
        assert os.environ["TOKENIZERS_PARALLELISM"] == "false"
        assert os.environ["OMP_NUM_THREADS"] == "1"
        assert os.environ["OPENBLAS_NUM_THREADS"] == "1"
        assert REPO.joinpath("queen_pawn-8").resolve() in {
            Path(p).resolve() for p in sys.path if p
        }
        assert mod.MAX_MODEL_LEN == 2304  # 2048 fixed max_tokens + 256
        # Per-ply seed: blake2b(f"{seed}|{game_id}|{ply}") % (2**31-1).
        import hashlib

        digest = hashlib.blake2b(b"20260823|0|0", digest_size=8).digest()
        expected = int.from_bytes(digest, "big") % (2 ** 31 - 1)
        assert mod.QueenEngine._request_seed(20260823, 0, 0) == expected
        # VALIDATION.json gpu_test cross-check (startpos, seed 20260823, game_id 0)
        assert mod.QueenEngine._request_seed(20260823, 0, 0) == 917225541
    finally:
        if had_torch is not None:
            sys.modules["torch"] = had_torch


def test_queen_engine_constructs_without_load():
    from backend.app.engine.queen import QueenEngine

    e = QueenEngine(REPO / "queen_pawn-8")
    assert e.model_dir == (REPO / "queen_pawn-8").resolve()
    assert e.name == "queen"
    with pytest.raises(RuntimeError):
        e.analyze("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", [], 1, 0.0)
