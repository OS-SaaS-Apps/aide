// ─────────────────────────────────────────────────────────────────────────────
// SSH UI — profile manager, profile picker and the prompts the main process
// raises while connecting (host key, password, passphrase, 2FA).
//
// Secrets typed here go straight to the main process, which encrypts them;
// profiles coming back only say whether a secret is stored (hasPassword …).
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  const api = () => window.electronAPI;
  let profiles = [];

  async function loadProfiles() {
    try { profiles = await api().sshListProfiles() || []; } catch { profiles = []; }
    return profiles;
  }

  const getProfile = (id) => profiles.find(p => p.id === id) || null;

  function profileLabel(id) {
    const p = getProfile(id);
    if (!p) return id ? '(missing profile)' : '';
    return p.name;
  }

  function profileSummary(p) {
    if (!p) return '';
    const who = (p.username ? p.username + '@' : '') + p.host + (p.port && p.port !== 22 ? ':' + p.port : '');
    const bits = [who];
    if (p.remoteDir) bits.push(p.remoteDir);
    if (p.startupCommand) bits.push(p.startupCommand);
    if (p.useTmux) bits.push('tmux');
    return bits.join('  ·  ');
  }

  // ── Small DOM helpers ──────────────────────────────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function input(value, placeholder, type = 'text') {
    const i = el('input', 'url-bar');
    i.type = type;
    i.spellcheck = false;
    i.value = value || '';
    i.placeholder = placeholder || '';
    if (type === 'password') i.autocomplete = 'new-password';
    return i;
  }

  function field(labelText, control, hintText) {
    const f = el('div', 'dialog-field');
    const l = el('label', 'dialog-label', labelText);
    if (hintText) l.appendChild(el('span', 'dialog-hint', ' ' + hintText));
    f.append(l, control);
    return f;
  }

  function checkbox(labelText, checked) {
    const l = el('label', 'ssh-check');
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = !!checked;
    l.append(c, document.createTextNode(labelText));
    return { label: l, box: c };
  }

  function button(text, cls = 'toolbar-btn') {
    const b = el('button', cls, text);
    b.type = 'button';
    return b;
  }

  function overlay(z) {
    const o = el('div', 'dialog-overlay');
    if (z) o.style.zIndex = String(z);
    o.tabIndex = -1;
    document.body.appendChild(o);
    return o;
  }

  function fillSelect(select, selectedId) {
    select.innerHTML = '';
    if (!profiles.length) {
      const o = el('option', null, '(no SSH profiles yet — click ⚙)');
      o.value = '';
      select.appendChild(o);
      return;
    }
    for (const p of profiles) {
      const o = el('option', null, p.name);
      o.value = p.id;
      select.appendChild(o);
    }
    if (selectedId && !getProfile(selectedId)) {
      const o = el('option', null, '(missing profile)');
      o.value = selectedId;
      select.appendChild(o);
    }
    select.value = selectedId || profiles[0].id;
  }

  // ── Profile picker (select + cog) ─────────────────────
  // Used by the new-pane dialog and the pane / designer settings.
  function buildProfilePicker(selectedId) {
    const row = el('div', 'dialog-row');
    const select = el('select', 'url-bar ssh-select');
    fillSelect(select, selectedId);
    const cog = button('⚙');
    cog.title = 'Manage SSH profiles';
    const summary = el('div', 'dialog-hint ssh-summary');
    const refreshSummary = () => { summary.textContent = profileSummary(getProfile(select.value)); };
    select.addEventListener('change', refreshSummary);
    cog.addEventListener('click', async () => {
      const picked = await showProfileManager(select.value || null);
      fillSelect(select, picked || select.value);
      refreshSummary();
      select.dispatchEvent(new Event('change'));
    });
    row.append(select, cog);
    refreshSummary();
    const wrap = el('div', 'ssh-picker');
    wrap.append(row, summary);
    return { el: wrap, select };
  }

  // ── New SSH pane dialog ────────────────────────────────
  // Resolves to a profile id, or null when cancelled.
  async function showSetupDialog(title = 'New SSH Session') {
    await loadProfiles();
    if (!profiles.length) {
      const id = await showProfileManager(null);
      if (!id) return null;
    }
    return new Promise(resolve => {
      const o = overlay();
      const box = el('div', 'dialog-box');
      o.appendChild(box);
      box.appendChild(el('div', 'dialog-title', title));
      const picker = buildProfilePicker(profiles[profiles.length - 1]?.id);
      box.appendChild(field('Profile', picker.el));

      const actions = el('div', 'dialog-actions');
      const ok = button('Connect');
      const cancel = button('Cancel', 'toolbar-btn dialog-cancel-btn');
      actions.append(ok, cancel);
      box.appendChild(actions);

      const syncOk = () => { ok.disabled = !picker.select.value; };
      picker.select.addEventListener('change', syncOk);
      syncOk();

      const finish = (v) => { o.remove(); resolve(v); };
      ok.addEventListener('click', () => { if (picker.select.value) finish(picker.select.value); });
      cancel.addEventListener('click', () => finish(null));
      o.addEventListener('click', (e) => { if (e.target === o) finish(null); });
      o.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
        if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && picker.select.value) { e.stopPropagation(); finish(picker.select.value); }
      });
      picker.select.focus();
    });
  }

  // ── Profile manager ────────────────────────────────────
  // Resolves to the profile selected when the dialog closes (null if none).
  async function showProfileManager(selectId) {
    await loadProfiles();
    return new Promise(resolve => {
      const o = overlay(260);
      const box = el('div', 'dialog-box ssh-manager-box');
      o.appendChild(box);

      const head = el('div', 'ssh-manager-head');
      head.appendChild(el('div', 'dialog-title', 'SSH Profiles'));
      const closeX = button('✕', 'session-delete-btn');
      closeX.title = 'Close';
      head.appendChild(closeX);
      box.appendChild(head);

      const body = el('div', 'ssh-manager-body');
      const side = el('div', 'ssh-profile-side');
      const list = el('div', 'ssh-profile-list');
      const addBtn = button('+ New profile', 'toolbar-btn dialog-cancel-btn');
      side.append(list, addBtn);
      const form = el('div', 'ssh-profile-form');
      body.append(side, form);
      box.appendChild(body);

      const foot = el('div', 'dialog-actions ssh-manager-foot');
      const status = el('div', 'ssh-status-line');
      const delBtn  = button('Delete', 'toolbar-btn dialog-cancel-btn');
      const testBtn = button('Test connection', 'toolbar-btn dialog-cancel-btn');
      const saveBtn = button('Save');
      const useBtn  = button('Save & use');
      foot.append(status, delBtn, testBtn, saveBtn, useBtn);
      box.appendChild(foot);

      let current = null;        // profile being edited (null = new)
      let f = null;              // form refs
      let tsStatus = null;       // Tailscale status, fetched once

      const setStatus = (text, kind = '') => {
        status.textContent = text || '';
        status.className = 'ssh-status-line' + (kind ? ' ' + kind : '');
      };

      function renderList() {
        list.innerHTML = '';
        if (!profiles.length) list.appendChild(el('div', 'ssh-profile-empty', 'No profiles yet'));
        for (const p of profiles) {
          const item = el('div', 'ssh-profile-item' + (current && current.id === p.id ? ' active' : ''));
          item.appendChild(el('div', 'ssh-profile-name', p.name));
          item.appendChild(el('div', 'ssh-profile-host', (p.username ? p.username + '@' : '') + p.host));
          item.addEventListener('click', () => { current = p; renderList(); renderForm(); });
          list.appendChild(item);
        }
        if (!current) {
          const item = el('div', 'ssh-profile-item active');
          item.appendChild(el('div', 'ssh-profile-name', 'New profile'));
          list.appendChild(item);
        }
      }

      function renderForm() {
        const p = current || { port: 22, authType: 'password' };
        form.innerHTML = '';
        setStatus('');
        f = { pendingKeyPath: null, forgetHostKey: false, clearKey: false };

        f.name = input(p.name, 'e.g. My VPS');
        form.appendChild(field('Name', f.name));

        f.host = input(p.host, 'IP address or host name');
        const dl = el('datalist');
        dl.id = 'ssh-ts-peers';
        f.host.setAttribute('list', dl.id);
        const tsLine = el('div', 'dialog-hint ssh-ts-line', 'Tailscale: checking…');
        const hostWrap = el('div', 'ssh-picker');
        hostWrap.append(f.host, dl, tsLine);
        form.appendChild(field('Server', hostWrap));

        const row = el('div', 'dialog-row');
        f.username = input(p.username, 'username');
        f.port = input(String(p.port || 22), '22');
        f.port.classList.add('ssh-port');
        row.append(f.username, f.port);
        form.appendChild(field('Username / Port', row));

        f.tailscale = checkbox('Reach it through Tailscale (check the tailnet before connecting)', p.tailscale);
        form.appendChild(f.tailscale.label);

        f.authType = el('select', 'url-bar ssh-select');
        for (const [v, t] of [['password', 'Password'], ['key', 'SSH key'], ['none', 'None (Tailscale SSH)']]) {
          const opt = el('option', null, t); opt.value = v; f.authType.appendChild(opt);
        }
        f.authType.value = p.authType || 'password';
        form.appendChild(field('Authentication', f.authType));

        // password
        const pwBox = el('div', 'ssh-auth-section');
        f.password = input('', p.hasPassword ? '•••••• saved — leave empty to keep' : 'Password', 'password');
        f.savePassword = checkbox('Save password (encrypted for this Windows user)', current ? p.hasPassword : true);
        pwBox.append(field('Password', f.password), f.savePassword.label);

        // key
        const keyBox = el('div', 'ssh-auth-section');
        const keyRow = el('div', 'dialog-row');
        const keyName = input(p.keyName || '', 'No key imported');
        keyName.readOnly = true;
        const importBtn = button('Import…');
        keyRow.append(keyName, importBtn);
        importBtn.addEventListener('click', async () => {
          const fp = await api().openFilePicker([
            { name: 'Private keys', extensions: ['*'] },
          ]);
          if (!fp) return;
          f.pendingKeyPath = fp;
          keyName.value = fp.split(/[\\/]/).pop() + '  (import on save)';
        });
        f.passphrase = input('', p.hasPassphrase ? '•••••• saved — leave empty to keep' : 'Only if the key is encrypted', 'password');
        f.savePassphrase = checkbox('Save passphrase (otherwise asked when connecting)', current ? p.hasPassphrase : true);
        keyBox.append(
          field('Private key', keyRow, 'copied into AIDE, encrypted — OpenSSH or PuTTY (.ppk v2) format'),
          field('Key passphrase', f.passphrase),
          f.savePassphrase.label);

        const noneBox = el('div', 'ssh-auth-section');
        noneBox.appendChild(el('div', 'dialog-hint', 'No credentials are sent. Use this for servers with Tailscale SSH enabled.'));

        form.append(pwBox, keyBox, noneBox);
        const syncAuth = () => {
          pwBox.hidden   = f.authType.value !== 'password';
          keyBox.hidden  = f.authType.value !== 'key';
          noneBox.hidden = f.authType.value !== 'none';
        };
        f.authType.addEventListener('change', syncAuth);
        syncAuth();

        f.remoteDir = input(p.remoteDir, 'e.g. ~/projects/app');
        form.appendChild(field('Remote directory', f.remoteDir, '(optional)'));

        f.startupCommand = input(p.startupCommand, 'e.g. claude');
        form.appendChild(field('Startup command', f.startupCommand, '(optional)'));

        f.useTmux = checkbox('Keep the session alive on the server with tmux (reconnect resumes it)', p.useTmux);
        form.appendChild(f.useTmux.label);

        const hkRow = el('div', 'dialog-row ssh-hostkey-row');
        const hkText = el('div', 'ssh-hostkey', p.hostKey || 'Not trusted yet — you will be asked to confirm it on first connect');
        hkRow.appendChild(hkText);
        if (p.hostKey) {
          const forget = button('Forget', 'toolbar-btn dialog-cancel-btn');
          forget.addEventListener('click', () => {
            f.forgetHostKey = true;
            hkText.textContent = 'Will be forgotten on save';
            forget.remove();
          });
          hkRow.appendChild(forget);
        }
        form.appendChild(field('Host key', hkRow));

        delBtn.disabled  = !current;
        testBtn.disabled = false;

        // Tailscale: fill the host suggestions and show the client state
        const applyTs = (s) => {
          if (!s || !s.installed) tsLine.textContent = 'Tailscale: not detected on this PC';
          else if (!s.running)    tsLine.textContent = `Tailscale: not connected (${s.state})`;
          else {
            const online = s.peers.filter(x => x.online).length;
            tsLine.textContent = s.cliMissing
              ? 'Tailscale: connected'
              : `Tailscale: connected · ${online} of ${s.peers.length} devices online`;
          }
          tsLine.classList.toggle('ok', !!(s && s.running));
          dl.innerHTML = '';
          for (const peer of (s?.peers || [])) {
            for (const v of [peer.dns, ...(peer.ips || []).filter(ip => ip.includes('.'))]) {
              if (!v) continue;
              const opt = el('option');
              opt.value = v;
              opt.label = `${peer.name}${peer.online ? '' : ' (offline)'}`;
              dl.appendChild(opt);
            }
          }
        };
        const autoTick = () => {
          const h = f.host.value.trim().toLowerCase();
          if (!h) return;
          const isTs = /\.ts\.net$/.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
            (tsStatus?.peers || []).some(x => x.dns.toLowerCase() === h || x.ips.includes(h) || (x.name || '').toLowerCase() === h);
          if (isTs) f.tailscale.box.checked = true;
        };
        f.host.addEventListener('change', autoTick);
        if (tsStatus) applyTs(tsStatus);
        else api().sshTailscaleStatus().then(s => { tsStatus = s; applyTs(s); }).catch(() => applyTs(null));

        f.name.focus();
      }

      function draft() {
        const d = {
          id:             current?.id || null,
          name:           f.name.value.trim(),
          host:           f.host.value.trim(),
          port:           f.port.value.trim(),
          username:       f.username.value.trim(),
          authType:       f.authType.value,
          tailscale:      f.tailscale.box.checked,
          remoteDir:      f.remoteDir.value.trim(),
          startupCommand: f.startupCommand.value.trim(),
          useTmux:        f.useTmux.box.checked,
          forgetHostKey:  f.forgetHostKey,
        };
        if (!f.savePassword.box.checked) d.password = null;
        else if (f.password.value) d.password = f.password.value;
        if (!f.savePassphrase.box.checked) d.passphrase = null;
        else if (f.passphrase.value) d.passphrase = f.passphrase.value;
        if (f.pendingKeyPath) d.keyPath = f.pendingKeyPath;
        return d;
      }

      async function save() {
        const d = draft();
        if (!d.host) { setStatus('Server is required.', 'err'); f.host.focus(); return null; }
        if (d.authType === 'key' && !f.pendingKeyPath && !current?.hasKey) {
          setStatus('Import a private key first.', 'err'); return null;
        }
        const r = await api().sshSaveProfile(d);
        if (!r?.success) { setStatus(r?.error || 'Could not save the profile.', 'err'); return null; }
        await loadProfiles();
        current = getProfile(r.profile.id);
        renderList();
        renderForm();
        setStatus('Saved.', 'ok');
        return current;
      }

      addBtn.addEventListener('click', () => { current = null; renderList(); renderForm(); });
      saveBtn.addEventListener('click', save);

      useBtn.addEventListener('click', async () => {
        const p = await save();
        if (p) finish(p.id);
      });

      testBtn.addEventListener('click', async () => {
        const p = await save();
        if (!p) return;
        testBtn.disabled = true;
        setStatus('Connecting…');
        try {
          const r = await api().sshTestProfile(p.id);
          await loadProfiles();
          current = getProfile(p.id);
          renderList();
          renderForm();
          setStatus(r?.success ? 'Connection OK.' : (r?.error || 'Connection failed.'), r?.success ? 'ok' : 'err');
        } finally { testBtn.disabled = false; }
      });

      delBtn.addEventListener('click', async () => {
        if (!current) return;
        if (delBtn.dataset.armed !== '1') {
          delBtn.dataset.armed = '1';
          delBtn.textContent = 'Click again to delete';
          setTimeout(() => { delBtn.dataset.armed = ''; delBtn.textContent = 'Delete'; }, 2500);
          return;
        }
        delBtn.dataset.armed = '';
        delBtn.textContent = 'Delete';
        await api().sshDeleteProfile(current.id);
        await loadProfiles();
        current = profiles[0] || null;
        renderList();
        renderForm();
        setStatus('Profile deleted. Panes that used it need another profile (⚙ in the pane header).');
      });

      const finish = (id) => {
        o.remove();
        resolve(id ?? (current?.id || null));
      };
      closeX.addEventListener('click', () => finish());
      o.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(); }
        e.stopPropagation();
      });

      current = getProfile(selectId) || profiles[0] || null;
      renderList();
      renderForm();
    });
  }

  // ── Prompts raised while connecting ────────────────────
  // payload: { reqId, kind: 'hostkey' | 'prompt', ... }; `context` names the pane.
  function handleAsk(payload, context) {
    const answer = (v) => api().sshAnswer(payload.reqId, v);
    if (payload.kind === 'hostkey') return askHostKey(payload, context).then(answer);
    if (payload.kind === 'prompt')  return askPrompts(payload, context).then(answer);
    answer(null);
  }

  function askHostKey(p, context) {
    return new Promise(resolve => {
      const o = overlay(320);
      const box = el('div', 'dialog-box ssh-ask-box' + (p.changed ? ' danger' : ''));
      o.appendChild(box);
      box.appendChild(el('div', 'dialog-title', p.changed ? '⚠ Server host key has CHANGED' : 'Trust this server?'));
      if (context) box.appendChild(el('div', 'dialog-hint', context));
      box.appendChild(el('div', 'ssh-ask-text', p.changed
        ? 'The server identified itself with a different key than last time. This happens when the server was reinstalled — or when someone is intercepting the connection. Only accept if you know why it changed.'
        : 'This is the first connection to this server. If you can, compare the fingerprint with the one on the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub).'));
      box.appendChild(field('Server', el('div', 'ssh-hostkey', p.host)));
      box.appendChild(field(`New fingerprint${p.keyType ? ' (' + p.keyType + ')' : ''}`, el('div', 'ssh-hostkey', p.fingerprint)));
      if (p.changed && p.previous) box.appendChild(field('Previously trusted', el('div', 'ssh-hostkey', p.previous)));

      const actions = el('div', 'dialog-actions');
      const cancel = button('Cancel', 'toolbar-btn dialog-cancel-btn');
      const ok = button(p.changed ? 'Accept new key' : 'Trust & connect');
      if (p.changed) ok.classList.add('ssh-danger-btn');
      actions.append(cancel, ok);
      box.appendChild(actions);

      const finish = (v) => { o.remove(); resolve(v); };
      ok.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));
      o.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(false);
        if (e.key === 'Enter' && !p.changed && e.target.tagName !== 'BUTTON') finish(true);
      });
      (p.changed ? cancel : ok).focus();
    });
  }

  function askPrompts(p, context) {
    return new Promise(resolve => {
      const o = overlay(320);
      const box = el('div', 'dialog-box ssh-ask-box');
      o.appendChild(box);
      box.appendChild(el('div', 'dialog-title', p.title || 'Authentication'));
      if (context) box.appendChild(el('div', 'dialog-hint', context));
      if (p.message) box.appendChild(el('div', 'ssh-ask-text', p.message));
      const inputs = (p.prompts || []).map(pr => {
        const i = input('', '', pr.echo ? 'text' : 'password');
        box.appendChild(field(String(pr.prompt || '').replace(/:\s*$/, ''), i));
        return i;
      });
      const actions = el('div', 'dialog-actions');
      const cancel = button('Cancel', 'toolbar-btn dialog-cancel-btn');
      const ok = button('OK');
      actions.append(cancel, ok);
      box.appendChild(actions);

      const finish = (v) => { o.remove(); resolve(v); };
      ok.addEventListener('click', () => finish(inputs.map(i => i.value)));
      cancel.addEventListener('click', () => finish(null));
      o.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(null);
        if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') finish(inputs.map(i => i.value));
      });
      (inputs[0] || ok).focus();
    });
  }

  window.SshUI = {
    loadProfiles, getProfile, profileLabel, profileSummary,
    buildProfilePicker, showSetupDialog, showProfileManager, handleAsk,
  };
})();
