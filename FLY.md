# Fly.io cheatsheet

App: `ig-telegram-integration` · region `gru` · one machine · SQLite on volume `ig_data` (`/data`).

## Deploy
```bash
fly deploy                 # build Dockerfile + release
fly status                 # machine state, health, version
fly logs                   # live logs (webhook hits, topic creation, errors)
fly logs --no-tail | tail  # recent logs only
```

## Secrets (env in production)
```bash
fly secrets list                          # names only (values hidden)
fly secrets set KEY=value                  # set/replace one — triggers a restart
fly secrets set IG_ACCESS_TOKEN=IGAA…      # e.g. rotating the 60-day token
fly secrets unset KEY
```
Required: `META_APP_SECRET`, `IG_ACCESS_TOKEN`, `IG_ACCOUNT_ID`, `VERIFY_TOKEN`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Optional: `BLOCKED_IGSIDS` (comma-separated).
`PORT` / `DB_PATH` come from `fly.toml`.

## Machine — keep it at ONE
Telegram long-polling allows a single getUpdates consumer per token, and SQLite is one
file on one volume. Never scale > 1.
```bash
fly scale count 1
fly machine restart <id>   # ids from `fly status`
```

## Volume / SQLite
```bash
fly volumes list
fly ssh console            # shell into the machine
#   ls -la /data           # data.db lives here
```

## Backups
Two layers: Fly's automatic **volume snapshots** (Fly-internal) + an on-demand **manual dump** you
pull off-box. No app changes — this is all CLI.

### Snapshots (automatic, daily)
Bump retention from the default to ~30 days (volume id from `fly volumes list`):
```bash
fly volumes list
fly volumes update vol_4oje010p2geo3ypr --snapshot-retention 30
fly volumes snapshots list vol_4oje010p2geo3ypr     # what's available to restore
```
(If your flyctl rejects `update --snapshot-retention`, check `fly volumes update --help`; on older
versions retention is set at create time with the same flag.)
Restore = make a new volume from a snapshot, then redeploy onto it (only one volume mounted at a time):
```bash
fly volumes create ig_data --region gru --size 1 --snapshot-id <snap-id>
```

### Manual dump (on-demand, off-box copy)
`sqlite3` isn't in the slim image, and you must **never** just `cp` a live DB — use the bundled
`better-sqlite3` to write a consistent copy via `VACUUM INTO`, then pull it with sftp (binary-safe).
```bash
# 1. shell in and write a consistent copy onto the volume (re-runnable)
fly ssh console
  cd /app
  rm -f /data/dump.db
  node -e "const D=require('better-sqlite3'); new D('/data/data.db').exec(\"VACUUM INTO '/data/dump.db'\")"
  exit

# 2. download it (timestamped)
fly ssh sftp get /data/dump.db data-$(date +%F).db

# 3. clean up the temp copy on the volume
fly ssh console -C "rm -f /data/dump.db"
```
`data-YYYY-MM-DD.db` is a normal SQLite file — inspect it with any SQLite tool, or restore by stopping
the machine and putting it back at `/data/data.db`. **A backup isn't real until you've test-restored one.**

## First-time setup (already done — for re-creation)
```bash
fly apps create ig-telegram-integration
fly volumes create ig_data --region gru --size 1
fly secrets set …         # all of the above
fly deploy
fly scale count 1
```

## Webhook
Callback URL is stable: `https://ig-telegram-integration.fly.dev/webhook`.
Health check: `curl https://ig-telegram-integration.fly.dev/` → `ok`.
In Telegram, `/health` reports IG token validity + last DM + uptime.
