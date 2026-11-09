// Voxel people: every body part of every person is one instance of a unit cube (one draw call for the whole crowd).
// Hair mass, face with eye voxels, shirt and arms, hands, legs, white shoes, a lanyard badge once registered,
// a blob shadow. Walk cycle: 4 leg/arm poses stepped at 8 fps while the position moves smoothly.
import * as THREE from '../vendor/three.module.min.js';
import { makeVoxelMaterial } from './world.js';
import { OTHER } from './crowd.js';

const PARTS_PER = 24;
const SWING = [0.5, 0, -0.5, 0];

export class People {
  constructor(theme, max) {
    this.theme = theme;
    this.max = max;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.InstancedMesh(geo, makeVoxelMaterial(theme, false), max * PARTS_PER);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, new THREE.Color(0, 0, 0));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.M = this.mesh.instanceMatrix.array;
    this.C = this.mesh.instanceColor.array;
    const T = theme;
    this.shadowCol = [T.dark[0], T.dark[1], T.dark[2]];
    this.eye = T.bubbleInk;
    this.badgeCol = [0.98, 0.97, 0.92];
  }
  _shade(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
  // write one part: body frame (pos, yaw), pivot + pitch, relative centre, size, colour
  _part(px, py, pz, cy, sy, pvx, pvy, pvz, pitch, rx, ry, rz, w, h, d, col) {
    const n = this.n++;
    const ca = Math.cos(pitch), sa = Math.sin(pitch);
    // local centre after the pitch about the pivot
    const lx = pvx + rx;
    const ly = pvy + ry * ca - rz * sa;
    const lz = pvz + ry * sa + rz * ca;
    // yaw
    const wx = px + lx * cy + lz * sy;
    const wz = pz - lx * sy + lz * cy;
    const wy = py + ly;
    const o = n * 16;
    const M = this.M;
    M[o] = cy * w; M[o + 1] = 0; M[o + 2] = -sy * w; M[o + 3] = 0;
    M[o + 4] = sa * sy * h; M[o + 5] = ca * h; M[o + 6] = sa * cy * h; M[o + 7] = 0;
    M[o + 8] = ca * sy * d; M[o + 9] = -sa * d; M[o + 10] = ca * cy * d; M[o + 11] = 0;
    M[o + 12] = wx; M[o + 13] = wy; M[o + 14] = wz; M[o + 15] = 1;
    const c3 = n * 3;
    this.C[c3] = col[0]; this.C[c3 + 1] = col[1]; this.C[c3 + 2] = col[2];
  }
  update(crowd, cut) {
    const T = this.theme;
    this.n = 0;
    const tnow = crowd.t;
    for (const a of crowd.agents) {
      if (a.hidden || a.disabled) continue;
      if (cut && (a.x < cut[0] || a.x > cut[2] || a.z < cut[1] || a.z > cut[3])) continue;
      if (this.n + PARTS_PER > this.max * PARTS_PER) break;
      const L = a.look;
      const skin = T.skins[L.skin];
      let hair = T.hairs[L.hair];
      let shirt, pants, shoe = T.shoes[L.shoes];
      if (a.kind === 'host' || a.kind === 'barista') { shirt = T.staffShirt; pants = T.pants[0]; }
      else shirt = T.shirts[L.shirt] || T.shirts[0];
      pants = pants || T.pants[L.pants];
      if (a.tint >= 0) {
        const h = a.tint === OTHER ? T.grey : a.tint > OTHER ? T.fold[(a.tint - OTHER - 1) % T.fold.length] : T.cluster[a.tint];
        shirt = h; pants = this._shade(h, 0.62); shoe = this._shade(h, 0.85); hair = this._shade(h, 0.8);
      }
      const yaw = a.yaw;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const sit = a.pose === 'sit';
      const walking = a.pose === 'walk';
      const frame = walking ? Math.floor(a.walkT * 8) & 3 : 1;
      const sw = walking ? SWING[frame] : 0;
      const tall = 1 + L.tall * 0.05;
      const px = a.x, pz = a.z;
      const py = a.y + (sit ? -0.24 : 0);
      const hipY = 0.74 * tall;
      // shadow (not lowered when seated)
      this._part(px, a.y + 0.012, pz, cy, sy, 0, 0, 0, 0, 0, 0, sit ? 0.15 : 0, 0.66, 0.02, sit ? 0.8 : 0.5, this.shadowCol);
      // legs + shoes
      const legLen = 0.62 * tall;
      for (const side of [-1, 1]) {
        const pitch = sit ? -PI2 : sw * side;
        this._part(px, py, pz, cy, sy, side * 0.12, hipY, 0, pitch, 0, -legLen / 2, 0, 0.19, legLen, 0.21, pants);
        this._part(px, py, pz, cy, sy, side * 0.12, hipY, 0, pitch, 0, -legLen - 0.05, 0.05, 0.2, 0.12, 0.31, shoe);
      }
      // torso
      const tY = hipY + 0.3;
      this._part(px, py, pz, cy, sy, 0, tY, 0, 0, 0, 0, 0, 0.52, 0.6, 0.3, shirt);
      // arms + hands (an arm goes up while the person talks)
      const talk = tnow < a.armUntil;
      for (const side of [-1, 1]) {
        let pitch = walking ? -sw * side * 0.8 : 0;
        if (sit) pitch = -0.5;
        if (talk && side === 1) pitch = a.kind === 'guest' || a.kind === 'host' ? -1.9 : -1.3;
        this._part(px, py, pz, cy, sy, side * 0.33, tY + 0.26, 0, pitch, 0, -0.24, 0, 0.14, 0.52, 0.2, shirt);
        this._part(px, py, pz, cy, sy, side * 0.33, tY + 0.26, 0, pitch, 0, -0.56, 0, 0.13, 0.13, 0.16, skin);
      }
      // badge on a lanyard
      if (a.badge) {
        this._part(px, py, pz, cy, sy, 0, tY, 0, 0, 0.02, -0.05, 0.155, 0.15, 0.17, 0.03, this.badgeCol);
        this._part(px, py, pz, cy, sy, 0, tY, 0, 0, 0.02, 0.15, 0.155, 0.05, 0.22, 0.02, T.accent);
      }
      // guided person: a lime diamond marker floating over the head
      if (a.kind === 'guide') {
        const mY = tY + 1.2;
        this._part(px, py, pz, cy, sy, 0, mY, 0, 0, 0, 0, 0, 0.3, 0.3, 0.3, T.accent);
        this._part(px, py, pz, cy, sy, 0, mY - 0.24, 0, 0, 0, 0, 0, 0.14, 0.18, 0.14, T.accent);
      }
      // head
      const hY = tY + 0.3 + 0.22;
      this._part(px, py, pz, cy, sy, 0, hY, 0, 0, 0, 0, 0, 0.44, 0.42, 0.42, skin);
      // eyes (or glasses)
      if (L.glasses) {
        for (const side of [-1, 1]) this._part(px, py, pz, cy, sy, 0, hY, 0, 0, side * 0.11, 0.01, 0.215, 0.11, 0.1, 0.03, this.eye);
        this._part(px, py, pz, cy, sy, 0, hY, 0, 0, 0, 0.04, 0.215, 0.12, 0.03, 0.03, this.eye);
      } else for (const side of [-1, 1]) this._part(px, py, pz, cy, sy, 0, hY, 0, 0, side * 0.1, 0.01, 0.215, 0.08, 0.1, 0.03, this.eye);
      // hair
      const st = a.kind === 'guest' || a.kind === 'host' ? L.style : (a.kind === 'speaker' ? 0 : 2);
      if (st !== 2) {
        this._part(px, py, pz, cy, sy, 0, hY, 0, 0, 0, 0.23, -0.01, 0.48, 0.12, 0.48, hair); // top
        this._part(px, py, pz, cy, sy, 0, hY, 0, 0, 0, st === 1 ? -0.1 : 0.05, -0.2, 0.48, st === 1 ? 0.6 : 0.32, 0.12, hair); // back
        if (st === 4 || st === 1) this._part(px, py, pz, cy, sy, 0, hY, 0, 0, 0.07, 0.15, 0.2, 0.36, 0.08, 0.1, hair); // fringe
        if (st === 3) this._part(px, py, pz, cy, sy, 0, hY, 0, 0, 0, 0.33, -0.14, 0.2, 0.16, 0.2, hair); // bun
        if (st === 1) for (const side of [-1, 1]) this._part(px, py, pz, cy, sy, 0, hY, 0, 0, side * 0.23, -0.06, -0.05, 0.06, 0.44, 0.3, hair);
      } else {
        this._part(px, py, pz, cy, sy, 0, hY, 0, 0, 0, 0.22, -0.03, 0.46, 0.04, 0.44, hair); // buzz cut
      }
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose?.(); }
}
const PI2 = Math.PI / 2;
