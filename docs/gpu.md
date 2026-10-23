## GPU requirements and memory

Queen needs a GPU with **compute capability 8.0 or higher** (Ampere or newer)
and enough VRAM for the weights (~8.4 GiB) plus the KV cache and the Leela
encoder.

### Setting `QUEEN_GPU_UTIL`

`QUEEN_GPU_UTIL` is the fraction of the GPU's *total* VRAM that vLLM may
claim, so the same value gives very different budgets on different cards.
The default (`0.25`) was tuned on a 48 GB card (about 12 GB). On a smaller
card it can be less than the model weights, and startup fails with a vLLM
memory error (for example, no room for the KV cache).

As a rule of thumb, `QUEEN_GPU_UTIL × total VRAM` must comfortably exceed
~8.4 GiB plus overhead.

| GPU | VRAM | Setting |
|---|---|---|
| RTX A6000 | 48 GB | default (`0.25`) |
| RTX PRO 4500 Blackwell | 32 GB | `0.6` works |
| RTX 3090 | 24 GB | `0.72` works |

```
QUEEN_GPU_UTIL=0.6 ENGINE=queen .venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 6006
```

These are values that worked in testing, not minimums. A single request at a
time (`QUEEN_MAX_NUM_SEQS=1`) needs little KV cache, so raising the value
mostly reserves memory rather than changing output. Don't set it so high that
other processes on the GPU (or the encoder) run out of memory.

### Unsupported GPUs

Pre-Ampere cards such as the V100 (compute capability 7.0) do not work with
the pinned versions. The model is loaded as bfloat16, which these GPUs don't
support, and the pinned torch build (`+cu130`) ships no kernels for them.

### Troubleshooting

- **vLLM memory error at startup:** raise `QUEEN_GPU_UTIL`, and check
  `nvidia-smi` for other processes using the GPU.
- **"No space left on device" during setup:** the model download is staged in
  a temp directory. If `/tmp` is on a small filesystem, point `TMPDIR` (and
  `HF_HOME`) at a larger volume before running `setup.sh`.
- **First start is slow on newer GPUs:** kernels may be compiled and cached
  on first run, so later starts should be faster.
