const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  getData: () => ipcRenderer.invoke('data:get'),

  addTodo: (text) => ipcRenderer.invoke('todo:add', text),
  toggleTodo: (id) => ipcRenderer.invoke('todo:toggle', id),
  deleteTodo: (id) => ipcRenderer.invoke('todo:delete', id),
  restoreTodo: (todo) => ipcRenderer.invoke('todo:restore', todo),
  clearDoneTodos: () => ipcRenderer.invoke('todo:clearDone'),

  startTimer: (subject) => ipcRenderer.invoke('timer:start', subject),
  pauseTimer: () => ipcRenderer.invoke('timer:pause'),
  resumeTimer: () => ipcRenderer.invoke('timer:resume'),
  stopTimer: () => ipcRenderer.invoke('timer:stop'),

  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  restoreSession: (session) => ipcRenderer.invoke('session:restore', session),

  setGoal: (minutes) => ipcRenderer.invoke('goal:set', minutes),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  getGuild: () => ipcRenderer.invoke('guild:get'),
  createGuild: (opts) => ipcRenderer.invoke('guild:create', opts),
  joinGuild: (opts) => ipcRenderer.invoke('guild:join', opts),
  viewGuild: (opts) => ipcRenderer.invoke('guild:view', opts),
  leaveGuild: () => ipcRenderer.invoke('guild:leave'),
  refreshGuild: () => ipcRenderer.invoke('guild:refresh'),
  setDisplayName: (name) => ipcRenderer.invoke('guild:setName', name),

  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  showDashboard: () => ipcRenderer.invoke('window:showDashboard'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  onTimerTick: (cb) => ipcRenderer.on('timer:tick', (_e, payload) => cb(payload)),
  onDataUpdated: (cb) => ipcRenderer.on('data:updated', (_e, payload) => cb(payload)),
  onLevelUp: (cb) => ipcRenderer.on('level:up', (_e, payload) => cb(payload)),
  onGoalReached: (cb) => ipcRenderer.on('goal:reached', (_e, payload) => cb(payload)),
  onMaximizedChange: (cb) => ipcRenderer.on('window:maximized', (_e, value) => cb(value)),
  onGuildUpdated: (cb) => ipcRenderer.on('guild:updated', (_e, payload) => cb(payload))
});
