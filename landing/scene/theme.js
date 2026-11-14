// Palette: reads --venue-* custom properties from the host at mount and derives every scene colour from them.
// Colours are [r,g,b] 0..1, used as final sRGB values (no colour management, no lighting model).
export const DEFAULTS = {
  bg: '#0b0e14',     // clear colour, near-black navy
  floor: '#1a2232',  // venue floor
  wall: '#2c3a55',   // architecture
  ink: '#eef3ff',    // light ink: speech bubbles, wall outlines in the clusters view, signage
  accent: '#93eaff', // CNCF Turquoise: doors, scanner lights, screens, markers
};

// Five cluster hues (turquoise amber pink blue orange), the app's --chart-* set. Hard rule: no violet, purple or lavender.
const CLUSTER_HEX = ['#93eaff', '#f0c24b', '#ff6cc4', '#6c9bff', '#ff9f5a'];
const GREY_HEX = '#8f9690';
const DENY_HEX = '#ff5a48';

let probe = null;
function ctx() {
  if (probe) return probe;
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  probe = c.getContext('2d', { willReadFrequently: true });
  return probe;
}
export function hex(h) {
  let s = String(h).replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function parseColor(str, fallback) {
  const v = String(str || '').trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return hex(v);
  try {
    const c = ctx();
    c.fillStyle = '#000';
    c.fillStyle = v;
    const before = c.fillStyle;
    c.fillStyle = '#fff';
    c.fillStyle = v;
    if (c.fillStyle !== before) return hex(fallback); // invalid colour string
    c.clearRect(0, 0, 1, 1);
    c.fillRect(0, 0, 1, 1);
    const d = c.getImageData(0, 0, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255];
  } catch (e) {
    return hex(fallback);
  }
}
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const lum = (a) => 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
export const toHex = (a) => '#' + a.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

export function readTheme(host) {
  let cs = null;
  try { cs = getComputedStyle(host); } catch (e) { /* detached */ }
  const get = (k) => {
    const v = cs ? cs.getPropertyValue('--venue-' + k).trim() : '';
    return v ? parseColor(v, DEFAULTS[k]) : hex(DEFAULTS[k]);
  };
  const bg = get('bg'), floor = get('floor'), wall = get('wall'), ink = get('ink'), accent = get('accent');
  const white = [1, 1, 1];
  const dark = mix(bg, [0, 0, 0], 0.45); // shade colour for stepped tones and baked shadows
  const cream = hex('#efe4c8');
  const wood = hex('#b9874f');
  const t = { bg, floor, wall, ink, accent, dark, cream, white };
  t.deny = hex(DENY_HEX);
  t.grey = hex(GREY_HEX);
  // the small groups that fold into "other": pale lime-yellow, light pink (none of the five hues, no violet)
  t.fold = ['#efe56a', '#ffa3b4'].map(hex);
  t.cluster = CLUSTER_HEX.map(hex);
  t.k = {
    wall,
    wallTop: mix(wall, ink, 0.18),
    trim: accent,
    plinth: mix(bg, floor, 0.55),
    plinthEdge: mix(floor, wall, 0.4),
    cream,
    creamDark: mix(cream, wood, 0.45),
    wood,
    woodDark: mix(wood, dark, 0.45),
    stage: mix(hex('#3b3328'), floor, 0.25),
    chair: mix(hex('#2b3a31'), wall, 0.4),
    chairSeat: mix(hex('#6b7f5f'), wall, 0.25),
    screen: mix(dark, bg, 0.3),
    metal: mix(wall, white, 0.35),
    ink: mix(dark, wall, 0.15),
    leaf: hex('#4f9a45'),
    leaf2: hex('#79c25a'),
    pot: hex('#a5683f'),
    sofa: hex('#c46a46'),
    sofaDark: hex('#9b4e33'),
    rug: mix(floor, accent, 0.18),
    banner: accent,
    cable: mix(dark, floor, 0.35),
    cup: hex('#f4efe2'),
    coffee: hex('#6b4329'),
    booth: hex('#2ec4b2'),
    paper: hex('#f6f2e6'),
  };
  const f = floor;
  t.floors = {
    hall: f,
    lobby: mix(f, wall, 0.16),
    keynote: mix(f, dark, 0.28),
    room: mix(f, wall, 0.08),
    room2: mix(f, wall, 0.2),
    lounge: mix(f, hex('#3a3426'), 0.35),
    rug: mix(f, accent, 0.2),
    mat: mix(f, accent, 0.32),
    apron: mix(f, wall, 0.3),
  };
  // People: the brightest, most varied things in the scene.
  t.skins = ['#f7d7b5', '#ecbd92', '#d39a6a', '#a8714a', '#7a4e30', '#553522'].map(hex);
  t.hairs = ['#16161a', '#3b2a1d', '#6b4425', '#a5512a', '#e2bd62', '#b9bcbf', '#1f2a2e'].map(hex);
  t.shirts = ['#f2ead6', '#f2c14e', '#e8664a', '#4f9de0', '#ef93a8', '#38b5a3', '#fbfaf5', '#2b3036',
    '#e07f36', '#86c75a', '#c7c0ae', '#3f6fb8', '#d94f5c', '#f4dc8a'].map(hex);
  t.pants = ['#2e333d', '#2f4f7a', '#8b9097', '#c4a77a', '#1d2024', '#4a5560', '#6b5a45'].map(hex);
  t.shoes = ['#f6f6f0', '#f6f6f0', '#f6f6f0', '#24262a', '#c9533c'].map(hex);
  t.staffShirt = mix(accent, wall, 0.08);
  t.bubble = mix(ink, white, 0.6);
  t.bubbleInk = mix(bg, [0, 0, 0], 0.3);
  t.ok = mix(hex('#0086ff'), accent, 0.15);
  return t;
}
