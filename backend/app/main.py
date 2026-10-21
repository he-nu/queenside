"""QUEEN Analysis Board backend (M1: app skeleton, engine behind /api).

One process on 0.0.0.0:6006 serves the API under /api and the built
frontend (frontend/dist) at / (see .agent/AGENTS.md, .agent/API.md).

App layer (applies to every engine): FEN validation with the exact
API.md error strings, history truncation to the last 7 entries, cache,
loading state (503), and a busy lock (429, one analysis at a time).
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import chess
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from .engine.base import Engine
from .schemas import AnalyzeRequest, AnalyzeResponse, HealthResponse

log = logging.getLogger("queen.backend")

MAX_HISTORY = 512
TRUNCATE_HISTORY = 7
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


def build_engine(name: str) -> Engine:
    if name == "mock":
        from .engine.mock import MockEngine

        return MockEngine()
    if name == "queen":
        # Lazy import (M2): must NOT happen for ENGINE=mock, otherwise we
        # would import torch/vLLM and create a GPU context.
        from .engine.queen import QueenEngine

        return QueenEngine()
    raise ValueError(f"unknown ENGINE: {name!r} (expected 'mock' or 'queen')")


def create_app(engine: Engine | None = None, engine_name: str | None = None) -> FastAPI:
    name = engine_name or os.environ.get("ENGINE", "mock")
    if engine is None:
        engine = build_engine(name)

    state: dict = {
        "engine": engine,
        "engine_name": engine.name,
        "loading": True,
        "busy_lock": threading.Lock(),
        "cache": {},
    }

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state["loading"] = True

        def _load_done(t: asyncio.Task):
            if t.cancelled():
                return
            exc = t.exception()
            if exc is not None:
                # Stay in "loading" state: health says loading, analyze 503s.
                log.exception("engine load failed", exc_info=exc)
            else:
                state["loading"] = False

        # Load in the background: the app serves /api/health ("loading") and
        # returns 503 on /api/analyze until load() finishes.
        task = asyncio.create_task(asyncio.to_thread(engine.load))
        task.add_done_callback(_load_done)
        yield
        if not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    app = FastAPI(title="QUEEN Analysis Board", lifespan=lifespan)
    app.state.engine = engine  # for tests / diagnostics

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> dict:
        return {
            "status": "loading" if state["loading"] else "ready",
            "engine": state["engine_name"],
        }

    @app.post("/api/analyze", response_model=AnalyzeResponse)
    async def analyze(req: AnalyzeRequest) -> dict:
        if len(req.history) > MAX_HISTORY:
            raise HTTPException(status_code=400, detail="history too long (max 512)")
        try:
            board = chess.Board(req.fen)
            if board is None or not board.is_valid():
                raise ValueError
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid FEN")
        for i, h in enumerate(req.history):
            try:
                if chess.Board(h) is None:
                    raise ValueError
            except ValueError:
                raise HTTPException(
                    status_code=400, detail=f"invalid history FEN at index {i}"
                )

        # Truncate BEFORE the cache key: only the 7 most recent prior
        # positions ever reach the model.
        truncated = tuple(req.history[-TRUNCATE_HISTORY:])
        key = (board.fen(), truncated, req.seed, req.temperature, req.game_id)

        if state["loading"]:
            raise HTTPException(status_code=503, detail="engine loading")

        cached = state["cache"].get(key)
        if cached is not None:
            return {**cached, "cached": True}

        if not state["busy_lock"].acquire(blocking=False):
            raise HTTPException(status_code=429, detail="engine busy")
        try:
            t0 = time.monotonic()
            result = await asyncio.to_thread(
                engine.analyze,
                board.fen(),
                list(truncated),
                req.seed,
                req.temperature,
                req.game_id,
            )
            result["elapsed_ms"] = max(1, int((time.monotonic() - t0) * 1000))
        except HTTPException:
            raise
        except Exception as e:
            log.exception("analyze failed")
            raise HTTPException(status_code=500, detail=str(e))
        finally:
            state["busy_lock"].release()

        if len(state["cache"]) >= 512:
            # naive eviction: drop the oldest key (dict order)
            state["cache"].pop(next(iter(state["cache"])))
        state["cache"][key] = result
        return result

    # Static frontend, mounted AFTER the /api routes and only if the built
    # frontend exists. Unknown non-API paths fall back to index.html (SPA).
    if FRONTEND_DIST.is_dir():
        dist_resolved = FRONTEND_DIST.resolve()

        @app.get("/{path:path}")
        def frontend(path: str):
            if path == "api" or path.startswith("api/"):
                return JSONResponse({"detail": "not found"}, status_code=404)
            if path:
                candidate = (dist_resolved / path).resolve()
                if dist_resolved in candidate.parents and candidate.is_file():
                    return FileResponse(candidate)
            return FileResponse(dist_resolved / "index.html")

    return app


app = create_app()
