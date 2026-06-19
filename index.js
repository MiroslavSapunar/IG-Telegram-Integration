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
db.exec(`CREATE TABLE IF NOT EXISTS blocked(
  igsid TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
)`);
try { db.exec(`ALTER TABLE threads ADD COLUMN unread INTEGER NOT NULL DEFAULT 0`); } catch { /* already added */ }
db.exec(`CREATE TABLE IF NOT EXISTS fwd(
  tg_message_id INTEGER PRIMARY KEY,   -- the forwarded message in Telegram
  igsid TEXT NOT NULL,
  ig_mid TEXT NOT NULL                 -- the IG message it represents (for reactions)
)`);
const q = {
  insertIn:      db.prepare(`INSERT INTO messages(igsid,direction,text,created_at) VALUES(?, 'in', ?, ?)`),
  insertOut:     db.prepare(`INSERT INTO messages(igsid,direction,text,created_at) VALUES(?, 'out', ?, ?)`),
  igsidByThread: db.prepare(`SELECT igsid FROM threads WHERE thread_id=?`),
  threadName:    db.prepare(`SELECT name FROM threads WHERE thread_id=?`),
  threadFull:    db.prepare(`SELECT thread_id, name, unread FROM threads WHERE igsid=?`),
  setUnread:     db.prepare(`UPDATE threads SET unread=? WHERE igsid=?`),
  insertThread:  db.prepare(`INSERT OR REPLACE INTO threads(igsid,thread_id,name,created_at) VALUES(?,?,?,?)`),
  deleteThread:  db.prepare(`DELETE FROM threads WHERE thread_id=?`),
  staleThreads:  db.prepare(`SELECT igsid, thread_id, last_at FROM (
    SELECT t.igsid AS igsid, t.thread_id AS thread_id,
      COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.igsid=t.igsid), t.created_at) AS last_at
    FROM threads t
  ) WHERE last_at < ?`),
  isBlocked:     db.prepare(`SELECT 1 FROM blocked WHERE igsid=?`),
  block:         db.prepare(`INSERT OR IGNORE INTO blocked(igsid,created_at) VALUES(?,?)`),
  unblock:       db.prepare(`DELETE FROM blocked WHERE igsid=?`),
  lastInbound:   db.prepare(`SELECT MAX(created_at) AS t FROM messages WHERE direction='in'`),
  insertFwd:     db.prepare(`INSERT OR REPLACE INTO fwd(tg_message_id,igsid,ig_mid) VALUES(?,?,?)`),
  fwdByTg:       db.prepare(`SELECT igsid, ig_mid FROM fwd WHERE tg_message_id=?`),
};

// soft blocklist: env seed + runtime /block. Dropped before forwarding (NOT blocked on Instagram).
const envBlocked = new Set((process.env.BLOCKED_IGSIDS || '').split(',').map(s => s.trim()).filter(Boolean));
const isBlocked = (igsid) => envBlocked.has(igsid) || !!q.isBlocked.get(igsid);

// Meta signs the raw body: "x-hub-signature-256: sha256=<hmac>"
function validSignature(rawBody, header, secret = META_APP_SECRET) {
  if (!header || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// IG webhook timestamps come as s or ms — normalize to ms
const toMs = (t) => { const n = Number(t); return n ? (n < 1e12 ? n * 1000 : n) : Date.now(); };

// first plain-emoji reaction from a Telegram reaction list (custom/premium emoji have no unicode -> skip)
const pickEmoji = (reactions) => reactions?.find((x) => x.type === 'emoji')?.emoji;

// igsid -> "Name (@username)"; only called when creating a topic (once per user), so no cache needed
async function displayName(igsid) {
  let label = igsid;
  try {
    const r = await fetch(`https://graph.instagram.com/v25.0/${igsid}?fields=name,username&access_token=${IG_ACCESS_TOKEN}`);
    if (r.ok) { const p = await r.json(); if (p.username) label = `${p.name || p.username} (@${p.username})`; }
  } catch { /* fall back to raw igsid */ }
  return label;
}

async function igMessages(payload) {
  const res = await fetch('https://graph.instagram.com/v25.0/me/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body.error ?? body));
  return body;
}

const sendIG = (igsid, text) => igMessages({ recipient: { id: igsid }, message: { text } });

// react (emoji) / unreact (emoji falsy) to an IG message
const reactIG = (igsid, mid, emoji) => igMessages(emoji
  ? { recipient: { id: igsid }, sender_action: 'react', payload: { message_id: mid, reaction: emoji } }
  : { recipient: { id: igsid }, sender_action: 'unreact', payload: { message_id: mid } });

if (SELFTEST) selftest();
else main();

function main() {
  for (const [k, v] of Object.entries({ META_APP_SECRET, IG_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VERIFY_TOKEN }))
    if (!v) console.warn(`⚠️  ${k} not set`);

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  // helper to find the group's chat id: type /id in the group
  bot.command('id', (ctx) => ctx.reply(`chat id: ${ctx.chat.id}`));

  bot.command('help', (ctx) => ctx.reply(
    'Comandos:\n' +
    '/help — esta lista\n' +
    '/general — (respondiendo a un mensaje) lo copia al tema General\n' +
    '/read — (dentro del tema) saca el ✉️ de pendiente\n' +
    '/unread — (dentro del tema) marca con ✉️ como pendiente\n' +
    '/block — (dentro del tema) deja de reenviar los mensajes de ese usuario\n' +
    '/unblock — (dentro del tema) vuelve a reenviar sus mensajes\n' +
    '/health — estado del bot y del token de Instagram\n' +
    '/prune — borra chats sin actividad hace más de 1 año\n' +
    '/id — muestra el id de este chat\n\n' +
    'Para responder a alguien, escribí dentro de su tema y se le manda como DM en Instagram.'
  ));

  // reply to a message + /general -> copy it into General with a button back to the topic
  bot.command('general', async (ctx) => {
    const replied = ctx.message?.reply_to_message;
    if (!replied) return ctx.reply('Respondé a un mensaje y luego /general para copiarlo al tema General.');
    const chatC = String(ctx.chat.id).replace(/^-100/, '');         // t.me/c link uses id without -100
    const tid = replied.message_thread_id;
    const link = `https://t.me/c/${chatC}/${tid ? tid + '/' : ''}${replied.message_id}`;
    const name = (tid && q.threadName.get(tid)?.name) || 'la conversación';
    try {
      await ctx.api.copyMessage(ctx.chat.id, ctx.chat.id, replied.message_id, { // no thread_id -> General
        reply_markup: { inline_keyboard: [[{ text: `↗ Ir a ${name}`, url: link }]] },
      });
      await ctx.reply('✅ Copiado a General.');
    } catch (e) {
      await ctx.reply(`❌ No se pudo copiar: ${e.description || e.message}`);
    }
  });

  // the IGSID of the topic a command was typed in (block/unblock act on it)
  const igsidOfTopic = (ctx) => {
    const tid = ctx.message?.message_thread_id;
    return tid ? q.igsidByThread.get(tid)?.igsid : undefined;
  };

  bot.command('block', async (ctx) => {
    const igsid = igsidOfTopic(ctx);
    if (!igsid) return ctx.reply('Usá /block dentro del tema del usuario.');
    q.block.run(igsid, Date.now());
    await ctx.reply('🚫 Usuario bloqueado: no se reenviarán más mensajes suyos (no se bloquea en Instagram).');
  });
  bot.command('unblock', async (ctx) => {
    const igsid = igsidOfTopic(ctx);
    if (!igsid) return ctx.reply('Usá /unblock dentro del tema del usuario.');
    q.unblock.run(igsid);
    await ctx.reply('✅ Usuario desbloqueado.');
  });
  bot.command('read', async (ctx) => {
    const igsid = igsidOfTopic(ctx);
    if (!igsid) return ctx.reply('Usá /read dentro del tema para sacar el ✉️.');
    await setTopicMark(igsid, false);
  });
  bot.command('unread', async (ctx) => {
    const igsid = igsidOfTopic(ctx);
    if (!igsid) return ctx.reply('Usá /unread dentro del tema para marcar con ✉️.');
    await setTopicMark(igsid, true);
  });
  bot.command('health', async (ctx) => {
    let ig;
    try {
      const r = await fetch(`https://graph.instagram.com/v25.0/me?fields=username&access_token=${IG_ACCESS_TOKEN}`);
      const b = await r.json();
      ig = r.ok ? `✅ @${b.username}` : `❌ ${b.error?.message || 'error'}`;
    } catch (e) { ig = `❌ ${e.message}`; }
    const last = q.lastInbound.get()?.t;
    const lastTxt = last ? new Date(last).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
    await ctx.reply(`🩺 Estado\nIG token: ${ig}\nÚltimo DM recibido: ${lastTxt}\nUptime: ${Math.floor(process.uptime() / 60)} min`);
  });

  // manual cleanup: delete topics with no activity in over a year (history stays in SQLite)
  bot.command('prune', async (ctx) => {
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const stale = q.staleThreads.all(cutoff);
    let deleted = 0, errors = 0;
    for (const t of stale) {
      try { await ctx.api.deleteForumTopic(ctx.chat.id, t.thread_id); }
      catch (e) { if (!/not found|deleted/i.test(e.description || e.message || '')) { errors++; continue; } }
      q.deleteThread.run(t.thread_id);
      deleted++;
    }
    await ctx.reply(`🧹 Prune: ${deleted} tema(s) sin actividad hace +1 año eliminados${errors ? `, ${errors} con error` : ''}.`);
  });

  // a member typing inside a user's topic -> relay text back to that IG user
  bot.on('message:text', async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    if (!threadId || ctx.message.text.startsWith('/')) return;  // General topic / commands
    const row = q.igsidByThread.get(threadId);
    if (!row) return;                                           // not a mapped topic
    try {
      await sendIG(row.igsid, ctx.message.text);
      q.insertOut.run(row.igsid, ctx.message.text, Date.now());
      await setTopicMark(row.igsid, false);                    // we replied -> clear ✉️
    } catch (e) {
      await ctx.reply(`❌ IG send failed: ${e.message}`);       // e.g. outside 24h window
    }
  });
  // member reacts to a forwarded DM -> mirror the emoji onto the IG message (removing it -> unreact)
  bot.on('message_reaction', async (ctx) => {
    const r = ctx.messageReaction;
    const map = q.fwdByTg.get(r.message_id);
    if (!map) return;                                       // reaction on something we didn't forward
    try {
      await reactIG(map.igsid, map.ig_mid, pickEmoji(r.new_reaction));
    } catch (e) { console.error('reactIG:', e.message); }
  });

  // allowed_updates must list every update type we handle (it replaces the default, which omits reactions)
  bot.start({ allowed_updates: ['message', 'message_reaction'], onStart: () => console.log('telegram bot polling') });

  // ✉️ marks a topic whose last message is from the user; cleared after we reply.
  // Tracked in db so we only call the Telegram API on an actual state change.
  async function setTopicMark(igsid, unread) {
    const row = q.threadFull.get(igsid);
    if (!row || row.unread === (unread ? 1 : 0)) return;
    const base = (row.name || '').replace(/^✉️ /, '');
    const name = (unread ? `✉️ ${base}` : base).slice(0, 128);
    try {
      await bot.api.editForumTopic(TELEGRAM_CHAT_ID, row.thread_id, { name });
      q.setUnread.run(unread ? 1 : 0, igsid);
    } catch (e) { console.error('mark topic:', e.description || e.message); }
  }

  // create a fresh forum topic for this user and (re)store the mapping.
  // topics are only created from an inbound DM, so start already marked unread (✉️ in the name)
  // to avoid a create-then-rename and its noisy "renamed the topic" service message.
  async function createTopic(igsid) {
    const name = (await displayName(igsid)).slice(0, 128);
    const topic = await bot.api.createForumTopic(TELEGRAM_CHAT_ID, `✉️ ${name}`.slice(0, 128));
    q.insertThread.run(igsid, topic.message_thread_id, name, Date.now());
    q.setUnread.run(1, igsid);                                   // store base name, flag unread
    console.log(`created topic ${topic.message_thread_id} for ${name}`);
    return topic.message_thread_id;
  }

  // forward into the user's topic; if the topic was deleted in Telegram, recreate and resend.
  // returns the sent Telegram Message.
  async function forwardToTopic(igsid, text) {
    let threadId = q.threadFull.get(igsid)?.thread_id ?? await createTopic(igsid);
    try {
      return await bot.api.sendMessage(TELEGRAM_CHAT_ID, text, { message_thread_id: threadId });
    } catch (e) {
      if (!/thread not found|topic.*delet|thread_id_invalid/i.test(e.description || e.message || '')) throw e;
      threadId = await createTopic(igsid);                       // stale/deleted topic -> recreate
      return await bot.api.sendMessage(TELEGRAM_CHAT_ID, text, { message_thread_id: threadId });
    }
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
      if (isBlocked(igsid)) { console.log(`blocked ${igsid} — dropped`); continue; }
      const text = m.message?.text;
      if (text === undefined) { console.log('non-text event:', JSON.stringify(m)); continue; }
      q.insertIn.run(igsid, text, toMs(m.timestamp));
      const sent = await forwardToTopic(igsid, text);
      if (m.message?.mid) q.insertFwd.run(sent.message_id, igsid, m.message.mid); // for reaction passthrough
      await setTopicMark(igsid, true);                              // user wrote last -> ✉️
      console.log(`DM from ${igsid} -> topic ${sent.message_thread_id}: ${text}`);
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
  assert(q.threadFull.get('IG123')?.thread_id === 555, 'igsid maps to its topic');
  assert(q.igsidByThread.get(999) === undefined, 'unknown topic routes nowhere');
  // recreate after a deleted topic: REPLACE swaps the mapping to the new id
  q.insertThread.run('IG123', 777, 'Karnaza (@k4rn4z4)', 2);
  assert(q.threadFull.get('IG123')?.thread_id === 777, 'recreate replaces thread_id');
  assert(q.igsidByThread.get(555) === undefined, 'old (deleted) topic id no longer maps');
  // unread marker flag round-trip
  q.insertThread.run('IGm', 321, 'Name', Date.now());
  q.setUnread.run(1, 'IGm'); assert(q.threadFull.get('IGm').unread === 1, 'mark unread sets flag');
  q.setUnread.run(0, 'IGm'); assert(q.threadFull.get('IGm').unread === 0, 'read clears flag');
  // blocklist round-trip
  q.block.run('IGbad', 1); assert(isBlocked('IGbad'), 'block marks user');
  q.unblock.run('IGbad'); assert(!isBlocked('IGbad'), 'unblock clears user');
  // reaction passthrough: fwd mapping + emoji selection
  q.insertFwd.run(42, 'IGz', 'mid_1');
  assert(q.fwdByTg.get(42)?.ig_mid === 'mid_1', 'fwd maps tg message -> ig mid');
  assert(pickEmoji([{ type: 'emoji', emoji: '👍' }]) === '👍', 'pick plain emoji');
  assert(pickEmoji([{ type: 'custom_emoji', custom_emoji_id: 'x' }]) === undefined, 'skip custom emoji');
  assert(pickEmoji([]) === undefined, 'no reaction -> unreact');
  // prune selection: a >1y-inactive topic is stale, a fresh one is kept
  q.insertThread.run('IGrecent', 888, 'recent', Date.now());
  q.insertThread.run('IGold', 900, 'old', Date.now() - 366 * 24 * 60 * 60 * 1000);
  const stale = q.staleThreads.all(Date.now() - 365 * 24 * 60 * 60 * 1000).map(r => r.thread_id);
  assert(stale.includes(900), 'year-old topic selected for prune');
  assert(!stale.includes(888), 'recent topic kept');
  console.log('selftest OK');
}
