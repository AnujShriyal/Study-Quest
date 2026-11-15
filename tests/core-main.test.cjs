'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsReal = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

function createApp(t, { seed, seedRaw, backupSeed, failWrites = false, failReads = false, importPath } = {}) {
  const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), 'study-quest-main-'));
  t.after(() => fsReal.rmSync(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'study-quest-data.json');
  if (seed) fsReal.writeFileSync(dataPath, JSON.stringify(seed));
  if (seedRaw !== undefined) fsReal.writeFileSync(dataPath, seedRaw);
  if (backupSeed) fsReal.writeFileSync(`${dataPath}.bak`, JSON.stringify(backupSeed));
  let now = new Date(2026, 10, 14, 23, 59, 58, 500).getTime();
  const NativeDate = Date;
  class TestDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  TestDate.parse = NativeDate.parse; TestDate.UTC = NativeDate.UTC;
  const handles = new Map(); const listeners = new Map(); const windows = [];
  const appEvents = new EventEmitter();
  const powerMonitor = new EventEmitter();
  const ipcMain = {
    handle: (key, fn) => handles.set(key, fn),
    on: (key, fn) => listeners.set(key, fn)
  };
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); this.destroyed = false; this.visible = false; this.maximized = false; this.size = [300, 400]; this.sizeCalls = [];
      this.webContents = new EventEmitter(); this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.on('will-navigate', () => {});
      this.webContents.mainFrame = { url: '' };
      windows.push(this);
    }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    once(event, cb) { if (event === 'ready-to-show') queueMicrotask(cb); else super.once(event, cb); return this; }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
    show() { this.visible = true; } showInactive() { this.visible = true; } hide() { this.visible = false; }
    focus() {} restore() {} isMinimized() { return false; } minimize() {}
    close() { this.emit('close', { preventDefault() {} }); } isMaximized() { return this.maximized; }
    maximize() { this.maximized = true; } unmaximize() { this.maximized = false; }
    setMenuBarVisibility() {} setAlwaysOnTop() {} setResizable() {} setSize(w, h) { this.size = [w, h]; this.sizeCalls.push([w, h]); } setPosition() {}
    getSize() { return this.size; } getBounds() { return { x: 20, y: 20, width: this.size[0], height: this.size[1] }; }
  }
  BrowserWindow.getAllWindows = () => windows;
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} isDestroyed() { return false; } }
  const electron = {
    app: Object.assign(appEvents, { getPath: () => dir, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit() {} }),
    BrowserWindow, Tray, Menu: { buildFromTemplate: (x) => x }, ipcMain,
    nativeImage: { createFromPath: () => ({}) }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 }, workAreaSize: { width: 1200, height: 800 } }), getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1200, height: 800 } }] },
    Notification: { isSupported: () => false }, nativeTheme: {}, dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => importPath ? ({ canceled: false, filePaths: [importPath] }) : ({ canceled: true, filePaths: [] }) }, powerMonitor
  };
  const fsMock = Object.create(fsReal);
  fsMock.writeFileSync = (...args) => { if (failWrites) throw new Error('disk full'); return fsReal.writeFileSync(...args); };
  fsMock.readFileSync = (file, ...args) => { if (failReads && path.resolve(String(file)) === path.resolve(dataPath)) { const error = new Error('access denied'); error.code = 'EACCES'; throw error; } return fsReal.readFileSync(file, ...args); };
  const sync = {
    sanitizeMember: (m) => m,
    getDefaultSyncUrl: () => '', guildPageUrl: () => '', initSync() {}, scheduleSync() {}, syncNow: () => Promise.resolve(),
    setDisplayName: async () => ({ ok: true }), createGuild: async () => ({}), joinGuild: async () => ({}), viewGuild: async () => ({}), leaveGuild: async () => ({}),
  };
  const req = (id) => id === 'electron' ? electron : id === './sync' ? sync : id === 'fs' ? fsMock : id.startsWith('./lib/') ? require(path.join(__dirname, '..', id.slice(2))) : require(id);
  const source = fsReal.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const context = { require: req, __dirname: path.join(__dirname, '..'), process: { platform: 'win32' }, console, Date: TestDate, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, structuredClone };
  vm.runInNewContext(source, context, { filename: 'main.js' });
  return {
    handles, listeners, powerMonitor, windows,
    dashboard: () => windows.find((w) => w.webContents.mainFrame.url.endsWith('/dashboard.html')),
    overlay: () => windows.find((w) => w.webContents.mainFrame.url.endsWith('/overlay.html')),
    invoke: async (channel, sender, ...args) => {
      const webContents = sender.webContents || sender;
      return handles.get(channel)({ sender: webContents, senderFrame: webContents.mainFrame }, ...args);
    },
    setNow: (v) => { now = v; }, getNow: () => now, dataPath
  };
}

test('main timer survives pause/restart and records finite midnight slices totaling exact seconds', async (t) => {
  const app = createApp(t);
  await new Promise((resolve) => setImmediate(resolve));
  const win = app.dashboard();
  const started = await app.invoke('timer:start', win, 'Math');
  assert.equal(started.running, true);
  app.setNow(app.getNow() + 2500);
  await app.invoke('timer:pause', win);
  app.setNow(app.getNow() + 3000);
  await app.invoke('timer:resume', win);
  app.setNow(app.getNow() + 4000);
  const stopped = await app.invoke('timer:stop', win);
  assert.equal(stopped.saved, true);
  const loaded = await app.invoke('data:get', win);
  assert.equal(loaded.data.sessions.reduce((n, s) => n + s.seconds, 0), stopped.seconds);
  assert.equal(loaded.data.sessions.length, 2);
  assert.ok(loaded.data.sessions.every((s) => Number.isFinite(s.startedAt) && Number.isFinite(s.endedAt) && s.endedAt > s.startedAt));
});

test('failed timer persistence returns a structured error and leaves timer empty', async (t) => {
  const app = createApp(t, { failWrites: true });
  await new Promise((resolve) => setImmediate(resolve));
  const result = await app.invoke('timer:start', app.dashboard(), 'Math');
  assert.equal(result.ok, false);
  assert.match(result.error, /save/i);
  const data = await app.invoke('data:get', app.dashboard());
  assert.equal(data.timer.elapsedSeconds, 0);
});

test('sender validation allows the real overlay and rejects a foreign renderer', async (t) => {
  const app = createApp(t);
  await new Promise((resolve) => setImmediate(resolve));
  const overlayResult = await app.invoke('data:get', app.overlay());
  assert.ok(overlayResult.data);
  const foreign = { webContents: { mainFrame: { url: 'file:///tmp/attacker/renderer/dashboard.html' } } };
  const denied = await app.invoke('data:get', foreign);
  assert.equal(denied.ok, false);
});

test('setting and overlay preset reject inherited object names; valid preset returns its dimensions', async (t) => {
  const app = createApp(t);
  await new Promise((resolve) => setImmediate(resolve));
  const dash = app.dashboard();
  const overlay = app.overlay();
  const badSetting = await app.invoke('setting:set', dash, 'toString', true);
  assert.equal(badSetting.ok, false);
  const badPreset = await app.invoke('overlay:size', overlay, 'toString');
  assert.equal(badPreset.ok, false);
  const preset = await app.invoke('overlay:size', overlay, 'micro');
  assert.deepEqual({ ok: preset.ok, width: preset.width, height: preset.height }, { ok: true, width: 140, height: 175 });
  assert.deepEqual(overlay.sizeCalls.at(-1), [140, 175]);
});

test('dashboard and overlay block all renderer-triggered navigation', async (t) => {
  const app = createApp(t);
  await new Promise((resolve) => setImmediate(resolve));
  for (const win of [app.dashboard(), app.overlay()]) {
    let prevented = false;
    win.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'file:///tmp/attacker.html');
    assert.equal(prevented, true);
  }
});

test('public data strips both guild secrets', async (t) => {
  const app = createApp(t, { seed: { settings: { guild: { memberSecret: 'member-secret', pendingLeave: { secret: 'pending-secret' } } } } });
  await new Promise((resolve) => setImmediate(resolve));
  const result = await app.invoke('data:get', app.dashboard());
  const text = JSON.stringify(result);
  assert.equal(Object.hasOwn(result.data.settings.guild, 'memberSecret'), false);
  assert.equal(Object.hasOwn(result.data.settings.guild, 'pendingLeave'), false);
  assert.equal(text.includes('member-secret'), false);
  assert.equal(text.includes('pending-secret'), false);
});

test('25 hour sessions round trip without 24 hour truncation', async (t) => {
  const app = createApp(t);
  await new Promise((resolve) => setImmediate(resolve));
  const win = app.dashboard();
  const session = { id: 'long', subject: 'Math', date: '2026-11-14', seconds: 25 * 3600, startedAt: 1794700000000, endedAt: 1794790000000 };
  const restored = await app.invoke('session:restore', win, session);
  assert.equal(restored.ok, true);
  assert.equal((await app.invoke('data:get', win)).data.sessions[0].seconds, 25 * 3600);
});

test('crash restore caps a long timer at 12 hours and marks the snapshot', async (t) => {
  const at = new Date(2026, 10, 15, 12).getTime();
  const app = createApp(t, { seed: { activeTimer: {
    subject: 'Physics', accumulatedMs: 25 * 3600 * 1000, savedAt: at,
    segments: [{ startedAt: at - 25 * 3600 * 1000, endedAt: at }]
  } } });
  await new Promise((resolve) => setImmediate(resolve));
  const timer = (await app.invoke('data:get', app.dashboard())).timer;
  assert.equal(timer.elapsedSeconds, 12 * 3600);
  assert.equal(timer.restoreLimited, true);
});

test('corrupt primary recovers from the rolling backup', async (t) => {
  const app = createApp(t, { seedRaw: '{broken json', backupSeed: { sessions: [
    { id: 'safe', subject: 'History', date: '2026-11-14', seconds: 12, startedAt: 1794700000000, endedAt: 1794700012000 }
  ] } });
  await new Promise((resolve) => setImmediate(resolve));
  const data = await app.invoke('data:get', app.dashboard());
  assert.equal(data.data.sessions[0].id, 'safe');
  assert.equal(data.recoveryError, null);
  await app.invoke('goal:set', app.dashboard(), 90);
  assert.equal(JSON.parse(fsReal.readFileSync(`${app.dataPath}.bak`, 'utf8')).sessions[0].id, 'safe');
});

test('non-corruption read failures block writes and expose a recovery error', async (t) => {
  const app = createApp(t, { seed: { subjects: ['Preserve me'] }, failReads: true });
  await new Promise((resolve) => setImmediate(resolve));
  const before = fsReal.readFileSync(app.dataPath, 'utf8');
  const initial = await app.invoke('data:get', app.dashboard());
  assert.match(initial.recoveryError, /could not be read/i);
  const result = await app.invoke('goal:set', app.dashboard(), 90);
  assert.equal(result.ok, false);
  assert.equal(fsReal.readFileSync(app.dataPath, 'utf8'), before);
});

test('import replaces the in-memory timer and restores the imported paused timer', async (t) => {
  const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), 'study-quest-import-'));
  t.after(() => fsReal.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'backup.json');
  const app = createApp(t, { importPath: input });
  await new Promise((resolve) => setImmediate(resolve));
  const win = app.dashboard();
  await app.invoke('timer:start', win, 'Old timer');
  app.setNow(app.getNow() + 10000);
  fsReal.writeFileSync(input, JSON.stringify({ app: 'Study Quest', schemaVersion: 2, data: {
    sessions: [{ id: 'imported', subject: 'Biology', date: '2026-11-14', seconds: 60, startedAt: app.getNow() - 60000, endedAt: app.getNow() }],
    activeTimer: { subject: 'Imported timer', accumulatedMs: 3000, savedAt: app.getNow(), segments: [{ startedAt: app.getNow() - 3000, endedAt: app.getNow() }] }
  } }));
  assert.equal((await app.invoke('data:import', win)).ok, true);
  const data = await app.invoke('data:get', win);
  assert.equal(data.timer.running, false);
  assert.equal(data.timer.subject, 'Imported timer');
  assert.equal(data.timer.elapsedSeconds, 3);
  assert.equal(data.timer.liveTotalSeconds, 63);
});

test('suspend and lock pause policies are independent', async (t) => {
  const app = createApp(t);
  await new Promise((resolve) => setImmediate(resolve));
  const win = app.dashboard();
  await app.invoke('setting:set', win, 'pauseOnSuspend', true);
  await app.invoke('setting:set', win, 'pauseOnLock', false);
  await app.invoke('timer:start', win, 'Math');
  app.setNow(app.getNow() + 1000);
  app.powerMonitor.emit('lock-screen');
  assert.equal((await app.invoke('data:get', win)).timer.running, true);
  app.powerMonitor.emit('suspend');
  assert.equal((await app.invoke('data:get', win)).timer.running, false);
});
