"""Engine interface (see .agent/PLAN.md M1)."""
from __future__ import annotations

import abc


class Engine(abc.ABC):
    """An analyze engine.

    Implementations expose `load()` (called once at startup) and `analyze()`.
    `analyze` receives the normalized current FEN and the already-truncated
    history (at most the last 7 prior FENs) and returns the response body
    fields described in .agent/API.md (without `elapsed_ms` and `cached`,
    which are added by the app layer).
    """

    name: str

    @abc.abstractmethod
    def load(self) -> None:
        """Load model / warm up. Called once at startup."""

    @abc.abstractmethod
    def analyze(
        self,
        fen: str,
        history: list[str],
        seed: int,
        temperature: float,
        game_id: int = 0,
    ) -> dict:
        """Analyze a position and return the API response body (dict)."""
