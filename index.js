// IG DM <-> Telegram bridge (no AI yet).
//   IG DM -> webhook -> a per-user Telegram forum *topic*; a member typing in
//   that topic -> reply sent back to the IG user.
//   Requires a supergroup with Topics enabled + bot = admin with "Manage Topics".
// run:       node --env-file=.env index.js   (or npm start)
// self-test: node index.js --selftest
// expose:    cloudflared tunnel --url http://localhost:3000   (Meta needs HTTPS)
import http from 'node:http';
import crypto from 'node:crypto';
import { Bot, InputFile } from 'grammy';
import { PORT, VERIFY_TOKEN, META_APP_SECRET, IG_ACCESS_TOKEN, IG_ACCOUNT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SELFTEST, WINDOW_MS, WARN_MS, OPEN_BADGE } from './config.js';
import { q, envBlocked, isBlocked } from './db.js';
import { validSignature, toMs, pickEmoji, SENDERS, download, displayName, sendIG, reactIG } from './instagram.js';

// open topics + how long is left on each one's IG 24h reply window (from the user's last inbound DM)
const fmtLeft = (ms) => {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// returns the formatted open-topics report, or null when nothing is open (one query; caller decides what null means)
function statusText(now = Date.now()) {
  const rows = q.openTopics.all();
  if (!rows.length) return null;
  const chatC = String(TELEGRAM_CHAT_ID).replace(/^-100/, '');     // t.me/c link uses id without -100
  let warn = 0;
  const lines = rows.map((r) => {
    const left = r.last_in == null ? null : (r.last_in + WINDOW_MS) - now;
    const emoji = left == null ? '•' : left <= 0 ? '⛔' : left < WARN_MS ? '⚠️' : '‼️';
    if (left != null && left < WARN_MS) warn++;
    const when = left == null ? 'sin DM entrante' : left <= 0 ? 'ventana vencida' : `${fmtLeft(left)} restantes`;
    return `${emoji} <a href="https://t.me/c/${chatC}/${r.thread_id}">${esc(r.name || r.igsid)}</a> — ${when}`;
  });
  const head = `📋 Temas abiertos: ${rows.length}${warn ? ` · ⚠️ ${warn} por vencer` : ''}`;
  return [head, ...lines].join('\n');
}

if (SELFTEST) selftest();
else main().catch((e) => { console.error(e); process.exit(1); });

async function main() {
  for (const [k, v] of Object.entries({ META_APP_SECRET, IG_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VERIFY_TOKEN }))
    if (!v) console.warn(`⚠️  ${k} not set`);

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  // brand every IG DM topic with a consistent icon, set once at creation (best-effort; topics still create without it).
  // icon ids must come from getForumTopicIconStickers — random custom emoji are rejected.
  let TOPIC_ICON;
  try {
    const icons = await bot.api.getForumTopicIconStickers();
    TOPIC_ICON = (icons.find((s) => ['📨', '✉', '💬'].includes(s.emoji)) || icons[0])?.custom_emoji_id;
  } catch (e) { console.error('icon stickers:', e.message); }

  // ack a command then self-destruct + drop the command message: neither should linger as the topic's preview line
  const ack = async (ctx, text) => {
    await ctx.deleteMessage().catch(() => {});
    const m = await ctx.reply(text);
    setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 6000);
  };

  // helper to find the group's chat id: type /id in the group
  bot.command('id', (ctx) => ctx.reply(`chat id: ${ctx.chat.id}`));

  bot.command('help', (ctx) => ctx.reply(
    'Comandos:\n' +
    '/help — esta lista\n' +
    '/general — (respondiendo a un mensaje) lo copia al tema General\n' +
    '/read — (dentro del tema) lo marca resuelto y lo cierra (se reabre solo con un nuevo DM)\n' +
    '/unread — (dentro del tema) lo reabre como pendiente. Agrega ❗ al inicio del nombre\n' +
    '/block — (dentro del tema) deja de reenviar los mensajes de ese usuario\n' +
    '/unblock — (dentro del tema) vuelve a reenviar sus mensajes\n' +
    '/blocklist — lista los usuarios bloqueados\n' +
    '/leaderboards — ranking de mensajes por miembro (sin General)\n' +
    '/status — lista los temas abiertos y cuánto queda de la ventana de 24h (⚠️ si quedan <6h)\n' +
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
      await ack(ctx, '✅ Copiado a General.');
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
    await ack(ctx, '🚫 Usuario bloqueado: no se reenviarán más mensajes suyos (no se bloquea en Instagram).');
  });
  bot.command('unblock', async (ctx) => {
    const igsid = igsidOfTopic(ctx);
    if (!igsid) return ctx.reply('Usá /unblock dentro del tema del usuario.');
    q.unblock.run(igsid);
    await ack(ctx, '✅ Usuario desbloqueado.');
  });
  bot.command('blocklist', (ctx) => {
    const rows = q.blockedList.all();
    const seen = new Set(rows.map((r) => r.igsid));
    const env = [...envBlocked].filter((id) => !seen.has(id));   // env-seeded blocks not also blocked at runtime
    if (!rows.length && !env.length) return ctx.reply('✅ No hay usuarios bloqueados.');
    const lines = rows.map((r) => `• ${r.name || r.igsid}`).concat(env.map((id) => `• ${id} (env)`));
    ctx.reply(`🚫 Bloqueados (${lines.length}) — /unblock dentro del tema para desbloquear:\n${lines.join('\n')}`);
  });
  bot.command('leaderboards', (ctx) => {
    const rows = q.leaderboard.all();
    if (!rows.length) return ctx.reply('Todavía no hay mensajes registrados.');
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    const lines = rows.map((r, i) => `${medal(i)} ${r.name || r.user_id} — ${r.count}`);
    ctx.reply(`🏆 Mensajes por miembro (sin General):\n${lines.join('\n')}`);
  });
  bot.command('read', async (ctx) => {
    const igsid = igsidOfTopic(ctx);
    if (!igsid) return ctx.reply('Usá /read dentro del tema para marcarlo resuelto.');
    await setTopicOpen(igsid, false);                          // resuelto -> cerrar (sale de la lista activa)
    await ctx.deleteMessage().catch(() => {});
  });
  bot.command('unread', async (ctx) => {
    const igsid = igsidOfTopic(ctx);
    if (!igsid) return ctx.reply('Usá /unread dentro del tema para reabrirlo como pendiente.');
    await setTopicOpen(igsid, true);
    await ctx.deleteMessage().catch(() => {});
  });
  const STATUS_OPTS = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  bot.command('status', (ctx) => ctx.reply(statusText() || '✅ No hay temas abiertos.', STATUS_OPTS));
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

  // tally each member's messages in user topics (everything but General + commands) for /leaderboards.
  // runs first and calls next() so the relay handler below still fires.
  bot.on('message', async (ctx, next) => {
    const u = ctx.from;
    if (ctx.message?.message_thread_id && u && !u.is_bot && !ctx.message.text?.startsWith('/')) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : String(u.id));
      q.bumpMember.run(u.id, name, Date.now());
    }
    await next();
  });

  // a member typing inside a user's topic -> relay text back to that IG user
  bot.on('message:text', async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    if (!threadId || ctx.message.text.startsWith('/')) return;  // General topic / commands
    const row = q.igsidByThread.get(threadId);
    if (!row) return;                                           // not a mapped topic
    try {
      const r = await sendIG(row.igsid, ctx.message.text);
      q.insertOut.run(row.igsid, ctx.message.text, Date.now());
      if (r?.message_id) q.insertFwd.run(ctx.message.message_id, row.igsid, r.message_id); // so A's IG reaction on this reply mirrors back
      // leave the topic OPEN: a member may send follow-ups, and they're regulars who can't post once it's closed.
      // Closing is a deliberate /read.
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

  // the other direction: an IG user reacts to a message (theirs, or a member's reply) -> mirror onto the
  // Telegram message. Telegram only accepts a fixed reaction set, so map IG's six types to allowed emoji.
  const IG_REACT = { love: '❤️', like: '👍', haha: '😁', wow: '😱', sad: '😢', angry: '🤬' };
  async function mirrorReaction(m) {
    const map = q.fwdByMid.get(m.reaction?.mid);
    if (!map) return;                                         // reacted to a message we never forwarded/sent
    const emoji = IG_REACT[m.reaction.reaction] || m.reaction.emoji;
    const reaction = m.reaction.action === 'react' && emoji ? [{ type: 'emoji', emoji }] : []; // unreact -> clear
    try {
      await bot.api.setMessageReaction(TELEGRAM_CHAT_ID, map.tg_message_id, reaction);
    } catch (e) { console.error('mirror reaction:', e.description || e.message); }
  }

  // allowed_updates must list every update type we handle (it replaces the default, which omits reactions)
  bot.start({ allowed_updates: ['message', 'message_reaction'], onStart: () => console.log('telegram bot polling') });

  // every 2h, post the open-topics status into General so the whole team sees what's pending / about to expire.
  // stays quiet when nothing is open. General topic = sendMessage with no message_thread_id.
  setInterval(async () => {
    const text = statusText();
    if (!text) return;                                   // nothing open -> stay quiet (single query, no separate count)
    try { await bot.api.sendMessage(TELEGRAM_CHAT_ID, text, STATUS_OPTS); }
    catch (e) { console.error('status cron:', e.description || e.message); }
  }, 2 * 60 * 60 * 1000);

  // open/closed IS the attention signal: a topic stays OPEN while it needs the team (new DM or live
  // conversation) and is CLOSED once someone marks it resolved with /read; closed topics drop out of the
  // active list. A new inbound DM reopens it. `unread` in db = "is open", tracked so we only hit the
  // Telegram API on an actual state change (and avoid TOPIC_NOT_MODIFIED noise).
  async function setTopicOpen(igsid, open) {
    const row = q.threadFull.get(igsid);
    if (!row) return;
    q.setUnread.run(open ? 1 : 0, igsid);                  // the flag drives /status — persist it first, no matter what TG does
    if (row.unread === (open ? 1 : 0)) return;             // already in that state -> nothing to change
    // two independent best-effort calls: a no-op on one (TOPIC_NOT_MODIFIED) must not skip the other
    try {
      if (open) await bot.api.reopenForumTopic(TELEGRAM_CHAT_ID, row.thread_id);
      else await bot.api.closeForumTopic(TELEGRAM_CHAT_ID, row.thread_id);
    } catch (e) { console.error('open/close topic:', e.description || e.message); }
    const name = (open ? `${OPEN_BADGE} ${row.name || ''}` : (row.name || '')).slice(0, 128); // db stores the base name
    try {
      await bot.api.editForumTopic(TELEGRAM_CHAT_ID, row.thread_id, { name });
    } catch (e) { console.error('badge topic:', e.description || e.message); }
  }

  // create a fresh forum topic for this user and (re)store the mapping. Created only from an inbound DM,
  // so it starts open with the badge baked into the name + icon (no extra edit -> no rename service message).
  async function createTopic(igsid) {
    const name = (await displayName(igsid)).slice(0, 128);
    const topic = await bot.api.createForumTopic(TELEGRAM_CHAT_ID, `${OPEN_BADGE} ${name}`.slice(0, 128), TOPIC_ICON ? { icon_custom_emoji_id: TOPIC_ICON } : {});
    q.insertThread.run(igsid, topic.message_thread_id, name, Date.now()); // store the base name (no badge)
    q.setUnread.run(1, igsid);                                   // fresh topic is open / needs attention
    console.log(`created topic ${topic.message_thread_id} for ${name}`);
    return topic.message_thread_id;
  }

  // send something into the user's topic; if the topic was deleted in Telegram, recreate and resend.
  // `send(threadId)` returns the sent Telegram Message.
  async function toUserTopic(igsid, send) {
    let threadId = q.threadFull.get(igsid)?.thread_id ?? await createTopic(igsid);
    try {
      return await send(threadId);
    } catch (e) {
      if (!/thread not found|topic.*delet|thread_id_invalid/i.test(e.description || e.message || '')) throw e;
      threadId = await createTopic(igsid);                       // stale/deleted topic -> recreate
      return await send(threadId);
    }
  }

  const forwardToTopic = (igsid, text) =>
    toUserTopic(igsid, (tid) => bot.api.sendMessage(TELEGRAM_CHAT_ID, text, { message_thread_id: tid }));

  // download an IG attachment and re-upload it to the topic; shares/unknown/failures -> link
  async function forwardAttachment(igsid, att) {
    const url = att.payload?.url;
    if (!url) return null;
    const method = SENDERS[att.type];
    const asLink = (note = '') => toUserTopic(igsid, (tid) =>
      bot.api.sendMessage(TELEGRAM_CHAT_ID, `📎 ${att.type}${note}: ${url}`, { message_thread_id: tid }));
    if (!method) return asLink();                                // share / story_mention / etc.
    try {
      const buf = await download(url);
      return await toUserTopic(igsid, (tid) =>
        bot.api[method](TELEGRAM_CHAT_ID, new InputFile(buf, att.type), { message_thread_id: tid }));
    } catch (e) {
      console.error('media forward:', e.message);
      return asLink(' (no se pudo cargar)').catch(() => null);   // at least deliver the link
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
      if (m.reaction) { await mirrorReaction(m); continue; }         // IG reaction -> mirror onto the Telegram message
      if (m.read || m.delivery) continue;                           // read/delivery receipts
      if (isBlocked(igsid)) { console.log(`blocked ${igsid} — dropped`); continue; }
      const text = m.message?.text;
      const attachments = m.message?.attachments ?? [];
      if (text === undefined && !attachments.length) { console.log('non-text event:', JSON.stringify(m)); continue; }
      const summary = text ?? `[${attachments.map((a) => a.type).join(', ')}]`;
      q.insertIn.run(igsid, summary, toMs(m.timestamp));
      const mid = m.message?.mid;
      const forwarded = [];
      if (text !== undefined) forwarded.push(await forwardToTopic(igsid, text));
      for (const att of attachments) { const s = await forwardAttachment(igsid, att); if (s) forwarded.push(s); }
      for (const s of forwarded) if (mid) q.insertFwd.run(s.message_id, igsid, mid); // reaction passthrough
      await setTopicOpen(igsid, true);                              // user wrote -> reopen / keep open
      console.log(`DM from ${igsid}: ${summary}`);
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
  // /status: only open (unread=1) topics are listed, and <6h-left ones get the ⚠️ warning
  const now = Date.now();
  q.insertThread.run('IGopenUrgent', 11, 'Urgent (@u)', now); q.setUnread.run(1, 'IGopenUrgent');
  q.insertIn.run('IGopenUrgent', 'hola', now - 19 * 3600000);          // 5h left -> warn
  q.insertThread.run('IGopenCalm', 12, 'Calm (@c)', now); q.setUnread.run(1, 'IGopenCalm');
  q.insertIn.run('IGopenCalm', 'hola', now - 1 * 3600000);             // 23h left -> no warn
  q.insertThread.run('IGclosed', 13, 'Closed (@x)', now); q.setUnread.run(0, 'IGclosed');
  const st = statusText(now);
  assert(/Urgent/.test(st) && /Calm/.test(st), 'status lists open topics');
  assert(!/Closed/.test(st), 'status hides closed topics');
  assert(/⚠️ <a[^>]*>Urgent/.test(st), 'topic with <6h left gets the ⚠️ warning');
  assert(/‼️ <a[^>]*>Calm/.test(st), 'topic with plenty of time uses ‼️ (not the <6h ⚠️)');
  // blocklist round-trip
  q.block.run('IGbad', 1); assert(isBlocked('IGbad'), 'block marks user');
  q.insertThread.run('IGbad', 71, 'Bad Guy (@bad)', Date.now());
  assert(q.blockedList.all().some((r) => r.igsid === 'IGbad' && r.name === 'Bad Guy (@bad)'), 'blocklist shows blocked user with name');
  q.unblock.run('IGbad'); assert(!isBlocked('IGbad'), 'unblock clears user');
  assert(!q.blockedList.all().some((r) => r.igsid === 'IGbad'), 'unblocked user drops off blocklist');
  // /leaderboards: bumpMember upserts a per-user count, ranked desc
  q.bumpMember.run(101, 'Ana', 1); q.bumpMember.run(101, 'Ana', 2); q.bumpMember.run(102, 'Beto', 3);
  const lb = q.leaderboard.all();
  assert(lb[0].user_id === 101 && lb[0].count === 2, 'leaderboard ranks most-active member first');
  assert(lb.find((r) => r.user_id === 102)?.count === 1, 'each member counted once per message');
  // reaction passthrough: fwd mapping + emoji selection
  q.insertFwd.run(42, 'IGz', 'mid_1');
  assert(q.fwdByTg.get(42)?.ig_mid === 'mid_1', 'fwd maps tg message -> ig mid');
  assert(q.fwdByMid.get('mid_1')?.tg_message_id === 42, 'fwd maps ig mid -> tg message (IG reaction mirror)');
  assert(pickEmoji([{ type: 'emoji', emoji: '👍' }]) === '👍', 'pick plain emoji');
  assert(pickEmoji([{ type: 'custom_emoji', custom_emoji_id: 'x' }]) === undefined, 'skip custom emoji');
  assert(pickEmoji([]) === undefined, 'no reaction -> unreact');
  // attachment routing: known types map to a send method, shares fall back to a link
  assert(SENDERS.image === 'sendPhoto' && SENDERS.video === 'sendVideo', 'media types map to send methods');
  assert(SENDERS.share === undefined, 'share -> link fallback');
  // prune selection: a >1y-inactive topic is stale, a fresh one is kept
  q.insertThread.run('IGrecent', 888, 'recent', Date.now());
  q.insertThread.run('IGold', 900, 'old', Date.now() - 366 * 24 * 60 * 60 * 1000);
  const stale = q.staleThreads.all(Date.now() - 365 * 24 * 60 * 60 * 1000).map(r => r.thread_id);
  assert(stale.includes(900), 'year-old topic selected for prune');
  assert(!stale.includes(888), 'recent topic kept');
  console.log('selftest OK');
}
