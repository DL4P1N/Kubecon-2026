// Pixel name labels over live arrivals: a 3x5 pixel font on the scene's own pixel grid (one texel = one rendered
// pixel), light plate with a 1-pixel dark border. One instanced draw for all labels.
import * as THREE from '../vendor/three.module.min.js';

const FONT = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001111', ' ': '000000000000000',
};
const SLOTS = 10, AW = 64, RH = 10; // atlas: one 64x10 row per label

export function sanitizeLabel(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
}

const VERT = /* glsl */ `
attribute vec2 corner;
attribute vec3 iPos;
attribute vec3 iSlot; // slot, width, lift (px)
uniform vec2 uRes;
varying vec2 vUv;
void main(){
  vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  vec2 px = (clip.xy / clip.w * 0.5 + 0.5) * uRes;
  vec2 o = vec2(floor(px.x - floor(iSlot.y * 0.5)), floor(px.y) + iSlot.z);
  vec2 p = o + corner * vec2(iSlot.y, 9.0);
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
  vUv = vec2(corner.x * iSlot.y / ${AW}.0, (iSlot.x * ${RH}.0 + (1.0 - corner.y) * 9.0) / ${SLOTS * RH}.0);
}`;
const FRAG = /* glsl */ `
uniform sampler2D tAtlas;
varying vec2 vUv;
void main(){
  vec4 t = texture2D(tAtlas, vUv);
  if (t.a < 0.5) discard;
  gl_FragColor = vec4(t.rgb, 1.0);
}`;

export class Labels {
  constructor(theme) {
    this.theme = theme;
    this.canvas = document.createElement('canvas');
    this.canvas.width = AW; this.canvas.height = SLOTS * RH;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.magFilter = THREE.NearestFilter; this.tex.minFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false; this.tex.flipY = false;
    this.slotOf = new Map(); // agent -> {slot, w}
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * 3), 3);
    this.slot = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * 3), 3);
    g.setAttribute('iPos', this.pos); g.setAttribute('iSlot', this.slot);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { tAtlas: { value: this.tex }, uRes: { value: new THREE.Vector2(1, 1) } }, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
  }
  _draw(slot, text) {
    const c = this.ctx, T = this.theme;
    const css = (a) => `rgb(${Math.round(a[0] * 255)},${Math.round(a[1] * 255)},${Math.round(a[2] * 255)})`;
    const up = text.toUpperCase();
    const w = up.length * 4 + 3;
    const y0 = slot * RH;
    c.clearRect(0, y0, AW, RH);
    c.fillStyle = css(T.bubbleInk);
    c.fillRect(1, y0, w - 2, 9); c.fillRect(0, y0 + 1, w, 7); // stepped corners
    c.fillStyle = css(T.accent);
    c.fillRect(2, y0 + 1, w - 4, 7); c.fillRect(1, y0 + 2, w - 2, 5);
    c.fillStyle = css(T.bubbleInk);
    for (let i = 0; i < up.length; i++) {
      const g = FONT[up[i]] || FONT[' '];
      for (let k = 0; k < 15; k++) if (g[k] === '1') c.fillRect(2 + i * 4 + (k % 3), y0 + 2 + Math.floor(k / 3), 1, 1);
    }
    this.tex.needsUpdate = true;
    return w;
  }
  update(crowd, cut) {
    const now = crowd.t;
    const want = crowd.agents.filter((a) => a.spawned && a.label && !a.disabled && now < a.labelUntil);
    for (const [a] of this.slotOf) if (!want.includes(a)) this.slotOf.delete(a);
    const used = new Set([...this.slotOf.values()].map((v) => v.slot));
    for (const a of want) {
      if (this.slotOf.has(a)) continue;
      let s = 0; while (used.has(s) && s < SLOTS) s++;
      if (s >= SLOTS) continue;
      used.add(s);
      this.slotOf.set(a, { slot: s, w: this._draw(s, a.label) });
    }
    let n = 0;
    for (const [a, v] of this.slotOf) {
      if (a.hidden || (cut && (a.x < cut[0] || a.x > cut[2] || a.z < cut[1] || a.z > cut[3]))) continue;
      const head = a.y + (a.pose === 'sit' ? 1.78 : 2.02) * (1 + a.look.tall * 0.05);
      this.pos.setXYZ(n, a.x, head, a.z);
      this.slot.setXYZ(n, v.slot, v.w, 14);
      n++;
    }
    this.geo.instanceCount = n;
    this.pos.needsUpdate = true; this.slot.needsUpdate = true;
  }
  setRes(w, h) { this.mat.uniforms.uRes.value.set(w, h); }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.tex.dispose(); }
}
