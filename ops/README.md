# Production ops (reference copies)

These are reference copies of the scripts installed on the production box at
`/home/hanschr/paperboy-ops/` — committed here so a dead box doesn't take the
runbook with it. The alert channel is a private ntfy.sh topic read from
`/home/hanschr/paperboy-ops/.ntfy-topic` (NOT in this repo — the repo is public).

## What runs

| Cron | Script | Does |
|---|---|---|
| `30 3 * * *` | `backup.sh` | `pg_dump -Fc` of the `paperboy` DB + tar of the uploads volume → `~/paperboy-backups/`, 14-day rotation, `pg_restore --list` sanity check, ntfy ping (OK daily / FAILED high-priority) |
| `*/5 * * * *` | `monitor.sh` | API `/health` (local), `www.neoteric.no` + `cms.neoteric.no` front-door 200s, disk ≥90%, backup-freshness (<48h). Alerts via ntfy with a 1h per-check cooldown |

## Restore

⚠️ **This procedure REPLACES live data.** Read it through first, and use the same
`<stamp>` for the dump and the uploads archive so database rows and media match.

The database the app actually reads is fixed: `docker-compose.yml` hardcodes
`DATABASE_URL=…/paperboy`, and nothing repoints it. So a restore has to land *in*
`paperboy` — an earlier version of this runbook loaded the dump into a side database
called `restore_target` and left the app on the broken one, while still rolling the
uploads volume back. Followed literally that was worse than doing nothing.

```bash
STAMP=<stamp>                       # e.g. 20260728-033000 — pick ONE for both files
DUMP=~/paperboy-backups/paperboy-$STAMP.dump
UPLOADS=~/paperboy-backups/uploads-$STAMP.tar.gz
VOLUME=$(docker compose config --format json \
  | python3 -c 'import json,sys; c=json.load(sys.stdin); print(c["volumes"]["paperboy-uploads"]["name"])')

# 0. Verify the archives BEFORE destroying anything. The uploads tarball is
#    root-owned mode 600, so read it inside a container.
docker exec -i paperboy-db pg_restore --list < "$DUMP" > /dev/null   # dump is intact
docker run --rm -v ~/paperboy-backups:/b alpine tar tzf /b/$(basename "$UPLOADS") | head -3

# 1. Quiesce every writer (api, web AND the mcp, which shares the uploads volume).
docker compose stop api web mcp

# 2. Database: restore into a scratch DB, then SWAP it into place. Restoring over a
#    live `paperboy` risks a half-applied dump with no way back; the swap is atomic
#    from the app's point of view and keeps the old data until you drop it.
docker exec paperboy-db psql -U paperboy -d postgres -c 'DROP DATABASE IF EXISTS paperboy_restore;'
docker exec paperboy-db psql -U paperboy -d postgres -c 'CREATE DATABASE paperboy_restore;'
docker exec -i paperboy-db pg_restore -U paperboy -d paperboy_restore --no-owner < "$DUMP"
# Sanity-check the restored copy before it becomes production.
docker exec paperboy-db psql -U paperboy -d paperboy_restore -tAc \
  'SELECT count(*) AS items FROM content_item;'
# Swap (needs no other sessions — the app is stopped).
docker exec paperboy-db psql -U paperboy -d postgres -c \
  'ALTER DATABASE paperboy RENAME TO paperboy_broken_'"$(date +%Y%m%d%H%M)"';'
docker exec paperboy-db psql -U paperboy -d postgres -c \
  'ALTER DATABASE paperboy_restore RENAME TO paperboy;'

# 3. Uploads: REPLACE (not merge) the volume, so the result is exactly the backup —
#    `tar x` overlays files and would otherwise leave orphans from the corrupted
#    state.
docker run --rm -v "$VOLUME":/data -v ~/paperboy-backups:/backup alpine \
  sh -c "find /data -mindepth 1 -delete && tar xzf /backup/uploads-$STAMP.tar.gz -C /data"

# 4. NEVER `docker compose start api web` here. `start` also starts depends_on
#    services — including `init`, as the CONTAINER it was last created from — and a
#    stale pre-guard init container re-running its unguarded seed is exactly what
#    wiped production on 2026-06-06. `up -d --no-deps` touches only these.
docker compose up -d --no-deps api web
docker compose --profile mcp up -d --no-deps mcp

# 5. Verify, then drop the renamed broken database once you're satisfied.
curl -fsS http://localhost:8091/health/ready
```

The database half of this path was drilled on 2026-06-06 (counts matched live
exactly); the swap-into-place steps above are the correction that drill exposed.

## Known gap (deliberate)

Backups currently live **on the same disk** as the data — they survive `rm -rf`,
reseeds and Postgres corruption, but not a disk failure. Next step when a
bucket/credential exists: add one `rclone copy ~/paperboy-backups remote:paperboy`
line to `backup.sh`.
