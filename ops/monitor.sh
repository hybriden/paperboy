#!/usr/bin/env bash
# Paperboy 5-minute monitor: api health, public site, admin, disk. Alerts via
# ntfy with a 1h per-check cooldown so a sustained outage doesn't spam.
set -u
TOPIC_FILE=${PAPERBOY_NTFY_TOPIC_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/paperboy/ntfy-topic}
BACKUP_DIR=${PAPERBOY_BACKUP_DIR:-$HOME/paperboy-backups}
STATE=${PAPERBOY_MONITOR_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/paperboy/monitor}
API_URL=${PAPERBOY_API_URL:-http://localhost:8091}
SITE_URL=${PAPERBOY_SITE_URL:-}    # public front page; check skipped when unset
ADMIN_URL=${PAPERBOY_ADMIN_URL:-}  # admin through the front door; skipped when unset
TOPIC=$(cat "$TOPIC_FILE")
mkdir -p "$STATE"

alert() { # key, title, body
  local key="$1" now last
  now=$(date +%s)
  last=$(cat "$STATE/$key" 2>/dev/null || echo 0)
  [ $((now - last)) -lt 3600 ] && return 0
  echo "$now" > "$STATE/$key"
  curl -fsS -m 10 -H "Title: $2" -H "Priority: high" -H "Tags: rotating_light" -d "$3" "https://ntfy.sh/$TOPIC" >/dev/null 2>&1 || true
}
clear_state() { rm -f "$STATE/$1"; }

# API health (local — independent of Cloudflare). /health/ready, NOT /health:
# /health is a static {"status":"ok"} that answers fine while Postgres is down or
# the pool is exhausted, so it would have reported healthy through a real outage.
# /health/ready pings the DB and 503s when it can't.
if ! curl -fsS -m 10 "$API_URL/health/ready" | grep -q '"ready"'; then
  alert api "Paperboy API not ready" "$API_URL/health/ready failed on the box (API up but DB unreachable?)"
else clear_state api; fi

# Public site + admin through the front door.
front_door() { # key, label, url
  [ -n "$3" ] || return 0
  local host=${3#*://} code
  host=${host%%/*}
  code=$(curl -s -o /dev/null -m 15 -w "%{http_code}" "$3")
  if [ "$code" != "200" ]; then alert "$1" "$host is $code" "$2 returned $code"; else clear_state "$1"; fi
}
front_door www "Front page" "$SITE_URL"
front_door cms "Admin" "$ADMIN_URL"

# Disk (uploads + variants + backups all grow). Alert at 90%.
use=$(df --output=pcent / | tail -1 | tr -dc 0-9)
if [ "${use:-0}" -ge 90 ]; then
  alert disk "Disk ${use}% full on the Paperboy box" "df / shows ${use}% — prune backups/variants or grow the disk"
else clear_state disk; fi

# Yesterday's backup must exist (catches a silently-removed cron). BOTH halves of
# the backup are required for a full restore, so monitor each independently — a
# silently-failing uploads tar must not hide behind a healthy pg dump.
if ! find "$BACKUP_DIR" -name "paperboy-*.dump" -mtime -2 2>/dev/null | grep -q .; then
  alert backup "Paperboy backup is stale" "No pg dump newer than 48h in paperboy-backups/"
else clear_state backup; fi
if ! find "$BACKUP_DIR" -name "uploads-*.tar.gz" -mtime -2 2>/dev/null | grep -q .; then
  alert backup_uploads "Paperboy uploads backup is stale" "No uploads tarball newer than 48h in paperboy-backups/"
else clear_state backup_uploads; fi
