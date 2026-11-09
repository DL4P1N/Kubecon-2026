// Crowd simulation (pure logic, no three.js): attendees, staff, queues, scanners, bubbles, the per-shot behaviour.
// Fixed time step, seeded RNG: the same seed and the same calls give the same crowd.
import { STREET, RECOMMENDED, FEATURED_DOOR } from './layout.js';

export const G = { CHECK: 0, CROSS: 1, DOTS: 2, QUESTION: 3, EXCL: 4, HEART: 5, STAR: 6, COFFEE: 7, QR: 8 };
const PI = Math.PI;
const snapYaw = (dx, dz) => Math.round(Math.atan2(dx, dz) / (PI / 4)) * (PI / 4);

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_TARGET = { keynote: 0.3, 'room-a': 0.065, 'room-b': 0.065, 'room-c': 0.065, 'room-d': 0.075, lounge: 0.13, bar: 0.035, hall: 0.065, lobby: 0.045, sponsor: 0.03, leave: 0.08 };
const ROOMS = ['keynote', 'room-a', 'room-b', 'room-c', 'room-d'];
// default cluster shares (teal amber coral green blue); small groups (FOLD0..) fold into grey "other" (OTHER)
const CLUSTER_SHARE = [0.28, 0.22, 0.17, 0.12, 0.08];
export const OTHER = 5;
export const FOLD0 = 6;
const FOLD_PERIOD = 12;   // the fold replays every 12 s while the clusters shot is current
const FOLD_AT = 6;        // seconds into each cycle when the small groups turn grey and join "other"

class Queue {
  constructor(slots, face, serveTime) {
    this.slots = slots;
    this.members = [];
    this.serveTime = serveTime;
    this.faces = slots.map((s, k) => (k === 0 ? face : snapYaw(slots[k - 1].x - s.x, slots[k - 1].z - s.z)));
  }
  full() { return this.members.length >= Math.min(this.cap || 99, this.slots.length); }
  remove(a) { const i = this.members.indexOf(a); if (i >= 0) this.members.splice(i, 1); }
}

export class Crowd {
  constructor(layout, nav, opts = {}) {
    this.L = layout; this.nav = nav;
    this.rnd = mulberry32(opts.seed ?? 9112026);
    this.t = 0;
    this.mode = 'overview';
    this.modeT = 0;
    this.agents = [];
    this.bubbles = [];
    this.lamps = {};
    this.scanCount = 0;
    this.dialog = { next: 0, turn: 0 };
    this.folded = false;
    for (const d of layout.doors) {
      d.q = new Queue(d.slots, d.face, 0.8);
      this.lamps[d.id] = { state: 'idle', until: 0 };
    }
    this.deskQ = new Queue(layout.deskQ, PI, 3.0);
    this.seats = layout.seats;
    this.stands = layout.stands;
    for (const k in this.stands) this.stands[k].forEach((s) => { s.taken = null; });
    for (const k in this.seats) this.seats[k].forEach((s) => { s.taken = null; });
    this.count = opts.count ?? 80;
    this._configure(opts.data);
    this._makeAgents();
    this._place();
  }

  // ------------------------------------------------------------------ setup
  _look(R) {
    const L = (n) => Math.floor(R() * n);
    return {
      skin: L(6), hair: L(7), style: L(5), shirt: L(14), pants: L(7), shoes: L(5),
      glasses: R() < 0.22, tall: R() < 0.5 ? 0 : (R() < 0.5 ? 1 : -1),
    };
  }
  // Optional event aggregates (data-venue-data): cluster sizes, room fill, denied share. Defaults otherwise.
  _configure(data) {
    const n = this.count;
    this.denyShare = 0.08;
    this.featuredDeny = 1 / 3;
    this.roomFill = null;
    // cluster sizes in people: [teal, amber, coral, green, blue, other, fold groups...]
    let sizes = CLUSTER_SHARE.map((x) => Math.round(n * x));
    let fold = [3, 2]; // by default two small groups (under 5) that fold into "other"
    try {
      if (data && Array.isArray(data.clusters)) {
        const rows = data.clusters.filter((c) => c && isFinite(+c.count) && +c.count > 0);
        const named = rows.filter((c) => c.id !== 'other').sort((a, b) => b.count - a.count);
        const total = rows.reduce((t, c) => t + +c.count, 0);
        if (total > 0 && named.length) {
          const top = named.slice(0, 5);
          sizes = top.map((c) => Math.max(5, Math.round(n * c.count / total)));
          while (sizes.length < 5) sizes.push(0);
          this.labels = top.map((c) => String(c.label || c.id || ''));
          // "other" is made of suppressed groups under 5: show them as tiny groups of their own that fold
          const other = rows.filter((c) => c.id === 'other').reduce((t, c) => t + +c.count, 0);
          const k = Math.max(1, Math.min(2, Math.round(+data.suppressedGroups) || 1));
          fold = [];
          if (other > 0) {
            const people = Math.max(2 * k, Math.round(n * other / total));
            for (let i = 0; i < k; i++) fold.push(Math.max(2, Math.round(people / k)));
          }
        }
      }
      if (data && Array.isArray(data.roomOccupancy)) {
        const map = { keynote: 'keynote', 'room-a': 'room-a', 'room-b': 'room-b', 'room-c': 'room-c', 'room-d': 'room-d', lounge: 'lounge' };
        const peak = {};
        for (const r of data.roomOccupancy) {
          const id = r && map[r.sceneRoom];
          if (!id || !(+r.capacity > 0)) continue;
          const v = isFinite(+r.scannedIn) && +r.scannedIn > 0 ? +r.scannedIn : +r.expected || 0;
          const f = Math.max(0, Math.min(1, v / +r.capacity));
          if (!(id in peak) || f > peak[id]) peak[id] = f;
        }
        // keep every shot readable: the keynote always has an audience, no room is ever quite empty
        for (const k in peak) peak[k] = Math.max(k === 'keynote' ? 0.55 : 0.2, peak[k]);
        if (Object.keys(peak).length) this.roomFill = peak;
      }
      if (data && data.scanTotals) {
        const a = +data.scanTotals.allowed || 0, d = +data.scanTotals.denied || 0;
        if (a + d > 0) { this.denyShare = d / (a + d); this.featuredDeny = Math.max(0.2, Math.min(0.5, this.denyShare)); }
      }
    } catch (e) { /* malformed data: defaults */ }
    sizes[OTHER] = 0; // whoever is left over after the named and folding groups
    this.foldSizes = fold;
    fold.forEach((f, i) => { sizes[FOLD0 + i] = f; });
    this.sizes = sizes;
  }
  _makeAgents() {
    const R = this.rnd;
    const n = this.count;
    // cluster membership, shuffled
    const cl = [];
    // small folding groups first so they always exist, then the named clusters, the rest is "other"
    const order = this.sizes.map((k, c) => c).sort((x, y) => (y >= FOLD0) - (x >= FOLD0));
    for (const c of order) for (let i = 0; i < this.sizes[c] && cl.length < n; i++) cl.push(c);
    while (cl.length < n) cl.push(OTHER);
    cl.length = n;
    for (let i = cl.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [cl[i], cl[j]] = [cl[j], cl[i]]; }
    for (let i = 0; i < n; i++) this.agents.push(this._agent('guest', cl[i]));
    const host = this._agent('host', -1);
    Object.assign(host, { x: this.L.host.x, z: this.L.host.z, yaw: this.L.host.yaw });
    host.look.shirt = -1; host.look.style = 3; host.look.hair = 1; host.look.glasses = false; host.look.skin = 2; host.look.tall = 0; host.badge = true;
    this.host = host;
    const sp = this._agent('speaker', -1);
    Object.assign(sp, { x: 7.6, z: this.L.speaker.z, y: this.L.speaker.y, yaw: 0 });
    sp.look.shirt = 7; sp.look.style = 0; sp.look.hair = 0; sp.look.skin = 4; sp.badge = true;
    this.speaker = sp;
    const ba = this._agent('barista', -1);
    Object.assign(ba, { x: this.L.barista.x, z: this.L.barista.z, yaw: this.L.barista.yaw });
    ba.look.shirt = 7; ba.look.style = 2; ba.look.skin = 1; ba.badge = true;
    this.barista = ba;
    this.agents.push(host, sp, ba);
  }
  _agent(kind, cluster) {
    const R = this.rnd;
    return {
      id: this.agents.length, kind, cluster, tint: -1,
      x: 0, y: 0, z: 0, yaw: 0, pose: 'stand', walkT: R() * 4, armUntil: 0, hidden: false, disabled: false,
      badge: true, look: this._look(R), speed: 1.55 + R() * 0.4,
      plan: [], cur: null, area: null, lastArea: null, seat: null, spot: null, queue: null, nextChat: 0,
    };
  }
  guests() { return this.agents.filter((a) => a.kind === 'guest' && !a.disabled); }

  // initial placement: everyone already somewhere sensible, so the very first frame reads as a busy venue
  _place() {
    const R = this.rnd;
    const gs = this.guests();
    const take = (list) => { const free = list.filter((s) => !s.taken); return free.length ? free[Math.floor(R() * free.length)] : null; };
    let i = 0;
    const F = this.roomFill;
    const nKey = F && F.keynote !== undefined ? Math.min(Math.round(gs.length * 0.45), Math.round(this.seats.keynote.length * F.keynote)) : Math.round(gs.length * 0.27);
    for (; i < nKey && i < gs.length; i++) this._seatAt(gs[i], take(this.seats.keynote), 'keynote', 10 + R() * 50);
    for (const room of ['room-a', 'room-b', 'room-c', 'room-d']) for (let k = 0, kn = F && F[room] !== undefined ? Math.round(this.seats[room].length * F[room]) : 4; k < kn && i < gs.length; k++, i++) this._seatAt(gs[i], take(this.seats[room]), room, 4 + R() * 25);
    for (const area of ['lounge', 'lounge', 'lounge', 'lounge', 'lounge', 'lounge', 'hall', 'hall', 'hall', 'hall', 'lobby', 'lobby', 'sponsor', 'bar']) {
      if (i >= gs.length) break;
      const s = take(this.stands[area]);
      if (!s) continue;
      const a = gs[i++];
      this._standAt(a, s, area, 3 + R() * 14);
    }
    // a short desk queue of new arrivals
    for (let k = 0; k < 3 && i < gs.length; k++, i++) {
      const a = gs[i];
      const sl = this.L.deskQ[k];
      a.x = sl.x; a.z = sl.z; a.yaw = PI; a.badge = false; a.area = 'leave';
      a.plan = [this._qStep(this.deskQ, 'desk'), this._fnStep((b) => { b.area = null; })];
      this.deskQ.members.push(a);
      a.queue = this.deskQ;
    }
    // a few are still outside, arriving over the next seconds
    for (let k = 0; k < 4 && i < gs.length; k++, i++) {
      const a = gs[i];
      a.hidden = true; a.badge = false; a.area = 'leave'; a.x = STREET.x; a.z = STREET.z;
      a.plan = [{ k: 'hide', t: 1 + k * 2.2 }, { k: 'appear' }, { k: 'go', x: STREET.x, z: 24.2 }, { k: 'waitq', q: this.deskQ },
        this._qStep(this.deskQ, 'desk'), this._fnStep((b) => { b.area = null; })];
    }
    // the rest walk the hallway
    for (; i < gs.length; i++) {
      const a = gs[i];
      for (let tries = 0; tries < 30; tries++) {
        const x = 2 + R() * 30, z = 10 + R() * 3.6;
        if (this.nav.clear(x, z, 0.25)) { a.x = x; a.z = z; break; }
      }
      a.yaw = snapYaw(R() - 0.5, R() - 0.5);
      a.plan = [{ k: 'wait', t: R() * 1.5 }];
    }
  }
  _seatAt(a, seat, area, t) {
    if (!seat) { a.x = 17; a.z = 11.5; a.plan = []; return; }
    seat.taken = a; a.seat = seat; a.area = area;
    a.x = seat.x; a.z = seat.z; a.yaw = seat.yaw; a.pose = 'sit';
    a.plan = [{ k: 'sit', seat, t, phase: 'sit', tt: 0 }, ...this._exitRoom(area)];
  }
  _standAt(a, spot, area, t) {
    spot.taken = a; a.spot = spot; a.area = area;
    a.x = spot.x; a.z = spot.z; a.yaw = spot.yaw;
    a.plan = [{ k: 'wait', t, yaw: spot.yaw, chat: area }, this._fnStep((b) => this._releaseSpot(b))];
  }

  // ------------------------------------------------------------------ public
  setMode(name) {
    if (name === this.mode) return;
    const prev = this.mode;
    this.mode = name;
    this.modeT = this.t;
    if (prev === 'clusters') this._leaveClusters();
    if (name === 'clusters') this._enterClusters();
    if (name === 'schedule') {
      // people in the hallway and lounge cut their chats short and head for rooms
      for (const a of this.guests()) {
        const c = a.cur;
        if (c && c.k === 'wait' && (a.area === 'hall' || a.area === 'lobby') && c.t > 2) c.t = 1 + this.rnd() * 2;
      }
    }
    this.deskQ.cap = name === 'host' ? 1 : 0;
    if (name === 'scan' || name === 'arrive' || name === 'lounge' || name === 'stage') this._nudge(name === 'scan' ? 8 : 5);
    if (name === 'host') {
      this.dialog = { next: this.t + 0.6, turn: 0 };
      // one attendee across the desk: the rest of the queue steps aside to the lobby
      for (const a of this.deskQ.members.slice(1)) { this._abort(a); this._planSpot(a, 'lobby', 6 + this.rnd() * 6); }
    }
  }
  // A live arrival: walks in from the street to the desk, gets a badge and a check, then joins the crowd.
  spawn(label) {
    const live = this.agents.filter((a) => a.spawned && !a.disabled);
    if (live.length >= 10) { const old = live[0]; this._abort(old); old.disabled = true; old.hidden = true; }
    const R = this.rnd;
    const w = this.sizes.map((k) => Math.max(0, k));
    let pick = R() * w.reduce((t, k) => t + k, 0), cluster = OTHER;
    for (let i = 0; i < w.length; i++) { if (pick < w[i]) { cluster = i; break; } pick -= w[i]; }
    if (cluster >= FOLD0) cluster = OTHER;
    const a = this._agent('guest', cluster);
    a.id = this.agents.length;
    Object.assign(a, { spawned: true, label, labelUntil: this.t + 45, badge: false, x: STREET.x, z: STREET.z, yaw: PI, area: 'leave' });
    const q = this.deskQ;
    a.plan = [
      { k: 'go', x: STREET.x, z: 24.2 },
      this._fnStep((b) => { if (!q.members.includes(b)) { q.members.splice(Math.min(1, q.members.length), 0, b); b.queue = q; } }),
      this._qStep(q, 'desk'),
      this._fnStep((b) => { b.area = null; }),
    ];
    this.agents.push(a);
    return a;
  }
  // a few people standing about wrap up soon, so the new shot's activity starts to fill quickly
  _nudge(n) {
    const R = this.rnd;
    for (const a of this.guests()) {
      if (n <= 0) break;
      const c = a.cur;
      if (c && c.k === 'wait' && c.t < 1e8 && a.area && !ROOMS.includes(a.area) && c.t - (c.tt || 0) > 2) { c.t = (c.tt || 0) + 0.3 + R() * 1.5; n--; }
    }
  }
  setActive(n) {
    const gs = this.agents.filter((a) => a.kind === 'guest' && !a.spawned);
    gs.forEach((a, i) => {
      if (i >= n && !a.disabled) { this._abort(a); a.disabled = true; a.hidden = true; }
    });
  }

  // ------------------------------------------------------------------ plan building
  _fnStep(f) { return { k: 'fn', f }; }
  _qStep(q, kind) { return { k: 'queue', q, kind, phase: 'join', serveT: 0 }; }
  _releaseSpot(a) { if (a.spot) { a.spot.taken = null; a.spot = null; } }
  _releaseSeat(a) { if (a.seat) { a.seat.taken = null; a.seat = null; } }
  _abort(a) {
    if (a.queue) { a.queue.remove(a); a.queue = null; }
    this._releaseSeat(a); this._releaseSpot(a);
    if (a.pose === 'sit') { a.pose = 'stand'; }
    a.plan = []; a.cur = null; a.area = null;
  }
  _exitRoom(room) {
    const d = this.L.doorById[room];
    const out = d.north ? { x: d.cx - 0.75, z: d.wz1 + 1.1 } : { x: d.cx - 0.6, z: d.wz0 - 1.4 };
    return [this._fnStep((a) => { a.area = null; }), { k: 'go', x: out.x, z: out.z }];
  }
  _target() {
    const T = { ...BASE_TARGET };
    if (this.roomFill) for (const k in this.roomFill) if (k in T) T[k] = BASE_TARGET[k] * (0.3 + 1.4 * this.roomFill[k]);
    const m = this.mode;
    if (m === 'arrive' || m === 'host') { T.leave = 0.16; T.lobby = 0.06; }
    if (m === 'schedule') { T.hall = 0.02; T.lobby = 0.02; for (const r of RECOMMENDED) T[r] += 0.05; T['room-b'] += 0.02; }
    if (m === 'scan') { T[FEATURED_DOOR] = 0.15; }
    if (m === 'stage') { T.keynote = 0.38; }
    if (m === 'lounge') { T.lounge = 0.17; T.bar = 0.05; }
    return T;
  }
  _choose(a) {
    const R = this.rnd;
    const gs = this.guests();
    const n = gs.length;
    const cnt = {};
    for (const g of gs) if (g.area) cnt[g.area] = (cnt[g.area] || 0) + 1;
    const T = this._target();
    let best = null, bs = -1e9;
    for (const k in T) {
      if (k === a.lastArea && k !== 'lounge') continue;
      const s = T[k] - (cnt[k] || 0) / n + R() * 0.04;
      if (s > bs) { bs = s; best = k; }
    }
    return best;
  }
  _plan(a) {
    const R = this.rnd;
    if (this.mode === 'clusters') { a.area = 'cluster'; this._sendToCluster(a, a.cluster >= FOLD0 && this.folded ? OTHER : a.cluster, 0); return; }
    const area = this._choose(a);
    a.lastArea = area;
    a.area = area;
    const m = this.mode;
    if (ROOMS.includes(area)) {
      const d = this.L.doorById[area];
      if (d.q.full()) return this._planSpot(a, 'hall', 2 + R() * 3);
      let stay = area === 'keynote' ? 25 + R() * 45 : 12 + R() * 22;
      if (m === 'scan' && area === FEATURED_DOOR) stay = 5 + R() * 6;
      if (m === 'schedule') stay = Math.min(stay, 10 + R() * 8);
      a.plan = [this._qStep(d.q, 'door'), this._fnStep((b) => this._afterScan(b, area, stay))];
      return;
    }
    if (area === 'leave') {
      a.plan = [
        { k: 'go', x: STREET.x + (R() - 0.5), z: STREET.z },
        { k: 'hide', t: 1.5 + R() * 4 },
        this._fnStep((b) => { b.badge = false; }),
        { k: 'appear' },
        { k: 'go', x: STREET.x, z: 24.2 },
        { k: 'waitq', q: this.deskQ },
        this._qStep(this.deskQ, 'desk'),
        this._fnStep((b) => { b.area = null; }),
      ];
      return;
    }
    if (area === 'bar') {
      const s = this.stands.bar.find((x) => !x.taken);
      if (!s) return this._planSpot(a, 'lounge', 8 + R() * 10);
      s.taken = a; a.spot = s;
      a.plan = [{ k: 'go', x: s.x, z: s.z }, { k: 'wait', t: 2.5 + R() * 2, yaw: s.yaw, serve: true },
        this._fnStep((b) => { this._releaseSpot(b); this.bubble(b, G.COFFEE, 1.4); })];
      return;
    }
    if (area === 'lounge' && R() < 0.25) {
      const s = this.seats.lounge.filter((x) => !x.taken && x.room === 'lounge');
      if (s.length) {
        const seat = s[Math.floor(R() * s.length)];
        seat.taken = a; a.seat = seat;
        a.plan = [{ k: 'go', x: seat.approach.x, z: seat.approach.z }, { k: 'sit', seat, t: 8 + R() * 12, phase: 'in', tt: 0 }];
        return;
      }
    }
    const stay = { lounge: 10 + R() * 14, hall: 5 + R() * 9, lobby: 5 + R() * 8, sponsor: 4 + R() * 6 }[area] || 6;
    this._planSpot(a, area, m === 'schedule' && area !== 'lounge' ? Math.min(stay, 3) : stay);
  }
  _planSpot(a, area, t) {
    const R = this.rnd;
    const list = this.stands[area] || this.stands.hall;
    let free = list.filter((s) => !s.taken);
    if (!free.length) {
      free = this.stands.hall.filter((s) => !s.taken);
      if (!free.length) { a.plan = [{ k: 'wait', t: 1 + R() * 2 }]; return; }
    }
    // prefer a spot whose partner is already there (pairs chat)
    const pairUp = free.filter((s) => { const i = list.indexOf(s); const p = list[i ^ 1]; return p && p.taken; });
    const pool = pairUp.length && R() < 0.75 ? pairUp : free;
    const s = pool[Math.floor(R() * pool.length)];
    s.taken = a; a.spot = s; a.area = area;
    a.plan = [{ k: 'go', x: s.x, z: s.z }, { k: 'wait', t, yaw: s.yaw, chat: area }, this._fnStep((b) => { this._releaseSpot(b); b.area = null; })];
  }
  _afterScan(a, room, stay) {
    const R = this.rnd;
    if (a.denied) {
      a.denied = false;
      a.area = null;
      const d = this.L.doorById[room];
      a.yaw = d.face + PI;
      const back = d.north ? { x: d.cx - 1.6 - R() * 2, z: 12.8 + R() * 0.8 } : { x: d.cx - 2.5, z: 11.5 };
      a.plan = [{ k: 'wait', t: 0.7, yaw: d.face + PI }, { k: 'go', x: back.x, z: back.z }, { k: 'wait', t: 1 + R() * 2 }];
      return;
    }
    const free = this.seats[room].filter((s) => !s.taken);
    if (free.length) {
      const seat = free[Math.floor(R() * free.length)];
      seat.taken = a; a.seat = seat;
      a.plan = [{ k: 'go', x: seat.approach.x, z: seat.approach.z }, { k: 'sit', seat, t: stay, phase: 'in', tt: 0 }, ...this._exitRoom(room)];
      return;
    }
    const st = this.stands[room].filter((s) => !s.taken);
    if (st.length) {
      const s = st[Math.floor(R() * st.length)];
      s.taken = a; a.spot = s;
      a.plan = [{ k: 'go', x: s.x, z: s.z }, { k: 'wait', t: stay, yaw: s.yaw }, this._fnStep((b) => this._releaseSpot(b)), ...this._exitRoom(room)];
      return;
    }
    a.plan = this._exitRoom(room);
  }

  // ------------------------------------------------------------------ clusters
  _clusterSlots() {
    if (this._cslots) return this._cslots;
    const need = this.L.clusterSpots.map(() => 0);
    for (const a of this.agents) if (a.kind === 'guest') need[a.cluster]++;
    for (let i = FOLD0; i < need.length; i++) need[OTHER] += need[i];
    for (let i = 0; i < need.length; i++) need[i] += 6; // room for live arrivals
    this._cslots = this.L.clusterSpots.map((c, ci) => {
      const out = [];
      for (let k = 0; out.length < need[ci] && k < 400; k++) {
        const r = 0.6 * Math.sqrt(k + 0.5), th = k * 2.39996;
        const x = c.x + Math.cos(th) * r * 1.15, z = c.z + Math.sin(th) * r * 0.85;
        if (this.nav.clear(x, z, 0.22)) out.push({ x, z, taken: null });
      }
      return out;
    });
    return this._cslots;
  }
  _sendToCluster(a, ci, delay) {
    const slots = this._clusterSlots()[ci];
    const s = slots.find((x) => !x.taken) || slots[0];
    if (s) s.taken = a;
    a.cslot = s;
    const c = this.L.clusterSpots[ci];
    const plan = [];
    if (a.hidden) plan.push({ k: 'appear' });
    plan.push({ k: 'wait', t: delay });
    plan.push(this._fnStep((b) => { b.tint = ci; }));
    if (s) plan.push({ k: 'go', x: s.x, z: s.z });
    plan.push({ k: 'wait', t: 1e9, yaw: s ? snapYaw(c.x - s.x, c.z - s.z) : 0, chat: 'cluster' });
    a.plan = plan; a.cur = null;
  }
  _enterClusters() {
    this.folded = false;
    this.foldCycle = 0;
    for (const sl of this._clusterSlots()) sl.forEach((s) => { s.taken = null; });
    const gs = this.guests();
    for (const a of gs) {
      if (a.spawned && !a.badge) continue; // a live arrival finishes at the desk first, then joins its group
      const wasSit = a.pose === 'sit' ? a.seat : null;
      this._abort(a);
      a.area = 'cluster';
      const delay = Math.floor(this.rnd() * 4) * 0.25;
      this._sendToCluster(a, a.cluster, delay);
      if (wasSit) a.plan.splice(a.hidden ? 1 : 0, 0, { k: 'go', x: wasSit.approach.x, z: wasSit.approach.z, slide: true });
    }
  }
  // a new cycle: the small groups split out of "other" again in their own colours
  _unfold() {
    this.folded = false;
    for (const a of this.guests()) {
      if (a.cluster < FOLD0 || (a.spawned && !a.badge)) continue;
      if (a.cslot) a.cslot.taken = null;
      this._sendToCluster(a, a.cluster, Math.floor(this.rnd() * 3) * 0.2);
    }
  }
  _fold() {
    this.folded = true;
    const slots = this._clusterSlots();
    for (const a of this.guests()) {
      if (a.cluster < FOLD0 || (a.spawned && !a.badge)) continue;
      if (a.cslot) a.cslot.taken = null;
      const s = slots[OTHER].find((x) => !x.taken);
      if (s) s.taken = a;
      a.cslot = s;
      const c = this.L.clusterSpots[OTHER];
      a.plan = [{ k: 'wait', t: 0.3 + Math.floor(this.rnd() * 3) * 0.25 }, this._fnStep((b) => { b.tint = OTHER; this.bubble(b, G.QUESTION, 1.0); })];
      if (s) a.plan.push({ k: 'go', x: s.x, z: s.z });
      a.plan.push({ k: 'wait', t: 1e9, yaw: s ? snapYaw(c.x - s.x, c.z - s.z) : 0 });
      a.cur = null;
    }
  }
  _leaveClusters() {
    for (const a of this.guests()) {
      if (a.spawned && !a.badge) continue;
      if (a.cslot) { a.cslot.taken = null; a.cslot = null; }
      a.tint = -1;
      a.plan = [{ k: 'wait', t: Math.floor(this.rnd() * 4) * 0.25 }];
      a.cur = null; a.area = null;
    }
  }

  // ------------------------------------------------------------------ bubbles
  bubble(a, glyph, dur = 1.6) {
    this.bubbles = this.bubbles.filter((b) => b.a !== a);
    if (this.bubbles.length >= 16) return;
    this.bubbles.push({ a, glyph, t0: this.t, dur });
    a.armUntil = this.t + Math.min(dur, 0.9);
  }

  // ------------------------------------------------------------------ simulation
  step(dt) {
    this.t += dt;
    const t = this.t;
    this.bubbles = this.bubbles.filter((b) => t - b.t0 < b.dur && !b.a.hidden);
    for (const a of this.agents) {
      if (a.disabled) continue;
      if (a.kind === 'guest') this._stepGuest(a, dt);
    }
    this._stepStaff(dt);
    if (this.mode === 'clusters') {
      const ct = t - this.modeT, cyc = Math.floor(ct / FOLD_PERIOD);
      if (cyc !== this.foldCycle) { this.foldCycle = cyc; this._unfold(); }
      if (!this.folded && ct - cyc * FOLD_PERIOD > FOLD_AT) this._fold();
    }
    for (const id in this.lamps) { const l = this.lamps[id]; if (l.state !== 'idle' && t > l.until) l.state = 'idle'; }
  }
  _stepGuest(a, dt) {
    let guard = 0;
    while (guard++ < 6) {
      if (!a.cur) {
        if (!a.plan.length) this._plan(a);
        a.cur = a.plan.shift();
        if (!a.cur) return;
      }
      const done = this._run(a, a.cur, dt);
      if (!done) return;
      a.cur = null;
      dt = 0;
    }
  }
  _move(a, tx, tz, dist) {
    const dx = tx - a.x, dz = tz - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return { arrived: true, left: dist };
    a.yaw = snapYaw(dx, dz);
    if (d <= dist) { a.x = tx; a.z = tz; return { arrived: true, left: dist - d }; }
    a.x += (dx / d) * dist; a.z += (dz / d) * dist;
    return { arrived: false, left: 0 };
  }
  _walk(a, dt) { a.pose = 'walk'; a.walkT += dt; }
  _run(a, s, dt) {
    const R = this.rnd;
    switch (s.k) {
      case 'fn': s.f(a); return true;
      case 'go': {
        if (!s.path) {
          s.path = s.slide ? [{ x: a.x, z: a.z }, { x: s.x, z: s.z }] : (this.nav.path(a.x, a.z, s.x, s.z) || [{ x: a.x, z: a.z }, { x: s.x, z: s.z }]);
          s.i = 1;
          if (a.pose === 'sit') a.pose = 'stand';
        }
        if (dt === 0) return false;
        let left = a.speed * dt * (this.mode === 'clusters' ? 1.5 : 1);
        while (left > 0 && s.i < s.path.length) {
          const p = s.path[s.i];
          const r = this._move(a, p.x, p.z, left);
          left = r.left;
          if (r.arrived) s.i++;
        }
        this._walk(a, dt);
        if (s.i >= s.path.length) { a.pose = 'stand'; return true; }
        return false;
      }
      case 'wait': {
        a.pose = 'stand';
        if (s.yaw !== undefined) a.yaw = s.yaw;
        s.tt = (s.tt || 0) + dt;
        if (s.chat) this._chat(a, s.chat);
        if (s.serve && !s.served && s.tt > 1.2) { s.served = true; this.barista.armUntil = this.t + 0.8; }
        return s.tt >= s.t;
      }
      case 'hide': a.hidden = true; s.tt = (s.tt || 0) + dt; return s.tt >= s.t;
      case 'appear': a.hidden = false; a.x = STREET.x + (R() - 0.5) * 0.8; a.z = STREET.z; a.yaw = PI; return true;
      case 'waitq': { // wait outside until there is room in the desk queue
        a.pose = 'stand';
        return !s.q.full();
      }
      case 'sit': {
        const seat = s.seat;
        if (s.phase === 'in') {
          const r = this._move(a, seat.x, seat.z, a.speed * dt * 0.6);
          this._walk(a, dt);
          if (r.arrived) { s.phase = 'sit'; a.pose = 'sit'; a.yaw = seat.yaw; }
          return false;
        }
        if (s.phase === 'sit') {
          a.pose = 'sit'; a.yaw = seat.yaw;
          s.tt += dt;
          if (seat.room === 'lounge' || seat.room === 'lobby') this._chat(a, 'lounge');
          if (s.tt >= s.t) s.phase = 'out';
          return false;
        }
        const r = this._move(a, seat.approach.x, seat.approach.z, a.speed * dt * 0.6);
        this._walk(a, dt);
        if (r.arrived) { a.pose = 'stand'; this._releaseSeat(a); return true; }
        return false;
      }
      case 'queue': return this._runQueue(a, s, dt);
      default: return true;
    }
  }
  _runQueue(a, s, dt) {
    const q = s.q;
    if (s.phase === 'join') {
      if (!q.members.includes(a)) {
        if (q.full()) { // give up, wander
          a.area = null; a.plan = [{ k: 'wait', t: 0.5 }];
          return true;
        }
        q.members.push(a); a.queue = q;
      }
      const idx = q.members.indexOf(a);
      const sl = q.slots[Math.min(idx, q.slots.length - 1)];
      if (!s.path) { s.path = this.nav.path(a.x, a.z, sl.x, sl.z) || [{ x: a.x, z: a.z }, { x: sl.x, z: sl.z }]; s.i = 1; }
      let left = a.speed * dt;
      while (left > 0 && s.i < s.path.length) {
        const p = s.path[s.i];
        const r = this._move(a, p.x, p.z, left);
        left = r.left;
        if (r.arrived) s.i++;
      }
      this._walk(a, dt);
      if (s.i >= s.path.length) s.phase = 'line';
      return false;
    }
    const idx = q.members.indexOf(a);
    if (idx < 0) return true;
    const sl = q.slots[Math.min(idx, q.slots.length - 1)];
    const r = this._move(a, sl.x, sl.z, a.speed * dt * 0.8);
    if (!r.arrived) { this._walk(a, dt); return false; }
    a.pose = 'stand';
    a.yaw = q.faces[Math.min(idx, q.faces.length - 1)];
    if (idx !== 0) return false;
    s.serveT += dt;
    if (s.kind === 'door') {
      const d = this.L.doors.find((x) => x.q === q);
      const lamp = this.lamps[d.id];
      if (s.serveT < q.serveTime) {
        if (s.serveT > 0.25 && lamp.state === 'idle') { lamp.state = 'scan'; lamp.until = this.t + 0.6; a.armUntil = this.t + 0.5; }
        return false;
      }
      q.members.shift(); a.queue = null;
      this.scanCount++;
      let deny = this.rnd() < this.denyShare;
      if (d.id === FEATURED_DOOR) {
        d.scans = (d.scans || 0) + 1;
        if (this.mode === 'scan') deny = Math.floor(d.scans * this.featuredDeny) > Math.floor((d.scans - 1) * this.featuredDeny);
      }
      if (!a.badge) deny = true;
      a.denied = deny;
      lamp.state = deny ? 'deny' : 'ok';
      lamp.until = this.t + 1.0;
      this.bubble(a, deny ? G.CROSS : G.CHECK, deny ? 1.9 : 1.3);
      return true;
    }
    // registration desk
    // the chat at the desk holds while the host shot is current (unless a live arrival is waiting behind)
    if (this.mode === 'host' && !a.spawned && !q.members.some((m) => m.spawned)) return false;
    if (s.serveT > 0.5 && !s.qr) { s.qr = true; this.bubble(a, G.QR, 1.0); }
    if (s.serveT > 1.5 && !s.hb) { s.hb = true; this.host.armUntil = this.t + 0.8; }
    if (s.serveT < q.serveTime) return false;
    q.members.shift(); a.queue = null;
    a.badge = true;
    this.bubble(a, G.CHECK, 1.5);
    if (a.spawned) a.labelUntil = this.t + 4.5;
    return true;
  }
  _chat(a, kind) {
    const t = this.t;
    if (t < a.nextChat) return;
    const R = this.rnd;
    const busy = this.mode === kind || (this.mode === 'lounge' && kind === 'lounge');
    a.nextChat = t + (busy ? 2 + R() * 3 : 4 + R() * 7);
    if (kind === 'cluster') { if (R() < 0.12) this.bubble(a, [G.STAR, G.HEART, G.DOTS][Math.floor(R() * 3)], 1.2); return; }
    // only chat when someone stands at the partner spot
    const list = this.stands[a.area] || [];
    const i = list.indexOf(a.spot);
    const partner = i >= 0 ? list[i ^ 1] : null;
    const seated = a.seat && (a.seat.room === 'lounge' || a.seat.room === 'lobby');
    if (!seated && !(partner && partner.taken && partner.taken.cur && partner.taken.cur.k === 'wait')) return;
    if (R() < 0.35) return;
    const set = kind === 'lounge' ? [G.COFFEE, G.HEART, G.STAR, G.DOTS, G.EXCL, G.COFFEE] : kind === 'sponsor' ? [G.STAR, G.QUESTION] : [G.DOTS, G.QUESTION, G.EXCL, G.STAR];
    this.bubble(a, set[Math.floor(R() * set.length)], 1.5);
  }
  _stepStaff(dt) {
    const t = this.t;
    const R = this.rnd;
    // host: faces the queue; in the host shot she and the attendee across the desk take turns talking
    const h = this.host;
    h.pose = 'stand'; h.yaw = 0;
    if (this.mode === 'host') {
      const front = this.deskQ.members[0];
      const fs = front && front.cur && front.cur.k === 'queue' && front.cur.phase === 'line' ? front : null;
      if (fs && Math.hypot(fs.x - this.L.deskQ[0].x, fs.z - this.L.deskQ[0].z) < 0.05 && t >= this.dialog.next) {
        const script = [[h, G.QUESTION], [fs, G.DOTS], [h, G.QR], [fs, G.EXCL], [h, G.STAR], [fs, G.HEART], [h, G.CHECK], [fs, G.DOTS]];
        const [who, g] = script[this.dialog.turn % script.length];
        this.bubble(who, g, 1.35);
        this.dialog.turn++;
        this.dialog.next = t + 1.6;
      }
    }
    // speaker paces the stage, stepping, and gestures
    const sp = this.speaker;
    const S = this.L.speaker;
    if (!sp.goal || Math.abs(sp.x - sp.goal) < 0.01) {
      if (!sp.pauseUntil) sp.pauseUntil = t + 2 + R() * 3;
      sp.pose = 'stand'; sp.yaw = 0;
      if (t > sp.pauseUntil) { sp.pauseUntil = 0; sp.goal = S.x0 + R() * (S.x1 - S.x0); }
      if (R() < dt * 0.5) sp.armUntil = t + 0.8;
      if (this.mode === 'stage' && R() < dt * 0.25) this.bubble(sp, R() < 0.5 ? G.EXCL : G.STAR, 1.3);
    } else {
      const dir = Math.sign(sp.goal - sp.x);
      const nx = sp.x + dir * 0.9 * dt;
      sp.x = (dir > 0 ? Math.min(nx, sp.goal) : Math.max(nx, sp.goal));
      sp.yaw = dir > 0 ? PI / 2 : -PI / 2;
      sp.pose = 'walk'; sp.walkT += dt;
    }
    const ba = this.barista;
    ba.pose = 'stand'; ba.yaw = PI;
  }
}
