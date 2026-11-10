// Pixel venue: the plug-and-play entry. Auto-mounts every [data-venue] host on DOM ready (one WebGL context:
// a background host wins), follows [data-venue-shot] elements on scroll, wires [data-venue-control] buttons.
// No static imports: the WebGL engine is loaded lazily, so any failure leaves <img data-venue-still> in place.
const BASE = new URL('.', import.meta.url);
const NAMES = ['overview', 'arrive', 'host', 'schedule', 'scan', 'stage', 'lounge', 'clusters', 'navigate'];
// guided navigation: accepted `to` names -> rooms
const GUIDE = { keynote: 'keynote', stage: 'keynote', 'room-a': 'room-a', 'room-b': 'room-b', 'room-c': 'room-c', 'room-d': 'room-d', scan: 'room-b', lounge: 'lounge' };
const STILLS = { overview: 'still-overview.png', arrive: 'still-arrive.png', host: 'still-host.png', clusters: 'still-clusters.png' };
const SIDES = ['left', 'right', 'center', 'top'];
const STORE = 'venue-motion-v1';
const AVATAR = 'cc.avatar.v1';
// a visitor's character: { skin, hair, shirt, pants } as #rrggbb (storage: rrggbb), hat boolean; anything else is ignored
function parseLook(o, bareHex) {
  if (!o || typeof o !== 'object') return null;
  const re = bareHex ? /^[0-9a-fA-F]{6}$/ : /^#[0-9a-fA-F]{6}$/;
  const out = {};
  for (const k of ['skin', 'hair', 'shirt', 'pants']) {
    const v = o[k];
    if (typeof v === 'string' && re.test(v)) { const n = parseInt(v.replace('#', ''), 16); out[k] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  }
  if (typeof o.hat === 'boolean') out.hat = o.hat;
  return Object.keys(out).length ? out : null;
}
function storedLook() {
  try { return parseLook(JSON.parse(localStorage.getItem(AVATAR) || 'null'), true); } catch (e) { return null; }
}
const NARROW = 760;
const STEP = 1 / 30;
const TIERS = [{ count: 80, fps: 60 }, { count: 50, fps: 30 }, { count: 30, fps: 20 }];

const root = document.documentElement;
const state = { paused: false, static: false };
const controllers = new Set();
const warned = new Set();

try {
  const s = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (s) { state.paused = !!s.paused; state.static = !!s.static; }
} catch (e) { /* storage blocked */ }

function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* storage blocked */ } }
function syncControls() {
  root.setAttribute('data-venue-state', state.static ? 'static' : state.paused ? 'paused' : 'playing');
  document.querySelectorAll('[data-venue-control]').forEach((b) => {
    const kind = b.getAttribute('data-venue-control');
    if (kind !== 'pause' && kind !== 'static') return;
    const on = kind === 'pause' ? state.paused : state.static;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = b.getAttribute(on ? 'data-label-on' : 'data-label-off');
    if (label != null && b.textContent !== label) b.textContent = label;
  });
}
function setState(patch) {
  Object.assign(state, patch);
  save();
  syncControls();
  controllers.forEach((c) => c.sync());
}
document.addEventListener('click', (e) => {
  const g = e.target && e.target.closest ? e.target.closest('[data-venue-guide]') : null;
  if (g) controllers.forEach((c) => c.guide({ to: g.getAttribute('data-venue-guide'), label: g.getAttribute('data-venue-guide-label') || undefined }));
  const b = e.target && e.target.closest ? e.target.closest('[data-venue-control]') : null;
  if (!b) return;
  const kind = b.getAttribute('data-venue-control');
  if (kind === 'pause') setState({ paused: !state.paused });
  else if (kind === 'static') setState({ static: !state.static });
});

document.addEventListener('venue:spawn', (e) => { controllers.forEach((c) => c.spawn(e.detail || {})); });

const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const reducedMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

class Controller {
  constructor(el, opts) {
    this.el = el;
    this.opts = opts || {};
    this.img = el.querySelector('img[data-venue-still]');
    this.imgSrc0 = this.img ? this.img.getAttribute('src') || '' : '';
    this.bg = el.getAttribute('data-venue-mode') === 'background';
    this.engine = null;
    this.failed = false;
    this.destroyed = false;
    this.raf = 0;
    this.last = 0;
    this.lastRender = 0;
    this.acc = 0;
    this.sCur = null;
    this.sTarget = 0;
    this.shots = [];
    this.current = null;
    this.dimLive = null;
    this.override = null;
    this.tier = 0;
    this.perf = { frames: 0, sum: 0, worst: 0, renders: 0, renderMs: 0, slow: 0, window: [] };
    this.reduced = !!(reducedMQ && reducedMQ.matches);
    this.ready = new Promise((r) => { this._resolve = r; });
    this._onScroll = () => { if (this.engine && !this.failed && !this.isStatic()) this.kick(); else this.follow(); };
    this._onResize = () => { this.needMeasure = true; this.needSize = true; this.kick(); };
    this._onVis = () => { if (!document.hidden) { this.last = 0; this.kick(); } };
    this._onRM = () => { this.reduced = !!reducedMQ.matches; this.composed = null; this.dirty = true; this.kick(); };
    window.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onResize, { passive: true });
    document.addEventListener('visibilitychange', this._onVis);
    if (reducedMQ && reducedMQ.addEventListener) reducedMQ.addEventListener('change', this._onRM);
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => { this.needMeasure = true; this.kick(); });
      this.ro.observe(document.documentElement);
      if (document.body) this.ro.observe(document.body);
      this.observed = new Set();
      this.hostRO = new ResizeObserver(() => { this.needSize = true; this.kick(); });
      this.hostRO.observe(el);
    }
    // shot elements whose attributes change at runtime (or that are added late) are picked up
    if (typeof MutationObserver === 'function') {
      this.mo = new MutationObserver((recs) => {
        for (const r of recs) {
          if (r.type === 'attributes' || [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1 && (n.hasAttribute('data-venue-shot') || (n.querySelector && n.querySelector('[data-venue-shot]'))))) {
            this.needMeasure = true; this.dirty = true;
            if (this.engine && !this.failed && !this.isStatic()) this.kick(); else this.follow();
            return;
          }
        }
      });
      this.mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-venue-shot', 'data-venue-side', 'data-venue-dim'] });
    }
    if (!this.bg && typeof IntersectionObserver === 'function') {
      this.onscreen = true;
      this.io = new IntersectionObserver((es) => { this.onscreen = es.some((x) => x.isIntersecting); if (this.onscreen) this.kick(); });
      this.io.observe(el);
    }
    this.needMeasure = true;
    this.needSize = true;
    this.api = {
      pause: () => setState({ paused: true }),
      play: () => setState({ paused: false }),
      setStatic: (v) => setState({ static: !!v }),
      goTo: (name) => this.goTo(name),
      spawn: (o) => this.spawn(o),
      guide: (o) => this.guide(o),
      clearGuide: () => this.clearGuide(),
      ready: this.ready,
      destroy: () => this.destroy(),
      stats: () => this.stats(),
    };
    this.measure();
    this.sync();
  }

  // ---------------------------------------------------------------- lifecycle
  sync() {
    if (this.destroyed) return;
    if (this.isStatic() || this.failed) {
      this.el.removeAttribute('data-venue-live');
      this.stop();
      this.updateStill();
      this.follow();
      if (!this.engine) this._resolve({ live: false, static: state.static });
      return;
    }
    if (this.img && this.imgSrc0 && this.img.getAttribute('src') !== this.imgSrc0) this.img.setAttribute('src', this.imgSrc0);
    if (!this.engine) { this.start(); return; }
    this.el.setAttribute('data-venue-live', '');
    this.dirty = true;
    this.kick();
  }
  async start() {
    if (this.starting || this.engine || this.failed) return;
    this.starting = true;
    try {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('data-venue-canvas', '');
      canvas.setAttribute('aria-hidden', 'true');
      const attrs = { antialias: false, alpha: false, depth: true, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' };
      const gl = canvas.getContext('webgl2', attrs);
      if (!gl) throw new Error('no webgl2');
      let gpu = '';
      try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      } catch (e) { /* ignore */ }
      this.software = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(gpu);
      this.gpu = gpu;
      if (this.software) this.tier = 1;
      const [mod, data] = await Promise.all([import(new URL('engine.js', BASE).href), this.loadData()]);
      if (this.destroyed) return;
      this.canvas = canvas;
      this.el.appendChild(canvas);
      this._onLost = (e) => { e.preventDefault(); this.fail(); };
      canvas.addEventListener('webglcontextlost', this._onLost);
      let count = this.opts.count || parseInt(this.el.getAttribute('data-venue-count'), 10) || TIERS[this.tier].count;
      if (data && isFinite(+data.attendeeCount) && !this.opts.count) count = Math.min(count, Math.max(60, Math.min(100, Math.round(+data.attendeeCount))));
      this.engine = mod.createEngine({ host: this.el, canvas, gl, count, seed: this.opts.seed, data });
      if (this.guideInfo) this.startGuide();
      if (this.pending) { const p = this.pending; this.pending = null; p.forEach((x) => this.engine.spawn(x.label, this.reduced, x.look)); }
      this.STEP = mod.STEP || STEP;
      this.needSize = true;
      this.needMeasure = true;
      this.frame(performance.now(), true);
      if (this.failed) return;
      if (!this.isStatic()) this.el.setAttribute('data-venue-live', '');
      this._resolve({ live: true });
      this.kick();
    } catch (e) {
      this.fail();
    } finally {
      this.starting = false;
    }
  }
  // the static view shows the still, except while a guide is showing its route
  isStatic() { return state.static && !this.guideShow; }
  // guided navigation: a highlighted person walks from the entrance to a room; the camera holds the "navigate" shot
  guide(o) {
    const to = String((o && o.to) || '').trim();
    if (!GUIDE[to] || this.destroyed || this.failed) return false;
    const label = String((o && o.label) || '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'You';
    this.clearGuide(true);
    const look = o && o.look !== undefined ? parseLook(o.look, false) : storedLook();
    this.guideInfo = { to, label, look, room: GUIDE[to], arrived: false, started: false };
    try { document.dispatchEvent(new CustomEvent('venue:guide', { detail: { to, label } })); } catch (e) { /* ignore */ }
    if (state.static) { this.guideShow = true; this.sync(); }
    if (this.engine) this.startGuide();
    return true;
  }
  startGuide() {
    const g = this.guideInfo;
    if (!g || g.started || !this.engine) return;
    g.started = true;
    // reduced motion, static view or paused motion: draw the whole route and place the person at the destination
    this.engine.guide(g.room, g.label, this.reduced || state.static || state.paused, g.look);
    this.goTo('navigate');
    this.dirty = true;
    this.kick();
  }
  clearGuide(quiet) {
    clearTimeout(this.guideTimer);
    if (this.destroyed) return false;
    const had = !!this.guideInfo;
    this.guideInfo = null;
    if (this.engine) this.engine.clearGuide();
    if (this.override && this.override.name === 'navigate') { this.override = null; this.needMeasure = true; }
    if (this.guideShow) { this.guideShow = false; if (!quiet) this.sync(); }
    this.dirty = true;
    this.kick();
    return had;
  }
  checkGuide() {
    const g = this.guideInfo;
    if (!g || !g.started || g.arrived || !this.engine) return;
    const st = this.engine.guideStatus();
    if (!st || !st.arrived) return;
    g.arrived = true;
    try { document.dispatchEvent(new CustomEvent('venue:arrived', { detail: { to: g.to, label: g.label } })); } catch (e) { /* ignore */ }
    this.guideTimer = setTimeout(() => { if (this.guideInfo === g) this.clearGuide(); }, 6000);
  }
  // optional aggregates: <div data-venue data-venue-data="data/demo-aggregates.json">; any failure means built-in defaults
  async loadData() {
    const src = this.opts.data || this.el.getAttribute('data-venue-data');
    if (!src || typeof fetch !== 'function') return null;
    if (typeof src === 'object') return src;
    try {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctl && ctl.abort(), 2500);
      const r = await fetch(new URL(src, document.baseURI).href, { signal: ctl ? ctl.signal : undefined, cache: 'no-cache' });
      clearTimeout(timer);
      if (!r.ok) return null;
      const j = await r.json();
      return j && typeof j === 'object' ? j : null;
    } catch (e) { return null; }
  }
  // a live arrival walks in to the desk with a pixel name label
  spawn(o) {
    const label = String((o && o.label) || '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
    if (this.destroyed || this.failed) return false;
    const look = o ? parseLook(o.look, false) : null;
    if (!this.engine) { (this.pending = this.pending || []).push({ label, look }); return true; }
    this.engine.spawn(label, this.reduced, look);
    this.dirty = true;
    this.kick();
    return true;
  }
  fail() {
    this.failed = true;
    this.stop();
    this.el.removeAttribute('data-venue-live');
    if (this.engine) { try { this.engine.destroy(); } catch (e) { /* ignore */ } this.engine = null; }
    if (this.canvas) { this.canvas.remove(); this.canvas = null; }
    this.updateStill();
    this.follow();
    this._resolve({ live: false });
  }
  destroy() {
    if (this.destroyed) return;
    clearTimeout(this.guideTimer);
    this.destroyed = true;
    this.stop();
    window.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVis);
    if (reducedMQ && reducedMQ.removeEventListener) reducedMQ.removeEventListener('change', this._onRM);
    if (this.ro) this.ro.disconnect();
    if (this.mo) this.mo.disconnect();
    if (this.hostRO) this.hostRO.disconnect();
    if (this.io) this.io.disconnect();
    if (this.engine) { try { this.engine.destroy(); } catch (e) { /* ignore */ } this.engine = null; }
    if (this.canvas) { this.canvas.removeEventListener('webglcontextlost', this._onLost); this.canvas.remove(); this.canvas = null; }
    this.el.removeAttribute('data-venue-live');
    this.el.removeAttribute('data-venue-shot-current');
    this.el.style.removeProperty('--venue-dim-live');
    if (this.img && this.imgSrc0) this.img.setAttribute('src', this.imgSrc0);
    controllers.delete(this);
    if (this.el.venue === this.api) delete this.el.venue;
    this._resolve({ live: false });
  }
  // without a running scene (static view, fallback still) the shot attributes, events and still image still follow scroll
  follow() {
    if (this.destroyed || this.followRaf) return;
    this.followRaf = requestAnimationFrame(() => {
      this.followRaf = 0;
      if (this.needMeasure) this.measure();
      const L = this.shots;
      const i = Math.max(0, Math.min(L.length - 1, Math.round(this.targetS())));
      this.setCurrent(L[i]);
    });
  }
  kick() {
    if (this.raf || this.destroyed || !this.engine || this.failed || this.isStatic()) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; if (this.followRaf) cancelAnimationFrame(this.followRaf); this.followRaf = 0; }

  // ---------------------------------------------------------------- shots
  measure() {
    const els = Array.from(document.querySelectorAll('[data-venue-shot]'));
    const vh = window.innerHeight || 1;
    const sy = window.scrollY || window.pageYOffset || 0;
    let rootDim = parseFloat(getComputedStyle(root).getPropertyValue('--venue-dim'));
    if (!isFinite(rootDim)) rootDim = 0.25;
    const list = els.map((el) => {
      let name = (el.getAttribute('data-venue-shot') || '').trim();
      if (!NAMES.includes(name)) {
        if (!warned.has(name)) { warned.add(name); console.warn(`[venue] unknown shot "${name}", using "overview"`); }
        name = 'overview';
      }
      let side = (el.getAttribute('data-venue-side') || 'left').trim();
      if (!SIDES.includes(side)) side = 'left';
      let dim = parseFloat(el.getAttribute('data-venue-dim'));
      if (!isFinite(dim)) dim = parseFloat(getComputedStyle(el).getPropertyValue('--venue-dim'));
      if (!isFinite(dim)) dim = rootDim;
      const r = el.getBoundingClientRect();
      const top = r.top + sy, h = r.height;
      const m = Math.min(vh, h) / 2;
      return { el, name, side, dim: clamp01(dim), top, h0: top + m, h1: top + Math.max(m, h - m), index: 0 };
    });
    list.forEach((s, i) => { s.index = i; });
    list.sort((a, b) => a.h0 - b.h0);
    // the top of the page is "overview" only while the first shot element starts below the viewport centre at scrollY 0
    const top = { el: null, name: 'overview', side: 'left', dim: rootDim, h0: vh / 2, h1: vh / 2, index: -1 };
    if (!list.length) list.push(top);
    else if (Math.min(...list.map((x) => x.top)) > vh / 2) list.unshift(top);
    if (this.ro) for (const el of els) if (!this.observed.has(el)) { this.observed.add(el); this.ro.observe(el); }
    // keep the camera where it is: re-anchor the continuous index onto the new list
    const old = this.shots;
    if (old.length && this.sCur !== null) {
      const same = (a, b) => a && b && a.el === b.el && a.name === b.name;
      const i = Math.max(0, Math.min(old.length - 1, Math.floor(this.sCur))), f = this.sCur - i;
      const ni = list.findIndex((x) => same(x, old[i]));
      if (ni >= 0) this.sCur = ni + (f > 0 && same(list[ni + 1], old[i + 1]) ? f : 0);
      else this.sCur = null;
    }
    this.shots = list;
    this.needMeasure = false;
    this.lastMeasure = performance.now();
    this.dirty = true;
  }
  side(s) {
    if (!this.bg) return 'center';
    if ((window.innerWidth || 1024) < NARROW) return 'top';
    return s.side;
  }
  targetS() {
    const sy = window.scrollY || window.pageYOffset || 0;
    if (this.override) {
      if (Math.abs(sy - this.override.sy) < 60) {
        let i = this.shots.findIndex((s) => s.name === this.override.name);
        if (i < 0) {
          this.shots.push({ el: null, name: this.override.name, side: this.shots[0] ? this.shots[0].side : 'left', dim: this.shots[0] ? this.shots[0].dim : 0.25, h0: Infinity, h1: Infinity, index: -1, extra: true });
          i = this.shots.length - 1;
        }
        return i;
      }
      this.override = null;
      this.needMeasure = true;
    }
    const L = this.shots;
    const vc = sy + (window.innerHeight || 1) / 2;
    if (vc <= L[0].h1) return 0;
    for (let i = 0; i < L.length - 1; i++) {
      const a = L[i], b = L[i + 1];
      if (vc <= a.h1) return i;
      if (vc < b.h0) return i + ease((vc - a.h1) / Math.max(1, b.h0 - a.h1));
    }
    return L.length - 1;
  }
  goTo(name) {
    const i = this.shots.findIndex((s) => s.name === name && s.el);
    if (i >= 0) {
      const el = this.shots[i].el;
      try { el.scrollIntoView({ behavior: this.reduced ? 'auto' : 'smooth', block: 'center' }); } catch (e) { el.scrollIntoView(); }
      return;
    }
    if (!NAMES.includes(name)) { console.warn(`[venue] unknown shot "${name}", using "overview"`); name = 'overview'; }
    // no element carries it: hold it in place until the visitor really scrolls
    this.override = { sy: window.scrollY || 0, name };
    this.dirty = true;
    if (this.engine && !this.failed && !this.isStatic()) this.kick(); else this.follow();
  }
  setCurrent(s) {
    const c = this.current;
    if (c && c.name === s.name && c.el === s.el) { this.current = s; return; }
    this.current = s;
    this.el.setAttribute('data-venue-shot-current', s.name);
    root.setAttribute('data-venue-shot-current', s.name);
    if (this.engine) this.engine.setMode(s.name);
    this.updateStill();
    try {
      this.el.dispatchEvent(new CustomEvent('venue:shot', { bubbles: true, detail: { name: s.name, index: s.index, element: s.el } }));
    } catch (e) { /* ignore */ }
  }
  updateStill() {
    if (!this.img || !(this.isStatic() || this.failed)) return;
    if (!/still-(overview|ambient|arrive|host|clusters)\.png/.test(this.imgSrc0)) return;
    const name = this.current ? this.current.name : 'overview';
    const file = STILLS[name] || STILLS.overview;
    const url = new URL(file, BASE).href;
    if (this.img.src !== url) this.img.src = url;
  }

  // ---------------------------------------------------------------- loop
  frame(now, force) {
    this.raf = 0;
    if (this.destroyed || !this.engine || this.failed || this.isStatic()) return;
    if (document.hidden || this.onscreen === false) return;
    const E = this.engine;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    const gap = this.last ? now - this.last : 0;
    this.last = now;
    // re-measure on observed changes, and every 1.5 s anyway (app screens can change layout without resizing the page)
    if (this.needMeasure || !this.lastMeasure || now - this.lastMeasure > 1500) this.measure();
    if (this.needSize) {
      const w = this.el.clientWidth || window.innerWidth, h = this.el.clientHeight || window.innerHeight;
      const k = (window.innerWidth || w) < NARROW ? 3 : Math.max(2, Math.min(6, Math.round(w / 360)));
      E.resize(w, h, k);
      this.k = k;
      this.needSize = false;
      this.dirty = true;
    }
    // camera: continuous shot index, eased by scroll, smoothed in time (cut when reduced motion)
    const target = this.targetS();
    let moving = false;
    if (this.sCur === null || this.reduced) {
      const s = this.reduced ? Math.round(target) : target;
      if (s !== this.sCur) { this.sCur = s; this.dirty = true; }
    } else if (Math.abs(target - this.sCur) > 0.0004) {
      this.sCur += (target - this.sCur) * (1 - Math.exp(-dt / 0.16));
      if (Math.abs(target - this.sCur) < 0.0004) this.sCur = target;
      moving = true;
      this.dirty = true;
    }
    const L = this.shots;
    const i = Math.max(0, Math.min(L.length - 1, Math.floor(this.sCur)));
    const t = this.sCur - i;
    const a = L[i], b = L[Math.min(L.length - 1, i + 1)];
    const near = t < 0.5 ? a : b;
    this.setCurrent(near);
    if (this.dirty) E.setView(a.name, this.side(a), b.name, this.side(b), t, this.bg && (window.innerWidth || 1024) < NARROW);
    const dim = a.dim + (b.dim - a.dim) * t;
    if (this.bg && (this.dimLive === null || Math.abs(dim - this.dimLive) > 0.002)) {
      this.dimLive = dim;
      this.el.style.setProperty('--venue-dim-live', dim.toFixed(3));
    }
    // crowd: fixed step; composed stills when reduced motion
    let simmed = false;
    if (this.reduced) {
      if (this.composed !== near.name) { E.compose(near.name); this.composed = near.name; this.dirty = true; }
    } else {
      if (this.composed) { this.composed = null; }
      if (!state.paused && dt > 0) {
        this.acc += dt;
        let n = 0;
        while (this.acc >= this.STEP && n < 3) { E.step(this.STEP); this.acc -= this.STEP; n++; }
        if (this.acc > this.STEP * 3) this.acc = 0;
        simmed = n > 0;
      }
    }
    this.checkGuide();
    const fps = TIERS[Math.min(this.tier, TIERS.length - 1)].fps;
    const want = force || this.dirty || simmed;
    if (want && (force || now - this.lastRender >= 1000 / fps - 3)) {
      const t0 = performance.now();
      this.calls = E.render();
      const ms = performance.now() - t0;
      this.perf.renders++;
      this.perf.renderMs += ms;
      const since = this.lastRender ? now - this.lastRender : 0;
      if (since && since < 400) this.track(since, ms);
      this.lastRender = now;
      this.dirty = false;
    }
    const animating = !this.reduced && !state.paused;
    if (animating || moving || this.dirty) this.kick();
  }
  // sustained slow frames: drop people, then the frame cap, then fall back to the still
  track(gap, ms) {
    const P = this.perf;
    P.frames++; P.sum += gap; P.worst = Math.max(P.worst, gap);
    P.window.push(gap);
    if (P.window.length > 90) P.window.shift();
    const fps = TIERS[Math.min(this.tier, TIERS.length - 1)].fps;
    const budget = 1000 / fps;
    if (P.window.length >= 45) {
      const sorted = P.window.slice().sort((x, y) => x - y);
      const avg = sorted[Math.floor(sorted.length / 2)]; // median: one-off stalls (tab switch, screenshots) do not count
      if (avg > Math.max(budget * 1.6, 45)) {
        P.window.length = 0;
        this.tier++;
        if (this.tier >= TIERS.length) { this.fail(); return; }
        if (this.engine) this.engine.setActive(TIERS[this.tier].count);
      }
    }
  }
  stats() {
    const P = this.perf;
    return {
      live: !!this.engine && !this.failed, failed: this.failed, tier: this.tier, software: !!this.software, gpu: this.gpu || '',
      reduced: this.reduced, k: this.k, calls: this.calls,
      avgFrameMs: P.frames ? P.sum / P.frames : null, worstFrameMs: P.worst,
      avgRenderCpuMs: P.renders ? P.renderMs / P.renders : null, renders: P.renders,
      shot: this.current && this.current.name, s: this.sCur,
      engine: this.engine ? this.engine.info() : null,
    };
  }
}

export function mountVenue(el, opts) {
  if (!el) return null;
  if (el.venue && el.venue.ready) return el.venue;
  const c = new Controller(el, opts);
  controllers.add(c);
  el.venue = c.api;
  syncControls();
  return c.api;
}

function auto() {
  syncControls();
  const all = Array.from(document.querySelectorAll('[data-venue]'));
  const bg = all.find((h) => h.getAttribute('data-venue-mode') === 'background');
  (bg ? [bg] : all.slice(0, 2)).forEach((h) => { try { mountVenue(h); } catch (e) { /* the still stays */ } });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto, { once: true });
else auto();
