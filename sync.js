'use strict';

// Guild leaderboard sync — main process module.
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

function guild() {
  return deps.getData().settings.guild;
}

function configuredBaseUrl() {
  const base = (guild().baseUrl || DEFAULT_SYNC_URL).trim();
  return base ? base.replace(/\/+$/, '') : '';
}

function getDefaultSyncUrl() {
  return DEFAULT_SYNC_URL;
}

function guildPageUrl(code) {
  const base = configuredBaseUrl();
  const clean = String(code || guild().roomCode || '').toUpperCase();
  return base && clean ? `${base}/guild/${clean}` : '';
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
  const g = guild();
  deps.sendToAll('guild:updated', {
    members: g.snapshot,
    syncedAt: g.lastSyncAt,
    error: g.lastError
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
      body: body === undefined ? undefined : JSON.stringify(body),
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

function cleanCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/* ---------- actions ---------- */

async function createGuild({ displayName, baseUrl } = {}) {
  const g = guild();
  const name = typeof displayName === 'string' ? displayName.trim().slice(0, MAX_NAME_LEN) : '';
  if (!name) return { ok: false, error: 'Pick a display name first' };
  if (baseUrl !== undefined) g.baseUrl = String(baseUrl || '').trim().slice(0, 200);
  if (!configuredBaseUrl()) return { ok: false, error: 'Add a sync server URL first' };
  if (!g.userId) g.userId = deps.uid() + deps.uid();

  try {
    const res = await apiRequest('/api/guilds', { userId: g.userId, name });
    g.roomCode = res.code;
    g.memberSecret = typeof res.secret === 'string' ? res.secret.slice(0, 128) : null;
    if (!g.memberSecret) throw new Error('Server did not issue a member secret');
    g.enabled = true;
    g.displayName = name;
    g.snapshot = adoptMembers(res.members);
    g.lastSyncAt = Date.now();
    g.lastError = null;
    deps.saveData();
    scheduleSync();
    broadcast();
    return { ok: true, roomCode: g.roomCode, pageUrl: guildPageUrl() };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function joinGuild({ code, displayName, baseUrl } = {}) {
  const g = guild();
  const name = typeof displayName === 'string' ? displayName.trim().slice(0, MAX_NAME_LEN) : '';
  if (!name) return { ok: false, error: 'Pick a display name first' };
  const clean = cleanCode(code);
  if (clean.length !== 6) return { ok: false, error: 'Guild codes are 6 characters' };
  if (baseUrl !== undefined) g.baseUrl = String(baseUrl || '').trim().slice(0, 200);
  if (!configuredBaseUrl()) return { ok: false, error: 'Add a sync server URL first' };
  if (!g.userId) g.userId = deps.uid() + deps.uid();

  try {
    const res = await apiRequest(`/api/guilds/${encodeURIComponent(clean)}/members`, {
      userId: g.userId,
      name,
      stats: buildStats()
    });
    if (typeof res.secret !== 'string' || !res.secret) {
      throw new Error('Server did not issue a member secret');
    }
    g.roomCode = clean;
    g.memberSecret = res.secret.slice(0, 128);
    g.enabled = true;
    g.displayName = name;
    g.snapshot = adoptMembers(res.members);
    g.lastSyncAt = Date.now();
    g.lastError = null;
    deps.saveData();
    scheduleSync();
    broadcast();
    return { ok: true, roomCode: clean, pageUrl: guildPageUrl() };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

// Spectator mode: view any guild's leaderboard by code — no membership, no name.
async function viewGuild({ code, baseUrl } = {}) {
  const g = guild();
  const clean = cleanCode(code);
  if (clean.length !== 6) return { ok: false, error: 'Guild codes are 6 characters' };
  if (baseUrl !== undefined) g.baseUrl = String(baseUrl || '').trim().slice(0, 200);
  if (!configuredBaseUrl()) return { ok: false, error: 'Add a sync server URL first' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${configuredBaseUrl()}/api/guilds/${encodeURIComponent(clean)}`, {
      signal: controller.signal
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);
    return { ok: true, code: clean, members: adoptMembers(data.members), serverTime: Date.now() };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function syncNow(reason = 'auto') {
  const g = guild();
  if (!g.enabled || !g.roomCode || !g.userId || !g.memberSecret) return { ok: false };
  if (inFlight) return { ok: false, reason: 'already-running' };
  inFlight = true;
  try {
    const res = await apiRequest(`/api/guilds/${encodeURIComponent(g.roomCode)}/members`, {
      userId: g.userId,
      secret: g.memberSecret,
      name: g.displayName || 'Player',
      stats: buildStats()
    });
    g.snapshot = adoptMembers(res.members);
    g.lastSyncAt = Date.now();
    g.lastError = null;
  } catch (e) {
    g.lastError = errorMessage(e);
  } finally {
    inFlight = false;
  }
  deps.saveData();
  broadcast();
  return { ok: !g.lastError, error: g.lastError };
}

async function leaveGuild() {
  const g = guild();
  if (g.enabled && g.roomCode && g.userId && g.memberSecret) {
    await apiRequest(`/api/guilds/${encodeURIComponent(g.roomCode)}/leave`, {
      userId: g.userId,
      secret: g.memberSecret
    }).catch(() => {}); // leaving is best-effort; local state clears regardless
  }
  g.enabled = false;
  g.roomCode = null;
  g.memberSecret = null;
  g.snapshot = [];
  g.lastSyncAt = 0;
  g.lastError = null;
  deps.saveData();
  broadcast();
  return { ok: true };
}

function setDisplayName(name) {
  const g = guild();
  const clean = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LEN) : '';
  if (!clean) return { ok: false, error: 'Name required' };
  g.displayName = clean;
  deps.saveData();
  if (g.enabled) syncNow('name-change');
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
  guildPageUrl,
  sanitizeMember,
  createGuild,
  joinGuild,
  viewGuild,
  syncNow,
  leaveGuild,
  setDisplayName,
  scheduleSync
};
