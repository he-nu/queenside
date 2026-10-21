# DEPENDENCIES

Third-party components used by Queenside and their licensing. Full captured
output: `docs/licenses.txt`.

Queenside does **not** host or redistribute the Queen model weights. They are
downloaded at setup time from the authors' Hugging Face repository.

## The model (`queen_pawn-8/`)

Queen is by Adithya Bhaskar, Jeffrey Cheng, and Danqi Chen (Princeton Language
and Intelligence). Weights:
[huggingface.co/princeton-nlp/queen_pawn-8](https://huggingface.co/princeton-nlp/queen_pawn-8).
Paper: [arXiv:2610.03695](https://arxiv.org/abs/2610.03695).

From the model's own `README.md`, recorded **verbatim**:

> Encoder: Leela Chess Zero, BT5-1024x15x32h-rpe-swa-3700000. Upstream
> component terms apply; no blanket license for the combined fine-tuned
> release is asserted here.

Component terms:

- **Queen weights (`queen_pawn-8`)** — no license has been published for the
  combined release. Queenside only links to and downloads them at runtime;
  do not redistribute them without the authors' permission.
- **SmolLM3-3B** (Hugging Face, `HuggingFaceTB/SmolLM3-3B`) — **Apache-2.0**.
- **Encoder: Leela Chess Zero** BT5 network
  (`BT5-1024x15x32h-rpe-swa-3700000`) — the Lc0 engine is
  **GPL-3.0-or-later**. The license of the BT5 network weights themselves
  should be confirmed at [lczero.org](https://lczero.org). Per the model
  README, **upstream component terms apply**.

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

Dev/peer toolchain (TypeScript, oxlint, etc.) is MIT-licensed; the complete
list is in `docs/licenses.txt`. (The single `UNLICENSED` row there is
`frontend@0.0.0` — this project's own app package, which declares no license
field. Set a `license` field in `frontend/package.json` once you add a
`LICENSE` file.)