// Study Quest friends sync — Cloudflare Worker + D1
// Tiny room-code API: no accounts, per-member secret to prevent impersonation.
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
      if (parts[0] !== 'api' || parts[1] !== 'rooms') return json({ error: 'Not found' }, 404);

      if (request.method === 'POST' && parts.length === 2) return createRoom(env, request);

      const code = String(parts[2] || '').toUpperCase();
      if (!isCode(code)) return json({ error: 'Invalid room code' }, 400);

      if (request.method === 'GET' && parts.length === 3) return getRoom(env, code);
      if (request.method === 'POST' && parts.length === 4 && parts[3] === 'members') {
        return upsertMember(env, request, code);
      }
      if (request.method === 'POST' && parts.length === 4 && parts[3] === 'leave') {
        return leaveRoom(env, request, code);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('worker error', err);
      return json({ error: 'Server error' }, 500);
    }
  }
};

/* ---------- endpoints ---------- */

async function createRoom(env, request) {
  const body = await readJson(request);
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const name = clampStr(body.name, MAX_NAME_LEN) || 'Player';
  if (!userId) return json({ error: 'userId required' }, 400);

  await gcRooms(env);

  let code = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = genCode();
    const clash = await env.DB.prepare('SELECT 1 FROM members WHERE room = ? LIMIT 1').bind(candidate).first();
    if (!clash) { code = candidate; break; }
  }
  if (!code) return json({ error: 'Could not allocate a room code, try again' }, 500);

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

  if (existing) {
    if (!clampStr(body.secret, 128) || (await sha256(body.secret)) !== existing.secret_hash) {
      return json({ error: 'Unknown member for this room' }, 403);
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
    if ((count?.n || 0) >= MAX_MEMBERS) return json({ error: 'This room is full' }, 403);

    const secret = genSecret();
    await env.DB.prepare(
      `INSERT INTO members (room, user_id, name, secret_hash, today_seconds, week_seconds,
       streak, level, total_seconds, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(code, userId, name, await sha256(secret), stats.todaySeconds, stats.weekSeconds,
      stats.streak, stats.level, stats.totalSeconds, now).run();
    await gcRoom(env, code);
    return json({ secret, members: await liveMembers(env, code), serverTime: now });
  }

  await gcRoom(env, code);
  return json({ members: await liveMembers(env, code), serverTime: now });
}

async function getRoom(env, code) {
  await gcRoom(env, code);
  return json({ members: await liveMembers(env, code), serverTime: Date.now() });
}

async function leaveRoom(env, request, code) {
  const body = await readJson(request);
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const row = userId
    ? await env.DB.prepare('SELECT secret_hash FROM members WHERE room = ? AND user_id = ?')
        .bind(code, userId).first()
    : null;
  if (row && (await sha256(clampStr(body.secret, 128))) !== row.secret_hash) {
    return json({ error: 'Unknown member for this room' }, 403);
  }
  if (row) {
    await env.DB.prepare('DELETE FROM members WHERE room = ? AND user_id = ?').bind(code, userId).run();
  }
  return json({ ok: true });
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

async function gcRoom(env, code) {
  await env.DB.prepare('DELETE FROM members WHERE room = ? AND last_seen < ?')
    .bind(code, Date.now() - MEMBER_TTL_MS).run();
}

async function gcRooms(env) {
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
