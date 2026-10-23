{% verbatim %}
/*
 * 3D view of a comms room, drawn on a 2D canvas with a small perspective renderer:
 * boxes are depth-sorted and drawn back to front, so no WebGL or external library is needed.
 *
 * World coordinates are the floor plan's millimetres (x right, y down the plan) plus z up.
 * The host supplies the room data and callbacks; see the `host` uses below.
 */
window.RoomView3D = function (canvas, host) {
  'use strict';

  const ctx = canvas.getContext('2d');
  const U_MM = 44.45;      // one rack unit
  const PLINTH = 100;      // space below U1
  const CAP = 80;          // space above the top unit
  const WALL = 2700;
  const OBJECT_HEIGHT = { crac: 1900, ups: 1900, pdu: 1800, column: 3000 };
  const FLAT = { cold_aisle: true, hot_aisle: true, door: true, area: true };
  const OBJECT_COLOR = {
    cold_aisle: 'rgba(56,139,253,0.22)', hot_aisle: 'rgba(240,82,82,0.22)', crac: '#7dd3fc', ups: '#c084fc',
    pdu: '#fbbf24', column: '#94a3b8', door: 'rgba(161,98,7,0.55)', area: 'rgba(0,0,0,0)',
  };
  const LIGHT = normalize([-0.45, 0.35, 0.82]);

  const cam = { yaw: -0.55, pitch: 0.72, dist: 10000, tx: 0, ty: 0 };
  let view = { w: 0, h: 0, cx: 0, cy: 0, f: 1 };
  let eye = [0, 0, 0];
  let hits = [];
  let spinning = false;
  let frame = 0;
  let theme = {};

  // ---------------------------------------------------------------- maths

  function normalize(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  // World point -> [screenX, screenY, depth], or null if behind the camera
  function project(px, py, pz) {
    const x = px - cam.tx;
    const y = cam.ty - py;   // plan y grows southwards; flip so north is away from the viewer
    const cy = Math.cos(cam.yaw);
    const sy = Math.sin(cam.yaw);
    const x1 = x * cy - y * sy;
    const y1 = x * sy + y * cy;
    const cp = Math.cos(cam.pitch);
    const sp = Math.sin(cam.pitch);
    const yc = y1 * sp + pz * cp;
    const zc = y1 * cp - pz * sp + cam.dist;
    if (zc < 100) return null;
    const k = view.f / zc;
    return [view.cx + x1 * k, view.cy - yc * k, zc];
  }

  function cameraPosition() {
    const y1 = -cam.dist * Math.cos(cam.pitch);
    const x = y1 * Math.sin(cam.yaw);
    const y = y1 * Math.cos(cam.yaw);
    return [x + cam.tx, cam.ty - y, cam.dist * Math.sin(cam.pitch)];
  }

  function parseColor(color) {
    const hex = /^#([0-9a-f]{6})$/i.exec(color || '');
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [n >> 16, (n >> 8) & 255, n & 255, 1];
    }
    const rgb = /rgba?\(([^)]+)\)/.exec(color || '');
    if (rgb) {
      const p = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    return [148, 163, 184, 1];
  }

  function shade(color, normal, extra) {
    const [r, g, b, a] = parseColor(color);
    const light = 0.55 + 0.45 * Math.max(0, normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]);
    const k = light * (extra || 1);
    return `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`;
  }

  function readTheme() {
    // Resolve the page's CSS variables to concrete colours through a probe element
    const probe = document.createElement('span');
    probe.style.display = 'none';
    canvas.parentNode.append(probe);
    const read = (value) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    theme = {
      floor: read('var(--rv-floor)'),
      grid: read('var(--rv-grid)'),
      text: read('var(--rv-text)'),
      muted: read('var(--rv-muted)'),
      accent: read('var(--rv-accent)'),
      wall: read('var(--rv-muted)'),
      rackFace: '#1f2329',
    };
    probe.remove();
  }

  // ---------------------------------------------------------------- drawing primitives

  function polygon(points, fill, stroke, lineWidth) {
    const p = points.map((q) => project(q[0], q[1], q[2]));
    if (p.some((q) => !q)) return null;
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth || 1;
      ctx.stroke();
    }
    return p;
  }

  // The faces of an axis-aligned box, each with its outward normal and a point on it
  function boxFaces(x0, y0, x1, y1, z0, z1) {
    return [
      { side: 'top', normal: [0, 0, 1], at: [x0, y0, z1], pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
      { side: 'north', normal: [0, -1, 0], at: [x0, y0, z0], pts: [[x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1]] },
      { side: 'south', normal: [0, 1, 0], at: [x0, y1, z0], pts: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]] },
      { side: 'west', normal: [-1, 0, 0], at: [x0, y0, z0], pts: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]] },
      { side: 'east', normal: [1, 0, 0], at: [x1, y0, z0], pts: [[x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1]] },
    ];
  }

  function facesCamera(face) {
    const n = face.normal;
    const d = [eye[0] - face.at[0], eye[1] - face.at[1], eye[2] - face.at[2]];
    return n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0;
  }

  // Bottom-left corner (seen from outside) and rightward direction of a vertical face
  function faceFrame(side, x0, y0, x1, y1) {
    switch (side) {
      case 'south': return { origin: [x0, y1], dir: [1, 0], width: x1 - x0 };
      case 'north': return { origin: [x1, y0], dir: [-1, 0], width: x1 - x0 };
      case 'west': return { origin: [x0, y0], dir: [0, 1], width: y1 - y0 };
      default: return { origin: [x1, y1], dir: [0, -1], width: y1 - y0 };
    }
  }

  const FRONT_SIDE = { 0: 'south', 90: 'west', 180: 'north', 270: 'east' };
  const OPPOSITE = { south: 'north', north: 'south', west: 'east', east: 'west' };

  // ---------------------------------------------------------------- scene

  function rackBox(r, tile) {
    const swap = r.rotation === 90 || r.rotation === 270;
    const w = swap ? r.depth_mm : r.width_mm;
    const d = swap ? r.width_mm : r.depth_mm;
    const x0 = r.x * tile;
    const y0 = r.y * tile;
    return { x0, y0, x1: x0 + w, y1: y0 + d, z1: PLINTH + r.u_height * U_MM + CAP };
  }

  function drawDevices(r, face, frameInfo, which) {
    const inset = frameInfo.width * 0.07;
    const n = face.normal;
    const off = 3;  // lift slabs just off the face
    const start = r.starting_unit || 1;
    for (const [pos, height, color, side] of r.units) {
      if (side !== 'b' && side !== which) continue;
      const u0 = r.desc_units ? r.u_height - (pos - start) - height : pos - start;
      const z0 = PLINTH + u0 * U_MM + 2;
      const z1 = z0 + height * U_MM - 4;
      const a = frameInfo.width - inset;
      const ox = frameInfo.origin[0] + n[0] * off;
      const oy = frameInfo.origin[1] + n[1] * off;
      const dx = frameInfo.dir[0];
      const dy = frameInfo.dir[1];
      const fill = side === 'b' && which === 'r' ? shade(color || '#94a3b8', n, 0.6) : shade(color || '#94a3b8', n, 1.05);
      polygon([
        [ox + dx * inset, oy + dy * inset, z0], [ox + dx * a, oy + dy * a, z0],
        [ox + dx * a, oy + dy * a, z1], [ox + dx * inset, oy + dy * inset, z1],
      ], fill);
    }
  }

  function drawRack(r, box, selected, dimmed) {
    const color = host.rackColor(r);
    const front = FRONT_SIDE[r.rotation];
    const rear = OPPOSITE[front];
    const polys = [];
    ctx.globalAlpha = dimmed ? 0.18 : 1;

    for (const face of boxFaces(box.x0, box.y0, box.x1, box.y1, 0, box.z1)) {
      if (!facesCamera(face)) continue;
      const isFront = face.side === front;
      const isRear = face.side === rear;
      let fill;
      if (face.side === 'top') fill = shade(color, face.normal, 1.05);
      else if (isFront || isRear) fill = shade(theme.rackFace, face.normal, 1);
      else fill = shade(color, face.normal, 0.8);
      const p = polygon(face.pts, fill, 'rgba(0,0,0,0.45)', 1);
      if (!p) continue;
      polys.push(p);
      if (isFront || isRear) {
        const fr = faceFrame(face.side, box.x0, box.y0, box.x1, box.y1);
        // Coloured frame strip so the metric colour is visible on the door too
        const n = face.normal;
        const [ox, oy] = [fr.origin[0] + n[0] * 2, fr.origin[1] + n[1] * 2];
        const [ex, ey] = [ox + fr.dir[0] * fr.width, oy + fr.dir[1] * fr.width];
        polygon([[ox, oy, box.z1 - CAP], [ex, ey, box.z1 - CAP], [ex, ey, box.z1], [ox, oy, box.z1]],
          shade(color, n, isFront ? 1 : 0.75));
        drawDevices(r, face, fr, isFront ? 'f' : 'r');
      }
    }

    if (selected) {
      for (const p of polys) {
        ctx.beginPath();
        ctx.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
        ctx.closePath();
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    // Name label above the rack
    const top = project((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, box.z1 + 120);
    if (top) {
      const size = Math.max(0, Math.min(15, view.f / top[2] * 230));
      if (size >= 7.5) {
        const label = r.facility_id && r.name.length > 10 ? r.facility_id : r.name;
        ctx.font = `600 ${size}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.strokeText(label, top[0], top[1]);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, top[0], top[1]);
      }
    }
    ctx.globalAlpha = 1;
    return polys;
  }

  function drawObjectBox(o, tile) {
    const x0 = o.x * tile;
    const y0 = o.y * tile;
    const x1 = x0 + o.width * tile;
    const y1 = y0 + o.height * tile;
    const color = OBJECT_COLOR[o.kind] || '#94a3b8';
    for (const face of boxFaces(x0, y0, x1, y1, 0, OBJECT_HEIGHT[o.kind] || 1800)) {
      if (facesCamera(face)) polygon(face.pts, shade(color, face.normal), 'rgba(0,0,0,0.35)', 1);
    }
    labelAt(o.label || o.kind_label, (x0 + x1) / 2, (y0 + y1) / 2, (OBJECT_HEIGHT[o.kind] || 1800) + 100, 160);
  }

  function labelAt(text, x, y, z, scale) {
    if (!text) return;
    const p = project(x, y, z);
    if (!p) return;
    const size = Math.min(13, view.f / p[2] * scale);
    if (size < 7.5) return;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.text;
    ctx.globalAlpha = 0.75;
    ctx.fillText(text.toUpperCase(), p[0], p[1]);
    ctx.globalAlpha = 1;
  }

  function drawFloor(L, tile) {
    const W = L.columns * tile;
    const D = L.rows * tile;
    polygon([[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]], theme.floor, theme.text, 1.5);

    // Tile grid, skipped when tiles would be too small to read
    const a = project(0, 0, 0);
    const b = project(tile, 0, 0);
    if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 5) {
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < L.columns; c++) {
        const p = project(c * tile, 0, 0);
        const q = project(c * tile, D, 0);
        if (p && q) { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); }
      }
      for (let r = 1; r < L.rows; r++) {
        const p = project(0, r * tile, 0);
        const q = project(W, r * tile, 0);
        if (p && q) { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); }
      }
      ctx.stroke();
    }

    // Only the walls on the far side, so they never hide the racks
    const walls = [
      { normal: [0, 1, 0], pts: [[0, 0, 0], [W, 0, 0], [W, 0, WALL], [0, 0, WALL]], at: [W / 2, 0, 0] },
      { normal: [0, -1, 0], pts: [[W, D, 0], [0, D, 0], [0, D, WALL], [W, D, WALL]], at: [W / 2, D, 0] },
      { normal: [1, 0, 0], pts: [[0, D, 0], [0, 0, 0], [0, 0, WALL], [0, D, WALL]], at: [0, D / 2, 0] },
      { normal: [-1, 0, 0], pts: [[W, 0, 0], [W, D, 0], [W, D, WALL], [W, 0, WALL]], at: [W, D / 2, 0] },
    ];
    const [wr, wg, wb] = parseColor(theme.wall);
    for (const wall of walls) {
      if (!facesCamera(wall)) continue;
      polygon(wall.pts, `rgba(${wr},${wg},${wb},0.10)`, `rgba(${wr},${wg},${wb},0.35)`, 1);
    }

    // Compass marker by the north wall
    labelAt('N', W / 2, -500, 0, 400);
  }

  function drawFlatObject(o, tile) {
    const x0 = o.x * tile;
    const y0 = o.y * tile;
    const x1 = x0 + o.width * tile;
    const y1 = y0 + o.height * tile;
    const color = OBJECT_COLOR[o.kind];
    const dashed = o.kind === 'area';
    ctx.setLineDash(dashed ? [4, 4] : []);
    polygon([[x0, y0, 4], [x1, y0, 4], [x1, y1, 4], [x0, y1, 4]], color,
      dashed ? theme.muted : 'rgba(0,0,0,0.15)', 1);
    ctx.setLineDash([]);
    labelAt(o.label || o.kind_label, (x0 + x1) / 2, (y0 + y1) / 2, 10, 170);
  }

  // ---------------------------------------------------------------- render

  // Only touch the canvas size when it actually changes; setting it reallocates the canvas
  let sized = '';
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w) return false;
    const key = `${w}x${h}@${dpr}`;
    if (key !== sized) {
      sized = key;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      view = { w, h, cx: w / 2, cy: h * 0.55, f: h * 1.25 };
      themeKey = '';
    }
    return true;
  }

  // Theme colours are cached and re-read only when NetBox switches light/dark mode
  let themeKey = '';
  function ensureTheme() {
    const key = document.documentElement.getAttribute('data-bs-theme') || 'light';
    if (key !== themeKey) {
      themeKey = key;
      readTheme();
    }
  }

  function draw() {
    frame = 0;
    if (!resize()) return;
    ensureTheme();
    const data = host.data();
    const L = data.layout;
    const tile = L.tile;
    eye = cameraPosition();
    ctx.clearRect(0, 0, view.w, view.h);

    drawFloor(L, tile);
    for (const o of data.objects) if (FLAT[o.kind]) drawFlatObject(o, tile);

    // Racks and solid objects, farthest first
    const items = [];
    for (const r of data.racks) {
      if (!r.placed) continue;
      const box = rackBox(r, tile);
      items.push({ rack: r, box });
    }
    for (const o of data.objects) {
      if (!FLAT[o.kind]) {
        items.push({ object: o, box: { x0: o.x * tile, y0: o.y * tile, x1: (o.x + o.width) * tile, y1: (o.y + o.height) * tile, z1: OBJECT_HEIGHT[o.kind] || 1800 } });
      }
    }
    // Straight-line distance from the camera orders side-by-side racks correctly,
    // where depth along the view axis would make neighbours draw over each other
    for (const item of items) {
      const b = item.box;
      item.depth = Math.hypot((b.x0 + b.x1) / 2 - eye[0], (b.y0 + b.y1) / 2 - eye[1], b.z1 / 2 - eye[2]);
    }
    items.sort((a, b) => b.depth - a.depth);

    hits = [];
    const selected = host.selected();
    for (const item of items) {
      if (item.object) {
        drawObjectBox(item.object, tile);
      } else {
        const r = item.rack;
        const polys = drawRack(r, item.box, r.id === selected, !host.rackMatches(r));
        hits.push({ rack: r, polys });
      }
    }

    if (spinning) {
      cam.yaw += 0.0035;
      schedule();
    }
  }

  function schedule() {
    if (!frame) frame = window.requestAnimationFrame(draw);
  }

  function rackAt(x, y) {
    for (let i = hits.length - 1; i >= 0; i--) {
      for (const p of hits[i].polys) {
        let inside = false;
        for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
          if ((p[a][1] > y) !== (p[b][1] > y) &&
            x < (p[b][0] - p[a][0]) * (y - p[a][1]) / (p[b][1] - p[a][1]) + p[a][0]) inside = !inside;
        }
        if (inside) return hits[i].rack;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- camera controls

  function reset() {
    const L = host.data().layout;
    const W = L.columns * L.tile;
    const D = L.rows * L.tile;
    cam.tx = W / 2;
    cam.ty = D / 2;
    cam.yaw = -0.55;
    cam.pitch = 0.72;
    cam.dist = Math.max(W, D) * 0.95 + 2500;
    schedule();
  }

  function localPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    const start = [e.clientX, e.clientY];
    let last = start;
    let moved = false;
    const pan = e.button === 2 || e.shiftKey;
    canvas.setPointerCapture(e.pointerId);
    host.hover(null);

    const onMove = (ev) => {
      const dx = ev.clientX - last[0];
      const dy = ev.clientY - last[1];
      last = [ev.clientX, ev.clientY];
      if (!moved && Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < 4) return;
      moved = true;
      if (pan) {
        const s = cam.dist / view.f;
        const cy = Math.cos(cam.yaw);
        const sy = Math.sin(cam.yaw);
        // Screen right and screen-up projected onto the floor, in plan coordinates
        cam.tx -= dx * s * cy;
        cam.ty -= dx * s * sy;
        const k = s / Math.max(0.3, Math.sin(cam.pitch));
        cam.tx -= dy * k * sy;
        cam.ty += dy * k * cy;
      } else {
        cam.yaw -= dx * 0.008;
        cam.pitch = Math.max(0.12, Math.min(1.55, cam.pitch + dy * 0.006));
      }
      schedule();
    };
    const onUp = (ev) => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      if (!moved && ev.type === 'pointerup' && ev.button === 0) {
        const [x, y] = localPoint(ev);
        const r = rackAt(x, y);
        host.select(r ? r.id : null);
      }
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const [x, y] = localPoint(e);
    const r = rackAt(x, y);
    canvas.style.cursor = r ? 'pointer' : 'grab';
    host.hover(r, e);
  });
  canvas.addEventListener('pointerleave', () => host.hover(null));

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = Math.max(1500, Math.min(80000, cam.dist * Math.exp(e.deltaY * 0.0012)));
    schedule();
  }, { passive: false });

  if (window.ResizeObserver) new ResizeObserver(() => schedule()).observe(canvas);
  new MutationObserver(() => schedule()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });

  reset();

  return {
    render: schedule,
    reset,
    rotate(delta) { cam.yaw += delta; schedule(); },
    topView() { cam.pitch = 1.55; cam.yaw = 0; schedule(); },
    zoom(factor) { cam.dist = Math.max(1500, Math.min(80000, cam.dist * factor)); schedule(); },
    toggleSpin() { spinning = !spinning; schedule(); return spinning; },
  };
};
{% endverbatim %}
