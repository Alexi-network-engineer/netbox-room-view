{% verbatim %}
(function () {
  'use strict';

  const app = document.getElementById('rv-app');
  if (!app) return;

  const API = app.dataset.api;
  const CSRF = app.dataset.csrf;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const PAD = 26;   // space for the grid coordinates, px
  const ROW = 15;   // height of one rack unit in elevations, px

  const HEAT = [[50, '#2fb344', 'Under 50%'], [75, '#f59f00', '50–75%'], [90, '#f76707', '75–90%'], [Infinity, '#d63939', '90% and over']];
  const NAMED = {
    green: '#2fb344', blue: '#206bc4', cyan: '#17a2b8', teal: '#0ca678', indigo: '#4263eb', purple: '#ae3ec9',
    pink: '#d6336c', red: '#d63939', orange: '#f76707', yellow: '#f59f00', gray: '#868e96', grey: '#868e96',
    black: '#1e293b', white: '#f8f9fa',
  };
  const NEUTRAL = '#94a3b8';
  const KINDS = {
    cold_aisle: { label: 'Cold aisle', css: 'rv-obj-cold', size: [6, 2], swatch: 'rgba(56,139,253,.35)' },
    hot_aisle: { label: 'Hot aisle', css: 'rv-obj-hot', size: [6, 2], swatch: 'rgba(240,82,82,.35)' },
    crac: { label: 'Cooling unit', css: 'rv-obj-crac', size: [2, 1], swatch: 'rgba(14,165,233,.6)' },
    ups: { label: 'UPS', css: 'rv-obj-ups', size: [2, 1], swatch: 'rgba(174,62,201,.6)' },
    pdu: { label: 'Power distribution', css: 'rv-obj-pdu', size: [1, 1], swatch: 'rgba(245,159,0,.6)' },
    column: { label: 'Column', css: 'rv-obj-column', size: [1, 1], swatch: '#64748b' },
    door: { label: 'Door', css: 'rv-obj-door', size: [2, 1], swatch: 'rgba(161,98,7,.6)' },
    area: { label: 'Area', css: 'rv-obj-area', size: [4, 3], swatch: 'transparent' },
  };
  const FACING = { 0: 'south', 90: 'west', 180: 'north', 270: 'east' };

  let data = JSON.parse(document.getElementById('rv-data').textContent);

  const state = {
    colorBy: store('rv-color') || 'space',
    tilePx: Number(store('rv-zoom')) || 0,
    edit: false,
    rack: null,        // selected rack id
    object: null,      // selected floor object id
    device: null,      // selected device id
    elevation: null,   // elevation of the selected rack
    loading: false,
    search: '',
    view: store('rv-view') === '3d' ? '3d' : '2d',
  };
  let view3d = null;

  const $ = (id) => document.getElementById(id);
  const floor = $('rv-floor');
  const panel = $('rv-panel');
  const tray = $('rv-tray');
  const palette = $('rv-palette');
  const tooltip = $('rv-tooltip');

  // ---------------------------------------------------------------- helpers

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  function setAttrs(node, attrs) {
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) {
          if (val !== null && val !== undefined) node.style.setProperty(p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), val);
        }
      } else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }

  function append(node, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    setAttrs(node, attrs);
    return append(node, children);
  }

  function s(tag, attrs, ...children) {
    const node = document.createElementNS(SVGNS, tag);
    setAttrs(node, attrs);
    return append(node, children);
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fmtU = (u) => Number(u) % 1 ? Number(u).toFixed(1) : String(Number(u));

  function colName(i) {
    let out = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    return out;
  }
  const tileName = (x, y) => colName(x) + (y + 1);

  function textOn(color) {
    const m = /^#([0-9a-f]{6})$/i.exec(color || '');
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 160 ? '#1e293b' : '#ffffff';
  }

  function toast(message, kind) {
    const node = h('div', { class: `alert alert-${kind || 'info'} py-2 px-3`, role: 'status' }, message);
    $('rv-toasts').append(node);
    setTimeout(() => node.remove(), kind === 'danger' ? 7000 : 3500);
  }

  async function api(path, body) {
    const opts = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-CSRFToken'] = CSRF;
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(API + path, opts);
    let json = {};
    try { json = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }

  // Send a change, then redraw from the server's view of the room
  async function mutate(path, body, success) {
    try {
      const json = await api(path, body);
      if (json.room) data = json.room;
      if (success) toast(success, 'success');
      if (state.rack) await loadElevation(state.rack);
      renderAll();
      return true;
    } catch (err) {
      toast(err.message, 'danger');
      renderAll();
      return false;
    }
  }

  const rackById = (id) => data.racks.find((r) => r.id === id);
  const roomPath = (suffix) => `rooms/${data.room.id}/${suffix}`;
  const canEditLayout = () => state.edit && data.perms.edit_layout;
  const canMoveDevices = () => state.edit && data.perms.move_devices;

  // ---------------------------------------------------------------- geometry

  const tileMm = () => data.layout.tile;
  const pxPerMm = () => state.tilePx / tileMm();

  function rackDims(r, rotation) {
    return rotation === 90 || rotation === 270 ? [r.depth_mm, r.width_mm] : [r.width_mm, r.depth_mm];
  }

  function rackRect(r, x, y, rotation) {
    const [w, d] = rackDims(r, rotation);
    return { x: x * tileMm(), y: y * tileMm(), w: w, h: d };
  }

  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  function rackFits(r, x, y, rotation) {
    const rect = rackRect(r, x, y, rotation);
    const L = data.layout;
    if (x < 0 || y < 0 || rect.x + rect.w > L.columns * tileMm() || rect.y + rect.h > L.rows * tileMm()) return false;
    return !data.racks.some((o) => o.placed && o.id !== r.id && overlaps(rect, rackRect(o, o.x, o.y, o.rotation)));
  }

  function svgPoint(evt) {
    const pt = floor.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const p = pt.matrixTransform(floor.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  }

  // ---------------------------------------------------------------- colours

  function heat(p) {
    if (p === null || p === undefined) return NEUTRAL;
    return HEAT.find(([max]) => p < max)[1];
  }

  function hashColor(text) {
    if (!text) return NEUTRAL;
    let n = 0;
    for (const ch of text) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    // HSL(hue, 55%, 50%) as hex, so text contrast can be computed
    const hue = n % 360;
    const sat = 0.55;
    const light = 0.5;
    const a = sat * Math.min(light, 1 - light);
    const f = (offset) => {
      const k = (offset + hue / 30) % 12;
      const c = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function rackColor(r) {
    switch (state.colorBy) {
      case 'space': return heat(r.space);
      case 'power': return heat(r.power);
      case 'role': return r.role_color || NEUTRAL;
      case 'status': return NAMED[r.status_color] || NEUTRAL;
      case 'tenant': return hashColor(r.tenant);
      default: return NEUTRAL;
    }
  }

  function legendItems() {
    const mode = state.colorBy;
    if (mode === 'space' || mode === 'power') {
      const items = HEAT.map(([, color, label]) => [color, label]);
      if (mode === 'power') items.push([NEUTRAL, 'No power feeds']);
      return items;
    }
    const seen = new Map();
    for (const r of data.racks) {
      const key = mode === 'role' ? r.role : mode === 'status' ? r.status : r.tenant;
      if (!seen.has(key)) seen.set(key, rackColor(r));
    }
    const none = { role: 'No role', tenant: 'No tenant', status: 'Unknown' }[mode];
    return [...seen].map(([key, color]) => [color, key || none]);
  }

  // ---------------------------------------------------------------- search

  const term = () => state.search;
  const rackMatches = (r) => !term() || r.search.includes(term());
  const deviceMatches = (d) => !!term() &&
    [d.name, d.serial, d.asset_tag, d.type].join(' ').toLowerCase().includes(term());

  // ---------------------------------------------------------------- floor plan

  function drawRack(r, x, y, rotation, extraClass) {
    const k = pxPerMm();
    const rect = rackRect(r, x, y, rotation);
    const w = rect.w * k;
    const hgt = rect.h * k;
    const color = rackColor(r);
    const classes = ['rv-rack'];
    if (state.rack === r.id) classes.push('rv-selected');
    if (term()) classes.push(rackMatches(r) ? 'rv-hit' : 'rv-dim');
    if (extraClass) classes.push(extraClass);

    const g = s('g', {
      class: classes.join(' '),
      dataset: { rack: r.id },
      transform: `translate(${rect.x * k},${rect.y * k})`,
    });
    g.append(s('rect', { class: 'rv-rack-body', width: w, height: hgt, rx: 2, fill: color }));

    // Thick bar along the front door
    const f = Math.max(3, Math.min(w, hgt) * 0.12);
    const front = { 0: [0, hgt - f, w, f], 180: [0, 0, w, f], 90: [0, 0, f, hgt], 270: [w - f, 0, f, hgt] }[rotation];
    g.append(s('rect', { class: 'rv-rack-front', x: front[0], y: front[1], width: front[2], height: front[3] }));

    const vertical = hgt > w * 1.3;
    const long = vertical ? hgt : w;
    const short = vertical ? w : hgt;
    const fs = clamp(state.tilePx / 3.2, 8, 13);
    const maxChars = Math.max(2, Math.floor((long - 8) / (fs * 0.62)));
    // Long names lose their distinctive end when cut, so fall back to the facility ID, then the tail
    let name = r.name;
    if (name.length > maxChars) {
      name = r.facility_id && r.facility_id.length <= maxChars ? r.facility_id : '…' + r.name.slice(-(maxChars - 1));
    }
    const value = r[state.colorBy];
    const showValue = (state.colorBy === 'space' || state.colorBy === 'power') && value !== null && short >= fs * 2.6;
    const cx = w / 2;
    const cy = hgt / 2;
    const off = showValue ? fs * 0.6 : 0;
    const ink = textOn(color);

    const lx = vertical ? cx - off : cx;
    const ly = vertical ? cy : cy - off;
    g.append(s('text', {
      class: 'rv-rack-label', x: lx, y: ly, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-size': fs, fill: ink, transform: vertical ? `rotate(-90 ${lx} ${ly})` : null, text: name,
    }));
    if (showValue) {
      const vx = vertical ? cx + off : cx;
      const vy = vertical ? cy : cy + off;
      g.append(s('text', {
        class: 'rv-rack-sub', x: vx, y: vy, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': fs * 0.85, fill: ink, transform: vertical ? `rotate(-90 ${vx} ${vy})` : null,
        text: `${Math.round(value)}%`,
      }));
    }
    return g;
  }

  function drawObject(o, box, extraClass) {
    const t = state.tilePx;
    const b = box || o;
    const kind = KINDS[o.kind] || KINDS.area;
    const classes = ['rv-obj', kind.css];
    if (state.object === o.id) classes.push('rv-selected');
    if (extraClass) classes.push(extraClass);
    const w = b.width * t;
    const hgt = b.height * t;
    const g = s('g', { class: classes.join(' '), dataset: { object: o.id }, transform: `translate(${b.x * t},${b.y * t})` });
    g.append(s('rect', { class: 'rv-obj-body', width: w, height: hgt, rx: o.kind === 'column' ? 1 : 3 }));
    const text = o.label || kind.label;
    const vertical = hgt > w * 1.5;
    const long = vertical ? hgt : w;
    if (text && long > 24) {
      const maxChars = Math.max(2, Math.floor((long - 6) / 7));
      const shown = text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
      g.append(s('text', {
        class: 'rv-obj-label', x: w / 2, y: hgt / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        transform: vertical ? `rotate(-90 ${w / 2} ${hgt / 2})` : null, text: shown,
      }));
    }
    if (state.edit && state.object === o.id && !extraClass) {
      g.append(s('rect', { class: 'rv-handle', x: w - 8, y: hgt - 8, width: 11, height: 11, rx: 2, dataset: { handle: o.id } }));
    }
    return g;
  }

  function get3d() {
    if (!view3d && window.RoomView3D) {
      view3d = window.RoomView3D($('rv-floor3d'), {
        data: () => data,
        rackColor,
        rackMatches,
        selected: () => state.rack,
        select: (id) => select(id),
        hover: (r, e) => (r ? showTooltip(r, e) : hideTooltip()),
      });
    }
    return view3d;
  }

  function renderFloor() {
    const L = data.layout;
    const tile = tileMm();
    $('rv-room-size').textContent =
      `${L.columns} × ${L.rows} tiles · ${(L.columns * tile / 1000).toFixed(1)} m × ${(L.rows * tile / 1000).toFixed(1)} m`;

    const is3d = state.view === '3d';
    floor.classList.toggle('d-none', is3d);
    $('rv-floor3d').classList.toggle('d-none', !is3d);
    $('rv-3d-controls').classList.toggle('d-none', !is3d);
    $('rv-view-2d').classList.toggle('active', !is3d);
    $('rv-view-3d').classList.toggle('active', is3d);
    if (is3d) {
      const v = get3d();
      if (v) v.render();
      return;
    }

    const t = state.tilePx;
    const W = L.columns * t;
    const H = L.rows * t;
    floor.setAttribute('width', W + PAD + 4);
    floor.setAttribute('height', H + PAD + 4);
    floor.setAttribute('viewBox', `${-PAD} ${-PAD} ${W + PAD + 4} ${H + PAD + 4}`);
    floor.classList.toggle('rv-editing', state.edit);
    floor.replaceChildren();

    floor.append(s('rect', { class: 'rv-room', x: 0, y: 0, width: W, height: H }));
    const grid = s('g', { class: 'rv-grid' });
    for (let c = 1; c < L.columns; c++) grid.append(s('line', { x1: c * t, y1: 0, x2: c * t, y2: H }));
    for (let r = 1; r < L.rows; r++) grid.append(s('line', { x1: 0, y1: r * t, x2: W, y2: r * t }));
    floor.append(grid);

    const axis = s('g', { class: 'rv-axis' });
    const step = t < 20 ? 2 : 1;
    for (let c = 0; c < L.columns; c += step) {
      axis.append(s('text', { x: c * t + t / 2, y: -9, 'text-anchor': 'middle', text: colName(c) }));
    }
    for (let r = 0; r < L.rows; r += step) {
      axis.append(s('text', { x: -7, y: r * t + t / 2 + 3, 'text-anchor': 'end', text: r + 1 }));
    }
    floor.append(axis);

    floor.append(s('g', {}, data.objects.map((o) => drawObject(o))));
    floor.append(s('g', {}, data.racks.filter((r) => r.placed).map((r) => drawRack(r, r.x, r.y, r.rotation))));
    if (!data.objects.length && !data.racks.some((r) => r.placed)) {
      const msg = data.perms.edit_layout
        ? 'Nothing placed yet. Turn on Edit mode and drag racks from the list below onto the floor.'
        : 'Nothing has been placed on this floor plan yet.';
      floor.append(s('text', { class: 'rv-empty', x: W / 2, y: H / 2, 'text-anchor': 'middle', text: msg }));
    }
    floor.append(s('g', { id: 'rv-ghosts' }));
  }

  // ---------------------------------------------------------------- toolbar, palette, tray

  function renderToolbar() {
    // NetBox turns .form-select elements into TomSelect widgets, which must be updated through their API
    const colorSelect = $('rv-color');
    if (colorSelect.tomselect) {
      if (colorSelect.tomselect.getValue() !== state.colorBy) colorSelect.tomselect.setValue(state.colorBy, true);
    } else {
      colorSelect.value = state.colorBy;
    }
    $('rv-legend').replaceChildren(...legendItems().map(([color, label]) =>
      h('span', { class: 'd-inline-flex align-items-center gap-1' },
        h('span', { class: 'rv-swatch', style: { background: color } }), label)));

    if (term()) {
      const n = data.racks.filter(rackMatches).length;
      $('rv-search-count').textContent = `${n} rack${n === 1 ? '' : 's'} match`;
    } else {
      $('rv-search-count').textContent = '';
    }

    const canEdit = data.perms.edit_layout || data.perms.move_devices;
    $('rv-edit-wrap').classList.toggle('d-none', !canEdit);
    $('rv-edit').checked = state.edit;

    const sizeForm = $('rv-size-form');
    sizeForm.classList.toggle('d-none', !canEditLayout());
    sizeForm.classList.toggle('d-flex', canEditLayout());
    if (document.activeElement !== $('rv-cols')) $('rv-cols').value = data.layout.columns;
    if (document.activeElement !== $('rv-rows')) $('rv-rows').value = data.layout.rows;

    const placed = data.racks.filter((r) => r.placed).length;
    let hint = `${placed} of ${data.racks.length} racks on the floor plan. Click a rack to see its elevation.`;
    if (state.view === '3d') {
      hint = 'Drag to orbit, Shift-drag or right-drag to pan, scroll to zoom. Click a rack to see its elevation.';
      if (state.edit) hint += ' Switch to 2D to move racks and floor objects.';
    } else if (state.edit) {
      hint = 'Edit mode: drag racks to move them, press R to rotate the selected rack, ' +
        'drag aisles and other objects from the palette, and drag devices between U positions, racks and the unracked tray.';
    }
    $('rv-hint').textContent = hint;
  }

  function renderPalette() {
    const unplaced = data.racks.filter((r) => !r.placed);
    palette.classList.toggle('d-none', !canEditLayout() && !unplaced.length);
    const parts = [];

    if (unplaced.length) {
      parts.push(h('div', { class: 'mb-2' },
        h('div', { class: 'small text-muted mb-1' },
          canEditLayout() ? 'Racks not on the floor plan. Drag one onto the floor to place it.'
            : 'Racks not on the floor plan. Turn on Edit mode to place them.'),
        h('div', { class: 'd-flex flex-wrap gap-2' }, unplaced.map((r) =>
          h('span', {
            class: 'rv-chip' + (canEditLayout() ? ' rv-draggable' : ''),
            dataset: { paletteRack: r.id }, title: `${r.width_mm} × ${r.depth_mm} mm`,
          }, h('span', { class: 'rv-swatch', style: { background: rackColor(r) } }), r.name)))));
    }
    if (canEditLayout()) {
      parts.push(h('div', {},
        h('div', { class: 'small text-muted mb-1' }, 'Floor objects. Drag onto the floor, then drag the corner handle to resize.'),
        h('div', { class: 'd-flex flex-wrap gap-2' }, Object.entries(KINDS).map(([kind, k]) =>
          h('span', { class: 'rv-chip rv-draggable', dataset: { paletteKind: kind } },
            h('span', { class: 'rv-swatch', style: { background: k.swatch, border: kind === 'area' ? '1px dashed #64748b' : null } }),
            k.label)))));
    }
    palette.replaceChildren(h('div', { class: 'card-body py-2' }, parts));
  }

  function renderTray() {
    const items = data.unracked;
    tray.classList.toggle('d-none', !items.length && !canMoveDevices());
    tray.replaceChildren(h('div', { class: 'card-body py-2' },
      h('div', { class: 'small text-muted mb-1' },
        `Unracked devices in this room (${items.length})`,
        canMoveDevices() ? ' · drag onto a rack elevation or a rack on the floor plan; drop a racked device here to unrack it' : ''),
      items.length
        ? h('div', { class: 'd-flex flex-wrap gap-2' }, items.map((d) =>
          h('span', {
            class: 'rv-chip' + (canMoveDevices() ? ' rv-draggable' : '') + (deviceMatches(d) ? ' border-warning' : ''),
            dataset: { trayDevice: d.id }, title: `${d.manufacturer} ${d.type} · ${fmtU(d.height)}U · ${d.status}`,
          },
          h('span', { class: 'rv-swatch', style: { background: d.role_color || NEUTRAL } }),
          d.name, h('span', { class: 'text-muted' }, `${fmtU(d.height)}U`))))
        : h('div', { class: 'small text-muted fst-italic' }, 'None')));
  }

  // ---------------------------------------------------------------- side panel

  function statBar(label, value, emptyText) {
    const pct = value === null || value === undefined ? null : value;
    return h('div', { class: 'mb-2' },
      h('div', { class: 'rv-stat-label' }, h('span', {}, label),
        h('strong', {}, pct === null ? emptyText : `${pct.toFixed(1)}%`)),
      h('div', { class: 'rv-bar' }, h('div', { style: { width: `${clamp(pct || 0, 0, 100)}%`, background: heat(pct) } })));
  }

  function renderPanel() {
    panel.classList.toggle('rv-panel-editing', canMoveDevices());
    const obj = state.object && data.objects.find((o) => o.id === state.object);
    if (obj) return panel.replaceChildren(objectPanel(obj));
    const r = state.rack && rackById(state.rack);
    if (r) return panel.replaceChildren(rackPanel(r));
    panel.replaceChildren(roomPanel());
  }

  function roomPanel() {
    const racks = data.racks;
    const avg = (key) => {
      const vals = racks.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const devices = racks.reduce((n, r) => n + r.devices, 0);
    return h('div', {},
      h('div', { class: 'card-header' }, h('h2', { class: 'card-title mb-0' }, data.room.name)),
      h('div', { class: 'card-body' },
        h('div', { class: 'row text-center mb-3' },
          [['Racks', racks.length], ['Racked devices', devices], ['Unracked', data.unracked.length]].map(([label, n]) =>
            h('div', { class: 'col' }, h('div', { class: 'h2 mb-0' }, n), h('div', { class: 'small text-muted' }, label)))),
        statBar('Average space used', avg('space'), 'n/a'),
        statBar('Average power used', avg('power'), 'No power feeds'),
        h('p', { class: 'text-muted small mt-3 mb-0' }, 'Click a rack on the floor plan to see its front and rear elevations.')));
  }

  function objectPanel(o) {
    const kind = KINDS[o.kind] || KINDS.area;
    const editable = canEditLayout();
    const label = h('input', {
      type: 'text', class: 'form-control form-control-sm', maxlength: 50, value: o.label,
      placeholder: kind.label, disabled: !editable,
    });
    const typeSelect = h('select', { class: 'form-select form-select-sm', disabled: !editable },
      Object.entries(KINDS).map(([key, k]) => h('option', { value: key, selected: key === o.kind }, k.label)));
    const save = () => mutate(roomPath('objects/'), { id: o.id, label: label.value, kind: typeSelect.value });
    label.addEventListener('change', save);
    typeSelect.addEventListener('change', save);
    return h('div', {},
      h('div', { class: 'card-header d-flex align-items-center' },
        h('h2', { class: 'card-title mb-0' }, o.label || kind.label),
        h('button', { type: 'button', class: 'btn-close ms-auto', 'aria-label': 'Close', onclick: () => select(null) })),
      h('div', { class: 'card-body' },
        h('div', { class: 'mb-2' }, h('label', { class: 'form-label small' }, 'Label'), label),
        h('div', { class: 'mb-2' }, h('label', { class: 'form-label small' }, 'Type'), typeSelect),
        h('p', { class: 'small text-muted' },
          `${tileName(o.x, o.y)} · ${o.width} × ${o.height} tiles`),
        editable ? h('button', {
          type: 'button', class: 'btn btn-sm btn-outline-danger',
          onclick: () => { state.object = null; mutate(roomPath('objects/'), { id: o.id, remove: true }); },
        }, h('i', { class: 'mdi mdi-trash-can-outline' }), ' Delete') : null));
  }

  function rackPanel(r) {
    const editable = canEditLayout();
    const E = state.elevation && state.elevation.id === r.id ? state.elevation : null;
    const header = h('div', { class: 'card-header d-flex align-items-center gap-2' },
      h('span', { class: 'rv-swatch', style: { background: rackColor(r) } }),
      h('h2', { class: 'card-title mb-0' }, h('a', { href: r.url }, r.name)),
      h('span', { class: `badge text-bg-${r.status_color || 'secondary'}` }, r.status),
      h('button', { type: 'button', class: 'btn-close ms-auto', 'aria-label': 'Close', onclick: () => select(null) }));

    const facts = [
      r.placed ? `${tileName(r.x, r.y)}, facing ${FACING[r.rotation]}` : 'Not on the floor plan',
      `${r.u_height}U · ${r.width_mm} × ${r.depth_mm} mm`,
      r.role && `Role: ${r.role}`,
      r.tenant && `Tenant: ${r.tenant}`,
      r.facility_id && `Facility ID: ${r.facility_id}`,
    ].filter(Boolean);

    const actions = editable && r.placed ? h('div', { class: 'd-flex gap-2 mb-3' },
      h('button', { type: 'button', class: 'btn btn-sm btn-outline-primary', onclick: () => rotate(r) },
        h('i', { class: 'mdi mdi-rotate-right' }), ' Rotate'),
      h('button', {
        type: 'button', class: 'btn btn-sm btn-outline-danger',
        onclick: () => mutate(roomPath('placements/'), { rack: r.id, remove: true }, `${r.name} removed from the floor plan.`),
      }, h('i', { class: 'mdi mdi-close' }), ' Remove from floor')) : null;

    const selected = E && state.device && E.devices.find((d) => d.id === state.device);
    const deviceInfo = selected ? h('div', { class: 'border rounded py-2 px-3 small mb-3' },
      h('a', { href: selected.url, class: 'fw-bold' }, selected.name), h('br'),
      `${selected.manufacturer} ${selected.type} · U${fmtU(selected.position)} · ${fmtU(selected.height)}U · ` +
      `${selected.face || 'no face'}${selected.full_depth ? ', full depth' : ''}`, h('br'),
      `${selected.status}${selected.serial ? ' · S/N ' + selected.serial : ''}${selected.asset_tag ? ' · ' + selected.asset_tag : ''}`) : null;

    let body;
    if (E) body = h('div', { class: 'rv-elev-scroll' }, renderElevation(E));
    else body = h('div', { class: 'text-muted small py-4 text-center' }, 'Loading elevation…');

    return h('div', {},
      header,
      h('div', { class: 'card-body' },
        h('div', { class: 'small text-muted mb-2' }, facts.join(' · ')),
        statBar('Space used', r.space, 'n/a'),
        statBar('Power used', r.power, 'No power feeds'),
        h('div', { class: 'small text-muted mb-3' }, `${r.devices} racked device${r.devices === 1 ? '' : 's'}`),
        actions, deviceInfo, body));
  }

  // Unit arithmetic for a rack elevation
  function unitsOf(E) {
    const first = E.starting_unit;
    const last = first + E.u_height - 1;
    return { first, last, asc: !E.desc_units };
  }

  function yForPos(E, pos, height) {
    const { first, last, asc } = unitsOf(E);
    return (asc ? last + 1 - (pos + height) : pos - first) * ROW;
  }

  function posForY(E, y, height) {
    const { first, last, asc } = unitsOf(E);
    const idx = Math.round(y / ROW);
    const pos = asc ? last + 1 - height - idx : first + idx;
    return clamp(pos, first, last + 1 - height);
  }

  function fitsInRack(E, dev, pos, face) {
    const { first, last } = unitsOf(E);
    if (pos < first || pos + dev.height - 1 > last) return false;
    return !E.devices.some((d) => d.id !== dev.id &&
      pos < d.position + d.height && d.position < pos + dev.height &&
      (dev.full_depth || d.full_depth || d.face === face));
  }

  function renderElevation(E) {
    const { first, last, asc } = unitsOf(E);
    const units = [];
    for (let i = 0; i < E.u_height; i++) units.push(asc ? last - i : first + i);

    const columns = ['front', 'rear'].map((face) => {
      const col = h('div', { class: 'rv-elev-col', dataset: { face }, style: { height: `${E.u_height * ROW}px` } });
      units.forEach((u, i) => {
        if (E.reserved.includes(u)) {
          col.append(h('div', { class: 'rv-reserved', title: 'Reserved', style: { top: `${i * ROW}px`, height: `${ROW}px` } }));
        }
      });
      for (const d of E.devices) {
        const primary = d.face === face;
        if (!primary && !d.full_depth) continue;
        const color = d.role_color || NEUTRAL;
        const classes = ['rv-dev'];
        if (!primary) classes.push('rv-dev-back');
        if (state.device === d.id) classes.push('rv-selected');
        if (deviceMatches(d)) classes.push('rv-hit');
        col.append(h('div', {
          class: classes.join(' '),
          dataset: { device: d.id },
          title: `${d.name}\n${d.manufacturer} ${d.type}\nU${fmtU(d.position)} · ${fmtU(d.height)}U · ${d.status}` +
            (primary ? '' : `\n(${d.face} mounted, full depth)`),
          style: {
            top: `${yForPos(E, d.position, d.height)}px`,
            height: `${d.height * ROW - 1}px`,
            background: primary ? color : null,
            color: primary ? textOn(color) : null,
            '--rv-dev-color': color,
          },
        },
        h('span', { class: 'rv-dev-name' }, d.name),
        d.height >= 2 ? h('span', { class: 'rv-dev-type' }, `${d.manufacturer} ${d.type}`) : null));
      }
      return h('div', {}, h('div', { class: 'rv-elev-head' }, face === 'front' ? 'Front' : 'Rear'), col);
    });

    return h('div', { class: 'rv-elev' },
      h('div', { class: 'rv-elev-units' }, units.map((u) => h('div', { class: 'rv-u' }, u))),
      columns);
  }

  async function loadElevation(id) {
    try {
      const json = await api(`racks/${id}/`);
      if (state.rack === id) state.elevation = json.rack;
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  // ---------------------------------------------------------------- selection and actions

  async function select(rackId, objectId) {
    state.rack = rackId || null;
    state.object = objectId || null;
    state.device = null;
    if (!state.rack) state.elevation = null;
    renderAll();
    if (state.rack && (!state.elevation || state.elevation.id !== state.rack)) {
      state.elevation = null;
      await loadElevation(state.rack);
      renderPanel();
    }
  }

  function rotate(r) {
    const next = (r.rotation + 90) % 360;
    if (!rackFits(r, r.x, r.y, next)) {
      toast(`${r.name} doesn't fit there when rotated.`, 'warning');
      return;
    }
    mutate(roomPath('placements/'), { rack: r.id, x: r.x, y: r.y, rotation: next });
  }

  function renderAll() {
    renderToolbar();
    renderFloor();
    renderPalette();
    renderTray();
    renderPanel();
  }

  // ---------------------------------------------------------------- dragging

  // Follow the pointer until release; `move` only starts after a small threshold so clicks still work
  function track(e, handlers) {
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    const onMove = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      dragging = true;
      hideTooltip();
      handlers.move(ev);
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      handlers.up(ev, dragging && ev.type === 'pointerup');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    e.preventDefault();
  }

  function floating(label, color, width) {
    const node = h('div', {
      class: 'rv-floating',
      style: { background: color || 'var(--rv-surface)', color: color ? textOn(color) : 'var(--rv-text)', width: width ? `${width}px` : null },
    }, label);
    document.body.append(node);
    return node;
  }

  const overFloor = (ev) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    return under && floor.contains(under) ? under : null;
  };

  function dragPlacedRack(e, r, node) {
    const start = svgPoint(e);
    const t = state.tilePx;
    let nx = r.x;
    let ny = r.y;
    let ok = true;
    track(e, {
      move(ev) {
        const p = svgPoint(ev);
        nx = Math.round(r.x + (p.x - start.x) / t);
        ny = Math.round(r.y + (p.y - start.y) / t);
        ok = rackFits(r, nx, ny, r.rotation);
        node.setAttribute('transform', `translate(${nx * t},${ny * t})`);
        node.classList.add('rv-dragging');
        node.classList.toggle('rv-invalid', !ok);
      },
      up(ev, dragged) {
        if (!dragged) return select(r.id);
        if (!ok) toast(`${r.name} doesn't fit there.`, 'warning');
        if (!ok || (nx === r.x && ny === r.y)) return renderFloor();
        r.x = nx;
        r.y = ny;
        renderFloor();
        mutate(roomPath('placements/'), { rack: r.id, x: nx, y: ny, rotation: r.rotation });
      },
    });
  }

  function dragObject(e, o, mode) {
    const start = svgPoint(e);
    const t = state.tilePx;
    const L = data.layout;
    const box = { x: o.x, y: o.y, width: o.width, height: o.height };
    let node = e.target.closest('[data-object]');
    track(e, {
      move(ev) {
        const p = svgPoint(ev);
        const dx = Math.round((p.x - start.x) / t);
        const dy = Math.round((p.y - start.y) / t);
        if (mode === 'move') {
          box.x = clamp(o.x + dx, 0, L.columns - o.width);
          box.y = clamp(o.y + dy, 0, L.rows - o.height);
        } else {
          box.width = clamp(o.width + dx, 1, L.columns - o.x);
          box.height = clamp(o.height + dy, 1, L.rows - o.y);
        }
        const next = drawObject(o, box);
        node.replaceWith(next);
        node = next;
      },
      up(ev, dragged) {
        if (!dragged) return select(null, o.id);
        const changed = ['x', 'y', 'width', 'height'].some((k) => box[k] !== o[k]);
        if (!changed) return renderFloor();
        Object.assign(o, box);
        state.object = o.id;
        renderAll();
        mutate(roomPath('objects/'), { id: o.id, ...box });
      },
    });
  }

  function dragFromPalette(e, item) {
    const ghosts = $('rv-ghosts');
    const label = item.rack ? item.rack.name : KINDS[item.kind].label;
    const chip = floating(label, item.rack ? rackColor(item.rack) : null);
    let target = null;
    let onFloor = false;
    track(e, {
      move(ev) {
        chip.style.left = `${ev.clientX + 12}px`;
        chip.style.top = `${ev.clientY + 12}px`;
        ghosts.replaceChildren();
        target = null;
        onFloor = !!overFloor(ev);
        if (!onFloor) return;
        const p = svgPoint(ev);
        const t = state.tilePx;
        if (item.rack) {
          const r = item.rack;
          const [w, d] = rackDims(r, 0);
          const x = Math.round(p.x / t - w / tileMm() / 2);
          const y = Math.round(p.y / t - d / tileMm() / 2);
          const ok = rackFits(r, x, y, 0);
          if (ok) target = { x, y };
          ghosts.append(drawRack(r, x, y, 0, 'rv-ghost' + (ok ? '' : ' rv-invalid')));
        } else {
          const [w, hgt] = KINDS[item.kind].size;
          const L = data.layout;
          const box = {
            x: clamp(Math.floor(p.x / t - w / 2 + 0.5), 0, Math.max(0, L.columns - w)),
            y: clamp(Math.floor(p.y / t - hgt / 2 + 0.5), 0, Math.max(0, L.rows - hgt)),
            width: Math.min(w, L.columns),
            height: Math.min(hgt, L.rows),
          };
          target = box;
          ghosts.append(drawObject({ id: 0, kind: item.kind, label: '' }, box, 'rv-ghost'));
        }
      },
      up(ev, dragged) {
        chip.remove();
        ghosts.replaceChildren();
        if (!dragged) {
          if (item.rack) select(item.rack.id);
          return;
        }
        if (!target) {
          if (onFloor) toast(`${label} doesn't fit there.`, 'warning');
          return;
        }
        if (item.rack) {
          state.rack = item.rack.id;
          mutate(roomPath('placements/'), { rack: item.rack.id, ...target, rotation: 0 },
            `${item.rack.name} placed at ${tileName(target.x, target.y)}.`).then(() => select(item.rack.id));
        } else {
          mutate(roomPath('objects/'), { kind: item.kind, label: '', ...target });
        }
      },
    });
  }

  function dragDevice(e, dev, source) {
    const E = state.elevation;
    const sourceRect = source.getBoundingClientRect();
    const grabY = dev.position !== null ? e.clientY - sourceRect.top : ROW / 2;
    const width = dev.position !== null ? sourceRect.width : 160;
    const color = dev.role_color || NEUTRAL;
    const chip = floating(dev.name, color, width);
    chip.style.height = `${Math.max(ROW, dev.height * ROW - 1)}px`;
    let indicator = null;
    let highlighted = null;
    let drop = null;

    const clear = () => {
      if (indicator) indicator.remove();
      indicator = null;
      if (highlighted) highlighted.classList.remove('rv-drop-target', 'rv-drop-active');
      highlighted = null;
    };

    track(e, {
      move(ev) {
        chip.style.left = `${ev.clientX - 20}px`;
        chip.style.top = `${ev.clientY - grabY}px`;
        source.classList.add('rv-moving');
        clear();
        drop = null;
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!under) return;
        const col = under.closest('[data-face]');
        const floorRack = floor.contains(under) && under.closest('[data-rack]');
        const overTray = under.closest('[data-tray]');

        if (col && E) {
          const rect = col.getBoundingClientRect();
          const pos = posForY(E, ev.clientY - grabY - rect.top - 2, dev.height);
          // Full-depth devices keep the side they are mounted from
          const face = dev.full_depth && dev.face ? dev.face : col.dataset.face;
          const ok = fitsInRack(E, dev, pos, face);
          indicator = h('div', {
            class: 'rv-drop-indicator' + (ok ? '' : ' rv-bad'),
            style: { top: `${yForPos(E, pos, dev.height)}px`, height: `${dev.height * ROW - 1}px` },
          }, `U${fmtU(pos)}`);
          col.append(indicator);
          if (ok) drop = { rack: E.id, position: pos, face };
        } else if (floorRack) {
          const id = Number(floorRack.dataset.rack);
          highlighted = floorRack;
          highlighted.classList.add('rv-drop-target');
          drop = { rack: id, position: null, face: dev.face || 'front' };
        } else if (overTray && dev.position !== null) {
          highlighted = overTray;
          highlighted.classList.add('rv-drop-active');
          drop = { rack: null };
        }
      },
      up(ev, dragged) {
        chip.remove();
        clear();
        source.classList.remove('rv-moving');
        if (!dragged) {
          if (dev.position !== null) {
            state.device = state.device === dev.id ? null : dev.id;
            renderPanel();
          } else {
            window.location.href = dev.url;
          }
          return;
        }
        if (!drop) return;
        if (drop.rack === (dev.position !== null && E ? E.id : null) && drop.position === dev.position && drop.face === dev.face) return;
        const where = drop.rack === null ? 'unracked'
          : `${rackById(drop.rack) ? rackById(drop.rack).name : 'rack'}${drop.position !== null ? ' U' + fmtU(drop.position) : ''}`;
        if (drop.rack !== null && drop.rack !== state.rack) {
          state.rack = drop.rack;
          state.elevation = null;
        }
        state.device = dev.id;
        mutate(`devices/${dev.id}/move/`, { room: data.room.id, ...drop }, `Moved ${dev.name} to ${where}.`);
      },
    });
  }

  // ---------------------------------------------------------------- events

  floor.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rackNode = e.target.closest('[data-rack]');
    const handle = e.target.closest('[data-handle]');
    const objNode = e.target.closest('[data-object]');
    if (rackNode) {
      const r = rackById(Number(rackNode.dataset.rack));
      if (canEditLayout()) return dragPlacedRack(e, r, rackNode);
      return track(e, { move() {}, up() { select(r.id); } });
    }
    if (canEditLayout() && handle) return dragObject(e, data.objects.find((o) => o.id === Number(handle.dataset.handle)), 'resize');
    if (canEditLayout() && objNode) return dragObject(e, data.objects.find((o) => o.id === Number(objNode.dataset.object)), 'move');
    if (state.object) select(null);
  });

  floor.addEventListener('pointermove', (e) => {
    const node = e.buttons ? null : e.target.closest('[data-rack]');
    const r = node && rackById(Number(node.dataset.rack));
    if (!r) return hideTooltip();
    showTooltip(r, e);
  });
  floor.addEventListener('pointerleave', hideTooltip);
  function hideTooltip() { tooltip.hidden = true; }

  function showTooltip(r, e) {
    tooltip.replaceChildren(
      h('strong', {}, r.name),
      h('dl', {},
        h('dt', {}, 'Status'), h('dd', {}, r.status),
        h('dt', {}, 'Location'), h('dd', {}, `${tileName(r.x, r.y)}, facing ${FACING[r.rotation]}`),
        h('dt', {}, 'Space'), h('dd', {}, `${r.space.toFixed(1)}% of ${r.u_height}U`),
        h('dt', {}, 'Power'), h('dd', {}, r.power === null ? 'No power feeds' : `${r.power.toFixed(1)}%`),
        h('dt', {}, 'Devices'), h('dd', {}, r.devices),
        r.role ? [h('dt', {}, 'Role'), h('dd', {}, r.role)] : null,
        r.tenant ? [h('dt', {}, 'Tenant'), h('dd', {}, r.tenant)] : null));
    tooltip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
    const y = Math.min(e.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function setView(next) {
    state.view = next;
    store('rv-view', next);
    hideTooltip();
    renderAll();
  }
  $('rv-view-2d').addEventListener('click', () => setView('2d'));
  $('rv-view-3d').addEventListener('click', () => setView('3d'));
  $('rv-3d-left').addEventListener('click', () => get3d().rotate(-Math.PI / 4));
  $('rv-3d-right').addEventListener('click', () => get3d().rotate(Math.PI / 4));
  $('rv-3d-top').addEventListener('click', () => get3d().topView());
  $('rv-3d-reset').addEventListener('click', () => get3d().reset());
  $('rv-3d-spin').addEventListener('click', (e) => {
    e.currentTarget.classList.toggle('active', get3d().toggleSpin());
  });

  palette.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rackChip = e.target.closest('[data-palette-rack]');
    const kindChip = e.target.closest('[data-palette-kind]');
    if (rackChip) {
      const r = rackById(Number(rackChip.dataset.paletteRack));
      if (canEditLayout()) return dragFromPalette(e, { rack: r });
      return select(r.id);
    }
    if (kindChip && canEditLayout()) dragFromPalette(e, { kind: kindChip.dataset.paletteKind });
  });

  panel.addEventListener('pointerdown', (e) => {
    const node = e.button === 0 && e.target.closest('[data-device]');
    if (!node || !state.elevation) return;
    const dev = state.elevation.devices.find((d) => d.id === Number(node.dataset.device));
    if (canMoveDevices()) return dragDevice(e, dev, node);
    track(e, { move() {}, up() { state.device = state.device === dev.id ? null : dev.id; renderPanel(); } });
  });
  panel.addEventListener('dblclick', (e) => {
    const node = e.target.closest('[data-device]');
    const dev = node && state.elevation && state.elevation.devices.find((d) => d.id === Number(node.dataset.device));
    if (dev) window.location.href = dev.url;
  });

  tray.addEventListener('pointerdown', (e) => {
    const node = e.button === 0 && e.target.closest('[data-tray-device]');
    if (!node) return;
    const dev = data.unracked.find((d) => d.id === Number(node.dataset.trayDevice));
    if (canMoveDevices()) return dragDevice(e, dev, node);
    window.location.href = dev.url;
  });

  $('rv-color').addEventListener('change', (e) => {
    // The TomSelect clear button can empty the value; fall back to space used
    state.colorBy = e.target.value || 'space';
    store('rv-color', state.colorBy);
    renderAll();
  });

  let searchTimer = null;
  $('rv-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim().toLowerCase();
      renderAll();
    }, 120);
  });
  $('rv-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const hit = data.racks.find((r) => r.placed && rackMatches(r)) || data.racks.find(rackMatches);
    if (hit && term()) select(hit.id);
  });

  $('rv-edit').addEventListener('change', (e) => {
    state.edit = e.target.checked;
    if (!state.edit) state.object = null;
    renderAll();
  });

  $('rv-size-form').addEventListener('submit', (e) => {
    e.preventDefault();
    mutate(roomPath('layout/'), { columns: Number($('rv-cols').value), rows: Number($('rv-rows').value) }, 'Room resized.');
  });

  function zoom(next) {
    state.tilePx = clamp(Math.round(next), 14, 90);
    store('rv-zoom', state.tilePx);
    renderFloor();
  }
  function fitZoom() {
    const wrap = $('rv-floor-wrap');
    return (wrap.clientWidth - PAD - 30) / data.layout.columns;
  }
  const in3d = () => state.view === '3d' && get3d();
  $('rv-zoom-in').addEventListener('click', () => (in3d() ? get3d().zoom(1 / 1.2) : zoom(state.tilePx * 1.2)));
  $('rv-zoom-out').addEventListener('click', () => (in3d() ? get3d().zoom(1.2) : zoom(state.tilePx / 1.2)));
  $('rv-zoom-fit').addEventListener('click', () => (in3d() ? get3d().reset() : zoom(fitZoom())));

  document.addEventListener('keydown', (e) => {
    // Ignore typing in fields, but not focus left on a checkbox such as the Edit mode switch
    if (e.target.isContentEditable || e.target.matches('select, textarea, input:not([type=checkbox]):not([type=radio])')) return;
    if (e.key === 'Escape') select(null);
    const r = state.rack && rackById(state.rack);
    if ((e.key === 'r' || e.key === 'R') && canEditLayout() && r && r.placed) rotate(r);
    if ((e.key === 'Delete' || e.key === 'Backspace') && canEditLayout() && state.object) {
      const id = state.object;
      state.object = null;
      mutate(roomPath('objects/'), { id, remove: true });
    }
  });

  // ---------------------------------------------------------------- start

  if (!state.tilePx) state.tilePx = clamp(Math.round(fitZoom()), 14, 90);
  renderAll();
})();
{% endverbatim %}
