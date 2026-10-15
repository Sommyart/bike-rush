/* Sommyart: Bike RUSH new-track alerts for browser / installed-web-app players.
   GET            -> { ok, key }  the public key a browser needs to subscribe.
   GET ?check=1   -> sends the "new tracks" alert once per release (when _news.json's id changes).
   POST {sub}     -> save a push subscription.   POST {unsub:endpoint} -> remove it.
   The signing keys are created on first use and kept in the same Upstash Redis as the leaderboard. */
const webpush = require('web-push');
const crypto = require('crypto');
const NEWS = require('./_news.json');
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SUBJECT = 'https://sommyart-bike-rush.vercel.app';
const MAX_SUBS = 20000;

async function pipe(cmds) {
  const r = await fetch(RURL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map((x) => x.result);
}

async function keys() {
  let [k] = await pipe([['GET', 'push:vapid']]);
  if (!k) {
    const fresh = webpush.generateVAPIDKeys();
    await pipe([['SET', 'push:vapid', JSON.stringify(fresh), 'NX']]);
    [k] = await pipe([['GET', 'push:vapid']]);
  }
  return JSON.parse(k);
}

const idOf = (endpoint) => crypto.createHash('sha1').update(endpoint).digest('hex');
function cleanSub(s) {
  if (!s || typeof s !== 'object') return null;
  const ep = String(s.endpoint || '');
  if (!/^https:\/\/[^\s]{10,800}$/.test(ep)) return null;
  const k = s.keys || {};
  const p = String(k.p256dh || ''), a = String(k.auth || '');
  if (!/^[A-Za-z0-9_\-=]{40,200}$/.test(p) || !/^[A-Za-z0-9_\-=]{10,60}$/.test(a)) return null;
  return { endpoint: ep, keys: { p256dh: p, auth: a } };
}

async function broadcast() {
  const [last] = await pipe([['GET', 'push:newsId']]);
  if (String(last) === String(NEWS.id)) return { sent: 0, same: true };
  if (!last) { await pipe([['SET', 'push:newsId', String(NEWS.id)]]); return { sent: 0, first: true }; }
  const [lock] = await pipe([['SET', 'push:lock', '1', 'NX', 'EX', '300']]);
  if (lock !== 'OK') return { sent: 0, busy: true };
  await pipe([['SET', 'push:newsId', String(NEWS.id)]]);
  const k = await keys();
  const [flat] = await pipe([['HGETALL', 'push:subs']]);
  const payload = JSON.stringify({ title: NEWS.title, body: NEWS.body, url: NEWS.url || './', tag: 'tracks-' + NEWS.id });
  const opts = { vapidDetails: { subject: SUBJECT, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 3 * 24 * 3600, timeout: 8000 };
  const entries = [];
  for (let i = 0; i + 1 < (flat || []).length; i += 2) entries.push([flat[i], flat[i + 1]]);
  let sent = 0; const dead = [];
  for (let i = 0; i < entries.length; i += 50) {
    await Promise.all(entries.slice(i, i + 50).map(async ([id, json]) => {
      try { await webpush.sendNotification(JSON.parse(json), payload, opts); sent++; }
      catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(id); }
    }));
  }
  if (dead.length) await pipe([['HDEL', 'push:subs', ...dead]]);
  await pipe([['DEL', 'push:lock']]);
  return { sent, removed: dead.length };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!RURL || !RTOK) return res.status(503).json({ ok: false, setup: true });
  try {
    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { b = {}; } }
      b = b || {};
      if (b.unsub) { await pipe([['HDEL', 'push:subs', idOf(String(b.unsub))]]); return res.status(200).json({ ok: true }); }
      const sub = cleanSub(b.sub);
      if (!sub) return res.status(400).json({ ok: false });
      const [n] = await pipe([['HLEN', 'push:subs']]);
      if (n >= MAX_SUBS) return res.status(200).json({ ok: false, full: true });
      await pipe([['HSET', 'push:subs', idOf(sub.endpoint), JSON.stringify(sub)]]);
      return res.status(200).json({ ok: true });
    }
    if (req.query && req.query.check) return res.status(200).json({ ok: true, ...(await broadcast()) });
    const k = await keys();
    return res.status(200).json({ ok: true, key: k.publicKey, news: NEWS.id });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
};
