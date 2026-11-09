// Shot definitions (camera + crowd state per name) and the framing maths that keeps the page's content side calm.
// box: the subject's floor rectangle [x0, z0, x1, z1] and h its height (world units), fitted into the frame;
// az: camera azimuth (0 = from the south, + = from the east); el: elevation (rad); wall: wall height factor.
// cut: true makes the box a diorama cut (nothing outside it is drawn), so the page's side of the frame is calm ground.
export const SHOTS = {
  overview: { box: [0, 0, 34, 27], boxN: [0.5, 9.5, 15, 24.5], h: 2.3, az: 0.62, el: 0.86, wall: 1, pad: 1.02, minH: 0, cut: false },
  arrive: { box: [0.4, 14.2, 12.4, 27], h: 2.2, az: 0.42, el: 0.8, wall: 1, pad: 1.0, minH: 13, cut: true },
  host: { box: [2.0, 14.2, 9.6, 21.4], h: 2.6, az: -0.5, el: 0.46, wall: 1, pad: 1.0, minH: 6.6, cut: true },
  schedule: { box: [4, 1.5, 34, 14.6], h: 2.4, az: 0.78, el: 0.78, wall: 1, pad: 1.0, minH: 0, cut: true },
  scan: { box: [22.7, 3.2, 29.2, 13.6], h: 2.6, az: 0.45, el: 0.62, wall: 1, pad: 1.0, minH: 9.5, cut: true },
  stage: { box: [0, 0, 16.4, 10.6], h: 2.6, az: 0.3, el: 0.72, wall: 1, pad: 1.0, minH: 0, cut: true },
  lounge: { box: [12.6, 13.8, 26.4, 24.2], h: 1.9, az: 0.72, el: 0.8, wall: 1, pad: 1.0, minH: 0, cut: true },
  clusters: { box: [0, 0, 34, 24], boxN: [3, 8, 31, 23], h: 0.3, az: 0.16, el: 1.42, wall: 0, pad: 1.0, minH: 0, cut: false },
};
const NOCUT = [-2, -2, 36, 29];
export const SHOT_NAMES = Object.keys(SHOTS);

// where the subject goes for each content side: centre (fractions of the frame, y from the top) and region size
const REGION = {
  left: { cx: 0.69, cy: 0.5, w: 0.6, h: 0.9 },
  right: { cx: 0.31, cy: 0.5, w: 0.6, h: 0.9 },
  center: { cx: 0.5, cy: 0.52, w: 0.9, h: 0.88 },
  top: { cx: 0.5, cy: 0.72, w: 0.94, h: 0.5 },
};

// camera basis for an azimuth/elevation (matches Object3D.lookAt with up = +y)
export function basis(az, el) {
  const sa = Math.sin(az), ca = Math.cos(az), se = Math.sin(el), ce = Math.cos(el);
  return { x: [ca, 0, -sa], y: [-se * sa, ce, -se * ca], z: [sa * ce, se, ca * ce] };
}

// Resolve a shot into a camera frame for a given aspect (width / height): project the subject box, fit it to the
// region opposite the page content, and offset the camera so the subject lands there.
export function frameShot(name, side, aspect, narrow = aspect < 1) {
  const s = SHOTS[name] || SHOTS.overview;
  const r = REGION[side] || REGION.left;
  const B = basis(s.az, s.el);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const [bx0, bz0, bx1, bz1] = narrow && s.boxN ? s.boxN : s.box;
  for (const x of [bx0, bx1]) for (const z of [bz0, bz1]) for (const y of [0, s.h]) {
    const sx = x * B.x[0] + y * B.x[1] + z * B.x[2];
    const sy = x * B.y[0] + y * B.y[1] + z * B.y[2];
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const viewH = Math.max((y1 - y0) / r.h * s.pad, (x1 - x0) / r.w / aspect * s.pad, s.minH);
  const viewW = viewH * aspect;
  const target = [B.x[0] * cx + B.y[0] * cy, B.x[1] * cx + B.y[1] * cy, B.x[2] * cx + B.y[2] * cy];
  return { target, offR: -(r.cx - 0.5) * viewW, offU: (r.cy - 0.5) * viewH, viewH, az: s.az, el: s.el, wall: s.wall, cut: s.cut ? s.box.slice() : NOCUT.slice() };
}

export const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));
const lerp = (a, b, t) => a + (b - a) * t;

export function blendFrames(a, b, t) {
  if (!b || t <= 0) return a;
  if (t >= 1) return b;
  return {
    target: [lerp(a.target[0], b.target[0], t), lerp(a.target[1], b.target[1], t), lerp(a.target[2], b.target[2], t)],
    offR: lerp(a.offR, b.offR, t),
    offU: lerp(a.offU, b.offU, t),
    viewH: Math.exp(lerp(Math.log(a.viewH), Math.log(b.viewH), t)),
    az: lerp(a.az, b.az, t),
    el: lerp(a.el, b.el, t),
    wall: lerp(a.wall, b.wall, t),
    cut: a.cut.map((v, i) => lerp(v, b.cut[i], t)),
  };
}
