// IG DM <-> Telegram bridge (no AI yet) — entry point: webhook server + bootstrap (+ offline selftest).
//   IG DM -> webhook -> a per-user Telegram forum *topic*; a member typing in that topic -> reply to IG.
//   Requires a supergroup with Topics enabled + bot = admin with "Manage Topics".
// run:       node --env-file=.env index.js   (or npm start)
// self-test: node index.js --selftest
// expose:    cloudflared tunnel --url http://localhost:3000   (Meta needs HTTPS)
import http from 'node:http';
import crypto from 'node:crypto';
import { PORT, VERIFY_TOKEN, META_APP_SECRET, IG_ACCESS_TOKEN, IG_ACCOUNT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SELFTEST } from './config.js';
import { q, isBlocked } from './db.js';
import { validSignature, toMs, pickEmoji, SENDERS } from './instagram.js';
import { statusText, initTopicIcon, startBot, forwardToTopic, forwardAttachment, setTopicOpen, mirrorReaction } from './telegram.js';

if (SELFTEST) selftest();
else main().catch((e) => { console.error(e); process.exit(1); });

async function main() {
  for (const [k, v] of Object.entries({ META_APP_SECRET, IG_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VERIFY_TOKEN }))
    if (!v) console.warn(`⚠️  ${k} not set`);
  startWebhook();          // bind :3000 first so fly-proxy + the GET / health check see a listener immediately
  await initTopicIcon();   // then Telegram setup (network); a DM in this window just gets a topic with no icon
  startBot();
}

// parse a Meta webhook payload and fan its events out to Telegram
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

function startWebhook() {
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
  // /estado: only open (unread=1) topics are listed, and <6h-left ones get the ⚠️ warning
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
  // /respuestas: bumpMember upserts a per-user count, ranked desc
  q.bumpMember.run(101, 'Ana', 1); q.bumpMember.run(101, 'Ana', 2); q.bumpMember.run(102, 'Beto', 3);
  const lb = q.leaderboard.all();
  assert(lb[0].user_id === 101 && lb[0].count === 2, 'leaderboard ranks most-active member first');
  assert(lb.find((r) => r.user_id === 102)?.count === 1, 'each member counted once per message');
  // /guardar + /guardados: per-user topic bookmarks (save-only, idempotent)
  q.saveTopic.run(201, 'IG123', 1); q.saveTopic.run(201, 'IG123', 2); q.saveTopic.run(201, 'IGz', 3);
  assert(q.savedByUser.all(201).length === 2, 'saving the same topic twice keeps one row');
  assert(q.savedByUser.all(201)[0].igsid === 'IGz', 'saved topics list newest first');
  assert(q.savedByUser.all(999).length === 0, 'another user has no saved topics');
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
