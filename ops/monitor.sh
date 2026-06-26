#!/usr/bin/env bash
# Paperboy 5-minute monitor: api health, public site, admin, disk. Alerts via
# ntfy with a 1h per-check cooldown so a sustained outage doesn't spam.
set -u
TOPIC=$(cat /home/hanschr/paperboy-ops/.ntfy-topic)
STATE=/home/hanschr/paperboy-ops/.monitor-state
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

# API health (local — independent of Cloudflare).
if ! curl -fsS -m 10 http://localhost:8091/health | grep -q '"ok"'; then
  alert api "Paperboy API unhealthy" "http://localhost:8091/health failed on the box"
else clear_state api; fi

# Public site + admin through the front door.
code=$(curl -s -o /dev/null -m 15 -w "%{http_code}" https://www.neoteric.no/)
if [ "$code" != "200" ]; then alert www "www.neoteric.no is $code" "Front page returned $code"; else clear_state www; fi
code=$(curl -s -o /dev/null -m 15 -w "%{http_code}" https://cms.neoteric.no/)
if [ "$code" != "200" ]; then alert cms "cms.neoteric.no is $code" "Admin returned $code"; else clear_state cms; fi

# Disk (uploads + variants + backups all grow). Already at ~81% — alert at 90%.
use=$(df --output=pcent / | tail -1 | tr -dc 0-9)
if [ "${use:-0}" -ge 90 ]; then
  alert disk "Disk ${use}% full on the Paperboy box" "df / shows ${use}% — prune backups/variants or grow the disk"
else clear_state disk; fi

# Yesterday's backup must exist (catches a silently-removed cron). BOTH halves of
# the backup are required for a full restore, so monitor each independently — a
# silently-failing uploads tar must not hide behind a healthy pg dump.
if ! find /home/hanschr/paperboy-backups -name "paperboy-*.dump" -mtime -2 2>/dev/null | grep -q .; then
  alert backup "Paperboy backup is stale" "No pg dump newer than 48h in paperboy-backups/"
else clear_state backup; fi
if ! find /home/hanschr/paperboy-backups -name "uploads-*.tar.gz" -mtime -2 2>/dev/null | grep -q .; then
  alert backup_uploads "Paperboy uploads backup is stale" "No uploads tarball newer than 48h in paperboy-backups/"
else clear_state backup_uploads; fi
