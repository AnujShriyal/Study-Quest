// Study Quest friends sync — local mock server (zero dependencies).
// Mirrors worker/src/index.js 1:1 but keeps rooms in memory.
// Run:  node worker/mock-server.js   →  http://127.0.0.1:8787
// Useful for testing without deploying, or for a "host it yourself" setup.

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

// rooms: Map<code, Map<userId, member>>
const rooms = new Map();
const rateBuckets = new Map();

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return respond(res, 204, null);
  try {
    if (!rateLimit(req)) return respond(res, 429, { error: 'Too many requests, slow down.' });
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = await readBody(req);

    if (parts[0] !== 'api' || parts[1] !== 'rooms') return respond(res, 404, { error: 'Not found' });
    if (req.method === 'POST' && parts.length === 2) return createRoom(res, body);

    const code = String(parts[2] || '').toUpperCase();
    if (!isCode(code)) return respond(res, 400, { error: 'Invalid room code' });

    if (req.method === 'GET' && parts.length === 3) return getRoom(res, code);
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'members') return upsertMember(res, code, body);
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'leave') return leaveRoom(res, code, body);
    return respond(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return respond(res, 500, { error: 'Server error' });
  }
});

/* ---------- endpoints ---------- */

function createRoom(res, body) {
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const name = clampStr(body.name, MAX_NAME_LEN) || 'Player';
  if (!userId) return respond(res, 400, { error: 'userId required' });
  gcAll();

  let code = genCode();
  while (rooms.has(code)) code = genCode();
  rooms.set(code, new Map());

  const secret = genSecret();
  rooms.get(code).set(userId, {
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

  const room = rooms.get(code);
  const now = Date.now();
  if (!room) return respond(res, 404, { error: 'Room not found (check the code, or it expired)' });
  gcRoom(code);

  const existing = room.get(userId);
  if (existing) {
    if (!clampStr(body.secret, 128) || sha256(body.secret) !== existing.secretHash) {
      return respond(res, 403, { error: 'Unknown member for this room' });
    }
    Object.assign(existing, clampStats(body.stats), { name, lastSeen: now });
  } else {
    if (liveMemberCount(code) >= MAX_MEMBERS) return respond(res, 403, { error: 'This room is full' });
    const secret = genSecret();
    room.set(userId, {
      name,
      secretHash: sha256(secret),
      ...clampStats(body.stats),
      lastSeen: now
    });
    return respond(res, 200, { secret, members: liveMembers(code), serverTime: now });
  }
  respond(res, 200, { members: liveMembers(code), serverTime: now });
}

function getRoom(res, code) {
  gcRoom(code);
  if (!rooms.has(code) || liveMemberCount(code) === 0) {
    return respond(res, 404, { error: 'Room not found (check the code, or it expired)' });
  }
  respond(res, 200, { members: liveMembers(code), serverTime: Date.now() });
}

function leaveRoom(res, code, body) {
  const room = rooms.get(code);
  const userId = clampStr(body.userId, MAX_USER_ID_LEN);
  const member = room && room.get(userId);
  if (member) {
    if (!clampStr(body.secret, 128) || sha256(body.secret) !== member.secretHash) {
      return respond(res, 403, { error: 'Unknown member for this room' });
    }
    room.delete(userId);
    if (room.size === 0) rooms.delete(code);
  }
  respond(res, 200, { ok: true });
}

/* ---------- helpers ---------- */

function liveMembers(code) {
  const room = rooms.get(code);
  if (!room) return [];
  const cutoff = Date.now() - MEMBER_TTL_MS;
  return [...room.entries()]
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
  const room = rooms.get(code);
  return room ? [...room.values()].filter((m) => m.lastSeen > cutoff).length : 0;
}

function gcRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  const cutoff = Date.now() - MEMBER_TTL_MS;
  for (const [id, m] of room) if (m.lastSeen < cutoff) room.delete(id);
  if (room.size === 0) rooms.delete(code);
}

function gcAll() {
  for (const code of [...rooms.keys()]) gcRoom(code);
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Study Quest mock sync server on http://127.0.0.1:${PORT}`);
});
