// ─────────────────────────────────────────────────────────────────────────────
// Layout model — pure geometry for the Layout Designer.
//
// A layout is a grid of `rows` × `cols` tracks plus a list of panels, each
// occupying a half-open rectangle of cells [r0, r1) × [c0, c1).  Cells that no
// panel covers are "holes" and render as `.` in grid-template-areas.
//
//   {
//     rows, cols,
//     rowSizes: [1, 2, …],        // fr units, one per track
//     colSizes: [1, 1, …],
//     panels: [{ uid, paneId, type, name, r0, c0, r1, c1, cfg }],
//     defaults: { cwd, shell }    // shared settings panels inherit (optional)
//   }
//
// A panel of type 'blank' is an untyped placeholder: it holds a cell until
// the user picks a type, and blocks applying the layout until then.
//
// Every operation returns a NEW model (structural sharing is not attempted —
// layouts are tiny) so the designer can keep a plain undo stack of snapshots.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  const AREA_LETTERS = ['a','b','c','d','e','f','g','h','i','j','k','l'];
  const MAX_PANELS   = AREA_LETTERS.length;

  const PANEL_TYPES = ['terminal', 'ssh', 'browser', 'explorer', 'text', 'memory', 'tasks'];

  const TYPE_META = {
    terminal: { label: 'Terminal',    digit: '1', iconClass: 'icon-terminal' },
    browser:  { label: 'Browser',     digit: '2', iconClass: 'icon-browser'  },
    explorer: { label: 'Explorer',    digit: '3', iconClass: 'icon-explorer' },
    text:     { label: 'Text Editor', digit: '4', iconClass: 'icon-text'     },
    memory:   { label: 'Memory',      digit: null, iconClass: 'icon-memory'  },
    tasks:    { label: 'Tasks',       digit: null, iconClass: 'icon-tasks'   },
    ssh:      { label: 'SSH',         digit: null, iconClass: 'icon-ssh'     },
    blank:    { label: 'Untyped',     digit: null, iconClass: null           },
  };

  // Settings a panel takes from model.defaults when it has none of its own.
  const INHERITED_CFG = {
    terminal: ['cwd', 'shell'],
    explorer: ['cwd'],
  };

  let uidSeq = 1;
  const nextUid = () => `p${uidSeq++}`;

  // ── Helpers ───────────────────────────────────────────
  const clone = (model) => ({
    rows: model.rows,
    cols: model.cols,
    rowSizes: [...model.rowSizes],
    colSizes: [...model.colSizes],
    panels: model.panels.map(p => ({ ...p, cfg: { ...p.cfg } })),
    defaults: { ...(model.defaults || {}) },
  });

  function makePanel(type, r0, c0, r1, c1, extra = {}) {
    return {
      uid: nextUid(),
      paneId: null,
      type,
      name: null,
      r0, c0, r1, c1,
      cfg: {},
      ...extra,
    };
  }

  function emptyModel(defaults = {}) {
    return { rows: 1, cols: 1, rowSizes: [1], colSizes: [1], panels: [], defaults: { ...defaults } };
  }

  function findPanel(model, uid) {
    return model.panels.find(p => p.uid === uid) || null;
  }

  // 2-D array of panel uids (null = hole)
  function occupancy(model) {
    const g = Array.from({ length: model.rows }, () => new Array(model.cols).fill(null));
    for (const p of model.panels)
      for (let r = p.r0; r < p.r1; r++)
        for (let c = p.c0; c < p.c1; c++)
          if (r >= 0 && r < model.rows && c >= 0 && c < model.cols) g[r][c] = p.uid;
    return g;
  }

  function panelAt(model, r, c) {
    return model.panels.find(p => r >= p.r0 && r < p.r1 && c >= p.c0 && c < p.c1) || null;
  }

  function holes(model) {
    const g = occupancy(model);
    const out = [];
    for (let r = 0; r < model.rows; r++)
      for (let c = 0; c < model.cols; c++)
        if (g[r][c] === null) out.push({ r, c });
    return out;
  }

  // Panels ordered top-to-bottom, left-to-right by their top-left cell.
  function readingOrder(model) {
    return [...model.panels].sort((a, b) => (a.r0 - b.r0) || (a.c0 - b.c0));
  }

  // ── CSS generation ────────────────────────────────────
  function modelToCss(model) {
    const ordered   = readingOrder(model);
    const areaByUid = {};
    ordered.forEach((p, i) => { areaByUid[p.uid] = AREA_LETTERS[i] || null; });

    const cells = Array.from({ length: model.rows }, () => new Array(model.cols).fill('.'));
    for (const p of ordered) {
      const letter = areaByUid[p.uid];
      if (!letter) continue;
      for (let r = p.r0; r < p.r1; r++)
        for (let c = p.c0; c < p.c1; c++)
          cells[r][c] = letter;
    }

    return {
      gridTemplateAreas:   cells.map(row => `"${row.join(' ')}"`).join(' '),
      gridTemplateColumns: model.colSizes.map(s => `${round(s)}fr`).join(' '),
      gridTemplateRows:    model.rowSizes.map(s => `${round(s)}fr`).join(' '),
      areaByUid,
      order: ordered,
    };
  }

  const round = (n) => +(+n).toFixed(4);

  // ── Construction ──────────────────────────────────────

  // Build a model from the live grid element + its panes Map.
  // Falls back to computed styles so CSS-class layouts (layout-quad, …) work too.
  function modelFromGrid(gridEl, panesMap) {
    const cs        = getComputedStyle(gridEl);
    const rawAreas  = gridEl.style.gridTemplateAreas || cs.gridTemplateAreas;
    const colTracks = parseTracks(gridEl.style.gridTemplateColumns || cs.gridTemplateColumns);
    const rowTracks = parseTracks(gridEl.style.gridTemplateRows    || cs.gridTemplateRows);

    const areaRows = parseAreaString(rawAreas);
    const paneList = [...panesMap.values()];

    // No usable template (single pane / empty tab) → derive a simple grid.
    if (!areaRows.length) {
      const n = paneList.length;
      const cols = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : 3;
      const rows = Math.max(1, Math.ceil(n / cols));
      const model = { rows, cols, rowSizes: fill(rows), colSizes: fill(cols), panels: [] };
      paneList.forEach((pane, i) => {
        const r = Math.floor(i / cols), c = i % cols;
        model.panels.push(paneFromLive(pane, r, c, r + 1, c + 1));
      });
      return simplify(model);
    }

    const rows = areaRows.length;
    const cols = Math.max(...areaRows.map(r => r.length));
    const model = {
      rows, cols,
      rowSizes: normalizeSizes(rowTracks, rows),
      colSizes: normalizeSizes(colTracks, cols),
      panels: [],
    };

    // Map each named area → bounding rectangle
    const bounds = new Map();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const name = areaRows[r][c];
        if (!name || name === '.') continue;
        const b = bounds.get(name);
        if (!b) bounds.set(name, { r0: r, c0: c, r1: r + 1, c1: c + 1 });
        else {
          b.r0 = Math.min(b.r0, r); b.c0 = Math.min(b.c0, c);
          b.r1 = Math.max(b.r1, r + 1); b.c1 = Math.max(b.c1, c + 1);
        }
      }
    }

    // Attach live panes to their area; panes without one get appended to holes.
    const unplaced = [];
    for (const pane of paneList) {
      const area = (pane.element.style.gridArea || '').trim();
      const b = area ? bounds.get(area) : null;
      if (b && !b._taken) {
        b._taken = true;
        model.panels.push(paneFromLive(pane, b.r0, b.c0, b.r1, b.c1));
      } else {
        unplaced.push(pane);
      }
    }
    for (const pane of unplaced) {
      const free = holes(model)[0];
      if (free) model.panels.push(paneFromLive(pane, free.r, free.c, free.r + 1, free.c + 1));
      else {
        // No room left — append a row and drop it in the first column.
        const grown = addRow(model, model.rows);
        model.rows = grown.rows; model.rowSizes = grown.rowSizes; model.panels = grown.panels;
        model.panels.push(paneFromLive(pane, model.rows - 1, 0, model.rows, 1));
      }
    }

    return simplify(model);
  }

  function paneFromLive(pane, r0, c0, r1, c1) {
    const cfg = {};
    if (pane.type === 'terminal') {
      cfg.shell        = pane.shell || null;
      cfg.cwd          = pane.cwd || null;
      cfg.command      = pane.initCommand || null;
      cfg.isClaudePane = !!pane.isClaudePane;
    } else if (pane.type === 'browser') {
      cfg.url = pane.urlInput?.value || null;
    } else if (pane.type === 'explorer') {
      cfg.cwd = pane.cwd || null;
    } else if (pane.type === 'text') {
      cfg.filePath = pane.filePath || null;
    } else if (pane.type === 'memory') {
      cfg.vaultPath = pane.vaultPath || null;
    } else if (pane.type === 'tasks') {
      cfg.tasksPath = pane.tasksPath || null;
    } else if (pane.type === 'ssh') {
      cfg.sshProfileId = pane.sshProfileId || null;
    }
    return makePanel(pane.type, r0, c0, r1, c1, { paneId: pane.id, name: pane.name || null, cfg });
  }

  // "a b" "a c"  →  [['a','b'], ['a','c']]
  function parseAreaString(str) {
    if (!str || str === 'none') return [];
    const rows = [];
    const re = /"([^"]*)"/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const cells = m[1].trim().split(/\s+/).filter(Boolean);
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return [];
    const width = Math.max(...rows.map(r => r.length));
    for (const r of rows) while (r.length < width) r.push('.');
    return rows;
  }

  // "1fr 2fr" / "240px 480px" / "repeat(2, 1fr)" → [1, 2]
  function parseTracks(str) {
    if (!str || str === 'none') return [];
    const repeat = /^\s*repeat\(\s*(\d+)\s*,\s*([^)]+)\)\s*$/.exec(str);
    if (repeat) {
      const n = parseInt(repeat[1], 10);
      const v = parseFloat(repeat[2]) || 1;
      return new Array(n).fill(v);
    }
    return str.trim().split(/\s+/).map(v => parseFloat(v)).filter(n => !isNaN(n) && n > 0);
  }

  const fill = (n, v = 1) => new Array(n).fill(v);

  // Coerce a track list to exactly `n` entries.
  function padSizes(tracks, n) {
    if (!tracks.length) return fill(n);
    const out = tracks.slice(0, n).map(round);
    while (out.length < n) out.push(out[out.length - 1] ?? 1);
    return out;
  }

  // Same, but rescaled so the smallest track is 1 — used when the source is
  // resolved pixel values from getComputedStyle.
  function normalizeSizes(tracks, n) {
    const out = padSizes(tracks, n);
    const min = Math.min(...out);
    return min > 0 ? out.map(v => round(v / min)) : fill(n);
  }

  // Build a model from parseAsciiLayout()'s output (uniform tracks, no holes).
  function modelFromAscii(parsed) {
    const areaRows = parseAreaString(parsed.gridCSS.gridTemplateAreas);
    const rows = areaRows.length;
    const cols = rows ? areaRows[0].length : 1;
    const model = { rows, cols, rowSizes: fill(rows), colSizes: fill(cols), panels: [] };

    const typeOf = { T: 'terminal', B: 'browser', E: 'explorer', X: 'text' };
    parsed.areas.forEach((letter, i) => {
      let r0 = Infinity, c0 = Infinity, r1 = 0, c1 = 0;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          if (areaRows[r][c] === letter) {
            r0 = Math.min(r0, r); c0 = Math.min(c0, c);
            r1 = Math.max(r1, r + 1); c1 = Math.max(c1, c + 1);
          }
      if (r0 === Infinity) return;
      model.panels.push(makePanel(typeOf[parsed.slots[i]] || 'terminal', r0, c0, r1, c1));
    });
    return model;
  }

  // ── Serialization (layouts.json) ──────────────────────
  function toJSON(model) {
    return {
      rows: model.rows,
      cols: model.cols,
      rowSizes: model.rowSizes.map(round),
      colSizes: model.colSizes.map(round),
      panels: model.panels.map(p => ({
        type: p.type,
        name: p.name || null,
        r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1,
        cfg: { ...p.cfg },
      })),
      defaults: cleanDefaults(model.defaults),
    };
  }

  const cleanDefaults = (d = {}) => {
    const out = {};
    for (const [k, v] of Object.entries(d)) if (v) out[k] = v;
    return out;
  };

  function fromJSON(data) {
    const rows = Math.max(1, data.rows | 0);
    const cols = Math.max(1, data.cols | 0);
    return {
      rows, cols,
      rowSizes: padSizes((data.rowSizes || []).map(Number).filter(n => n > 0), rows),
      colSizes: padSizes((data.colSizes || []).map(Number).filter(n => n > 0), cols),
      panels: (data.panels || [])
        .filter(p => PANEL_TYPES.includes(p.type))
        .map(p => makePanel(p.type, p.r0, p.c0, p.r1, p.c1, { name: p.name || null, cfg: { ...(p.cfg || {}) } })),
      defaults: cleanDefaults(data.defaults),
    };
  }

  // ── ASCII export ──────────────────────────────────────
  //
  // The ASCII notation can't express every grid (a space extends from ABOVE
  // before LEFT, so some horizontal spans are ambiguous), and it has no
  // notation for holes, custom track sizes, or memory/tasks panes.  Generate a
  // candidate, re-parse it with the real parser, and only return it if the
  // round-trip is identical.
  function modelToAscii(model, parseAsciiLayout) {
    if (holes(model).length) return { ok: false, reason: 'Layout has empty cells, which ASCII layouts cannot express.' };
    if (!isUniform(model.rowSizes) || !isUniform(model.colSizes))
      return { ok: false, reason: 'Panel sizes are not equal, which ASCII layouts cannot express.' };
    const bad = model.panels.find(p => !TYPE_META[p.type].digit);
    if (bad) return { ok: false, reason: `${TYPE_META[bad.type].label} panes have no ASCII digit.` };

    const grid = Array.from({ length: model.rows }, () => new Array(model.cols).fill(' '));
    for (const p of model.panels) grid[p.r0][p.c0] = TYPE_META[p.type].digit;
    const art = grid.map(row => row.join('').replace(/\s+$/, ''));

    if (typeof parseAsciiLayout === 'function') {
      let reparsed;
      try {
        reparsed = parseAsciiLayout('roundtrip', art.map(r => r));
      } catch (e) {
        return { ok: false, reason: 'This arrangement cannot be written as ASCII art.' };
      }
      const a = modelToCss(model).gridTemplateAreas;
      const b = modelToCss(modelFromAscii(reparsed)).gridTemplateAreas;
      if (a !== b) return { ok: false, reason: 'This arrangement cannot be written as ASCII art.' };
    }
    return { ok: true, art: art.join('\n') };
  }

  const isUniform = (arr) => arr.every(v => Math.abs(v - arr[0]) < 1e-6);

  // ── Track insertion / removal ─────────────────────────

  // Insert an empty track before index `idx` (0 … rows).  Panels straddling
  // that boundary are stretched over the new track.
  function insertTrack(model, axis, idx, size = 1) {
    const m = clone(model);
    const isRow = axis === 'row';
    const sizes = isRow ? m.rowSizes : m.colSizes;
    sizes.splice(idx, 0, size);
    if (isRow) m.rows++; else m.cols++;
    for (const p of m.panels) {
      const s = isRow ? 'r0' : 'c0';
      const e = isRow ? 'r1' : 'c1';
      if (p[s] >= idx) { p[s]++; p[e]++; }
      else if (p[e] > idx) { p[e]++; }
    }
    return m;
  }

  // Cut track `idx` in two.  Every panel covering that track grows by one
  // track, so only the panel the caller re-assigns actually changes shape —
  // this is what makes "split this pane" leave its neighbours alone.
  function subdivideTrack(model, axis, idx, firstSize, secondSize) {
    const m = clone(model);
    const isRow = axis === 'row';
    const sizes = isRow ? m.rowSizes : m.colSizes;
    sizes.splice(idx, 1, firstSize, secondSize);
    if (isRow) m.rows++; else m.cols++;
    const s = isRow ? 'r0' : 'c0';
    const e = isRow ? 'r1' : 'c1';
    for (const p of m.panels) {
      if (p[s] > idx) { p[s]++; p[e]++; }
      else if (p[e] > idx) { p[e]++; }   // covers idx → stretch over both halves
    }
    return m;
  }

  function removeTrack(model, axis, idx) {
    const isRow = axis === 'row';
    if ((isRow ? model.rows : model.cols) <= 1) return model;
    const m = clone(model);
    const sizes = isRow ? m.rowSizes : m.colSizes;
    sizes.splice(idx, 1);
    if (isRow) m.rows--; else m.cols--;
    const s = isRow ? 'r0' : 'c0';
    const e = isRow ? 'r1' : 'c1';
    m.panels = m.panels.filter(p => !(p[s] === idx && p[e] === idx + 1)); // panels living only there
    for (const p of m.panels) {
      if (p[s] > idx) { p[s]--; p[e]--; }
      else if (p[e] > idx) { p[e]--; }
    }
    return simplify(m);
  }

  const addRow = (model, idx = model.rows) => insertTrack(model, 'row', clampIdx(idx, model.rows));
  const addCol = (model, idx = model.cols) => insertTrack(model, 'col', clampIdx(idx, model.cols));
  const removeRow = (model, idx = model.rows - 1) => removeTrack(model, 'row', clampIdx(idx, model.rows - 1));
  const removeCol = (model, idx = model.cols - 1) => removeTrack(model, 'col', clampIdx(idx, model.cols - 1));

  const clampIdx = (i, max) => Math.max(0, Math.min(max, i | 0));

  // ── Panel operations ──────────────────────────────────

  // Split a panel in two.  'v' cuts vertically (side by side), 'h' cuts
  // horizontally (stacked).  When the panel already spans ≥2 tracks the cut
  // reuses an existing grid line; otherwise a new track is inserted and every
  // panel straddling it is stretched, so neighbours keep their shape.
  function splitPanel(model, uid, dir, newType = 'terminal', newCfg = {}) {
    const src = findPanel(model, uid);
    if (!src) return { model, newUid: null };
    if (model.panels.length >= MAX_PANELS)
      return { model, newUid: null, error: `Maximum ${MAX_PANELS} panels.` };

    const isRow = dir === 'h';
    const s = isRow ? 'r0' : 'c0';
    const e = isRow ? 'r1' : 'c1';
    const span = src[e] - src[s];

    let m, cut, secondEnd;
    if (span >= 2) {
      // Reuse an existing grid line — no new track needed.
      m = clone(model);
      cut = src[s] + Math.floor(span / 2);
      secondEnd = src[e];
    } else {
      const idx   = src[s];
      const sizes = isRow ? model.rowSizes : model.colSizes;
      const half  = round(sizes[idx] / 2);
      m = subdivideTrack(model, isRow ? 'row' : 'col', idx, half, round(sizes[idx] - half));
      cut = idx + 1;
      secondEnd = idx + 2;
    }

    const target = findPanel(m, uid);
    const second = makePanel(
      newType,
      isRow ? cut       : target.r0,
      isRow ? target.c0 : cut,
      isRow ? secondEnd : target.r1,
      isRow ? target.c1 : secondEnd,
      { cfg: { ...newCfg } }
    );
    target[e] = cut;
    m.panels.push(second);
    return { model: m, newUid: second.uid };
  }

  function deletePanel(model, uid) {
    const m = clone(model);
    m.panels = m.panels.filter(p => p.uid !== uid);
    return simplify(m);
  }

  function duplicatePanel(model, uid) {
    const src = findPanel(model, uid);
    if (!src) return { model, newUid: null };
    const dir = (src.c1 - src.c0) >= (src.r1 - src.r0) ? 'v' : 'h';
    const res = splitPanel(model, uid, dir, src.type, { ...src.cfg });
    const copy = res.newUid ? findPanel(res.model, res.newUid) : null;
    if (copy && src.name) copy.name = src.name;
    return res;
  }

  function swapPanels(model, uidA, uidB) {
    const m = clone(model);
    const a = findPanel(m, uidA), b = findPanel(m, uidB);
    if (!a || !b) return m;
    const rect = { r0: a.r0, c0: a.c0, r1: a.r1, c1: a.c1 };
    a.r0 = b.r0; a.c0 = b.c0; a.r1 = b.r1; a.c1 = b.c1;
    b.r0 = rect.r0; b.c0 = rect.c0; b.r1 = rect.r1; b.c1 = rect.c1;
    return m;
  }

  // Move a panel onto a hole: keep its size if the whole footprint is free,
  // otherwise shrink to the single target cell.
  function movePanelToCell(model, uid, r, c) {
    const m = clone(model);
    const p = findPanel(m, uid);
    if (!p) return m;
    const h = p.r1 - p.r0, w = p.c1 - p.c0;
    const others = m.panels.filter(o => o.uid !== uid);
    const freeAt = (r0, c0, rh, cw) => {
      if (r0 + rh > m.rows || c0 + cw > m.cols) return false;
      return !others.some(o => o.r0 < r0 + rh && o.r1 > r0 && o.c0 < c0 + cw && o.c1 > c0);
    };
    if (freeAt(r, c, h, w)) { p.r0 = r; p.c0 = c; p.r1 = r + h; p.c1 = c + w; }
    else if (freeAt(r, c, 1, 1)) { p.r0 = r; p.c0 = c; p.r1 = r + 1; p.c1 = c + 1; }
    return simplify(m);
  }

  // Extend a panel by one track if every cell it would take is empty.
  function growPanel(model, uid, dir) {
    const m = clone(model);
    const p = findPanel(m, uid);
    if (!p) return m;
    const others = m.panels.filter(o => o.uid !== uid);
    const rect = { r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1 };
    if (dir === 'up')    rect.r0--;
    if (dir === 'down')  rect.r1++;
    if (dir === 'left')  rect.c0--;
    if (dir === 'right') rect.c1++;
    if (rect.r0 < 0 || rect.c0 < 0 || rect.r1 > m.rows || rect.c1 > m.cols) return model;
    const clash = others.some(o => o.r0 < rect.r1 && o.r1 > rect.r0 && o.c0 < rect.c1 && o.c1 > rect.c0);
    if (clash) return model;
    Object.assign(p, rect);
    return m;
  }

  // Fill every hole reachable from this panel by repeatedly growing.
  function expandPanel(model, uid) {
    let m = model;
    let changed = true;
    while (changed) {
      changed = false;
      for (const dir of ['right', 'down', 'left', 'up']) {
        const next = growPanel(m, uid, dir);
        if (next !== m) { m = next; changed = true; }
      }
    }
    return m;
  }

  function setPanelType(model, uid, type) {
    const m = clone(model);
    const p = findPanel(m, uid);
    if (!p || p.type === type) return model;
    p.type = type;
    p.paneId = null;   // a different kind of pane can't reuse the live one
    p.cfg = {};
    return m;
  }

  function updatePanel(model, uid, patch) {
    const m = clone(model);
    const p = findPanel(m, uid);
    if (!p) return model;
    if ('name' in patch) p.name = patch.name || null;
    if ('cfg' in patch)  p.cfg  = { ...p.cfg, ...patch.cfg };
    return m;
  }

  function addPanel(model, type, cfg = {}) {
    if (model.panels.length >= MAX_PANELS) return { model, newUid: null, error: `Maximum ${MAX_PANELS} panels.` };

    // 1. Drop into the largest rectangular hole.
    const hole = largestHole(model);
    if (hole) {
      const m = clone(model);
      const p = makePanel(type, hole.r0, hole.c0, hole.r1, hole.c1, { cfg: { ...cfg } });
      m.panels.push(p);
      return { model: m, newUid: p.uid };
    }
    // 2. Otherwise split the panel with the largest area.
    if (model.panels.length) {
      const biggest = [...model.panels].sort((a, b) => area(model, b) - area(model, a))[0];
      const wide = (biggest.c1 - biggest.c0) * avg(model.colSizes, biggest.c0, biggest.c1)
                 >= (biggest.r1 - biggest.r0) * avg(model.rowSizes, biggest.r0, biggest.r1);
      const res = splitPanel(model, biggest.uid, wide ? 'v' : 'h', type, cfg);
      return res.model ? res : { model, newUid: null };
    }
    // 3. Empty layout.
    const m = emptyModel();
    const p = makePanel(type, 0, 0, 1, 1, { cfg: { ...cfg } });
    m.panels.push(p);
    return { model: m, newUid: p.uid };
  }

  const avg = (sizes, a, b) => {
    let t = 0;
    for (let i = a; i < b; i++) t += sizes[i] || 0;
    return t;
  };
  const area = (model, p) => avg(model.rowSizes, p.r0, p.r1) * avg(model.colSizes, p.c0, p.c1);

  // Largest all-empty rectangle (greedy: grow each hole right then down).
  function largestHole(model) {
    const g = occupancy(model);
    let best = null, bestArea = 0;
    for (let r = 0; r < model.rows; r++) {
      for (let c = 0; c < model.cols; c++) {
        if (g[r][c] !== null) continue;
        let c1 = c;
        while (c1 < model.cols && g[r][c1] === null) c1++;
        let r1 = r + 1;
        outer: while (r1 < model.rows) {
          for (let cc = c; cc < c1; cc++) if (g[r1][cc] !== null) break outer;
          r1++;
        }
        const a = avg(model.rowSizes, r, r1) * avg(model.colSizes, c, c1);
        if (a > bestArea) { bestArea = a; best = { r0: r, c0: c, r1, c1 }; }
      }
    }
    return best;
  }

  // ── Track sizing ──────────────────────────────────────
  function setTrackSize(model, axis, idx, value) {
    const m = clone(model);
    const sizes = axis === 'row' ? m.rowSizes : m.colSizes;
    if (idx < 0 || idx >= sizes.length) return model;
    sizes[idx] = Math.max(0.05, round(value));
    return m;
  }

  // Drag the boundary between track `idx` and `idx+1`, keeping their sum.
  function resizeTrackPair(model, axis, idx, firstSize) {
    const m = clone(model);
    const sizes = axis === 'row' ? m.rowSizes : m.colSizes;
    if (idx < 0 || idx + 1 >= sizes.length) return model;
    const total = sizes[idx] + sizes[idx + 1];
    const a = Math.max(total * 0.08, Math.min(total * 0.92, firstSize));
    sizes[idx] = round(a);
    sizes[idx + 1] = round(total - a);
    return m;
  }

  function equalizeTracks(model) {
    const m = clone(model);
    m.rowSizes = fill(m.rows);
    m.colSizes = fill(m.cols);
    return m;
  }

  // ── Simplify ──────────────────────────────────────────
  //
  // Drop tracks nothing occupies, then merge adjacent tracks that no panel
  // boundary falls between (they are redundant grid lines).
  function simplify(model) {
    let m = clone(model);

    // 1. Remove entirely empty rows / columns.
    for (let r = m.rows - 1; r >= 0 && m.rows > 1; r--) {
      if (m.panels.some(p => p.r0 <= r && p.r1 > r)) continue;
      m.rowSizes.splice(r, 1);
      m.rows--;
      for (const p of m.panels) { if (p.r0 > r) { p.r0--; p.r1--; } }
    }
    for (let c = m.cols - 1; c >= 0 && m.cols > 1; c--) {
      if (m.panels.some(p => p.c0 <= c && p.c1 > c)) continue;
      m.colSizes.splice(c, 1);
      m.cols--;
      for (const p of m.panels) { if (p.c0 > c) { p.c0--; p.c1--; } }
    }

    // 2. Merge redundant interior lines.
    for (let r = m.rows - 1; r >= 1; r--) {
      const used = m.panels.some(p => p.r0 === r || p.r1 === r);
      if (used) continue;
      m.rowSizes[r - 1] = round(m.rowSizes[r - 1] + m.rowSizes[r]);
      m.rowSizes.splice(r, 1);
      m.rows--;
      for (const p of m.panels) { if (p.r0 >= r) p.r0--; if (p.r1 >= r) p.r1--; }
    }
    for (let c = m.cols - 1; c >= 1; c--) {
      const used = m.panels.some(p => p.c0 === c || p.c1 === c);
      if (used) continue;
      m.colSizes[c - 1] = round(m.colSizes[c - 1] + m.colSizes[c]);
      m.colSizes.splice(c, 1);
      m.cols--;
      for (const p of m.panels) { if (p.c0 >= c) p.c0--; if (p.c1 >= c) p.c1--; }
    }

    return m;
  }

  // ── Auto arrange ──────────────────────────────────────
  //
  // Reflow the existing panels (in reading order) into an n-up preset; cells
  // left over are filled with untyped placeholders.
  const ARRANGEMENTS = {
    1:  { rows: 1, cols: 1, cells: [[0,0,1,1]] },
    2:  { rows: 1, cols: 2, cells: [[0,0,1,1],[0,1,1,2]] },
    '2v': { rows: 2, cols: 1, cells: [[0,0,1,1],[1,0,2,1]] },
    3:  { rows: 1, cols: 3, cells: [[0,0,1,1],[0,1,1,2],[0,2,1,3]] },
    '3l': { rows: 2, cols: 2, cells: [[0,0,2,1],[0,1,1,2],[1,1,2,2]] },
    4:  { rows: 2, cols: 2, cells: [[0,0,1,1],[0,1,1,2],[1,0,2,1],[1,1,2,2]] },
    5:  { rows: 3, cols: 2, cells: [[0,0,1,1],[0,1,1,2],[1,0,2,1],[1,1,2,2],[2,0,3,2]] },
    6:  { rows: 2, cols: 3, cells: [[0,0,1,1],[0,1,1,2],[0,2,1,3],[1,0,2,1],[1,1,2,2],[1,2,2,3]] },
    8:  { rows: 2, cols: 4, cells: [[0,0,1,1],[0,1,1,2],[0,2,1,3],[0,3,1,4],[1,0,2,1],[1,1,2,2],[1,2,2,3],[1,3,2,4]] },
    9:  { rows: 3, cols: 3, cells: [[0,0,1,1],[0,1,1,2],[0,2,1,3],[1,0,2,1],[1,1,2,2],[1,2,2,3],[2,0,3,1],[2,1,3,2],[2,2,3,3]] },
    12: { rows: 3, cols: 4, cells: [[0,0,1,1],[0,1,1,2],[0,2,1,3],[0,3,1,4],[1,0,2,1],[1,1,2,2],[1,2,2,3],[1,3,2,4],[2,0,3,1],[2,1,3,2],[2,2,3,3],[2,3,3,4]] },
  };

  function autoArrange(model, key) {
    const preset = ARRANGEMENTS[key];
    if (!preset) return model;
    const ordered = readingOrder(model).slice(0, preset.cells.length);
    const m = {
      rows: preset.rows,
      cols: preset.cols,
      rowSizes: fill(preset.rows),
      colSizes: fill(preset.cols),
      panels: [],
      defaults: { ...(model.defaults || {}) },
    };
    preset.cells.forEach((cell, i) => {
      const src = ordered[i];
      if (!src) m.panels.push(makePanel('blank', cell[0], cell[1], cell[2], cell[3]));
      else m.panels.push({ ...src, cfg: { ...src.cfg }, r0: cell[0], c0: cell[1], r1: cell[2], c1: cell[3] });
    });
    return simplify(m);
  }

  // The arrangement that exactly fits n panels, if there is one.
  function arrangementFor(n) {
    return ARRANGEMENTS[n] ? String(n) : null;
  }

  // ── Unconfigured panels ───────────────────────────────
  //
  // Settings a new panel needs before it is of any use.  Missing ones are a
  // warning, not an error: the pane still opens, it just lands empty.  Panels
  // that reuse a live pane are exempt — that pane is already set up.
  const REQUIRED_CFG = {
    terminal: { keys: ['command', 'cwd'], label: 'no command or folder' },
    browser:  { keys: ['url'],            label: 'no URL' },
    explorer: { keys: ['cwd'],            label: 'no folder' },
    text:     { keys: ['filePath'],       label: 'no file' },
    memory:   { keys: ['vaultPath'],      label: 'no vault folder' },
    tasks:    { keys: ['tasksPath'],      label: 'no tasks folder' },
    ssh:      { keys: ['sshProfileId'],   label: 'no SSH profile' },
  };

  function panelIssue(panel, defaults = {}) {
    if (panel.paneId != null) return null;
    const req = REQUIRED_CFG[panel.type];
    if (!req) return null;
    const cfg = effectiveCfg(panel, defaults);
    return req.keys.some(k => cfg[k]) ? null : req.label;
  }

  function unconfigured(model) {
    return model.panels
      .filter(p => p.type !== 'blank')
      .map(p => ({ panel: p, issue: panelIssue(p, model.defaults) }))
      .filter(x => x.issue);
  }

  // ── Shared defaults ───────────────────────────────────

  // The panel's cfg with any missing inheritable keys taken from `defaults`.
  function effectiveCfg(panel, defaults = {}) {
    const cfg = { ...(panel.cfg || {}) };
    for (const k of INHERITED_CFG[panel.type] || [])
      if (!cfg[k] && defaults[k]) cfg[k] = defaults[k];
    return cfg;
  }

  // Keys of the panel's effective cfg that come from `defaults`.
  function inheritedKeys(panel, defaults = {}) {
    const cfg = panel.cfg || {};
    return (INHERITED_CFG[panel.type] || []).filter(k => !cfg[k] && defaults[k]);
  }

  // Bake the defaults into every panel's cfg (live ones too — the designer shows
  // them as inherited, and applyModel restarts a live terminal whose cfg changed).
  function resolveDefaults(model) {
    const m = clone(model);
    for (const p of m.panels) p.cfg = effectiveCfg(p, m.defaults);
    return m;
  }

  function setDefaults(model, patch) {
    const m = clone(model);
    m.defaults = cleanDefaults({ ...m.defaults, ...patch });
    return m;
  }

  // "Terminal (no command or folder), Explorer (no folder) and 2 more"
  function describeUnconfigured(list, max = 3) {
    const shown = list.slice(0, max).map(x => `${panelLabel(x.panel)} (${x.issue})`);
    const rest  = list.length - shown.length;
    if (rest > 0) shown.push(`${rest} more`);
    if (shown.length === 1) return shown[0];
    return shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1];
  }

  // ── Validation ────────────────────────────────────────
  function validate(model) {
    const errors = [], warnings = [];

    if (!model.panels.length) errors.push('The layout has no panels.');
    if (model.panels.length > MAX_PANELS) errors.push(`Too many panels — maximum is ${MAX_PANELS}.`);

    const untyped = model.panels.filter(p => p.type === 'blank').length;
    if (untyped) errors.push(`${untyped} panel${untyped > 1 ? 's have' : ' has'} no type yet — click to choose one.`);

    for (const p of model.panels) {
      if (p.r0 < 0 || p.c0 < 0 || p.r1 > model.rows || p.c1 > model.cols || p.r1 <= p.r0 || p.c1 <= p.c0)
        errors.push(`Panel "${panelLabel(p)}" is out of bounds.`);
    }

    const seen = new Map();
    for (const p of model.panels) {
      for (let r = p.r0; r < p.r1; r++) {
        for (let c = p.c0; c < p.c1; c++) {
          const key = `${r},${c}`;
          if (seen.has(key)) errors.push(`Panels "${panelLabel(seen.get(key))}" and "${panelLabel(p)}" overlap.`);
          else seen.set(key, p);
        }
      }
    }

    const nHoles = holes(model).length;
    if (nHoles) warnings.push(`${nHoles} empty cell${nHoles > 1 ? 's' : ''} — the space will stay blank.`);

    const blank = unconfigured(model);
    if (blank.length)
      warnings.push(`${blank.length} panel${blank.length > 1 ? 's have' : ' has'} no settings yet: ${describeUnconfigured(blank)}.`);

    return { ok: errors.length === 0, errors, warnings, unconfigured: blank };
  }

  function panelLabel(p) {
    return p.name || TYPE_META[p.type]?.label || p.type;
  }

  // ── Exports ───────────────────────────────────────────
  window.LayoutModel = {
    AREA_LETTERS, MAX_PANELS, PANEL_TYPES, TYPE_META, ARRANGEMENTS,
    clone, emptyModel, makePanel, findPanel, occupancy, panelAt, holes, readingOrder,
    modelToCss, modelFromGrid, modelFromAscii, modelToAscii, toJSON, fromJSON,
    addRow, addCol, removeRow, removeCol, insertTrack, removeTrack,
    splitPanel, deletePanel, duplicatePanel, swapPanels, movePanelToCell,
    growPanel, expandPanel, setPanelType, updatePanel, addPanel,
    setTrackSize, resizeTrackPair, equalizeTracks, simplify,
    autoArrange, arrangementFor, validate, panelLabel, largestHole,
    panelIssue, unconfigured, describeUnconfigured,
    INHERITED_CFG, effectiveCfg, inheritedKeys, resolveDefaults, setDefaults,
  };
})();
