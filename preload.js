const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  createPty: (id, cols, rows, shell, cwd) =>
    ipcRenderer.invoke('pty:create', { id, cols, rows, shell, cwd }),

  openDirectoryPicker: (title) =>
    ipcRenderer.invoke('dialog:openDirectory', { title }),

  readDir: (dirPath) =>
    ipcRenderer.invoke('fs:readDir', dirPath),

  parentDir: (dirPath) =>
    ipcRenderer.invoke('fs:parentDir', dirPath),

  deleteItem: (itemPath) =>
    ipcRenderer.invoke('fs:delete', itemPath),

  pasteItem: (src, destDir, move) =>
    ipcRenderer.invoke('fs:paste', { src, destDir, move }),

  createDir: (dir, name) =>
    ipcRenderer.invoke('fs:createDir', { dir, name }),

  createFile: (dir, name) =>
    ipcRenderer.invoke('fs:createFile', { dir, name }),

  renameItem: (oldPath, newName) =>
    ipcRenderer.invoke('fs:rename', { oldPath, newName }),

  readTextFile: (filePath) =>
    ipcRenderer.invoke('fs:readTextFile', filePath),

  writeTextFile: (filePath, content) =>
    ipcRenderer.invoke('fs:writeTextFile', { filePath, content }),

  openFilePicker: (filters) =>
    ipcRenderer.invoke('dialog:openFile', { filters }),

  saveFilePicker: (defaultPath, filters) =>
    ipcRenderer.invoke('dialog:saveFile', { defaultPath, filters }),

  openFile: (filePath) =>
    ipcRenderer.invoke('fs:openFile', filePath),

  openNotepad: (filePath) =>
    ipcRenderer.invoke('fs:openNotepad', filePath),

  cmdHere: (dirPath) =>
    ipcRenderer.invoke('fs:cmdHere', dirPath),

  listShells: () =>
    ipcRenderer.invoke('shells:list'),

  writePty: (id, data) =>
    ipcRenderer.send('pty:write', { id, data }),

  resizePty: (id, cols, rows) =>
    ipcRenderer.send('pty:resize', { id, cols, rows }),

  killPty: (id) =>
    ipcRenderer.send('pty:kill', { id }),

  onPtyData: (callback) =>
    ipcRenderer.on('pty:data', (event, payload) => callback(payload)),

  onPtyExit: (callback) =>
    ipcRenderer.on('pty:exit', (event, payload) => callback(payload)),

  removePtyListeners: () => {
    ipcRenderer.removeAllListeners('pty:data');
    ipcRenderer.removeAllListeners('pty:exit');
  },

  loadLayouts: () =>
    ipcRenderer.invoke('layouts:load'),

  openConfigFile: () =>
    ipcRenderer.invoke('layouts:openFile'),

  getPaneInfo: (id) =>
    ipcRenderer.invoke('session:getPaneInfo', { id }),

  getClaudeSessionId: (cwd, since) =>
    ipcRenderer.invoke('claude:getSessionId', { cwd, since }),

  listSessions: () =>
    ipcRenderer.invoke('session:list'),

  saveSession: (session) =>
    ipcRenderer.invoke('session:save', session),

  deleteSession: (id) =>
    ipcRenderer.invoke('session:delete', { id }),

  loadLastState: () =>
    ipcRenderer.invoke('app:load-last-state'),

  saveLastState: (lastState) =>
    ipcRenderer.invoke('app:save-last-state', lastState),

  confirmClose: (lastState) =>
    ipcRenderer.invoke('app:confirm-close', { lastState }),

  onCloseRequested: (callback) =>
    ipcRenderer.on('app:close-requested', () => callback()),

  openDevTools: () => ipcRenderer.send('devtools:open'),
  restartApp: () => ipcRenderer.send('app:restart'),

  detachPane: (config) => ipcRenderer.invoke('pane:detach', config),

  onPaneReattach: (callback) =>
    ipcRenderer.on('pane:reattach', (event, config) => callback(config)),

  readClipboard:  ()     => ipcRenderer.sendSync('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.sendSync('clipboard:write', text),

  sttGetStatus: () =>
    ipcRenderer.invoke('stt:status'),

  sttDownload: () =>
    ipcRenderer.send('stt:download'),

  sttTranscribe: (samples, sampleRate, language) =>
    ipcRenderer.invoke('stt:transcribe', samples, sampleRate, language),

  onSttStatusChange: (callback) =>
    ipcRenderer.on('stt:status-change', (event, state) => callback(state)),
});
