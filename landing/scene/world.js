// Static venue geometry (plinth, floor with baked blocky shadows, props, walls) and the stepped-tone voxel material.
import * as THREE from '../vendor/three.module.min.js';
import { GRID, NX, NZ, VW, VD, APRON, HALL } from './layout.js';

const VERT = /* glsl */ `
uniform vec3 uDark;
uniform vec3 uMixCol;
uniform float uMix;
uniform vec3 uTones;
uniform vec2 uLight;
varying vec3 vCol;
varying vec2 vW;
void main(){
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    n = mat3(instanceMatrix) * n;
  #endif
  vec4 wp = modelMatrix * p;
  vec3 wn = normalize(mat3(modelMatrix) * n);
  float tone;
  if (wn.y > 0.5) tone = 1.0;
  else if (wn.y < -0.5) tone = uTones.z;
  else tone = dot(wn.xz, uLight) > 0.0 ? uTones.x : uTones.y;
  vec3 c = vec3(1.0);
  #ifdef USE_COLOR
    c = color.rgb;
  #endif
  #ifdef USE_INSTANCING_COLOR
    c = instanceColor;
  #endif
  c = mix(c, uMixCol, uMix);
  vCol = mix(uDark, c, tone);
  vW = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FRAG = /* glsl */ `
uniform vec4 uClip;
varying vec3 vCol;
varying vec2 vW;
void main(){
  if (vW.x < uClip.x || vW.x > uClip.z || vW.y < uClip.y || vW.y > uClip.w) discard;
  gl_FragColor = vec4(vCol, 1.0);
}`;

// The diorama cut: everything outside this world-space rectangle (x0, z0, x1, z1) is not drawn. Shared by all
// voxel materials; set per frame from the shot blend.
export const CLIP = { value: new THREE.Vector4(-99, -99, 999, 999) };
const NOCLIP = { value: new THREE.Vector4(-999, -999, 9999, 9999) };

export function makeVoxelMaterial(theme, vertexColors = true, clip = CLIP) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    vertexColors,
    side: THREE.DoubleSide,
    uniforms: {
      uClip: clip,
      uDark: { value: new THREE.Color().fromArray(theme.dark) },
      uMixCol: { value: new THREE.Color().fromArray(theme.ink) },
      uMix: { value: 0 },
      uTones: { value: new THREE.Vector3(0.8, 0.6, 0.45) },
      // light comes from the north-west: faces pointing west/north get the brighter side tone
      uLight: { value: new THREE.Vector2(-0.8, -0.6).normalize() },
    },
  });
}

class Builder {
  constructor() { this.pos = []; this.nor = []; this.col = []; }
  quad(p0, p1, p2, p3, n, c) {
    for (const p of [p0, p1, p2, p0, p2, p3]) { this.pos.push(p[0], p[1], p[2]); this.nor.push(n[0], n[1], n[2]); this.col.push(c[0], c[1], c[2]); }
  }
  box(x0, y0, z0, x1, y1, z1, c, top = c, faces = 'all') {
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], top);
    if (y1 - y0 < 0.03 && faces === 'all') return; // floor decals: top only
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], c);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], c);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], c);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], c);
  }
  top(x0, z0, x1, z1, y, c) { this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], c); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function buildWorld(layout, theme) {
  const group = new THREE.Group();
  const K = theme.k;
  const col = (k) => K[k] || theme.wall;

  // ---- height map for baked shadows (light from the north-west, shadows fall south-east)
  const hmap = new Float32Array(NX * NZ);
  const stamp = (o) => {
    const e = 1e-6;
    const i0 = Math.floor(o.x0 / GRID + e), i1 = Math.ceil(o.x1 / GRID - e) - 1;
    const j0 = Math.floor(o.z0 / GRID + e), j1 = Math.ceil(o.z1 / GRID - e) - 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (i >= 0 && j >= 0 && i < NX && j < NZ) hmap[j * NX + i] = Math.max(hmap[j * NX + i], o.y1);
  };
  layout.walls.forEach((o) => { if (o.block) stamp(o); });
  layout.boxes.forEach((o) => { if (o.y1 - o.y0 > 0.3 && o.y0 < 0.5) stamp(o); });
  const H = (x, z) => {
    const i = Math.floor(x / GRID), j = Math.floor(z / GRID);
    return i < 0 || j < 0 || i >= NX || j >= NZ ? 0 : hmap[j * NX + i];
  };
  const shadowed = (x, z) => {
    if (H(x, z) > 0.05) return false;
    for (let s = 0.25; s <= 1.5; s += 0.25) if (H(x - 0.55 * s, z - 0.75 * s) >= s * 0.9) return true;
    return false;
  };

  const zone = (x, z) => {
    const F = theme.floors;
    if (z >= VD) return x >= APRON.x0 && x <= APRON.x1 ? F.apron : null;
    if (x < 0 || x > VW || z < 0) return null;
    if (z < HALL.z0 - 0.2) {
      if (x < 16.2) return F.keynote;
      return (x < 22.7 || x > 28.7) ? F.room : F.room2;
    }
    if (z < HALL.z1) return F.hall;
    if (x > 26.2) return F.room2;
    if (x > 13) return F.lounge;
    if (x > 4.6 && x < 6.2 && z > 18.2) return F.mat; // queue lane
    return F.lobby;
  };

  // ---- floor: 0.5 cells, 1-unit tile checker, baked shadow tone
  const fb = new Builder();
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const x0 = i * GRID, z0 = j * GRID;
    let c = zone(x0 + 0.25, z0 + 0.25);
    if (!c) continue;
    if ((Math.floor(x0) + Math.floor(z0)) & 1) c = mixc(c, theme.dark, 0.05);
    if (shadowed(x0 + 0.25, z0 + 0.25)) c = mixc(c, theme.dark, 0.42);
    fb.top(x0, z0, x0 + GRID, z0 + GRID, 0, c);
  }
  // ---- plinth: the slab the venue is cut from; a unit box rescaled to the cut each frame (main floor + apron)
  const pb = new Builder();
  pb.box(0, -1, 0, 1, 0, 1, col('plinthEdge'), col('plinth'));

  // ---- props (merged)
  const prb = new Builder();
  for (const o of layout.boxes) prb.box(o.x0, o.y0, o.z0, o.x1, o.y1, o.z1, col(o.c), o.c === 'wall' ? K.wallTop : col(o.c));

  // ---- walls (merged; scaled in y and tinted to outlines for the clusters shot)
  const wb = new Builder();
  for (const o of layout.walls) wb.box(o.x0, o.y0, o.z0, o.x1, o.y1, o.z1, col(o.c), o.c === 'wall' ? K.wallTop : col(o.c));

  const mats = [];
  const mk = (b) => { const m = makeVoxelMaterial(theme); mats.push(m); const mesh = new THREE.Mesh(b.geometry(), m); mesh.frustumCulled = false; group.add(mesh); return mesh; };
  const plinthMat = makeVoxelMaterial(theme, true, NOCLIP);
  mats.push(plinthMat);
  const pgeo = pb.geometry();
  const slabs = [
    { r: [-0.15, -0.15, VW + 0.15, VD + 0.15] },
    { r: [APRON.x0, VD, APRON.x1, APRON.z1] },
  ].map((sl) => { sl.mesh = new THREE.Mesh(pgeo, plinthMat); sl.mesh.frustumCulled = false; group.add(sl.mesh); return sl; });
  const plinthMesh = { geometry: pgeo };
  const floorMesh = mk(fb);
  const propMesh = mk(prb);
  const wallMesh = mk(wb);

  return {
    group,
    setCut(c) {
      CLIP.value.set(c[0], c[1], c[2], c[3]);
      for (const sl of slabs) {
        const x0 = Math.max(sl.r[0], c[0] - 0.001), z0 = Math.max(sl.r[1], c[1] - 0.001);
        const x1 = Math.min(sl.r[2], c[2] + 0.001), z1 = Math.min(sl.r[3], c[3] + 0.001);
        sl.mesh.visible = x1 > x0 && z1 > z0;
        sl.mesh.position.set(x0, -0.002, z0);
        sl.mesh.scale.set(Math.max(1e-3, x1 - x0), 1.1, Math.max(1e-3, z1 - z0));
      }
    },
    setWallK(k) {
      wallMesh.scale.y = Math.max(0.03, k);
      wallMesh.material.uniforms.uMix.value = (1 - k) * 0.7;
    },
    dispose() {
      for (const m of [plinthMesh, floorMesh, propMesh, wallMesh]) m.geometry.dispose();
      mats.forEach((m) => m.dispose());
    },
  };
}

// Live boxes: scanner lamps, screen pixels, recommended markers, espresso light. One instanced draw.
export class Fx {
  constructor(layout, theme) {
    this.theme = theme;
    this.items = [];
    const add = (x0, y0, z0, x1, y1, z1, key) => { const it = { x0, y0, z0, x1, y1, z1, key, color: null, show: true }; this.items.push(it); return it; };
    this.lamps = {};
    this.tiles = {};
    for (const d of layout.doors) {
      this.lamps[d.id] = add(d.lamp.x - 0.18, d.lamp.y0, d.lamp.z - 0.18, d.lamp.x + 0.18, d.lamp.y1, d.lamp.z + 0.18, 'lamp');
      this.tiles[d.id] = add(d.tile.x0, 0.004, d.tile.z0, d.tile.x1, 0.02, d.tile.z1, 'tile');
    }
    this.screens = layout.fx.screens.map((s) => {
      const cells = [];
      const cw = (s.x1 - s.x0) / s.cols, ch = (s.y1 - s.y0) / s.rows;
      for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) {
        cells.push(add(s.x0 + c * cw + 0.02, s.y1 - (r + 1) * ch + 0.02, s.z - 0.01, s.x0 + (c + 1) * cw - 0.02, s.y1 - r * ch - 0.02, s.z + 0.01, 'px'));
      }
      return { ...s, cells };
    });
    this.markers = layout.fx.markers.map((m) => {
      const parts = [
        add(m.x - 0.15, 0.005, m.z - 0.75, m.x + 0.15, 0.03, m.z + 0.35, 'mk'),   // arrow shaft (points north, into the room)
        add(m.x - 0.45, 0.005, m.z - 0.75, m.x + 0.45, 0.03, m.z - 0.55, 'mk'),   // arrow head wide row
        add(m.x - 0.3, 0.005, m.z - 0.95, m.x + 0.3, 0.03, m.z - 0.75, 'mk'),
        add(m.x - 0.18, m.pinY, (m.z - 1.9) - 0.18, m.x + 0.18, m.pinY + 0.36, (m.z - 1.9) + 0.18, 'mk'), // pin over the door
        add(m.x - 0.08, m.pinY - 0.18, (m.z - 1.9) - 0.08, m.x + 0.08, m.pinY, (m.z - 1.9) + 0.08, 'mk'),
      ];
      return { ...m, parts };
    });
    // guided navigation: a pool of floor dots for the route, and a ring (4 thin boxes) per Bluetooth receiver
    this.dots = [];
    for (let i = 0; i < 140; i++) { const d = add(0, 0, 0, 0, 0, 0, 'dot'); d.show = false; this.dots.push(d); }
    this.rings = (layout.receivers || []).map((b) => ({ b, parts: [0, 1, 2, 3].map(() => { const r = add(0, 0, 0, 0, 0, 0, 'ring'); r.show = false; return r; }) }));
    const mc = layout.fx.machine;
    this.machine = add(mc.x - 0.12, mc.y - 0.06, mc.z - 0.03, mc.x + 0.12, mc.y + 0.06, mc.z, 'lamp');
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0.5, 0.5, 0.5);
    this.mesh = new THREE.InstancedMesh(geo, makeVoxelMaterial(theme, false), this.items.length);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.Color();
    this.m4 = new THREE.Matrix4();
    for (let i = 0; i < this.items.length; i++) this.mesh.setColorAt(i, this.color.setRGB(0, 0, 0));
    this.dirty = true;
  }
  set(it, color, show = true) {
    if (it.color !== color || it.show !== show) { it.color = color; it.show = show; this.dirty = true; }
  }
  place(it, x0, y0, z0, x1, y1, z1, color, show = true) {
    if (it.show === show && it.color === color && it.x0 === x0 && it.z0 === z0 && it.x1 === x1 && it.z1 === z1 && it.y0 === y0 && it.y1 === y1) return;
    Object.assign(it, { x0, y0, z0, x1, y1, z1, color, show });
    this.dirty = true;
  }
  flush() {
    if (!this.dirty) return false;
    let n = 0;
    for (const it of this.items) {
      if (!it.show || !it.color) continue;
      this.m4.makeScale(it.x1 - it.x0, it.y1 - it.y0, it.z1 - it.z0).setPosition(it.x0, it.y0, it.z0);
      this.mesh.setMatrixAt(n, this.m4);
      this.mesh.setColorAt(n, this.color.setRGB(it.color[0], it.color[1], it.color[2]));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.dirty = false;
    return true;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose?.(); }
}
