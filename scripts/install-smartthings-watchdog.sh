#!/usr/bin/env bash
set -euo pipefail

# Install the SmartThings PAT watchdog as a launchd LaunchAgent.
# Idempotent — safe to re-run after edits to the template.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="${PROJECT_ROOT}/launchd/com.nanoclaw.smartthings-watchdog.plist"
TARGET="${HOME}/Library/LaunchAgents/com.nanoclaw.smartthings-watchdog.plist"
LABEL="com.nanoclaw.smartthings-watchdog"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "smartthings-watchdog: macOS-only (launchd). Use cron / systemd timer on Linux." >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "smartthings-watchdog: template missing at $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"

sed -e "s|{{PROJECT_ROOT}}|${PROJECT_ROOT}|g" \
    -e "s|{{HOME}}|${HOME}|g" \
    "$TEMPLATE" >"$TARGET"

echo "wrote $TARGET"

# Reload (unload first to pick up template changes; ignore if not loaded).
launchctl unload "$TARGET" 2>/dev/null || true
launchctl load "$TARGET"

if launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "loaded $LABEL"
else
  echo "WARN: launchctl list shows $LABEL not loaded — check /var/log/system.log" >&2
  exit 1
fi
