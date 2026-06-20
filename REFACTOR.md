# Refactor: split `index.js` into modules

Goal: break the single 537-line `index.js` into 5 scope-based ES modules for readability.
**Pure code-move — no behavior change.** Entry point stays `index.js`.

## Target layout

| File | Responsibility | Imports |
|------|----------------|---------|
| `config.js` | env vars, `PORT`, `SELFTEST`, `WINDOW_MS`, `WARN_MS`, `OPEN_BADGE` | — |
| `db.js` | schema (`CREATE TABLE`) + `q` prepared statements + `envBlocked` / `isBlocked` | config |
| `instagram.js` | IG Graph client (`displayName`, `igMessages`, `sendIG`, `reactIG`, `download`, `SENDERS`) + webhook utils (`validSignature`, `toMs`, `pickEmoji`) | config |
| `telegram.js` | `bot` instance, all `bot.command`/`bot.on` handlers, topic lifecycle (`setTopicOpen`, `createTopic`, `toUserTopic`, `forwardToTopic`, `forwardAttachment`), `mirrorReaction`, `statusText`, 2h cron, `startBot()` | config, db, instagram |
| `index.js` | `handleEvent` + HTTP webhook server (`startWebhook()`) + `selftest()` + bootstrap | all |

Dependency flow is one-way (`index → telegram → {db, instagram} → config`): **no circular imports.**

### Known wrinkle (handled)
`selftest()` lives in `index.js` and needs `statusText` from `telegram.js`; importing that module
constructs the `bot`, and grammy throws on an empty token (selftest has no `TELEGRAM_BOT_TOKEN`).

Fix: `new Bot(TELEGRAM_BOT_TOKEN || (SELFTEST ? 'selftest:placeholder' : ''))`.
- Production: unchanged (real token; throws loudly if genuinely missing — same as today).
- Selftest: constructs harmlessly. grammy makes **no** network call until `bot.start()`, which
  selftest never calls. Handlers register at import; `setInterval`/`bot.start` run only inside
  `startBot()`, so importing the module is side-effect-safe.

## Dockerfile change (critical — prevents a broken image)

```diff
- COPY package.json index.js ./
+ COPY package.json *.js ./
```
`.dockerignore` excludes `node_modules`, `.env`, `*.db`, `*.md`, `.git`, `photo*`, so `*.js` only
ships our source. `CMD ["node","index.js"]` and `package.json` scripts are unchanged.

## Commit sequence (each commit keeps the app working + selftest green)

1. **`config.js` + `db.js` + Dockerfile `COPY *.js`** — `index.js` imports from them. Dockerfile
   updated now so the image is correct as soon as a second `.js` exists.
2. **`instagram.js`** — `index.js` imports from it.
3. **`telegram.js`** — move all bot/handler/topic/status code out; slim `index.js` down to
   `handleEvent` + webhook server + `selftest` + bootstrap. This is the big one.
4. **Docs** — update README "Files" section + ARCHITECTURE "Components" to list the modules.

Gate every commit on `node --check` (all files) + `node index.js --selftest`. The Docker + boot
tests run before commit 3 is considered done (and again before deploy).

## Pre-deploy test gauntlet (stop on first failure)

| # | Step | Who runs it |
|---|------|-------------|
| 1 | `node --check` on each `.js` (syntax) | Claude |
| 2 | `node index.js --selftest` — all asserts pass | Claude |
| 3 | Diff review — confirm pure move, no logic drift | Claude (+ user spot-check) |
| 4 | Local boot with **dummy bot token**: `node --env-file=.env.test index.js` → logs show `telegram bot polling` **and** `webhook listening on :3000`, no throw | **User** |
| 5 | `docker build -t igtg .` then `docker run --env-file .env.test igtg` → container boots identically (proves `COPY *.js` shipped all modules) | **User** |
| 6 | `fly deploy`, watch logs; Fly holds the old machine until the new one passes the `GET /` health check. Then smoke: `/health` + one real DM round-trip | **User** |

## Prerequisites from the user

- [ ] **Dummy BotFather bot token** for steps 4–5 (do NOT use the prod token — a second poller on
      the same token causes a 409 conflict with the live bot).
- [ ] **`.env.test`** file with the dummy token + placeholder values for the other env vars
      (`TELEGRAM_CHAT_ID`, `META_APP_SECRET`, `IG_ACCESS_TOKEN`, `VERIFY_TOKEN`, …). Add `.env.test`
      to `.gitignore`. This is enough to prove the app **boots**; a full DM round-trip additionally
      needs a test supergroup (dummy bot as admin w/ Manage Topics) + a tunnel — **optional**, since
      this is a pure code-move and steps 2/5 already cover correctness + packaging.
- [ ] Steps 4–6 are run by the user (they touch your bot token / Fly account). Claude runs 1–3.

## Rollback

Pure move, so reverting is `git revert` of the refactor commits. If a deploy boots badly, Fly keeps
the previous healthy machine; `fly deploy` of the prior image (or `fly releases` rollback) restores.
