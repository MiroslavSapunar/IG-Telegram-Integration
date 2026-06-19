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
