// throwaway: confirm IGAA token + fetch profile and recent DM conversations
// run: node --env-file=.env test-ig.js
const BASE = 'https://graph.instagram.com/v25.0';
const token = process.env.IG_ACCESS_TOKEN;

async function get(path) {
  const url = `${BASE}/${path}${path.includes('?') ? '&' : '?'}access_token=${token}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body.error ?? body));
  return body;
}

(async () => {
  const me = await get('me?fields=user_id,username');
  console.log('Token OK ->', me);

  const convos = await get('me/conversations?platform=instagram');
  console.log(`\nConversations: ${convos.data?.length ?? 0}`);

  for (const c of convos.data ?? []) {
    const detail = await get(`${c.id}?fields=messages{id,created_time,from,to,message}`);
    console.log(`\n--- conversation ${c.id} ---`);
    console.log(JSON.stringify(detail.messages?.data ?? detail, null, 2));
  }
})().catch(e => console.error('FAILED:', e.message));
