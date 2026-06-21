// Telegram bot: commands, message/reaction handlers, topic lifecycle, status report, and the 6h cron.
import { Bot, InputFile } from 'grammy';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, IG_ACCESS_TOKEN, SELFTEST, WINDOW_MS, WARN_MS, OPEN_BADGE } from './config.js';
import { q, envBlocked } from './db.js';
import { SENDERS, download, displayName, sendIG, reactIG, pickEmoji } from './instagram.js';

// selftest imports this module only for statusText; grammy throws on an empty token, so hand it a
// placeholder when offline. No network happens until startBot() calls bot.start().
export const bot = new Bot(TELEGRAM_BOT_TOKEN || (SELFTEST ? 'selftest:placeholder' : ''));

const STATUS_OPTS = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const CHAT_C = String(TELEGRAM_CHAT_ID).replace(/^-100/, '');   // chat id without the -100 prefix, for t.me/c links
const topicLink = (threadId) => `https://t.me/c/${CHAT_C}/${threadId}`;

// open topics + how long is left on each one's IG 24h reply window (from the user's last inbound DM)
const fmtLeft = (ms) => {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// returns the formatted open-topics report, or null when nothing is open (one query; caller decides what null means)
export function statusText(now = Date.now()) {
  const rows = q.openTopics.all();
  if (!rows.length) return null;
  let warn = 0;
  const lines = rows.map((r) => {
    const left = r.last_in == null ? null : (r.last_in + WINDOW_MS) - now;
    const emoji = left == null ? '•' : left <= 0 ? '⛔' : left < WARN_MS ? '⚠️' : '‼️';
    if (left != null && left < WARN_MS) warn++;
    const when = left == null ? 'sin DM entrante' : left <= 0 ? 'ventana vencida' : `${fmtLeft(left)} restantes`;
    return `${emoji} <a href="${topicLink(r.thread_id)}">${esc(r.name || r.igsid)}</a> — ${when}`;
  });
  const head = `📋 Temas abiertos: ${rows.length}${warn ? ` · ⚠️ ${warn} por vencer` : ''}`;
  return [head, ...lines].join('\n');
}

// brand every IG DM topic with a consistent icon, set once at creation (best-effort; topics still create without it).
// icon ids must come from getForumTopicIconStickers — random custom emoji are rejected. Loaded once before startBot.
let TOPIC_ICON;
export async function initTopicIcon() {
  try {
    const icons = await bot.api.getForumTopicIconStickers();
    TOPIC_ICON = (icons.find((s) => ['📨', '✉', '💬'].includes(s.emoji)) || icons[0])?.custom_emoji_id;
  } catch (e) { console.error('icon stickers:', e.message); }
}

// ack a command then self-destruct + drop the command message: neither should linger as a preview line.
// default ~6s; pass { ms, ...sendOpts } to change the lifetime or add parse_mode/link options.
const ack = async (ctx, text, { ms = 6000, ...opts } = {}) => {
  await ctx.deleteMessage().catch(() => {});
  const m = await ctx.reply(text, opts);
  setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), ms);
};

// the IGSID of the topic a command was typed in (bloquear/desbloquear act on it)
const igsidOfTopic = (ctx) => {
  const tid = ctx.message?.message_thread_id;
  return tid ? q.igsidByThread.get(tid)?.igsid : undefined;
};

// a Telegram member's display name: full name, else @username, else numeric id
const memberName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : String(u?.id ?? '?'));

// post a one-line audit note into General (no thread_id), linking back to the topic
async function logToGeneral(ctx, row, igsid, emoji, verb) {
  const subject = row?.name ? `<a href="${topicLink(row.thread_id)}">${esc(row.name)}</a>` : esc(igsid);
  await bot.api.sendMessage(TELEGRAM_CHAT_ID, `${emoji} ${subject} — ${verb} ${esc(memberName(ctx.from))}`, STATUS_OPTS)
    .catch((e) => console.error('general log:', e.description || e.message));
}

// register an info/report command that only runs in the General topic (no message_thread_id);
// typed inside a user topic it's dropped with a brief self-deleting hint so it can't clutter the convo.
const generalCommand = (name, handler) => bot.command(name, (ctx) =>
  ctx.message?.message_thread_id ? ack(ctx, `ℹ️ Usá /${name} en el tema General.`) : handler(ctx));

// helper to find the group's chat id: type /id in the group
generalCommand('id', (ctx) => ctx.reply(`chat id: ${ctx.chat.id}`));

generalCommand('ayuda', (ctx) => ctx.reply(
  'Comandos:\n' +
  '/ayuda — esta lista\n' +
  '/manual — guía rápida para responder (flujo + comandos básicos)\n' +
  '/compartir — (respondiendo a un mensaje) lo copia al tema General\n' +
  '/resuelto — (dentro del tema) lo marca resuelto y lo cierra (se reabre solo con un nuevo DM)\n' +
  '/pendiente — (dentro del tema) lo reabre como pendiente. Agrega ❗ al inicio del nombre\n' +
  '/guardar — (dentro del tema) lo guarda en tu lista personal\n' +
  '/bloquear — (dentro del tema) deja de reenviar los mensajes de ese usuario\n' +
  '/desbloquear — (dentro del tema) vuelve a reenviar sus mensajes\n' +
  '/bloqueados — lista los usuarios bloqueados\n' +
  '/respuestas — mensajes enviados por cada miembro (sin General)\n' +
  '/guardados — tus temas guardados (en General)\n' +
  '/estado — lista los temas abiertos y cuánto queda de la ventana de 24h (⚠️ si quedan <6h)\n' +
  '/servercheck — estado del bot y del token de Instagram\n' +
  '/purgar — borra chats sin actividad hace más de 1 año\n' +
  '/id — muestra el id de este chat\n\n' +
  'Para responder a alguien, escribí dentro de su tema y se le manda como DM en Instagram.'
));

// narrative guide for regular members: how the bridge works + the day-to-day commands
generalCommand('manual', (ctx) => ctx.reply(
  '📖 Cómo funciona\n\n' +
  'Cada persona que escribe por Instagram tiene su propio tema acá. El ❗ al inicio del nombre = pendiente de respuesta.\n\n' +
  '✍️ Para responder: escribí DENTRO del tema de esa persona. Tu mensaje le llega como DM en Instagram.\n\n' +
  '⏰ Ventana de 24h: Instagram solo deja responder hasta 24h después del último mensaje del usuario; pasado ese tiempo el bot avisa "IG send failed".\n\n' +
  '✅ /resuelto (dentro del tema): cuando terminaste, lo cierra y le saca el ❗. Si el usuario vuelve a escribir, se reabre solo. Queda registrado en General quién lo resolvió.\n\n' +
  '↩️ /pendiente: lo vuelve a marcar como pendiente (también queda registrado en General).\n\n' +
  '⭐ /guardar (dentro del tema): lo guarda en tu lista personal para no perderlo; /guardados (en General) muestra tu lista.\n\n' +
  '😀 Reacciones: si reaccionás con un emoji a un mensaje, esa reacción también aparece en Instagram.\n\n' +
  '📋 /estado: muestra los temas abiertos y cuánto queda de la ventana de 24h (⚠️ = quedan menos de 6h).\n\n' +
  '📎 Las fotos, videos y audios llegan al tema; si no se pueden cargar, llega un link.\n\n' +
  'ℹ️ /ayuda lista todos los comandos.'
));

// reply to a message + /compartir -> copy it into General with a button back to the topic
bot.command('compartir', async (ctx) => {
  const replied = ctx.message?.reply_to_message;
  if (!replied) return ctx.reply('Respondé a un mensaje y luego /compartir para copiarlo al tema General.');
  const tid = replied.message_thread_id;
  const link = `https://t.me/c/${CHAT_C}/${tid ? tid + '/' : ''}${replied.message_id}`;
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

bot.command('bloquear', async (ctx) => {
  const igsid = igsidOfTopic(ctx);
  if (!igsid) return ctx.reply('Usá /bloquear dentro del tema del usuario.');
  const wasBlocked = !!q.isBlocked.get(igsid);              // only announce a real unblocked -> blocked change
  q.block.run(igsid, Date.now());
  await ack(ctx, '🚫 Usuario bloqueado: no se reenviarán más mensajes suyos (no se bloquea en Instagram).');
  if (!wasBlocked) await logToGeneral(ctx, q.threadFull.get(igsid), igsid, '🚫', 'bloqueado por');
});
bot.command('desbloquear', async (ctx) => {
  const igsid = igsidOfTopic(ctx);
  if (!igsid) return ctx.reply('Usá /desbloquear dentro del tema del usuario.');
  const wasBlocked = !!q.isBlocked.get(igsid);
  q.unblock.run(igsid);
  await ack(ctx, '✅ Usuario desbloqueado.');
  if (wasBlocked) await logToGeneral(ctx, q.threadFull.get(igsid), igsid, '✅', 'desbloqueado por');
});
generalCommand('bloqueados', (ctx) => {
  const rows = q.blockedList.all();
  const seen = new Set(rows.map((r) => r.igsid));
  const env = [...envBlocked].filter((id) => !seen.has(id));   // env-seeded blocks not also blocked at runtime
  if (!rows.length && !env.length) return ctx.reply('✅ No hay usuarios bloqueados.');
  const lines = rows.map((r) => `• ${r.name || r.igsid}`).concat(env.map((id) => `• ${id} (env)`));
  ctx.reply(`🚫 Bloqueados (${lines.length}) — /desbloquear dentro del tema para desbloquear:\n${lines.join('\n')}`);
});
generalCommand('respuestas', (ctx) => {
  const rows = q.leaderboard.all();   // top 10
  if (!rows.length) return ctx.reply('Todavía no hay mensajes registrados.');
  const lines = rows.map((r) => `• ${r.name || r.user_id} — ${r.count}`);
  ctx.reply(`📊 Respuestas por miembro (sin General):\n${lines.join('\n')}`);
});
// your personal saved-topics list; self-deletes after ~60s (the data persists — re-run anytime)
generalCommand('guardados', (ctx) => {
  const lines = q.savedByUser.all(ctx.from.id)
    .map((s) => q.threadFull.get(s.igsid))                  // resolve igsid -> topic (name + thread_id)
    .filter(Boolean)                                        // skip topics that were pruned/deleted
    .map((t) => `• <a href="${topicLink(t.thread_id)}">${esc(t.name || '?')}</a>`);
  const text = lines.length ? `⭐ Tus temas guardados:\n${lines.join('\n')}` : 'No tenés temas guardados. Usá /guardar dentro de un tema.';
  return ack(ctx, text, { ms: 60000, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
});
bot.command('resuelto', async (ctx) => {
  const igsid = igsidOfTopic(ctx);
  if (!igsid) return ctx.reply('Usá /resuelto dentro del tema para marcarlo resuelto.');
  const row = q.threadFull.get(igsid);
  const wasOpen = row?.unread === 1;                         // only announce a real open -> closed transition
  await setTopicOpen(igsid, false);                          // resuelto -> cerrar (sale de la lista activa)
  await ctx.deleteMessage().catch(() => {});
  if (wasOpen) await logToGeneral(ctx, row, igsid, '✅', 'resuelto por');
});
bot.command('pendiente', async (ctx) => {
  const igsid = igsidOfTopic(ctx);
  if (!igsid) return ctx.reply('Usá /pendiente dentro del tema para reabrirlo como pendiente.');
  const row = q.threadFull.get(igsid);
  const wasClosed = row?.unread === 0;                       // only announce a real closed -> open transition
  await setTopicOpen(igsid, true);
  await ctx.deleteMessage().catch(() => {});
  if (wasClosed) await logToGeneral(ctx, row, igsid, '↩️', 'reabierto por');
});
// bookmark this topic to the caller's personal list (per Telegram user); list it with /guardados in General
bot.command('guardar', async (ctx) => {
  const igsid = igsidOfTopic(ctx);
  if (!igsid) return ctx.reply('Usá /guardar dentro del tema que querés guardar.');
  q.saveTopic.run(ctx.from.id, igsid, Date.now());          // save-only (INSERT OR IGNORE)
  await ack(ctx, '⭐ Guardado. Vé tu lista con /guardados en General.');
});
generalCommand('estado', (ctx) => ctx.reply(statusText() || '✅ No hay temas abiertos.', STATUS_OPTS));
generalCommand('servercheck', async (ctx) => {
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
generalCommand('purgar', async (ctx) => {
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const stale = q.staleThreads.all(cutoff);
  let deleted = 0, errors = 0;
  for (const t of stale) {
    try { await ctx.api.deleteForumTopic(ctx.chat.id, t.thread_id); }
    catch (e) { if (!/not found|deleted/i.test(e.description || e.message || '')) { errors++; continue; } }
    q.deleteThread.run(t.thread_id);
    deleted++;
  }
  await ctx.reply(`🧹 Purga: ${deleted} tema(s) sin actividad hace +1 año eliminados${errors ? `, ${errors} con error` : ''}.`);
});

// tally each member's messages in user topics (everything but General + commands) for /respuestas.
// runs first and calls next() so the relay handler below still fires.
bot.on('message', async (ctx, next) => {
  const u = ctx.from;
  if (ctx.message?.message_thread_id && u && !u.is_bot && !ctx.message.text?.startsWith('/')) {
    q.bumpMember.run(u.id, memberName(u), Date.now());
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
    // Closing is a deliberate /resuelto.
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
export async function mirrorReaction(m) {
  const map = q.fwdByMid.get(m.reaction?.mid);
  if (!map) return;                                         // reacted to a message we never forwarded/sent
  const emoji = IG_REACT[m.reaction.reaction] || m.reaction.emoji;
  const reaction = m.reaction.action === 'react' && emoji ? [{ type: 'emoji', emoji }] : []; // unreact -> clear
  try {
    await bot.api.setMessageReaction(TELEGRAM_CHAT_ID, map.tg_message_id, reaction);
  } catch (e) { console.error('mirror reaction:', e.description || e.message); }
}

// open/closed IS the attention signal: a topic stays OPEN while it needs the team (new DM or live
// conversation) and is CLOSED once someone marks it resolved with /resuelto; closed topics drop out of the
// active list. A new inbound DM reopens it. `unread` in db = "is open", tracked so we only hit the
// Telegram API on an actual state change (and avoid TOPIC_NOT_MODIFIED noise).
export async function setTopicOpen(igsid, open) {
  const row = q.threadFull.get(igsid);
  if (!row) return;
  q.setUnread.run(open ? 1 : 0, igsid);                  // the flag drives /estado — persist it first, no matter what TG does
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

export const forwardToTopic = (igsid, text) =>
  toUserTopic(igsid, (tid) => bot.api.sendMessage(TELEGRAM_CHAT_ID, text, { message_thread_id: tid }));

// download an IG attachment and re-upload it to the topic; shares/unknown/failures -> link
export async function forwardAttachment(igsid, att) {
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

// the autocomplete menu shown when you type "/" — kept here so it never drifts from the handlers above
const COMMANDS = [
  ['ayuda', 'Lista de comandos'],
  ['manual', 'Guía rápida para responder'],
  ['compartir', '(respondiendo) copiar el mensaje al tema General'],
  ['resuelto', 'Marcar el tema como resuelto y cerrarlo'],
  ['pendiente', 'Reabrir el tema como pendiente'],
  ['guardar', 'Guardar este tema en tu lista personal'],
  ['guardados', 'Tus temas guardados'],
  ['bloquear', 'Dejar de reenviar los mensajes del usuario'],
  ['desbloquear', 'Volver a reenviar sus mensajes'],
  ['bloqueados', 'Lista de usuarios bloqueados'],
  ['respuestas', 'Mensajes enviados por cada miembro'],
  ['estado', 'Temas abiertos y tiempo restante (24h)'],
  ['servercheck', 'Estado del bot y del token de Instagram'],
  ['purgar', 'Borrar temas inactivos hace +1 año'],
  ['id', 'Mostrar el id del chat'],
].map(([command, description]) => ({ command, description }));

// start polling + the 6h status cron (called from index after initTopicIcon)
export function startBot() {
  // register the "/" autocomplete menu so it matches the handlers (no manual BotFather step)
  bot.api.setMyCommands(COMMANDS).catch((e) => console.error('setMyCommands:', e.description || e.message));

  // allowed_updates must list every update type we handle (it replaces the default, which omits reactions)
  bot.start({ allowed_updates: ['message', 'message_reaction'], onStart: () => console.log('telegram bot polling') });

  // every 6h, post the open-topics status into General so the whole team sees what's pending / about to expire.
  // stays quiet when nothing is open. General topic = sendMessage with no message_thread_id.
  setInterval(async () => {
    const text = statusText();
    if (!text) return;                                   // nothing open -> stay quiet (single query, no separate count)
    try { await bot.api.sendMessage(TELEGRAM_CHAT_ID, text, STATUS_OPTS); }
    catch (e) { console.error('status cron:', e.description || e.message); }
  }, 6 * 60 * 60 * 1000);
}
