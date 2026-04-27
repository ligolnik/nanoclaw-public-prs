#!/usr/bin/env bash
set -euo pipefail

# SmartThings PAT watchdog (host-side, runs via launchd every ~30 min).
#
# SmartThings PATs are valid for 24 hours (policy change announced 2026-04-26).
# This script probes /v1/locations through the OneCLI proxy. On 401 it pings
# the owner via Telegram so they can rotate. On recovery (200 after a 401
# streak) it sends an "access restored" message.
#
# State persists in $STATE_FILE so we don't spam every 30 min while expired.
#
# All deps: curl, onecli (in $PATH), jq optional. Uses .env for the bot token.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"
STATE_FILE="${STATE_FILE:-${PROJECT_ROOT}/data/smartthings-watchdog-state.json}"
LOG_FILE="${LOG_FILE:-${PROJECT_ROOT}/logs/smartthings-watchdog.log}"

# Recipient: owner's main Telegram DM. JID `tg:114893642` -> chat_id 114893642.
TELEGRAM_CHAT_ID="${SMARTTHINGS_WATCHDOG_CHAT_ID:-114893642}"
# OneCLI secret id for the SmartThings PAT (for the rotation message).
SECRET_ID="bff14ee4-d89a-4370-9b61-ff18df826e41"
# Don't ping more often than this for the same failure spell.
ALERT_COOLDOWN_SECONDS="${SMARTTHINGS_WATCHDOG_COOLDOWN:-14400}" # 4h

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")"

log() {
  printf '%s smartthings-watchdog: %s\n' "$(date -Iseconds)" "$*" | tee -a "$LOG_FILE" >&2
}

# Load TELEGRAM_BOT_TOKEN from .env (KEY=VALUE; tolerates spaces/quotes).
if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: .env not found at $ENV_FILE"
  exit 2
fi
TELEGRAM_BOT_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  log "ERROR: TELEGRAM_BOT_TOKEN missing from $ENV_FILE"
  exit 2
fi

# State file shape: { "last_status": <int>, "last_alert_ts": <epoch>, "spell_started_ts": <epoch> }
read_state() {
  if [[ -f "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
  else
    printf '{"last_status":0,"last_alert_ts":0,"spell_started_ts":0}'
  fi
}

# Tiny key reader so we don't depend on jq being installed on the host.
state_get() {
  local key="$1" raw
  raw="$(read_state)"
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get(sys.argv[2], 0))" "$raw" "$key"
}

write_state() {
  local last_status="$1" last_alert_ts="$2" spell_started_ts="$3"
  python3 -c '
import json, sys
print(json.dumps({
  "last_status": int(sys.argv[1]),
  "last_alert_ts": int(sys.argv[2]),
  "spell_started_ts": int(sys.argv[3]),
}))
' "$last_status" "$last_alert_ts" "$spell_started_ts" >"$STATE_FILE"
}

send_telegram() {
  local text="$1"
  curl -sf --max-time 15 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "parse_mode=HTML" \
    -d "disable_web_page_preview=true" \
    --data-urlencode "text=${text}" \
    -o /dev/null && return 0
  log "ERROR: Telegram sendMessage failed"
  return 1
}

# Probe SmartThings via OneCLI proxy. We use `onecli run --` so HTTPS_PROXY,
# CA bundle, etc. are auto-set; the gateway injects the SmartThings PAT.
probe() {
  # -o /dev/null discards the body, -w prints the status code.
  # 28 = curl operation timeout. Treat any non-numeric as 0 ("network down").
  local out
  out="$(onecli run -- curl -sS --max-time 20 \
      -o /dev/null -w '%{http_code}' \
      'https://api.smartthings.com/v1/locations' 2>>"$LOG_FILE" || true)"
  # `onecli run` prepends a banner line to stdout ("onecli: gateway connected. Starting curl...")
  # So we take the LAST 3-digit token in the captured output.
  local code
  code="$(printf '%s' "$out" | grep -Eo '[0-9]{3}' | tail -1 || true)"
  printf '%s' "${code:-0}"
}

now="$(date +%s)"
last_status="$(state_get last_status)"
last_alert_ts="$(state_get last_alert_ts)"
spell_started_ts="$(state_get spell_started_ts)"

status="$(probe)"
log "probe -> HTTP $status (last_status=$last_status, last_alert_ts=$last_alert_ts)"

# ── Recovered (200 after a 401 streak): send "restored" once, clear spell ───
if [[ "$status" == "200" && "$last_status" == "401" ]]; then
  msg="✅ <b>SmartThings access restored</b>"$'\n'
  msg+="<code>/v1/locations</code> is responding 200 again."
  if send_telegram "$msg"; then
    log "recovery alert sent"
  fi
  write_state 200 0 0
  exit 0
fi

# ── Healthy steady state ────────────────────────────────────────────────────
if [[ "$status" == "200" ]]; then
  write_state 200 "$last_alert_ts" 0
  exit 0
fi

# ── 401 (PAT expired/revoked) ───────────────────────────────────────────────
if [[ "$status" == "401" ]]; then
  if [[ "$spell_started_ts" == "0" ]]; then
    spell_started_ts="$now"
  fi
  age=$(( now - last_alert_ts ))
  if (( age < ALERT_COOLDOWN_SECONDS )); then
    log "401 within cooldown (age=${age}s < ${ALERT_COOLDOWN_SECONDS}s) — skipping alert"
    write_state 401 "$last_alert_ts" "$spell_started_ts"
    exit 0
  fi
  msg="🔑 <b>SmartThings PAT expired</b>"$'\n\n'
  msg+="<code>GET /v1/locations</code> → 401."$'\n\n'
  msg+="Generate a new token at https://account.smartthings.com/tokens"$'\n'
  msg+="(24h validity is now policy — no way around it),"$'\n'
  msg+="then update the OneCLI secret:"$'\n'
  msg+="<code>onecli secrets update ${SECRET_ID} --value &quot;\$NEW_TOKEN&quot;</code>"$'\n\n'
  msg+="Verify: <code>onecli run -- curl -s -o /dev/null -w '%{http_code}' https://api.smartthings.com/v1/locations</code>"
  if send_telegram "$msg"; then
    log "401 alert sent"
    last_alert_ts="$now"
  fi
  write_state 401 "$last_alert_ts" "$spell_started_ts"
  exit 0
fi

# ── Other non-200 (network down, 5xx, etc.) — log only, don't alert ─────────
log "non-200 non-401 status ($status) — no alert"
write_state "$status" "$last_alert_ts" "$spell_started_ts"
exit 0
