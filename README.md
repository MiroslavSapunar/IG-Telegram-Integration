# IG–Telegram Integration

Bridge between an Instagram professional account's DMs and a private Telegram group.
Incoming Instagram DMs are forwarded to Telegram; union members reply from Telegram and
the reply is sent back to the Instagram user. AI-suggested replies are planned but **not
yet implemented** — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

| Piece | State |
|-------|-------|
| IG auth (Instagram Login, `graph.instagram.com`) | ✅ working |
| Inbound DM via `messages` webhook | ✅ working (real users, no App Review — own account) |
| Forward DM → Telegram group | ✅ |
| Reply from Telegram → IG (`/me/messages`) | ✅ (needs live test) |
| Persistence (SQLite, timestamps, follow-ups) | ✅ |
| AI-suggested replies (Claude) | ⏳ deferred |
| Deploy (Fly.io) | ⏳ next |

## How it works

```
IG user DMs the account
  → Meta webhook → POST /webhook   (signature-verified)
  → stored in data.db, forwarded to the Telegram group as "📩 IG <igsid>\n<text>"
  → member *replies to that message* in Telegram
  → reply sent to the IG user via graph.instagram.com/me/messages (24h window)
```

Reply routing: each forwarded message's Telegram `message_id` is mapped to the sender's
IGSID in SQLite, so a Telegram reply goes back to the right Instagram user.

## Setup — step by step

Requires Node 20+. Assumes you already have a Meta app (Instagram API with Instagram Login)
and know where to find/add its credentials — see [ARCHITECTURE.md](ARCHITECTURE.md) for the
Meta-side details and constraints.

### 1. Install deps

```bash
yarn install      # or: npm install
```

`better-sqlite3` compiles natively — needs Xcode Command Line Tools on macOS.

### 2. Fill the Instagram credentials in `.env`

```
META_APP_ID=         # your Meta/Instagram app id
META_APP_SECRET=     # used to verify the x-hub-signature-256 webhook signature
IG_ACCESS_TOKEN=     # IGAA… user token (App Dashboard → Instagram → Generate token)
IG_ACCOUNT_ID=       # informational; the token resolves the account itself
VERIFY_TOKEN=        # any random string; must match the Meta webhook config below
```

### 3. Create the bot (BotFather)

- DM **@BotFather** → `/newbot` → name it → copy the token.
- Privacy mode: **no action needed** — members reply to the bot's own forwarded message, and
  bots always receive replies to their own messages even with privacy ON.

### 4. Create the group + get its id

- Create a private group, add your bot.
- Start the server (step 6), then type **`/id`** in the group → bot replies `chat id: -100…`.

### 5. Add the Telegram values to `.env`

```
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_CHAT_ID=<the id from /id>
# PORT=3000        # optional
# DB_PATH=data.db  # optional
```

### 6. Run + expose

```bash
yarn start                                       # node --env-file=.env index.js
cloudflared tunnel --url http://localhost:3000   # new terminal — public HTTPS for the webhook
```

Point the Meta app's webhook callback to `https://<tunnel>/webhook` with your `VERIFY_TOKEN`
and subscribe to the **`messages`** field. The quick-tunnel URL changes on every restart —
re-paste it into the dashboard when it does.

### 7. Test the round-trip

```bash
yarn selftest    # offline: signature validation + reply-routing logic
```

End-to-end:
- Real DM to the IG account → appears in the group as `📩 IG <igsid>\n<text>`.
- **Reply** to that message in Telegram → the IG user receives your text.
- Outside 24h of their last message → bot posts `❌ IG send failed` (expected Meta limit).

## Files

- `index.js` — the whole bridge: webhook server + Telegram bot + SQLite (deps: `grammy`, `better-sqlite3`)
- `test-ig.js` — throwaway: verify the IG token and fetch profile/conversations
- `data.db` — SQLite message log (gitignored)
- `ARCHITECTURE.md` — design, Meta API constraints, and findings
