// IG messaging webhook — verify handshake + receive DM events.
// run:       node --env-file=.env webhook.js
// self-test: node webhook.js --selftest
// expose:    cloudflared tunnel --url http://localhost:3000   (Meta needs HTTPS)
//
// ponytail: native http + zero deps. Swap to Express+TS once routes/Telegram land.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;

// Meta signs the raw body: header "x-hub-signature-256: sha256=<hmac>"
function validSignature(rawBody, header, secret = APP_SECRET) {
  if (!header || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function handleEvent(body) {
  const items = [];
  for (const entry of body.entry ?? []) {
    for (const m of entry.messaging ?? []) items.push(m);                       // real DM events
    for (const c of entry.changes ?? []) if (c.field === 'messages') items.push(c.value); // dashboard test
  }
  if (body.field === 'messages' && body.value) items.push(body.value);          // bare sample shape
  if (!items.length) console.log('no message items in payload:', JSON.stringify(body));
  for (const m of items) {
    const sender = m.sender?.id;          // IGSID — reply target
    const text = m.message?.text;
    if (text !== undefined) console.log(`DM from ${sender}: ${text}`);
    else console.log('event:', JSON.stringify(m));
  }
}

if (process.argv.includes('--selftest')) { selftest(); }
else {
  http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/webhook') { res.writeHead(404).end(); return; }

    if (req.method === 'GET') {
      // Meta verification handshake
      const ok = url.searchParams.get('hub.mode') === 'subscribe'
        && url.searchParams.get('hub.verify_token') === VERIFY_TOKEN;
      if (ok) { res.writeHead(200).end(url.searchParams.get('hub.challenge')); }
      else { res.writeHead(403).end(); }
      return;
    }

    if (req.method === 'POST') {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => {
        const sigOk = validSignature(raw, req.headers['x-hub-signature-256']);
        console.log(`POST /webhook (${raw.length}b, sig ${sigOk ? 'ok' : 'MISSING/BAD'})`);
        if (!sigOk) { res.writeHead(401).end(); return; }
        res.writeHead(200).end();           // ack within 30s, then process
        try { handleEvent(JSON.parse(raw)); } catch (e) { console.error('parse error', e.message); }
      });
      return;
    }
    res.writeHead(405).end();
  }).listen(PORT, () => console.log(`webhook listening on :${PORT}/webhook`));
}

function selftest() {
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
  const body = '{"hello":"world"}', secret = 'testsecret';
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert(validSignature(body, sig, secret), 'valid signature should pass');
  assert(!validSignature(body, 'sha256=deadbeef', secret), 'bad signature should fail');
  assert(!validSignature(body, undefined, secret), 'missing header should fail');
  console.log('selftest OK');
}
