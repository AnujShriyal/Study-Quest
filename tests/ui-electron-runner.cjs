const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.setPath('userData', process.env.STUDY_QUEST_SMOKE_PROFILE);
BrowserWindow.prototype.show = function () { return this; };
BrowserWindow.prototype.showInactive = function () { return this; };
const profileData = path.join(process.env.STUDY_QUEST_SMOKE_PROFILE, 'study-quest-data.json');
fs.mkdirSync(path.dirname(profileData), { recursive: true });
const now = Date.now();
const localDate = new Date().toLocaleDateString('en-CA');
const seededSessions = Array.from({ length: 205 }, (_, index) => ({
  id: `smoke-${index}`, subject: index === 204 ? 'Needle subject' : 'Algebra', date: localDate,
  seconds: 120 + index, startedAt: now - index * 60000, endedAt: now - index * 60000 + 120000
}));
fs.writeFileSync(profileData, JSON.stringify({
  subjects: ['Algebra', 'Needle subject'], sessions: seededSessions, todos: [],
  streak: { current: 0, longest: 0, lastStudyDate: null },
  settings: { overlayBounds: { x: 10, y: 10, width: 100, height: 80 }, overlayVisible: false, dailyGoalMinutes: 120, trayHintShown: true, theme: 'dark', pauseOnSuspend: false, pauseOnLock: false, guild: { enabled: false, baseUrl: '', roomCode: null, userId: null, memberSecret: null, displayName: '', lastSyncAt: 0, lastError: null, snapshot: [] } }, activeTimer: null
}, null, 2));
require('../main.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function captureTo(win, file) {
  await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await win.webContents.capturePage(); // Flush Chromium's hidden-window compositor.
  const image = await win.webContents.capturePage();
  await fs.promises.writeFile(file, image.toPNG());
}
async function waitFor(predicate, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await wait(100);
  }
  throw new Error('Timed out waiting for Study Quest windows');
}

app.whenReady().then(async () => {
  try {
    const windows = await waitFor(() => {
      const all = BrowserWindow.getAllWindows();
      const dashboard = all.find((win) => win.webContents.getURL().endsWith('/renderer/dashboard.html'));
      const overlay = all.find((win) => win.webContents.getURL().endsWith('/renderer/overlay.html'));
      return dashboard && overlay ? { dashboard, overlay } : null;
    });
    const { dashboard, overlay } = windows;
    for (const win of [dashboard, overlay]) {
      win.webContents.setBackgroundThrottling(false);
      win.webContents.on('console-message', (_event, level, message, line, source) => console.error(`[renderer ${win.webContents.getURL()}] ${level} ${source}:${line} ${message}`));
      win.webContents.on('render-process-gone', (_event, details) => console.error(`[renderer-gone] ${JSON.stringify(details)}`));
    }
    dashboard.hide(); overlay.hide();
    await wait(1200);

    console.log('smoke stage: getData');
    await dashboard.webContents.executeJavaScript(`window.addEventListener('error', event => console.error('PAGE_ERROR ' + event.message + ' ' + (event.error && event.error.stack))); window.addEventListener('unhandledrejection', event => console.error('PAGE_REJECTION ' + (event.reason && event.reason.stack)))`);
    const initial = await dashboard.webContents.executeJavaScript(`(async () => {
      const data = await window.api.getData();
      return { hasData: !!data.data, createHidden: document.getElementById('guildCode').closest('#guildJoinPanel').hidden,
        joinRequired: document.getElementById('guildCode').required, joinDisabled: document.getElementById('guildCode').disabled };
    })()`);
    if (!initial.hasData || !initial.createHidden || initial.joinRequired || !initial.joinDisabled) throw new Error(`Guild mode or real IPC startup check failed: ${JSON.stringify(initial)}`);

    console.log('smoke stage: guild mode');
    const joinPanel = await dashboard.webContents.executeJavaScript(`(() => {
      document.getElementById('guildModeJoin').click();
      return { visible: !document.getElementById('guildJoinPanel').hidden, required: document.getElementById('guildCode').required, disabled: document.getElementById('guildCode').disabled };
    })()`);
    if (!joinPanel.visible || !joinPanel.required || joinPanel.disabled) throw new Error('Join mode did not reveal required code field');
    console.log('smoke stage: history');
    await dashboard.webContents.executeJavaScript(`document.getElementById('tabHistory').click()`);
    console.log('smoke stage: history clicked');
    await wait(250);
    const history = await dashboard.webContents.executeJavaScript(`({ total: document.getElementById('historyFilteredMeta').textContent, shown: document.querySelectorAll('#historyList .history-item').length, more: !document.getElementById('historyMore').hidden })`);
    console.log(`smoke stage: history results ${JSON.stringify(history)}`);
    if (!history.total.includes('205 matching') || history.shown !== 100 || !history.more) throw new Error(`History pagination smoke failed: ${JSON.stringify(history)}`);
    await dashboard.webContents.executeJavaScript(`document.getElementById('historySearch').value = 'Needle'; document.getElementById('historySearch').dispatchEvent(new Event('input', { bubbles: true }))`);
    console.log('smoke stage: history filtered');
    const filtered = await dashboard.webContents.executeJavaScript(`({ count: document.querySelectorAll('#historyList .history-item').length, text: document.getElementById('historyFilteredMeta').textContent })`);
    if (filtered.count !== 1 || !filtered.text.includes('1 matching')) throw new Error(`History search smoke failed: ${JSON.stringify(filtered)}`);
    console.log('smoke stage: clear search');
    await dashboard.webContents.executeJavaScript(`document.getElementById('historySearch').value = ''; document.getElementById('historySearch').dispatchEvent(new Event('input', { bubbles: true }))`);
    console.log('smoke stage: open editor');
    await dashboard.webContents.executeJavaScript(`document.querySelector('#historyList .h-edit').click()`);
    console.log('smoke stage: save edit');
    await captureTo(dashboard, path.join(process.env.STUDY_QUEST_SMOKE_SHOTS, 'history-edit.png'));
    await dashboard.webContents.executeJavaScript(`document.getElementById('editSubject').value = 'Corrected subject'; document.getElementById('editSeconds').value = '300';`);
    await dashboard.webContents.executeJavaScript(`document.querySelector('#sessionEditForm [type="submit"]').click()`);
    await wait(300);
    const edited = await dashboard.webContents.executeJavaScript(`(async () => (await window.api.getData()).data.sessions.some(s => s.subject === 'Corrected subject'))()`);
    if (!edited) throw new Error('Session correction did not persist via main IPC');
    await dashboard.webContents.executeJavaScript(`document.getElementById('btnCancelSessionEdit').click(); document.getElementById('btnSettings').click(); document.getElementById('settingsDialog').close()`);

    const timer = await dashboard.webContents.executeJavaScript(`(async () => {
      const started = await window.api.startTimer('UI smoke');
      const paused = await window.api.pauseTimer();
      return { started: !!started, paused: paused && !paused.running };
    })()`);
    if (!timer.started || !timer.paused) throw new Error(`Timer IPC smoke failed: ${JSON.stringify(timer)}`);

    await dashboard.webContents.executeJavaScript(`window.api.startTimer('Save failure smoke')`);
    await wait(5200);
    // Fail the atomic data write from this isolated Electron process only.
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function (file, ...args) {
      if (String(file).endsWith('study-quest-data.json.tmp')) throw new Error('deterministic smoke disk failure');
      return originalWrite.call(this, file, ...args);
    };
    await dashboard.webContents.executeJavaScript(`document.getElementById('btnStop').click()`);
    await wait(400);
    fs.writeFileSync = originalWrite;
    const retained = await dashboard.webContents.executeJavaScript(`({ time: document.getElementById('timerDisplay').textContent, status: document.getElementById('sessionStatus').textContent, error: document.querySelector('.toast-host').textContent })`);
    if (retained.time === '00:00:00' || retained.status !== 'Recording' || !retained.error.includes('not saved')) throw new Error(`Failed save did not preserve active timer state: ${JSON.stringify(retained)}`);
    await dashboard.webContents.executeJavaScript(`window.api.stopTimer()`);

    const shots = process.env.STUDY_QUEST_SMOKE_SHOTS;
    fs.mkdirSync(shots, { recursive: true });
    const noMotion = '* { animation: none !important; transition: none !important; }';
    await dashboard.webContents.insertCSS(noMotion);
    await overlay.webContents.insertCSS(noMotion);
    const saveShot = async (win, name) => captureTo(win, path.join(shots, name));
    await dashboard.webContents.executeJavaScript(`document.getElementById('tabOverview').click()`);
    await dashboard.webContents.executeJavaScript(`document.getElementById('toastHost').replaceChildren()`);
    await wait(300);
    await saveShot(dashboard, 'dashboard.png');
    await dashboard.webContents.executeJavaScript(`document.getElementById('tabGuild').click()`);
    await dashboard.webContents.executeJavaScript(`document.getElementById('guildModeCreate').click()`);
    const createMode = await dashboard.webContents.executeJavaScript(`({ hidden: document.getElementById('guildJoinPanel').hidden, disabled: document.getElementById('guildCode').disabled, required: document.getElementById('guildCode').required, display: getComputedStyle(document.getElementById('guildJoinPanel')).display })`);
    if (!createMode.hidden || !createMode.disabled || createMode.required || createMode.display !== 'none') throw new Error(`Create mode exposed a join field: ${JSON.stringify(createMode)}`);
    await saveShot(dashboard, 'guild-create.png');
    await dashboard.webContents.executeJavaScript(`document.getElementById('guildModeJoin').click()`);
    await saveShot(dashboard, 'guild-join.png');
    await dashboard.webContents.executeJavaScript(`document.getElementById('btnSettings').click()`);
    await saveShot(dashboard, 'settings.png');
    await dashboard.webContents.executeJavaScript(`(async () => { document.getElementById('settingsDialog').close(); await window.api.setTheme('light'); })()`);
    await saveShot(dashboard, 'light-theme.png');
    await dashboard.webContents.executeJavaScript(`(async () => await window.api.setTheme('legacy'))()`);
    await saveShot(dashboard, 'legacy-theme.png');
    await dashboard.webContents.executeJavaScript(`(async () => await window.api.setTheme('dark'))()`);
    await saveShot(overlay, 'overlay.png');
    const overlaySize = await overlay.webContents.executeJavaScript(`({ tier: document.querySelector('.overlay-card').dataset.size, label: document.getElementById('btnAction').getAttribute('aria-label') })`);
    if (overlaySize.tier !== 'micro' || !overlaySize.label) throw new Error(`Micro overlay smoke failed: ${JSON.stringify(overlaySize)}`);
    console.log('Electron renderer smoke passed (isolated profile; main/preload IPC exercised).');
    app.quit();
  } catch (error) {
    console.error(error.stack || error);
    app.exit(1);
  }
});
