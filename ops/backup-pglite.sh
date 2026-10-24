#!/usr/bin/env bash
# Paperboy backup for PGlite mode (DATABASE_URL=pglite:///data/db): the database
# and uploads live in ONE volume. PGlite has no pg_dump endpoint and its files
# can't be copied while it writes, so this stops the container, archives the
# volume, and always starts it again. Expect a few seconds of downtime.
#
#   PAPERBOY_CONTAINER=paperboy PAPERBOY_VOLUME=pbdata ops/backup-pglite.sh
#
# Same contract as backup.sh: owner-only files, an empty archive is a failure,
# newest 14 kept, ntfy ping when ~/.config/paperboy/ntfy-topic exists.
set -euo pipefail
umask 077 # a backup holds password hashes, tokens and visitor PII
CONTAINER=${PAPERBOY_CONTAINER:?set PAPERBOY_CONTAINER to the paperboy container name}
VOLUME=${PAPERBOY_VOLUME:?set PAPERBOY_VOLUME to the volume mounted at /data}
DIR=${PAPERBOY_BACKUP_DIR:-$HOME/paperboy-backups}
TOPIC_FILE=${PAPERBOY_NTFY_TOPIC_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/paperboy/ntfy-topic}
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/paperboy-pglite-$STAMP.tar.gz"
mkdir -p "$DIR" && chmod 700 "$DIR"

notify() { [ -r "$TOPIC_FILE" ] && curl -fsS -m 10 -H "Title: $1" -H "Priority: $2" -d "$3" "https://ntfy.sh/$(cat "$TOPIC_FILE")" >/dev/null 2>&1 || true; }
fail() { echo "Paperboy backup FAILED: $1 (at $STAMP)" >&2; notify "Paperboy backup FAILED" high "$1 (at $STAMP)"; exit 1; }

# A missing volume would be CREATED empty by `docker run -v` and archived as "OK".
docker volume inspect "$VOLUME" >/dev/null 2>&1 || fail "volume '$VOLUME' does not exist"
docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "container '$CONTAINER' does not exist"

docker stop -t 30 "$CONTAINER" >/dev/null || fail "could not stop $CONTAINER"
trap 'docker start "$CONTAINER" >/dev/null || echo "Paperboy backup: COULD NOT RESTART $CONTAINER" >&2' EXIT
docker run --rm -v "$VOLUME":/data:ro -v "$DIR":/backup alpine \
  sh -c "umask 077; tar czf /backup/$(basename "$OUT") -C /data ." || fail "tar failed"
docker start "$CONTAINER" >/dev/null || fail "could not restart $CONTAINER"
trap - EXIT

# PG_VERSION exists in every Postgres data directory: no database in the archive = no backup.
# Checked inside the container: on the host, grep -q closing the pipe early trips pipefail.
docker run --rm -v "$DIR":/backup alpine sh -c "tar tzf /backup/$(basename "$OUT") | grep -q 'PG_VERSION\$'" \
  || fail "archive has no database (is the volume mounted at /data with DATABASE_URL=pglite:///data/db?)"

ls -1t "$DIR"/paperboy-pglite-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
notify "Paperboy backup OK" default "pglite volume @ $STAMP — $(du -sh "$OUT" | cut -f1)"
echo "Backed up $VOLUME to $OUT"
