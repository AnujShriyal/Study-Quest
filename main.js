const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, Notification, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const sync = require('./sync');

const DATA_PATH = path.join(app.getPath('userData'), 'study-quest-data.json');
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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
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
      friends: {
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
  const seconds = Math.round(num(s.seconds, 0, 24 * 3600, 0));
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
  const width = num(b.width, 100, 5000, 0);
  const height = num(b.height, 100, 5000, 0);
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
  const accumulatedMs = Math.round(num(t.accumulatedMs, 0, MAX_RESTORE_MS, 0));
  if (accumulatedMs <= 0) return null;
  return {
    subject: typeof t.subject === 'string' ? t.subject.trim().slice(0, MAX_SUBJECT_LEN) : '',
    accumulatedMs,
    savedAt: num(t.savedAt, 0, Number.MAX_SAFE_INTEGER, Date.now())
  };
}

function sanitizeFriends(raw) {
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
    snapshot: Array.isArray(f.snapshot) ? f.snapshot.map(sync.sanitizeMember).filter(Boolean) : []
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
      friends: sanitizeFriends(settings.friends)
    },
    activeTimer: sanitizeActiveTimer(raw.activeTimer)
  };
  return d;
}

function loadData() {
  if (!fs.existsSync(DATA_PATH)) return defaultData();
  try {
    return sanitizeData(JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')));
  } catch (e) {
    console.error('Failed to load data, backing up and starting fresh:', e);
    try { fs.copyFileSync(DATA_PATH, `${DATA_PATH}.corrupt-${Date.now()}`); } catch {}
    return defaultData();
  }
}

let data = loadData();

function saveData() {
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    const tmp = `${DATA_PATH}.tmp`;
    // Write-then-rename so a crash mid-write can't corrupt the save file
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_PATH);
  } catch (e) {
    console.error('Failed to save data:', e);
  }
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
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 4);

  const goalMinutes = data.settings.dailyGoalMinutes;
  const weekSeconds = last7.reduce((sum, d) => sum + d.seconds, 0);
  return {
    totalSeconds,
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
    weekSubjects,
    goalMinutes,
    goalSeconds: goalMinutes * 60
  };
}

// ---------- Timer engine (single source of truth in the main process) ----------
const timer = {
  running: false,
  subject: '',
  startedAt: null,    // ms timestamp when the current run segment started
  accumulatedMs: 0    // ms accumulated before the current running segment
};

let tickInterval = null;
let persistInterval = null;

function timerElapsedMs() {
  if (timer.running && timer.startedAt) {
    return timer.accumulatedMs + (Date.now() - timer.startedAt);
  }
  return timer.accumulatedMs;
}

function timerSnapshot() {
  const elapsedMs = timerElapsedMs();
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  return {
    running: timer.running,
    subject: timer.subject,
    elapsedSeconds,
    // Wall-clock start of the whole session (not just the current run segment)
    startedAt: elapsedMs > 0 ? Date.now() - elapsedMs : null,
    canSave: elapsedSeconds >= MIN_SESSION_SECONDS
  };
}

// Remember the timer across restarts. On launch it comes back paused.
function persistTimer() {
  const elapsedMs = timerElapsedMs();
  data.activeTimer = elapsedMs > 0
    ? {
        subject: timer.subject,
        accumulatedMs: Math.round(elapsedMs),
        savedAt: Date.now()
      }
    : null;
  saveData();
}

function restoreTimer() {
  if (!data.activeTimer) return;
  timer.subject = data.activeTimer.subject || '';
  timer.accumulatedMs = Math.min(data.activeTimer.accumulatedMs, MAX_RESTORE_MS);
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
  const f = data.settings.friends;
  return {
    ...data,
    settings: {
      ...data.settings,
      friends: f ? { ...f, memberSecret: undefined } : f
    }
  };
}

function friendsPublicState() {
  const f = data.settings.friends;
  return {
    friends: f ? { ...f, memberSecret: undefined } : f,
    defaultSyncUrlSet: !!sync.getDefaultSyncUrl()
  };
}

function broadcastData() {
  sendToAll('data:updated', { data: publicData(), stats: computeStats() });
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
  const width = Math.max(980, Math.min(1120, workArea.width - 60));
  const height = Math.max(680, Math.min(780, workArea.height - 50));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 980,
    minHeight: 680,
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

function clampOverlayBounds(saved, width, height) {
  if (!saved) return null;
  const onSomeDisplay = screen.getAllDisplays().some(({ workArea }) =>
    saved.x < workArea.x + workArea.width &&
    saved.x + width > workArea.x &&
    saved.y < workArea.y + workArea.height &&
    saved.y + height > workArea.y
  );
  return onSomeDisplay ? saved : null;
}

function createOverlayWindow() {
  const width = 300;
  const height = 400;
  const saved = clampOverlayBounds(data.settings.overlayBounds, width, height);
  const primary = screen.getPrimaryDisplay().workArea;
  const x = saved ? saved.x : primary.x + primary.width - width - 24;
  const y = saved ? saved.y : primary.y + 24;

  overlayWindow = new BrowserWindow({
    width, height, x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'floating');
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
        if (timer.running) return;
        if (!timer.accumulatedMs) {
          timer.subject = timer.subject || 'General study';
          if (!data.subjects.includes(timer.subject)) {
            data.subjects.push(timer.subject);
            saveData();
          }
        }
        timer.running = true;
        timer.startedAt = Date.now();
        startTickLoop();
        broadcastTimer();
        persistTimer();
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

  if (timer.accumulatedMs > 0) {
    // Resuming a paused session — keep its original subject.
    timer.running = true;
    timer.startedAt = Date.now();
    startTickLoop();
    broadcastTimer();
    persistTimer();
    return timerSnapshot();
  }

  const subject = typeof subjectRaw === 'string' && subjectRaw.trim()
    ? subjectRaw.trim().slice(0, MAX_SUBJECT_LEN)
    : '';
  timer.subject = subject || timer.subject || 'General study';
  if (!data.subjects.includes(timer.subject)) {
    data.subjects.push(timer.subject);
    saveData();
  }
  timer.running = true;
  timer.startedAt = Date.now();
  startTickLoop();
  broadcastTimer();
  persistTimer();
  return timerSnapshot();
}

function pauseCurrentTimer() {
  if (!timer.running) return timerSnapshot();
  timer.accumulatedMs += Date.now() - timer.startedAt;
  timer.running = false;
  timer.startedAt = null;
  stopTickLoop();
  broadcastTimer();
  persistTimer();
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
    const endedAt = Date.now();
    const startedAt = endedAt - elapsedMs;
    data.sessions.push({
      id: uid(),
      subject: timer.subject || 'General study',
      date: localDateStr(new Date(startedAt)),
      seconds,
      startedAt,
      endedAt
    });
    saved = true;

    const after = computeStats();
    if (after.level > before.level) levelUp = after.level;
    goalReached = after.goalSeconds > 0 &&
      before.todaySeconds < after.goalSeconds &&
      after.todaySeconds >= after.goalSeconds;
  }

  timer.running = false;
  timer.startedAt = null;
  timer.accumulatedMs = 0;
  timer.subject = '';
  stopTickLoop();

  persistTimer();
  broadcastTimer();
  broadcastData();
  sync.syncNow('session-stop'); // fire-and-forget; never blocks the session flow
  if (levelUp) sendToAll('level:up', { level: levelUp });
  if (goalReached) sendToAll('goal:reached', { goalMinutes: data.settings.dailyGoalMinutes });

  return { saved, seconds };
}

// ---------- IPC ----------
ipcMain.handle('data:get', () => ({
  data: publicData(),
  stats: computeStats(),
  timer: timerSnapshot(),
  friends: friendsPublicState()
}));

ipcMain.handle('todo:add', (_e, textRaw) => {
  const text = typeof textRaw === 'string' ? textRaw.trim().slice(0, MAX_TODO_LEN) : '';
  if (!text) return { ok: false };
  data.todos.unshift({ id: uid(), text, done: false, createdAt: Date.now() });
  saveData();
  broadcastData();
  return { ok: true };
});

ipcMain.handle('todo:toggle', (_e, id) => {
  const t = data.todos.find((x) => x.id === id);
  if (t) {
    t.done = !t.done;
    saveData();
    broadcastData();
  }
  return { ok: !!t };
});

ipcMain.handle('todo:delete', (_e, id) => {
  const idx = data.todos.findIndex((x) => x.id === id);
  if (idx === -1) return { deleted: null };
  const [deleted] = data.todos.splice(idx, 1);
  saveData();
  broadcastData();
  return { deleted };
});

ipcMain.handle('todo:restore', (_e, todo) => {
  const restored = sanitizeTodo(todo);
  if (restored && !data.todos.some((x) => x.id === restored.id)) {
    data.todos.unshift(restored);
    saveData();
    broadcastData();
  }
  return { ok: !!restored };
});

ipcMain.handle('todo:clearDone', () => {
  data.todos = data.todos.filter((t) => !t.done);
  saveData();
  broadcastData();
  return { ok: true };
});

ipcMain.handle('timer:start', (_e, subject) => startCurrentTimer(subject));
ipcMain.handle('timer:pause', () => pauseCurrentTimer());
ipcMain.handle('timer:resume', () => startCurrentTimer());
ipcMain.handle('timer:stop', () => stopCurrentSession());

ipcMain.handle('session:delete', (_e, id) => {
  const idx = data.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return { deleted: null };
  const [deleted] = data.sessions.splice(idx, 1);
  saveData();
  broadcastData();
  return { deleted };
});

ipcMain.handle('session:restore', (_e, session) => {
  const restored = sanitizeSession(session);
  if (restored && !data.sessions.some((s) => s.id === restored.id)) {
    data.sessions.push(restored);
    saveData();
    broadcastData();
  }
  return { ok: !!restored };
});

ipcMain.handle('goal:set', (_e, minutes) => {
  data.settings.dailyGoalMinutes = Math.round(num(minutes, 0, 720, 0));
  saveData();
  broadcastData();
  return { goalMinutes: data.settings.dailyGoalMinutes };
});

ipcMain.handle('theme:set', (_e, theme) => {
  if (THEMES.includes(theme) && theme !== data.settings.theme) {
    data.settings.theme = theme;
    saveData();
    syncNativeTheme();
    broadcastData();
  }
  return { theme: data.settings.theme };
});

ipcMain.handle('friends:get', () => ({ ...friendsPublicState(), myUserId: data.settings.friends.userId }));
ipcMain.handle('friends:join', (_e, opts) => {
  const o = isObj(opts) ? opts : {};
  if (o.mode === 'create') return sync.createRoom({ displayName: o.displayName, baseUrl: o.baseUrl });
  return sync.joinRoom({ code: o.code, displayName: o.displayName, baseUrl: o.baseUrl });
});
ipcMain.handle('friends:leave', () => sync.leaveRoom());
ipcMain.handle('friends:refresh', () => sync.syncNow('manual'));
ipcMain.handle('friends:setName', (_e, name) => sync.setName(name));

ipcMain.handle('overlay:toggle', () => toggleOverlay());
ipcMain.handle('overlay:hide', () => { if (overlayWindow) overlayWindow.hide(); });
ipcMain.handle('window:showDashboard', () => showDashboard());
ipcMain.handle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
ipcMain.handle('window:isMaximized', () =>
  !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized())
);
ipcMain.handle('app:quit', () => { app.isQuiting = true; app.quit(); });

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
      timer.accumulatedMs = timerElapsedMs();
      timer.startedAt = Date.now();
      timer.running = false;
    }
    stopTickLoop();
    persistTimer();
  });
}
