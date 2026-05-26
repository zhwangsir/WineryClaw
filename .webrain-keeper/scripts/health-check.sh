#!/usr/bin/env bash
# webrain-keeper health-check.sh
# 监控：跑测试套件 + type check + lint + 输出 JSON 健康报告
# 用法：
#   ./health-check.sh          # 完整套件（含 main-brain pytest，慢）
#   ./health-check.sh --quick  # 仅 sub-brain + frontend vitest（快，Stop hook 用）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPORT_DIR="$REPO_ROOT/.webrain-keeper/reports"
ALERT_DIR="$REPO_ROOT/.webrain-keeper/alerts"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
REPORT_FILE="$REPORT_DIR/$TIMESTAMP-health.json"

mkdir -p "$REPORT_DIR" "$ALERT_DIR"

QUICK_MODE=0
if [[ "${1:-}" == "--quick" ]]; then
  QUICK_MODE=1
fi

# ===== Helpers =====
log() { echo "[keeper-health $(date -u +%H:%M:%S)] $*" >&2; }
fail_count=0
# Use plain vars (macOS bash 3.2 has no associative arrays)
sub_pass=0; sub_fail=0; sub_tsc="unknown"
fe_pass=0;  fe_fail=0;  fe_tsc="unknown"
mb_pass="0"; mb_fail=0

# ===== sub-brain vitest =====
log "running sub-brain vitest..."
SUB_OUT="$(cd "$REPO_ROOT/sub-brain" && pnpm exec vitest run --reporter=json 2>&1 | tail -50 || true)"
sub_pass=$(echo "$SUB_OUT" | grep -oE '"numPassedTests":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")
sub_fail=$(echo "$SUB_OUT" | grep -oE '"numFailedTests":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")
if [[ "$sub_fail" -gt 0 ]]; then
  fail_count=$((fail_count+1))
  echo "## sub-brain test failure $(date -u)" > "$ALERT_DIR/$TIMESTAMP-sub-fail.md"
  echo "$SUB_OUT" >> "$ALERT_DIR/$TIMESTAMP-sub-fail.md"
fi

# ===== frontend vitest =====
log "running frontend vitest..."
FE_OUT="$(cd "$REPO_ROOT/frontend" && pnpm exec vitest run --reporter=json 2>&1 | tail -50 || true)"
fe_pass=$(echo "$FE_OUT" | grep -oE '"numPassedTests":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")
fe_fail=$(echo "$FE_OUT" | grep -oE '"numFailedTests":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")
if [[ "$fe_fail" -gt 0 ]]; then
  fail_count=$((fail_count+1))
  echo "## frontend test failure $(date -u)" > "$ALERT_DIR/$TIMESTAMP-fe-fail.md"
  echo "$FE_OUT" >> "$ALERT_DIR/$TIMESTAMP-fe-fail.md"
fi

# ===== sub-brain tsc =====
log "running sub-brain tsc..."
if (cd "$REPO_ROOT/sub-brain" && pnpm exec tsc --noEmit) >/dev/null 2>&1; then
  sub_tsc="clean"
else
  sub_tsc="errors"
  fail_count=$((fail_count+1))
fi

# ===== frontend tsc =====
log "running frontend tsc..."
if (cd "$REPO_ROOT/frontend" && pnpm exec tsc --noEmit) >/dev/null 2>&1; then
  fe_tsc="clean"
else
  fe_tsc="errors"
  fail_count=$((fail_count+1))
fi

# ===== main-brain pytest (skip in quick mode — 6 min total) =====
if [[ "$QUICK_MODE" -eq 0 ]]; then
  log "running main-brain pytest (~6 min)..."
  VENV_PY="$REPO_ROOT/sub-brain/main-brain/venv/bin/python3"
  if [[ -x "$VENV_PY" ]]; then
    MB_OUT="$(cd "$REPO_ROOT/sub-brain/main-brain" && "$VENV_PY" -m pytest tests/ -q --no-cov 2>&1 | tail -3 || true)"
    mb_pass=$(echo "$MB_OUT" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+' || echo "0")
    mb_fail=$(echo "$MB_OUT" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || echo "0")
    if [[ "$mb_fail" -gt 0 ]]; then
      fail_count=$((fail_count+1))
      echo "## main-brain test failure $(date -u)" > "$ALERT_DIR/$TIMESTAMP-mb-fail.md"
      echo "$MB_OUT" >> "$ALERT_DIR/$TIMESTAMP-mb-fail.md"
    fi
  else
    mb_pass="skip-no-venv"
  fi
else
  mb_pass="skip-quick"
fi

# ===== Git state =====
GIT_BRANCH="$(cd "$REPO_ROOT" && git symbolic-ref --short HEAD 2>/dev/null || echo "detached")"
GIT_STATUS_LINES="$(cd "$REPO_ROOT" && git status --porcelain | wc -l | tr -d ' ')"
GIT_LAST_COMMIT="$(cd "$REPO_ROOT" && git log -1 --format='%h %s' 2>/dev/null || echo 'no-commits')"

# ===== Doc drift detection =====
PROJ_STATE_DATE="$(grep -oE '\*\*最后更新\*\*：[0-9]{4}-[0-9]{2}-[0-9]{2}' "$REPO_ROOT/docs/PROJECT_STATE.md" 2>/dev/null | head -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "")"
LAST_COMMIT_DATE="$(cd "$REPO_ROOT" && git log -1 --format='%ad' --date=short 2>/dev/null || echo "")"
DOC_DRIFT="unknown"
if [[ -n "$PROJ_STATE_DATE" && -n "$LAST_COMMIT_DATE" ]]; then
  # macOS date 跟 GNU date 不一样,简单做字符串比较先
  if [[ "$PROJ_STATE_DATE" < "$LAST_COMMIT_DATE" ]]; then
    DOC_DRIFT="drifted"
  else
    DOC_DRIFT="in-sync"
  fi
fi

# ===== Write JSON report =====
cat > "$REPORT_FILE" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "quick_mode": $QUICK_MODE,
  "fail_count": $fail_count,
  "tests": {
    "sub_brain": {"pass": $sub_pass, "fail": $sub_fail, "tsc": "$sub_tsc"},
    "frontend":  {"pass": $fe_pass,  "fail": $fe_fail,  "tsc": "$fe_tsc"},
    "main_brain":{"pass": "$mb_pass", "fail": $mb_fail}
  },
  "git": {
    "branch": "$GIT_BRANCH",
    "dirty_files": $GIT_STATUS_LINES,
    "last_commit": "$GIT_LAST_COMMIT"
  },
  "doc_drift": {
    "project_state_date": "$PROJ_STATE_DATE",
    "last_commit_date": "$LAST_COMMIT_DATE",
    "status": "$DOC_DRIFT"
  }
}
EOF

# ===== Retention: keep last 30 reports =====
ls -t "$REPORT_DIR"/*-health.json 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

# ===== Console summary =====
log "report written: $REPORT_FILE"
log "summary: sub=$sub_pass/$sub_fail fe=$fe_pass/$fe_fail mb=$mb_pass/$mb_fail drift=$DOC_DRIFT"

if [[ "$fail_count" -gt 0 ]]; then
  log "FAIL: $fail_count subsystem(s) failed — see $ALERT_DIR"
  exit 1
fi
log "OK: all subsystems green"
exit 0
