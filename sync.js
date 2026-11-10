'use strict';

// Friends leaderboard sync — main process module.
// Owns all network traffic. Aggregates only ever leave the machine:
// name, today/week seconds, streak, level, total time. Never sessions,
// subjects, missions, or the member secret (which stays in the data file
// and is never sent to renderers).

const DEFAULT_SYNC_URL = ''; // e.g. 'https://study-quest-sync.your-subdomain.workers.dev'
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_NAME_LEN = 24;

let deps = null; // { getData, saveData, computeStats, sendToAll, uid }
let syncTimer = null;
let inFlight = false;

function initSync(d) {
  deps = d;
}

function friends() {
  return deps.getData().settings.friends;
}

function configuredBaseUrl() {
  const base = (friends().baseUrl || DEFAULT_SYNC_URL).trim();
  return base ? base.replace(/\/+$/, '') : '';
}

function getDefaultSyncUrl() {
  return DEFAULT_SYNC_URL;
}

/* ---------- payload ---------- */

function buildStats() {
  const s = deps.computeStats();
  return {
    todaySeconds: Math.max(0, Math.round(s.todaySeconds)),
    weekSeconds: Math.max(0, Math.round(s.weekSeconds)),
    streak: Math.max(0, s.streak.current),
    level: Math.max(1, s.level),
    totalSeconds: Math.max(0, Math.round(s.totalSeconds))
  };
}

function sanitizeMember(m) {
  if (!m || typeof m !== 'object') return null;
  const int = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min;
  };
  return {
    userId: typeof m.userId === 'string' ? m.userId.slice(0, 64) : '',
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, MAX_NAME_LEN) : 'Friend',
    todaySeconds: int(m.todaySeconds, 0, 24 * 3600),
    weekSeconds: int(m.weekSeconds, 0, 7 * 24 * 3600),
    streak: int(m.streak, 0, 3650),
    level: int(m.level, 1, 100000),
    totalSeconds: int(m.totalSeconds, 0, 100 * 365 * 24 * 3600),
    lastSeen: int(m.lastSeen, 0, Number.MAX_SAFE_INTEGER)
  };
}

function adoptMembers(raw) {
  return (Array.isArray(raw) ? raw : []).map(sanitizeMember).filter((m) => m && m.userId);
}

function broadcast() {
  const f = friends();
  deps.sendToAll('friends:updated', {
    members: f.snapshot,
    syncedAt: f.lastSyncAt,
    error: f.lastError
  });
}

/* ---------- transport ---------- */

async function apiRequest(path, body) {
  const base = configuredBaseUrl();
  if (!base) throw new Error('No sync server configured yet');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- actions ---------- */

async function createRoom({ displayName, baseUrl } = {}) {
  const f = friends();
  const name = typeof displayName === 'string' ? displayName.trim().slice(0, MAX_NAME_LEN) : '';
  if (!name) return { ok: false, error: 'Pick a display name first' };
  if (baseUrl !== undefined) f.baseUrl = String(baseUrl || '').trim().slice(0, 200);
  if (!configuredBaseUrl()) return { ok: false, error: 'Add a sync server URL first' };
  if (!f.userId) f.userId = deps.uid() + deps.uid();

  try {
    const res = await apiRequest('/api/rooms', { userId: f.userId, name });
    f.roomCode = res.code;
    f.memberSecret = typeof res.secret === 'string' ? res.secret.slice(0, 128) : null;
    if (!f.memberSecret) throw new Error('Server did not issue a member secret');
    f.enabled = true;
    f.displayName = name;
    f.snapshot = adoptMembers(res.members);
    f.lastSyncAt = Date.now();
    f.lastError = null;
    deps.saveData();
    scheduleSync();
    broadcast();
    return { ok: true, roomCode: f.roomCode };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function joinRoom({ code, displayName, baseUrl } = {}) {
  const f = friends();
  const name = typeof displayName === 'string' ? displayName.trim().slice(0, MAX_NAME_LEN) : '';
  if (!name) return { ok: false, error: 'Pick a display name first' };
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 6) return { ok: false, error: 'Room codes are 6 characters' };
  if (baseUrl !== undefined) f.baseUrl = String(baseUrl || '').trim().slice(0, 200);
  if (!configuredBaseUrl()) return { ok: false, error: 'Add a sync server URL first' };
  if (!f.userId) f.userId = deps.uid() + deps.uid();

  try {
    const res = await apiRequest(`/api/rooms/${encodeURIComponent(clean)}/members`, {
      userId: f.userId,
      name,
      stats: buildStats()
    });
    if (typeof res.secret !== 'string' || !res.secret) {
      throw new Error('Server did not issue a member secret');
    }
    f.roomCode = clean;
    f.memberSecret = res.secret.slice(0, 128);
    f.enabled = true;
    f.displayName = name;
    f.snapshot = adoptMembers(res.members);
    f.lastSyncAt = Date.now();
    f.lastError = null;
    deps.saveData();
    scheduleSync();
    broadcast();
    return { ok: true, roomCode: clean };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function syncNow(reason = 'auto') {
  const f = friends();
  if (!f.enabled || !f.roomCode || !f.userId || !f.memberSecret) return { ok: false };
  if (inFlight) return { ok: false, reason: 'already-running' };
  inFlight = true;
  try {
    const res = await apiRequest(`/api/rooms/${encodeURIComponent(f.roomCode)}/members`, {
      userId: f.userId,
      secret: f.memberSecret,
      name: f.displayName || 'Player',
      stats: buildStats()
    });
    f.snapshot = adoptMembers(res.members);
    f.lastSyncAt = Date.now();
    f.lastError = null;
  } catch (e) {
    f.lastError = errorMessage(e);
  } finally {
    inFlight = false;
  }
  deps.saveData();
  broadcast();
  return { ok: !f.lastError, error: f.lastError };
}

async function leaveRoom() {
  const f = friends();
  if (f.enabled && f.roomCode && f.userId && f.memberSecret) {
    await apiRequest(`/api/rooms/${encodeURIComponent(f.roomCode)}/leave`, {
      userId: f.userId,
      secret: f.memberSecret
    }).catch(() => {}); // leaving is best-effort; local state clears regardless
  }
  f.enabled = false;
  f.roomCode = null;
  f.memberSecret = null;
  f.snapshot = [];
  f.lastSyncAt = 0;
  f.lastError = null;
  deps.saveData();
  broadcast();
  return { ok: true };
}

function setDisplayName(name) {
  const f = friends();
  const clean = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LEN) : '';
  if (!clean) return { ok: false, error: 'Name required' };
  f.displayName = clean;
  deps.saveData();
  if (f.enabled) syncNow('name-change');
  return { ok: true };
}

/* ---------- scheduler ---------- */

function scheduleSync() {
  if (syncTimer) return;
  syncTimer = setInterval(() => { syncNow('interval'); }, SYNC_INTERVAL_MS);
  if (syncTimer.unref) syncTimer.unref();
  const startup = setTimeout(() => { syncNow('startup'); }, STARTUP_DELAY_MS);
  if (startup.unref) startup.unref();
}

function errorMessage(e) {
  const msg = e && e.name === 'AbortError' ? 'Server timed out' : String((e && e.message) || e);
  return msg.slice(0, 120);
}

module.exports = {
  initSync,
  getDefaultSyncUrl,
  sanitizeMember,
  createRoom,
  joinRoom,
  syncNow,
  leaveRoom,
  setDisplayName,
  scheduleSync
};
