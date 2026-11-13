// Study Quest guild sync — local mock server (zero dependencies).
// Mirrors worker/src/index.js 1:1 (including the public /guild/:code page)
// but keeps guilds in memory.
// Run:  node worker/mock-server.js   →  http://127.0.0.1:8787

const http = require('http');
const crypto = require('crypto');

const PORT = 8787;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const MAX_NAME_LEN = 24;
const MAX_USER_ID_LEN = 64;
const MAX_MEMBERS = 50;
const DAY_MS = 86_400_000;
const MEMBER_TTL_MS = 30 * DAY_MS;
const MAX_SECONDS_PER_DAY = 24 * 3600;
const MAX_SECONDS_PER_WEEK = 7 * 24 * 3600;
const RATE_LIMIT_PER_MIN = 120;

// guilds: Map<code, Map<userId, member>>
const guilds = new Map();
const rateBuckets = new Map();

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return respond(res, 204, null);
  try {
    if (!rateLimit(req)) return respond(res, 429, { error: 'Too many requests, slow down.' });
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = await readBody(req);

    if (req.method === 'GET' && parts[0] === 'guild' && parts.length === 2) {
      return guildPage(res, String(parts[1] || '').toUpperCase());
    }

    if (parts[0] !== 'api' || (parts[1] !== 'guilds' && parts[1] !== 'rooms')) {
      return respond(res, 404, { error: 'Not found' });
    }
    if (req.method === 'POST' && parts.length === 2) return createGuild(res, body);

    const code = String(parts[2] || '').toUpperCase();
    if (!isCode(code)) return respond(res, 400, { error: 'Invalid guild code' });

    if (req.method === 'GET' && parts.length === 3) return getGuild(res, code);
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'members') return upsertMember(res, code, body);
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'leave') return leaveGuild(res, code, body);
    return respond(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return respond(res, 500, { error: 'Server error' });
  }
});

/* ---------- endpoints ---------- */

function createGuild(res, body) {
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const name = clampStr(body.name, MAX_NAME_LEN) || 'Player';
  if (!userId) return respond(res, 400, { error: 'userId required' });
  gcAll();

  let code = genCode();
  while (guilds.has(code)) code = genCode();
  guilds.set(code, new Map());

  const secret = genSecret();
  guilds.get(code).set(userId, {
    name,
    secretHash: sha256(secret),
    ...clampStats(body.stats),
    lastSeen: Date.now()
  });
  respond(res, 200, { code, secret, members: liveMembers(code), serverTime: Date.now() });
}

function upsertMember(res, code, body) {
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const name = clampStr(body.name, MAX_NAME_LEN) || 'Player';
  if (!userId) return respond(res, 400, { error: 'userId required' });

  const guild = guilds.get(code);
  const now = Date.now();
  if (!guild) return respond(res, 404, { error: 'Guild not found — check the code, or it expired' });
  gcGuild(code);

  const existing = guild.get(userId);
  if (existing) {
    if (!clampStr(body.secret, 128) || sha256(body.secret) !== existing.secretHash) {
      return respond(res, 403, { error: 'Unknown member for this guild' });
    }
    Object.assign(existing, clampStats(body.stats), { name, lastSeen: now });
  } else {
    if (!liveMemberCount(code)) return respond(res, 404, { error: 'Guild not found — check the code, or it expired' });
    if (liveMemberCount(code) >= MAX_MEMBERS) return respond(res, 403, { error: 'This guild is full' });
    const secret = genSecret();
    guild.set(userId, {
      name,
      secretHash: sha256(secret),
      ...clampStats(body.stats),
      lastSeen: now
    });
    return respond(res, 200, { secret, members: liveMembers(code), serverTime: now });
  }
  respond(res, 200, { members: liveMembers(code), serverTime: now });
}

function getGuild(res, code) {
  gcGuild(code);
  if (!guilds.has(code) || liveMemberCount(code) === 0) {
    return respond(res, 404, { error: 'Guild not found — check the code, or it expired' });
  }
  respond(res, 200, { members: liveMembers(code), serverTime: Date.now() });
}

function leaveGuild(res, code, body) {
  const guild = guilds.get(code);
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const member = guild && guild.get(userId);
  if (member) {
    if (!clampStr(body.secret, 128) || sha256(body.secret) !== member.secretHash) {
      return respond(res, 403, { error: 'Unknown member for this guild' });
    }
    guild.delete(userId);
    if (guild.size === 0) guilds.delete(code);
  }
  respond(res, 200, { ok: true });
}

/* ---------- public guild page ---------- */

function guildPage(res, code) {
  if (!isCode(code)) return html(res, 404, pageShell('Guild not found', '<p class="hint">That link is not a valid guild page.</p>'));
  gcGuild(code);
  if (!guilds.has(code) || liveMemberCount(code) === 0) {
    return html(res, 404, pageShell('Guild not found',
      '<p class="hint">This guild does not exist, or everyone left. Check the link — codes expire after 30 quiet days.</p>'));
  }

  const now = Date.now();
  const sorted = liveMembers(code);
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

  const inner = `
    <p class="code">Guild code <b>${code}</b></p>
    <table>
      <thead><tr><th></th><th>Member</th><th>Today</th><th>Week</th><th>Streak</th><th>Lvl</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">Live leaderboard · updates as members study · powered by Study Quest</p>`;
  html(res, 200, pageShell('Guild leaderboard', inner));
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

function liveMembers(code) {
  const guild = guilds.get(code);
  if (!guild) return [];
  const cutoff = Date.now() - MEMBER_TTL_MS;
  return [...guild.entries()]
    .filter(([, m]) => m.lastSeen > cutoff)
    .map(([userId, m]) => ({
      userId,
      name: m.name,
      todaySeconds: m.todaySeconds,
      weekSeconds: m.weekSeconds,
      streak: m.streak,
      level: m.level,
      totalSeconds: m.totalSeconds,
      lastSeen: m.lastSeen
    }))
    .sort((a, b) => b.weekSeconds - a.weekSeconds);
}

function liveMemberCount(code) {
  const cutoff = Date.now() - MEMBER_TTL_MS;
  const guild = guilds.get(code);
  return guild ? [...guild.values()].filter((m) => m.lastSeen > cutoff).length : 0;
}

function gcGuild(code) {
  const guild = guilds.get(code);
  if (!guild) return;
  const cutoff = Date.now() - MEMBER_TTL_MS;
  for (const [id, m] of guild) if (m.lastSeen < cutoff) guild.delete(id);
  if (guild.size === 0) guilds.delete(code);
}

function gcAll() {
  for (const code of [...guilds.keys()]) gcGuild(code);
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
  let out = '';
  for (let i = 0; i < CODE_LEN; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

function genSecret() {
  return crypto.randomBytes(24).toString('base64url').slice(0, 32);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function rateLimit(req) {
  const ip = req.socket.remoteAddress || 'unknown';
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

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function respond(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(obj === null ? '' : JSON.stringify(obj));
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Study Quest mock guild server on http://127.0.0.1:${PORT}`);
});
