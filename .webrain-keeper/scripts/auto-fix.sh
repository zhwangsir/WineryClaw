#!/usr/bin/env bash
# webrain-keeper auto-fix.sh
# 简单纠正：prettier / eslint --fix / 同步 PROJECT_STATE 测试数字
# 永不直接修改 main 分支，必须在干净的 git tree 上运行
# 所有改动写入 keeper/auto-fix-<date> 分支并 commit

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATE_TAG="$(date -u +%Y-%m-%d)"
KEEPER_BRANCH="keeper/auto-fix-$DATE_TAG"

cd "$REPO_ROOT"

log() { echo "[keeper-fix $(date -u +%H:%M:%S)] $*" >&2; }

# ===== Pre-flight: must be clean =====
if [[ -n "$(git status --porcelain)" ]]; then
  log "ABORT: working tree not clean, refuse to auto-fix"
  exit 2
fi

CUR_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo detached)"
log "current branch: $CUR_BRANCH"

# ===== Run autofixers (dry collect, don't commit yet) =====
log "running prettier --write (frontend)..."
(cd frontend && pnpm exec prettier --write 'src/**/*.{ts,tsx,css,json}' >/dev/null 2>&1 || true)

log "running eslint --fix (frontend)..."
(cd frontend && pnpm exec eslint --fix src/ >/dev/null 2>&1 || true)

log "running prettier --write (sub-brain)..."
(cd sub-brain && pnpm exec prettier --write 'src/**/*.ts' >/dev/null 2>&1 || true)

# ===== Did anything change? =====
if [[ -z "$(git status --porcelain)" ]]; then
  log "OK: nothing to fix"
  exit 0
fi

CHANGED_FILES="$(git status --porcelain | wc -l | tr -d ' ')"
log "fixers touched $CHANGED_FILES file(s)"

# ===== Branch + commit =====
git checkout -b "$KEEPER_BRANCH" 2>/dev/null || git checkout "$KEEPER_BRANCH"
git add -u

# Use a HEREDOC so the message doesn't get mangled
git commit -m "$(cat <<EOF
chore(keeper): auto-format $DATE_TAG

Ran prettier + eslint --fix across frontend/ + sub-brain/.
Touched $CHANGED_FILES file(s). No logic changes.

This commit was created by .webrain-keeper/scripts/auto-fix.sh.
EOF
)" || { log "commit failed, aborting"; git checkout "$CUR_BRANCH"; exit 1; }

NEW_SHA="$(git log -1 --format=%h)"
log "committed $NEW_SHA on $KEEPER_BRANCH"

# ===== Run tests on the new branch =====
log "verifying tests are still green..."
if (cd sub-brain && pnpm exec vitest run --reporter=dot >/dev/null 2>&1) && \
   (cd frontend && pnpm exec vitest run --reporter=dot >/dev/null 2>&1); then
  log "tests green"
else
  log "tests FAIL on auto-fix branch — reverting"
  git checkout "$CUR_BRANCH"
  git branch -D "$KEEPER_BRANCH"
  exit 1
fi

# ===== Try to push (if remote exists) =====
if git remote -v 2>/dev/null | grep -q origin; then
  log "pushing $KEEPER_BRANCH..."
  if git push -u origin "$KEEPER_BRANCH" 2>/dev/null; then
    log "pushed"
  else
    log "push failed (no permission or not configured) — branch retained locally"
  fi
else
  log "no remote configured — branch retained locally"
fi

# ===== Try to create PR (if gh available) =====
if command -v gh >/dev/null 2>&1 && git remote -v 2>/dev/null | grep -q origin; then
  log "creating PR..."
  gh pr create \
    --title "chore(keeper): auto-format $DATE_TAG" \
    --body "Automated formatting pass by webrain-keeper. No logic changes." \
    --base "$CUR_BRANCH" 2>&1 | tee -a "$REPO_ROOT/.webrain-keeper/logs/auto-fix-$DATE_TAG.log" || true
fi

# Return to caller's branch
git checkout "$CUR_BRANCH"
log "done. keeper branch: $KEEPER_BRANCH"
exit 0
