#!/usr/bin/env bash
# webrain-keeper keeper-loop.sh
# launchd / systemd 触发的主入口
# 调 claude CLI headless 启动 webrain-keeper sub-agent，让它跑一次完整 keeper round
# 单次最大预算：1M tokens、20 分钟 wall clock（由 sub-agent 自我执行）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG_FILE="$REPO_ROOT/.webrain-keeper/logs/$TIMESTAMP-loop.log"
ALERT_DIR="$REPO_ROOT/.webrain-keeper/alerts"

mkdir -p "$(dirname "$LOG_FILE")" "$ALERT_DIR"

log() { echo "[keeper-loop $(date -u +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

# ===== Pre-flight =====
log "=== webrain-keeper loop start ==="
log "repo: $REPO_ROOT"
log "log:  $LOG_FILE"

# Disk space check (need > 5 GB free)
FREE_GB=$(df -g "$REPO_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
if [[ -n "$FREE_GB" && "$FREE_GB" -lt 5 ]]; then
  log "ABORT: free disk < 5 GB ($FREE_GB GB)"
  echo "disk full" > "$ALERT_DIR/$TIMESTAMP-low-disk.md"
  exit 2
fi

# Working tree must be clean
cd "$REPO_ROOT"
if [[ -n "$(git status --porcelain)" ]]; then
  log "ABORT: working tree not clean — keeper refuses to run on dirty state"
  echo "## dirty working tree at keeper start" > "$ALERT_DIR/$TIMESTAMP-dirty-tree.md"
  git status >> "$ALERT_DIR/$TIMESTAMP-dirty-tree.md"
  exit 2
fi

# Make sure we're on a sensible branch (not detached)
CUR_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null)"
if [[ -z "$CUR_BRANCH" ]]; then
  log "ABORT: detached HEAD — keeper refuses to run"
  exit 2
fi

# ===== Run claude headless =====
# Use the claude CLI; user's environment is configured for local Kimi via ANTHROPIC_BASE_URL
# Keeper sub-agent is defined at .claude/agents/webrain-keeper.md

if ! command -v claude >/dev/null 2>&1; then
  log "ABORT: claude CLI not found in PATH"
  echo "missing claude CLI" > "$ALERT_DIR/$TIMESTAMP-missing-claude.md"
  exit 2
fi

PROMPT="$(cat <<'EOF'
You are activating as the webrain-keeper sub-agent.
Read .claude/agents/webrain-keeper.md fully, then execute one complete keeper round
according to its 7-step operation flow.

Do NOT exceed your stated budget (1M input / 200K output tokens, 20 min wall clock).
Do NOT modify main branch directly — all changes must go on keeper/* branches.
If you encounter anything ambiguous, write to .webrain-keeper/alerts/ and exit.

When done, output a single-line summary in the required format:
"Keeper 本次任务：<topic>；产出：<artifact>；下次建议任务：<next>"
EOF
)"

log "invoking claude --print headless..."
timeout 1200 claude --print --output-format json --max-turns 80 "$PROMPT" \
  >> "$LOG_FILE" 2>&1
KEEPER_RC=$?

if [[ "$KEEPER_RC" -eq 124 ]]; then
  log "TIMEOUT: keeper exceeded 20-min wall clock"
  echo "## keeper timed out at $TIMESTAMP" > "$ALERT_DIR/$TIMESTAMP-timeout.md"
elif [[ "$KEEPER_RC" -ne 0 ]]; then
  log "keeper exited with rc=$KEEPER_RC"
  echo "## keeper exit code $KEEPER_RC at $TIMESTAMP" > "$ALERT_DIR/$TIMESTAMP-nonzero-exit.md"
  tail -50 "$LOG_FILE" >> "$ALERT_DIR/$TIMESTAMP-nonzero-exit.md"
else
  log "keeper completed successfully"
fi

# ===== Post-flight =====
# Retention: keep last 60 days of logs
find "$REPO_ROOT/.webrain-keeper/logs" -type f -mtime +60 -delete 2>/dev/null || true
find "$REPO_ROOT/.webrain-keeper/alerts" -type f -mtime +90 -delete 2>/dev/null || true

log "=== keeper loop end (rc=$KEEPER_RC) ==="
exit "$KEEPER_RC"
