const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, Notification, nativeTheme, dialog, powerMonitor
} = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const fs = require('fs');
const sync = require('./sync');
const { localDateStr: localDateFromCore, allocateIntervals, sessionSlices } = require('./lib/core-time.cjs');
const { writeJsonAtomically } = require('./lib/core-persistence.cjs');

const DATA_PATH = path.join(app.getPath('userData'), 'study-quest-data.json');
const OVERLAY_CHANNELS = new Set(['data:get', 'todo:add', 'todo:toggle', 'timer:start', 'timer:pause', 'timer:resume', 'timer:stop', 'overlay:hide', 'overlay:resizeTo', 'overlay:resizeEnd', 'overlay:size', 'window:showDashboard']);
function registerHandle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return { ok: false, error: 'Unauthorized IPC frame.' };
  let file;
  try { file = path.resolve(fileURLToPath(frame.url)); } catch { return { ok: false, error: 'Unauthorized IPC frame.' }; }
  const isOverlay = !!overlayWindow && event.sender === overlayWindow.webContents && file === path.resolve(path.join(__dirname, 'renderer', 'overlay.html'));
  const isDashboard = !!mainWindow && event.sender === mainWindow.webContents && file === path.resolve(path.join(__dirname, 'renderer', 'dashboard.html'));
  if ((!isOverlay && !isDashboard) || (isOverlay && !OVERLAY_CHANNELS.has(channel))) return { ok: false, error: 'Unauthorized IPC sender.' };
  return listener(event, ...args);
  });
}
function registerOn(channel, listener) {
  ipcMain.on(channel, (event, ...args) => {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return;
  let file;
  try { file = path.resolve(fileURLToPath(frame.url)); } catch { return; }
  if (overlayWindow && event.sender === overlayWindow.webContents && file === path.resolve(path.join(__dirname, 'renderer', 'overlay.html')) && OVERLAY_CHANNELS.has(channel)) listener(event, ...args);
  });
}
const MIN_SESSION_SECONDS = 5;              // ignore accidental sub-5-second sessions
const MAX_RESTORE_MS = 12 * 60 * 60 * 1000; // never restore more than 12h of timer state
const MAX_SUBJECT_LEN = 60;
const MAX_TODO_LEN = 200;
const MAX_FRIEND_NAME_LEN = 24;
const THEMES = ['dark', 'light', 'legacy'];

// ---------- Small helpers ----------
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Local calendar date (NOT UTC — toISOString would shift the day for evening study)
function localDateStr(d = new Date()) {
  return localDateFromCore(d);
}

function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const value = new Date(y, m - 1, d);
  return value.getFullYear() === y && value.getMonth() === m - 1 && value.getDate() === d;
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return localDateStr(dt);
}

function fmtHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

// ---------- Data layer ----------
function defaultData() {
  return {
    subjects: [],
    sessions: [],   // { id, subject, date (local YYYY-MM-DD), seconds, startedAt, endedAt }
    todos: [],      // { id, text, done, createdAt }
    streak: { current: 0, longest: 0, lastStudyDate: null },
    settings: {
      overlayBounds: null,
      overlayVisible: true,
      dailyGoalMinutes: 120,
      trayHintShown: false,
      theme: 'dark',
      pauseOnSuspend: false,
      pauseOnLock: false,
      guild: {
        enabled: false,
        baseUrl: '',
        roomCode: null,
        userId: null,
        memberSecret: null,
        displayName: '',
        lastSyncAt: 0,
        lastError: null,
        snapshot: []
      }
    },
    activeTimer: null // survives restarts/crashes (restored paused)
  };
}

function sanitizeSession(s) {
  if (!isObj(s)) return null;
  const rawSeconds = Number(s.seconds);
  if (!Number.isFinite(rawSeconds) || rawSeconds > 7 * 24 * 3600) return null;
  const seconds = Math.round(num(rawSeconds, 0, 7 * 24 * 3600, 0));
  if (seconds <= 0) return null;
  const startedAt = num(s.startedAt, 0, Number.MAX_SAFE_INTEGER, Date.now() - seconds * 1000);
  const endedAt = num(s.endedAt, 0, Number.MAX_SAFE_INTEGER, startedAt + seconds * 1000);
  const subject = typeof s.subject === 'string' && s.subject.trim()
    ? s.subject.trim().slice(0, MAX_SUBJECT_LEN)
    : 'General study';
  return {
    id: typeof s.id === 'string' && s.id ? s.id : uid(),
    subject,
    date: isDateStr(s.date) ? s.date : localDateStr(new Date(startedAt)),
    seconds,
    startedAt,
    endedAt
  };
}

function sanitizeTodo(t) {
  if (!isObj(t)) return null;
  const text = typeof t.text === 'string' ? t.text.trim().slice(0, MAX_TODO_LEN) : '';
  if (!text) return null;
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    text,
    done: !!t.done,
    createdAt: num(t.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now())
  };
}

function sanitizeBounds(b) {
  if (!isObj(b)) return null;
  const width = num(b.width, 100, 800, 0);
  const height = num(b.height, 80, 900, 0);
  if (!width || !height) return null;
  return {
    x: Math.round(num(b.x, -20000, 20000, 0)),
    y: Math.round(num(b.y, -20000, 20000, 0)),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function sanitizeActiveTimer(t) {
  if (!isObj(t)) return null;
  const rawAccumulatedMs = Number(t.accumulatedMs);
  const accumulatedMs = Math.round(num(rawAccumulatedMs, 0, MAX_RESTORE_MS, 0));
  if (accumulatedMs <= 0) return null;
  const segments = Array.isArray(t.segments) ? t.segments.map((s) => ({
    startedAt: Math.round(num(s?.startedAt, 0, Number.MAX_SAFE_INTEGER, 0)),
    endedAt: Math.round(num(s?.endedAt, 0, Number.MAX_SAFE_INTEGER, 0))
  })).filter((s) => s.startedAt > 0 && s.endedAt >= s.startedAt) : [];
  const rawSegmentMs = segments.reduce((n, s) => n + s.endedAt - s.startedAt, 0);
  return {
    subject: typeof t.subject === 'string' ? t.subject.trim().slice(0, MAX_SUBJECT_LEN) : '',
    accumulatedMs,
    restoreLimited: !!t.restoreLimited || (Number.isFinite(rawAccumulatedMs) && rawAccumulatedMs > MAX_RESTORE_MS) || rawSegmentMs > MAX_RESTORE_MS,
    segments,
    savedAt: num(t.savedAt, 0, Number.MAX_SAFE_INTEGER, Date.now())
  };
}

function sanitizeGuild(raw) {
  // v1.4.0 stored this under settings.friends — migrate transparently.
  const f = isObj(raw) ? raw : {};
  return {
    enabled: !!f.enabled,
    baseUrl: typeof f.baseUrl === 'string' ? f.baseUrl.trim().slice(0, 200) : '',
    roomCode: typeof f.roomCode === 'string'
      ? f.roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || null
      : null,
    userId: typeof f.userId === 'string' ? f.userId.slice(0, 64) : null,
    memberSecret: typeof f.memberSecret === 'string' ? f.memberSecret.slice(0, 128) : null,
    displayName: typeof f.displayName === 'string' ? f.displayName.slice(0, MAX_FRIEND_NAME_LEN) : '',
    lastSyncAt: num(f.lastSyncAt, 0, Number.MAX_SAFE_INTEGER, 0),
    lastError: typeof f.lastError === 'string' ? f.lastError.slice(0, 120) : null,
    snapshot: Array.isArray(f.snapshot) ? f.snapshot.map(sync.sanitizeMember).filter(Boolean) : [],
    pendingLeave: isObj(f.pendingLeave) ? {
      roomCode: typeof f.pendingLeave.roomCode === 'string' ? f.pendingLeave.roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : '',
      userId: typeof f.pendingLeave.userId === 'string' ? f.pendingLeave.userId.slice(0, 64) : '',
      secret: typeof f.pendingLeave.secret === 'string' ? f.pendingLeave.secret.slice(0, 128) : '',
      baseUrl: typeof f.pendingLeave.baseUrl === 'string' ? f.pendingLeave.baseUrl.trim().slice(0, 200) : ''
    } : null
  };
}

function sanitizeData(raw) {
  const base = defaultData();
  if (!isObj(raw)) return base;

  const settings = isObj(raw.settings) ? raw.settings : {};
  const d = {
    ...base,
    subjects: Array.isArray(raw.subjects)
      ? [...new Set(raw.subjects
          .filter((s) => typeof s === 'string' && s.trim())
          .map((s) => s.trim().slice(0, MAX_SUBJECT_LEN)))]
      : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions.map(sanitizeSession).filter(Boolean) : [],
    todos: Array.isArray(raw.todos) ? raw.todos.map(sanitizeTodo).filter(Boolean) : [],
    streak: { ...base.streak },
    settings: {
      overlayBounds: sanitizeBounds(settings.overlayBounds),
      overlayVisible: settings.overlayVisible !== false,
      dailyGoalMinutes: Math.round(num(settings.dailyGoalMinutes, 0, 720, base.settings.dailyGoalMinutes)),
      trayHintShown: !!settings.trayHintShown,
      theme: THEMES.includes(settings.theme) ? settings.theme : 'dark',
      pauseOnSuspend: settings.pauseOnSuspend === true,
      pauseOnLock: settings.pauseOnLock === true,
      guild: sanitizeGuild(isObj(settings.guild) ? settings.guild : settings.friends)
    },
    activeTimer: sanitizeActiveTimer(raw.activeTimer)
  };
  // The legacy timer stored only duration + save time. Anchor its migrated
  // interval at that save time so it survives pause/restart without deriving
  // the origin later from the eventual stop time.
  if (d.activeTimer && !d.activeTimer.segments.length) {
    const end = d.activeTimer.savedAt;
    d.activeTimer.segments = [{ startedAt: end - d.activeTimer.accumulatedMs, endedAt: end }];
  }
  return d;
}

let dataLoadFailure = null;
let recoveredFromBackup = false;
function loadData() {
  if (!fs.existsSync(DATA_PATH)) return defaultData();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    const loaded = sanitizeData(raw);
    return loaded;
  } catch (e) {
    if (!(e instanceof SyntaxError) && e.code !== 'ENOENT') {
      console.error('Data read failed; preserving the original file:', e);
      dataLoadFailure = 'Existing data could not be read. Import a backup to recover safely.';
      return defaultData();
    }
    console.error('Failed to load data, backing up and starting fresh:', e);
    try { fs.copyFileSync(DATA_PATH, `${DATA_PATH}.corrupt-${Date.now()}`); } catch {}
    try {
      const recovered = sanitizeData(JSON.parse(fs.readFileSync(`${DATA_PATH}.bak`, 'utf-8')));
      console.warn('Recovered Study Quest data from the rolling backup.');
      recoveredFromBackup = true;
      return recovered;
    } catch {}
    return defaultData();
  }
}

let data = loadData();
let durableData = structuredClone(data);

function saveData(value = data, allowRecovery = false) {
  if (dataLoadFailure && !allowRecovery) return { ok: false, error: dataLoadFailure };
  const fsForSave = Object.create(fs);
  fsForSave.copyFileSync = (from, to) => {
    if ((dataLoadFailure && allowRecovery) || recoveredFromBackup) return;
    fs.copyFileSync(from, to);
  };
  const writeResult = writeJsonAtomically(DATA_PATH, value, fsForSave);
  if (!writeResult.ok) {
    console.error('Failed to save data:', writeResult.error);
    if (value === data) Object.assign(data, structuredClone(durableData));
    return writeResult;
  }
  if (value !== data) Object.assign(data, structuredClone(value));
  durableData = structuredClone(data);
  dataLoadFailure = null;
  recoveredFromBackup = false;
  return { ok: true };
}

// ---------- XP / levels ----------
// Every 15 seconds studied = 1 XP (~100 XP per 25 minutes).
function xpForSeconds(totalSeconds) {
  return Math.floor(totalSeconds / 15);
}

function levelFromXp(xp) {
  let level = 1;
  let need = 250;
  let remaining = xp;
  while (remaining >= need) {
    remaining -= need;
    level += 1;
    need = level * 250;
  }
  return { level, into: remaining, need };
}

function totalStudySeconds() {
  return data.sessions.reduce((sum, s) => sum + s.seconds, 0);
}

function currentLevel() {
  return levelFromXp(xpForSeconds(totalStudySeconds())).level;
}

// ---------- Streaks (derived from sessions, so they self-heal) ----------
function computeStreaks() {
  const today = localDateStr();
  const days = [...new Set(data.sessions.map((s) => s.date))]
    .filter(isDateStr)
    .filter((d) => d <= today)
    .sort();

  const set = new Set(days);
  const yesterday = shiftDate(today, -1);

  // A streak stays alive until the end of today; it only breaks after a full missed day.
  let anchor = set.has(today) ? today : (set.has(yesterday) ? yesterday : null);
  let current = 0;
  while (anchor && set.has(anchor)) {
    current += 1;
    anchor = shiftDate(anchor, -1);
  }

  let longest = 0;
  for (const day of days) {
    if (set.has(shiftDate(day, -1))) continue; // not the start of a run
    let run = 1;
    let cursor = day;
    while (set.has(shiftDate(cursor, 1))) {
      run += 1;
      cursor = shiftDate(cursor, 1);
    }
    longest = Math.max(longest, run);
  }

  return {
    current,
    longest,
    lastStudyDate: days.length ? days[days.length - 1] : null,
    studiedToday: set.has(today)
  };
}

function computeStats() {
  const now = new Date();
  const today = localDateStr(now);
  const byDate = new Map();
  const bySubject = new Map();
  let totalSeconds = 0;

  for (const s of data.sessions) {
    totalSeconds += s.seconds;
    byDate.set(s.date, (byDate.get(s.date) || 0) + s.seconds);
  }

  const weekStart = shiftDate(today, -6);
  const prevWeekStart = shiftDate(today, -13);
  let prevWeekSeconds = 0;
  let sessionsToday = 0;
  for (const s of data.sessions) {
    if (s.date === today) sessionsToday += 1;
    if (s.date >= weekStart && s.date <= today) {
      bySubject.set(s.subject, (bySubject.get(s.subject) || 0) + s.seconds);
    }
    if (s.date >= prevWeekStart && s.date < weekStart) {
      prevWeekSeconds += s.seconds;
    }
  }

  const todaySeconds = byDate.get(today) || 0;
  const xp = xpForSeconds(totalSeconds);
  const lvl = levelFromXp(xp);
  const streak = computeStreaks();
  data.streak = {
    current: streak.current,
    longest: streak.longest,
    lastStudyDate: streak.lastStudyDate
  };

  const last7 = [];
  for (let i = 6; i >= 0; i -= 1) {
    const key = shiftDate(today, -i);
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    last7.push({
      date: key,
      label: dt.toLocaleDateString(undefined, { weekday: 'short' }),
      seconds: byDate.get(key) || 0,
      isToday: key === today
    });
  }

  // 53 full Sunday-to-Saturday weeks, ending with the current week. This is
  // intentionally aligned to weeks so the dashboard can draw a GitHub-style
  // contribution grid without doing date math in the renderer.
  const activityStart = shiftDate(today, -(52 * 7 + now.getDay()));
  const activity = [];
  for (let i = 0; i < 53 * 7; i += 1) {
    const key = shiftDate(activityStart, i);
    activity.push({
      date: key,
      seconds: byDate.get(key) || 0,
      future: key > today
    });
  }

  const weekSubjects = [...bySubject.entries()]
    .map(([subject, seconds]) => ({ subject, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
  const topSubjects = weekSubjects.slice(0, 4);
  if (weekSubjects.length > 4) topSubjects.push({ subject: 'Other', seconds: weekSubjects.slice(4).reduce((n, s) => n + s.seconds, 0) });

  const goalMinutes = data.settings.dailyGoalMinutes;
  const weekSeconds = last7.reduce((sum, d) => sum + d.seconds, 0);
  return {
    totalSeconds,
    subjectCount: new Set(data.sessions.filter((s) => s.date >= shiftDate(today, -6) && s.date <= today).map((s) => s.subject)).size,
    todayDate: today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dailySeconds: last7.map(({ date, seconds }) => ({ date, seconds })),
    todaySeconds,
    sessionsToday,
    xp,
    level: lvl.level,
    xpIntoLevel: lvl.into,
    xpNeededForLevel: lvl.need,
    streak: { ...streak },
    last7,
    activity,
    weekSeconds,
    prevWeekSeconds,
    weekDeltaSeconds: weekSeconds - prevWeekSeconds,
    weekSubjects: topSubjects,
    goalMinutes,
    goalSeconds: goalMinutes * 60
  };
}

// ---------- Timer engine (single source of truth in the main process) ----------
const timer = {
  running: false,
  subject: '',
  startedAt: null,    // ms timestamp when the current run segment started
  accumulatedMs: 0,   // ms accumulated before the current running segment
  segments: [],       // completed wall-clock run intervals for date attribution
  restoreLimited: false
};

let tickInterval = null;
let persistInterval = null;

function timerElapsedMs() {
  return timer.segments.reduce((n, s) => n + Math.max(0, s.endedAt - s.startedAt), 0) +
    (timer.running && timer.startedAt ? Math.max(0, Date.now() - timer.startedAt) : 0);
}

function currentIntervals() {
  const intervals = [...timer.segments];
  if (timer.running && timer.startedAt) intervals.push({ startedAt: timer.startedAt, endedAt: Date.now() });
  return intervals;
}

function timerSnapshot() {
  const elapsedMs = timerElapsedMs();
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const today = localDateStr();
  const activeByDate = allocateIntervals(currentIntervals());
  const savedToday = data.sessions.reduce((n, s) => n + (s.date === today ? s.seconds : 0), 0);
  const weekStart = shiftDate(today, -6);
  const savedWeek = data.sessions.reduce((n, s) => n + (s.date >= weekStart && s.date <= today ? s.seconds : 0), 0);
  const savedTotal = data.sessions.reduce((n, s) => n + s.seconds, 0);
  const activeTodaySeconds = activeByDate.get(today) || 0;
  return {
    running: timer.running,
    subject: timer.subject,
    elapsedSeconds,
    // Wall-clock start of the whole session (not just the current run segment)
    startedAt: elapsedMs > 0 ? (timer.segments[0]?.startedAt || timer.startedAt) : null,
    date: timer.segments[0] ? localDateStr(new Date(timer.segments[0].startedAt)) : (timer.startedAt ? localDateStr(new Date(timer.startedAt)) : localDateStr()),
    liveTodaySeconds: savedToday + activeTodaySeconds,
    activeTodaySeconds,
    activeSecondsByDate: [...activeByDate].map(([date, seconds]) => ({ date, seconds })),
    liveWeekSeconds: savedWeek + [...activeByDate].filter(([d]) => d >= weekStart && d <= today).reduce((n, [, s]) => n + s, 0),
    liveTotalSeconds: savedTotal + elapsedSeconds,
    restoreLimited: timer.restoreLimited,
    canSave: elapsedSeconds >= MIN_SESSION_SECONDS
  };
}

// Remember the timer across restarts. On launch it comes back paused.
function persistTimer() {
  const elapsedMs = timerElapsedMs();
  const candidate = structuredClone(data);
  if (timer.subject && !candidate.subjects.includes(timer.subject)) candidate.subjects.push(timer.subject);
  candidate.activeTimer = elapsedMs > 0
    ? {
        subject: timer.subject,
        accumulatedMs: Math.round(elapsedMs),
        segments: currentIntervals().map((s) => ({ startedAt: s.startedAt, endedAt: s.endedAt })),
        restoreLimited: timer.restoreLimited,
        savedAt: Date.now()
      }
    : null;
  return saveData(candidate);
}

function restoreTimer() {
  if (!data.activeTimer) return;
  timer.subject = data.activeTimer.subject || '';
  const sorted = [...(data.activeTimer.segments || [])].sort((a, b) => a.startedAt - b.startedAt);
  const safe = [];
  let total = 0;
  let endSeen = 0;
  for (const raw of sorted) {
    const startedAt = Math.max(raw.startedAt, endSeen);
    const endedAt = Math.min(raw.endedAt, Date.now());
    if (endedAt <= startedAt || total >= MAX_RESTORE_MS) continue;
    const clippedEnd = Math.min(endedAt, startedAt + (MAX_RESTORE_MS - total));
    safe.push({ startedAt, endedAt: clippedEnd });
    total += clippedEnd - startedAt;
    endSeen = clippedEnd;
  }
  timer.segments = safe;
  timer.accumulatedMs = total;
  timer.restoreLimited = !!data.activeTimer.restoreLimited || total < data.activeTimer.accumulatedMs;
}

function sendToAll(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function updateTrayTooltip(elapsedSeconds) {
  if (!tray || tray.isDestroyed()) return;
  if (timer.running) {
    tray.setToolTip(`Study Quest — ${timer.subject || 'Studying'} · ${fmtHMS(elapsedSeconds)}`);
  } else if (elapsedSeconds > 0) {
    tray.setToolTip(`Study Quest — paused at ${fmtHMS(elapsedSeconds)}`);
  } else {
    tray.setToolTip('Study Quest — ready to study');
  }
}

function broadcastTimer() {
  const snapshot = timerSnapshot();
  sendToAll('timer:tick', snapshot);
  updateTrayTooltip(snapshot.elapsedSeconds);
}

function startTickLoop() {
  if (tickInterval) return;
  tickInterval = setInterval(broadcastTimer, 1000);
  // Snapshot the running timer every 15s so a crash/power loss loses at most a few seconds
  if (!persistInterval) persistInterval = setInterval(() => { if (timer.running) persistTimer(); }, 15000);
}
function stopTickLoop() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  if (persistInterval) {
    clearInterval(persistInterval);
    persistInterval = null;
  }
}

// The renderer never needs the member secret — strip it from anything
// broadcast or returned over IPC.
function publicData() {
  const g = data.settings.guild;
  const { memberSecret, pendingLeave, ...safeGuild } = g || {};
  return {
    ...data,
    settings: {
      ...data.settings,
      guild: g ? safeGuild : g
    }
  };
}

function guildPublicState() {
  const g = data.settings.guild;
  const { memberSecret, pendingLeave, ...safeGuild } = g || {};
  return {
    guild: g ? { ...safeGuild, hasPendingLeave: !!pendingLeave } : g,
    defaultSyncUrlSet: !!sync.getDefaultSyncUrl(),
    pageUrl: sync.guildPageUrl()
  };
}

function broadcastData() {
  sendToAll('data:updated', { data: publicData(), stats: computeStats(), timer: timerSnapshot(), recoveryError: dataLoadFailure });
}

// ---------- Windows ----------
let mainWindow = null;
let overlayWindow = null;
let tray = null;

function showDashboard() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createMainWindow() {
  const isMac = process.platform === 'darwin';
  // Fit comfortably on smaller laptop displays instead of forcing 780px always.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const minWidth = Math.min(980, Math.max(420, workArea.width - 40));
  const minHeight = Math.min(680, Math.max(320, workArea.height - 40));
  const width = Math.max(minWidth, Math.min(1120, workArea.width - 40));
  const height = Math.max(minHeight, Math.min(780, workArea.height - 40));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    title: 'Study Quest',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#070912',
    autoHideMenuBar: true,
    show: false,
    // Frameless on Windows/Linux so the app can draw its own title bar.
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false, roundedCorners: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const sendWindowState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);

  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide(); // keep running in the tray instead of quitting
      maybeShowTrayHint();
    }
  });
}

function clampOverlayBounds(saved, width = saved?.width, height = saved?.height) {
  if (!saved) return null;
  const MIN_VISIBLE = 80;
  let best = null;
  let bestArea = 0;
  for (const { workArea } of screen.getAllDisplays()) {
    const interW = Math.min(saved.x + width, workArea.x + workArea.width) - Math.max(saved.x, workArea.x);
    const interH = Math.min(saved.y + height, workArea.y + workArea.height) - Math.max(saved.y, workArea.y);
    if (interW >= MIN_VISIBLE && interH >= MIN_VISIBLE && interW * interH > bestArea) { best = workArea; bestArea = interW * interH; }
  }
  if (!best) return null;
  const w = Math.max(100, Math.min(Math.round(width), best.width));
  const h = Math.max(80, Math.min(Math.round(height), best.height));
  return {
    x: Math.round(Math.min(best.x + best.width - MIN_VISIBLE, Math.max(best.x - w + MIN_VISIBLE, saved.x))),
    y: Math.round(Math.min(best.y + best.height - MIN_VISIBLE, Math.max(best.y - h + MIN_VISIBLE, saved.y))),
    width: w, height: h
  };
}

// Put the floating timer back at its default spot (primary display,
// top-right). Used by the Respawn button in the main window's title bar.
function respawnOverlay() {
  const size = overlayWindow && !overlayWindow.isDestroyed()
    ? overlayWindow.getSize()
    : [300, 400];
  const primary = screen.getPrimaryDisplay().workArea;
  const x = primary.x + primary.width - size[0] - 24;
  const y = primary.y + 24;
  const candidate = structuredClone(data);
  candidate.settings.overlayBounds = { x, y, width: size[0], height: size[1] };
  const saved = saveData(candidate);
  if (!saved.ok) return saved;

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  } else {
    overlayWindow.setPosition(x, y);
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();
  }
  return { ok: true, x, y };
}

function createOverlayWindow() {
  const savedBounds = data.settings.overlayBounds;
  let width = savedBounds?.width || 300;
  let height = savedBounds?.height || 400;
  const saved = clampOverlayBounds(savedBounds, width, height);
  if (saved) { width = saved.width; height = saved.height; }
  const primary = screen.getPrimaryDisplay().workArea;
  const x = saved ? saved.x : primary.x + primary.width - width - 24;
  const y = saved ? saved.y : primary.y + 24;

  overlayWindow = new BrowserWindow({
    width, height, x, y,
    minWidth: 100,
    minHeight: 80,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false, // user resizing goes through the corner grip (transparent windows can't be edge-resized)
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'floating');
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  overlayWindow.once('ready-to-show', () => {
    if (data.settings.overlayVisible !== false) overlayWindow.showInactive();
  });

  const persistBounds = () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      data.settings.overlayBounds = overlayWindow.getBounds();
      saveData();
    }
  };
  overlayWindow.on('moved', persistBounds);
  overlayWindow.on('show', () => {
    if (app.isQuiting) return;
    data.settings.overlayVisible = true;
    saveData();
  });
  overlayWindow.on('hide', () => {
    if (app.isQuiting) return;
    data.settings.overlayVisible = false;
    saveData();
  });
  overlayWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      overlayWindow.hide();
    }
  });
}

function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    return;
  }
  if (overlayWindow.isVisible()) overlayWindow.hide();
  else overlayWindow.showInactive();
}

function maybeShowTrayHint() {
  if (data.settings.trayHintShown) return;
  data.settings.trayHintShown = true;
  saveData();
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: 'Study Quest is still running',
      body: 'It minimized to the system tray. Right-click the tray icon and choose Quit to exit.'
    }).show();
  } catch (e) {
    console.error('Could not show tray hint:', e);
  }
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(trayIcon);
  updateTrayTooltip(0);

  const menu = Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: showDashboard },
    { label: 'Toggle Floating Timer', click: () => toggleOverlay() },
    { type: 'separator' },
    {
      label: 'Quick Start Timer',
      click: () => {
        if (!timer.running) startCurrentTimer(timer.subject || 'General study');
      }
    },
    {
      label: 'Stop & Save Session',
      click: () => stopCurrentSession()
    },
    { type: 'separator' },
    { label: 'Quit Study Quest', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggleOverlay());
}

// ---------- Timer actions ----------
function startCurrentTimer(subjectRaw) {
  if (timer.running) return timerSnapshot();
  const previous = { ...timer, segments: [...timer.segments] };

  if (timer.accumulatedMs > 0) {
    // Resuming a paused session — keep its original subject.
    timer.running = true;
    timer.startedAt = Date.now();
    startTickLoop();
    const persisted = persistTimer();
    if (!persisted.ok) { Object.assign(timer, previous); return { ...timerSnapshot(), ok: false, error: persisted.error }; }
    broadcastTimer();
    return timerSnapshot();
  }

  const subject = typeof subjectRaw === 'string' && subjectRaw.trim()
    ? subjectRaw.trim().slice(0, MAX_SUBJECT_LEN)
    : '';
  timer.subject = subject || timer.subject || 'General study';
  if (timer.accumulatedMs <= 0) timer.segments = [];
  timer.running = true;
  timer.startedAt = Date.now();
  startTickLoop();
  const persisted = persistTimer();
  if (!persisted.ok) { Object.assign(timer, previous); stopTickLoop(); return { ...timerSnapshot(), ok: false, error: persisted.error }; }
  broadcastTimer();
  broadcastData();
  return timerSnapshot();
}

function pauseCurrentTimer() {
  if (!timer.running) return timerSnapshot();
  const previous = { ...timer, segments: [...timer.segments] };
  timer.segments.push({ startedAt: timer.startedAt, endedAt: Date.now() });
  timer.running = false;
  timer.startedAt = null;
  timer.accumulatedMs = timerElapsedMs();
  stopTickLoop();
  const persisted = persistTimer();
  if (!persisted.ok) { Object.assign(timer, previous); startTickLoop(); return { ...timerSnapshot(), ok: false, error: persisted.error }; }
  broadcastTimer();
  return timerSnapshot();
}

function stopCurrentSession() {
  const elapsedMs = timerElapsedMs();
  const seconds = Math.floor(elapsedMs / 1000);
  let saved = false;
  let levelUp = null;
  let goalReached = false;

  if (seconds >= MIN_SESSION_SECONDS) {
    const before = computeStats();
    const intervals = currentIntervals();
    const newSessions = sessionSlices(intervals).map((row) => ({
      id: uid(), subject: timer.subject || 'General study', date: row.date,
      seconds: row.seconds, startedAt: row.startedAt, endedAt: row.endedAt
    }));
    const candidate = structuredClone(data);
    candidate.sessions.push(...newSessions);
    candidate.activeTimer = null;
    const persisted = saveData(candidate);
    if (!persisted.ok) return { saved: false, error: persisted.error, seconds };
    saved = true;

    const after = computeStats();
    if (after.level > before.level) levelUp = after.level;
    goalReached = after.goalSeconds > 0 &&
      before.todaySeconds < after.goalSeconds &&
      after.todaySeconds >= after.goalSeconds;
  }

  if (!saved) {
    const candidate = structuredClone(data);
    candidate.activeTimer = null;
    const persisted = saveData(candidate);
    if (!persisted.ok) return { saved: false, error: persisted.error, seconds };
  }

  timer.running = false;
  timer.startedAt = null;
  timer.accumulatedMs = 0;
  timer.subject = '';
  timer.segments = [];
  timer.restoreLimited = false;
  stopTickLoop();

  broadcastTimer();
  broadcastData();
  sync.syncNow('session-stop'); // fire-and-forget; never blocks the session flow
  if (levelUp) sendToAll('level:up', { level: levelUp });
  if (goalReached) sendToAll('goal:reached', { goalMinutes: data.settings.dailyGoalMinutes });

  return { saved, seconds };
}

// ---------- IPC ----------
registerHandle('data:get', () => ({
  data: publicData(),
  stats: computeStats(),
  timer: timerSnapshot(),
  guild: guildPublicState(),
  recoveryError: dataLoadFailure
}));

registerHandle('todo:add', (_e, textRaw) => {
  const text = typeof textRaw === 'string' ? textRaw.trim().slice(0, MAX_TODO_LEN) : '';
  if (!text) return { ok: false };
  data.todos.unshift({ id: uid(), text, done: false, createdAt: Date.now() });
  const saved = saveData();
  if (!saved.ok) return saved;
  broadcastData();
  return { ok: true };
});

registerHandle('todo:toggle', (_e, id) => {
  const t = data.todos.find((x) => x.id === id);
  if (t) {
    t.done = !t.done;
    const saved = saveData();
    if (!saved.ok) return saved;
    broadcastData();
  }
  return { ok: !!t };
});

registerHandle('todo:delete', (_e, id) => {
  const idx = data.todos.findIndex((x) => x.id === id);
  if (idx === -1) return { deleted: null };
  const [deleted] = data.todos.splice(idx, 1);
  const saved = saveData();
  if (!saved.ok) return saved;
  broadcastData();
  return { deleted };
});

registerHandle('todo:restore', (_e, todo) => {
  const restored = sanitizeTodo(todo);
  if (restored && !data.todos.some((x) => x.id === restored.id)) {
    data.todos.unshift(restored);
    const saved = saveData();
    if (!saved.ok) return saved;
    broadcastData();
  }
  return { ok: !!restored };
});

registerHandle('todo:clearDone', () => {
  data.todos = data.todos.filter((t) => !t.done);
  const saved = saveData();
  if (!saved.ok) return saved;
  broadcastData();
  return { ok: true };
});

registerHandle('timer:start', (_e, subject) => startCurrentTimer(subject));
registerHandle('timer:pause', () => pauseCurrentTimer());
registerHandle('timer:resume', () => startCurrentTimer());
registerHandle('timer:stop', () => stopCurrentSession());

registerHandle('session:delete', (_e, id) => {
  const idx = data.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return { deleted: null };
  const [deleted] = data.sessions.splice(idx, 1);
  const saved = saveData();
  if (!saved.ok) return saved;
  broadcastData();
  return { deleted };
});

registerHandle('session:restore', (_e, session) => {
  const restored = sanitizeSession(session);
  if (restored && !data.sessions.some((s) => s.id === restored.id)) {
    data.sessions.push(restored);
    const saved = saveData();
    if (!saved.ok) return saved;
    broadcastData();
  }
  return { ok: !!restored };
});

registerHandle('goal:set', (_e, minutes) => {
  data.settings.dailyGoalMinutes = Math.round(num(minutes, 0, 720, 0));
  const saved = saveData();
  if (!saved.ok) return saved;
  broadcastData();
  return { goalMinutes: data.settings.dailyGoalMinutes };
});

registerHandle('theme:set', (_e, theme) => {
  if (THEMES.includes(theme) && theme !== data.settings.theme) {
    data.settings.theme = theme;
    const saved = saveData();
    if (!saved.ok) return saved;
    syncNativeTheme();
    broadcastData();
  }
  return { theme: data.settings.theme };
});

registerHandle('setting:set', (_e, name, value) => {
  const allowed = { pauseOnSuspend: (v) => typeof v === 'boolean', pauseOnLock: (v) => typeof v === 'boolean', overlayVisible: (v) => typeof v === 'boolean' };
  if (!Object.hasOwn(allowed, name) || !allowed[name](value)) return { ok: false, error: 'Invalid setting.' };
  const candidate = structuredClone(data);
  candidate.settings[name] = value;
  const result = saveData(candidate);
  if (!result.ok) return result;
  broadcastData();
  return { ok: true, name, value };
});

registerHandle('session:update', (_e, id, changes) => {
  const index = data.sessions.findIndex((s) => s.id === id);
  const allowed = new Set(['subject', 'date', 'seconds']);
  if (index < 0 || !isObj(changes) || !Object.keys(changes).length || Object.keys(changes).some((k) => !allowed.has(k))) return { ok: false, error: 'Session not found or invalid fields.' };
  const candidate = structuredClone(data);
  const existing = candidate.sessions[index];
  const date = changes.date === undefined ? existing.date : changes.date;
  if (!isDateStr(date)) return { ok: false, error: 'Choose a valid calendar date.' };
  const seconds = changes.seconds === undefined ? existing.seconds : Number(changes.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7 * 24 * 3600) return { ok: false, error: 'Enter a valid session duration.' };
  const subject = changes.subject === undefined ? existing.subject : String(changes.subject).trim().slice(0, MAX_SUBJECT_LEN);
  if (!subject) return { ok: false, error: 'Choose a subject.' };
  const oldStart = new Date(existing.startedAt);
  const [year, month, day] = date.split('-').map(Number);
  const startedAt = new Date(year, month - 1, day, oldStart.getHours(), oldStart.getMinutes(), oldStart.getSeconds(), oldStart.getMilliseconds()).getTime();
  const patched = sanitizeSession({ ...existing, subject, date, seconds, startedAt, endedAt: startedAt + seconds * 1000, id });
  if (!patched) return { ok: false, error: 'Invalid session values.' };
  candidate.sessions[index] = patched;
  if (!candidate.subjects.includes(patched.subject)) candidate.subjects.push(patched.subject);
  const result = saveData(candidate);
  if (!result.ok) return result;
  broadcastData();
  return { ok: true, session: patched };
});

registerHandle('data:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, { title: 'Export Study Quest data', defaultPath: 'study-quest-backup.json', filters: [{ name: 'JSON backup', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const destination = path.resolve(result.filePath);
  if (destination === path.resolve(DATA_PATH) || destination === path.resolve(`${DATA_PATH}.bak`)) return { ok: false, error: 'Choose a separate file for the export.' };
  const timerSaved = persistTimer();
  if (!timerSaved.ok) return timerSaved;
  try {
    return writeJsonAtomically(destination, { app: 'Study Quest', schemaVersion: 2, exportedAt: new Date().toISOString(), data });
  } catch (e) { return { ok: false, error: 'Could not export data. Check the selected location and permissions.' }; }
});

registerHandle('data:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Import Study Quest data', properties: ['openFile'], filters: [{ name: 'JSON backup', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
  let imported;
  try {
    const parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    const raw = parsed?.app === 'Study Quest' ? parsed.data : parsed;
    if (!isObj(raw) || (!Array.isArray(raw.sessions) && !Array.isArray(raw.subjects) && !isObj(raw.settings))) throw new Error('shape');
    imported = sanitizeData(raw);
  } catch { return { ok: false, error: 'This file is not a valid Study Quest backup.' }; }
  const saved = saveData(imported, true);
  if (!saved.ok) return saved;
  stopTickLoop();
  Object.assign(timer, { running: false, subject: '', startedAt: null, accumulatedMs: 0, segments: [] });
  restoreTimer();
  broadcastData(); broadcastTimer();
  return { ok: true };
});

registerHandle('guild:get', () => ({ ...guildPublicState(), myUserId: data.settings.guild.userId }));
registerHandle('guild:create', (_e, opts) => {
  const o = isObj(opts) ? opts : {};
  return sync.createGuild({ displayName: o.displayName, baseUrl: o.baseUrl });
});
registerHandle('guild:join', (_e, opts) => {
  const o = isObj(opts) ? opts : {};
  return sync.joinGuild({ code: o.code, displayName: o.displayName, baseUrl: o.baseUrl });
});
registerHandle('guild:view', (_e, opts) => {
  const o = isObj(opts) ? opts : {};
  return sync.viewGuild({ code: o.code, baseUrl: o.baseUrl });
});
registerHandle('guild:leave', () => sync.leaveGuild());
registerHandle('guild:refresh', () => sync.syncNow('manual'));
registerHandle('guild:setName', (_e, name) => sync.setDisplayName(name));

registerHandle('overlay:toggle', () => toggleOverlay());
registerHandle('overlay:hide', () => { if (overlayWindow) overlayWindow.hide(); });
registerHandle('overlay:respawn', () => respawnOverlay());
registerHandle('overlay:size', (_e, preset) => {
  const sizes = { micro: [140, 175], mini: [190, 225], compact: [260, 330], cozy: [340, 440], roomy: [440, 560] };
  const size = Object.hasOwn(sizes, preset) ? sizes[preset] : null;
  if (!size || !overlayWindow || overlayWindow.isDestroyed()) return { ok: false, error: 'Unknown size preset.' };
  const bounds = overlayWindow.getBounds();
  const candidate = structuredClone(data);
  candidate.settings.overlayBounds = { ...bounds, width: size[0], height: size[1] };
  const saved = saveData(candidate);
  if (!saved.ok) return saved;
  overlayWindow.setResizable(true); overlayWindow.setSize(...size); overlayWindow.setResizable(false);
  broadcastData();
  return { ok: true, width: size[0], height: size[1] };
});

// Overlay corner-grip resizing (transparent frameless windows can't be
// user-resized natively, so the renderer drives the size).
let overlayPersistTimer = null;
function persistOverlayBoundsSoon() {
  clearTimeout(overlayPersistTimer);
  overlayPersistTimer = setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      data.settings.overlayBounds = overlayWindow.getBounds();
      saveData();
    }
  }, 250);
}
registerOn('overlay:resizeTo', (_e, w, h) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Windows clamps setSize on non-resizable windows to their initial size
  // (grow-only) — flip resizability for the instant of the programmatic
  // resize so shrinking works too.
  overlayWindow.setResizable(true);
  overlayWindow.setSize(Math.round(num(w, 100, 800, 300)), Math.round(num(h, 80, 900, 400)));
  overlayWindow.setResizable(false);
  persistOverlayBoundsSoon();
});
registerOn('overlay:resizeEnd', () => persistOverlayBoundsSoon());
registerHandle('window:showDashboard', () => showDashboard());
registerHandle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
registerHandle('window:toggleMaximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
registerHandle('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
registerHandle('window:isMaximized', () =>
  !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized())
);
registerHandle('app:quit', () => { app.isQuiting = true; app.quit(); });

// ---------- Lifecycle ----------
function syncNativeTheme() {
  // Native chrome (context menus, tooltips) follows the chosen theme.
  nativeTheme.themeSource = data.settings.theme === 'light' ? 'light' : 'dark';
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showDashboard());

  app.whenReady().then(() => {
    syncNativeTheme();
    restoreTimer();

    sync.initSync({
      getData: () => data,
      saveData,
      computeStats,
      sendToAll,
      uid
    });
    sync.scheduleSync();

    createMainWindow();
    createOverlayWindow();
    createTray();
    broadcastTimer();
    let broadcastDay = localDateStr();
    setInterval(() => {
      const nextDay = localDateStr();
      if (nextDay !== broadcastDay) { broadcastDay = nextDay; broadcastData(); broadcastTimer(); }
    }, 30000);
    const pauseForPower = (enabled) => {
      if (!enabled || !timer.running) return;
      timer.segments.push({ startedAt: timer.startedAt, endedAt: Date.now() });
      timer.running = false; timer.startedAt = null; stopTickLoop();
      timer.accumulatedMs = timerElapsedMs();
      persistTimer(); broadcastTimer(); broadcastData();
    };
    powerMonitor.on('suspend', () => pauseForPower(data.settings.pauseOnSuspend));
    powerMonitor.on('lock-screen', () => pauseForPower(data.settings.pauseOnLock));

    app.on('activate', () => showDashboard());
  });

  app.on('window-all-closed', () => {
    // Stay alive in the tray. Quit only via the tray menu or app:quit.
  });

  app.on('before-quit', () => {
    app.isQuiting = true;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      data.settings.overlayVisible = overlayWindow.isVisible();
    }
    // Fold any running time into the saved timer so reopening restores it (paused).
    if (timer.running) {
      timer.segments.push({ startedAt: timer.startedAt, endedAt: Date.now() });
      timer.startedAt = null;
      timer.running = false;
      timer.accumulatedMs = timerElapsedMs();
    }
    stopTickLoop();
    persistTimer();
  });
}
