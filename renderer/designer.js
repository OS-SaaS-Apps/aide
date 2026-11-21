// ─────────────────────────────────────────────────────────────────────────────
// Layout Designer — modal visual editor for the pane grid.
//
// Operates on a LayoutModel (see layout-model.js) and talks back to the
// renderer through the context object passed to init().  Nothing in here
// touches live panes directly; applying is the renderer's job.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  const LM = () => window.LayoutModel;

  const TYPE_COLORS = {
    terminal: { bg: '#1e3a5f', fg: '#569cd6' },
    browser:  { bg: '#1e3d2f', fg: '#4ec9b0' },
    explorer: { bg: '#2a3a1e', fg: '#4ec94e' },
    text:     { bg: '#1e2535', fg: '#4e94ce' },
    memory:   { bg: '#35251e', fg: '#ce9178' },
    tasks:    { bg: '#2d1e35', fg: '#c586c0' },
    ssh:      { bg: '#353018', fg: '#dcdcaa' },
    blank:    { bg: '#252526', fg: '#6a6a6a' },
  };

  const GAP = 4;   // must match .designer-canvas { gap }

  const ICON_MAXIMIZE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/>' +
    '<path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
  const ICON_RESTORE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/>' +
    '<path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>';

  let ctx   = null;
  let state = null;
  let keyHandler = null;
  let maximized  = false;   // remembered for the rest of the session

  const $ = (id) => document.getElementById(id);

  // ── Lifecycle ─────────────────────────────────────────
  function init(context) {
    ctx = context;

    $('designer-maximize').addEventListener('click', () => toggleMaximize());
    $('designer-close').addEventListener('click', () => requestClose());
    $('designer-cancel').addEventListener('click', () => requestClose());
    $('designer-apply').addEventListener('click', () => apply({ newTab: false }));
    $('designer-apply-newtab').addEventListener('click', () => apply({ newTab: true }));
    $('designer-save-template').addEventListener('click', saveAsTemplate);
    $('designer-export-ascii').addEventListener('click', exportAscii);
    $('designer-open-conf').addEventListener('click', () => ctx.openConfigFile());

    $('designer-dialog').addEventListener('click', (e) => {
      if (e.target === $('designer-dialog')) requestClose();
    });

    window.addEventListener('resize', () => { if (isOpen()) renderCanvas(); });
  }

  const isOpen = () => !$('designer-dialog').classList.contains('hidden');

  async function open() {
    if (isOpen()) return;

    const model = ctx.modelFromCurrentTab();
    state = {
      model,
      baseline: LM().clone(model),
      undo: [],
      redo: [],
      sel: new Set(model.panels[0] ? [model.panels[0].uid] : []),
      dirty: false,
      custom: [],
      shells: [],
      ascii: ctx.getAsciiTemplates(),
      dragUid: null,
    };

    // Webviews are composited above normal DOM in Electron — hide them while
    // the modal is up so browser panes don't punch through it.
    hideWebviews(true);

    $('designer-dialog').classList.remove('hidden');
    applyMaximized();
    keyHandler = onKeyDown;
    document.addEventListener('keydown', keyHandler, true);

    render();
    loadCustomTemplates();
    loadShells();
  }

  async function loadShells() {
    try {
      const shells = await ctx.listShells();
      if (!state) return;
      state.shells = shells || [];
      renderSidebar();
      renderCanvas();
    } catch { /* free-text shells still work */ }
  }

  function toggleMaximize() {
    maximized = !maximized;
    applyMaximized();
    if (state) renderCanvas();   // the stage changed size — refit the preview
  }

  function applyMaximized() {
    const box = document.querySelector('#designer-dialog .designer-box');
    box.classList.toggle('maximized', maximized);
    const btn = $('designer-maximize');
    btn.innerHTML = maximized ? ICON_RESTORE : ICON_MAXIMIZE;
    btn.title = maximized ? 'Restore (F11)' : 'Maximize (F11)';
  }

  function close() {
    $('designer-dialog').classList.add('hidden');
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
    hideWebviews(false);
    closeTypeMenu();
    state = null;
  }

  async function requestClose() {
    if (state?.dirty) {
      const ok = await ctx.confirm('Discard your layout changes?', 'Discard', 'Keep editing');
      if (!ok) return;
    }
    close();
  }

  function hideWebviews(hidden) {
    document.querySelectorAll('webview').forEach(wv => {
      wv.style.visibility = hidden ? 'hidden' : '';
    });
  }

  function onKeyDown(e) {
    if (!isOpen()) return;
    // Let inline editors and nested dialogs handle their own keys.
    if (document.querySelector('.dialog-overlay:not(.hidden) .designer-nested')) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'F11')                   { e.preventDefault(); e.stopPropagation(); toggleMaximize(); }
    else if (e.key === 'Escape')           { e.preventDefault(); e.stopPropagation(); requestClose(); }
    else if (e.key === 'Delete' && state.sel.size) { e.preventDefault(); deleteSelected(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  }

  // ── State plumbing ────────────────────────────────────
  function commit(next, opts = {}) {
    if (!next || next === state.model) return;
    state.undo.push(state.model);
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
    state.model = next;
    state.dirty = true;
    if (opts.select !== undefined) selectOnly(opts.select);
    pruneSelection();
    render();
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(state.model);
    state.model = state.undo.pop();
    state.dirty = true;
    pruneSelection();
    render();
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(state.model);
    state.model = state.redo.pop();
    state.dirty = true;
    pruneSelection();
    render();
  }

  // ── Selection ─────────────────────────────────────────
  // Plain click selects one panel; Ctrl/Shift-click adds or removes panels so
  // several can be edited, retyped or deleted at once.
  function selectOnly(uid) {
    state.sel = new Set(uid ? [uid] : []);
  }

  function toggleSelect(uid) {
    if (state.sel.has(uid)) state.sel.delete(uid);
    else state.sel.add(uid);
  }

  function pruneSelection() {
    for (const uid of [...state.sel])
      if (!LM().findPanel(state.model, uid)) state.sel.delete(uid);
  }

  const selectedPanels = () => LM().readingOrder(state.model).filter(p => state.sel.has(p.uid));

  // The panels an action on `p` applies to: the whole selection when `p` is
  // part of a multi-selection, otherwise just `p`.
  const targetsFor = (p) => (state.sel.size > 1 && state.sel.has(p.uid)) ? selectedPanels() : [p];

  function render() {
    renderSidebar();
    renderCanvas();
    renderStatus();
    renderSubtitle();
  }

  function renderSubtitle() {
    const n = state.model.panels.length;
    const live = state.model.panels.filter(p => p.paneId != null).length;
    $('designer-subtitle').textContent =
      `${n} panel${n === 1 ? '' : 's'} · ${state.model.rows}×${state.model.cols} grid · ${live} reused from this tab` +
      (state.dirty ? ' · unsaved changes' : '');
  }

  // ── Sidebar ───────────────────────────────────────────
  function renderSidebar() {
    const bar = $('designer-sidebar');
    bar.innerHTML = '';

    const atMax = state.model.panels.length >= LM().MAX_PANELS;

    section(bar, 'Panels');
    const addBtn = button(bar, '＋  Add panel', () => openTypeMenu(addBtn, (type) => {
      const res = LM().addPanel(state.model, type, defaultCfgFor(type));
      if (res.newUid) commit(res.model, { select: res.newUid });
      else flash(res.error || 'No room for another panel.');
    }), { primary: true, disabled: atMax });
    if (atMax) note(bar, `Maximum ${LM().MAX_PANELS} panels reached.`);

    const picked = selectedPanels();
    if (picked.length > 1) {
      section(bar, `Selection · ${picked.length}`);
      const types = new Set(picked.map(p => p.type));
      const sameType = types.size === 1 && !types.has('blank');
      button(bar, '⌘  Edit settings…', () => editPanels(picked), {
        disabled: !sameType,
        title: sameType ? 'Edit the settings of every selected panel' : 'Select panels of one type to edit them together',
      });
      const typeBtn = button(bar, '⇄  Set type…', () =>
        openTypeMenu(typeBtn, (t) => setTypeFor(picked, t)));
      button(bar, '✕  Delete selected', deleteSelected);
      button(bar, '○  Clear selection', () => { selectOnly(null); render(); });
    }

    renderSharedSettings(bar);

    section(bar, 'Arrange');
    const chips = row(bar);
    const presets = [
      ['1', '1'], ['2', '2'], ['2↕', '2v'], ['3', '3'], ['3+', '3l'],
      ['4', '4'], ['6', '6'], ['9', '9'], ['12', '12'],
    ];
    for (const [label, key] of presets) {
      const preset = LM().ARRANGEMENTS[key];
      const fits = preset && preset.cells.length >= state.model.panels.length;
      const extra = preset ? preset.cells.length - state.model.panels.length : 0;
      chip(chips, label, () => commit(LM().autoArrange(state.model, key)), {
        disabled: !fits,
        title: !fits
          ? `Needs at most ${preset ? preset.cells.length : 0} panels`
          : `Rearrange into ${preset.rows}×${preset.cols}` +
            (extra > 0 ? `, adding ${extra} untyped panel${extra > 1 ? 's' : ''}` : ''),
      });
    }
    button(bar, '⇔  Equalize sizes', () => commit(LM().equalizeTracks(state.model)));
    button(bar, '⌗  Simplify grid',  () => commit(LM().simplify(state.model)),
      { title: 'Drop unused rows/columns and redundant grid lines' });

    section(bar, 'Grid');
    const rowsRow = row(bar);
    label(rowsRow, `Rows ${state.model.rows}`);
    chip(rowsRow, '−', () => commit(LM().removeRow(state.model)), { disabled: state.model.rows <= 1 });
    chip(rowsRow, '+', () => commit(LM().addRow(state.model)));
    const colsRow = row(bar);
    label(colsRow, `Cols ${state.model.cols}`);
    chip(colsRow, '−', () => commit(LM().removeCol(state.model)), { disabled: state.model.cols <= 1 });
    chip(colsRow, '+', () => commit(LM().addCol(state.model)));

    section(bar, 'My layouts');
    if (!state.custom.length) note(bar, 'Saved layouts appear here. Use “Save as template…”.');
    for (const entry of state.custom) {
      templateRow(bar, entry.name, entry.model, () => loadTemplate(entry.name, LM().fromJSON(entry.model)), () => deleteTemplate(entry));
    }

    section(bar, 'Presets');
    for (const t of state.ascii) {
      templateRow(bar, t.label, null, () => loadTemplate(t.label, LM().modelFromAscii(t)), null, t);
    }

    section(bar, 'History');
    button(bar, '↶  Undo',  undo, { disabled: !state.undo.length });
    button(bar, '↷  Redo',  redo, { disabled: !state.redo.length });
    button(bar, '⟲  Reset to current tab', async () => {
      if (state.dirty && !(await ctx.confirm('Discard changes and reload this tab’s layout?', 'Reset', 'Cancel'))) return;
      commit(LM().clone(state.baseline), { select: null });
    });
    button(bar, '🗑  Clear all', async () => {
      if (!(await ctx.confirm('Remove every panel from the canvas?', 'Clear', 'Cancel'))) return;
      commit(LM().emptyModel(state.model.defaults), { select: null });
    });
  }

  // Folder and shell every terminal / explorer uses unless set on the panel.
  function renderSharedSettings(bar) {
    const d = state.model.defaults || {};
    section(bar, 'Shared settings');
    note(bar, 'Used by terminals and explorers that have no folder or shell of their own.');

    const folderRow = row(bar);
    const folder = document.createElement('input');
    folder.className = 'designer-input';
    folder.type = 'text';
    folder.spellcheck = false;
    folder.placeholder = 'Working folder';
    folder.value = d.cwd || '';
    folder.title = d.cwd || 'Working folder shared by all panels';
    folder.addEventListener('change', () => setDefault('cwd', folder.value.trim()));
    folder.addEventListener('keydown', (e) => { if (e.key === 'Enter') folder.blur(); });
    folderRow.appendChild(folder);
    chip(folderRow, '…', async () => {
      const dir = await ctx.pickDirectory('Shared working folder');
      if (dir) setDefault('cwd', dir);
    }, { title: 'Browse…' }).style.flex = 'none';

    const shellRow = row(bar);
    const shell = document.createElement('select');
    shell.className = 'designer-input';
    const opt = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      shell.appendChild(o);
    };
    opt('', 'Default shell');
    for (const sh of state.shells) opt(sh.path, sh.label);
    if (d.shell && !state.shells.some(sh => sh.path === d.shell)) opt(d.shell, shellLabel(d.shell));
    shell.value = d.shell || '';
    shell.addEventListener('change', () => setDefault('shell', shell.value));
    shellRow.appendChild(shell);
  }

  function setDefault(key, value) {
    if ((state.model.defaults?.[key] || '') === (value || '')) return;
    commit(LM().setDefaults(state.model, { [key]: value || null }));
  }

  function shellLabel(path) {
    const known = state.shells.find(sh => sh.path === path);
    return known ? known.label : String(path).split(/[\\/]/).pop();
  }

  function section(parent, text) {
    const d = document.createElement('div');
    d.className = 'designer-sidebar-section';
    d.textContent = text;
    parent.appendChild(d);
    return d;
  }

  function note(parent, text) {
    const d = document.createElement('div');
    d.className = 'designer-empty-note';
    d.textContent = text;
    parent.appendChild(d);
    return d;
  }

  function row(parent) {
    const d = document.createElement('div');
    d.className = 'designer-sidebar-row';
    parent.appendChild(d);
    return d;
  }

  function label(parent, text) {
    const d = document.createElement('span');
    d.style.cssText = 'flex:1;font-size:11px;color:#858585;align-self:center;';
    d.textContent = text;
    parent.appendChild(d);
    return d;
  }

  function button(parent, text, onClick, opts = {}) {
    const b = document.createElement('button');
    b.className = 'designer-btn' + (opts.primary ? ' designer-btn-primary' : '');
    b.textContent = text;
    if (opts.title) b.title = opts.title;
    b.disabled = !!opts.disabled;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    parent.appendChild(b);
    return b;
  }

  function chip(parent, text, onClick, opts = {}) {
    const b = document.createElement('button');
    b.className = 'designer-chip';
    b.textContent = text;
    if (opts.title) b.title = opts.title;
    b.disabled = !!opts.disabled;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    parent.appendChild(b);
    return b;
  }

  function templateRow(parent, name, modelJson, onLoad, onDelete, asciiLayout) {
    const b = document.createElement('button');
    b.className = 'designer-template';
    b.title = `Load “${name}”`;

    const icon = asciiLayout
      ? ctx.makeLayoutIcon(asciiLayout)
      : miniIcon(LM().fromJSON(modelJson));
    b.appendChild(icon);

    const span = document.createElement('span');
    span.className = 'designer-template-label';
    span.textContent = name;
    b.appendChild(span);

    if (onDelete) {
      const del = document.createElement('span');
      del.className = 'designer-template-del';
      del.textContent = '✕';
      del.title = 'Delete this layout';
      del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
      b.appendChild(del);
    }

    b.addEventListener('click', (e) => { e.stopPropagation(); onLoad(); });
    parent.appendChild(b);
    return b;
  }

  // Mini grid preview for a model (mirrors makeLayoutIcon for ASCII layouts).
  function miniIcon(model) {
    const css = LM().modelToCss(model);
    const div = document.createElement('div');
    div.className = 'layout-icon';
    div.style.gridTemplateAreas   = css.gridTemplateAreas;
    div.style.gridTemplateColumns = css.gridTemplateColumns;
    div.style.gridTemplateRows    = css.gridTemplateRows;
    for (const p of css.order) {
      const cell = document.createElement('div');
      cell.className = 'icon-cell';
      cell.style.gridArea = css.areaByUid[p.uid];
      const col = TYPE_COLORS[p.type] || TYPE_COLORS.terminal;
      cell.style.background = col.bg;
      cell.style.border = `1px solid ${col.fg}`;
      div.appendChild(cell);
    }
    return div;
  }

  async function loadTemplate(name, model) {
    if (state.dirty && !(await ctx.confirm(`Replace the canvas with “${name}”?`, 'Load', 'Cancel'))) return;
    // A template without shared settings keeps the ones already on the canvas.
    if (!Object.keys(model.defaults || {}).length) model = LM().setDefaults(model, state.model.defaults || {});
    // Re-bind live panes where the types line up, so applying keeps terminals alive.
    const bound = bindLivePanes(model, state.baseline);
    commit(bound, { select: bound.panels[0]?.uid || null });
  }

  // Give template panels the paneId of a compatible live pane (same type,
  // first-come-first-served in reading order).
  function bindLivePanes(model, baseline) {
    const m = LM().clone(model);
    const pool = {};
    for (const p of LM().readingOrder(baseline)) {
      if (p.paneId == null) continue;
      (pool[p.type] = pool[p.type] || []).push(p);
    }
    for (const p of LM().readingOrder(m)) {
      const src = pool[p.type]?.shift();
      if (!src) continue;
      const target = LM().findPanel(m, p.uid);
      target.paneId = src.paneId;
      target.name   = src.name;
      target.cfg    = { ...src.cfg };
    }
    return m;
  }

  async function loadCustomTemplates() {
    try {
      state.custom = await window.electronAPI.loadCustomLayouts();
    } catch {
      state.custom = [];
    }
    if (isOpen()) renderSidebar();
  }

  async function deleteTemplate(entry) {
    if (!(await ctx.confirm(`Delete the layout “${entry.name}”?`, 'Delete', 'Cancel'))) return;
    const res = await window.electronAPI.deleteCustomLayout(entry.id);
    if (res?.success) {
      state.custom = res.layouts || [];
      ctx.onTemplatesChanged?.();
      renderSidebar();
    } else {
      flash(res?.error || 'Could not delete the layout.');
    }
  }

  // ── Canvas ────────────────────────────────────────────
  function renderCanvas() {
    const canvas = $('designer-canvas');
    const wrap   = $('designer-canvas-wrap');
    canvas.innerHTML = '';

    const model = state.model;
    const css   = LM().modelToCss(model);

    // Match the live grid's proportions so the preview reads true.
    const aspect = ctx.getGridAspect() || 16 / 9;
    const availW = Math.max(120, wrap.clientWidth  - 28);
    const availH = Math.max(90,  wrap.clientHeight - 28);
    let w = availW, h = w / aspect;
    if (h > availH) { h = availH; w = h * aspect; }
    canvas.style.width  = `${Math.round(w)}px`;
    canvas.style.height = `${Math.round(h)}px`;
    canvas.style.gridTemplateColumns = css.gridTemplateColumns;
    canvas.style.gridTemplateRows    = css.gridTemplateRows;

    // Holes first (they sit behind and act as drop targets)
    for (const { r, c } of LM().holes(model)) {
      const cell = document.createElement('div');
      cell.className = 'designer-hole';
      cell.style.gridArea = `${r + 1} / ${c + 1} / ${r + 2} / ${c + 2}`;
      cell.textContent = '＋';
      cell.title = 'Empty cell — click to add a panel';
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        openTypeMenu(cell, (type) => {
          const m = LM().clone(state.model);
          const p = LM().makePanel(type, r, c, r + 1, c + 1, { cfg: defaultCfgFor(type) });
          if (m.panels.length >= LM().MAX_PANELS) return flash(`Maximum ${LM().MAX_PANELS} panels.`);
          m.panels.push(p);
          commit(m, { select: p.uid });
        });
      });
      cell.addEventListener('dragover', (e) => {
        if (state.dragUid == null) return;
        e.preventDefault();
        cell.classList.add('drag-over');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        cell.classList.remove('drag-over');
        if (state.dragUid == null) return;
        commit(LM().movePanelToCell(state.model, state.dragUid, r, c), { select: state.dragUid });
        state.dragUid = null;
      });
      canvas.appendChild(cell);
    }

    for (const p of LM().readingOrder(model)) canvas.appendChild(buildPanelCard(p));

    requestAnimationFrame(() => {
      if (!isOpen()) return;
      tagPanelSizes(canvas);
      buildSplitters(canvas);
    });
  }

  function buildPanelCard(p) {
    const col = TYPE_COLORS[p.type] || TYPE_COLORS.terminal;
    const meta = LM().TYPE_META[p.type];

    const untyped = p.type === 'blank';

    const card = document.createElement('div');
    card.className = 'designer-panel' + (state.sel.has(p.uid) ? ' selected' : '') + (untyped ? ' untyped' : '');
    card.dataset.uid = p.uid;
    card.style.gridArea = `${p.r0 + 1} / ${p.c0 + 1} / ${p.r1 + 1} / ${p.c1 + 1}`;
    card.style.background  = col.bg;
    card.style.borderColor = col.fg + '80';
    card.draggable = true;
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelect(p.uid);
      else selectOnly(p.uid);
      render();
    });

    // ── header
    const head = document.createElement('div');
    head.className = 'designer-panel-head';

    const swatch = document.createElement('span');
    swatch.className = 'designer-panel-swatch';
    swatch.style.background = col.fg;

    const name = document.createElement('span');
    name.className = 'designer-panel-name';
    name.textContent = p.name || meta.label;
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); renameInline(p, name); });

    head.append(swatch, name);

    if (p.paneId != null) {
      const live = document.createElement('span');
      live.className = 'designer-panel-live';
      live.textContent = '● live';
      live.title = 'Reuses the existing pane — its terminal / page stays alive';
      head.appendChild(live);
    }

    const issue = LM().panelIssue(p, state.model.defaults);
    if (issue) {
      const warn = document.createElement('span');
      warn.className = 'designer-panel-warn';
      warn.textContent = '⚠';
      warn.title = `This panel has ${issue} — click ⌘ to set it up`;
      head.appendChild(warn);
      card.classList.add('unconfigured');
    }

    // ── body
    const body = document.createElement('div');
    body.className = 'designer-panel-body';

    const tools = document.createElement('div');
    tools.className = 'designer-panel-tools';

    if (untyped) {
      const targets = targetsFor(p);
      const pick = document.createElement('button');
      pick.className = 'designer-choose-type';
      pick.textContent = targets.length > 1 ? `Choose type (${targets.length})…` : 'Choose type…';
      pick.addEventListener('click', (e) => {
        e.stopPropagation();
        openTypeMenu(pick, (t) => setTypeFor(targets, t));
      });
      tool(tools, '⠿', 'Drag to move or swap', null, { grab: true });
      tool(tools, '✕', 'Delete panel', () => commit(LM().deletePanel(state.model, p.uid)), { danger: true });
      body.append(pick, tools);
      card.append(head, body);
      wireCardDrag(card, p);
      return card;
    }

    const many = targetsFor(p).length > 1;
    tool(tools, '⠿', 'Drag to move or swap', null, { grab: true });
    tool(tools, '⌘', many ? `Edit the ${targetsFor(p).length} selected panels…`
                          : p.type === 'terminal' ? 'Edit command line…' : 'Edit settings…',
      () => { const t = targetsFor(p); t.length > 1 ? editPanels(t) : editPanel(p); });
    tool(tools, '▥', 'Split side by side', () => split(p.uid, 'v'));
    tool(tools, '▤', 'Split top / bottom',  () => split(p.uid, 'h'));
    tool(tools, '⇄', many ? 'Change type of the selected panels' : 'Change panel type',
      (e) => { const t = targetsFor(p); openTypeMenu(e.currentTarget, (type) => setTypeFor(t, type)); });
    tool(tools, '⧉', 'Duplicate',           () => {
      const res = LM().duplicatePanel(state.model, p.uid);
      res.newUid ? commit(res.model, { select: res.newUid }) : flash(res.error || 'No room to duplicate.');
    });
    tool(tools, '⤢', 'Expand into empty space', () => {
      const next = LM().expandPanel(state.model, p.uid);
      next === state.model ? flash('No empty space next to this panel.') : commit(next, { select: p.uid });
    });
    tool(tools, '✕', 'Delete panel', () => commit(LM().deletePanel(state.model, p.uid)), { danger: true });

    const metaLine = document.createElement('div');
    metaLine.className = 'designer-panel-meta';
    metaLine.textContent = describeCfg(p);
    metaLine.title = metaLine.textContent;

    body.append(tools, metaLine);
    card.append(head, body);
    wireCardDrag(card, p);
    return card;
  }

  // Drag & drop: swap with another panel, or move onto a hole.
  function wireCardDrag(card, p) {
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('.designer-tool') && !e.target.closest('[data-grab]')) { e.preventDefault(); return; }
      state.dragUid = p.uid;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.uid);
      card.classList.add('drag-source');
    });
    card.addEventListener('dragend', () => {
      state.dragUid = null;
      card.classList.remove('drag-source');
      document.querySelectorAll('.designer-panel, .designer-hole')
        .forEach(el => el.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (e) => {
      if (state.dragUid == null || state.dragUid === p.uid) return;
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', (e) => {
      if (!card.contains(e.relatedTarget)) card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (state.dragUid == null || state.dragUid === p.uid) return;
      commit(LM().swapPanels(state.model, state.dragUid, p.uid), { select: state.dragUid });
      state.dragUid = null;
    });
  }

  // Retype panels in one undo step, keeping them selected.
  function setTypeFor(list, type) {
    let m = state.model;
    for (const p of list) m = LM().setPanelType(m, p.uid, type);
    if (m === state.model) return;
    state.sel = new Set(list.map(p => p.uid));
    commit(m);
  }

  function tool(parent, glyph, title, onClick, opts = {}) {
    const b = document.createElement('button');
    b.className = 'designer-tool' + (opts.danger ? ' designer-tool-danger' : '');
    b.textContent = glyph;
    b.title = title;
    if (opts.grab) {
      b.dataset.grab = '1';
      b.style.cursor = 'grab';
    }
    if (onClick) b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    parent.appendChild(b);
    return b;
  }

  function split(uid, dir) {
    const src = LM().findPanel(state.model, uid);
    const res = LM().splitPanel(state.model, uid, dir, src?.type || 'terminal', defaultCfgFor(src?.type || 'terminal'));
    if (res.newUid) commit(res.model, { select: res.newUid });
    else flash(res.error || 'Cannot split further.');
  }

  function deleteSelected() {
    if (!state.sel.size) return;
    let m = state.model;
    for (const uid of state.sel) m = LM().deletePanel(m, uid);
    commit(m, { select: null });
  }

  function renameInline(p, nameEl) {
    const inp = document.createElement('input');
    inp.className = 'pane-title-input';
    inp.value = p.name || '';
    inp.placeholder = LM().TYPE_META[p.type].label;
    inp.style.cssText = 'width:100%;min-width:0;font-size:10px;';
    nameEl.replaceWith(inp);
    inp.focus();
    inp.select();
    const commitName = () => {
      inp.removeEventListener('blur', commitName);
      commit(LM().updatePanel(state.model, p.uid, { name: inp.value.trim() || null }), { select: p.uid });
    };
    inp.addEventListener('blur', commitName);
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter')  inp.blur();
      if (e.key === 'Escape') { inp.removeEventListener('blur', commitName); render(); }
    });
  }

  // Panels smaller than the tool cluster lose their chrome.
  function tagPanelSizes(canvas) {
    for (const card of canvas.querySelectorAll('.designer-panel')) {
      const r = card.getBoundingClientRect();
      card.classList.toggle('tiny', r.height < 78 || r.width < 108);
    }
  }

  function describeCfg(p) {
    const defaults = state.model.defaults;
    const issue = LM().panelIssue(p, defaults);
    if (issue) return issue;

    const c = LM().effectiveCfg(p, defaults);
    const shared = LM().inheritedKeys(p, defaults);
    const mark = (key, text) => shared.includes(key) ? `${text} (shared)` : text;
    if (p.type === 'terminal') {
      const bits = [];
      if (c.command) bits.push(c.command);
      if (c.cwd) bits.push(mark('cwd', shortPath(c.cwd)));
      if (c.shell) bits.push(mark('shell', shellLabel(c.shell)));
      return bits.join('  ·  ');
    }
    if (p.type === 'browser')  return c.url || '';
    if (p.type === 'explorer') return c.cwd ? mark('cwd', shortPath(c.cwd)) : '';
    if (p.type === 'text')     return c.filePath ? shortPath(c.filePath) : '';
    if (p.type === 'memory')   return c.vaultPath ? shortPath(c.vaultPath) : '';
    if (p.type === 'tasks')    return c.tasksPath ? shortPath(c.tasksPath) : '';
    if (p.type === 'ssh')      return window.SshUI?.profileLabel(c.sshProfileId) || '';
    return '';
  }

  function shortPath(p) {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length <= 2 ? p : '…' + p.slice(-(parts.slice(-2).join('/').length + 1));
  }

  function defaultCfgFor(type) {
    return {};
  }

  // ── Splitters ─────────────────────────────────────────
  function buildSplitters(canvas) {
    canvas.querySelectorAll('.designer-splitter').forEach(el => el.remove());
    const cs   = getComputedStyle(canvas);
    const cols = cs.gridTemplateColumns.trim().split(/\s+/).map(parseFloat).filter(n => !isNaN(n));
    const rows = cs.gridTemplateRows.trim().split(/\s+/).map(parseFloat).filter(n => !isNaN(n));

    const pos = (sizes, i) => {
      let t = 0;
      for (let j = 0; j <= i; j++) t += sizes[j] + (j < i ? GAP : 0);
      return t + GAP / 2;
    };

    for (let i = 0; i < cols.length - 1; i++) {
      const s = document.createElement('div');
      s.className = 'designer-splitter';
      s.style.cssText = `top:0;bottom:0;width:7px;left:${pos(cols, i) - 3.5}px;cursor:ew-resize`;
      s.title = 'Drag to resize columns';
      s.addEventListener('mousedown', (e) => startSplitterDrag(e, 'col', i, cols));
      canvas.appendChild(s);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const s = document.createElement('div');
      s.className = 'designer-splitter';
      s.style.cssText = `left:0;right:0;height:7px;top:${pos(rows, i) - 3.5}px;cursor:ns-resize`;
      s.title = 'Drag to resize rows';
      s.addEventListener('mousedown', (e) => startSplitterDrag(e, 'row', i, rows));
      canvas.appendChild(s);
    }
  }

  function startSplitterDrag(e, axis, idx, pxSizes) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const base    = state.model;
    const sizes   = axis === 'row' ? base.rowSizes : base.colSizes;
    const totalFr = sizes[idx] + sizes[idx + 1];
    const totalPx = pxSizes[idx] + pxSizes[idx + 1];
    const startPx = pxSizes[idx];
    const start   = axis === 'row' ? e.clientY : e.clientX;

    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed;inset:0;z-index:9999;cursor:${axis === 'row' ? 'ns-resize' : 'ew-resize'}`;
    document.body.appendChild(overlay);
    e.currentTarget.classList.add('active');

    const onMove = (me) => {
      const delta = (axis === 'row' ? me.clientY : me.clientX) - start;
      const firstFr = ((startPx + delta) / totalPx) * totalFr;
      state.model = LM().resizeTrackPair(base, axis, idx, firstFr);
      renderCanvas();
    };
    const onUp = () => {
      overlay.remove();
      const finished = state.model;
      state.model = base;                 // rewind so commit() records the drag once
      commit(finished);
    };

    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseup', onUp, { once: true });
  }

  // ── Type menu ─────────────────────────────────────────
  let typeMenuEl = null;

  function openTypeMenu(anchor, onPick) {
    closeTypeMenu();
    const menu = document.createElement('div');
    menu.className = 'designer-type-menu';
    for (const type of LM().PANEL_TYPES) {
      const meta = LM().TYPE_META[type];
      const col  = TYPE_COLORS[type];
      const b = document.createElement('button');
      const sw = document.createElement('span');
      sw.style.cssText = `width:9px;height:9px;border-radius:2px;background:${col.fg};flex:none;`;
      b.append(sw, document.createTextNode(meta.label));
      b.addEventListener('click', (e) => { e.stopPropagation(); closeTypeMenu(); onPick(type); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);

    const r = anchor.getBoundingClientRect();
    const mh = menu.offsetHeight, mw = menu.offsetWidth;
    menu.style.left = `${Math.min(r.left, window.innerWidth  - mw - 8)}px`;
    menu.style.top  = `${Math.min(r.bottom + 4, window.innerHeight - mh - 8)}px`;

    typeMenuEl = menu;
    setTimeout(() => document.addEventListener('click', closeTypeMenu, { once: true }), 0);
  }

  function closeTypeMenu() {
    typeMenuEl?.remove();
    typeMenuEl = null;
  }

  // ── Status line ───────────────────────────────────────
  function renderStatus() {
    const el = $('designer-status');
    el.innerHTML = '';
    const v = LM().validate(state.model);
    for (const e of v.errors)   append(el, 'err',  '✕ ' + e);
    for (const w of v.warnings) append(el, 'warn', '⚠ ' + w);
    if (!v.errors.length && !v.warnings.length) append(el, '', 'Drag a panel onto another to swap them; drag the grid lines to resize; Ctrl-click to select several.');

    $('designer-apply').disabled        = !v.ok;
    $('designer-apply-newtab').disabled = !v.ok;
    $('designer-save-template').disabled = !v.ok;

    function append(parent, cls, text) {
      const s = document.createElement('span');
      if (cls) s.className = cls;
      s.textContent = text;
      parent.appendChild(s);
    }
  }

  function flash(message) {
    const el = $('designer-status');
    el.innerHTML = '';
    const s = document.createElement('span');
    s.className = 'warn';
    s.textContent = '⚠ ' + message;
    el.appendChild(s);
    setTimeout(() => { if (isOpen()) renderStatus(); }, 2600);
  }

  // ── Panel settings ────────────────────────────────────
  function editPanel(p) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.style.zIndex = '250';
    document.body.appendChild(overlay);

    const box = document.createElement('div');
    box.className = 'dialog-box designer-nested';
    overlay.appendChild(box);

    const title = document.createElement('div');
    title.className = 'dialog-title';
    title.textContent = `${LM().TYPE_META[p.type].label} settings`;
    box.appendChild(title);

    const fields = ctx.paneConfigFields(box, p.type, { name: p.name, ...p.cfg });
    showSharedPlaceholders(fields);

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const okBtn = document.createElement('button');
    okBtn.className = 'toolbar-btn';
    okBtn.textContent = 'OK';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'toolbar-btn dialog-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    actions.append(okBtn, cancelBtn);
    box.appendChild(actions);

    fields.focus?.();

    const close = () => overlay.remove();
    const save = () => {
      const values = fields.read();
      const { name, ...cfg } = values;
      close();
      commit(LM().updatePanel(state.model, p.uid, { name, cfg }), { select: p.uid });
    };

    okBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter')  save();
      if (e.key === 'Escape') close();
    });
  }

  // Edit several panels of the same type at once.  Fields start with the value
  // the panels share (or empty, marked "mixed"); only the fields the user
  // changes are written back, so per-panel values survive.
  function editPanels(list) {
    const type = list[0].type;
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.style.zIndex = '250';
    document.body.appendChild(overlay);

    const box = document.createElement('div');
    box.className = 'dialog-box designer-nested';
    overlay.appendChild(box);

    const title = document.createElement('div');
    title.className = 'dialog-title';
    title.textContent = `${LM().TYPE_META[type].label} settings — ${list.length} panels`;
    box.appendChild(title);

    const fields = ctx.paneConfigFields(box, type, {});
    fields.refs.name?.closest('.dialog-field')?.remove();
    delete fields.refs.name;

    for (const [key, el] of Object.entries(fields.refs)) {
      const vals = list.map(p => el.type === 'checkbox' ? !!p.cfg[key] : (p.cfg[key] || ''));
      const same = vals.every(v => v === vals[0]);
      if (el.type === 'checkbox') {
        el.checked = same && vals[0];
        el.indeterminate = !same;
      } else {
        el.value = same ? vals[0] : '';
        if (!same && el.tagName === 'INPUT') el.placeholder = '(mixed — leave empty to keep)';
      }
    }
    showSharedPlaceholders(fields);

    const initial = fields.read();
    const mixedBoxes = new Set(Object.entries(fields.refs)
      .filter(([, el]) => el.indeterminate).map(([key]) => key));

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const okBtn = document.createElement('button');
    okBtn.className = 'toolbar-btn';
    okBtn.textContent = 'OK';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'toolbar-btn dialog-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    actions.append(okBtn, cancelBtn);
    box.appendChild(actions);

    Object.values(fields.refs)[0]?.focus?.();

    const close = () => overlay.remove();
    const save = () => {
      const values = fields.read();
      const patch = {};
      for (const [key, v] of Object.entries(values)) {
        const touched = mixedBoxes.has(key) ? !fields.refs[key].indeterminate : v !== initial[key];
        if (touched) patch[key] = v;
      }
      close();
      if (!Object.keys(patch).length) return;
      let m = state.model;
      for (const p of list) m = LM().updatePanel(m, p.uid, { cfg: patch });
      commit(m);
    };

    okBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter')  save();
      if (e.key === 'Escape') close();
    });
  }

  // Empty folder / shell fields show the shared value they fall back to.
  function showSharedPlaceholders(fields) {
    const d = state.model.defaults || {};
    for (const key of ['cwd', 'shell']) {
      const el = fields.refs[key];
      if (!el || el.tagName !== 'INPUT' || el.value || !d[key]) continue;
      if (el.placeholder.startsWith('(mixed')) continue;
      el.placeholder = `Shared: ${key === 'shell' ? shellLabel(d[key]) : d[key]}`;
    }
  }

  // ── Footer actions ────────────────────────────────────

  // Panels the user never configured would open blank; make them say so out
  // loud before the layout is applied or saved.
  async function confirmUnconfigured(question, yesLabel) {
    const blank = LM().unconfigured(state.model);
    if (!blank.length) return true;
    const many = blank.length > 1;
    return ctx.confirm(
      `${blank.length} panel${many ? 's' : ''} ${many ? 'have' : 'has'} no settings: ` +
      `${LM().describeUnconfigured(blank)}. ${question}`,
      yesLabel, 'Go back');
  }

  async function apply({ newTab }) {
    const v = LM().validate(state.model);
    if (!v.ok) return;
    if (!(await confirmUnconfigured('Open them empty?', 'Open empty'))) return;

    const doomed = state.baseline.panels.filter(p =>
      p.paneId != null && !state.model.panels.some(q => q.paneId === p.paneId));
    if (!newTab && doomed.length) {
      const names = doomed.map(p => LM().panelLabel(p)).join(', ');
      const ok = await ctx.confirm(
        `Close ${doomed.length} existing pane${doomed.length > 1 ? 's' : ''} (${names})?`, 'Close them', 'Cancel');
      if (!ok) return;
    }

    const model = LM().resolveDefaults(state.model);
    close();
    await ctx.applyModel(model, { newTab });
  }

  async function saveAsTemplate() {
    if (!(await confirmUnconfigured('Save them without settings?', 'Save anyway'))) return;

    const suggested = state.custom.length ? '' : 'My Layout';
    const name = await promptText('Save layout as', 'Layout name', suggested);
    if (!name) return;

    const existing = state.custom.find(l => l.name === name);
    if (existing && !(await ctx.confirm(`Overwrite the saved layout “${name}”?`, 'Overwrite', 'Cancel'))) return;

    const res = await window.electronAPI.saveCustomLayout({
      id: existing?.id,
      name,
      model: LM().toJSON(state.model),
    });
    if (res?.success) {
      state.custom = res.layouts || state.custom;
      ctx.onTemplatesChanged?.();
      renderSidebar();
      flash(`Saved “${name}”.`);
    } else {
      flash(res?.error || 'Could not save the layout.');
    }
  }

  function exportAscii() {
    const res = LM().modelToAscii(state.model, ctx.parseAsciiLayout);
    if (!res.ok) return flash(res.reason);
    window.electronAPI.writeClipboard(`[My Layout]\n${res.art}\n`);
    flash('ASCII layout copied to the clipboard.');
  }

  // ── Small text prompt ─────────────────────────────────
  function promptText(titleText, placeholder, initial = '') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      overlay.style.zIndex = '250';
      document.body.appendChild(overlay);

      const box = document.createElement('div');
      box.className = 'dialog-box designer-nested';
      overlay.appendChild(box);

      const title = document.createElement('div');
      title.className = 'dialog-title';
      title.textContent = titleText;

      const input = document.createElement('input');
      input.className = 'url-bar';
      input.type = 'text';
      input.spellcheck = false;
      input.placeholder = placeholder;
      input.value = initial;

      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      const okBtn = document.createElement('button');
      okBtn.className = 'toolbar-btn';
      okBtn.textContent = 'Save';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'toolbar-btn dialog-cancel-btn';
      cancelBtn.textContent = 'Cancel';
      actions.append(okBtn, cancelBtn);

      box.append(title, input, actions);
      input.focus();
      input.select();

      const finish = (value) => { overlay.remove(); resolve(value); };
      okBtn.addEventListener('click', () => finish(input.value.trim() || null));
      cancelBtn.addEventListener('click', () => finish(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
      box.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter')  finish(input.value.trim() || null);
        if (e.key === 'Escape') finish(null);
      });
    });
  }

  window.LayoutDesigner = { init, open, isOpen };
})();
