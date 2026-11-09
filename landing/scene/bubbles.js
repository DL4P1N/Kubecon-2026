// Pixel speech bubbles drawn on the scene's own pixel grid: one texel = one rendered pixel, positions snapped to it.
// White fill, stepped 1-pixel dark border, stepped tail; glyph inside. One instanced draw for all bubbles.
import * as THREE from '../vendor/three.module.min.js';
import { G } from './crowd.js';

const BW = 13, BH = 12;
const SHAPE = [
  '..ooooooooo..',
  '.owwwwwwwwwo.',
  'owwwwwwwwwwwo',
  'owwwwwwwwwwwo',
  'owwwwwwwwwwwo',
  'owwwwwwwwwwwo',
  'owwwwwwwwwwwo',
  '.owwwwwwwwwo.',
  '..oooowwoooo.',
  '....owwo.....',
  '....owo......',
  '....oo.......',
];
const GLYPHS = {
  [G.CHECK]: ['......#', '.....##', '#...##.', '##.##..', '.###...'],
  [G.CROSS]: ['##...##', '.##.##.', '..###..', '.##.##.', '##...##'],
  [G.DOTS]: ['.......', '.......', '#..#..#', '.......', '.......'],
  [G.QUESTION]: ['..###..', '.#...#.', '....##.', '.......', '...#...'],
  [G.EXCL]: ['...#...', '...#...', '...#...', '.......', '...#...'],
  [G.HEART]: ['.##.##.', '#######', '.#####.', '..###..', '...#...'],
  [G.STAR]: ['...#...', '..###..', '#######', '..###..', '.#...#.'],
  [G.COFFEE]: ['.#.#...', '.......', '#####..', '######.', '.###...'],
  [G.QR]: ['###.###', '#.#.#.#', '###.###', '...#...', '###.#.#'],
};
const NG = 9;

function glyphColor(theme, g) {
  if (g === G.CHECK) return theme.ok;
  if (g === G.CROSS) return theme.deny;
  if (g === G.HEART) return theme.cluster[2];
  if (g === G.STAR) return theme.cluster[1];
  if (g === G.COFFEE) return theme.k.coffee;
  return theme.bubbleInk;
}

function buildAtlas(theme) {
  const c = document.createElement('canvas');
  c.width = NG * BW; c.height = BH;
  const x2 = c.getContext('2d');
  const css = (a) => `rgb(${Math.round(a[0] * 255)},${Math.round(a[1] * 255)},${Math.round(a[2] * 255)})`;
  for (let g = 0; g < NG; g++) {
    const ox = g * BW;
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      const ch = SHAPE[y][x];
      if (ch === '.') continue;
      x2.fillStyle = ch === 'o' ? css(theme.bubbleInk) : css(theme.bubble);
      x2.fillRect(ox + x, y, 1, 1);
    }
    const gl = GLYPHS[g];
    x2.fillStyle = css(glyphColor(theme, g));
    for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) if (gl[y][x] === '#') x2.fillRect(ox + 3 + x, 2 + y, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  return tex;
}

const VERT = /* glsl */ `
attribute vec2 corner;
attribute vec3 iPos;
attribute float iGlyph;
uniform vec2 uRes;
varying vec2 vUv;
void main(){
  vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  vec2 px = (clip.xy / clip.w * 0.5 + 0.5) * uRes;
  // tail tip sits at the anchor; the bubble rises above it. Snap to whole pixels.
  vec2 o = vec2(floor(px.x) - 4.0, floor(px.y) + 1.0);
  vec2 p = o + corner * vec2(${BW}.0, ${BH}.0);
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
  vUv = vec2((iGlyph + corner.x) / ${NG}.0, 1.0 - corner.y);
}`;
const FRAG = /* glsl */ `
uniform sampler2D tAtlas;
varying vec2 vUv;
void main(){
  vec4 t = texture2D(tAtlas, vUv);
  if (t.a < 0.5) discard;
  gl_FragColor = vec4(t.rgb, 1.0);
}`;

export class Bubbles {
  constructor(theme, max = 20) {
    this.max = max;
    this.tex = buildAtlas(theme);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.gly = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.pos.setUsage(THREE.DynamicDrawUsage); this.gly.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.pos);
    g.setAttribute('iGlyph', this.gly);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { tAtlas: { value: this.tex }, uRes: { value: new THREE.Vector2(1, 1) } },
      depthTest: false, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }
  update(crowd, cut) {
    let n = 0;
    for (const b of crowd.bubbles) {
      const a = b.a;
      if (a.hidden || a.disabled || n >= this.max) continue;
      if (cut && (a.x < cut[0] || a.x > cut[2] || a.z < cut[1] || a.z > cut[3])) continue;
      const head = a.y + (a.pose === 'sit' ? 1.78 : 2.02) * (1 + a.look.tall * 0.05);
      this.pos.setXYZ(n, a.x, head, a.z);
      this.gly.setX(n, b.glyph);
      n++;
    }
    this.geo.instanceCount = n;
    this.pos.needsUpdate = true; this.gly.needsUpdate = true;
  }
  setRes(w, h) { this.mat.uniforms.uRes.value.set(w, h); }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.tex.dispose(); }
}
