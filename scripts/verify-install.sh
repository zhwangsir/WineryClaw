#!/usr/bin/env bash
#
# verify-install.sh — sanity-check that webrain is ready to run.
#
# Why this exists: every README has a "quickstart" section that subtly
# drifts from reality as the codebase changes (the 2026-05-20 user trial
# found Python version mismatches and missing venv setup). This script
# is the executable form of the README. CI and humans both run it.
#
# Exit 0 if everything's installed and pnpm/python tests would pass.
# Exit 1 with a checklist of what's missing otherwise.
#
# Usage:
#   ./scripts/verify-install.sh           # just check
#   ./scripts/verify-install.sh --smoke   # also run the e2e smoke (~50s)

set -u

# Resolve repo root from this script's location, not CWD — lets you run
# from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Colors — fall back to plain if not on a tty
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BOLD=""; RESET=""
fi

FAIL_COUNT=0
WARN_COUNT=0

ok()    { echo "  ${GREEN}✓${RESET} $*"; }
fail()  { echo "  ${RED}✗${RESET} $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
warn()  { echo "  ${YELLOW}!${RESET} $*"; WARN_COUNT=$((WARN_COUNT + 1)); }
section() { echo; echo "${BOLD}$*${RESET}"; }

# ─── Section 1: System dependencies ─────────────────────────────────────────
section "System prerequisites"

if command -v python3 >/dev/null 2>&1; then
  PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)')
  PY_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
  if [ "$PY_MAJOR" -ge 3 ] && [ "$PY_MINOR" -ge 9 ]; then
    ok "python3 ($PY_VER)"
  else
    fail "python3 is $PY_VER but webrain needs 3.9+"
  fi
else
  fail "python3 not on PATH — install Python 3.9+"
fi

if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VER" | sed -E 's/v([0-9]+)\..*/\1/')
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "node ($NODE_VER)"
  else
    warn "node is $NODE_VER but webrain is tested with 18+ (recommended 20+)"
  fi
else
  fail "node not on PATH — install Node 18+"
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm ($(pnpm -v))"
else
  fail "pnpm not on PATH — install via: npm install -g pnpm"
fi

# ─── Section 2: main-brain Python venv ──────────────────────────────────────
section "Main-brain (Python venv)"

MAIN_BRAIN_DIR="$ROOT/sub-brain/main-brain"
VENV_PY="$MAIN_BRAIN_DIR/venv/bin/python3"

if [ ! -d "$MAIN_BRAIN_DIR" ]; then
  fail "main-brain directory missing at $MAIN_BRAIN_DIR"
elif [ ! -x "$VENV_PY" ]; then
  fail "no venv at $MAIN_BRAIN_DIR/venv — create with:
      cd $MAIN_BRAIN_DIR && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt"
else
  ok "venv interpreter present"
  # Probe for critical packages
  for pkg in fastapi httpx pydantic sentence_transformers; do
    if "$VENV_PY" -c "import $pkg" >/dev/null 2>&1; then
      ok "venv has $pkg"
    else
      fail "venv missing $pkg — run: $MAIN_BRAIN_DIR/venv/bin/pip install -r $MAIN_BRAIN_DIR/requirements.txt"
    fi
  done
  # Optional packages — warn not fail
  for pkg in watchdog playwright; do
    if "$VENV_PY" -c "import $pkg" >/dev/null 2>&1; then
      ok "venv has $pkg (optional)"
    else
      warn "$pkg not installed (optional — disables some features)"
    fi
  done
fi

# ─── Section 3: sub-brain Node modules ──────────────────────────────────────
section "Sub-brain (Node + TypeScript)"

SUB_BRAIN_DIR="$ROOT/sub-brain"
if [ ! -d "$SUB_BRAIN_DIR/node_modules" ]; then
  fail "sub-brain node_modules missing — run: cd $SUB_BRAIN_DIR && pnpm install"
else
  ok "sub-brain node_modules present"
  # Probe via pnpm's resolver — works for both flat and .pnpm layouts.
  # We just need to know the modules are RESOLVABLE, not whether the
  # symlink layout is canonical. `pnpm exec node -e ...` returns
  # successfully iff the package can be required.
  ( cd "$SUB_BRAIN_DIR" && pnpm exec node -e "require('fastify')" >/dev/null 2>&1 ) \
    && ok "sub-brain has fastify (resolvable)" \
    || warn "sub-brain can't require('fastify') — try: cd $SUB_BRAIN_DIR && pnpm install"
  ( cd "$SUB_BRAIN_DIR" && pnpm exec tsx --version >/dev/null 2>&1 ) \
    && ok "sub-brain has tsx (executable)" \
    || warn "sub-brain can't run tsx — try: cd $SUB_BRAIN_DIR && pnpm install"
fi

# ─── Section 4: frontend ────────────────────────────────────────────────────
section "Frontend"

FRONTEND_DIR="$ROOT/frontend"
if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  fail "frontend node_modules missing — run: cd $FRONTEND_DIR && pnpm install"
else
  ok "frontend node_modules present"
fi

if [ -d "$FRONTEND_DIR/dist" ] && [ -f "$FRONTEND_DIR/dist/index.html" ]; then
  ok "frontend dist built (sub-brain will serve it at /)"
else
  warn "frontend not built — sub-brain will run without UI. Build with: cd $FRONTEND_DIR && pnpm build"
fi

# ─── Section 5: optional smoke test ─────────────────────────────────────────
if [ "${1:-}" = "--smoke" ]; then
  section "End-to-end smoke (boots services, ~50s)"
  if [ -x "$VENV_PY" ] && [ -d "$SUB_BRAIN_DIR/node_modules" ]; then
    if "$VENV_PY" -m pytest -m smoke "$MAIN_BRAIN_DIR/tests/smoke/" --no-cov -q 2>&1 | tail -3; then
      ok "smoke tests passed"
    else
      fail "smoke tests failed — see output above"
    fi
  else
    warn "skipping smoke — venv or sub-brain deps missing"
  fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo
if [ "$FAIL_COUNT" -eq 0 ]; then
  if [ "$WARN_COUNT" -eq 0 ]; then
    echo "${GREEN}${BOLD}All checks passed.${RESET}  Run:"
  else
    echo "${GREEN}Install OK${RESET} (${WARN_COUNT} warning(s)).  Run:"
  fi
  echo "  cd $MAIN_BRAIN_DIR && source venv/bin/activate && python3 main_brain.py &"
  echo "  cd $SUB_BRAIN_DIR && pnpm dev &"
  echo "  cd $FRONTEND_DIR && pnpm dev"
  exit 0
else
  echo "${RED}${BOLD}$FAIL_COUNT check(s) failed.${RESET}  Fix the items marked ${RED}✗${RESET} above and re-run."
  exit 1
fi
