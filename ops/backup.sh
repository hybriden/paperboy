#!/usr/bin/env bash
# Paperboy nightly backup: Postgres (custom format) + uploads volume, 14-day
# rotation, ntfy alert on failure + daily OK ping. Installed by ops automation.
set -euo pipefail
# Backups are a full credential dump (argon2id hashes, encrypted TOTP secrets,
# session/MCP tokens, delivery keys). Lock them down: owner-only files + dir.
umask 077
TOPIC=$(cat /home/hanschr/paperboy-ops/.ntfy-topic)
DIR=/home/hanschr/paperboy-backups
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DIR"
chmod 700 "$DIR"

notify() { # title, priority, tags, body
  curl -fsS -m 10 -H "Title: $1" -H "Priority: $2" -H "Tags: $3" -d "$4" "https://ntfy.sh/$TOPIC" >/dev/null 2>&1 || true
}
fail() {
  notify "Paperboy backup FAILED" high rotating_light "$1 (at $STAMP)"
  exit 1
}

# 1. Database — custom format (pg_restore-able, compressed). The host-side
#    redirect creates the file under our umask 077 (mode 600); make it explicit.
docker exec paperboy-db pg_dump -U paperboy -Fc paperboy > "$DIR/paperboy-$STAMP.dump" || fail "pg_dump failed"
chmod 600 "$DIR/paperboy-$STAMP.dump"
[ -s "$DIR/paperboy-$STAMP.dump" ] || fail "pg_dump produced an empty file"

# 2. Uploads volume (originals + image-variant cache).
#
#    The volume name carries Compose's PROJECT PREFIX, which defaults to the checkout
#    directory name — so it is `paperboycms_paperboy-uploads` only while the repo sits
#    in a directory called `paperboycms`. Rename the checkout, or run with `-p`, and
#    `docker run -v <name>:/data` CREATES A NEW EMPTY VOLUME rather than failing;
#    `tar czf` of an empty directory then exits 0 and this script would report
#    "backup OK" every night while archiving nothing. monitor.sh only checks file
#    mtime, so it cannot catch that either.
#
#    So: resolve the name from Compose, assert the volume already exists, and assert
#    the archive actually contains files.
VOLUME=${PAPERBOY_UPLOADS_VOLUME:-}
if [ -z "$VOLUME" ]; then
  # Ask Compose for the RESOLVED (project-prefixed) volume name. Note the api
  # service's `volumes[].source` is the UNprefixed key ("paperboy-uploads"), so it
  # must be looked up in the top-level `volumes` block, whose `.name` carries the
  # real one ("paperboycms_paperboy-uploads").
  VOLUME=$(cd /home/hanschr/paperboycms 2>/dev/null && docker compose config --format json 2>/dev/null \
    | python3 -c 'import json,sys
try:
    cfg = json.load(sys.stdin)
except Exception:
    sys.exit(0)
src = ""
for v in cfg.get("services", {}).get("api", {}).get("volumes", []) or []:
    if v.get("target") == "/app/uploads" and v.get("type") == "volume":
        src = v.get("source", ""); break
if src:
    print((cfg.get("volumes", {}).get(src) or {}).get("name") or src)' 2>/dev/null) || VOLUME=""
fi
[ -n "$VOLUME" ] || fail "could not determine the uploads volume name (set PAPERBOY_UPLOADS_VOLUME)"
# MUST already exist — a missing volume means we resolved the wrong name, and letting
# docker create it would silently back up an empty directory.
docker volume inspect "$VOLUME" >/dev/null 2>&1 || fail "uploads volume '$VOLUME' does not exist (wrong Compose project name?)"

#    The container writes the tarball as root, so set the umask INSIDE it (the host
#    cron user can't chmod a root-owned file) — result is a root-owned, mode-600 archive.
docker run --rm -v "$VOLUME":/data:ro -v "$DIR":/backup alpine \
  sh -c "umask 077; tar czf /backup/uploads-$STAMP.tar.gz -C /data ." || fail "uploads tar failed"

# 2b. Verify the archive is real. An empty/near-empty tar is the failure mode this
#     script used to report as success, so it is checked as strictly as the dump.
[ -s "$DIR/uploads-$STAMP.tar.gz" ] || fail "uploads tarball is empty"
# Counted INSIDE a container, as root: the archive is deliberately root-owned mode
# 600 (umask 077 above), so the cron user cannot read it and a host-side `tar tzf`
# would always fail — which is how the first version of this check was wrong.
COUNTS=$(docker run --rm -v "$VOLUME":/data:ro -v "$DIR":/backup alpine \
  sh -c "echo \"\$(tar tzf /backup/uploads-$STAMP.tar.gz | grep -vc '/$') \$(find /data -type f | wc -l)\"") \
  || fail "uploads tarball is unreadable"
ENTRIES=${COUNTS%% *}
LIVE=${COUNTS##* }
# Allow a small delta (files written mid-archive), but catch "archived nothing".
if [ "$ENTRIES" -lt 1 ] || { [ "$LIVE" -gt 10 ] && [ "$ENTRIES" -lt $((LIVE / 2)) ]; }; then
  fail "uploads archive has $ENTRIES entries but the volume holds $LIVE files"
fi

# 3. Sanity: the dump must be readable by pg_restore (catches truncated writes).
docker exec -i paperboy-db pg_restore --list < "$DIR/paperboy-$STAMP.dump" > /dev/null || fail "dump unreadable by pg_restore"

# 4. Rotate: keep the newest 14 of each.
ls -1t "$DIR"/paperboy-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$DIR"/uploads-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

SIZE=$(du -sh "$DIR" | cut -f1)
notify "Paperboy backup OK" default white_check_mark "pg + uploads ($ENTRIES files) @ $STAMP — backup dir now $SIZE"
