// The WebGL side: one renderer, one scene, one orthographic camera, rendered at a low internal resolution and
// upscaled by CSS with nearest-neighbour. Loaded lazily by venue.js so a missing WebGL never breaks the page.
import * as THREE from '../vendor/three.module.min.js';
import { readTheme, mix } from './theme.js';
import { buildLayout } from './layout.js';
import { Nav } from './nav.js';
import { buildWorld, Fx } from './world.js';
import { Crowd, G } from './crowd.js';
import { People } from './people.js';
import { Bubbles } from './bubbles.js';
import { Labels } from './labels.js';
import { frameShot, blendFrames, SHOTS, setNavigateBox } from './shots.js';

export const STEP = 1 / 30;
const SEED = 9112026;

// screen slides: functions (slide, col, row, cols, rows) -> 0 off, 1 dim, 2 bright, or a colour
function slideCell(theme, k, c, r, cols, rows, big) {
  const s = k % 4;
  if (!big) {
    if (s === 0 || s === 2) return r === 0 ? (c < cols - 2 ? 2 : 0) : (c < 1 + ((r * 3 + k) % (cols - 1)) ? 1 : 0);
    const h = [1, 3, 2, 4, 2, 3, 1][c % 7];
    return rows - r <= h ? (c % 2 ? 2 : 1) : 0;
  }
  if (s === 0) { // title + bullets
    if (r === 0) return c >= 1 && c <= 10 ? 2 : 0;
    if (r >= 2 && r <= 4) { if (c === 1) return 2; const len = [9, 12, 7][r - 2]; return c >= 3 && c < 3 + len ? 1 : 0; }
    return 0;
  }
  if (s === 1) { // bar chart
    if (r === rows - 1) return c >= 1 && c <= 14 ? 1 : 0;
    const hs = [0, 0, 2, 0, 4, 0, 3, 0, 5, 0, 4, 0, 5, 0, 0, 0];
    return rows - 1 - r <= hs[c] ? 2 : 0;
  }
  if (s === 2) { // the interest map: five cluster blobs + grey other
    const blobs = [[2, 2, 0], [5, 3, 1], [9, 1, 2], [12, 3, 3], [14, 1, -1]];
    for (const [bx, by, h] of blobs) {
      if (Math.abs(c - bx) + Math.abs(r - by) <= 1) return h < 0 ? theme.grey : theme.cluster[h];
    }
    return r === rows - 1 ? 1 : 0;
  }
  // big pixel QR-ish mark
  const qr = ['111.1.111', '1.1..11.1', '111.1.111', '...11.1..', '111..1.11', '1.1.11..1'];
  const cc = c - 3;
  if (cc >= 0 && cc < 9) return qr[r][cc] === '1' ? 2 : 0;
  return c === 14 && r < 3 ? 1 : 0;
}

export function createEngine({ host, canvas, gl, count = 80, seed = SEED, data = null }) {
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'low-power' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(1);
  const theme = readTheme(host);
  renderer.setClearColor(new THREE.Color().fromArray(theme.bg), 1);

  const layout = buildLayout();
  const nav = new Nav(layout);
  const scene = new THREE.Scene();
  const world = buildWorld(layout, theme);
  scene.add(world.group);
  const fx = new Fx(layout, theme);
  scene.add(fx.mesh);
  const people = new People(theme, count + 16);
  scene.add(people.mesh);
  const bubbles = new Bubbles(theme);
  scene.add(bubbles.mesh);
  const labels = new Labels(theme);
  scene.add(labels.mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 220);

  let crowd = new Crowd(layout, nav, { seed, count, data });
  const warm = (secs, pred) => {
    const n = Math.round(secs / STEP);
    for (let i = 0; i < n; i++) {
      crowd.step(STEP);
      if (pred && i > 60 && pred(crowd)) break;
    }
  };
  warm(4);

  const C = {
    lampIdle: mix(theme.accent, theme.dark, 0.5),
    lampScan: mix(theme.ink, [1, 1, 1], 0.5),
    lampOk: theme.accent,
    lampDeny: theme.deny,
    tileOk: mix(theme.accent, theme.floor, 0.25),
    tileDeny: mix(theme.deny, theme.floor, 0.35),
    pxDim: mix(theme.accent, theme.k.screen, 0.55),
    pxBright: theme.accent,
    machineOff: mix(theme.accent, theme.dark, 0.6),
    ring: mix(theme.accent, theme.floor, 0.55),
    ringFaint: mix(theme.accent, theme.floor, 0.78),
  };

  let guideShown = false;
  let guideArgs = null;
  // dotted lime route on the floor (what is left of it) and stepped expanding rings around the three Bluetooth receivers
  function updateGuide() {
    const route = crowd.guideRoute();
    if (!route && !guideShown) return;
    guideShown = !!route;
    let n = 0;
    if (route && route.length > 1) {
      let carry = 0.3;
      for (let i = 1; i < route.length && n < fx.dots.length; i++) {
        const p = route[i - 1], q = route[i];
        const L = Math.hypot(q.x - p.x, q.z - p.z);
        let d = carry;
        for (; d < L && n < fx.dots.length; d += 0.62) {
          const x = p.x + (q.x - p.x) * d / L, z = p.z + (q.z - p.z) * d / L;
          fx.place(fx.dots[n++], x - 0.13, 0.014, z - 0.13, x + 0.13, 0.03, z + 0.13, theme.accent, true);
        }
        carry = d - L;
      }
    }
    for (let i = n; i < fx.dots.length; i++) if (fx.dots[i].show) fx.place(fx.dots[i], 0, 0, 0, 0, 0, 0, null, false);
    const step = Math.floor(crowd.t * 2.5) % 4;
    const r = 0.45 + step * 0.42;
    for (const g of fx.rings) {
      const { x, z } = g.b, t = 0.07, on = !!route;
      const c = step === 3 ? C.ringFaint : C.ring;
      fx.place(g.parts[0], x - r, 0.016, z - r, x + r, 0.03, z - r + t, c, on);
      fx.place(g.parts[1], x - r, 0.016, z + r - t, x + r, 0.03, z + r, c, on);
      fx.place(g.parts[2], x - r, 0.016, z - r, x - r + t, 0.03, z + r, c, on);
      fx.place(g.parts[3], x + r - t, 0.016, z - r, x + r, 0.03, z + r, c, on);
    }
  }
  let W = 1, H = 1, aspect = 1;
  let frame = null;
  let slide = -1;

  function updateFx() {
    for (const id in crowd.lamps) {
      const st = crowd.lamps[id].state;
      fx.set(fx.lamps[id], st === 'ok' ? C.lampOk : st === 'deny' ? C.lampDeny : st === 'scan' ? C.lampScan : C.lampIdle);
      fx.set(fx.tiles[id], st === 'ok' ? C.tileOk : st === 'deny' ? C.tileDeny : null, st === 'ok' || st === 'deny');
    }
    const showMk = crowd.mode === 'schedule';
    for (const m of fx.markers) for (const p of m.parts) fx.set(p, theme.accent, showMk);
    const k = Math.floor(crowd.t / 5);
    if (k !== slide) {
      slide = k;
      fx.screens.forEach((s, si) => {
        s.cells.forEach((cell, i) => {
          const c = i % s.cols, r = Math.floor(i / s.cols);
          const v = slideCell(theme, k + si, c, r, s.cols, s.rows, !!s.big);
          if (!v) fx.set(cell, null, false);
          else fx.set(cell, Array.isArray(v) ? v : v === 2 ? C.pxBright : C.pxDim, true);
        });
      });
    }
    fx.set(fx.machine, crowd.t < crowd.barista.armUntil ? theme.accent : C.machineOff);
    updateGuide();
    fx.flush();
  }

  const right = new THREE.Vector3(), up = new THREE.Vector3(), tgt = new THREE.Vector3(), dir = new THREE.Vector3();
  function applyCamera(f) {
    const viewH = f.viewH, viewW = viewH * aspect;
    camera.left = -viewW / 2; camera.right = viewW / 2; camera.top = viewH / 2; camera.bottom = -viewH / 2;
    camera.updateProjectionMatrix();
    dir.set(Math.sin(f.az) * Math.cos(f.el), Math.sin(f.el), Math.cos(f.az) * Math.cos(f.el));
    tgt.set(f.target[0], f.target[1], f.target[2]);
    camera.position.copy(tgt).addScaledVector(dir, 100);
    camera.up.set(0, 1, 0);
    camera.lookAt(tgt);
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    tgt.addScaledVector(right, f.offR).addScaledVector(up, f.offU);
    // snap the camera centre to the pixel grid so a resting view never shimmers
    const px = viewH / H;
    const tr = tgt.dot(right), tu = tgt.dot(up);
    tgt.addScaledVector(right, Math.round(tr / px) * px - tr).addScaledVector(up, Math.round(tu / px) * px - tu);
    camera.position.copy(tgt).addScaledVector(dir, 100);
    camera.updateMatrixWorld();
    world.setWallK(Math.round(f.wall * 4) / 4);
    world.setCut(f.cut);
  }

  const api = {
    theme, layout,
    get crowd() { return crowd; },
    get size() { return { w: W, h: H }; },
    resize(cssW, cssH, k) {
      W = Math.max(1, Math.ceil(cssW / k));
      H = Math.max(1, Math.ceil(cssH / k));
      aspect = W / H;
      renderer.setSize(W, H, false);
      canvas.style.width = W * k + 'px';
      canvas.style.height = H * k + 'px';
      bubbles.setRes(W, H);
      labels.setRes(W, H);
    },
    // shot blend: names, sides, t (already eased)
    setView(a, sideA, b, sideB, t, narrow) {
      const fa = frameShot(a, sideA, aspect, narrow);
      const fb = b ? frameShot(b, sideB, aspect, narrow) : null;
      frame = blendFrames(fa, fb, t);
    },
    setMode(name) { crowd.setMode(SHOTS[name] ? name : 'overview'); },
    step(dt) { crowd.step(dt); },
    // a composed still for one shot: fresh crowd from the seed, simulated until the shot's moment happens
    compose(name) {
      crowd = new Crowd(layout, nav, { seed, count: crowd.count, data });
      warm(5);
      crowd.setMode(name);
      const nearDoor = (b, id) => { const d = layout.doorById[id]; return Math.hypot(b.a.x - d.scan.x, b.a.z - d.scan.z) < 2.5; };
      const preds = {
        overview: (c) => c.t > 14 && c.bubbles.length >= 3,
        arrive: (c) => c.t - c.modeT > 6 && c.bubbles.some((b) => b.glyph === G.CHECK && b.a.z > 17 && b.a.x < 9 && c.t - b.t0 < 0.5) && c.deskQ.members.length >= 3,
        host: (c) => c.t - c.modeT > 4 && c.bubbles.some((b) => b.a === c.host && c.t - b.t0 < 0.4),
        schedule: (c) => c.t - c.modeT > 8,
        scan: (c) => c.t - c.modeT > 6 && c.bubbles.some((b) => b.glyph === G.CROSS && nearDoor(b, 'room-b') && c.t - b.t0 < 0.5),
        stage: (c) => c.t - c.modeT > 10 && c.bubbles.some((b) => b.a === c.speaker),
        lounge: (c) => c.t - c.modeT > 8 && c.bubbles.filter((b) => b.a.x > 13 && b.a.z > 14 && b.a.x < 26).length >= 3,
        clusters: (c) => c.t - c.modeT > 18 && (c.t - c.modeT) % 12 > 7.4,
      };
      warm(40, preds[name] || preds.overview);
      if (guideArgs) crowd.guide(guideArgs[0], guideArgs[1], true, guideArgs[2]); // a composed still keeps the guide (placed, full route)
    },
    render() {
      if (!frame) return 0;
      applyCamera(frame);
      updateFx();
      people.update(crowd, frame.cut);
      bubbles.update(crowd, frame.cut);
      labels.update(crowd, frame.cut);
      renderer.render(scene, camera);
      return renderer.info.render.calls;
    },
    info() {
      const i = renderer.info;
      let gpu = '';
      try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      } catch (e) { /* ignore */ }
      return { calls: i.render.calls, triangles: i.render.triangles, w: W, h: H, gpu, people: crowd.guests().length };
    },
    setActive(n) { crowd.setActive(n); },
    // guided navigation; returns false for an unknown room. The "navigate" shot frames entrance and destination.
    guide(to, label, instant, look) {
      const a = crowd.guide(to, label, instant, look);
      if (!a) return false;
      guideArgs = [to, label, look];
      const xs = a.route.map((p) => p.x), zs = a.route.map((p) => p.z);
      setNavigateBox([Math.min(...xs) - 2.5, Math.min(...zs) - 2.5, Math.max(...xs) + 2.5, Math.max(...zs) + 2.5]);
      return true;
    },
    clearGuide() { crowd.clearGuide(); guideArgs = null; },
    guideStatus() { const a = crowd.guideAgent; return a ? { arrived: a.arrived } : null; },
    // a live arrival; with reduced motion the crowd jumps ahead until the newcomer has a badge (no walking shown)
    spawn(label, instant, look) {
      const a = crowd.spawn(label, look);
      if (instant) warm(30, () => a.badge && crowd.bubbles.some((b) => b.a === a));
      return true;
    },
    destroy() {
      world.dispose(); fx.dispose(); people.dispose(); bubbles.dispose(); labels.dispose();
      const lost = gl.isContextLost();
      renderer.dispose();
      if (!lost) { try { renderer.forceContextLoss(); } catch (e) { /* ignore */ } }
    },
  };
  return api;
}
