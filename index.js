// IG DM <-> Telegram bridge (no AI yet).
//   IG DM -> webhook -> Telegram group; member replies-to-message -> back to IG.
// run:       node --env-file=.env index.js   (or npm start)
// self-test: node index.js --selftest
// expose:    cloudflared tunnel --url http://localhost:3000   (Meta needs HTTPS)
import http from 'node:http';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Bot } from 'grammy';

const PORT = process.env.PORT || 3000;
const { VERIFY_TOKEN, META_APP_SECRET, IG_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const SELFTEST = process.argv.includes('--selftest');

// --- light db (sqlite) ---
const db = new Database(SELFTEST ? ':memory:' : (process.env.DB_PATH || 'data.db'));
db.exec(`CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  igsid TEXT NOT NULL,
  direction TEXT NOT NULL,        -- 'in' | 'out'
  text TEXT,
  created_at INTEGER NOT NULL,    -- unix ms
  tg_message_id INTEGER           -- telegram msg id (inbound only) for reply routing
)`);
const q = {
  insertIn:  db.prepare(`INSERT INTO messages(igsid,direction,text,created_at) VALUES(?, 'in', ?, ?)`),
  setTg:     db.prepare(`UPDATE messages SET tg_message_id=? WHERE id=?`),
  insertOut: db.prepare(`INSERT INTO messages(igsid,direction,text,created_at) VALUES(?, 'out', ?, ?)`),
  igsidByTg: db.prepare(`SELECT igsid FROM messages WHERE tg_message_id=?`),
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

  // a member replies to a forwarded DM -> relay text back to that IG user
  bot.on('message:text', async (ctx) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) return;                                   // only replies route to IG
    const row = q.igsidByTg.get(replyTo);
    if (!row) { await ctx.reply('⚠️ no IG conversation mapped to this message'); return; }
    try {
      await sendIG(row.igsid, ctx.message.text);
      q.insertOut.run(row.igsid, ctx.message.text, Date.now());
    } catch (e) {
      await ctx.reply(`❌ IG send failed: ${e.message}`);   // e.g. outside 24h window
    }
  });
  bot.start({ onStart: () => console.log('telegram bot polling') });

  async function handleEvent(body) {
    const items = [];
    for (const entry of body.entry ?? []) {
      for (const m of entry.messaging ?? []) items.push(m);                          // real DM events
      for (const c of entry.changes ?? []) if (c.field === 'messages') items.push(c.value); // dashboard test
    }
    if (body.field === 'messages' && body.value) items.push(body.value);
    for (const m of items) {
      const igsid = m.sender?.id, text = m.message?.text;
      if (text === undefined) { console.log('non-text event:', JSON.stringify(m)); continue; }
      const info = q.insertIn.run(igsid, text, toMs(m.timestamp));
      const sent = await bot.api.sendMessage(TELEGRAM_CHAT_ID, `📩 IG ${igsid}\n${text}`);
      q.setTg.run(sent.message_id, info.lastInsertRowid);
      console.log(`DM from ${igsid}: ${text} -> tg ${sent.message_id}`);
    }
  }

  http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
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
  // reply routing: inbound -> tg map -> reply finds the IGSID
  const r = q.insertIn.run('IG123', 'hola', 1000); q.setTg.run(555, r.lastInsertRowid);
  assert(q.igsidByTg.get(555)?.igsid === 'IG123', 'reply routes to correct IGSID');
  assert(q.igsidByTg.get(999) === undefined, 'unknown tg message routes nowhere');
  console.log('selftest OK');
}
