// Study Quest guild sync — Cloudflare Worker + D1
// Tiny guild-code API: no accounts, per-member secret to prevent impersonation.
// Plus a public, read-only leaderboard page for every guild at /guild/:code.
// Deploy: see worker/README.md

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
const CODE_LEN = 6;
const MAX_NAME_LEN = 24;
const MAX_USER_ID_LEN = 64;
const MAX_MEMBERS = 50;
const DAY_MS = 86_400_000;
const MEMBER_TTL_MS = 30 * DAY_MS;
const MAX_SECONDS_PER_DAY = 24 * 3600;
const MAX_SECONDS_PER_WEEK = 7 * 24 * 3600;
const RATE_LIMIT_PER_MIN = 120;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// Best-effort per-isolate rate limiting (fine for a friends app).
const rateBuckets = new Map();

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (!rateLimit(request)) return json({ error: 'Too many requests, slow down.' }, 429);

      const parts = new URL(request.url).pathname.split('/').filter(Boolean);

      // Public guild page — no code-gated API, just the shareable link.
      if (request.method === 'GET' && parts[0] === 'guild' && parts.length === 2) {
        return guildPage(env, String(parts[1] || '').toUpperCase());
      }

      // API — /api/guilds/* is canonical; legacy /api/rooms/* still accepted.
      if (parts[0] !== 'api' || (parts[1] !== 'guilds' && parts[1] !== 'rooms')) {
        return json({ error: 'Not found' }, 404);
      }

      if (request.method === 'POST' && parts.length === 2) return createGuild(env, request);

      const code = String(parts[2] || '').toUpperCase();
      if (!isCode(code)) return json({ error: 'Invalid guild code' }, 400);

      if (request.method === 'GET' && parts.length === 3) return getGuild(env, code);
      if (request.method === 'POST' && parts.length === 4 && parts[3] === 'members') {
        return upsertMember(env, request, code);
      }
      if (request.method === 'POST' && parts.length === 4 && parts[3] === 'leave') {
        return leaveGuild(env, request, code);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('worker error', err);
      return json({ error: 'Server error' }, 500);
    }
  }
};

/* ---------- endpoints ---------- */

async function createGuild(env, request) {
  const body = await readJson(request);
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const name = clampStr(body.name, MAX_NAME_LEN) || 'Player';
  if (!userId) return json({ error: 'userId required' }, 400);

  await gcAll(env);

  let code = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = genCode();
    const clash = await env.DB.prepare('SELECT 1 FROM members WHERE room = ? LIMIT 1').bind(candidate).first();
    if (!clash) { code = candidate; break; }
  }
  if (!code) return json({ error: 'Could not allocate a guild code, try again' }, 500);

  const secret = genSecret();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO members (room, user_id, name, secret_hash, last_seen) VALUES (?, ?, ?, ?, ?)'
  ).bind(code, userId, name, await sha256(secret), now).run();

  return json({ code, secret, members: await liveMembers(env, code), serverTime: now });
}

async function upsertMember(env, request, code) {
  const body = await readJson(request);
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const name = clampStr(body.name, MAX_NAME_LEN) || 'Player';
  const now = Date.now();
  if (!userId) return json({ error: 'userId required' }, 400);
  const stats = clampStats(body.stats);

  const existing = await env.DB.prepare(
    'SELECT secret_hash FROM members WHERE room = ? AND user_id = ?'
  ).bind(code, userId).first();

  if (!existing) {
    // Unknown member: only allow joining guilds that actually exist,
    // otherwise a typo'd code would silently create a ghost guild.
    const guildExists = await env.DB.prepare(
      'SELECT 1 FROM members WHERE room = ? AND last_seen > ? LIMIT 1'
    ).bind(code, now - MEMBER_TTL_MS).first();
    if (!guildExists) return json({ error: 'Guild not found — check the code, or it expired' }, 404);
  }

  if (existing) {
    if (!clampStr(body.secret, 128) || (await sha256(body.secret)) !== existing.secret_hash) {
      return json({ error: 'Unknown member for this guild' }, 403);
    }
    await env.DB.prepare(
      `UPDATE members SET name = ?, today_seconds = ?, week_seconds = ?, streak = ?,
       level = ?, total_seconds = ?, last_seen = ? WHERE room = ? AND user_id = ?`
    ).bind(name, stats.todaySeconds, stats.weekSeconds, stats.streak, stats.level,
      stats.totalSeconds, now, code, userId).run();
  } else {
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM members WHERE room = ? AND last_seen > ?'
    ).bind(code, now - MEMBER_TTL_MS).first();
    if ((count?.n || 0) >= MAX_MEMBERS) return json({ error: 'This guild is full' }, 403);

    const secret = genSecret();
    await env.DB.prepare(
      `INSERT INTO members (room, user_id, name, secret_hash, today_seconds, week_seconds,
       streak, level, total_seconds, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(code, userId, name, await sha256(secret), stats.todaySeconds, stats.weekSeconds,
      stats.streak, stats.level, stats.totalSeconds, now).run();
    await gcGuild(env, code);
    return json({ secret, members: await liveMembers(env, code), serverTime: now });
  }

  await gcGuild(env, code);
  return json({ members: await liveMembers(env, code), serverTime: now });
}

async function getGuild(env, code) {
  await gcGuild(env, code);
  const members = await liveMembers(env, code);
  if (!members.length) return json({ error: 'Guild not found — check the code, or it expired' }, 404);
  return json({ members, serverTime: Date.now() });
}

async function leaveGuild(env, request, code) {
  const body = await readJson(request);
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const row = userId
    ? await env.DB.prepare('SELECT secret_hash FROM members WHERE room = ? AND user_id = ?')
        .bind(code, userId).first()
    : null;
  if (row && (await sha256(clampStr(body.secret, 128))) !== row.secret_hash) {
    return json({ error: 'Unknown member for this guild' }, 403);
  }
  if (row) {
    await env.DB.prepare('DELETE FROM members WHERE room = ? AND user_id = ?').bind(code, userId).run();
  }
  return json({ ok: true });
}

/* ---------- public guild page ---------- */

async function guildPage(env, code) {
  if (!isCode(code)) return htmlPage(pageShell('Guild not found', '<p class="hint">That link is not a valid guild page.</p>'), 404);
  await gcGuild(env, code);
  const members = await liveMembers(env, code);
  if (!members.length) {
    return htmlPage(pageShell('Guild not found',
      '<p class="hint">This guild does not exist, or everyone left. Check the link — codes expire after 30 quiet days.</p>'), 404);
  }

  const now = Date.now();
  const sorted = [...members].sort((a, b) => b.weekSeconds - a.weekSeconds);
  const rows = sorted.map((m, i) => {
    const away = now - m.lastSeen > 2 * 3600 * 1000;
    const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    return `<tr class="${away ? 'away' : ''}">
      <td><span class="rank ${medal}">${i + 1}</span></td>
      <td class="name">${escapeHtml(m.name)}${away ? ' <span class="tag">away</span>' : ''}</td>
      <td>${fmtDur(m.todaySeconds)}</td>
      <td>${fmtDur(m.weekSeconds)}</td>
      <td>${m.streak}d</td>
      <td><span class="lvl">L${m.level}</span></td>
    </tr>`;
  }).join('');

  const body = `
    <p class="code">Guild code <b>${code}</b></p>
    <table>
      <thead><tr><th></th><th>Member</th><th>Today</th><th>Week</th><th>Streak</th><th>Lvl</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">Live leaderboard · updates as members study · powered by Study Quest</p>`;
  return htmlPage(pageShell('Guild leaderboard', body));
}

function pageShell(title, inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} — Study Quest</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #151518; color: #ededea; padding: 24px;
    font-family: 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif;
  }
  .card {
    width: min(640px, 100%); background: #1c1c21; border: 1px solid rgba(255,255,255,.08);
    border-radius: 16px; padding: 28px 28px 22px; box-shadow: 0 12px 32px rgba(0,0,0,.25);
  }
  .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .hex {
    width: 22px; height: 24px; background: linear-gradient(140deg, #edba62, #d0872a);
    clip-path: polygon(50% 0%, 94% 25%, 94% 75%, 50% 100%, 6% 75%, 6% 25%);
  }
  .logo b { font-size: 15px; letter-spacing: .3px; }
  .logo span { color: #6e6d66; font-size: 12px; }
  .code { color: #a3a29b; font-size: 13px; margin: 0 0 14px; }
  .code b { color: #e2a44b; letter-spacing: 2px; font-family: Consolas, monospace; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th {
    text-align: left; color: #6e6d66; font-size: 10px; text-transform: uppercase;
    letter-spacing: 1.1px; font-weight: 700; padding: 0 8px 8px; border-bottom: 1px solid rgba(255,255,255,.08);
  }
  th:nth-child(n+3), td:nth-child(n+3) { text-align: right; }
  td { padding: 9px 8px; border-bottom: 1px solid rgba(255,255,255,.05); color: #a3a29b; }
  td.name { color: #ededea; font-weight: 600; }
  tr.away td { opacity: .45; }
  .rank {
    display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 7px;
    background: rgba(255,255,255,.05); color: #6e6d66; font-size: 11px; font-weight: 700;
  }
  .rank.gold { background: rgba(217,169,78,.14); color: #d9a94e; }
  .tag {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px;
    color: #6e6d66; background: rgba(255,255,255,.05); padding: 2px 6px; border-radius: 5px;
  }
  .lvl {
    background: rgba(226,164,75,.14); color: #e2a44b; font-size: 10px; font-weight: 700;
    padding: 2px 7px; border-radius: 5px;
  }
  .hint { color: #6e6d66; font-size: 11.5px; line-height: 1.5; }
  p.hint { margin: 16px 0 0; }
</style>
</head>
<body>
  <main class="card">
    <div class="logo">
      <span class="hex"></span>
      <b>Study Quest</b>
      <span>· guild leaderboard</span>
    </div>
    ${inner}
  </main>
</body>
</html>`;
}

function htmlPage(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtDur(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/* ---------- helpers ---------- */

async function liveMembers(env, code) {
  const cutoff = Date.now() - MEMBER_TTL_MS;
  const res = await env.DB.prepare(
    `SELECT user_id, name, today_seconds, week_seconds, streak, level, total_seconds, last_seen
     FROM members WHERE room = ? AND last_seen > ? ORDER BY week_seconds DESC`
  ).bind(code, cutoff).all();
  return (res.results || []).map((r) => ({
    userId: r.user_id,
    name: r.name,
    todaySeconds: r.today_seconds,
    weekSeconds: r.week_seconds,
    streak: r.streak,
    level: r.level,
    totalSeconds: r.total_seconds,
    lastSeen: r.last_seen
  }));
}

async function gcGuild(env, code) {
  await env.DB.prepare('DELETE FROM members WHERE room = ? AND last_seen < ?')
    .bind(code, Date.now() - MEMBER_TTL_MS).run();
}

async function gcAll(env) {
  await env.DB.prepare('DELETE FROM members WHERE last_seen < ?')
    .bind(Date.now() - MEMBER_TTL_MS).run();
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function clampStats(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    todaySeconds: clampInt(s.todaySeconds, 0, MAX_SECONDS_PER_DAY),
    weekSeconds: clampInt(s.weekSeconds, 0, MAX_SECONDS_PER_WEEK),
    streak: clampInt(s.streak, 0, 3650),
    level: clampInt(s.level, 1, 100_000),
    totalSeconds: clampInt(s.totalSeconds, 0, 100 * 365 * MAX_SECONDS_PER_DAY)
  };
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampStr(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function isCode(code) {
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`).test(code);
}

function genCode() {
  return genRandom(CODE_LEN).map((i) => CODE_ALPHABET[i % CODE_ALPHABET.length]).join('');
}

function genSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 32);
}

function genRandom(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes];
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function rateLimit(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > 60_000) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return bucket.count <= RATE_LIMIT_PER_MIN;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}
