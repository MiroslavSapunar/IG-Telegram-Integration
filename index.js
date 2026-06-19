// IG DM <-> Telegram bridge (no AI yet).
//   IG DM -> webhook -> a per-user Telegram forum *topic*; a member typing in
//   that topic -> reply sent back to the IG user.
//   Requires a supergroup with Topics enabled + bot = admin with "Manage Topics".
// run:       node --env-file=.env index.js   (or npm start)
// self-test: node index.js --selftest
// expose:    cloudflared tunnel --url http://localhost:3000   (Meta needs HTTPS)
import http from 'node:http';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Bot } from 'grammy';

const PORT = process.env.PORT || 3000;
const { VERIFY_TOKEN, META_APP_SECRET, IG_ACCESS_TOKEN, IG_ACCOUNT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const SELFTEST = process.argv.includes('--selftest');

// --- light db (sqlite) ---
const db = new Database(SELFTEST ? ':memory:' : (process.env.DB_PATH || 'data.db'));
db.exec(`CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  igsid TEXT NOT NULL,
  direction TEXT NOT NULL,        -- 'in' | 'out'
  text TEXT,
  created_at INTEGER NOT NULL     -- unix ms
)`);
db.exec(`CREATE TABLE IF NOT EXISTS threads(
  igsid TEXT PRIMARY KEY,
  thread_id INTEGER NOT NULL,     -- telegram forum topic id
  name TEXT,
  created_at INTEGER NOT NULL
)`);
const q = {
  insertIn:      db.prepare(`INSERT INTO messages(igsid,direction,text,created_at) VALUES(?, 'in', ?, ?)`),
  insertOut:     db.prepare(`INSERT INTO messages(igsid,direction,text,created_at) VALUES(?, 'out', ?, ?)`),
  threadByIgsid: db.prepare(`SELECT thread_id FROM threads WHERE igsid=?`),
  igsidByThread: db.prepare(`SELECT igsid FROM threads WHERE thread_id=?`),
  insertThread:  db.prepare(`INSERT INTO threads(igsid,thread_id,name,created_at) VALUES(?,?,?,?)`),
};

// Meta signs the raw body: "x-hub-signature-256: sha256=<hmac>"
function validSignature(rawBody, header, secret = META_APP_SECRET) {
  if (!header || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// IG webhook timestamps come as s or ms — normalize to ms
const toMs = (t) => { const n = Number(t); return n ? (n < 1e12 ? n * 1000 : n) : Date.now(); };

// igsid -> "Name (@username)"; cached in memory (ponytail: refetched on restart, cheap)
const profileCache = new Map();
async function displayName(igsid) {
  if (profileCache.has(igsid)) return profileCache.get(igsid);
  let label = igsid;
  try {
    const r = await fetch(`https://graph.instagram.com/v25.0/${igsid}?fields=name,username&access_token=${IG_ACCESS_TOKEN}`);
    if (r.ok) { const p = await r.json(); if (p.username) label = `${p.name || p.username} (@${p.username})`; }
  } catch { /* fall back to raw igsid */ }
  profileCache.set(igsid, label);
  return label;
}

async function sendIG(igsid, text) {
  const res = await fetch('https://graph.instagram.com/v25.0/me/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body.error ?? body));
  return body;
}

if (SELFTEST) selftest();
else main();

function main() {
  for (const [k, v] of Object.entries({ META_APP_SECRET, IG_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VERIFY_TOKEN }))
    if (!v) console.warn(`⚠️  ${k} not set`);

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  // helper to find the group's chat id: type /id in the group
  bot.command('id', (ctx) => ctx.reply(`chat id: ${ctx.chat.id}`));

  // a member typing inside a user's topic -> relay text back to that IG user
  bot.on('message:text', async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    if (!threadId || ctx.message.text.startsWith('/')) return;  // General topic / commands
    const row = q.igsidByThread.get(threadId);
    if (!row) return;                                           // not a mapped topic
    try {
      await sendIG(row.igsid, ctx.message.text);
      q.insertOut.run(row.igsid, ctx.message.text, Date.now());
    } catch (e) {
      await ctx.reply(`❌ IG send failed: ${e.message}`);       // e.g. outside 24h window
    }
  });
  bot.start({ onStart: () => console.log('telegram bot polling') });

  // find or create this user's forum topic (persisted so it survives restarts)
  async function threadFor(igsid) {
    const existing = q.threadByIgsid.get(igsid);
    if (existing) return existing.thread_id;
    const name = (await displayName(igsid)).slice(0, 128);
    const topic = await bot.api.createForumTopic(TELEGRAM_CHAT_ID, name);
    q.insertThread.run(igsid, topic.message_thread_id, name, Date.now());
    console.log(`created topic ${topic.message_thread_id} for ${name}`);
    return topic.message_thread_id;
  }

  async function handleEvent(body) {
    const items = [];
    for (const entry of body.entry ?? []) {
      for (const m of entry.messaging ?? []) items.push(m);                          // real DM events
      for (const c of entry.changes ?? []) if (c.field === 'messages') items.push(c.value); // dashboard test
    }
    if (body.field === 'messages' && body.value) items.push(body.value);
    for (const m of items) {
      const igsid = m.sender?.id;
      if (igsid === IG_ACCOUNT_ID || m.message?.is_echo) continue;   // our own outgoing message echoed back
      if (m.read || m.delivery || m.reaction) continue;             // read/delivery receipts, reactions
      const text = m.message?.text;
      if (text === undefined) { console.log('non-text event:', JSON.stringify(m)); continue; }
      q.insertIn.run(igsid, text, toMs(m.timestamp));
      const threadId = await threadFor(igsid);
      await bot.api.sendMessage(TELEGRAM_CHAT_ID, text, { message_thread_id: threadId });
      console.log(`DM from ${igsid} -> topic ${threadId}: ${text}`);
    }
  }

  http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/' && req.method === 'GET') { res.writeHead(200).end('ok'); return; }
    if (url.pathname !== '/webhook') { res.writeHead(404).end(); return; }

    if (req.method === 'GET') {                              // Meta verification handshake
      const ok = url.searchParams.get('hub.mode') === 'subscribe'
        && url.searchParams.get('hub.verify_token') === VERIFY_TOKEN;
      res.writeHead(ok ? 200 : 403).end(ok ? url.searchParams.get('hub.challenge') : undefined);
      return;
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => {
        const sigOk = validSignature(raw, req.headers['x-hub-signature-256']);
        console.log(`POST /webhook (${raw.length}b, sig ${sigOk ? 'ok' : 'MISSING/BAD'})`);
        if (!sigOk) { res.writeHead(401).end(); return; }
        res.writeHead(200).end();                           // ack within 30s, then process
        handleEvent(JSON.parse(raw)).catch(e => console.error('handle error', e.message));
      });
      return;
    }
    res.writeHead(405).end();
  }).listen(PORT, () => console.log(`webhook listening on :${PORT}/webhook`));
}

function selftest() {
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
  // signature
  const body = '{"x":1}', secret = 'testsecret';
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert(validSignature(body, sig, secret), 'valid signature passes');
  assert(!validSignature(body, 'sha256=bad', secret), 'bad signature fails');
  // topic routing: igsid <-> thread_id persisted both ways
  q.insertThread.run('IG123', 555, 'Karnaza (@k4rn4z4)', 1000);
  assert(q.igsidByThread.get(555)?.igsid === 'IG123', 'topic routes to correct IGSID');
  assert(q.threadByIgsid.get('IG123')?.thread_id === 555, 'igsid maps to its topic');
  assert(q.igsidByThread.get(999) === undefined, 'unknown topic routes nowhere');
  console.log('selftest OK');
}
