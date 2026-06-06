#!/usr/bin/env bash
# Paperboy nightly backup: Postgres (custom format) + uploads volume, 14-day
# rotation, ntfy alert on failure + daily OK ping. Installed by ops automation.
set -euo pipefail
TOPIC=$(cat /home/hanschr/paperboy-ops/.ntfy-topic)
DIR=/home/hanschr/paperboy-backups
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DIR"

notify() { # title, priority, tags, body
  curl -fsS -m 10 -H "Title: $1" -H "Priority: $2" -H "Tags: $3" -d "$4" "https://ntfy.sh/$TOPIC" >/dev/null 2>&1 || true
}
fail() {
  notify "Paperboy backup FAILED" high rotating_light "$1 (at $STAMP)"
  exit 1
}

# 1. Database — custom format (pg_restore-able, compressed).
docker exec paperboy-db pg_dump -U paperboy -Fc paperboy > "$DIR/paperboy-$STAMP.dump" || fail "pg_dump failed"
[ -s "$DIR/paperboy-$STAMP.dump" ] || fail "pg_dump produced an empty file"

# 2. Uploads volume (originals + image-variant cache).
docker run --rm -v paperboycms_paperboy-uploads:/data:ro -v "$DIR":/backup alpine \
  tar czf "/backup/uploads-$STAMP.tar.gz" -C /data . || fail "uploads tar failed"

# 3. Sanity: the dump must be readable by pg_restore (catches truncated writes).
docker exec -i paperboy-db pg_restore --list < "$DIR/paperboy-$STAMP.dump" > /dev/null || fail "dump unreadable by pg_restore"

# 4. Rotate: keep the newest 14 of each.
ls -1t "$DIR"/paperboy-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$DIR"/uploads-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

SIZE=$(du -sh "$DIR" | cut -f1)
notify "Paperboy backup OK" default white_check_mark "pg + uploads @ $STAMP — backup dir now $SIZE"
