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

```bash
DUMP=$(ls -1t ~/paperboy-backups/paperboy-*.dump | head -1)
docker exec paperboy-db psql -U paperboy -d postgres -c "CREATE DATABASE restore_target;"
docker exec -i paperboy-db pg_restore -U paperboy -d restore_target --no-owner < "$DUMP"
# uploads:
docker run --rm -v paperboycms_paperboy-uploads:/data -v ~/paperboy-backups:/backup alpine \
  tar xzf /backup/uploads-<stamp>.tar.gz -C /data
```

The restore path was drilled on 2026-06-06 (counts matched live exactly).

## Known gap (deliberate)

Backups currently live **on the same disk** as the data — they survive `rm -rf`,
reseeds and Postgres corruption, but not a disk failure. Next step when a
bucket/credential exists: add one `rclone copy ~/paperboy-backups remote:paperboy`
line to `backup.sh`.
