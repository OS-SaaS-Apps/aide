// ─────────────────────────────────────────────────────────────────────────────
// SSH panes — profiles, secrets, Tailscale detection and ssh2 sessions.
//
// A session is wrapped in a pty-like object (onData / onExit / write / resize /
// kill) so main.js can treat it exactly like a node-pty process: same IPC
// channels, same scrollback buffer, same detach / adopt path.
//
// Secrets (password, private key, passphrase) are encrypted with Electron's
// safeStorage (DPAPI on Windows) and never leave the main process.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { safeStorage } = require('electron');
const { Client, utils: { parseKey } } = require('ssh2');

let profilesFile = null;

function init(userDataPath) {
  profilesFile = path.join(userDataPath, 'ssh-profiles.json');
}

// ── Profile storage ────────────────────────────────────
function readProfiles() {
  try {
    if (profilesFile && fs.existsSync(profilesFile)) {
      const data = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) { console.error('[ssh] failed to read profiles:', e.message); }
  return [];
}

function writeProfiles(list) {
  const tmp = profilesFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, profilesFile);
}

function encrypt(text) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system');
  return safeStorage.encryptString(text).toString('base64');
}

function decrypt(b64) {
  if (!b64) return null;
  try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); }
  catch { return null; }
}

// What the renderer is allowed to see: everything but the secrets themselves.
function publicProfile(p) {
  const { password, privateKey, passphrase, ...rest } = p;
  return { ...rest, hasPassword: !!password, hasKey: !!privateKey, hasPassphrase: !!passphrase };
}

function listProfiles() {
  return readProfiles().map(publicProfile);
}

function getProfile(id) {
  return readProfiles().find(p => p.id === id) || null;
}

// A key the ssh2 parser can't read is rejected at import time, not at connect time.
function checkKey(content) {
  const parsed = parseKey(content);
  if (!(parsed instanceof Error)) return { encrypted: false };
  if (/no passphrase given/i.test(parsed.message)) return { encrypted: true };
  if (/^PuTTY-User-Key-File-3/m.test(content) || /^PuTTY-User-Key-File-2: (?!ssh-(rsa|dss))/m.test(content))
    throw new Error('This PuTTY key format is not supported. Open it in PuTTYgen and use Conversions → Export OpenSSH key, then import that file.');
  throw new Error(`Unsupported or invalid private key: ${parsed.message}`);
}

// `draft` holds the plain fields plus:
//   password / passphrase — non-empty string sets it, null clears it, anything else keeps it
//   keyPath               — import this private key file (encrypted into the profile)
//   clearKey              — drop the stored key
//   forgetHostKey         — drop the trusted host fingerprint
function saveProfile(draft) {
  const list = readProfiles();
  const idx  = draft.id ? list.findIndex(p => p.id === draft.id) : -1;
  const prev = idx >= 0 ? list[idx] : {};
  const host = String(draft.host || '').trim();
  if (!host) throw new Error('Host is required');
  const port = parseInt(draft.port, 10) || 22;

  const p = {
    id:             prev.id || `ssh${Date.now()}`,
    name:           String(draft.name || '').trim() || host,
    host,
    port,
    username:       String(draft.username || '').trim(),
    authType:       ['password', 'key', 'none'].includes(draft.authType) ? draft.authType : 'password',
    remoteDir:      String(draft.remoteDir || '').trim(),
    startupCommand: String(draft.startupCommand || '').trim(),
    useTmux:        !!draft.useTmux,
    tailscale:      !!draft.tailscale,
    keyName:        prev.keyName || null,
    // The fingerprint belongs to host:port — pointing the profile elsewhere forgets it
    hostKey:        (prev.host === host && prev.port === port && !draft.forgetHostKey) ? (prev.hostKey || null) : null,
    password:       prev.password || null,
    privateKey:     prev.privateKey || null,
    passphrase:     prev.passphrase || null,
  };

  if (draft.password === null) p.password = null;
  else if (typeof draft.password === 'string' && draft.password) p.password = encrypt(draft.password);

  if (draft.clearKey) { p.privateKey = null; p.keyName = null; p.passphrase = null; }
  if (draft.keyPath) {
    const content = fs.readFileSync(draft.keyPath, 'utf8');
    checkKey(content);
    p.privateKey = encrypt(content);
    p.keyName    = path.basename(draft.keyPath);
    p.passphrase = null;   // a new key invalidates the old passphrase
  }

  if (draft.passphrase === null) p.passphrase = null;
  else if (typeof draft.passphrase === 'string' && draft.passphrase) p.passphrase = encrypt(draft.passphrase);

  if (idx >= 0) list[idx] = p; else list.push(p);
  writeProfiles(list);
  return publicProfile(p);
}

function deleteProfile(id) {
  writeProfiles(readProfiles().filter(p => p.id !== id));
}

function setHostKey(id, fingerprint) {
  const list = readProfiles();
  const p = list.find(x => x.id === id);
  if (!p) return;
  p.hostKey = fingerprint;
  writeProfiles(list);
}

// ── Tailscale ──────────────────────────────────────────
const TAILSCALE_EXE = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
];

function tailscaleCli() {
  if (process.platform !== 'win32') return 'tailscale';
  return TAILSCALE_EXE.find(p => fs.existsSync(p)) || 'tailscale';
}

function hasTailscaleAdapter() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!/tailscale/i.test(name)) continue;
    if ((addrs || []).some(a => a.family === 'IPv4' && a.address.startsWith('100.'))) return true;
  }
  return false;
}

// { installed, running, state, self, peers: [{ name, dns, ips, online, os }], cliMissing? }
function tailscaleStatus() {
  return new Promise(resolve => {
    execFile(tailscaleCli(), ['status', '--json'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      let data = null;
      try { data = JSON.parse(stdout); } catch {}
      if (!data) {
        // CLI missing or its service not answering — fall back to looking for the network adapter
        const adapter = hasTailscaleAdapter();
        const cliFound = TAILSCALE_EXE.some(p => fs.existsSync(p));
        return resolve({ installed: adapter || cliFound, running: adapter, state: adapter ? 'Running' : (cliFound ? 'NotRunning' : 'Unavailable'),
                         self: null, peers: [], cliMissing: true });
      }
      const peers = Object.values(data.Peer || {}).map(p => ({
        name:   p.HostName,
        dns:    (p.DNSName || '').replace(/\.$/, ''),
        ips:    p.TailscaleIPs || [],
        online: !!p.Online,
        os:     p.OS || '',
      }));
      resolve({
        installed: true,
        running:   data.BackendState === 'Running',
        state:     data.BackendState || 'Unknown',
        self:      data.Self ? (data.Self.DNSName || '').replace(/\.$/, '') : null,
        peers,
      });
    });
  });
}

function isTailnetHost(host) {
  if (/\.ts\.net$/i.test(host)) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  return !!m && +m[1] >= 64 && +m[1] <= 127;   // 100.64.0.0/10, the CGNAT range Tailscale uses
}

function findPeer(status, host) {
  const h = host.toLowerCase();
  return status.peers.find(p =>
    p.ips.includes(host) ||
    p.dns.toLowerCase() === h ||
    (p.name || '').toLowerCase() === h ||
    p.dns.toLowerCase().split('.')[0] === h);
}

// Returns an error message when Tailscale clearly can't reach the host, else null.
async function checkTailscale(profile) {
  const status = await tailscaleStatus();
  if (!status.installed) return 'Tailscale does not appear to be installed on this PC.';
  if (!status.running)   return `Tailscale is not connected (state: ${status.state}). Open the Tailscale app and connect, then retry.`;
  const peer = findPeer(status, profile.host);
  if (peer && !peer.online) return `${peer.name || profile.host} is offline on your tailnet.`;
  return null;
}

// ── Sessions ───────────────────────────────────────────
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function shDir(d) {
  if (d === '~') return '~';
  if (d.startsWith('~/')) return '~/' + shq(d.slice(2));
  return shq(d);
}

// The line typed into the remote shell once it is up.
function startupLine(profile, panelName) {
  const dir = profile.remoteDir;
  const cmd = profile.startupCommand;
  if (profile.useTmux) {
    // -A attaches when the session already exists; the startup command is then ignored,
    // since whatever it started is still running inside tmux.
    const base = String(panelName || profile.name || 'session').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
    let line = `tmux new-session -A -s ${shq('aide-' + (base || 'session'))}`;
    if (dir) line += ` -c ${shDir(dir)}`;
    if (cmd) line += ` ${shq(cmd + '; exec $SHELL')}`;
    return line;
  }
  const parts = [];
  if (dir) parts.push(`cd ${shDir(dir)}`);
  if (cmd) parts.push(cmd);
  return parts.join(' && ');
}

function fingerprintOf(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

function keyTypeOf(keyBuf) {
  try { const k = parseKey(keyBuf); return (Array.isArray(k) ? k[0] : k).type || ''; } catch { return ''; }
}

// Opens an SSH session for `profileId` and returns a pty-like handle immediately; the
// connection proceeds in the background and reports progress as terminal output.
//
// ask(payload)       → Promise<answer|null>   (host key / password / 2FA prompts)
// status(state, msg) → void                   ('connecting' | 'connected' | 'lost')
function openSession(profileId, { cols, rows, panelName, ask, status }) {
  const dataCbs = [], exitCbs = [];
  let conn = null, stream = null, exited = false, killed = false, hostRejected = false;
  let size = { cols: cols || 80, rows: rows || 24 };

  const emit = (s) => { if (s) for (const cb of dataCbs) cb(s); };
  const info = (s) => emit(`\x1b[90m${s}\x1b[0m\r\n`);
  const fail = (s) => emit(`\r\n\x1b[1;31m${s}\x1b[0m\r\n`);
  const finish = (code) => {
    if (exited) return;
    exited = true;
    status('lost', killed ? 'Closed' : 'Disconnected');
    try { conn?.end(); } catch {}
    for (const cb of exitCbs) cb({ exitCode: code });
  };

  const handle = {
    pid: undefined,
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    write:  (data) => { if (stream) stream.write(data); },
    resize: (c, r) => {
      size = { cols: c, rows: r };
      if (stream) try { stream.setWindow(r, c, 0, 0); } catch {}
    },
    kill: () => { killed = true; finish(0); },
  };

  const run = async () => {
    const profile = getProfile(profileId);
    if (!profile) { fail('SSH profile not found — pick another one in the pane settings (⚙).'); return finish(1); }

    const who = profile.username ? `${profile.username}@${profile.host}` : profile.host;
    status('connecting', `Connecting to ${who}…`);
    info(`Connecting to ${who}${profile.port !== 22 ? ':' + profile.port : ''}…`);

    if (profile.tailscale || isTailnetHost(profile.host)) {
      const problem = await checkTailscale(profile);
      if (killed) return;
      if (problem) { fail(problem); return finish(1); }
    }

    // ── credentials
    const cfg = {
      host: profile.host,
      port: profile.port || 22,
      username: profile.username || os.userInfo().username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
    };

    let password = null;
    if (profile.authType === 'password') {
      password = decrypt(profile.password);
      if (!password) {
        const a = await ask({ kind: 'prompt', title: `Password for ${who}`, prompts: [{ prompt: 'Password', echo: false }] });
        if (killed) return;
        if (!a) { fail('Cancelled.'); return finish(1); }
        password = a[0];
      }
      cfg.password = password;
    } else if (profile.authType === 'key') {
      const key = decrypt(profile.privateKey);
      if (!key) { fail('No private key stored in this profile (or it could not be decrypted). Re-import it in the SSH profiles (⚙).'); return finish(1); }
      cfg.privateKey = key;
      if (checkKey(key).encrypted) {
        let pass = decrypt(profile.passphrase);
        if (!pass) {
          const a = await ask({ kind: 'prompt', title: `Passphrase for ${profile.keyName || 'private key'}`, prompts: [{ prompt: 'Key passphrase', echo: false }] });
          if (killed) return;
          if (!a) { fail('Cancelled.'); return finish(1); }
          pass = a[0];
        }
        if (parseKey(key, pass) instanceof Error) { fail('Wrong key passphrase.'); return finish(1); }
        cfg.passphrase = pass;
      }
    }

    // ── host key: trust on first use, loud warning when it changes
    cfg.hostVerifier = (keyBuf, cb) => {
      const fp = fingerprintOf(keyBuf);
      if (profile.hostKey === fp) return cb(true);
      const changed = !!profile.hostKey;
      ask({ kind: 'hostkey', host: `${profile.host}:${profile.port || 22}`, fingerprint: fp,
            keyType: keyTypeOf(keyBuf), changed, previous: profile.hostKey || null })
        .then(ok => {
          if (ok) { setHostKey(profile.id, fp); profile.hostKey = fp; }
          else {
            hostRejected = true;
            fail(changed ? 'Host key changed — connection refused.' : 'Host key not trusted — connection cancelled.');
          }
          cb(!!ok);
        });
    };

    conn = new Client();

    conn.on('keyboard-interactive', (name, instructions, lang, prompts, finishKbd) => {
      // Servers often route plain password auth through keyboard-interactive
      if (password && prompts.length === 1 && /password/i.test(prompts[0].prompt)) return finishKbd([password]);
      if (!prompts.length) return finishKbd([]);
      ask({ kind: 'prompt', title: name || `Authentication for ${who}`, message: instructions || '', prompts })
        .then(a => finishKbd(a || prompts.map(() => '')));
    });

    // Tailscale SSH "check mode" and many servers print their login URL / notice here
    conn.on('banner', (msg) => emit(String(msg || '').replace(/\r?\n/g, '\r\n')));

    conn.on('ready', () => {
      if (killed) return conn.end();
      conn.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, s) => {
        if (err) { fail(`Could not open a shell: ${err.message}`); return finish(1); }
        stream = s;
        status('connected', `Connected to ${who}`);
        if (exited) return;   // the connection test closes as soon as it is connected
        const out    = new StringDecoder('utf8');
        const errOut = new StringDecoder('utf8');
        s.on('data', (d) => emit(out.write(d)));
        s.stderr.on('data', (d) => emit(errOut.write(d)));
        s.on('close', (code) => finish(typeof code === 'number' ? code : 0));
        const line = startupLine(profile, panelName);
        if (line) s.write(line + '\n');
      });
    });

    conn.on('error', (err) => {
      if (hostRejected || killed) return finish(1);
      let msg = err.message;
      if (err.level === 'client-authentication') msg = 'Authentication failed — check the username, password or key.';
      else if (err.code === 'ENOTFOUND')    msg = `Host not found: ${profile.host}`;
      else if (err.code === 'ECONNREFUSED') msg = `Connection refused by ${profile.host}:${profile.port || 22}`;
      else if (err.level === 'client-timeout' || /timed out/i.test(msg)) msg = `Timed out connecting to ${profile.host}`;
      fail(msg);
      finish(1);
    });

    conn.on('close', () => finish(0));

    conn.connect(cfg);
  };

  // Deferred so the caller can attach onData before the first progress line is emitted
  setImmediate(() => run().catch(e => { fail(e.message); finish(1); }));

  return handle;
}

// Connects, authenticates and disconnects — for the profile dialog's "Test" button.
function testProfile(profileId, ask) {
  return new Promise(resolve => {
    let output = '';
    let h = null;
    h = openSession(profileId, {
      cols: 80, rows: 24, panelName: 'test', ask,
      status: (state) => { if (state === 'connected') { resolve({ success: true }); h.kill(); } },
    });
    h.onData(d => { output += d; });
    h.onExit(() => {
      const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      resolve({ success: false, error: lines[lines.length - 1] || 'Connection failed' });
    });
  });
}

module.exports = {
  init, listProfiles, saveProfile, deleteProfile, tailscaleStatus, openSession, testProfile,
};
