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
let actionQueue = Promise.resolve();
let volatileMemberCredential = null;
let volatilePendingLeave = null;

function serializeAction(fn) {
  const task = actionQueue.then(fn, fn);
  actionQueue = task.catch(() => {});
  return task;
}

function initSync(d) {
  deps = d;
}

function guild() {
  return deps.getData().settings.guild;
}
function persist() { const r = deps.saveData(); return r !== false && !(r && r.ok === false); }
function captureCredential(g) {
  return {
    baseUrl: g.baseUrl || '', userId: g.userId, roomCode: g.roomCode,
    memberSecret: g.memberSecret, displayName: g.displayName || 'Player', enabled: true,
    snapshot: adoptMembers(g.snapshot), lastSyncAt: g.lastSyncAt || 0, lastError: g.lastError || null
  };
}
function persistWithCredentialRecovery(g) {
  if (g.enabled && g.userId && g.roomCode && g.memberSecret) volatileMemberCredential = captureCredential(g);
  const ok = persist();
  if (ok) volatileMemberCredential = null;
  return ok;
}
function matchesCredentialState(g, p) {
  return (!g.userId || g.userId === p.userId) &&
    (!g.roomCode || g.roomCode === p.roomCode) &&
    (!g.baseUrl || validatedBaseUrl(g.baseUrl) === validatedBaseUrl(p.baseUrl));
}
function retryVolatileCredential() {
  const p = volatileMemberCredential;
  if (!p) return true;
  const g = guild();
  if (!matchesCredentialState(g, p)) return false;
  Object.assign(g, p);
  const ok = persist();
  if (ok) volatileMemberCredential = null;
  return ok;
}

function validatedBaseUrl(value) {
  const base = String(value || '').trim();
  if (!base) return '';
  try {
    const u = new URL(base);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.username || u.password || (u.protocol !== 'https:' && !(loopback && u.protocol === 'http:'))) return '';
    return u.origin;
  } catch { return ''; }
}
function configuredBaseUrl() { return validatedBaseUrl(guild().baseUrl || DEFAULT_SYNC_URL); }

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
    totalSeconds: Math.max(0, Math.round(s.totalSeconds)),
    todayDate: typeof s.todayDate === 'string' ? s.todayDate : new Date().toISOString().slice(0, 10),
    timeZone: typeof s.timeZone === 'string' ? s.timeZone : 'UTC',
    dailySeconds: Array.isArray(s.dailySeconds) ? s.dailySeconds.slice(-7) : []
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
    lastSeen: int(m.lastSeen, 0, Number.MAX_SAFE_INTEGER),
    todayDate: isISODate(m.todayDate) ? m.todayDate : '',
    timeZone: validTimeZone(m.timeZone) ? m.timeZone : 'UTC'
  };
}

function isISODate(s) { if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(`${s}T00:00:00.000Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s; }
function validTimeZone(zone) { if(typeof zone!=='string'||zone.length>64)return false;try{new Intl.DateTimeFormat('en-US',{timeZone:zone}).format();return true;}catch{return false;} }

function adoptMembers(raw) {
  return (Array.isArray(raw) ? raw : []).map(sanitizeMember).filter((m) => m && m.userId);
}

function broadcast() {
  const g = guild();
  deps.sendToAll('guild:updated', {
    members: adoptMembers(g.snapshot),
    syncedAt: g.lastSyncAt,
    error: g.lastError,
    enabled: !!g.enabled,
    roomCode: g.roomCode || null,
    hasPendingLeave: !!g.pendingLeave || !!volatilePendingLeave,
    pageUrl: guildPageUrl()
  });
}

/* ---------- transport ---------- */

async function apiRequest(path, body, baseOverride) {
  const base = baseOverride === undefined ? configuredBaseUrl() : validatedBaseUrl(baseOverride);
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
    const data = await readResponseJson(res);
    if (!res.ok) {
      const e = new Error(data.error || `Server responded ${res.status}`);
      e.status = res.status;
      e.payload = data;
      throw e;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Server returned invalid data');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function cleanCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/* ---------- actions ---------- */

function createGuild(args = {}) { return serializeAction(async () => { if (!retryVolatileCredential()) return {ok:false,error:'Could not save your guild credentials; retry before creating another guild'}; if (!(await flushPendingLeave())) return {ok:false,error:'Finish removing your previous guild membership before creating another'}; return createGuildNow(args); }); }
async function createGuildNow({ displayName, baseUrl } = {}) {
  let g = guild();
  const name = typeof displayName === 'string' ? displayName.trim().slice(0, MAX_NAME_LEN) : '';
  if (!name) return { ok: false, error: 'Pick a display name first' };
  if (baseUrl !== undefined) g.baseUrl = String(baseUrl || '').trim().slice(0, 200);
  if (!configuredBaseUrl()) return { ok: false, error: 'Add a sync server URL first' };
  if (!g.userId) g.userId = deps.uid() + deps.uid();
  if (!persist()) return {ok:false,error:'Could not save guild identity'};

  try {
    const userId = g.userId;
    const res = await apiRequest('/api/guilds', { userId, name, stats: buildStats() });
    g = guild();
    if (g.userId !== userId) throw new Error('Guild state changed during request');
    if (!/^[A-Z0-9]{6}$/.test(String(res.code || ''))) throw new Error('Server returned invalid guild code');
    g.roomCode = res.code;
    g.memberSecret = typeof res.secret === 'string' ? res.secret.slice(0, 128) : null;
    if (!g.memberSecret) throw new Error('Server did not issue a member secret');
    g.enabled = true;
    g.displayName = name;
    g.snapshot = adoptMembers(res.members);
    g.lastSyncAt = Date.now();
    g.lastError = null;
    if (!persistWithCredentialRecovery(g)) throw new Error('Could not save guild credentials; retry to finish saving');
    if (!Array.isArray(res.members)) throw new Error('Server returned invalid guild data');
    scheduleSync();
    broadcast();
    return { ok: true, roomCode: g.roomCode, pageUrl: guildPageUrl() };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

function joinGuild(args = {}) { return serializeAction(async () => { if (!retryVolatileCredential()) return {ok:false,error:'Could not save your guild credentials; retry before joining another guild'}; if (!(await flushPendingLeave())) return {ok:false,error:'Finish removing your previous guild membership before joining another'}; return joinGuildNow(args); }); }
async function joinGuildNow({ code, displayName, baseUrl } = {}) {
  let g = guild();
  const name = typeof displayName === 'string' ? displayName.trim().slice(0, MAX_NAME_LEN) : '';
  if (!name) return { ok: false, error: 'Pick a display name first' };
  const clean = cleanCode(code);
  if (clean.length !== 6) return { ok: false, error: 'Guild codes are 6 characters' };
  if (baseUrl !== undefined) g.baseUrl = String(baseUrl || '').trim().slice(0, 200);
  if (!configuredBaseUrl()) return { ok: false, error: 'Add a sync server URL first' };
  if (!g.userId) g.userId = deps.uid() + deps.uid();
  if (!persist()) return {ok:false,error:'Could not save guild identity'};

  try {
    const userId = g.userId;
    const res = await apiRequest(`/api/guilds/${encodeURIComponent(clean)}/members`, {
      userId: g.userId,
      name,
      stats: buildStats()
    });
    if (typeof res.secret !== 'string' || !res.secret) {
      throw new Error('Server did not issue a member secret');
    }
    g = guild();
    if (g.userId !== userId) throw new Error('Guild state changed during request');
    g.roomCode = clean;
    g.memberSecret = res.secret.slice(0, 128);
    g.enabled = true;
    g.displayName = name;
    g.snapshot = adoptMembers(res.members);
    g.lastSyncAt = Date.now();
    g.lastError = null;
    if (!persistWithCredentialRecovery(g)) throw new Error('Could not save guild credentials; retry to finish saving');
    if (!Array.isArray(res.members)) throw new Error('Server returned invalid guild data');
    scheduleSync();
    broadcast();
    return { ok: true, roomCode: clean, pageUrl: guildPageUrl() };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

// Spectator mode: view any guild's leaderboard by code — no membership, no name.
async function viewGuild({ code, baseUrl } = {}) {
  const clean = cleanCode(code);
  if (clean.length !== 6) return { ok: false, error: 'Guild codes are 6 characters' };
  const spectatorBase = baseUrl === undefined ? configuredBaseUrl() : validatedBaseUrl(baseUrl);
  if (!spectatorBase) return { ok: false, error: 'Add a secure sync server URL first' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${spectatorBase}/api/guilds/${encodeURIComponent(clean)}`, {
      signal: controller.signal
    });
    const data = await readResponseJson(res);
    if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);
    if (!Array.isArray(data.members)) throw new Error('Server returned invalid guild data');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Server returned invalid data');
    return { ok: true, code: clean, members: adoptMembers(data.members), serverTime: Date.now() };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}

function syncNow(reason = 'auto') { return serializeAction(() => syncNowNow(reason)); }
async function syncNowNow(reason = 'auto') {
  if (volatilePendingLeave || guild().pendingLeave) return {ok:false,reason:'pending-leave'};
  if (!retryVolatileCredential()) return {ok:false,error:'Could not save guild credentials; sync will retry'};
  let g = guild();
  if (!g.enabled || !g.roomCode || !g.userId || !g.memberSecret) return { ok: false };
  const identity = `${g.userId}:${g.roomCode}:${g.memberSecret}:${g.displayName || ''}:${configuredBaseUrl()}`;
  try {
    const res = await apiRequest(`/api/guilds/${encodeURIComponent(g.roomCode)}/members`, {
      userId: g.userId,
      secret: g.memberSecret,
      name: g.displayName || 'Player',
      stats: buildStats()
    });
    if (!Array.isArray(res.members)) throw new Error('Server returned invalid guild data');
    g = guild();
    if (`${g.userId}:${g.roomCode}:${g.memberSecret}:${g.displayName || ''}:${configuredBaseUrl()}` !== identity) return { ok: false, reason: 'state-changed' };
    if (typeof res.secret === 'string' && res.secret) g.memberSecret = res.secret.slice(0, 128);
    g.snapshot = adoptMembers(res.members);
    g.lastSyncAt = Date.now();
    g.lastError = null;
  } catch (e) {
    g = guild();
    if (`${g.userId}:${g.roomCode}:${g.memberSecret}:${g.displayName || ''}:${configuredBaseUrl()}` !== identity) return { ok: false, reason: 'state-changed' };
    if (e.status === 403 && e.payload && e.payload.secret) g.memberSecret = e.payload.secret.slice(0, 128);
    if (e.status === 404 && /guild not found/i.test(e.message)) {
      g.enabled = false; g.roomCode = null; g.memberSecret = null; g.snapshot = [];
    }
    g.lastError = errorMessage(e);
  }
  const saved = g.enabled && g.memberSecret ? persistWithCredentialRecovery(g) : persist();
  if (!saved) g = guild();
  broadcast();
  return { ok: saved && !g.lastError, error: saved ? g.lastError : 'Could not save guild settings' };
}

function leaveGuild() { return serializeAction(() => leaveGuildNow()); }
async function leaveGuildNow() {
  let g = guild();
  let pending = false;
  if (volatileMemberCredential && !retryVolatileCredential()) {
    const credential = volatileMemberCredential;
    volatileMemberCredential = null;
    volatilePendingLeave = { roomCode:credential.roomCode, userId:credential.userId, secret:credential.memberSecret, baseUrl:validatedBaseUrl(credential.baseUrl) };
    pending = !(await flushPendingLeave());
    if (pending) return {ok:true,pendingLeave:true};
    g = guild();
    if (matchesCredentialState(g, credential)) { g.enabled=false;g.roomCode=null;g.memberSecret=null;g.snapshot=[]; }
    return persist() ? {ok:true,pendingLeave:false} : {ok:false,error:'Could not save guild settings'};
  }
  if (volatilePendingLeave) {
    pending = !(await flushPendingLeave());
    if (pending) return {ok:true,pendingLeave:true};
  }
  if (g.enabled && g.roomCode && g.userId && g.memberSecret) {
    const staged = { roomCode: g.roomCode, userId: g.userId, secret: g.memberSecret, baseUrl: configuredBaseUrl() };
    g.pendingLeave = staged;
    if (!persist()) { volatilePendingLeave = staged; g = guild(); }
    pending = !(await flushPendingLeave());
  }
  g = guild();
  if (volatilePendingLeave) g.pendingLeave = volatilePendingLeave;
  g.enabled = false;
  g.roomCode = null;
  g.memberSecret = null;
  g.snapshot = [];
  g.lastSyncAt = 0;
  g.lastError = null;
  if (!persist()) return {ok:false,error:'Could not save guild settings',pendingLeave:pending};
  broadcast();
  return { ok: true, pendingLeave: pending };
}

async function flushPendingLeave() {
  const p = guild().pendingLeave || volatilePendingLeave;
  if (!p || !p.roomCode || !p.userId || !p.secret) return true;
  try {
    const leaveBase = p.baseUrl ? validatedBaseUrl(p.baseUrl) : configuredBaseUrl();
    if (!leaveBase) throw new Error('Pending leave server URL is invalid');
    if (volatilePendingLeave) {
      const current = guild();
      current.pendingLeave = p;
      if (persist()) volatilePendingLeave = null;
    }
    await apiRequest(`/api/guilds/${encodeURIComponent(p.roomCode)}/leave`, { userId: p.userId, secret: p.secret }, leaveBase);
    guild().pendingLeave = null;
    if (!persist()) { volatilePendingLeave = p; guild().pendingLeave = p; return false; }
    volatilePendingLeave = null;
    return true;
  } catch { return false; }
}

function setDisplayName(name) { return serializeAction(() => setDisplayNameNow(name)); }
function setDisplayNameNow(name) {
  if (volatilePendingLeave || guild().pendingLeave) return {ok:false,error:'Finish removing the previous guild membership first'};
  if (!retryVolatileCredential()) return {ok:false,error:'Could not save guild credentials; retry before changing the display name'};
  const g = guild();
  const clean = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LEN) : '';
  if (!clean) return { ok: false, error: 'Name required' };
  g.displayName = clean;
  if (!persist()) return {ok:false,error:'Could not save guild settings'};
  if (g.enabled) return syncNowNow('name-change').then(() => ({ ok: true }));
  return { ok: true };
}

async function readResponseJson(res) {
  let text;
  if (res.body && res.body.getReader) {
    const reader=res.body.getReader();const chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>256_000){await reader.cancel();throw new Error('Server response was too large');}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}text=new TextDecoder().decode(bytes);
  } else text=await res.text();
  let value;
  try { value = JSON.parse(text || '{}'); } catch { throw new Error('Server returned invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Server returned invalid data');
  return value;
}

/* ---------- scheduler ---------- */

function scheduleSync() {
  if (syncTimer) return;
  syncTimer = setInterval(() => { serializeAction(async()=>{ await flushPendingLeave(); return syncNowNow('interval'); }); }, SYNC_INTERVAL_MS);
  if (syncTimer.unref) syncTimer.unref();
  const startup = setTimeout(() => { serializeAction(async()=>{ await flushPendingLeave(); return syncNowNow('startup'); }); }, STARTUP_DELAY_MS);
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
