#!/usr/bin/env bash
# webrain-keeper uninstall.sh
# 卸载 launchd plist / systemd timer

set -euo pipefail

OS="$(uname -s)"
log() { echo "[keeper-uninstall] $*"; }

case "$OS" in
  Darwin)
    PLIST_DST="$HOME/Library/LaunchAgents/ai.webrain.keeper.plist"
    if [[ -f "$PLIST_DST" ]]; then
      if launchctl list | grep -q ai.webrain.keeper; then
        launchctl unload "$PLIST_DST" || true
      fi
      rm -f "$PLIST_DST"
      log "removed $PLIST_DST"
    else
      log "no plist at $PLIST_DST — nothing to do"
    fi
    ;;

  Linux)
    SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
    SERVICE_DST="$SYSTEMD_USER_DIR/webrain-keeper.service"
    TIMER_DST="$SYSTEMD_USER_DIR/webrain-keeper.timer"

    if [[ -f "$TIMER_DST" ]]; then
      systemctl --user disable --now webrain-keeper.timer 2>/dev/null || true
      rm -f "$TIMER_DST" "$SERVICE_DST"
      systemctl --user daemon-reload
      log "removed and disabled webrain-keeper timer/service"
    else
      log "no systemd unit found — nothing to do"
    fi
    ;;

  *)
    log "unsupported OS: $OS"
    exit 1
    ;;
esac

log "done."
