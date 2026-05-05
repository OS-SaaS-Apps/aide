(() => {
  const MAX_PANES = 6; // limit for the + button
  const GRID_AREAS = ['a','b','c','d','e','f','g','h','i','j','k','l'];

  // Inject --resume <sessionId> into a claude init command
  function withClaudeResume(initCmd, sessionId) {
    if (!sessionId || !initCmd) return initCmd || null;
    const base = initCmd.replace(/\s*--resume\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').trim();
    return base.replace(/(\bclaude(?:\.exe)?\b)/i, `$1 --resume ${sessionId}`);
  }

  const _urlParams     = new URLSearchParams(window.location.search);
  const isDetached     = _urlParams.has('detached');
  const detachedConfig = isDetached ? JSON.parse(_urlParams.get('config') || '{}') : null;

  const globalPanes = new Map();   // all panes across all tabs (for PTY routing)
  let draggedPaneId = null;        // pane currently being dragged (for swap)
  let lastFocusedTerminalId = null; // for STT injection
  const tabs = new Map();
  let activeTabId = null;
  let nextTabId = 1;
  let panes;   // → active tab's panes Map (updated by switchTab)
  let grid;    // → active tab's gridEl   (updated by switchTab)
  let nextId = 1;

  // ── Built-in fallback layouts (used when no config file is found) ─────────
  // Defined as ASCII art — same format as layouts.conf — so one parser handles both.
  const BUILTIN_ASCII = [
    { name: '1 Terminal',              art: '1'      },
    { name: '2 Terminals',             art: '11'     },
    { name: '2 Terminals Stacked',     art: '1\n1'   },
    { name: '3 Terminals',             art: '111'    },
    { name: '4 Terminals',             art: '11\n11' },
    { name: '1 Browser',               art: '2'      },
    { name: '2 Browsers',              art: '22'     },
    { name: 'Browser + Terminal',      art: '21'     },
    { name: 'Terminal / Browser',      art: '1\n2'   },
    { name: 'Terminal Wide + Browser', art: '1 2'    },
    { name: 'Browser Wide + Terminal', art: '2 1'    },
    { name: 'Terminal + 2 Browsers',   art: '12\n 2' },
    { name: 'Browser + 2 Terminals',   art: '21\n 1' },
    { name: '2 Browsers + 2 Terminals',art: '21\n21' },
    { name: 'Browser + 3 Terminals',   art: '21\n11' },
    { name: '1 Explorer',                   art: '3'       },
    { name: 'Explorer + Terminal',          art: '31'      },
    { name: 'Explorer + 2 Terminals',       art: '31\n 1'  },
    { name: 'Explorer + Browser',           art: '32'      },
    { name: 'Explorer + Terminal + Browser',art: '31\n 2'  },
    { name: '1 Text Editor',                    art: '4'       },
    { name: 'Text Editor + Terminal',           art: '41'      },
    { name: 'Text Editor + Explorer',           art: '43'      },
    { name: 'Text Editor Wide + Terminal',      art: '4 1'     },
    { name: 'Explorer + Text Editor + Terminal',art: '341'     },
  ];

  const DEFAULT_LAYOUT_BY_COUNT = {
    0: { gridClass: 'layout-solo',    areas: [] },
    1: { gridClass: 'layout-solo',    areas: ['a'] },
    2: { gridClass: 'layout-split-h', areas: ['a','b'] },
    3: { gridClass: 'layout-3-top',   areas: ['a','b','c'] },
    4: { gridClass: 'layout-quad',    areas: ['a','b','c','d'] },
    5: { gridCSS: { gridTemplateAreas: '"a b" "c d" "e e"', gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: 'repeat(3, 1fr)' }, areas: ['a','b','c','d','e'] },
    6: { gridCSS: { gridTemplateAreas: '"a b c" "d e f"', gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(2, 1fr)' }, areas: ['a','b','c','d','e','f'] },
  };

  // ── Layout parser ─────────────────────────────────────
  //
  // Rules:
  //   '1'         → new Terminal pane
  //   '2'         → new Browser pane
  //   '3'         → new Explorer pane
  //   '4'         → new Text Editor pane
  //   ' '         → extend the pane to the LEFT (same row),
  //                 or extend the pane ABOVE (if nothing to the left)
  //   shorter row → only the missing trailing column(s) extend from above;
  //                 characters present in the short row still create new panes
  //
  // Each new '1', '2', '3', or '4' is a distinct pane regardless of row length.
  // Spanning within a row is via spaces; trailing missing columns extend downward.

  function parseAsciiLayout(name, rows) {
    rows = rows.map(r => r.trimEnd()); // strip trailing spaces (editor artefacts)
    const nrows = rows.length;

    const ncols = Math.max(...rows.map(r => r.length));

    const letters = GRID_AREAS;
    let paneCount = 0;
    const paneSlots = []; // 'T', 'B', or 'E', in creation order

    // 2-D grid of assigned area letters (null = unassigned)
    const areaGrid = Array.from({ length: nrows }, () => new Array(ncols).fill(null));

    for (let r = 0; r < nrows; r++) {
      const rowLen = rows[r].length;
      for (let c = 0; c < ncols; c++) {
        if (c >= rowLen) {
          // Missing trailing column: extend the pane above downward
          if (r === 0 || areaGrid[r - 1][c] === null)
            throw new Error(`Column ${c + 1} is missing in row ${r + 1} and has nothing above to extend`);
          areaGrid[r][c] = areaGrid[r - 1][c];
          continue;
        }
        const ch = rows[r][c];
        if (ch === '1' || ch === '2' || ch === '3' || ch === '4') {
          if (paneCount >= letters.length)
            throw new Error(`Too many panes — maximum is ${letters.length}`);
          areaGrid[r][c] = letters[paneCount];
          paneSlots.push(ch === '1' ? 'T' : ch === '2' ? 'B' : ch === '3' ? 'E' : 'X');
          paneCount++;
        } else if (ch === ' ') {
          // Extend from above first (vertical span), then from left (horizontal span)
          if (r > 0 && areaGrid[r - 1][c] !== null) {
            areaGrid[r][c] = areaGrid[r - 1][c];
          } else if (c > 0 && areaGrid[r][c - 1] !== null) {
            areaGrid[r][c] = areaGrid[r][c - 1];
          } else {
            throw new Error(
              `Space at row ${r + 1} col ${c + 1} has no pane to extend (nothing above or to the left)`
            );
          }
        } else {
          throw new Error(`Invalid character '${ch}' — use 1 (terminal), 2 (browser), 3 (explorer), 4 (text editor), or space`);
        }
      }
    }

    // Validate each area forms a rectangle (required by CSS grid)
    for (let i = 0; i < paneCount; i++) {
      const letter = letters[i];
      const cells = [];
      for (let r = 0; r < nrows; r++)
        for (let c = 0; c < ncols; c++)
          if (areaGrid[r][c] === letter) cells.push({ r, c });

      const rs = cells.map(p => p.r);
      const cs = cells.map(p => p.c);
      const minR = Math.min(...rs), maxR = Math.max(...rs);
      const minC = Math.min(...cs), maxC = Math.max(...cs);
      if (cells.length !== (maxR - minR + 1) * (maxC - minC + 1))
        throw new Error(
          `Pane ${i + 1} (${paneSlots[i] === 'T' ? 'terminal' : paneSlots[i] === 'E' ? 'explorer' : paneSlots[i] === 'X' ? 'text' : 'browser'}) ` +
          `doesn't form a rectangle — check your spaces`
        );
    }

    // Build CSS grid-template-areas string
    const templateAreas = areaGrid
      .map(row => '"' + row.join(' ') + '"')
      .join(' ');

    // Build icon: 2D array of 1-based pane indices (for the mini preview)
    const letterToIdx = {};
    letters.slice(0, paneCount).forEach((l, i) => letterToIdx[l] = i + 1);
    const icon = areaGrid.map(row => row.map(cell => letterToIdx[cell]));

    return {
      label:   name,
      slots:   paneSlots,
      areas:   letters.slice(0, paneCount),
      gridCSS: {
        gridTemplateAreas:   templateAreas,
        gridTemplateColumns: `repeat(${ncols}, 1fr)`,
        gridTemplateRows:    `repeat(${nrows}, 1fr)`,
      },
      icon,
    };
  }

  function parseConfigFile(text) {
    const layouts = [];
    let currentName = null;
    let currentLines = [];

    const flush = () => {
      if (!currentName) return;
      // Trim leading/trailing blank lines only; keep interior spacer rows
      let s = 0, e = currentLines.length - 1;
      while (s <= e && currentLines[s].trim().length === 0) s++;
      while (e >= s && currentLines[e].trim().length === 0) e--;
      const art = currentLines.slice(s, e + 1);
      if (art.length > 0) {
        try {
          layouts.push(parseAsciiLayout(currentName, art));
        } catch (e) {
          console.warn(`Layout "${currentName}" skipped: ${e.message}`);
        }
      }
      currentName = null;
      currentLines = [];
    };

    for (const rawLine of text.split('\n')) {
      if (rawLine.trimStart().startsWith('#')) continue;
      const sectionMatch = rawLine.trim().match(/^\[(.+)\]$/);
      if (sectionMatch) {
        flush();
        currentName = sectionMatch[1].trim();
        continue;
      }
      if (currentName !== null) currentLines.push(rawLine); // preserve spaces
    }
    flush();
    return layouts;
  }

  function categorize(layouts) {
    return {
      terminal: layouts.filter(l => l.slots.every(s => s === 'T')),
      browser:  layouts.filter(l => l.slots.every(s => s === 'B')),
      explorer: layouts.filter(l => l.slots.every(s => s === 'E')),
      text:     layouts.filter(l => l.slots.every(s => s === 'X')),
      mixed:    layouts.filter(l => new Set(l.slots).size > 1),
    };
  }

  // ── Grid helpers ──────────────────────────────────────
  function setGrid(layout, areas) {
    if (layout.gridClass) {
      grid.className = 'tab-grid ' + layout.gridClass;
      grid.style.removeProperty('grid-template-areas');
      grid.style.removeProperty('grid-template-columns');
      grid.style.removeProperty('grid-template-rows');
    } else {
      grid.className = 'tab-grid';
      grid.style.gridTemplateAreas   = layout.gridCSS.gridTemplateAreas;
      grid.style.gridTemplateColumns = layout.gridCSS.gridTemplateColumns;
      grid.style.gridTemplateRows    = layout.gridCSS.gridTemplateRows;
    }
    const list = [...panes.values()];
    for (let i = 0; i < list.length; i++)
      list[i].element.style.gridArea = areas[i] || '';
    grid._updateResizeHandles?.();
  }

  function updateDefaultLayout() {
    const def = DEFAULT_LAYOUT_BY_COUNT[panes.size] || DEFAULT_LAYOUT_BY_COUNT[4];
    setGrid(def, def.areas);
  }

  // ── Panel resize handles ──────────────────────────────
  function setupGridResizing(gridEl) {
    const HANDLE_SIZE = 8;

    function parseTemplate(str) {
      return (str || '').trim().split(/\s+/).map(parseFloat).filter(n => !isNaN(n));
    }

    function gapCenterPos(sizes, gapIdx, gapPx) {
      let pos = 0;
      for (let j = 0; j <= gapIdx; j++) {
        pos += sizes[j];
        if (j < gapIdx) pos += gapPx;
      }
      return pos + gapPx / 2;
    }

    function updateHandles() {
      gridEl.querySelectorAll('.resize-handle').forEach(h => h.remove());
      const cs   = getComputedStyle(gridEl);
      const rows = parseTemplate(cs.gridTemplateRows);
      const cols = parseTemplate(cs.gridTemplateColumns);
      const rGap = parseFloat(cs.rowGap)    || 2;
      const cGap = parseFloat(cs.columnGap) || 2;
      const hs   = HANDLE_SIZE / 2;

      for (let i = 0; i < rows.length - 1; i++) {
        const center = gapCenterPos(rows, i, rGap);
        const h = document.createElement('div');
        h.className = 'resize-handle';
        h.style.cssText = `position:absolute;z-index:10;left:0;right:0;top:${center - hs}px;height:${HANDLE_SIZE}px;cursor:ns-resize`;
        h.addEventListener('mousedown', e => startDrag(e, h, 'row', i));
        gridEl.appendChild(h);
      }

      for (let i = 0; i < cols.length - 1; i++) {
        const center = gapCenterPos(cols, i, cGap);
        const h = document.createElement('div');
        h.className = 'resize-handle';
        h.style.cssText = `position:absolute;z-index:10;top:0;bottom:0;left:${center - hs}px;width:${HANDLE_SIZE}px;cursor:ew-resize`;
        h.addEventListener('mousedown', e => startDrag(e, h, 'col', i));
        gridEl.appendChild(h);
      }
    }

    function convertToInlineIfNeeded() {
      if (!gridEl.style.gridTemplateAreas) {
        const cs = getComputedStyle(gridEl);
        gridEl.style.gridTemplateAreas   = cs.gridTemplateAreas;
        gridEl.style.gridTemplateColumns = cs.gridTemplateColumns;
        gridEl.style.gridTemplateRows    = cs.gridTemplateRows;
        gridEl.className = 'tab-grid';
      }
    }

    function startDrag(e, handle, type, index) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      convertToInlineIfNeeded();
      const cs    = getComputedStyle(gridEl);
      const sizes = parseTemplate(type === 'row' ? cs.gridTemplateRows : cs.gridTemplateColumns);
      const gapPx = parseFloat(type === 'row' ? cs.rowGap : cs.columnGap) || 2;
      const start = type === 'row' ? e.clientY : e.clientX;
      const hs    = HANDLE_SIZE / 2;
      const MIN   = 60;

      // Full-screen overlay captures all mouse events, preventing xterm/webview
      // from intercepting mousemove/mouseup via stopPropagation.
      const overlay = document.createElement('div');
      overlay.style.cssText = `position:fixed;inset:0;z-index:9999;cursor:${type === 'row' ? 'ns-resize' : 'ew-resize'}`;
      document.body.appendChild(overlay);

      // Also disable pointer events on webviews (Electron compositor layer)
      const webviews = document.querySelectorAll('webview');
      webviews.forEach(wv => wv.style.pointerEvents = 'none');

      function onMove(me) {
        const delta    = (type === 'row' ? me.clientY : me.clientX) - start;
        const total    = sizes[index] + sizes[index + 1];
        const newA     = Math.max(MIN, Math.min(total - MIN, sizes[index] + delta));
        const newB     = total - newA;
        const newSizes = sizes.map((s, j) => j === index ? newA : j === index + 1 ? newB : s);
        const tmpl     = newSizes.map(s => `${s}px`).join(' ');
        if (type === 'row') gridEl.style.gridTemplateRows    = tmpl;
        else                gridEl.style.gridTemplateColumns = tmpl;
        const center = gapCenterPos(newSizes, index, gapPx);
        if (type === 'row') handle.style.top  = `${center - hs}px`;
        else                handle.style.left = `${center - hs}px`;
        refitAll();
      }

      function onUp() {
        overlay.remove();
        webviews.forEach(wv => wv.style.pointerEvents = '');
        overlay.removeEventListener('mousemove', onMove);
        overlay.removeEventListener('mouseup',   onUp);
        requestAnimationFrame(updateHandles);
        refitAll();
      }

      overlay.addEventListener('mousemove', onMove);
      overlay.addEventListener('mouseup',   onUp);
    }

    gridEl._updateResizeHandles = () => requestAnimationFrame(updateHandles);
    requestAnimationFrame(updateHandles);
  }

  // ── Layout icon (mini grid preview) ──────────────────
  function makeLayoutIcon(layout) {
    const rows    = layout.icon;
    const nrows   = rows.length;
    const ncols   = rows[0].length;
    const letters = ['a', 'b', 'c', 'd', 'e', 'f'];

    const templateAreas = rows
      .map(row => `"${row.map(n => letters[n - 1]).join(' ')}"`)
      .join(' ');

    const div = document.createElement('div');
    div.className = 'layout-icon';
    div.style.gridTemplateAreas   = templateAreas;
    div.style.gridTemplateRows    = `repeat(${nrows}, 1fr)`;
    div.style.gridTemplateColumns = `repeat(${ncols}, 1fr)`;

    const seen = new Set();
    for (const row of rows) {
      for (const idx of row) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const cell = document.createElement('div');
        cell.style.gridArea = letters[idx - 1];
        const slot = layout.slots[idx - 1];
        const iconType = slot === 'T' ? 'terminal' : slot === 'E' ? 'explorer' : slot === 'X' ? 'text' : 'browser';
        cell.className = `icon-cell icon-${iconType}`;
        div.appendChild(cell);
      }
    }
    return div;
  }

  // ── View menu ─────────────────────────────────────────
  function buildViewMenu(viewMenu, categorized) {
    viewMenu.innerHTML = '';
    const cats = [
      { key: 'terminal', label: 'Terminals'    },
      { key: 'browser',  label: 'Browsers'     },
      { key: 'explorer', label: 'Explorers'    },
      { key: 'text',     label: 'Text Editors' },
      { key: 'mixed',    label: 'Mixed'        },
    ];
    for (const cat of cats) {
      const list = categorized[cat.key];
      if (!list || !list.length) continue;
      const section = document.createElement('div');
      section.className = 'dropdown-section';
      section.textContent = cat.label;
      viewMenu.appendChild(section);
      for (const layout of list) {
        const item = document.createElement('button');
        item.className = 'dropdown-item';
        item.appendChild(makeLayoutIcon(layout));
        const label = document.createElement('span');
        label.textContent = layout.label;
        item.appendChild(label);
        item.addEventListener('click', async () => {
          viewMenu.classList.add('hidden');
          await applyLayout(layout);
        });
        viewMenu.appendChild(item);
      }
    }
    const sep = document.createElement('div');
    sep.className = 'dropdown-sep';
    viewMenu.appendChild(sep);
    const customBtn = document.createElement('button');
    customBtn.className = 'dropdown-item dropdown-footer-item';
    customBtn.textContent = '✏️ Custom…';
    customBtn.addEventListener('click', () => {
      viewMenu.classList.add('hidden');
      openCustomLayoutDialog();
    });
    viewMenu.appendChild(customBtn);
    const sep2 = document.createElement('div');
    sep2.className = 'dropdown-sep';
    viewMenu.appendChild(sep2);
    const footer = document.createElement('button');
    footer.className = 'dropdown-item dropdown-footer-item';
    footer.textContent = '📄 Open config file';
    footer.addEventListener('click', () => {
      viewMenu.classList.add('hidden');
      window.electronAPI.openConfigFile();
    });
    viewMenu.appendChild(footer);
  }

  // ── Custom layout dialog ──────────────────────────────
  function openCustomLayoutDialog() {
    const overlay  = document.getElementById('custom-layout-dialog');
    const input    = document.getElementById('custom-layout-input');
    const errorEl  = document.getElementById('custom-layout-error');
    const okBtn    = document.getElementById('custom-layout-ok');
    const cancelBtn = document.getElementById('custom-layout-cancel');

    input.value = '';
    errorEl.style.display = 'none';
    overlay.classList.remove('hidden');
    input.focus();

    function close() {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKey);
    }

    async function onOk() {
      const raw = input.value;
      if (!raw.trim()) {
        errorEl.textContent = 'Please enter a layout.';
        errorEl.style.display = '';
        return;
      }
      const rows = raw.split('\n');
      let layout;
      try {
        layout = parseAsciiLayout('Custom', rows);
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = '';
        return;
      }
      close();
      await applyLayout(layout);
    }

    function onCancel() { close(); }

    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKey);
  }

  // ── Shell submenu ─────────────────────────────────────
  function buildShellSubmenu(shells) {
    const wrapper  = document.getElementById('shell-submenu-wrapper');
    const submenu  = document.getElementById('shell-submenu');
    const addMenu  = document.getElementById('add-menu');

    for (const sh of shells) {
      const btn = document.createElement('button');
      btn.className   = 'dropdown-item';
      btn.textContent = '⬛ ' + sh.label;
      btn.addEventListener('click', () => {
        addMenu.classList.add('hidden');
        submenu.classList.add('hidden');
        addPane('terminal', sh.path);
      });
      submenu.appendChild(btn);
    }

    wrapper.addEventListener('mouseenter', () => submenu.classList.remove('hidden'));
    wrapper.addEventListener('mouseleave', () => submenu.classList.add('hidden'));
    submenu.addEventListener('mouseenter',  () => submenu.classList.remove('hidden'));
    submenu.addEventListener('mouseleave',  () => submenu.classList.add('hidden'));
  }

  // ── File explorer ─────────────────────────────────────
  const explorerClipboard = { type: null, path: null };
  let _ctxMenuEl = null;

  function getCtxMenu() {
    return _ctxMenuEl || (_ctxMenuEl = document.getElementById('explorer-ctx-menu'));
  }

  function hideCtxMenu() { getCtxMenu().classList.add('hidden'); }

  function showCtxMenu(items, x, y) {
    const menu = getCtxMenu();
    menu.innerHTML = '';
    for (const item of items) {
      if (item.sep) {
        const d = document.createElement('div');
        d.className = 'ctx-menu-sep';
        menu.appendChild(d);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'ctx-menu-item' + (item.disabled ? ' disabled' : '');
      const ic = document.createElement('span'); ic.className = 'ctx-icon'; ic.textContent = item.icon || '';
      const lb = document.createElement('span'); lb.textContent = item.label;
      el.append(ic, lb);
      if (!item.disabled && item.action)
        el.addEventListener('click', () => { hideCtxMenu(); item.action(); });
      if (!item.disabled && item.onContextMenu)
        el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); item.onContextMenu(); });
      menu.appendChild(el);
    }
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.classList.remove('hidden');
    // Flip if overflowing viewport
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + 'px';
    if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';
  }

  document.addEventListener('click',      (e) => { if (!e.target.closest('#explorer-ctx-menu')) hideCtxMenu(); });
  document.addEventListener('keydown',    (e) => { if (e.key === 'Escape') hideCtxMenu(); });
  document.addEventListener('contextmenu',(e) => { if (!e.target.closest('.explorer-tree') && !e.target.closest('#explorer-ctx-menu')) hideCtxMenu(); });

  function promptInlineCreate(tree, targetDir, isDir, onCreated) {
    tree.querySelector('.explorer-inline-create')?.remove();
    const row = document.createElement('div');
    row.className = 'explorer-item explorer-inline-create';
    row.style.paddingLeft = '6px';
    const ic = document.createElement('span'); ic.className = 'explorer-item-icon'; ic.textContent = isDir ? '📁' : '📄';
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'explorer-inline-input';
    input.placeholder = isDir ? 'folder name' : 'file.ext';
    row.append(ic, input);
    tree.prepend(row);
    input.focus();
    const commit = async () => {
      const name = input.value.trim();
      row.remove();
      if (!name) return;
      const result = await (isDir ? window.electronAPI.createDir(targetDir, name) : window.electronAPI.createFile(targetDir, name));
      if (!result.success) console.error('Create failed:', result.error);
      onCreated();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.stopPropagation(); commit(); }
      if (e.key === 'Escape') { e.stopPropagation(); row.remove(); }
    });
    input.addEventListener('blur', () => { if (document.body.contains(row)) row.remove(); });
  }

  function promptInlineRename(item, entry, onRefresh) {
    const nameSpan = item.querySelector('.explorer-item-name');
    if (!nameSpan) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'explorer-inline-input';
    input.value = entry.name;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    const commit = async () => {
      const newName = input.value.trim();
      input.replaceWith(nameSpan);
      if (!newName || newName === entry.name) return;
      const result = await window.electronAPI.renameItem(entry.path, newName);
      if (!result.success) console.error('Rename failed:', result.error);
      onRefresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.stopPropagation(); commit(); }
      if (e.key === 'Escape') { e.stopPropagation(); input.replaceWith(nameSpan); }
    });
    input.addEventListener('blur', commit);
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function sortEntries(entries, sortKey) {
    return [...entries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      switch (sortKey) {
        case 'name-asc':  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        case 'name-desc': return b.name.localeCompare(a.name, undefined, { sensitivity: 'base' });
        case 'date-asc':  return (a.mtime || 0) - (b.mtime || 0);
        case 'date-desc': return (b.mtime || 0) - (a.mtime || 0);
        case 'size-asc':  return (a.size  || 0) - (b.size  || 0);
        case 'size-desc': return (b.size  || 0) - (a.size  || 0);
        case 'type': {
          const extA = a.name.includes('.') ? a.name.split('.').pop().toLowerCase() : '';
          const extB = b.name.includes('.') ? b.name.split('.').pop().toLowerCase() : '';
          const cmp = extA.localeCompare(extB);
          return cmp !== 0 ? cmp : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        }
        default: return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
    });
  }

  async function renderExplorer(tree, rootPath, expanded, onRefresh, sortKey = 'name-asc') {
    tree.innerHTML = '';
    if (!rootPath) return;
    await renderExplorerLevel(tree, rootPath, 0, expanded, onRefresh, sortKey);
  }

  async function renderExplorerLevel(container, dirPath, depth, expanded, onRefresh, sortKey = 'name-asc') {
    const raw = await window.electronAPI.readDir(dirPath);
    const entries = sortEntries(raw, sortKey);
    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'explorer-item' + (entry.isDirectory ? '' : ' is-file');
      item.style.paddingLeft = (depth * 16 + 6) + 'px';

      const arrow = document.createElement('span');
      arrow.className = 'explorer-arrow';
      arrow.textContent = entry.isDirectory ? (expanded.has(entry.path) ? '▾' : '▸') : '';

      const icon = document.createElement('span');
      icon.className = 'explorer-item-icon';
      icon.textContent = entry.isDirectory ? (expanded.has(entry.path) ? '📂' : '📁') : '📄';

      const name = document.createElement('span');
      name.className = 'explorer-item-name';
      name.textContent = entry.name;

      const sizeEl = document.createElement('span');
      sizeEl.className = 'explorer-item-size';
      sizeEl.textContent = entry.isDirectory ? '' : formatFileSize(entry.size || 0);

      const dateEl = document.createElement('span');
      dateEl.className = 'explorer-item-date';
      dateEl.textContent = entry.mtime ? new Date(entry.mtime).toLocaleDateString() : '';

      item.append(arrow, icon, name, sizeEl, dateEl);
      container.appendChild(item);

      if (entry.isDirectory) {
        if (expanded.has(entry.path))
          await renderExplorerLevel(container, entry.path, depth + 1, expanded, onRefresh, sortKey);

        item.addEventListener('click', (e) => {
          e.stopPropagation();
          if (expanded.has(entry.path)) {
            for (const p of [...expanded])
              if (p === entry.path || p.startsWith(entry.path + '\\') || p.startsWith(entry.path + '/'))
                expanded.delete(p);
          } else {
            expanded.add(entry.path);
          }
          onRefresh();
        });
      }

      // ── Drag source (file path → terminal drop) ─────────
      item.draggable = true;
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', entry.path);
        e.dataTransfer.effectAllowed = 'copy';
      });

      // ── Right-click context menu ────────────────────────
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        const cb = explorerClipboard;
        const hasCb = !!cb.path;
        const treeEl = container.closest('.explorer-tree') || container;

        if (entry.isDirectory) {
          showCtxMenu([
            { icon: '⬛', label: 'CMD Here', action: () => window.electronAPI.cmdHere(entry.path) },
            { sep: true },
            { icon: '📁', label: 'New Folder', action: () => promptInlineCreate(treeEl, entry.path, true,  onRefresh) },
            { icon: '📄', label: 'New File',   action: () => promptInlineCreate(treeEl, entry.path, false, onRefresh) },
            { sep: true },
            { icon: '📋', label: 'Copy',   action: () => { cb.type = 'copy'; cb.path = entry.path; } },
            { icon: '✂',  label: 'Cut',    action: () => { cb.type = 'cut';  cb.path = entry.path; } },
            { icon: '📋', label: 'Paste',  disabled: !hasCb, action: !hasCb ? null : async () => {
              await window.electronAPI.pasteItem(cb.path, entry.path, cb.type === 'cut');
              if (cb.type === 'cut') cb.path = null;
              onRefresh();
            }},
            { icon: '✏️', label: 'Rename', action: () => promptInlineRename(item, entry, onRefresh) },
            { sep: true },
            { icon: '🗑', label: 'Delete', action: async () => { await window.electronAPI.deleteItem(entry.path); onRefresh(); } },
          ], e.clientX, e.clientY);
        } else {
          showCtxMenu([
            { icon: '📝', label: 'Open in Notepad', action: () => window.electronAPI.openNotepad(entry.path) },
            { icon: '🔗', label: 'Open',             action: () => window.electronAPI.openFile(entry.path) },
            { sep: true },
            { icon: '📋', label: 'Copy',   action: () => { cb.type = 'copy'; cb.path = entry.path; } },
            { icon: '✂',  label: 'Cut',    action: () => { cb.type = 'cut';  cb.path = entry.path; } },
            { icon: '📋', label: 'Paste',  disabled: !hasCb, action: !hasCb ? null : async () => {
              await window.electronAPI.pasteItem(cb.path, dirPath, cb.type === 'cut');
              if (cb.type === 'cut') cb.path = null;
              onRefresh();
            }},
            { icon: '✏️', label: 'Rename', action: () => promptInlineRename(item, entry, onRefresh) },
            { sep: true },
            { icon: '🗑', label: 'Delete', action: async () => { await window.electronAPI.deleteItem(entry.path); onRefresh(); } },
          ], e.clientX, e.clientY);
        }
      });
    }
  }

  // ── Terminal setup dialog ─────────────────────────────
  function showTerminalSetupDialog(title = 'New Terminal') {
    return new Promise(resolve => {
      const overlay   = document.getElementById('term-dialog');
      const titleEl   = document.getElementById('term-dialog-title');
      const cwdInput  = document.getElementById('term-dialog-cwd');
      const cmdInput  = document.getElementById('term-dialog-cmd');
      const browseBtn = document.getElementById('term-dialog-browse');
      const okBtn     = document.getElementById('term-dialog-ok');
      const cancelBtn = document.getElementById('term-dialog-cancel');

      titleEl.textContent = title;
      cwdInput.value = '';
      cmdInput.value = '';
      overlay.classList.remove('hidden');
      cmdInput.focus();

      const finish = (cwd, command) => {
        overlay.classList.add('hidden');
        browseBtn.removeEventListener('click', onBrowse);
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlayClick);
        cwdInput.removeEventListener('keydown', onKey);
        cmdInput.removeEventListener('keydown', onKey);
        resolve({ cwd: cwd || null, command: command || null });
      };

      const onBrowse = async () => {
        const dir = await window.electronAPI.openDirectoryPicker();
        if (dir) cwdInput.value = dir;
      };
      const onOk     = () => finish(cwdInput.value.trim(), cmdInput.value.trim());
      const onCancel = () => finish(null, null);
      const onKey    = (e) => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
      const onOverlayClick = (e) => { if (e.target === overlay) onCancel(); };

      browseBtn.addEventListener('click', onBrowse);
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      cwdInput.addEventListener('keydown', onKey);
      cmdInput.addEventListener('keydown', onKey);
      overlay.addEventListener('click', onOverlayClick);
    });
  }

  // ── Generic confirm dialog ────────────────────────────
  function showConfirmDialog(message, yesLabel = 'Yes', noLabel = 'No') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      overlay.tabIndex = -1;
      document.body.appendChild(overlay);

      const box = document.createElement('div');
      box.className = 'dialog-box';
      overlay.appendChild(box);

      const msg = document.createElement('div');
      msg.className = 'dialog-title';
      msg.style.marginBottom = '16px';
      msg.textContent = message;
      box.appendChild(msg);

      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      box.appendChild(actions);

      const noBtn = document.createElement('button');
      noBtn.className = 'dialog-cancel-btn';
      noBtn.textContent = noLabel;

      const yesBtn = document.createElement('button');
      yesBtn.className = 'toolbar-btn';
      yesBtn.textContent = yesLabel;

      actions.append(noBtn, yesBtn);

      const finish = (result) => {
        document.body.removeChild(overlay);
        resolve(result);
      };

      yesBtn.addEventListener('click', () => finish(true));
      noBtn.addEventListener('click',  () => finish(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.stopPropagation(); finish(true); }
        if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      });
      overlay.focus();
    });
  }

  // ── Pane settings dialog ──────────────────────────────
  function showPaneSettingsDialog(pane) {
    if (!pane) return;

    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    document.body.appendChild(overlay);

    const box = document.createElement('div');
    box.className = 'dialog-box';
    overlay.appendChild(box);

    const dlgTitle = document.createElement('div');
    dlgTitle.className = 'dialog-title';
    dlgTitle.textContent = 'Pane Settings';
    box.appendChild(dlgTitle);

    function makeField(labelText, hintText, inputEl) {
      const field = document.createElement('div');
      field.className = 'dialog-field';
      const lbl = document.createElement('label');
      lbl.className = 'dialog-label';
      lbl.textContent = labelText;
      if (hintText) {
        const hint = document.createElement('span');
        hint.className = 'dialog-hint';
        hint.textContent = ' ' + hintText;
        lbl.appendChild(hint);
      }
      field.append(lbl, inputEl);
      box.appendChild(field);
    }

    function makeInput(value, placeholder) {
      const inp = document.createElement('input');
      inp.className = 'url-bar';
      inp.type = 'text';
      inp.spellcheck = false;
      inp.value = value || '';
      inp.placeholder = placeholder || '';
      return inp;
    }

    function makeRowWithBrowse(inp, browseCallback) {
      const row = document.createElement('div');
      row.className = 'dialog-row';
      const btn = document.createElement('button');
      btn.className = 'toolbar-btn';
      btn.textContent = 'Browse…';
      btn.addEventListener('click', browseCallback);
      row.append(inp, btn);
      return row;
    }

    let nameInput = null;
    let shellInput = null, cwdInput = null, initCmdInput = null;
    let urlInput = null;
    let dirInput = null;
    let fileInput = null;

    if (pane.type === 'terminal' || pane.type === 'browser') {
      nameInput = makeInput(pane.name, 'Panel name');
      makeField('Name', '', nameInput);
    }

    if (pane.type === 'terminal') {
      shellInput = makeInput(pane.shell || '', 'Default shell');
      makeField('Shell', '(applies on restart)', shellInput);

      cwdInput = makeInput(pane.cwd || '', 'Default directory');
      const cwdRow = makeRowWithBrowse(cwdInput, async () => {
        const dir = await window.electronAPI.openDirectoryPicker();
        if (dir) cwdInput.value = dir;
      });
      const cwdField = document.createElement('div');
      cwdField.className = 'dialog-field';
      const cwdLbl = document.createElement('label');
      cwdLbl.className = 'dialog-label';
      cwdLbl.innerHTML = 'Working Directory <span class="dialog-hint">(applies on restart)</span>';
      cwdField.append(cwdLbl, cwdRow);
      box.appendChild(cwdField);

      initCmdInput = makeInput(pane.initCommand || '', 'e.g. npm run dev');
      makeField('Init Command', '(applies on restart)', initCmdInput);

    } else if (pane.type === 'browser') {
      urlInput = makeInput(pane.urlInput?.value || '', 'https://');
      makeField('URL', '', urlInput);

    } else if (pane.type === 'explorer') {
      dirInput = makeInput(pane.cwd || '', 'Directory path');
      const dirRow = makeRowWithBrowse(dirInput, async () => {
        const dir = await window.electronAPI.openDirectoryPicker();
        if (dir) dirInput.value = dir;
      });
      const dirField = document.createElement('div');
      dirField.className = 'dialog-field';
      const dirLbl = document.createElement('label');
      dirLbl.className = 'dialog-label';
      dirLbl.textContent = 'Directory';
      dirField.append(dirLbl, dirRow);
      box.appendChild(dirField);

    } else if (pane.type === 'text') {
      fileInput = makeInput(pane.filePath || '', 'File path');
      const fileRow = makeRowWithBrowse(fileInput, async () => {
        const fp = await window.electronAPI.openFilePicker([
          { name: 'Text / Code', extensions: ['txt','md','json','xml','html','css','js','ts','py','yaml','conf','log'] },
          { name: 'All Files', extensions: ['*'] },
        ]);
        if (fp) fileInput.value = fp;
      });
      const fileField = document.createElement('div');
      fileField.className = 'dialog-field';
      const fileLbl = document.createElement('label');
      fileLbl.className = 'dialog-label';
      fileLbl.textContent = 'File';
      fileField.append(fileLbl, fileRow);
      box.appendChild(fileField);
    }

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const okBtn = document.createElement('button');
    okBtn.className = 'toolbar-btn';
    okBtn.textContent = 'Apply';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'toolbar-btn dialog-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    actions.append(okBtn, cancelBtn);
    box.appendChild(actions);

    const firstInput = nameInput || shellInput || dirInput || fileInput || urlInput;
    if (firstInput) { firstInput.focus(); firstInput.select(); }

    const close = () => document.body.removeChild(overlay);

    const apply = async () => {
      if (nameInput) {
        const newName = nameInput.value.trim();
        if (newName) {
          pane.name = newName;
          const titleSpan = pane.element.querySelector('.pane-title');
          if (titleSpan) titleSpan.textContent = newName;
        }
      }
      if (pane.type === 'terminal') {
        pane.shell       = shellInput.value.trim() || null;
        pane.cwd         = cwdInput.value.trim() || null;
        pane.initCommand = initCmdInput.value.trim() || null;
      } else if (pane.type === 'browser') {
        let url = urlInput.value.trim();
        if (url) {
          if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
          pane.urlInput.value = url;
          pane.webview.setAttribute('src', url);
        }
      } else if (pane.type === 'explorer') {
        const path = dirInput.value.trim();
        if (path && pane.navigate) await pane.navigate(path);
      } else if (pane.type === 'text') {
        const fp = fileInput.value.trim();
        if (fp && pane.openFile) await pane.openFile(fp);
      }
      close();
    };

    okBtn.addEventListener('click', apply);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.stopPropagation(); apply(); }
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
  }

  // ── Sessions ──────────────────────────────────────────
  function showSaveSessionInput(menu) {
    menu.innerHTML = '';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:5px 8px;';

    const input = document.createElement('input');
    input.type        = 'text';
    input.className   = 'url-bar';
    input.placeholder = 'Session name…';
    input.value       = new Date().toLocaleString();
    input.style.flex  = '1';

    const okBtn = document.createElement('button');
    okBtn.className   = 'toolbar-btn';
    okBtn.textContent = 'Save';
    okBtn.style.cssText = 'padding:3px 8px;font-size:11px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.className   = 'toolbar-btn';
    cancelBtn.textContent = '✕';
    cancelBtn.style.cssText = 'padding:3px 6px;font-size:11px;background:#3e3e42;';

    row.append(input, okBtn, cancelBtn);
    menu.appendChild(row);
    input.focus();
    input.select();

    const doSave = async () => {
      const name = input.value.trim();
      if (name) await saveSession(name, menu);
      else await buildSessionMenu(menu);
    };
    okBtn.addEventListener('click', doSave);
    cancelBtn.addEventListener('click', () => buildSessionMenu(menu));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSave();
      if (e.key === 'Escape') buildSessionMenu(menu);
      e.stopPropagation();
    });
  }

  async function buildSessionMenu(menu) {
    menu.innerHTML = '';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'dropdown-item';
    saveBtn.textContent = '💾 Save current session…';
    saveBtn.addEventListener('click', () => showSaveSessionInput(menu));
    menu.appendChild(saveBtn);

    const sessions = await window.electronAPI.listSessions();
    if (sessions.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'dropdown-sep';
      menu.appendChild(sep);

      const section = document.createElement('div');
      section.className = 'dropdown-section';
      section.textContent = 'Saved Sessions';
      menu.appendChild(section);

      for (const s of [...sessions].reverse()) {
        const item = document.createElement('div');
        item.className = 'dropdown-item session-item';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = s.name;

        const delBtn = document.createElement('button');
        delBtn.className = 'session-delete-btn';
        delBtn.textContent = '✕';
        delBtn.title = 'Delete session';
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.electronAPI.deleteSession(s.id);
          await buildSessionMenu(menu);
        });

        item.append(nameSpan, delBtn);
        item.addEventListener('click', async () => {
          menu.classList.add('hidden');
          try {
            await createTab(s.name);
            await loadSession(s);
          } catch (err) { console.error('Session load error:', err); }
        });
        menu.appendChild(item);
      }
    }
  }

  async function saveSession(name, menu) {
    const panesData = await Promise.all([...panes.values()].map(async (pane) => {
      if (pane.type === 'explorer') {
        return {
          gridArea: pane.element.style.gridArea || '',
          type: 'explorer',
          name: pane.name || null,
          cwd: pane.cwd || null,
        };
      } else if (pane.type === 'terminal') {
        const info = pane.ptyCreated
          ? await window.electronAPI.getPaneInfo(pane.id)
          : { cwd: null, command: null };
        return {
          gridArea: pane.element.style.gridArea || '',
          type: 'terminal',
          name: pane.name || null,
          shell: pane.shell,
          cwd: info.cwd || pane.cwd || null,
          initCommand: pane.initCommand || null,
          claudeSessionId: pane.claudeSessionId || undefined,
          command: pane.lastCommand || info.command || null,
          predefinedCommands: pane.predefinedCommands?.length ? pane.predefinedCommands : undefined,
        };
      } else if (pane.type === 'text') {
        return {
          gridArea: pane.element.style.gridArea || '',
          type: 'text',
          name: pane.name || null,
          filePath: pane.filePath || null,
        };
      } else {
        return {
          gridArea: pane.element.style.gridArea || '',
          type: 'browser',
          name: pane.name || null,
          url: pane.urlInput?.value || 'https://www.google.com',
        };
      }
    }));

    // Save the raw inline style strings (reliable) + class name for CSS-class-based layouts
    const session = {
      id: Date.now(),
      name,
      savedAt: new Date().toISOString(),
      gridClass:             grid.className.replace(/\btab-grid\b|\bhidden\b/g, '').trim(),
      gridTemplateAreas:     grid.style.gridTemplateAreas,
      gridTemplateColumns:   grid.style.gridTemplateColumns,
      gridTemplateRows:      grid.style.gridTemplateRows,
      panes: panesData,
    };

    await window.electronAPI.saveSession(session);
    if (menu) await buildSessionMenu(menu);
  }

  // Convert absolute px track sizes to fr units so the layout scales to any
  // screen resolution.  If the template contains no px values it is returned
  // unchanged (fr / repeat() strings are already resolution-independent).
  function normalizePxToFr(template) {
    if (!template || !template.includes('px')) return template;
    const values = template.trim().split(/\s+/).map(v => parseFloat(v));
    const total  = values.reduce((a, b) => a + b, 0);
    if (!total) return template;
    return values.map(v => `${+(v / total).toFixed(6)}fr`).join(' ');
  }

  async function loadSession(session, skipPtyInit = false) {
    for (const id of [...panes.keys()]) destroyPane(id);

    // Restore grid layout exactly as it was saved
    const savedClass = (session.gridClass || '').replace(/\btab-grid\b|\bhidden\b/g, '').trim();
    grid.className = savedClass ? 'tab-grid ' + savedClass : 'tab-grid';
    if (session.gridTemplateAreas) {
      grid.style.gridTemplateAreas   = session.gridTemplateAreas;
      grid.style.gridTemplateColumns = normalizePxToFr(session.gridTemplateColumns);
      grid.style.gridTemplateRows    = normalizePxToFr(session.gridTemplateRows);
    } else {
      grid.style.removeProperty('grid-template-areas');
      grid.style.removeProperty('grid-template-columns');
      grid.style.removeProperty('grid-template-rows');
    }
    grid._updateResizeHandles?.();

    for (const pd of session.panes) {
      // For text panes, filePath is passed via cwd slot
      const initCwd = pd.type === 'text' ? (pd.filePath || null) : (pd.cwd || null);
      const initCmd = pd.type === 'terminal'
        ? withClaudeResume(pd.initCommand || null, pd.claudeSessionId || null)
        : (pd.initCommand || null);
      createPane(pd.type, pd.gridArea || null, pd.shell || null, initCwd, initCmd, pd.name || null, pd.type === 'browser' ? (pd.url || null) : null, pd.predefinedCommands || null);
    }

    updateAddButton();
    if (!skipPtyInit) await initNewTerminals();
  }

  // ── Dropdown setup ────────────────────────────────────
  function setupDropdowns() {
    const btnAdd      = document.getElementById('btn-add');
    const addMenu     = document.getElementById('add-menu');
    const btnView     = document.getElementById('btn-view');
    const viewMenu    = document.getElementById('view-menu');
    const btnSessions = document.getElementById('btn-sessions');
    const sessionsMenu= document.getElementById('sessions-menu');

    const allMenus = [addMenu, viewMenu, sessionsMenu];

    function closeAll() { allMenus.forEach(m => m.classList.add('hidden')); }

    function toggleMenu(menu) {
      const wasOpen = !menu.classList.contains('hidden');
      closeAll();
      if (!wasOpen) menu.classList.remove('hidden');
    }

    btnAdd.addEventListener('click',  (e) => { e.stopPropagation(); toggleMenu(addMenu); });
    btnView.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(viewMenu); });
    btnSessions.addEventListener('click', async (e) => {
      e.stopPropagation();
      const wasOpen = !sessionsMenu.classList.contains('hidden');
      closeAll();
      if (!wasOpen) {
        await buildSessionMenu(sessionsMenu);
        sessionsMenu.classList.remove('hidden');
      }
    });

    document.addEventListener('click', closeAll);
    allMenus.forEach(m => m.addEventListener('click', (e) => e.stopPropagation()));

    document.getElementById('btn-add-browser').addEventListener('click', () => {
      addMenu.classList.add('hidden');
      addPane('browser');
    });
    document.getElementById('btn-add-explorer').addEventListener('click', () => {
      addMenu.classList.add('hidden');
      addPane('explorer');
    });
    document.getElementById('btn-add-text').addEventListener('click', () => {
      addMenu.classList.add('hidden');
      addPane('text');
    });
  }

  // ── Apply layout ──────────────────────────────────────
  async function applyLayout(layout) {
    const slots    = layout.slots;
    const existing = [...panes.values()];
    const pool     = { terminal: [], browser: [], explorer: [], text: [] };
    for (const p of existing) pool[p.type]?.push(p);

    const matched = slots.map(slot => {
      const type = slot === 'T' ? 'terminal' : slot === 'E' ? 'explorer' : slot === 'X' ? 'text' : 'browser';
      return pool[type].length > 0 ? pool[type].shift() : null;
    });
    for (const arr of Object.values(pool))
      for (const p of arr) destroyPane(p.id);

    // Ask for setup before touching the DOM
    const newSetups = [];
    const newTermCount = matched.filter((m, i) => m === null && slots[i] === 'T').length;
    let termIdx = 0;

    let sharedTermSetup = null;
    if (newTermCount > 1) {
      const useSame = await showConfirmDialog(
        `Apply the same initial command to all ${newTermCount} new terminals?`
      );
      if (useSame) {
        sharedTermSetup = await showTerminalSetupDialog('Configure All New Terminals');
      }
    }

    for (let i = 0; i < slots.length; i++) {
      if (matched[i] === null && slots[i] === 'T') {
        termIdx++;
        if (sharedTermSetup) {
          newSetups.push({ cwd: sharedTermSetup.cwd, command: sharedTermSetup.command, name: `Terminal ${termIdx}` });
        } else {
          const title = newTermCount > 1 ? `New Terminal ${termIdx} of ${newTermCount}` : 'New Terminal';
          newSetups.push(await showTerminalSetupDialog(title));
        }
      } else if (matched[i] === null && slots[i] === 'E') {
        const dir = await window.electronAPI.openDirectoryPicker('Explorer — Select Root Folder');
        newSetups.push({ cwd: dir, command: null });
      } else if (matched[i] === null && slots[i] === 'X') {
        newSetups.push({ cwd: null, command: null });
      } else {
        newSetups.push(null);
      }
    }

    const areas = layout.areas;
    setGrid(layout, []); // apply grid CSS before panes exist

    // Create all pane DOM first (no PTY yet) so the grid is fully populated
    for (let i = 0; i < slots.length; i++) {
      const area = areas[i];
      if (matched[i]) {
        grid.appendChild(matched[i].element);
        matched[i].element.style.gridArea = area;
      } else {
        const setup = newSetups[i];
        const paneType = slots[i] === 'T' ? 'terminal' : slots[i] === 'E' ? 'explorer' : slots[i] === 'X' ? 'text' : 'browser';
        createPane(paneType, area, null, setup?.cwd, setup?.command, setup?.name || null);
      }
    }
    updateAddButton();
    refitAll();                  // refit existing (reused) terminals
    await initNewTerminals();    // fit + PTY for newly created terminals
  }

  // ── Add pane (+ button) ───────────────────────────────
  async function addPane(type, shell = null) {
    if (panes.size >= MAX_PANES) return;
    let cwd = null, initCommand = null;
    if (type === 'terminal') {
      ({ cwd, command: initCommand } = await showTerminalSetupDialog());
    } else if (type === 'explorer') {
      cwd = await window.electronAPI.openDirectoryPicker();
    }
    createPane(type, null, shell, cwd, initCommand);
    updateDefaultLayout();
    updateAddButton();
    try {
      await initNewTerminals();
    } catch (e) {
      console.error('[addPane] initNewTerminals threw:', e);
    }
  }

  function getPaneConfig(pane) {
    if (pane.type === 'browser')
      return { type: 'browser',   name: pane.name, url: pane.urlInput?.value || 'https://www.google.com' };
    if (pane.type === 'terminal')
      return { type: 'terminal',  name: pane.name, shell: pane.shell || null, cwd: pane.cwd || null, initCommand: pane.initCommand || null };
    if (pane.type === 'explorer')
      return { type: 'explorer',  name: pane.name, cwd: pane.cwd || null };
    return   { type: 'text',      name: pane.name, filePath: pane.filePath || null };
  }

  // ── Create pane DOM (PTY deferred — call initNewTerminals afterwards) ─────
  function createPane(type, gridArea, shell = null, cwd = null, initCommand = null, savedName = null, url = null, predefinedCommands = null) {
    const id = nextId++;
    const paneEl = document.createElement('div');
    paneEl.className = 'pane';
    paneEl.dataset.id   = id;
    paneEl.dataset.type = type;
    if (gridArea) paneEl.style.gridArea = gridArea;

    const header = document.createElement('div');
    header.className = 'pane-header';

    const defaultName = savedName || (type === 'terminal' ? `Terminal ${id}` : type === 'explorer' ? `Explorer ${id}` : `Browser ${id}`);

    const title = document.createElement('span');
    title.className   = 'pane-title';
    title.textContent = defaultName;
    title.title       = 'Double-click to rename';
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const pane = panes.get(id);
      const inp = document.createElement('input');
      inp.value = title.textContent;
      inp.className = 'pane-title-input';
      title.replaceWith(inp);
      inp.focus(); inp.select();
      const commit = () => {
        const val = inp.value.trim();
        title.textContent = val || title.textContent;
        if (pane) pane.name = title.textContent;
        inp.replaceWith(title);
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter')  { ev.stopPropagation(); inp.blur(); }
        if (ev.key === 'Escape') { ev.stopPropagation(); inp.replaceWith(title); }
      });
    });

    const closeBtn = document.createElement('button');
    closeBtn.className   = 'pane-close';
    closeBtn.textContent = '✕';
    closeBtn.title       = 'Close';
    closeBtn.addEventListener('click', () => closePane(id));

    const settingsBtn = document.createElement('button');
    settingsBtn.className   = 'pane-settings-btn';
    settingsBtn.textContent = '⚙';
    settingsBtn.title       = 'Pane settings';
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showPaneSettingsDialog(panes.get(id));
    });

    const detachBtn = document.createElement('button');
    detachBtn.className = 'pane-settings-btn';
    detachBtn.title     = 'Detach to new window';
    detachBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    if (isDetached) detachBtn.style.display = 'none';
    detachBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pane = panes.get(id);
      if (!pane) return;
      const config = getPaneConfig(pane);
      // Save the pane's grid position and the full grid layout so we can restore on reattach
      config.gridArea = pane.element.style.gridArea;
      config._snapshot = {
        gridClass:           grid.className.replace(/\btab-grid\b|\bhidden\b/g, '').trim(),
        gridTemplateAreas:   grid.style.gridTemplateAreas   || null,
        gridTemplateColumns: grid.style.gridTemplateColumns || null,
        gridTemplateRows:    grid.style.gridTemplateRows    || null,
        paneAreas: [...panes.values()].map(p => ({ id: p.id, area: p.element.style.gridArea })),
      };
      await window.electronAPI.detachPane(config);
      closePane(id);
    });

    // ── Pane swap via drag ────────────────────────────────
    header.draggable = true;
    header.addEventListener('dragstart', (e) => {
      draggedPaneId = id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-pane-id', String(id));
      paneEl.classList.add('pane-dragging');
    });
    header.addEventListener('dragend', () => {
      draggedPaneId = null;
      paneEl.classList.remove('pane-dragging');
      for (const p of globalPanes.values()) p.element.classList.remove('pane-drag-over');
    });
    paneEl.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-pane-id')) return;
      e.preventDefault();
      if (draggedPaneId === id) return;
      e.dataTransfer.dropEffect = 'move';
      paneEl.classList.add('pane-drag-over');
    });
    paneEl.addEventListener('dragleave', (e) => {
      if (!paneEl.contains(e.relatedTarget))
        paneEl.classList.remove('pane-drag-over');
    });
    paneEl.addEventListener('drop', (e) => {
      if (!e.dataTransfer.types.includes('application/x-pane-id')) return;
      e.preventDefault();
      paneEl.classList.remove('pane-drag-over');
      if (draggedPaneId === null || draggedPaneId === id) return;
      const srcPane = globalPanes.get(draggedPaneId);
      const dstPane = globalPanes.get(id);
      if (!srcPane || !dstPane) return;
      const srcArea = srcPane.element.style.gridArea;
      srcPane.element.style.gridArea = dstPane.element.style.gridArea;
      dstPane.element.style.gridArea = srcArea;
      draggedPaneId = null;
    });

    if (type === 'explorer') {
      const nav = document.createElement('div');
      nav.className = 'browser-nav';

      const upBtn      = makeNavBtn('↑', 'Parent Directory');
      const openBtn    = makeNavBtn('⋯', 'Open Folder');
      const sortBtn    = makeNavBtn('⇅', 'Sort');
      const refreshBtn = makeNavBtn('⟳', 'Refresh');
      const pathInput = document.createElement('input');
      pathInput.className   = 'url-bar';
      pathInput.type        = 'text';
      pathInput.spellcheck  = false;
      pathInput.placeholder = 'Enter path or click ⋯';

      nav.append(upBtn, pathInput, sortBtn, refreshBtn, openBtn);
      header.append(title, nav, detachBtn, settingsBtn, closeBtn);

      // ── Column header row ─────────────────────────────
      const colDefs = {
        name: { asc: 'name-asc', desc: 'name-desc', label: 'Name', defDir: 'asc'  },
        size: { asc: 'size-asc', desc: 'size-desc', label: 'Size', defDir: 'desc' },
        date: { asc: 'date-asc', desc: 'date-desc', label: 'Date', defDir: 'desc' },
      };

      const explorerColHeader = document.createElement('div');
      explorerColHeader.className = 'explorer-col-header';

      const hSpacer = document.createElement('span');
      hSpacer.className = 'explorer-header-spacer';

      const hName = document.createElement('span');
      hName.className = 'explorer-header-col';
      hName.dataset.col = 'name';

      const hSize = document.createElement('span');
      hSize.className = 'explorer-header-col explorer-item-size';
      hSize.dataset.col = 'size';

      const hDate = document.createElement('span');
      hDate.className = 'explorer-header-col explorer-item-date';
      hDate.dataset.col = 'date';

      explorerColHeader.append(hSpacer, hName, hSize, hDate);

      const tree = document.createElement('div');
      tree.className = 'explorer-tree';

      const explorerContent = document.createElement('div');
      explorerContent.className = 'explorer-content';
      explorerContent.append(explorerColHeader, tree);

      paneEl.append(header, explorerContent);
      grid.appendChild(paneEl);

      const expanded = new Set();
      let rootPath = cwd || '';
      let sortKey = 'name-asc';

      function updateColHeader() {
        for (const [col, def] of Object.entries(colDefs)) {
          const el = col === 'name' ? hName : col === 'size' ? hSize : hDate;
          const isAsc  = sortKey === def.asc;
          const isDesc = sortKey === def.desc;
          el.textContent = def.label + (isAsc ? ' ▲' : isDesc ? ' ▼' : '');
          el.classList.toggle('active', isAsc || isDesc);
        }
        sortBtn.style.color = (sortKey !== 'name-asc' && !Object.values(colDefs).some(d => d.asc === sortKey || d.desc === sortKey)) ? '#569cd6' : '';
      }

      explorerColHeader.addEventListener('click', (e) => {
        const colEl = e.target.closest('[data-col]');
        if (!colEl) return;
        const col = colEl.dataset.col;
        const def = colDefs[col];
        if (sortKey === def.asc) sortKey = def.desc;
        else if (sortKey === def.desc) sortKey = def.asc;
        else sortKey = def.defDir === 'asc' ? def.asc : def.desc;
        updateColHeader();
        refresh();
      });

      const SORT_OPTIONS = [
        { key: 'name-asc',  label: 'Name (A→Z)'           },
        { key: 'name-desc', label: 'Name (Z→A)'           },
        null,
        { key: 'date-desc', label: 'Date (newest first)'  },
        { key: 'date-asc',  label: 'Date (oldest first)'  },
        null,
        { key: 'size-desc', label: 'Size (largest first)' },
        { key: 'size-asc',  label: 'Size (smallest first)'},
        null,
        { key: 'type',      label: 'Type (by extension)'  },
      ];

      sortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = sortBtn.getBoundingClientRect();
        showCtxMenu(
          SORT_OPTIONS.map(o => o === null
            ? { sep: true }
            : { icon: o.key === sortKey ? '✓' : '', label: o.label, action: () => {
                sortKey = o.key;
                sortBtn.style.color = !Object.values(colDefs).some(d => d.asc === sortKey || d.desc === sortKey) ? '#569cd6' : '';
                updateColHeader();
                refresh();
              }}
          ),
          rect.left, rect.bottom + 4
        );
      });

      updateColHeader();

      const refresh = async () => {
        if (!rootPath) return;
        pathInput.value = rootPath;
        const parts = rootPath.replace(/\\/g, '/').split('/').filter(Boolean);
        title.textContent = parts[parts.length - 1] || rootPath;
        await renderExplorer(tree, rootPath, expanded, refresh, sortKey);
      };

      // Empty-area right-click
      tree.addEventListener('contextmenu', (e) => {
        if (e.target !== tree) return; // items stop propagation
        e.preventDefault();
        const cb = explorerClipboard;
        const hasCb = !!cb.path;
        showCtxMenu([
          { icon: '📁', label: 'New Folder', action: () => promptInlineCreate(tree, rootPath, true,  refresh) },
          { icon: '📄', label: 'New File',   action: () => promptInlineCreate(tree, rootPath, false, refresh) },
          ...(hasCb ? [
            { sep: true },
            { icon: '📋', label: 'Paste', action: async () => {
              await window.electronAPI.pasteItem(cb.path, rootPath, cb.type === 'cut');
              if (cb.type === 'cut') cb.path = null;
              refresh();
            }},
          ] : []),
        ], e.clientX, e.clientY);
      });

      const navigateTo = async (newPath) => {
        rootPath = newPath;
        expanded.clear();
        await refresh();
      };

      upBtn.addEventListener('click', async () => {
        if (!rootPath) return;
        const parent = await window.electronAPI.parentDir(rootPath);
        if (parent !== rootPath) await navigateTo(parent);
      });

      openBtn.addEventListener('click', async () => {
        const dir = await window.electronAPI.openDirectoryPicker();
        if (dir) await navigateTo(dir);
      });

      pathInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') await navigateTo(pathInput.value.trim());
      });

      refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); refresh(); });

      const resizeObserver = new ResizeObserver(entries => {
        const w = entries[0].contentRect.width;
        explorerContent.classList.toggle('show-size', w >= 260);
        explorerContent.classList.toggle('show-date', w >= 380);
      });
      resizeObserver.observe(tree);

      const explorerData = { id, type: 'explorer', element: paneEl, name: defaultName, resizeObserver, get cwd() { return rootPath; }, renderExplorer: refresh, navigate: navigateTo };
      panes.set(id, explorerData);
      globalPanes.set(id, explorerData);
      if (rootPath) refresh();

    } else if (type === 'text') {
      // ── Text Editor pane ──────────────────────────────────
      const nav = document.createElement('div');
      nav.className = 'browser-nav';

      const openBtn   = makeNavBtn('📂', 'Open File');
      const saveBtn = document.createElement('button');
      saveBtn.className = 'nav-btn';
      saveBtn.title = 'Save  Ctrl+S';
      saveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
      const reloadBtn = makeNavBtn('⟳',  'Reload from disk');
      const saveAsBtn = makeNavBtn('⤓',  'Save As…');

      const fileLabel = document.createElement('span');
      fileLabel.className = 'text-editor-path';

      nav.append(openBtn, fileLabel, saveBtn, saveAsBtn, reloadBtn);
      header.append(title, nav, detachBtn, settingsBtn, closeBtn);

      // Format toolbar (shown based on file type)
      const toolbar = document.createElement('div');
      toolbar.className = 'text-editor-toolbar hidden';

      // Main textarea
      const textarea = document.createElement('textarea');
      textarea.className   = 'text-editor-area';
      textarea.spellcheck  = false;
      textarea.wrap        = 'off';
      textarea.autocomplete = 'off';
      textarea.autocorrect  = 'off';
      textarea.autocapitalize = 'off';

      // Tree/preview view (JSON, XML, Markdown)
      const viewPane = document.createElement('div');
      viewPane.className = 'text-editor-tree hidden';

      const textBody = document.createElement('div');
      textBody.className = 'text-editor-body';
      textBody.append(toolbar, textarea, viewPane);

      paneEl.append(header, textBody);
      grid.appendChild(paneEl);

      let filePath = cwd || null; // cwd param carries the initial file path
      let dirty    = false;
      let fileType = 'text';
      let viewMode = false; // true = tree/preview, false = edit

      function detectFileType(fp) {
        if (!fp) return 'text';
        const ext = fp.split('.').pop().toLowerCase();
        if (ext === 'json') return 'json';
        if (['xml', 'svg', 'xhtml'].includes(ext)) return 'xml';
        if (['md', 'markdown'].includes(ext)) return 'markdown';
        return 'text';
      }

      function setDirty(val) {
        dirty = val;
        saveBtn.style.color   = val ? '#f4d03f' : '';
        saveBtn.title = val ? 'Save  Ctrl+S  (unsaved changes)' : 'Save  Ctrl+S';
        const base = filePath ? filePath.split(/[\\/]/).pop() : 'Untitled';
        title.textContent = base + (val ? ' •' : '');
      }

      function applyFilePath(fp) {
        filePath = fp;
        fileType = detectFileType(fp);
        const base = fp ? fp.split(/[\\/]/).pop() : 'Untitled';
        title.textContent = base;
        fileLabel.textContent = fp || 'No file';
        fileLabel.title = fp || '';
        buildToolbar();
      }

      // ── Toolbar builder ────────────────────────────────
      function buildToolbar() {
        toolbar.innerHTML = '';
        if (fileType === 'markdown') {
          toolbar.classList.remove('hidden');
          const mdBtns = [
            { t: 'B',   title: 'Bold',         wrap: ['**','**']        },
            { t: 'I',   title: 'Italic',        wrap: ['*','*']          },
            { sep: true },
            { t: 'H1',  title: 'Heading 1',     linePrefix: '# '        },
            { t: 'H2',  title: 'Heading 2',     linePrefix: '## '       },
            { t: 'H3',  title: 'Heading 3',     linePrefix: '### '      },
            { sep: true },
            { t: '`c`', title: 'Inline code',   wrap: ['`','`']         },
            { t: '```', title: 'Code block',    wrap: ['```\n','\n```'] },
            { sep: true },
            { t: '—',   title: 'Horizontal rule', insert: '\n\n---\n\n' },
            { t: '• ',  title: 'List item',     linePrefix: '- '        },
            { t: '[]',  title: 'Link',          wrap: ['[','](url)']    },
            { sep: true },
            { t: '👁',  title: 'Preview',       action: 'preview'       },
          ];
          for (const b of mdBtns) {
            if (b.sep) { const s = document.createElement('span'); s.className = 'text-toolbar-sep'; toolbar.appendChild(s); }
            else {
              const btn = makeToolbarBtn(b.t, b.title);
              btn.addEventListener('click', () => {
                if (b.action === 'preview') { toggleView(); return; }
                applyOp(b); textarea.focus();
              });
              toolbar.appendChild(btn);
            }
          }
        } else if (fileType === 'json' || fileType === 'xml') {
          toolbar.classList.remove('hidden');
          const fmtBtn  = makeToolbarBtn('⊞ Format', `Pretty-print ${fileType.toUpperCase()}`);
          const treeBtn = makeToolbarBtn('⊟ Tree',   'Toggle tree view');
          treeBtn.id = 'text-tree-btn';
          fmtBtn.addEventListener('click',  () => { formatContent(); textarea.focus(); });
          treeBtn.addEventListener('click', () => toggleView());
          toolbar.append(fmtBtn, treeBtn);
        } else {
          toolbar.classList.add('hidden');
        }
      }

      function makeToolbarBtn(label, titleText) {
        const b = document.createElement('button');
        b.className   = 'text-toolbar-btn';
        b.textContent = label;
        b.title       = titleText;
        return b;
      }

      // ── Text operations (toolbar inserts) ─────────────
      function applyOp({ wrap, linePrefix, insert }) {
        textarea.focus();
        const start = textarea.selectionStart;
        const end   = textarea.selectionEnd;
        if (wrap) {
          const sel = textarea.value.substring(start, end);
          const replacement = wrap[0] + sel + wrap[1];
          document.execCommand('insertText', false, replacement);
          const newCur = start + wrap[0].length + sel.length;
          textarea.setSelectionRange(newCur, newCur);
        } else if (linePrefix) {
          const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1;
          textarea.setSelectionRange(lineStart, lineStart);
          document.execCommand('insertText', false, linePrefix);
        } else if (insert) {
          textarea.setSelectionRange(start, end);
          document.execCommand('insertText', false, insert);
        }
      }

      // ── Format / pretty-print ──────────────────────────
      function formatContent() {
        try {
          let formatted;
          if (fileType === 'json') {
            formatted = JSON.stringify(JSON.parse(textarea.value), null, 2);
          } else {
            formatted = formatXml(textarea.value);
          }
          textarea.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, formatted);
        } catch (e) {
          showEditorError(e.message);
        }
      }

      function formatXml(xml) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, 'text/xml');
        const err = doc.querySelector('parseerror');
        if (err) throw new Error(err.textContent.split('\n')[0]);
        return serializeXmlNode(doc.documentElement, 0);
      }

      function serializeXmlNode(node, depth) {
        const ind = '  '.repeat(depth);
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.trim();
          return t ? ind + t : '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        let attrs = '';
        for (const a of node.attributes) attrs += ` ${a.name}="${a.value}"`;
        const kids = [...node.childNodes].map(c => serializeXmlNode(c, depth + 1)).filter(s => s);
        if (kids.length === 0) return `${ind}<${node.tagName}${attrs}/>`;
        if (kids.length === 1 && !kids[0].includes('\n'))
          return `${ind}<${node.tagName}${attrs}>${kids[0].trimStart()}</${node.tagName}>`;
        return `${ind}<${node.tagName}${attrs}>\n${kids.join('\n')}\n${ind}</${node.tagName}>`;
      }

      // ── Tree / preview view ────────────────────────────
      function toggleView() {
        viewMode = !viewMode;
        if (viewMode) {
          textarea.classList.add('hidden');
          viewPane.classList.remove('hidden');
          renderView();
          const tb = toolbar.querySelector('#text-tree-btn');
          if (tb) tb.textContent = '✎ Edit';
          const pb = [...toolbar.querySelectorAll('.text-toolbar-btn')].find(b => b.title === 'Preview');
          if (pb) { pb.textContent = '✎ Edit'; pb.title = 'Back to edit'; }
        } else {
          viewPane.classList.add('hidden');
          textarea.classList.remove('hidden');
          textarea.focus();
          const tb = toolbar.querySelector('#text-tree-btn');
          if (tb) tb.textContent = '⊟ Tree';
          const pb = [...toolbar.querySelectorAll('.text-toolbar-btn')].find(b => b.title === 'Back to edit');
          if (pb) { pb.textContent = '👁'; pb.title = 'Preview'; }
        }
      }

      function renderView() {
        viewPane.innerHTML = '';
        viewPane.style.color = '';
        const content = textarea.value;
        if (fileType === 'json') {
          try {
            viewPane.appendChild(buildJsonTree(JSON.parse(content), null, true));
          } catch (e) {
            viewPane.textContent = '⚠ JSON error: ' + e.message;
            viewPane.style.color = '#f44747';
          }
        } else if (fileType === 'xml') {
          try {
            const doc = new DOMParser().parseFromString(content, 'text/xml');
            const err = doc.querySelector('parseerror');
            if (err) throw new Error(err.textContent.split('\n')[0]);
            viewPane.appendChild(buildXmlTree(doc.documentElement));
          } catch (e) {
            viewPane.textContent = '⚠ XML error: ' + e.message;
            viewPane.style.color = '#f44747';
          }
        } else if (fileType === 'markdown') {
          viewPane.classList.add('md-preview');
          viewPane.innerHTML = renderMarkdown(content);
        }
      }

      // ── JSON tree builder ──────────────────────────────
      function buildJsonTree(value, key, isRoot) {
        const wrap = document.createElement('div');
        wrap.className = 'tree-node';
        const isArr = Array.isArray(value);
        const isObj = value !== null && typeof value === 'object';

        if (isObj) {
          const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
          const row = document.createElement('div'); row.className = 'tree-row';
          const tog = document.createElement('span'); tog.className = 'tree-toggle';
          tog.textContent = entries.length > 0 ? '▾' : '';
          const lbl = document.createElement('span');
          if (key !== null) { const k = document.createElement('span'); k.className = 'tree-key'; k.textContent = `"${key}": `; lbl.appendChild(k); }
          const br = document.createElement('span'); br.className = 'tree-brace';
          br.textContent = (isArr ? '[' : '{') + (entries.length === 0 ? (isArr ? ']' : '}') : ` ${entries.length} ${isArr ? 'item' : 'key'}${entries.length !== 1 ? 's' : ''} }`);
          lbl.appendChild(br);
          row.append(tog, lbl);
          wrap.appendChild(row);
          if (entries.length > 0) {
            const children = document.createElement('div'); children.className = 'tree-children';
            for (const [k, v] of entries) children.appendChild(buildJsonTree(v, k, false));
            tog.addEventListener('click', e => {
              e.stopPropagation();
              const open = tog.textContent === '▾';
              tog.textContent = open ? '▸' : '▾';
              children.classList.toggle('hidden', open);
            });
            wrap.appendChild(children);
          }
        } else {
          const row = document.createElement('div'); row.className = 'tree-row';
          const ind = document.createElement('span'); ind.className = 'tree-indent';
          const lbl = document.createElement('span');
          if (key !== null) { const k = document.createElement('span'); k.className = 'tree-key'; k.textContent = `"${key}": `; lbl.appendChild(k); }
          const v = document.createElement('span');
          v.className = value === null ? 'tree-null' : typeof value === 'number' ? 'tree-number' : typeof value === 'boolean' ? 'tree-bool' : 'tree-string';
          v.textContent = value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value);
          lbl.appendChild(v);
          row.append(ind, lbl);
          wrap.appendChild(row);
        }
        return wrap;
      }

      // ── XML tree builder ───────────────────────────────
      function buildXmlTree(node) {
        const wrap = document.createElement('div'); wrap.className = 'tree-node';
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.trim();
          if (!t) return wrap;
          const s = document.createElement('span'); s.className = 'tree-xml-text'; s.textContent = t;
          wrap.appendChild(s); return wrap;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return wrap;
        let attrs = '';
        for (const a of node.attributes) attrs += ` ${a.name}="${a.value}"`;
        const kids = [...node.childNodes].filter(c =>
          c.nodeType === Node.ELEMENT_NODE || (c.nodeType === Node.TEXT_NODE && c.textContent.trim())
        );
        const row = document.createElement('div'); row.className = 'tree-row';
        if (kids.length > 0) {
          const tog = document.createElement('span'); tog.className = 'tree-toggle'; tog.textContent = '▾';
          const tagOpen = document.createElement('span'); tagOpen.className = 'tree-xml-tag';
          tagOpen.textContent = `<${node.tagName}`;
          const attrEl = document.createElement('span'); attrEl.className = 'tree-xml-attr'; attrEl.textContent = attrs + '>';
          row.append(tog, tagOpen, attrEl);
          wrap.appendChild(row);
          const children = document.createElement('div'); children.className = 'tree-children';
          for (const c of kids) { const ce = buildXmlTree(c); if (ce.hasChildNodes()) children.appendChild(ce); }
          tog.addEventListener('click', e => {
            e.stopPropagation();
            const open = tog.textContent === '▾';
            tog.textContent = open ? '▸' : '▾';
            children.classList.toggle('hidden', open);
          });
          const closeRow = document.createElement('div'); closeRow.className = 'tree-row';
          const closeTag = document.createElement('span'); closeTag.className = 'tree-xml-tag'; closeTag.textContent = `</${node.tagName}>`;
          closeRow.appendChild(closeTag);
          wrap.append(children, closeRow);
        } else {
          const ind = document.createElement('span'); ind.className = 'tree-indent';
          const tagEl = document.createElement('span'); tagEl.className = 'tree-xml-tag'; tagEl.textContent = `<${node.tagName}`;
          const attrEl = document.createElement('span'); attrEl.className = 'tree-xml-attr';
          const text = node.textContent.trim();
          attrEl.textContent = attrs + (text ? `>${text}</${node.tagName}>` : '/>');
          row.append(ind, tagEl, attrEl);
          wrap.appendChild(row);
        }
        return wrap;
      }

      // ── Markdown preview renderer ──────────────────────
      function renderMarkdown(md) {
        let html = md
          .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/^#{6}\s+(.+)$/gm,'<h6>$1</h6>')
          .replace(/^#{5}\s+(.+)$/gm,'<h5>$1</h5>')
          .replace(/^#{4}\s+(.+)$/gm,'<h4>$1</h4>')
          .replace(/^###\s+(.+)$/gm,'<h3>$1</h3>')
          .replace(/^##\s+(.+)$/gm,'<h2>$1</h2>')
          .replace(/^#\s+(.+)$/gm,'<h1>$1</h1>')
          .replace(/^---+$/gm,'<hr/>')
          .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
          .replace(/\*(.+?)\*/g,'<em>$1</em>')
          .replace(/`([^`]+)`/g,'<code>$1</code>')
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2">$1</a>')
          .replace(/^- (.+)$/gm,'<li>$1</li>')
          .replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>')
          .replace(/\n{2,}/g,'</p><p>')
          .replace(/\n/g,'<br/>');
        return '<p>' + html + '</p>';
      }

      function showEditorError(msg) {
        const orig = title.textContent;
        title.textContent = '⚠ ' + msg;
        setTimeout(() => { title.textContent = orig; }, 3000);
      }

      // ── File operations ────────────────────────────────
      async function loadFile(fp) {
        const result = await window.electronAPI.readTextFile(fp);
        if (!result.success) { showEditorError(result.error); return; }
        textarea.value = result.content;
        if (viewMode) renderView();
        applyFilePath(fp);
        setDirty(false);
      }

      async function saveFile() {
        if (!filePath) { await saveFileAs(); return; }
        const result = await window.electronAPI.writeTextFile(filePath, textarea.value);
        if (result.success) setDirty(false);
        else showEditorError(result.error);
      }

      async function saveFileAs() {
        const fp = await window.electronAPI.saveFilePicker(
          filePath || 'untitled.txt',
          [{ name: 'Text Files', extensions: ['txt','md','json','xml','html','css','js','ts','py','yaml','toml','conf','log'] }, { name: 'All Files', extensions: ['*'] }]
        );
        if (!fp) return;
        const result = await window.electronAPI.writeTextFile(fp, textarea.value);
        if (result.success) { applyFilePath(fp); setDirty(false); }
        else showEditorError(result.error);
      }

      // ── Event wiring ──────────────────────────────────
      textarea.addEventListener('input', () => setDirty(true));

      textarea.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveFile(); }
        if (e.key === 'Tab') {
          e.preventDefault();
          document.execCommand('insertText', false, '  ');
        }
      });

      openBtn.addEventListener('click', async () => {
        const fp = await window.electronAPI.openFilePicker([
          { name: 'Text / Code',  extensions: ['txt','md','markdown','json','xml','svg','html','htm','css','js','ts','jsx','tsx','py','rb','go','rs','yaml','yml','toml','ini','conf','log','csv'] },
          { name: 'All Files', extensions: ['*'] },
        ]);
        if (fp) await loadFile(fp);
      });

      saveBtn.addEventListener('click',   () => saveFile());
      saveAsBtn.addEventListener('click', () => saveFileAs());
      reloadBtn.addEventListener('click', () => { if (filePath) loadFile(filePath); });

      // ── Init ──────────────────────────────────────────
      applyFilePath(filePath);
      if (filePath) loadFile(filePath); // async, fire-and-forget
      else setDirty(false);

      const pane = { id, type: 'text', element: paneEl, name: defaultName,
        _autoName: defaultName,
        get filePath() { return filePath; },
        get dirty()    { return dirty; },
        openFile: loadFile,
      };
      panes.set(id, pane);
      globalPanes.set(id, pane);

    } else if (type === 'browser') {
      const nav       = document.createElement('div');
      nav.className   = 'browser-nav';
      const backBtn   = makeNavBtn('◀', 'Back');
      const fwdBtn    = makeNavBtn('▶', 'Forward');
      const reloadBtn = makeNavBtn('↻', 'Reload');

      const initialUrl = url || 'https://www.google.com';
      const urlInput      = document.createElement('input');
      urlInput.className  = 'url-bar';
      urlInput.type       = 'text';
      urlInput.value      = initialUrl;
      urlInput.spellcheck = false;

      nav.append(backBtn, fwdBtn, reloadBtn, urlInput);
      header.append(title, nav, detachBtn, settingsBtn, closeBtn);

      const webview = document.createElement('webview');
      webview.className = 'browser-view';
      webview.setAttribute('src', initialUrl);
      webview.setAttribute('partition', 'persist:aiconsole');
      webview.setAttribute('allowpopups', '');
      webview.addEventListener('dom-ready', () => webview.setBackgroundColor('#1e1e1e'));

      backBtn.addEventListener('click',   () => webview.goBack());
      fwdBtn.addEventListener('click',    () => webview.goForward());
      reloadBtn.addEventListener('click', () => webview.reload());
      urlInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        let url = urlInput.value.trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
        webview.setAttribute('src', url);
      });
      webview.addEventListener('did-navigate',        (e) => { urlInput.value = e.url; });
      webview.addEventListener('did-navigate-in-page',(e) => { if (e.isMainFrame) urlInput.value = e.url; });

      paneEl.append(header, webview);
      grid.appendChild(paneEl);
      const browserData = { id, type: 'browser', element: paneEl, name: defaultName, webview, urlInput };
      panes.set(id, browserData);
      globalPanes.set(id, browserData);

    } else {
      const cmdSaveBtn = document.createElement('button');
      cmdSaveBtn.className   = 'pane-cmd-btn';
      cmdSaveBtn.textContent = '⊕';
      cmdSaveBtn.title       = 'Save clipboard as predefined command';
      cmdSaveBtn.style.marginLeft = 'auto';

      const cmdDropBtn = document.createElement('button');
      cmdDropBtn.className   = 'pane-cmd-btn';
      cmdDropBtn.textContent = '▾';
      cmdDropBtn.title       = 'Predefined commands';

      const refreshCmdDropBtn = () => {
        const pane = globalPanes.get(id);
        const n = pane?.predefinedCommands?.length || 0;
        cmdDropBtn.textContent = n ? `▾${n}` : '▾';
        cmdDropBtn.title = n ? `Predefined commands (${n})` : 'Predefined commands';
      };

      cmdSaveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pane = globalPanes.get(id);
        if (!pane) return;
        const text = (window.electronAPI.readClipboard() || '').trim();
        if (!text) {
          cmdSaveBtn.textContent = '!';
          cmdSaveBtn.style.color = '#ce9178';
          setTimeout(() => { cmdSaveBtn.textContent = '⊕'; cmdSaveBtn.style.color = ''; }, 1000);
          return;
        }
        pane.predefinedCommands = pane.predefinedCommands || [];
        if (!pane.predefinedCommands.includes(text)) {
          pane.predefinedCommands.push(text);
        }
        refreshCmdDropBtn();
        cmdSaveBtn.textContent = '✓';
        cmdSaveBtn.style.color = '#4ec9b0';
        setTimeout(() => { cmdSaveBtn.textContent = '⊕'; cmdSaveBtn.style.color = ''; }, 1000);
      });

      cmdDropBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pane = globalPanes.get(id);
        if (!pane) return;
        const cmds = pane.predefinedCommands || [];
        const rect = cmdDropBtn.getBoundingClientRect();
        const items = cmds.length
          ? cmds.map((cmd, i) => ({
              icon: '',
              label: cmd,
              action: () => {
                if (pane.ptyCreated) window.electronAPI.writePty(pane.id, cmd);
                pane.terminal.focus();
              },
              onContextMenu: () => {
                pane.predefinedCommands.splice(i, 1);
                refreshCmdDropBtn();
                hideCtxMenu();
              },
            }))
          : [{ icon: '', label: '(no saved commands)', disabled: true }];
        showCtxMenu(items, rect.left, rect.bottom);
      });

      header.append(title, cmdSaveBtn, cmdDropBtn, detachBtn, settingsBtn, closeBtn);
      const termContainer = document.createElement('div');
      termContainer.className = 'term-container';
      paneEl.append(header, termContainer);
      grid.appendChild(paneEl);

      const terminal = new Terminal({
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: 14,
        theme: {
          background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4',
          selectionBackground: '#264f78',
          black: '#1e1e1e',   brightBlack:   '#808080',
          red: '#f44747',     brightRed:     '#f44747',
          green: '#4ec9b0',   brightGreen:   '#4ec9b0',
          yellow: '#ce9178',  brightYellow:  '#ce9178',
          blue: '#569cd6',    brightBlue:    '#569cd6',
          magenta: '#c586c0', brightMagenta: '#c586c0',
          cyan: '#9cdcfe',    brightCyan:    '#9cdcfe',
          white: '#d4d4d4',   brightWhite:   '#ffffff',
        },
        allowTransparency: false,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);

      // ── Clipboard: Ctrl+C copies selection (or sends interrupt), Ctrl+V pastes ──
      terminal.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        if (e.ctrlKey && e.key === 'c') {
          const selection = terminal.getSelection();
          if (selection) {
            window.electronAPI.writeClipboard(selection);
            return false; // consumed
          }
          return true; // pass through as interrupt
        }
        if (e.ctrlKey && e.key === 'v') {
          const text = window.electronAPI.readClipboard();
          if (text) window.electronAPI.writePty(id, text);
          return false;
        }
        return true;
      });

      // ── Right-click context menu: Copy / Paste ────────────────────
      termContainer.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const selection = terminal.getSelection();
        showCtxMenu([
          { icon: '', label: 'Copy',  disabled: !selection, action: () => window.electronAPI.writeClipboard(selection) },
          { icon: '', label: 'Paste', action: () => {
            const text = window.electronAPI.readClipboard();
            if (text) window.electronAPI.writePty(id, text);
          }},
        ], e.clientX, e.clientY);
      });

      // terminal.open() is deferred to initNewTerminals() so it runs after layout settles
      // ── Drop target: insert dragged file path into the terminal ──
      termContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        termContainer.classList.add('drag-over');
      });
      termContainer.addEventListener('dragleave', (e) => {
        if (!termContainer.contains(e.relatedTarget))
          termContainer.classList.remove('drag-over');
      });
      termContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        termContainer.classList.remove('drag-over');
        const filePath = e.dataTransfer.getData('text/plain');
        if (!filePath) return;
        const p = globalPanes.get(id);
        if (!p?.ptyCreated) return;
        const quoted = filePath.includes(' ') ? `"${filePath}"` : filePath;
        window.electronAPI.writePty(id, quoted);
        p.terminal.focus();
      });

      const termData = { id, type: 'terminal', shell, cwd, initCommand, terminal, fitAddon, termContainer, element: paneEl, name: defaultName, ptyCreated: false, predefinedCommands: predefinedCommands ? [...predefinedCommands] : [] };
      panes.set(id, termData);
      globalPanes.set(id, termData);
      refreshCmdDropBtn();
    }
    return id;
  }

  // ── Fit + create PTYs for all terminals not yet initialised ───────────────
  async function initNewTerminals() {
    const pending = [...panes.values()].filter(p => p.type === 'terminal' && !p.ptyCreated);
    console.log('[initNewTerminals] pending count:', pending.length, pending.map(p => p.id));
    if (!pending.length) return;

    // Wait until every pending terminal's container has real dimensions in both
    // axes (i.e. the full grid layout — all panes — has settled in the browser)
    await new Promise(resolve => {
      const check = () => {
        const allReady = pending.every(
          p => p.termContainer.clientHeight > 0 && p.termContainer.clientWidth > 0
        );
        allReady ? resolve() : requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    console.log('[initNewTerminals] rAF resolved, dims:',
      pending.map(p => `id=${p.id} h=${p.termContainer.clientHeight} w=${p.termContainer.clientWidth}`));

    for (const pane of pending) {
      try {
        console.log('[initNewTerminals] opening terminal id:', pane.id);
        pane.terminal.open(pane.termContainer);
      } catch (e) {
        console.error('[initNewTerminals] terminal.open() threw for id', pane.id, e);
        continue;
      }
      // Give xterm one frame to initialise its character-cell measurements
      // before FitAddon reads them; skipping this can yield cols/rows = 0
      // for terminals added to an already-rendered tab.
      await new Promise(r => requestAnimationFrame(r));
      pane.fitAddon.fit();
      // If fit() produced degenerate dimensions, retry once after another frame
      if (!pane.terminal.cols || !pane.terminal.rows) {
        console.warn('[initNewTerminals] fit() gave 0 dims for id', pane.id, '— retrying');
        await new Promise(r => requestAnimationFrame(r));
        pane.fitAddon.fit();
      }
      const { cols, rows } = pane.terminal;
      console.log('[initNewTerminals] creating PTY id:', pane.id, 'cols:', cols, 'rows:', rows);
      let ptyResult;
      try {
        ptyResult = await window.electronAPI.createPty(pane.id, cols, rows, pane.shell, pane.cwd);
      } catch (e) {
        console.error('[initNewTerminals] createPty threw for id', pane.id, e);
        pane.terminal.writeln(`\x1b[1;31mFailed to start terminal: ${e.message}\x1b[0m`);
        continue;
      }
      if (!ptyResult?.success) {
        const msg = ptyResult?.error || 'unknown error';
        console.error('[initNewTerminals] PTY creation failed for id', pane.id, msg);
        pane.terminal.writeln(`\x1b[1;31mFailed to start terminal: ${msg}\x1b[0m`);
        continue;
      }
      console.log('[initNewTerminals] PTY created for id:', pane.id, ptyResult);

      // Track commands typed by the user
      let inputBuf = '';
      let inEsc = false;
      pane.terminal.onData(data => {
        for (const ch of data) {
          const code = ch.charCodeAt(0);
          if (inEsc) {
            // Escape sequences end at a letter (A-Z or a-z)
            if ((code >= 64 && code <= 90) || (code >= 97 && code <= 122)) inEsc = false;
            continue;
          }
          if (ch === '\x1b') { inEsc = true; }
          else if (ch === '\r') {
            const cmd = inputBuf.trim();
            if (cmd) {
              pane.commandHistory = pane.commandHistory || [];
              pane.commandHistory.push(cmd);
              if (pane.commandHistory.length > 200) pane.commandHistory.shift();
              pane.lastCommand = cmd;
            }
            inputBuf = '';
          } else if (ch === '\x03' || ch === '\x15') { inputBuf = ''; }  // Ctrl+C / Ctrl+U
          else if (ch === '\x7f' || ch === '\x08') { inputBuf = inputBuf.slice(0, -1); }  // Backspace
          else if (code >= 32) { inputBuf += ch; }
        }
        window.electronAPI.writePty(pane.id, data);
      });

      pane.terminal.onResize(({ cols, rows }) => window.electronAPI.resizePty(pane.id, cols, rows));
      // terminal.onFocus was removed in xterm v5; use focusin on the container instead
      pane.termContainer.addEventListener('focusin', () => { lastFocusedTerminalId = pane.id; });
      pane.ptyCreated = true;
    }

    const last = pending[pending.length - 1];
    if (last) last.terminal.focus();
  }

  function makeNavBtn(text, title) {
    const btn = document.createElement('button');
    btn.className   = 'nav-btn';
    btn.textContent = text;
    btn.title       = title;
    return btn;
  }

  // ── Close / destroy pane ──────────────────────────────
  function closePane(id) {
    destroyPane(id);
    updateDefaultLayout();
    updateAddButton();
    refitAll();
    const last = [...panes.values()].pop();
    if (last?.terminal) last.terminal.focus();
  }

  function destroyPane(id) {
    const pane = panes.get(id);
    if (!pane) return;
    if (pane.type === 'terminal') {
      window.electronAPI.killPty(id);
      pane.terminal.dispose();
    }
    if (pane.resizeObserver) pane.resizeObserver.disconnect();
    pane.element.remove();
    panes.delete(id);
    globalPanes.delete(id);
  }

  // ── Helpers ───────────────────────────────────────────
  function updateAddButton() {
    document.getElementById('btn-add').disabled = panes.size >= MAX_PANES;
  }

  function refitAll() {
    for (const pane of panes.values())
      if (pane.fitAddon && pane.ptyCreated) try { pane.fitAddon.fit(); } catch {}
  }

  // ── PTY events ────────────────────────────────────────
  window.electronAPI.onPtyData(({ id, data }) => {
    const pane = globalPanes.get(id);
    if (!pane?.terminal) return;
    // Strip BOM injected by Windows ConPTY on first chunk
    if (!pane.bomStripped) {
      data = data.replace(/^\uFEFF/, '');
      pane.bomStripped = true;
    }
    pane.terminal.write(data);
    // Send init command once, after the shell emits its first output (prompt ready)
    if (pane.initCommand && !pane.initCommandSent) {
      pane.initCommandSent = true;
      setTimeout(() => {
        window.electronAPI.writePty(id, pane.initCommand + '\r');
        // Poll JSONL files to detect Claude session ID for new sessions
        if (!pane.claudeSessionId && /\bclaude(?:\.exe)?\b/i.test(pane.initCommand) && pane.cwd) {
          const since = Date.now();
          let attempts = 0;
          const poll = async () => {
            if (pane.claudeSessionId || attempts >= 8) return;
            attempts++;
            const sid = await window.electronAPI.getClaudeSessionId(pane.cwd, since);
            if (sid) {
              pane.claudeSessionId = sid;
            } else {
              setTimeout(poll, 2000);
            }
          };
          setTimeout(poll, 2000);
        }
      }, 150);
    }
  });
  window.electronAPI.onPtyExit(({ id }) => {
    const pane = globalPanes.get(id);
    if (pane?.terminal) pane.terminal.writeln('\r\n\x1b[31m[Process exited]\x1b[0m');
  });

  let refitTimer = null;
  new ResizeObserver(() => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => { refitAll(); if (grid) grid._updateResizeHandles?.(); }, 50);
  }).observe(document.getElementById('grid-container'));

  // ── Tab management ────────────────────────────────────
  function renderTabBar() {
    const list = document.getElementById('tab-list');
    list.innerHTML = '';
    const only = tabs.size <= 1;
    for (const [id, tab] of tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (id === activeTabId ? ' active' : '');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'tab-name';
      nameSpan.textContent = tab.name;
      nameSpan.title = tab.name;
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const inp = document.createElement('input');
        inp.value = tab.name;
        inp.style.cssText = 'flex:1;background:#1e1e1e;border:1px solid #0e639c;border-radius:2px;color:#d4d4d4;font-size:12px;padding:0 3px;font-family:inherit;min-width:0;outline:none;width:100%;';
        nameSpan.replaceWith(inp);
        inp.focus(); inp.select();
        const commit = () => { tab.name = inp.value.trim() || tab.name; renderTabBar(); };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter')  { e.stopPropagation(); inp.blur(); }
          if (e.key === 'Escape') { e.stopPropagation(); renderTabBar(); }
        });
      });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '✕';
      closeBtn.title = 'Close tab';
      closeBtn.style.visibility = only ? 'hidden' : '';
      closeBtn.addEventListener('click', async (e) => { e.stopPropagation(); await closeTab(id); });

      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-tab-id', String(id));
        el.classList.add('tab-dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('tab-dragging');
        document.querySelectorAll('.tab-drag-over').forEach(t => t.classList.remove('tab-drag-over'));
      });
      el.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-tab-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('tab-drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('tab-drag-over'));
      el.addEventListener('drop', (e) => {
        if (!e.dataTransfer.types.includes('application/x-tab-id')) return;
        e.preventDefault();
        el.classList.remove('tab-drag-over');
        const fromId = parseInt(e.dataTransfer.getData('application/x-tab-id'), 10);
        if (fromId === id) return;
        reorderTab(fromId, id);
      });

      el.append(nameSpan, closeBtn);
      el.addEventListener('click', async () => { if (id !== activeTabId) await switchTab(id); });
      list.appendChild(el);
    }
  }

  function reorderTab(fromId, toId) {
    const entries = [...tabs.entries()];
    const fromIdx = entries.findIndex(([id]) => id === fromId);
    const toIdx   = entries.findIndex(([id]) => id === toId);
    const [entry] = entries.splice(fromIdx, 1);
    entries.splice(toIdx, 0, entry);
    tabs.clear();
    for (const [id, tab] of entries) tabs.set(id, tab);
    renderTabBar();
  }

  async function createTab(name) {
    const id = nextTabId++;
    const gridEl = document.createElement('div');
    gridEl.className = 'tab-grid layout-solo';
    document.getElementById('grid-container').appendChild(gridEl);
    setupGridResizing(gridEl);
    const tab = { id, name: name || `Tab ${id}`, gridEl, panes: new Map() };
    tabs.set(id, tab);
    await switchTab(id);
    return id;
  }

  async function switchTab(id) {
    if (activeTabId !== null) {
      const cur = tabs.get(activeTabId);
      if (cur) cur.gridEl.classList.add('hidden');
    }
    activeTabId = id;
    const tab = tabs.get(id);
    tab.gridEl.classList.remove('hidden');
    panes = tab.panes;
    grid  = tab.gridEl;
    updateAddButton();
    renderTabBar();
    const hasPending = [...panes.values()].some(p => p.type === 'terminal' && !p.ptyCreated);
    if (hasPending) await initNewTerminals();
    else {
      // Wait one frame for the browser to re-layout the newly-visible grid
      // before measuring container dimensions for fitAddon.fit()
      await new Promise(r => requestAnimationFrame(r));
      refitAll();
    }
  }

  async function closeTab(id) {
    if (tabs.size <= 1) return;
    const tab = tabs.get(id);
    if (!tab) return;
    for (const paneId of [...tab.panes.keys()]) {
      const pane = tab.panes.get(paneId);
      if (pane.type === 'terminal') {
        window.electronAPI.killPty(paneId);
        pane.terminal.dispose();
      }
      if (pane.resizeObserver) pane.resizeObserver.disconnect();
      pane.element.remove();
      tab.panes.delete(paneId);
      globalPanes.delete(paneId);
    }
    tab.gridEl.remove();
    tabs.delete(id);
    if (activeTabId === id) {
      const remaining = [...tabs.keys()];
      await switchTab(remaining[remaining.length - 1]);
    } else {
      renderTabBar();
    }
  }

  // ── Gather state of all tabs (for save-on-close) ─────
  async function gatherAllTabsState() {
    const tabsData = [];
    for (const [, tab] of tabs) {
      const panesData = await Promise.all([...tab.panes.values()].map(async (pane) => {
        if (pane.type === 'explorer') {
          return { type: 'explorer', name: pane.name || null, gridArea: pane.element.style.gridArea || '', cwd: pane.cwd || null };
        } else if (pane.type === 'terminal') {
          const info = pane.ptyCreated ? await window.electronAPI.getPaneInfo(pane.id) : { cwd: null, command: null };
          return {
            type: 'terminal',
            name: pane.name || null,
            gridArea: pane.element.style.gridArea || '',
            shell: pane.shell,
            cwd: info.cwd || pane.cwd || null,
            initCommand: pane.initCommand || null,
            claudeSessionId: pane.claudeSessionId || undefined,
            command: pane.lastCommand || info.command || null,
            predefinedCommands: pane.predefinedCommands?.length ? pane.predefinedCommands : undefined,
          };
        } else if (pane.type === 'text') {
          return { type: 'text', name: pane.name || null, gridArea: pane.element.style.gridArea || '', filePath: pane.filePath || null };
        } else {
          return { type: 'browser', name: pane.name || null, gridArea: pane.element.style.gridArea || '', url: pane.urlInput?.value || 'https://www.google.com' };
        }
      }));
      tabsData.push({
        name: tab.name,
        gridClass: tab.gridEl.className.replace(/\btab-grid\b|\bhidden\b/g, '').trim(),
        gridTemplateAreas:   tab.gridEl.style.gridTemplateAreas,
        gridTemplateColumns: tab.gridEl.style.gridTemplateColumns,
        gridTemplateRows:    tab.gridEl.style.gridTemplateRows,
        panes: panesData,
      });
    }
    return {
      savedAt: new Date().toISOString(),
      tabs: tabsData,
      activeTabIndex: [...tabs.keys()].indexOf(activeTabId),
    };
  }

  // ── Restore all tabs from last state ─────────────────
  async function restoreAllTabs(lastState) {
    // Force-close all current tabs
    for (const [, tab] of tabs) {
      for (const paneId of [...tab.panes.keys()]) {
        const pane = tab.panes.get(paneId);
        if (pane.type === 'terminal') { window.electronAPI.killPty(paneId); pane.terminal.dispose(); }
        pane.element.remove();
        globalPanes.delete(paneId);
      }
      tab.gridEl.remove();
    }
    tabs.clear();
    activeTabId = null;

    if (!lastState.tabs?.length) { await createTab('Tab 1'); return; }

    // Create all tab containers (hidden initially)
    const tabIds = [];
    for (const tabData of lastState.tabs) {
      const id = nextTabId++;
      const gridEl = document.createElement('div');
      gridEl.className = 'tab-grid layout-solo hidden';
      document.getElementById('grid-container').appendChild(gridEl);
      setupGridResizing(gridEl);
      tabs.set(id, { id, name: tabData.name, gridEl, panes: new Map() });
      tabIds.push(id);
    }

    const activeIdx = Math.min(lastState.activeTabIndex || 0, tabIds.length - 1);

    // Load each tab — skip PTY init for all during restore (terminals init after UI is ready)
    for (let i = 0; i < lastState.tabs.length; i++) {
      const id = tabIds[i];
      const tab = tabs.get(id);
      tab.gridEl.classList.remove('hidden');
      activeTabId = id;
      panes = tab.panes;
      grid  = tab.gridEl;
      await loadSession(lastState.tabs[i], true);  // always skip PTY init here
      if (i !== activeIdx) tab.gridEl.classList.add('hidden');
    }

    // Activate the saved active tab
    activeTabId = tabIds[activeIdx];
    tabs.get(activeTabId).gridEl.classList.remove('hidden');
    renderTabBar();
    updateAddButton();

    // Initialize terminals for ALL tabs.
    // Non-active tabs are temporarily un-hidden so xterm can measure dimensions.
    // Because .tab-grid uses position:absolute they overlay each other — no visual glitch.
    for (const [id, tab] of tabs) {
      const isActive = id === activeTabId;
      if (!isActive) tab.gridEl.classList.remove('hidden');
      panes = tab.panes;
      grid  = tab.gridEl;
      try { await initNewTerminals(); } catch (e) { console.error('[restore] init failed:', e); }
      if (!isActive) tab.gridEl.classList.add('hidden');
    }
    panes = tabs.get(activeTabId).panes;
    grid  = tabs.get(activeTabId).gridEl;
    refitAll();

    // Second pass: refit every tab after a delay to correct any terminal that
    // was sized against temporarily-wrong dimensions during the restore loop.
    setTimeout(() => {
      for (const tab of tabs.values())
        for (const pane of tab.panes.values())
          if (pane.fitAddon && pane.ptyCreated) try { pane.fitAddon.fit(); } catch {}
    }, 300);
  }

  // ── Close confirmation dialog ─────────────────────────
  function showCloseDialog() {
    return new Promise(resolve => {
      const overlay   = document.getElementById('close-dialog');
      const saveBtn   = document.getElementById('close-save-btn');
      const nosaveBtn = document.getElementById('close-nosave-btn');
      const cancelBtn = document.getElementById('close-cancel-btn');
      overlay.classList.remove('hidden');
      const finish = (result) => {
        overlay.classList.add('hidden');
        saveBtn.removeEventListener('click', onSave);
        nosaveBtn.removeEventListener('click', onNoSave);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onSave   = () => finish('save');
      const onNoSave = () => finish('nosave');
      const onCancel = () => finish('cancel');
      const onKey    = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish('cancel'); } };
      saveBtn.addEventListener('click', onSave);
      nosaveBtn.addEventListener('click', onNoSave);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }

  // ── Resume session dialog ─────────────────────────────
  function showResumeDialog(lastState) {
    return new Promise(resolve => {
      const overlay = document.getElementById('resume-dialog');
      const infoEl  = document.getElementById('resume-dialog-info');
      const yesBtn  = document.getElementById('resume-yes-btn');
      const noBtn   = document.getElementById('resume-no-btn');
      const tabCount = lastState.tabs?.length || 0;
      const savedAt  = lastState.savedAt ? new Date(lastState.savedAt).toLocaleString() : 'unknown';
      infoEl.textContent = `${tabCount} tab${tabCount !== 1 ? 's' : ''} saved on ${savedAt}`;
      overlay.classList.remove('hidden');
      const finish = (result) => {
        overlay.classList.add('hidden');
        yesBtn.removeEventListener('click', onYes);
        noBtn.removeEventListener('click', onNo);
        resolve(result);
      };
      const onYes = () => finish(true);
      const onNo  = () => finish(false);
      yesBtn.addEventListener('click', onYes);
      noBtn.addEventListener('click', onNo);
    });
  }

  // ── Init ──────────────────────────────────────────────
  if (isDetached) {
    // Detached window: hide chrome, create a single pane from URL config
    document.getElementById('toolbar').style.display = 'none';
    document.getElementById('tab-bar').style.display  = 'none';
    (async () => {
      await createTab(detachedConfig.name || 'Detached');
      const cwd = detachedConfig.type === 'text'
        ? (detachedConfig.filePath || null)
        : (detachedConfig.cwd || null);
      createPane(
        detachedConfig.type, null,
        detachedConfig.shell || null,
        cwd,
        detachedConfig.initCommand || null,
        detachedConfig.name || null,
        detachedConfig.type === 'browser' ? (detachedConfig.url || null) : null
      );
      updateDefaultLayout();
      await initNewTerminals();
    })();
  } else {
    document.getElementById('btn-new-tab').addEventListener('click', () => createTab());

    document.getElementById('btn-devtools').addEventListener('click', () => {
      window.electronAPI.openDevTools();
    });

    document.getElementById('btn-restart').addEventListener('click', () => {
      window.electronAPI.restartApp();
    });

    document.getElementById('btn-save-state').addEventListener('click', async () => {
      const btn = document.getElementById('btn-save-state');
      const state = await gatherAllTabsState();
      const result = await window.electronAPI.saveLastState(state);
      if (result.success) {
        btn.textContent = '✓';
        btn.style.background = '#388a34';
        setTimeout(() => { btn.textContent = '💾'; btn.style.background = ''; }, 1500);
      }
    });

    document.getElementById('btn-recall-state').addEventListener('click', async () => {
      const lastState = await window.electronAPI.loadLastState();
      if (!lastState?.tabs?.length) return;
      const resume = await showResumeDialog(lastState);
      if (resume) await restoreAllTabs(lastState);
    });

    setupDropdowns();

    (async () => {
      await createTab('Tab 1');

      // Check for saved last state
      const lastState = await window.electronAPI.loadLastState();
      if (lastState?.tabs?.length) {
        const resume = await showResumeDialog(lastState);
        if (resume) await restoreAllTabs(lastState);
      }

      let categorized;
      try {
        const text = await window.electronAPI.loadLayouts();
        if (text) {
          const parsed = parseConfigFile(text);
          if (parsed.length > 0) categorized = categorize(parsed);
        }
      } catch (e) {
        console.warn('Failed to load layouts config:', e);
      }

      if (!categorized) {
        // Fall back to built-in ASCII definitions
        const parsed = BUILTIN_ASCII.map(({ name, art }) =>
          parseAsciiLayout(name, art.split('\n'))
        );
        categorized = categorize(parsed);
      }

      buildViewMenu(document.getElementById('view-menu'), categorized);
      buildShellSubmenu(await window.electronAPI.listShells());
      updateAddButton();

      // Re-attach a detached pane when its window is closed
      window.electronAPI.onPaneReattach(async (config) => {
        const { _snapshot, gridArea, ...rest } = config;
        if (_snapshot) {
          // Restore the grid template that was active when the pane was detached
          if (_snapshot.gridClass) {
            grid.className = 'tab-grid ' + _snapshot.gridClass;
            grid.style.removeProperty('grid-template-areas');
            grid.style.removeProperty('grid-template-columns');
            grid.style.removeProperty('grid-template-rows');
          } else {
            grid.className = 'tab-grid';
            if (_snapshot.gridTemplateAreas)   grid.style.gridTemplateAreas   = _snapshot.gridTemplateAreas;
            if (_snapshot.gridTemplateColumns) grid.style.gridTemplateColumns = _snapshot.gridTemplateColumns;
            if (_snapshot.gridTemplateRows)    grid.style.gridTemplateRows    = _snapshot.gridTemplateRows;
          }
          // Restore remaining panes to their original positions
          for (const { id: pid, area } of _snapshot.paneAreas) {
            const p = panes.get(pid);
            if (p) p.element.style.gridArea = area;
          }
        }
        const cwd = rest.type === 'text' ? (rest.filePath || null) : (rest.cwd || null);
        createPane(rest.type, gridArea, rest.shell || null, cwd, rest.initCommand || null, rest.name || null, rest.type === 'browser' ? (rest.url || null) : null);
        grid._updateResizeHandles?.();
        updateAddButton();
        await initNewTerminals();
        refitAll();
      });

      // Handle window close request
      window.electronAPI.onCloseRequested(async () => {
        const choice = await showCloseDialog();
        if (choice === 'cancel') return;
        const lastState = choice === 'save' ? await gatherAllTabsState() : null;
        window.electronAPI.confirmClose(lastState);
      });

      // ── STT ─────────────────────────────────────────────
      initStt();
    })();
  }

  // ── STT recording ─────────────────────────────────────
  let sttRecording   = false;
  let sttState       = null;
  let mediaRecorder  = null;
  let mediaStream    = null;
  let audioChunks    = [];
  let sttMicLabel    = null;   // cached mic name for the tooltip

  async function refreshMicLabel() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      // Prefer the device explicitly labelled 'default', otherwise take the first mic
      const def = mics.find(d => d.deviceId === 'default') || mics[0];
      // Strip the leading "Default - " prefix Windows adds, if present
      const raw = def?.label || '';
      sttMicLabel = raw.replace(/^Default\s*[-–]\s*/i, '') || null;
    } catch {
      sttMicLabel = null;
    }
  }

  function updateSttBtn(s) {
    const btn = document.getElementById('btn-stt');
    if (!btn) return;
    btn.classList.remove('stt-recording', 'stt-downloading');
    if (sttRecording) {
      btn.disabled = false;
      btn.classList.add('stt-recording');
      btn.title = 'Recording… (click to stop)';
    } else if (s?.downloading) {
      btn.disabled = true;
      btn.classList.add('stt-downloading');
      const pct = Math.round((s.progress || 0) * 100);
      btn.title = `Downloading STT model… ${pct}%`;
    } else if (s?.available) {
      btn.disabled = false;
      const mic = sttMicLabel ? ` — ${sttMicLabel}` : '';
      btn.title = `Dictate (click to start recording)${mic}`;
    } else if (s?.error) {
      btn.disabled = false;
      btn.title = `STT error — click to retry\n${s.error}`;
    } else {
      btn.disabled = false;
      btn.title = 'STT model not downloaded — click to download (~40 MB)';
    }
  }

  async function startRecording() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(mediaStream);
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = processAudio;
      mediaRecorder.start();
      sttRecording = true;
      updateSttBtn(null);
    } catch (e) {
      console.error('[STT] Failed to start recording:', e);
      sttRecording = false;
      sttState = await window.electronAPI.sttGetStatus();
      updateSttBtn(sttState);
    }
  }

  function stopRecording() {
    sttRecording = false;
    if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop();
    mediaStream?.getTracks().forEach(t => t.stop());
    mediaStream = null;
    // Re-enumerate after first permission grant so labels are now populated
    refreshMicLabel().then(() => updateSttBtn(sttState));
  }

  async function processAudio() {
    if (!audioChunks.length) return;
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
    audioChunks = [];

    try {
      const arrayBuffer = await blob.arrayBuffer();

      // Decode the compressed audio from MediaRecorder
      const decodeCtx   = new AudioContext();
      const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
      await decodeCtx.close();

      // Resample to 16 kHz mono (required by the whisper model)
      const targetRate = 16000;
      const length     = Math.ceil(audioBuffer.duration * targetRate);
      const offlineCtx = new OfflineAudioContext(1, length, targetRate);
      const src        = offlineCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(offlineCtx.destination);
      src.start(0);
      const rendered = await offlineCtx.startRendering();
      const samples  = rendered.getChannelData(0); // Float32Array, 16 kHz mono

      const lang = document.getElementById('stt-lang')?.value || 'en';
      const text = await window.electronAPI.sttTranscribe(samples, targetRate, lang);
      if (text && lastFocusedTerminalId) {
        const pane = globalPanes.get(lastFocusedTerminalId);
        if (pane?.ptyCreated) {
          window.electronAPI.writePty(lastFocusedTerminalId, text);
          pane.terminal.focus();
        }
      }
    } catch (e) {
      console.error('[STT] Audio processing error:', e);
    }
  }

  function initStt() {
    const btn = document.getElementById('btn-stt');
    if (!btn) return;

    // Restore saved language preference
    const langSelect = document.getElementById('stt-lang');
    if (langSelect) {
      const saved = localStorage.getItem('stt-language');
      if (saved) langSelect.value = saved;
      langSelect.addEventListener('change', () => {
        localStorage.setItem('stt-language', langSelect.value);
      });
    }

    btn.addEventListener('click', () => {
      console.log('[STT] btn click — sttState:', JSON.stringify(sttState), 'sttRecording:', sttRecording);
      if (sttRecording) stopRecording();
      else if (sttState?.available) startRecording();
      else {
        console.log('[STT] triggering download via IPC');
        window.electronAPI.sttDownload();
      }
    });

    // Listen for status updates from the main process (download progress, ready, etc.)
    window.electronAPI.onSttStatusChange(async state => {
      sttState = state;
      if (state?.available && !sttMicLabel) await refreshMicLabel();
      updateSttBtn(state);
    });

    // Apply initial state; refresh mic label if STT is already ready
    window.electronAPI.sttGetStatus().then(async s => {
      sttState = s;
      if (s?.available) await refreshMicLabel();
      updateSttBtn(s);
    }).catch(e => {
      console.error('[STT] sttGetStatus failed:', e);
      updateSttBtn(null);  // ensure button is enabled even on IPC failure
    });
  }

})();
