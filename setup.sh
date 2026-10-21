#!/usr/bin/env bash
# setup.sh — bring a tree of queenside (source clone or release copy) to a
# runnable state in one step.
#
# Usage (from the project root):
#   ./setup.sh                 # app dependencies + download queen_pawn-8 model (~8.4 GiB)
#   ./setup.sh --no-model      # app dependencies only (mock engine is enough to run)
#   ./setup.sh --model         # explicit: also ensure the model (same as default)
#   ./setup.sh --refresh-model # like --model, but delete and re-download the model
#   ./setup.sh --verify-model  # sha256-check an existing queen_pawn-8 against release.json
#   ./setup.sh --via-git|hf    # force the model download method (default: auto); flags: --via-git, --via-hf
#     auto = `git clone` + `rm -rf .git` when git-lfs is available,
#            otherwise `hf download` (huggingface-hub, which ships with the
#            pinned transformers/vllm).
#   ./setup.sh --skip-verify   # don't sha256-check the downloaded model
#   ./setup.sh --no-uv         # force the plain venv + pip path (uv may still be faster)
#
# Python installs use astral uv when it is on PATH (much faster than pip, and
# what the model's own README uses); otherwise the classic
# `python -m venv` + pip path is used. Same result either way.
#
# Steps: python3.12 venv -> pip install (pinned) -> model (unless --no-model)
#        -> npm ci && npm run build.
set -euo pipefail
cd "$(dirname "$0")"

MODEL_REPO="princeton-nlp/queen_pawn-8"
MODEL_URL="https://huggingface.co/${MODEL_REPO}"
MODEL_DIR="queen_pawn-8"

WITH_MODEL=1
REFRESH_MODEL=0
VERIFY_ONLY=0
VIA="auto"
VERIFY=1
USE_UV="auto"

usage() { sed -n '2,20p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-model) WITH_MODEL=0 ;;
    --model) : ;; # explicit; already the default
    --refresh-model) REFRESH_MODEL=1 ;;
    --verify-model) VERIFY_ONLY=1; WITH_MODEL=0 ;;
    --via-git) VIA="git" ;;
    --via-hf) VIA="hf" ;;
    --skip-verify) VERIFY=0 ;;
    --no-uv) USE_UV=0 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) echo "unexpected argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

UV=""
find_uv() {
  [ "$USE_UV" = "0" ] && return 0
  command -v uv >/dev/null 2>&1 && UV="$(command -v uv)" || UV=""
}

PYTHON=""
find_python() {
  command -v python3.12 >/dev/null 2>&1 || {
    echo "error: python3.12 not found on PATH." >&2
    echo "       The pins in requirements.txt/constraints.txt are tested for Python 3.12.3" >&2
    echo "       (do not deviate). Install it (e.g. deadsnakes PPA on Ubuntu) and rerun." >&2
    exit 1
  }
  PYTHON="$(command -v python3.12)"
}

# Verify every file listed in <dir>/release.json against its sha256 (+ size).
verify_model() {
  local dir="$1"
  [ -f "$dir/release.json" ] || die "$dir/release.json not found; nothing to verify against."
  "$PYTHON" - "$dir" <<'EOF'
import hashlib, json, os, sys

d = sys.argv[1]
rel = json.load(open(os.path.join(d, "release.json")))
bad = missing = 0
for path, meta in sorted(rel["files"].items()):
    f = os.path.join(d, path)
    if not os.path.isfile(f):
        print(f"  MISSING  {path}")
        missing += 1
        continue
    size = os.path.getsize(f)
    ok = size == meta["bytes"]
    if ok:
        got = hashlib.sha256(open(f, "rb").read()).hexdigest()
        ok = got == meta["sha256"]
    if not ok:
        print(f"  BAD      {path}")
        bad += 1
if missing or bad:
    print(f"verify FAILED: {missing} missing, {bad} mismatched", file=sys.stderr)
    sys.exit(1)
print(f"  all {len(rel['files'])} files verified (size + sha256)")
EOF
}

find_python
find_uv

if [ "$VERIFY_ONLY" -eq 1 ]; then
  log "Verifying $MODEL_DIR/ against release.json (~8.4 GiB of hashing)"
  verify_model "$MODEL_DIR"
  echo
  echo "$MODEL_DIR/ is consistent with its release.json."
  exit 0
fi

# --- 1. Python environment --------------------------------------------------
log "Checking prerequisites"
echo "  python: $PYTHON ($("$PYTHON" --version))"
if [ -n "$UV" ]; then
  echo "  uv:     $UV ($(uv --version))"   # used for the fast install
else
  echo "  uv:     (not found; falling back to pip — install https://astral.sh/uv for a much faster setup)"
fi
command -v git >/dev/null && echo "  git:    $(git --version)" || echo "  git:    (not found)"
command -v git-lfs >/dev/null && echo "  lfs:    $(git lfs version)" || echo "  lfs:    (not found)"
command -v npm >/dev/null || die "npm not found; install Node.js and rerun."
echo "  npm:    $(npm --version) (node $(node --version))"

if [ -n "$UV" ]; then
  # venvs made by 'uv venv' have no pip; drop a stray one
  if [ -d .venv ] && [ ! -x .venv/bin/python ]; then rm -rf .venv; fi
  if [ ! -d .venv ]; then
    log "Creating .venv with uv (python3.12)"
    "$UV" venv --python "$PYTHON" .venv
  fi
  log "Installing pinned backend dependencies with uv (torch/vllm wheels are large; still far faster than pip)"
  "$UV" pip install --python .venv/bin/python -c constraints.txt -r requirements.txt
else
  # venvs made by 'uv venv' have no pip; recreate for the pip fallback path
  if [ -d .venv ] && [ ! -x .venv/bin/pip ]; then rm -rf .venv; fi
  if [ ! -x .venv/bin/python ]; then
    log "Creating .venv (python3.12)"
    "$PYTHON" -m venv .venv
  fi
  log "Installing pinned backend dependencies with pip (this can take a while: torch+vllm)"
  .venv/bin/pip install -c constraints.txt -r requirements.txt
fi

# --- 2. Model -----------------------------------------------------------------
if [ "$WITH_MODEL" -eq 1 ]; then
  if [ -d "$MODEL_DIR" ] && [ -f "$MODEL_DIR/release.json" ]; then
    if [ "$REFRESH_MODEL" -eq 1 ]; then
      log "Removing existing $MODEL_DIR/ (--refresh-model)"
      rm -rf "$MODEL_DIR"
    else
      echo "==> $MODEL_DIR/ already present; skipping download (use --refresh-model to re-fetch)."
      if [ "$VERIFY" -eq 1 ]; then
        log "Verifying $MODEL_DIR/ against release.json (~8.4 GiB of hashing)"
        verify_model "$MODEL_DIR"
      fi
    fi
  fi

  if [ ! -d "$MODEL_DIR" ] || [ ! -f "$MODEL_DIR/release.json" ]; then
    TMP="$(mktemp -d "${TMPDIR:-/tmp}/queenside-setup.XXXXXX")"
    trap 'rm -rf "$TMP"' EXIT
    if [ "$VIA" = "auto" ]; then
      VIA="$(git lfs version >/dev/null 2>&1 && echo git || echo hf)"
    fi
    case "$VIA" in
      git)
        log "Downloading model via 'git clone' from $MODEL_URL (~8.4 GiB, needs git-lfs)"
        git clone --depth 1 --single-branch "$MODEL_URL" "$TMP/repo"
        rm -rf "$TMP/repo/.git"
        ;;
      hf)
        log "Downloading model via 'hf download' from $MODEL_URL (~8.4 GiB)"
        .venv/bin/hf download "$MODEL_REPO" --local-dir "$TMP/repo"
        rm -rf "$TMP/repo/.git" "$TMP/repo/.cache"
        ;;
      *) die "bad VIA=$VIA (expected auto|git|hf)" ;;
    esac
    [ -f "$TMP/repo/release.json" ] || die "downloaded tree has no release.json (method: $VIA); aborting"
    if [ "$VERIFY" -eq 1 ]; then
      log "Verifying downloaded model against release.json (~8.4 GiB of hashing)"
      verify_model "$TMP/repo"
    fi
    log "Installing verified model to $MODEL_DIR/"
    mkdir -p "$MODEL_DIR"
    (cd "$TMP/repo" && tar -cf - .) | (cd "$MODEL_DIR" && tar -xf -)
    rm -rf "$TMP/repo"
  fi
fi

# --- 3. Frontend ----------------------------------------------------------------
log "Frontend: npm ci && npm run build"
(cd frontend && npm ci && npm run build)

# --- Done -------------------------------------------------------------------------
cat <<EOF

Setup complete. Run the server from the project root:

  # mock engine (no GPU; what the README tests use):
  ENGINE=mock .venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 6006

EOF
if [ "$WITH_MODEL" -eq 1 ]; then
  cat <<EOF
  # real QUEEN engine (needs an NVIDIA GPU with enough free VRAM):
  ENGINE=queen .venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 6006

Then open http://localhost:6006/
EOF
else
  cat <<EOF
  (model not installed; ENGINE=queen needs './setup.sh --model' first + a GPU)
EOF
fi
