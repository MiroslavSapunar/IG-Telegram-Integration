// Instagram Graph client (graph.instagram.com) + webhook helpers
import crypto from 'node:crypto';
import { META_APP_SECRET, IG_ACCESS_TOKEN } from './config.js';

// Meta signs the raw body: "x-hub-signature-256: sha256=<hmac>"
export function validSignature(rawBody, header, secret = META_APP_SECRET) {
  if (!header || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// IG webhook timestamps come as s or ms — normalize to ms
export const toMs = (t) => { const n = Number(t); return n ? (n < 1e12 ? n * 1000 : n) : Date.now(); };

// first plain-emoji reaction from a Telegram reaction list (custom/premium emoji have no unicode -> skip)
export const pickEmoji = (reactions) => reactions?.find((x) => x.type === 'emoji')?.emoji;

// IG attachment type -> grammy send method; shares/story_mention/unknown fall back to a link
export const SENDERS = { image: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio', file: 'sendDocument' };
export async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// igsid -> "Name (@username)"; only called when creating a topic (once per user), so no cache needed
export async function displayName(igsid) {
  let label = igsid;
  try {
    const r = await fetch(`https://graph.instagram.com/v25.0/${igsid}?fields=name,username&access_token=${IG_ACCESS_TOKEN}`);
    if (r.ok) { const p = await r.json(); if (p.username) label = `${p.name || p.username} (@${p.username})`; }
  } catch { /* fall back to raw igsid */ }
  return label;
}

export async function igMessages(payload) {
  const res = await fetch('https://graph.instagram.com/v25.0/me/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body.error ?? body));
  return body;
}

export const sendIG = (igsid, text) => igMessages({ recipient: { id: igsid }, message: { text } });

// react (emoji) / unreact (emoji falsy) to an IG message
export const reactIG = (igsid, mid, emoji) => igMessages(emoji
  ? { recipient: { id: igsid }, sender_action: 'react', payload: { message_id: mid, reaction: emoji } }
  : { recipient: { id: igsid }, sender_action: 'unreact', payload: { message_id: mid } });
