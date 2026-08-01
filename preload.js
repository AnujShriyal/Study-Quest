const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getData: () => ipcRenderer.invoke('data:get'),

  addTodo: (text) => ipcRenderer.invoke('todo:add', text),
  toggleTodo: (id) => ipcRenderer.invoke('todo:toggle', id),
  deleteTodo: (id) => ipcRenderer.invoke('todo:delete', id),

  startTimer: (subject) => ipcRenderer.invoke('timer:start', subject),
  pauseTimer: () => ipcRenderer.invoke('timer:pause'),
  resumeTimer: () => ipcRenderer.invoke('timer:resume'),
  stopTimer: () => ipcRenderer.invoke('timer:stop'),

  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  showDashboard: () => ipcRenderer.invoke('window:showDashboard'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  onTimerTick: (cb) => ipcRenderer.on('timer:tick', (_e, payload) => cb(payload)),
  onDataUpdated: (cb) => ipcRenderer.on('data:updated', (_e, payload) => cb(payload))
});
