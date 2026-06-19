# IG-Telegram Integration — Architecture Document

## Problem

University student union IG account (10.4k followers) receives high volume of DMs. Multiple union members share access to the account, making DM management chaotic and uncoordinated.

## Solution

A bridge between Instagram DMs and a private Telegram group, with AI-assisted reply suggestions. Union members review, edit, and approve replies from Telegram before they're sent back via Instagram.

## Flow

Current (implemented, no AI yet):

1. DM arrives on Instagram
2. Meta sends a `messages` webhook to our server
3. Server verifies the signature, acks HTTP 200, stores the message in SQLite
4. Server forwards the DM to the Telegram group: `📩 IG <igsid>\n<text>`
5. A union member *replies to that message* in Telegram
6. Server maps the reply to the sender's IGSID and sends it back via the IG API (within the 24h window)

Planned (Phase 4): before step 4, Claude reads the message + FAQ context and the forwarded
card carries an AI-suggested reply the member can approve or edit.

## Tech Stack

| Component  | Choice                                                          |
|------------|-----------------------------------------------------------------|
| Runtime    | Node.js 20+ (ESM, plain JS — no TypeScript build step)          |
| Hosting    | Fly.io (Docker + a small volume for the SQLite file)            |
| IG         | Instagram API with Instagram Login (`graph.instagram.com` v25.0)|
| Telegram   | `grammy` (long-polling)                                         |
| AI         | Claude API (`@anthropic-ai/sdk`) — planned                      |
| Storage    | SQLite via `better-sqlite3` (message log with timestamps)       |

Dependency choices are deliberately minimal: native `node:http` for the webhook, `grammy`
for the bot, `better-sqlite3` for storage. No web framework, no ORM.

## Instagram API Constraints

- **API flavor**: **Instagram API with Instagram Login** — base URL `graph.instagram.com`, version `v25.0`. NOT the Facebook-Page/Graph route (no FB Page required).
- **Account**: Must be Instagram Business or Creator (no Facebook Page link needed for this flavor)
- **Permissions required**: `instagram_business_basic`, `instagram_business_manage_messages` (also `instagram_business_manage_comments` configured)
- **Access token**: Instagram User token (`IGAA...`), generated via App Dashboard → Instagram → API setup with Instagram business login → **Generate token**. Dashboard tokens last 60 days. (Graph API Explorer is the wrong tool — it issues FB/app tokens.)
- **Rate limit**: 200 DMs/hour
- **Messaging window**: 24h to reply (extendable with `human_agent` permission)
- **Webhook**: Must respond HTTP 200 within 30 seconds; payloads are signed `x-hub-signature-256: sha256=<hmac>` with the app secret
- **Publishing**: the app must be **Live/published** to receive real webhooks — this only needs basic settings + a privacy-policy URL
- **App Review**: NOT required for the union's own account (direct-developer / Standard Access path). Advanced Access via App Review is only needed to serve accounts you don't own.

## Findings (verified 2026-06-18)

Confirmed by direct testing against the live `mli.fiuba` account:

- ✅ **Auth**: Instagram Login app + `IGAA...` token works; resolves to `mli.fiuba` (`user_id 17841407167444620`).
- ✅ **Reading DMs = webhook, not polling**: once the app is **published (Live)**, the `messages` webhook delivers real DMs from real (non-tester) users — no App Review for the own account. `GET /me/conversations` returns `[]` (event-driven API, not a historical inbox dump) and is unused.
- ✅ **Publishing ≠ App Review**: Live mode is a light gate (basic settings + privacy-policy URL). App Review (Advanced Access) is a separate, heavier gate not required here.
- 🔁 **Sending**: `POST /me/messages` replies to the `sender.id` (IGSID) from the webhook payload, within the 24h window.
- ⚙️ **Webhook quirks**: the dashboard "Test" button sends a *signed* sample (passes HMAC). The quick `cloudflared` tunnel URL changes on every restart — re-paste it into the dashboard.

**Implication**: the inbound path is webhook-first and already working end-to-end in dev. The
remaining work is hosting (stable URL) and the AI layer — not Meta approvals.

## Components

Everything runs in a single Node process (`index.js`): HTTP webhook server + grammy bot + SQLite.

### 1. Webhook server (native `node:http`)
- `GET /webhook`: Meta verify-token handshake (echoes `hub.challenge`)
- `POST /webhook`: validates `x-hub-signature-256`, acks 200, forwards the DM to Telegram

### 2. Telegram bot (`grammy`, long-polling)
- Private group with union members
- Forwards each incoming IG DM as a message
- Reply routing: a member *replies* to the forwarded message → mapped to the IGSID → sent to IG
- `/id` command prints the group's chat id

### 3. Storage (SQLite, `better-sqlite3`)
- `messages` table: `igsid`, `direction` (in/out), `text`, `created_at`, `tg_message_id`
- Persists conversation history (follow-ups + dates) and maps Telegram replies → IGSID

### 4. Claude AI (planned, Phase 4)
- DM text + FAQ context → suggested reply shown in the Telegram card for approve/edit

### 5. FAQ storage (planned, Phase 4)
- Q&A pairs as context for Claude; start as a `.json` file, fold into SQLite if it grows

## Implementation Phases

- ✅ **Phase 2 — Instagram Webhook**: verify (GET) + signed event handler (POST), DM parsing.
- ✅ **Phase 3 — Telegram Bot**: BotFather bot, private group, IG DM → Telegram forwarding.
- ✅ **Phase 5 — Reply Path**: member's Telegram reply → IG via `POST /me/messages`; messages persisted in SQLite.
- ⏳ **Phase 6 — Deployment**: Dockerfile + Fly.io (volume for SQLite, stable webhook URL, secrets).
- ⏳ **Phase 4 — Claude AI**: Claude integration, FAQ context, suggested reply in the Telegram card.

(Phase 1's TypeScript/Express scaffold was dropped — native `http` + plain JS was enough.)

## Prerequisites (manual steps)

1. IG account is Business/Creator (no Facebook Page link needed for the Instagram Login flavor)
2. Meta app created, Instagram product = "API setup with Instagram business login"
3. App **published (Live)** with a privacy-policy URL (required to receive real webhooks)
4. Telegram bot via @BotFather + private group with the bot added
5. (Phase 4) Claude API key from console.anthropic.com

See the README for the step-by-step run/setup guide.
