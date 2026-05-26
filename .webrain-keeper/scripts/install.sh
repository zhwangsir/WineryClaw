#!/usr/bin/env bash
# webrain-keeper install.sh
# 一键启用 launchd（macOS）/ systemd user timer（Linux）
# 用法：
#   ./install.sh           # 安装并立即加载
#   ./install.sh --dry-run # 只渲染配置，不写入系统目录

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$REPO_ROOT/.webrain-keeper/launchd.plist.template"
DRY=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=1
fi

OS="$(uname -s)"
log() { echo "[keeper-install] $*"; }

case "$OS" in
  Darwin)
    PLIST_DST="$HOME/Library/LaunchAgents/ai.webrain.keeper.plist"
    log "OS: macOS → using launchd"
    log "template: $TEMPLATE"
    log "destination: $PLIST_DST"

    # 渲染模板：替换 __REPO_ROOT__ 占位符
    RENDERED="$(mktemp)"
    sed "s|__REPO_ROOT__|$REPO_ROOT|g" "$TEMPLATE" > "$RENDERED"

    if [[ "$DRY" -eq 1 ]]; then
      log "DRY RUN — rendered plist:"
      cat "$RENDERED"
      rm -f "$RENDERED"
      exit 0
    fi

    mkdir -p "$(dirname "$PLIST_DST")"
    mv "$RENDERED" "$PLIST_DST"
    chmod 644 "$PLIST_DST"
    log "installed: $PLIST_DST"

    # Make sure the loop script is executable
    chmod +x "$REPO_ROOT/.webrain-keeper/scripts/"*.sh

    # Load (unload first if already loaded — idempotent)
    if launchctl list | grep -q ai.webrain.keeper; then
      log "already loaded — unloading first..."
      launchctl unload "$PLIST_DST" || true
    fi
    launchctl load -w "$PLIST_DST"
    log "loaded into launchd"

    log ""
    log "verify:"
    log "  launchctl list | grep webrain.keeper"
    log ""
    log "manual trigger (for testing, doesn't wait for 03:00):"
    log "  launchctl start ai.webrain.keeper"
    log ""
    log "watch live log:"
    log "  tail -f $REPO_ROOT/.webrain-keeper/logs/launchd-stdout.log"
    ;;

  Linux)
    log "OS: Linux → using systemd user timer"
    SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
    SERVICE_DST="$SYSTEMD_USER_DIR/webrain-keeper.service"
    TIMER_DST="$SYSTEMD_USER_DIR/webrain-keeper.timer"

    if [[ "$DRY" -eq 1 ]]; then
      log "DRY RUN — would write:"
      log "  $SERVICE_DST"
      log "  $TIMER_DST"
      exit 0
    fi

    mkdir -p "$SYSTEMD_USER_DIR"

    cat > "$SERVICE_DST" <<EOF
[Unit]
Description=WeBrain Keeper - autonomous project guardian
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
ExecStart=/bin/bash $REPO_ROOT/.webrain-keeper/scripts/keeper-loop.sh
Nice=10
EOF

    cat > "$TIMER_DST" <<EOF
[Unit]
Description=WeBrain Keeper daily timer

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

    chmod +x "$REPO_ROOT/.webrain-keeper/scripts/"*.sh
    systemctl --user daemon-reload
    systemctl --user enable --now webrain-keeper.timer
    log "installed and enabled webrain-keeper.timer"
    log ""
    log "verify:"
    log "  systemctl --user list-timers webrain-keeper.timer"
    log ""
    log "manual trigger:"
    log "  systemctl --user start webrain-keeper.service"
    ;;

  *)
    log "unsupported OS: $OS"
    exit 1
    ;;
esac

log "done."
