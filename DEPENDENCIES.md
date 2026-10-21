# DEPENDENCIES

Third-party components used by this project and their licensing. Full captured
output: `docs/licenses.txt`.

## The model (`queen_pawn-8/`)

From the model's own `README.md`, recorded **verbatim**:

> Encoder: Leela Chess Zero, BT5-1024x15x32h-rpe-swa-3700000. Upstream
> component terms apply; no blanket license for the combined fine-tuned
> release is asserted here.

Component terms:

- **SmolLM3-3B** (Hugging Face, `HuggingFaceTB/SmolLM3-3B`) — **Apache-2.0**.
- **Encoder: Leela Chess Zero** BT5 network
  (`BT5-1024x15x32h-rpe-swa-3700000`) — LcZero is an open-source project
  (codebase MIT-licensed). Per the model README, **upstream component terms
  apply** and **no blanket license for the combined fine-tuned release is
  asserted**; redistribution of `queen_pawn-8/` (included in release copies
  by default; opt out with `make_release.sh --no-model`) is at the human's
  discretion.

`queen_pawn-8/requirements-inference.txt` exists to pin the inference
environment as constraints only (`pip install -c ...`). It must never be
installed directly (`-r` / `pip sync`): it lists both `chess` and a
`python-chess==1.999` stub, and syncing against it can break the `chess`
module.

## Backend (Python)

Direct dependencies — see `requirements.txt` for the exact tested pins;
environment-wide pins are frozen in `constraints.txt`.

| Package | Role | License |
|---|---|---|
| `fastapi` (+ `pydantic`, `starlette`, `sse-starlette` transitively) | HTTP API | MIT |
| `uvicorn` (+ `h11`, `httptools`, `websockets`, `uvloop` transitively) | ASGI server | BSD-3-Clause |
| `chess` (python-chess, provides the `chess` module) | rules / move legality | BSD-3-Clause |
| `torch` | tensor runtime | BSD-3-Clause (with exceptions) |
| `vllm` | model serving | Apache-2.0 |
| `transformers`, `tokenizers`, `safetensors` | model loading | Apache-2.0 |
| `pytest` | tests | MIT |

Note: the full environment (~200 distributions, incl. the CUDA/cuDNN wheels
pulled in by torch/vLLM) is captured in `docs/licenses.txt`; the rows above
are only the direct surface.

## Frontend (JavaScript)

Pinned by `frontend/package-lock.json`. Direct dependencies:

| Package | Role | License |
|---|---|---|
| `react`, `react-dom` | UI | MIT |
| `react-chessboard` | board rendering | MIT |
| `chess.js` | rules / PGN parsing | BSD-2-Clause |
| `vite` (dev) | build tool | MIT |
| `vitest` (+ `@vitest/*`, dev) | tests | MIT |

Dev/peer toolchain (TypeScript, oxlint, etc.) is MIT-licenced; the complete
list is in `docs/licenses.txt`. (The single `UNLICENSED` row there is
`frontend@0.0.0` — this project's own app package, which declares no license
field.)
