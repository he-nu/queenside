"""QUEEN real-engine wrapper (M2). Adapts the model dir's own inference code.

Adapted from ``queen_pawn-8/infer.py`` (read it; it is never edited). All
heavy work -- torch/vLLM imports, generator construction and every
``generate()`` call -- runs in ONE dedicated worker thread; the generator is
created in that same thread.

Env vars (set BEFORE anything imports vLLM/torch-dependent model code, per
.agents/AGENTS.md): PYTHONPATH=<model dir>, VLLM_ENABLE_V1_MULTIPROCESSING=0,
VLLM_USE_FLASHINFER_SAMPLER=0, VLLM_DISABLE_REQUEST_ID_RANDOMIZATION=1,
plus setdefault TOKENIZERS_PARALLELISM=false, OMP_NUM_THREADS=1,
OPENBLAS_NUM_THREADS=1.

Config env vars:
- QUEEN_MODEL_DIR:      model directory (default ./queen_pawn-8).
- QUEEN_GPU_UTIL:       vLLM gpu_memory_utilization (default 0.25, NOT
                        infer.py's 0.72).
- QUEEN_MAX_NUM_SEQS:   vLLM max_num_seqs (default 1, NOT infer.py's 32).

This module must import nothing torch/vLLM-related at import time; importing
it is safe for the mock-mode GPU policy check because torch is imported only
inside the worker thread, and only after ``load()`` is called.
"""
from __future__ import annotations

import hashlib
import json
import os
import queue
import sys
import threading
from pathlib import Path

import chess

from .base import Engine

MAX_TOKENS = 2048  # fixed at engine load (API.md: not a request field)
MAX_MODEL_LEN = MAX_TOKENS + 256  # = 2304, as in infer.py
HISTORY_LIMIT = 7  # only the 7 most recent prior positions reach the encoder
_GIB = 1024 ** 3


def _model_dir() -> Path:
    return Path(os.environ.get("QUEEN_MODEL_DIR", "./queen_pawn-8"))


def _configure_model_env(model_dir: Path) -> None:
    """Must run before any torch/vLLM import is attempted in this process."""
    model_dir = model_dir.resolve()
    # infer.py sets these for the whole process; the PYTHONPATH env var matters
    # for vLLM's architecture-inspection subprocess, the sys.path entry for
    # the in-process `models`/`utils` imports.
    os.environ["PYTHONPATH"] = str(model_dir)
    os.environ["VLLM_ENABLE_V1_MULTIPROCESSING"] = "0"
    os.environ["VLLM_USE_FLASHINFER_SAMPLER"] = "0"
    os.environ["VLLM_DISABLE_REQUEST_ID_RANDOMIZATION"] = "1"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    if str(model_dir) not in sys.path:
        sys.path.insert(0, str(model_dir))


# The model package is not ours and its top-level names (models/, utils/)
# must be importable only after the env vars above are in place.
_configure_model_env(_model_dir())


class _WorkerThread:
    """A single OS thread that executes queued callables (blocking submit)."""

    def __init__(self, name: str = "queen-engine"):
        self._queue: queue.Queue = queue.Queue()
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            fn, args, box, event = item
            try:
                box["result"] = fn(*args)
            except BaseException as exc:  # propagate to the submitter
                box["exception"] = exc
            finally:
                event.set()

    def submit(self, fn, *args):
        box: dict = {}
        event = threading.Event()
        self._queue.put((fn, args, box, event))
        event.wait()
        if "exception" in box:
            raise box["exception"]
        return box.get("result")


class QueenEngine(Engine):
    """Implements Engine around ChessFlamingoGenerator (one worker thread)."""

    name = "queen"

    def __init__(self, model_dir: str | Path | None = None):
        self.model_dir = Path(model_dir if model_dir is not None else _model_dir())
        # Env vars are module-level (process-wide); make sure this engine's
        # resolved dir is the one on sys.path/PYTHONPATH.
        _configure_model_env(self.model_dir)
        self._worker = _WorkerThread()
        self._generator = None
        self._settings: dict = {}
        # Filled on the worker thread during load():
        self._translator_cls = None
        self._choose_move_fn = None

    # ------------------------------------------------------------------ load

    def load(self) -> None:
        """Build the generator once, in the dedicated worker thread."""
        if self._generator is not None:
            return
        self._worker.submit(self._bootstrap)

    def _bootstrap(self) -> None:  # worker thread
        if not (self.model_dir / "models").is_dir():
            raise FileNotFoundError(
                f"queen_pawn-8 model directory not found: {self.model_dir.resolve()!s} "
                "(no 'models' package there). Set QUEEN_MODEL_DIR to the full model "
                "directory, or rebuild the release with ./make_release.sh (the model "
                "is included by default) / ./make_release.sh --add-model on an "
                "existing release."
            )
        import torch

        from models.vllm.flamingo_generate import ChessFlamingoGenerator
        from utils.eval_policy import choose_move
        from utils.translate_helpers import Translator

        if not torch.cuda.is_available():
            raise RuntimeError(
                "CUDA is unavailable; QUEEN inference requires an NVIDIA GPU "
                "and CUDA-enabled PyTorch"
            )
        self._settings = json.loads(
            (self.model_dir / "inference_config.json").read_text()
        )
        dtype = self._settings.get("dtype", "bfloat16")
        if dtype == "bfloat16" and not torch.cuda.is_bf16_supported():
            raise RuntimeError(
                "This GPU does not support BF16; set inference_config dtype to float16"
            )

        gpu_util = float(os.environ.get("QUEEN_GPU_UTIL", "0.25"))
        max_num_seqs = int(os.environ.get("QUEEN_MAX_NUM_SEQS", "1"))
        free, total = torch.cuda.mem_get_info()
        # vLLM may take gpu_util * total; on top of that the lc0 encoder
        # (~1 GiB) loads OUTSIDE vLLM's budget, plus the CUDA context.
        needed = gpu_util * total + 2 * _GIB
        if free < needed:
            raise RuntimeError(
                f"insufficient free GPU memory: {free / _GIB:.2f} GiB free, "
                f"need ~{needed / _GIB:.2f} GiB "
                f"(QUEEN_GPU_UTIL={gpu_util} x {total / _GIB:.2f} GiB total "
                f"+ 2 GiB encoder/CUDA context). Stop other GPU processes "
                f"(e.g. the local coding model) or lower QUEEN_GPU_UTIL."
            )

        self._translator_cls = Translator
        self._choose_move_fn = choose_move
        self._generator = ChessFlamingoGenerator(
            self.model_dir,
            self.model_dir / "lc0",
            dtype=dtype,
            gpu_memory_utilization=gpu_util,
            max_model_len=MAX_MODEL_LEN,
            max_num_seqs=max_num_seqs,
            seed=self._settings.get("seed", 20260823),
            enforce_eager=True,
            use_v1_vllm=True,
        )

    # --------------------------------------------------------------- analyze

    def analyze(
        self,
        fen: str,
        history: list[str],
        seed: int,
        temperature: float,
        game_id: int = 0,
    ) -> dict:
        if self._generator is None:
            raise RuntimeError("engine not loaded; call load() first")
        return self._worker.submit(
            self._analyze_impl, fen, list(history), seed, temperature, game_id
        )

    def _analyze_impl(
        self,
        fen: str,
        history: list[str],
        seed: int,
        temperature: float,
        game_id: int,
    ) -> dict:  # worker thread
        board = chess.Board(fen)
        if not board.is_valid():
            raise ValueError(f"invalid FEN: {fen!r}")
        # Only the 7 most recent prior positions affect the encoder and the
        # cache key (idempotent: the app layer already truncates).
        prior = [h for h in history if h][-HISTORY_LIMIT:]
        for h in prior:
            chess.Board(h)  # same lax parse as infer.py

        prompt = self._settings["prompt"]
        request_seed = self._request_seed(seed, game_id, board.ply())
        result = self._generator.generate(
            [board.fen()],
            [prompt],
            [prior],
            max_tokens=MAX_TOKENS,
            temperature=temperature,
            top_k=self._settings.get("top_k", 20),
            top_p=self._settings.get("top_p", 0.95),
            repetition_penalty=self._settings.get("repetition_penalty", 1.0),
            seeds=[request_seed],
        )[0]
        raw = result["text"]

        best, source, critical = self._choose_move_fn(
            board.fen(), raw, request_seed,
            self._settings.get("move_policy", "structured"),
        )
        # Parsing is not move validation: never present an illegal move.
        legal_best = best if best is not None and best in board.legal_moves else None

        steps = [
            {"ply": s["ply"], "uci": s["uci"], "fen": s["fen"]}
            for s in critical["legal_steps"]
        ]
        illegal_at = critical["illegal_at"]
        illegal_at = (
            {"ply": illegal_at["ply"], "reason": illegal_at["reason"]}
            if illegal_at
            else None
        )

        return {
            "fen": board.fen(),
            "text": self._translator_cls(board.turn).decode_absolute(raw),
            "best_move_uci": legal_best.uci() if legal_best else None,
            "move_source": source,
            "finish_reason": result.get("finish_reason"),
            "generated_tokens": len(result["token_ids"]),
            "critical_line": {"steps": steps, "illegal_at": illegal_at},
        }

    @staticmethod
    def _request_seed(seed: int, game_id: int, ply: int) -> int:
        # Per-ply sampling seed, exactly as in infer.py.
        digest = hashlib.blake2b(f"{seed}|{game_id}|{ply}".encode(),
                                 digest_size=8).digest()
        return int.from_bytes(digest, "big") % (2 ** 31 - 1)
