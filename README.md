# IG–Telegram Integration

Bridge between an Instagram professional account's DMs and a private Telegram group.
Incoming Instagram DMs are forwarded to Telegram; union members reply from Telegram and
the reply is sent back to the Instagram user. AI-suggested replies are planned but **not
yet implemented** — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

| Piece | State |
|-------|-------|
| IG auth (Instagram Login, `graph.instagram.com`) | ✅ working |
| Inbound DM (text + media) via `messages` webhook | ✅ working (real users, no App Review — own account) |
| Per-user Telegram forum topics | ✅ |
| Reply from Telegram → IG (`/me/messages`) | ✅ |
| Reaction sync (Telegram ↔ IG, both ways) | ✅ |
| Open-topic `/status` + 2h alert into General | ✅ |
| Moderation/ops commands (block, prune, health, …) | ✅ |
| Persistence (SQLite on a Fly volume) | ✅ |
| Deploy (Fly.io, ~64 MB image) | ✅ |
| AI-suggested replies (Claude) | ⏳ deferred |

## How it works

```
IG user DMs the account (text or media)
  → Meta webhook → POST /webhook   (signature-verified)
  → stored in SQLite, forwarded into that user's Telegram forum topic
  → member types a reply inside the topic
  → reply sent to the IG user via graph.instagram.com/me/messages (24h window)
```

- **One topic per IG user**, named `Name (@username)`, created on first DM (auto-recreated if deleted).
- Routing is by the topic's `message_thread_id` → IGSID (persisted in SQLite), so replies reach the right user.
- **Media** (image/video/audio/file) is downloaded and re-uploaded into the topic; shares/links fall back to a link.
- **Attention = open/closed topic + ✉️ badge**: an open topic (✉️ in its name) needs the team; `/read` closes it and drops the badge, a new DM reopens it, so handled chats leave the active list. Replies keep it open (for follow-ups); command acks self-delete so the preview stays the real conversation.
- **Reactions sync both ways**: a member's emoji reaction in Telegram is mirrored onto the IG message, and an IG user's reaction (on their message or your reply) is mirrored back onto the Telegram message (mapped to Telegram's allowed set).
- **`/status`** lists open topics with the time left on each one's IG 24h reply window (`⚠️` under 6h, `⛔` expired); a 2h job auto-posts it into General when anything is open.

## Commands

`/help` `/general` (reply to a message → copy it to #General with a back-link) `/read` `/unread`
(close as resolved / reopen as pending) `/block` `/unblock` (soft-ignore a user, not blocked on IG)
`/blocklist` (list blocked users) `/leaderboards` (per-member message count, excludes General)
`/status` (open topics + 24h-window time left, ⚠️ under 6h) `/health` (bot + IG token status)
`/prune` (delete topics inactive > 1 year) `/id` (chat id).

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

### 4. Create the supergroup + get its id

- Create a private group, **enable Topics** (converts it to a supergroup), and add the bot
  as **admin with "Manage Topics"** (needed to create/rename/delete per-user topics).
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
and subscribe to the **`messages`** field **and the message-reactions field** (the latter is
required for IG-user reactions to mirror into Telegram). The quick-tunnel URL changes on every
restart — re-paste it into the dashboard when it does.

### 7. Test the round-trip

```bash
yarn selftest    # offline: signature, topic/reply routing, blocklist, unread, prune, reactions
```

End-to-end:
- Real DM to the IG account → a topic `✉️ Name (@username)` appears (open), with the message inside.
- **Type a reply inside that topic** → the IG user receives it; the topic stays open. Type `/read` to close it and drop the ✉️ once resolved.
- Outside 24h of their last message → bot posts `❌ IG send failed` (expected Meta limit).

## Files

- `index.js` — the whole bridge: webhook server + Telegram bot + SQLite (deps: `grammy`, `better-sqlite3`)
- `data.db` — SQLite message log (gitignored)
- `ARCHITECTURE.md` — design, Meta API constraints, and findings
- `FLY.md` — Fly.io deploy cheatsheet
