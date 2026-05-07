const { app, BrowserWindow, ipcMain, nativeTheme, shell, dialog, Menu, Tray, nativeImage, clipboard } = require('electron');
app.setAppUserModelId('com.aide.app');
Menu.setApplicationMenu(null);
nativeTheme.themeSource = 'dark';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');

let mainWindow;
let tray = null;
let isShuttingDown = false;
const ptyProcesses = new Map();
const ptyToSender  = new Map(); // maps pty id → webContents.id (for routing data to correct window)
const stt = require('./stt');

// ── Session / last-state helpers ───────────────────────
function sessionsFilePath()  { return path.join(app.getPath('userData'), 'sessions.json'); }
function lastStatePath()     { return path.join(app.getPath('userData'), 'laststate.json'); }
function loadSessionsFile() {
  try { const p = sessionsFilePath(); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  return [];
}
function saveSessionsFile(sessions) { fs.writeFileSync(sessionsFilePath(), JSON.stringify(sessions, null, 2)); }

function getPtyInfo(pid) {
  const result = { cwd: null, command: null };
  if (!pid) return result;
  try {
    if (process.platform !== 'win32') {
      result.cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      try {
        const childPid = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' }).trim().split('\n')[0];
        if (childPid) result.command = fs.readlinkSync(`/proc/${childPid}/exe`).split('/').pop();
      } catch {}
    }
  } catch {}
  return result;
}

function getShell() {
  if (process.platform === 'win32') {
    try { execSync('where pwsh.exe', { stdio: 'ignore' }); return 'pwsh.exe'; } catch {}
    return 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function getAvailableShells() {
  const shells = [];
  if (process.platform === 'win32') {
    try { execSync('where pwsh.exe', { stdio: 'ignore' });
      shells.push({ id: 'pwsh',        label: 'PowerShell 7',       path: 'pwsh.exe' }); } catch {}
    shells.push(  { id: 'powershell',  label: 'Windows PowerShell', path: 'powershell.exe' });
    shells.push(  { id: 'cmd',         label: 'Command Prompt',      path: 'cmd.exe' });
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const p of gitBashPaths) {
      if (fs.existsSync(p)) { shells.push({ id: 'gitbash', label: 'Git Bash', path: p }); break; }
    }
  } else {
    shells.push({ id: 'default', label: 'Terminal', path: process.env.SHELL || '/bin/bash' });
  }
  return shells;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, 'favicon_dark.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Force dark mode for all webview panes via Chrome DevTools Protocol
  mainWindow.webContents.on('did-attach-webview', (event, wc) => {
    wc.on('did-finish-load', () => {
      try { wc.debugger.attach('1.3'); } catch {}
      wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      }).catch(() => {});
    });
  });

  // Allow microphone access for STT
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media');
  });
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission) => {
    return permission === 'media';
  });

  mainWindow.on('close', (event) => {
    event.preventDefault();
    mainWindow.webContents.send('app:close-requested');
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Deploy MCP scripts to userData on startup ──────────────────────────────
function deployMcpScripts() {
  const srcDir  = path.join(__dirname, 'mcp');
  const destDir = path.join(app.getPath('userData'), 'mcp');
  if (!fs.existsSync(srcDir)) return;
  try {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
    }
  } catch (e) {
    console.error('[mcp] deploy failed:', e.message);
  }
}

app.whenReady().then(() => {
  deployMcpScripts();

  let pty = null;
  let ptyLoadError = null;
  try {
    pty = require('node-pty');
  } catch (e) {
    ptyLoadError = e.message;
    console.error('[node-pty] failed to load:', e);
  }

  ipcMain.handle('shells:list', () => getAvailableShells());

  ipcMain.handle('app:getUserDataPath', () => app.getPath('userData'));

  ipcMain.on('clipboard:read',  (e)      => { e.returnValue = clipboard.readText(); });
  ipcMain.on('clipboard:write', (e, txt) => { clipboard.writeText(txt); e.returnValue = null; });

  ipcMain.on('devtools:open', () => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  ipcMain.on('app:restart', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('fs:readDir', (event, dirPath) => {
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true })
        .map(e => {
          const p = path.join(dirPath, e.name);
          let mtime = 0, size = 0;
          try { const st = fs.statSync(p); mtime = st.mtimeMs; size = st.size; } catch {}
          return { name: e.name, path: p, isDirectory: e.isDirectory(), mtime, size };
        });
    } catch { return []; }
  });

  ipcMain.handle('fs:parentDir', (event, dirPath) => path.dirname(dirPath));

  ipcMain.handle('fs:delete', (event, itemPath) => {
    try {
      const stat = fs.statSync(itemPath);
      if (stat.isDirectory()) fs.rmSync(itemPath, { recursive: true, force: true });
      else fs.unlinkSync(itemPath);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:paste', (event, { src, destDir, move }) => {
    try {
      let name = path.basename(src);
      let dest = path.join(destDir, name);
      if (fs.existsSync(dest)) {
        const ext  = path.extname(name);
        const base = path.basename(name, ext);
        let candidate = path.join(destDir, `${base}_copy${ext}`);
        if (fs.existsSync(candidate)) {
          let i = 2;
          do { candidate = path.join(destDir, `${base}_copy_${i++}${ext}`); } while (fs.existsSync(candidate));
        }
        dest = candidate;
      }
      const isDir = fs.statSync(src).isDirectory();
      if (move) {
        try { fs.renameSync(src, dest); }
        catch {
          if (isDir) { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true }); }
          else { fs.copyFileSync(src, dest); fs.unlinkSync(src); }
        }
      } else {
        if (isDir) fs.cpSync(src, dest, { recursive: true });
        else fs.copyFileSync(src, dest);
      }
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:createDir', (event, { dir, name }) => {
    try { fs.mkdirSync(path.join(dir, name)); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:createFile', (event, { dir, name }) => {
    try { fs.writeFileSync(path.join(dir, name), '', { flag: 'wx' }); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:rename', (event, { oldPath, newName }) => {
    try {
      const newPath = path.join(path.dirname(oldPath), newName);
      fs.renameSync(oldPath, newPath);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:openFile', (event, filePath) => shell.openPath(filePath));

  ipcMain.handle('fs:openNotepad', (event, filePath) => {
    try {
      spawn('notepad.exe', [filePath], { detached: true, stdio: 'ignore' }).unref();
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:cmdHere', (event, dirPath) => {
    try {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: dirPath, detached: true, stdio: 'ignore' }).unref();
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:readTextFile', (event, filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return { success: true, content };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:writeTextFile', (event, { filePath, content }) => {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('fs:ensureDir', (event, dirPath) => {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('dialog:openFile', async (event, { filters } = {}) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open File',
      properties: ['openFile'],
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:saveFile', async (event, { defaultPath, filters } = {}) => {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save File',
      defaultPath,
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('dialog:openDirectory', async (event, { title } = {}) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Select Working Directory',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('pty:create', (event, { id, cols, rows, shell: shellPath, cwd, panelName }) => {
    if (!pty) return { success: false, error: `node-pty failed to load: ${ptyLoadError}` };
    const shell = shellPath || getShell();
    const args = (shell.includes('pwsh') || shell.includes('powershell')) ? ['-NoLogo'] : [];
    const startCwd = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();
    let ptyProcess;
    try {
      const env = { ...process.env };
      if (panelName) env.AIDE_PANEL_NAME = panelName;
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: startCwd,
        env,
      });
    } catch (e) {
      console.error('[pty:create] spawn failed:', e);
      return { success: false, error: e.message };
    }

    const sender = event.sender;
    ptyProcesses.set(id, ptyProcess);
    ptyToSender.set(id, sender.id);

    ptyProcess.onData((data) => {
      if (!sender.isDestroyed()) {
        sender.send('pty:data', { id, data });
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      ptyProcesses.delete(id);
      ptyToSender.delete(id);
      if (!sender.isDestroyed()) {
        sender.send('pty:exit', { id, exitCode });
      }
    });

    return { success: true };
  });

  ipcMain.on('pty:write', (event, { id, data }) => {
    const ptyProcess = ptyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  });

  ipcMain.on('pty:resize', (event, { id, cols, rows }) => {
    const ptyProcess = ptyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.resize(cols, rows);
    }
  });

  ipcMain.on('pty:kill', (event, { id }) => {
    const ptyProcess = ptyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcesses.delete(id);
    }
  });

  // Layout config IPC
  ipcMain.handle('layouts:load', () => {
    const userPath = path.join(app.getPath('userData'), 'layouts.conf');
    if (fs.existsSync(userPath)) return fs.readFileSync(userPath, 'utf8');
    const bundledPath = path.join(__dirname, 'layouts.conf');
    if (fs.existsSync(bundledPath)) return fs.readFileSync(bundledPath, 'utf8');
    return null;
  });

  ipcMain.handle('layouts:openFile', () => {
    const userPath = path.join(app.getPath('userData'), 'layouts.conf');
    if (!fs.existsSync(userPath)) {
      const bundledPath = path.join(__dirname, 'layouts.conf');
      if (fs.existsSync(bundledPath)) fs.copyFileSync(bundledPath, userPath);
    }
    shell.openPath(userPath);
  });

  // Last-state IPC
  ipcMain.handle('app:load-last-state', () => {
    try {
      const p = lastStatePath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
    return null;
  });

  ipcMain.handle('app:save-last-state', (event, lastState) => {
    try { fs.writeFileSync(lastStatePath(), JSON.stringify(lastState, null, 2)); return { success: true, path: lastStatePath() }; }
    catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('app:confirm-close', (event, { lastState }) => {
    if (lastState) {
      try { fs.writeFileSync(lastStatePath(), JSON.stringify(lastState, null, 2)); } catch {}
    }
    for (const [, ptyProcess] of ptyProcesses) { try { ptyProcess.kill(); } catch {} }
    ptyProcesses.clear();

    isShuttingDown = true;

    try {
      tray = new Tray(path.join(__dirname, 'favicon_dark.ico'));
      tray.setToolTip('AIDE — closing…');
    } catch {}

    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();

    stt.shutdown().then(() => {
      if (tray) { try { tray.destroy(); } catch {} tray = null; }
      process.exit(0);
    });
  });

  // Session IPC
  ipcMain.handle('session:getPaneInfo', (event, { id }) => {
    const ptyProcess = ptyProcesses.get(id);
    if (!ptyProcess) return { cwd: null, command: null };
    return getPtyInfo(ptyProcess.pid);
  });

  ipcMain.handle('session:list', () => loadSessionsFile());

  ipcMain.handle('session:save', (event, session) => {
    const sessions = loadSessionsFile();
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) sessions[idx] = session;
    else sessions.push(session);
    saveSessionsFile(sessions);
    return { success: true };
  });

  ipcMain.handle('session:delete', (event, { id }) => {
    const sessions = loadSessionsFile().filter(s => s.id !== id);
    saveSessionsFile(sessions);
    return { success: true };
  });

  ipcMain.handle('claude:getSessionId', (event, { cwd, since }) => {
    try {
      const encoded = cwd.replace(/[:\\\/]/g, '-');
      const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
      if (!fs.existsSync(dir)) return null;
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const stat = fs.statSync(path.join(dir, f));
          return { name: f, mtime: stat.mtimeMs, btime: stat.birthtimeMs };
        })
        .filter(f => !since || f.mtime >= since - 5000)
        .sort((a, b) => b.mtime - a.mtime);
      return files.length ? files[0].name.slice(0, -6) : null;
    } catch { return null; }
  });

  function panelSummaryFile(panelName) {
    const safe = panelName.replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 80);
    return path.join(os.homedir(), '.claude', 'panel-summaries', safe + '.md');
  }

  ipcMain.handle('claude:getSummary', (event, { panelName }) => {
    try {
      const file = panelSummaryFile(panelName);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    } catch { return null; }
  });

  ipcMain.handle('claude:saveSummary', (event, { panelName, summary }) => {
    try {
      const file = panelSummaryFile(panelName);
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, summary, 'utf8');
      return true;
    } catch { return false; }
  });

  ipcMain.handle('claude:generateSummary', async (event, { sessionId, cwd }) => {
    try {
      const encoded = cwd.replace(/[:\\\/]/g, '-');
      const file = path.join(os.homedir(), '.claude', 'projects', encoded, sessionId + '.jsonl');
      if (!fs.existsSync(file)) return null;

      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const messages = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if ((obj.type === 'user' || obj.type === 'assistant') && obj.message?.content) {
            const raw = obj.message.content;
            const text = typeof raw === 'string' ? raw
              : Array.isArray(raw) ? raw.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : '';
            if (text.trim()) messages.push(`${obj.type === 'user' ? 'User' : 'Claude'}: ${text.slice(0, 500)}`);
          }
        } catch {}
      }
      if (messages.length < 2) return null;

      const transcript = messages.join('\n\n').slice(0, 4000);
      const prompt = `Summarize this Claude Code conversation in 2-4 sentences. Focus on what was worked on, key decisions made, and any open items:\n\n${transcript}`;

      const { spawn } = require('child_process');
      return await new Promise((resolve) => {
        const proc = spawn('claude', ['-p', '--no-session-persistence', '--tools', ''], {
          cwd: os.homedir(),
          env: process.env,
        });
        proc.stdin.write(prompt, 'utf8');
        proc.stdin.end();
        let output = '';
        proc.stdout.on('data', d => { output += d; });
        proc.on('close', () => resolve(output.trim() || null));
        proc.on('error', () => resolve(null));
        const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 30000);
        proc.on('close', () => clearTimeout(timer));
      });
    } catch { return null; }
  });

  // ── Detach pane to a new window ───────────────────────
  ipcMain.handle('pane:detach', (event, config) => {
    const detachWin = new BrowserWindow({
      width: 900,
      height: 700,
      backgroundColor: '#1e1e1e',
      icon: path.join(__dirname, 'favicon_dark.ico'),
      title: config.name || 'AIDE',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
      },
    });

    detachWin.webContents.on('did-attach-webview', (e, wc) => {
      wc.on('did-finish-load', () => {
        try { wc.debugger.attach('1.3'); } catch {}
        wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'dark' }],
        }).catch(() => {});
      });
    });

    const winContentId = detachWin.webContents.id;
    detachWin.on('closed', () => {
      // Kill PTYs that belonged to this window
      for (const [id, senderId] of [...ptyToSender]) {
        if (senderId === winContentId) {
          const proc = ptyProcesses.get(id);
          if (proc) { try { proc.kill(); } catch {} ptyProcesses.delete(id); }
          ptyToSender.delete(id);
        }
      }
      // Reattach the pane back into the main window
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pane:reattach', config);
      }
    });

    detachWin.loadFile(
      path.join(__dirname, 'renderer', 'index.html'),
      { query: { detached: '1', config: JSON.stringify(config) } }
    );

    return { success: true };
  });

  // ── STT IPC ───────────────────────────────────────────
  ipcMain.handle('stt:status', () => stt.getState());
  ipcMain.on('stt:download', () => stt.download());

  ipcMain.handle('stt:transcribe', async (event, samplesArray, sampleRate, language) => {
    try { return await stt.transcribe(samplesArray, sampleRate, language); }
    catch (e) { console.warn('[STT] transcribe error:', String(e)); return ''; }
  });

  createWindow();

  // Init STT after window exists so status events can reach the renderer
  stt.init(app.getPath('userData'), (newState) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('stt:status-change', newState);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (isShuttingDown) return; // tray path handles exit
  for (const [, ptyProcess] of ptyProcesses) { try { ptyProcess.kill(); } catch {} }
  ptyProcesses.clear();
  stt.shutdown().then(() => process.exit(0));
});
