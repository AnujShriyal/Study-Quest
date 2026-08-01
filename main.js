const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_PATH = path.join(app.getPath('userData'), 'study-quest-data.json');

// ---------- Data layer ----------
function defaultData() {
  return {
    subjects: [],
    sessions: [],   // { id, subject, date (YYYY-MM-DD), seconds, startedAt, endedAt }
    todos: [],      // { id, text, done, createdAt }
    streak: { current: 0, longest: 0, lastStudyDate: null },
    settings: { overlayBounds: null }
  };
}

function loadData() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const raw = fs.readFileSync(DATA_PATH, 'utf-8');
      return { ...defaultData(), ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('Failed to load data, starting fresh:', e);
  }
  return defaultData();
}

let data = loadData();

function saveData() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save data:', e);
  }
}

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// XP / Level model: every 25 minutes (1500s) of studying = 100 XP. Level thresholds grow.
function xpForSeconds(totalSeconds) {
  return Math.floor(totalSeconds / 15); // ~100xp per 25 min
}
function levelFromXp(xp) {
  // level n requires n*250 cumulative xp (simple ramp)
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

function computeStats() {
  const totalSeconds = data.sessions.reduce((s, x) => s + x.seconds, 0);
  const today = todayStr();
  const todaySeconds = data.sessions
    .filter((x) => x.date === today)
    .reduce((s, x) => s + x.seconds, 0);
  const xp = xpForSeconds(totalSeconds);
  const lvl = levelFromXp(xp);
  return {
    totalSeconds,
    todaySeconds,
    xp,
    level: lvl.level,
    xpIntoLevel: lvl.into,
    xpNeededForLevel: lvl.need,
    streak: data.streak
  };
}

function updateStreakOnSessionSave(dateStr) {
  const s = data.streak;
  if (s.lastStudyDate === dateStr) return; // already counted today
  const prev = s.lastStudyDate ? new Date(s.lastStudyDate) : null;
  const cur = new Date(dateStr);
  if (prev) {
    const diffDays = Math.round((cur - prev) / 86400000);
    if (diffDays === 1) {
      s.current += 1;
    } else if (diffDays > 1) {
      s.current = 1;
    } // diffDays === 0 handled above; negative (backfilled past date) ignored for streak math
  } else {
    s.current = 1;
  }
  s.lastStudyDate = dateStr;
  s.longest = Math.max(s.longest, s.current);
}

// ---------- Timer engine (lives in main process, single source of truth) ----------
const timer = {
  running: false,
  subject: '',
  startedAt: null,     // ms timestamp when current run segment started
  accumulatedMs: 0,     // ms accumulated before the current running segment
};

let tickInterval = null;

function timerElapsedMs() {
  if (timer.running && timer.startedAt) {
    return timer.accumulatedMs + (Date.now() - timer.startedAt);
  }
  return timer.accumulatedMs;
}

function broadcastTimer() {
  const payload = {
    running: timer.running,
    subject: timer.subject,
    elapsedSeconds: Math.floor(timerElapsedMs() / 1000)
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('timer:tick', payload);
  }
}

function startTickLoop() {
  if (tickInterval) return;
  tickInterval = setInterval(broadcastTimer, 1000);
}
function stopTickLoop() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function broadcastData() {
  const payload = { data, stats: computeStats() };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('data:updated', payload);
  }
}

// ---------- Windows ----------
let mainWindow = null;
let overlayWindow = null;
let tray = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 560,
    title: 'Study Quest',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#12142b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));

  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide(); // minimize to tray instead of quitting
    }
  });
}

function createOverlayWindow() {
  const savedBounds = data.settings.overlayBounds;
  const primary = screen.getPrimaryDisplay().workAreaSize;
  const width = 300;
  const height = 400;
  const x = savedBounds ? savedBounds.x : primary.width - width - 24;
  const y = savedBounds ? savedBounds.y : 24;

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
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  const persistBounds = () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      data.settings.overlayBounds = overlayWindow.getBounds();
      saveData();
    }
  };
  overlayWindow.on('moved', persistBounds);
  overlayWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      overlayWindow.hide();
    }
  });
}

function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
  }
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(trayIcon);
  tray.setToolTip('Study Quest');

  const menu = Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Toggle Floating Timer', click: () => toggleOverlay() },
    { type: 'separator' },
    {
      label: 'Quick Start Timer', click: () => {
        if (!timer.running) {
          timer.running = true;
          timer.startedAt = Date.now();
          startTickLoop();
          broadcastTimer();
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit Study Quest', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggleOverlay());
}

// ---------- IPC ----------
ipcMain.handle('data:get', () => ({ data, stats: computeStats(), timer: {
  running: timer.running, subject: timer.subject, elapsedSeconds: Math.floor(timerElapsedMs() / 1000)
} }));

ipcMain.handle('todo:add', (_e, text) => {
  data.todos.unshift({ id: uid(), text, done: false, createdAt: Date.now() });
  saveData();
  broadcastData();
  return data.todos;
});

ipcMain.handle('todo:toggle', (_e, id) => {
  const t = data.todos.find((x) => x.id === id);
  if (t) t.done = !t.done;
  saveData();
  broadcastData();
  return data.todos;
});

ipcMain.handle('todo:delete', (_e, id) => {
  data.todos = data.todos.filter((x) => x.id !== id);
  saveData();
  broadcastData();
  return data.todos;
});

ipcMain.handle('timer:start', (_e, subject) => {
  if (!timer.running) {
    timer.subject = subject || timer.subject || 'General study';
    if (!data.subjects.includes(timer.subject)) {
      data.subjects.push(timer.subject);
      saveData();
    }
    timer.running = true;
    timer.startedAt = Date.now();
    startTickLoop();
    broadcastTimer();
  }
  return true;
});

ipcMain.handle('timer:pause', () => {
  if (timer.running) {
    timer.accumulatedMs += Date.now() - timer.startedAt;
    timer.running = false;
    timer.startedAt = null;
    stopTickLoop();
    broadcastTimer();
  }
  return true;
});

ipcMain.handle('timer:resume', () => {
  if (!timer.running && timer.accumulatedMs > 0) {
    timer.running = true;
    timer.startedAt = Date.now();
    startTickLoop();
    broadcastTimer();
  }
  return true;
});

ipcMain.handle('timer:stop', () => {
  const elapsedMs = timerElapsedMs();
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds >= 5) { // ignore accidental sub-5-second sessions
    const date = todayStr();
    data.sessions.push({
      id: uid(),
      subject: timer.subject || 'General study',
      date,
      seconds,
      startedAt: Date.now() - elapsedMs,
      endedAt: Date.now()
    });
    updateStreakOnSessionSave(date);
    saveData();
  }
  timer.running = false;
  timer.startedAt = null;
  timer.accumulatedMs = 0;
  timer.subject = '';
  stopTickLoop();
  broadcastTimer();
  broadcastData();
  return { savedSeconds: seconds };
});

ipcMain.handle('overlay:toggle', () => toggleOverlay());
ipcMain.handle('overlay:hide', () => { if (overlayWindow) overlayWindow.hide(); });
ipcMain.handle('window:showDashboard', () => { mainWindow.show(); mainWindow.focus(); });
ipcMain.handle('app:quit', () => { app.isQuiting = true; app.quit(); });

// ---------- Lifecycle ----------
app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  // Keep app alive in tray on Windows/Linux; only quit fully via tray "Quit"
  if (process.platform === 'darwin') return;
});

app.on('before-quit', () => {
  app.isQuiting = true;
});
