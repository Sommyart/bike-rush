/* Sommyart: Bike RUSH global leaderboard.
   POST: a game reports its player's progress.  GET: top 100 players (+ your own rank with ?me=<id>).
   Storage: Upstash Redis (Vercel Marketplace). Env: KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN. */
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PID = /^[a-z0-9]{10,24}$/;
const ONLINE_MS = 180000;

async function pipe(cmds) {
  const r = await fetch(RURL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map((x) => x.result);
}
const int = (v, a, b) => { v = Math.floor(Number(v) || 0); return Math.max(a, Math.min(b, v)); };
const txt = (v, n) => String(v == null ? '' : v).replace(/[<>"`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const pub = (r) => { const o = { ...r }; delete o.pid; return o; };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!RURL || !RTOK) return res.status(503).json({ ok: false, setup: true });
  try {
    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { b = {}; } }
      b = b || {};
      const pid = String(b.pid || '');
      if (!PID.test(pid)) return res.status(400).json({ ok: false });
      const total = int(b.total, 1, 300), lvl = int(b.lvl, 1, total), done = int(b.done, 0, lvl), stars = int(b.stars, 0, done * 3);
      const wins = int(b.wins, 0, 1e6), races = int(b.races, wins, 1e6), cur = b.cur ? int(b.cur, 0, total) : 0, now = Date.now();
      const rec = { pid, name: txt(b.name, 16) || 'Rider', lvl, done, stars, wins, races, total, ch: int(b.ch, 1, 40), lvName: txt(b.lvName, 40),
        cur, curName: cur ? txt(b.curName, 40) : '', t: now };
      // at most one write per player every 10 s, unless what they are doing changed (started or finished a race)
      const [first, prevCur] = await pipe([['SET', 'rl:' + pid, String(cur), 'NX', 'EX', '10'], ['GET', 'rl:' + pid]]);
      if (first !== 'OK') {
        if (String(prevCur) === String(cur)) return res.status(200).json({ ok: true, throttled: true });
        await pipe([['SET', 'rl:' + pid, String(cur), 'EX', '10']]);
      }
      const score = done * 1e6 + stars * 1e3 + Math.min(wins, 999);
      await pipe([['SET', 'p:' + pid, JSON.stringify(rec)], ['ZADD', 'lb', String(score), pid], ['ZADD', 'seen', String(now), pid]]);
      return res.status(200).json({ ok: true });
    }
    const q = req.query || {}, me = String(q.me || ''), now = Date.now();
    const [ids, total, online] = await pipe([['ZREVRANGE', 'lb', '0', '99'], ['ZCARD', 'lb'], ['ZCOUNT', 'seen', String(now - ONLINE_MS), '+inf']]);
    let players = [];
    if (ids && ids.length) {
      const raw = await pipe(ids.map((i) => ['GET', 'p:' + i]));
      players = raw.map((x, i) => { try { const r = JSON.parse(x); r.rank = i + 1; r.you = r.pid === me; return pub(r); } catch (e) { return null; } }).filter(Boolean);
    }
    let mine = null;
    if (PID.test(me)) {
      const [rk, raw] = await pipe([['ZREVRANK', 'lb', me], ['GET', 'p:' + me]]);
      if (rk != null && raw) { try { mine = pub({ ...JSON.parse(raw), rank: rk + 1, you: true }); } catch (e) {} }
    }
    res.setHeader('Cache-Control', me ? 'no-store' : 'public, s-maxage=20, stale-while-revalidate=40');
    return res.status(200).json({ ok: true, now, total: total || 0, online: online || 0, onlineMs: ONLINE_MS, players, me: mine });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
};
