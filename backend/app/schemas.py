"""API request/response schemas (see .agent/API.md)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

MoveSource = Literal[
    "best_move",
    "critical_line",
    "promising_or_analysis",
    "no_legal_moves",
    "random_legal_fallback",
]


class AnalyzeRequest(BaseModel):
    fen: str
    history: list[str] = Field(default_factory=list)
    seed: int = 20260823
    temperature: float = 0.6
    game_id: int = 0


class CriticalStep(BaseModel):
    ply: int
    uci: str
    fen: str


class IllegalAt(BaseModel):
    ply: int
    reason: str


class CriticalLine(BaseModel):
    steps: list[CriticalStep]
    illegal_at: Optional[IllegalAt] = None


class AnalyzeResponse(BaseModel):
    fen: str
    text: str
    best_move_uci: Optional[str] = None
    move_source: MoveSource
    finish_reason: str
    generated_tokens: int
    critical_line: CriticalLine
    elapsed_ms: int
    cached: bool = False


class HealthResponse(BaseModel):
    status: Literal["loading", "ready"]
    engine: str
