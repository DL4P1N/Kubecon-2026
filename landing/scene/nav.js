// Grid pathfinding (A* + line-of-sight smoothing) on the 0.5 unit venue grid.
import { GRID, NX, NZ, VW, VD, APRON } from './layout.js';

export class Nav {
  constructor(layout) {
    this.b = new Uint8Array(NX * NZ).fill(1);
    this.open(0, 0, VW, VD);
    this.open(APRON.x0, APRON.z0 - 0.5, APRON.x1, APRON.z1);
    for (const o of layout.walls) if (o.block) this.block(o.x0, o.z0, o.x1, o.z1);
    for (const o of layout.boxes) if (o.block) this.block(o.x0, o.z0, o.x1, o.z1);
    for (const o of layout.navBlocks) this.block(o.x0, o.z0, o.x1, o.z1);
    this.g = new Float32Array(NX * NZ);
    this.from = new Int32Array(NX * NZ);
    this.closed = new Uint8Array(NX * NZ);
  }
  _rng(x0, z0, x1, z1) {
    const e = 1e-6;
    return [
      Math.max(0, Math.floor(x0 / GRID + e)), Math.max(0, Math.floor(z0 / GRID + e)),
      Math.min(NX - 1, Math.ceil(x1 / GRID - e) - 1), Math.min(NZ - 1, Math.ceil(z1 / GRID - e) - 1),
    ];
  }
  open(x0, z0, x1, z1) { this._fill(x0, z0, x1, z1, 0); }
  block(x0, z0, x1, z1) { this._fill(x0, z0, x1, z1, 1); }
  _fill(x0, z0, x1, z1, v) {
    const [i0, j0, i1, j1] = this._rng(x0, z0, x1, z1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.b[j * NX + i] = v;
  }
  blockedAt(x, z) {
    const i = Math.floor(x / GRID), j = Math.floor(z / GRID);
    if (i < 0 || j < 0 || i >= NX || j >= NZ) return true;
    return this.b[j * NX + i] === 1;
  }
  clear(x, z, r) {
    return !(this.blockedAt(x, z) || this.blockedAt(x - r, z - r) || this.blockedAt(x + r, z - r) ||
      this.blockedAt(x - r, z + r) || this.blockedAt(x + r, z + r));
  }
  los(x0, z0, x1, z1, r = 0.18) {
    const dx = x1 - x0, dz = z1 - z0;
    const n = Math.ceil(Math.hypot(dx, dz) / 0.12);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (!this.clear(x0 + dx * t, z0 + dz * t, r)) return false;
    }
    return true;
  }
  nearestFree(x, z) {
    let ci = Math.floor(x / GRID), cj = Math.floor(z / GRID);
    ci = Math.min(NX - 1, Math.max(0, ci)); cj = Math.min(NZ - 1, Math.max(0, cj));
    if (this.b[cj * NX + ci] === 0) return [ci, cj];
    for (let r = 1; r < 8; r++) {
      let best = null, bd = 1e9;
      for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || j < 0 || i >= NX || j >= NZ) continue;
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        if (this.b[j * NX + i] === 1) continue;
        const d = Math.hypot((i + 0.5) * GRID - x, (j + 0.5) * GRID - z);
        if (d < bd) { bd = d; best = [i, j]; }
      }
      if (best) return best;
    }
    return null;
  }
  path(sx, sz, gx, gz) {
    const s = this.nearestFree(sx, sz), g = this.nearestFree(gx, gz);
    if (!s || !g) return null;
    const N = NX * NZ;
    const gs = this.g, from = this.from, closed = this.closed;
    gs.fill(1e9); closed.fill(0);
    const si = s[1] * NX + s[0], gi = g[1] * NX + g[0];
    const hx = g[0], hz = g[1];
    const h = (i) => {
      const dx = Math.abs((i % NX) - hx), dz = Math.abs(((i / NX) | 0) - hz);
      return (dx + dz) + (1.4142 - 2) * Math.min(dx, dz);
    };
    // binary heap of [f, idx]
    const heap = [];
    const push = (f, i) => {
      heap.push([f, i]);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]]; k = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last; let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1; let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
        }
      }
      return top;
    };
    gs[si] = 0; from[si] = -1; push(h(si), si);
    const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    let found = false;
    while (heap.length) {
      const [, cur] = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === gi) { found = true; break; }
      const ci = cur % NX, cj = (cur / NX) | 0;
      for (const [di, dj, c] of D) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
        const nidx = nj * NX + ni;
        if (this.b[nidx] === 1 || closed[nidx]) continue;
        if (di !== 0 && dj !== 0 && (this.b[cj * NX + ni] === 1 || this.b[nj * NX + ci] === 1)) continue;
        const ng = gs[cur] + c;
        if (ng < gs[nidx]) { gs[nidx] = ng; from[nidx] = cur; push(ng + h(nidx), nidx); }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let c = gi; c !== -1; c = from[c]) cells.push(c);
    cells.reverse();
    const pts = [{ x: sx, z: sz }];
    for (let k = 1; k < cells.length; k++) {
      const c = cells[k];
      pts.push({ x: ((c % NX) + 0.5) * GRID, z: (((c / NX) | 0) + 0.5) * GRID });
    }
    pts.push({ x: gx, z: gz });
    // smooth by line-of-sight
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.los(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}
