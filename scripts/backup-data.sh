#!/usr/bin/env bash
# WeBrain data backup (Round L1, 2026-05-21).
#
# Snapshots both the main-brain SQLite DB + RAG index AND the sandbox
# workspace bind mounts (~/.webrain/workspaces/) into a single timestamped
# tarball under data/backups/. Idempotent — safe to re-run.
#
# Usage
#   ./scripts/backup-data.sh                        # default: snapshot both
#   ./scripts/backup-data.sh --skip-workspaces      # main-brain only (smaller)
#   ./scripts/backup-data.sh --out /tmp/foo.tgz     # explicit output path
#   ./scripts/backup-data.sh --retention 14         # delete backups >14 days old
#
# Restore
#   tar -xzf data/backups/webrain-YYYYMMDD-HHMMSS.tgz -C /
#   (paths inside the archive are absolute, so this restores in-place.)
#
# What's NOT backed up
#   - node_modules / venv / dist (regenerate from source)
#   - Docker images (rebuild via sub-brain/docker/workspace/build.sh)
#   - .git (use git push)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Defaults
TS="$(date +%Y%m%d-%H%M%S)"
DEFAULT_OUT="${REPO_ROOT}/data/backups/webrain-${TS}.tgz"
OUT_PATH="${DEFAULT_OUT}"
INCLUDE_WORKSPACES=1
RETENTION_DAYS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_PATH="$2"; shift 2 ;;
    --skip-workspaces)
      INCLUDE_WORKSPACES=0; shift ;;
    --retention)
      RETENTION_DAYS="$2"; shift 2 ;;
    -h|--help)
      grep -E "^#" "$0" | sed -E 's/^# ?//'; exit 0 ;;
    *)
      echo "[backup-data] unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "${OUT_PATH}")"

# Source 1: main-brain data dir. If the user overrode it via WEBRAIN_DATA_DIR
# we honor that. Otherwise default to the repo path used by main-brain.
MAIN_BRAIN_DATA="${WEBRAIN_DATA_DIR:-${REPO_ROOT}/data/main-brain}"

# Source 2: sandbox workspace bind mounts (only if user opted in to
# stateful workspaces — these may not exist on fresh installs).
WORKSPACES_DIR="${HOME}/.webrain/workspaces"

SOURCES=()
[[ -d "${MAIN_BRAIN_DATA}" ]] && SOURCES+=("${MAIN_BRAIN_DATA}")
if [[ ${INCLUDE_WORKSPACES} -eq 1 && -d "${WORKSPACES_DIR}" ]]; then
  SOURCES+=("${WORKSPACES_DIR}")
fi

if [[ ${#SOURCES[@]} -eq 0 ]]; then
  echo "[backup-data] nothing to back up (no main-brain data + no workspaces)" >&2
  exit 1
fi

echo "[backup-data] writing ${OUT_PATH}"
for src in "${SOURCES[@]}"; do
  echo "[backup-data]   + ${src}"
done

# Short flags work on both BSD (macOS) and GNU tar — long forms diverge.
# SQLite -wal/-shm files can vanish mid-snapshot; tar usually reports
# "file changed as we read it" → exit code 1 with the archive still
# valid, so we capture the exit code and only fail hard on >1 (real I/O
# error, missing source, etc).
set +e
tar -czf "${OUT_PATH}" "${SOURCES[@]}" 2>/tmp/webrain-backup-stderr.log
rc=$?
set -e
if [[ ${rc} -gt 1 ]]; then
  echo "[backup-data] tar failed (rc=${rc}):" >&2
  cat /tmp/webrain-backup-stderr.log >&2
  exit ${rc}
elif [[ ${rc} -eq 1 ]]; then
  echo "[backup-data] tar reported transient warnings (likely sqlite -wal). Archive is still valid." >&2
fi

size=$(du -h "${OUT_PATH}" | awk '{print $1}')
echo "[backup-data] done · ${OUT_PATH} (${size})"

# Optional retention purge.
if [[ -n "${RETENTION_DAYS}" ]]; then
  echo "[backup-data] purging backups older than ${RETENTION_DAYS} days"
  find "$(dirname "${OUT_PATH}")" -maxdepth 1 -type f -name "webrain-*.tgz" \
       -mtime "+${RETENTION_DAYS}" -print -delete || true
fi
