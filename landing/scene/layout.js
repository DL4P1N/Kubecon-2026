// Pure data: the venue floorplan. 1 world unit ~ 0.55 m; a person is ~1.75 units tall. Nav grid cell = 0.5 units.
// x runs east, z runs south (towards the default camera), y is up.
export const GRID = 0.5;
export const VW = 34;
export const VD = 24;
export const APRON = { x0: 4.4, x1: 8.6, z0: 24, z1: 27 };
export const NX = Math.round(VW / GRID);
export const NZ = Math.round(APRON.z1 / GRID);
const T = 0.4; // wall thickness
const HZ0 = 9, HZ1 = 9 + T; // hallway north wall band
export const HALL = { z0: HZ1, z1: 14 };
export const STREET = { x: 6.5, z: 26.6 }; // arrivals appear / leavers vanish here (front edge of the apron)

export const RECOMMENDED = ['room-a', 'room-c'];
export const FEATURED_DOOR = 'room-b';

export function buildLayout() {
  const boxes = []; // static props: {x0,y0,z0,x1,y1,z1,c, block}
  const walls = []; // walls (one mesh, drops to outlines in the clusters shot)
  const navBlocks = []; // extra nav-only blockers
  const B = (x0, z0, x1, z1, y0, y1, c, block = true) => { boxes.push({ x0, y0, z0, x1, y1, z1, c, block }); };
  const W = (x0, z0, x1, z1, h, c = 'wall') => { walls.push({ x0, y0: 0, z0, x1, y1: h, z1, c, block: true }); };
  const F = (x0, z0, x1, z1, y0, y1) => { walls.push({ x0, y0, z0, x1, y1, z1, c: 'trim', block: false }); };
  const hwall = (z0, xa, xb, h, gaps) => {
    let a = xa;
    for (const [g0, g1] of gaps) { if (g0 > a) W(a, z0, g0, z0 + T, h); a = g1; }
    if (a < xb) W(a, z0, xb, z0 + T, h);
  };

  // ---------------------------------------------------------------- shell
  W(0, 0, VW, T, 2.3);                 // north (back) wall, tall
  W(0, T, T, VD, 2.3);                 // west (back) wall, tall
  W(VW - T, T, VW, VD, 0.45);          // east (front) wall, low
  hwall(VD - T, 0, VW, 0.45, [[5, 8]]); // south (front) wall with the entrance

  // north strip: keynote | B1 | B2 | B3
  const doorDefs = [
    { id: 'keynote', g0: 7, g1: 9 },
    { id: 'room-a', g0: 18.6, g1: 20.2 },
    { id: 'room-b', g0: 24.9, g1: 26.5 },
    { id: 'room-c', g0: 30.5, g1: 32.1 },
  ];
  hwall(HZ0, T, VW - T, 1.05, doorDefs.map((d) => [d.g0, d.g1]));
  for (const x of [16, 22.5, 28.5]) W(x, T, x + T, HZ0, 1.05);
  // B4 workshop in the south-east corner
  const b4 = { g0: 27.6, g1: 29.2 };
  hwall(14, 26, VW - T, 1.05, [[b4.g0, b4.g1]]);
  W(26, 14 + T, 26 + T, VD - T, 1.05);

  const rooms = {
    keynote: { x0: T, x1: 16, z0: T, z1: HZ0 },
    'room-a': { x0: 16 + T, x1: 22.5, z0: T, z1: HZ0 },
    'room-b': { x0: 22.5 + T, x1: 28.5, z0: T, z1: HZ0 },
    'room-c': { x0: 28.5 + T, x1: VW - T, z0: T, z1: HZ0 },
    'room-d': { x0: 26 + T, x1: VW - T, z0: 14 + T, z1: VD - T },
  };

  // ---------------------------------------------------------------- doors + scanners
  const doors = [];
  const mkDoor = (id, g0, g1, north) => {
    const cx = (g0 + g1) / 2;
    const wz0 = north ? HZ0 : 14, wz1 = wz0 + T;
    const d = { id, g0, g1, cx, wz0, wz1, north };
    if (north) { // room is north of the hallway; scanner on the hallway (south) side
      d.post = { x: g1 + 0.42, z: wz1 + 0.32 };
      d.scan = { x: cx + 0.15, z: wz1 + 0.75 };
      d.qdir = { x: 0, z: 0.85 };
      d.inner = { x: cx, z: wz0 - 0.9 };
      d.face = Math.PI; // facing -z (into the room)
    } else { // 'room-d': room is south of the hallway wall
      d.post = { x: g1 + 0.42, z: wz0 - 0.32 };
      d.scan = { x: cx + 0.15, z: wz0 - 0.75 };
      d.qdir = { x: -0.85, z: 0 };
      d.inner = { x: cx, z: wz1 + 0.9 };
      d.face = 0;
    }
    d.slots = [0, 1, 2, 3].map((k) => ({ x: d.scan.x + d.qdir.x * k, z: d.scan.z + d.qdir.z * k }));
    // frame posts and lintel in the accent colour (part of the wall mesh, so they drop with the walls)
    const fz0 = wz0 - 0.05, fz1 = wz1 + 0.05;
    F(g0 - 0.22, fz0, g0, fz1, 0, 1.55);
    F(g1, fz0, g1 + 0.22, fz1, 0, 1.55);
    F(g0 - 0.22, fz0, g1 + 0.22, fz1, 1.55, 1.72);
    // scanner post: dark body, metal head; the lamp on top is a live fx box
    B(d.post.x - 0.16, d.post.z - 0.16, d.post.x + 0.16, d.post.z + 0.16, 0, 1.05, 'ink');
    B(d.post.x - 0.24, d.post.z - 0.24, d.post.x + 0.24, d.post.z + 0.24, 1.05, 1.16, 'metal', false);
    d.lamp = { x: d.post.x, z: d.post.z, y0: 1.16, y1: 1.46 };
    // threshold tile that flashes on a scan
    d.tile = north ? { x0: g0 + 0.05, x1: g1 - 0.05, z0: wz1 + 0.05, z1: wz1 + 1.15 } : { x0: g0 + 0.05, x1: g1 - 0.05, z0: wz0 - 1.15, z1: wz0 - 0.05 };
    doors.push(d);
  };
  for (const d of doorDefs) mkDoor(d.id, d.g0, d.g1, true);
  mkDoor('room-d', b4.g0, b4.g1, false);
  const doorById = Object.fromEntries(doors.map((d) => [d.id, d]));
  for (const d of doors) d.room = rooms[d.id];

  // ---------------------------------------------------------------- seating helpers
  const seats = { keynote: [], 'room-a': [], 'room-b': [], 'room-c': [], 'room-d': [], lounge: [] };
  const stands = { keynote: [], 'room-a': [], 'room-b': [], 'room-c': [], 'room-d': [], lounge: [], hall: [], lobby: [], bar: [], sponsor: [] };
  // chair facing north (towards -z) has its back on the +z side; approach lane is behind it (+z)
  const chair = (cx, cz, faceNorth, room, appZ) => {
    if (faceNorth) {
      B(cx - 0.27, cz - 0.27, cx + 0.27, cz + 0.2, 0, 0.42, 'chairSeat', false);
      B(cx - 0.27, cz + 0.2, cx + 0.27, cz + 0.32, 0, 0.95, 'chair', false);
    } else {
      B(cx - 0.27, cz - 0.2, cx + 0.27, cz + 0.27, 0, 0.42, 'chairSeat', false);
      B(cx - 0.27, cz - 0.32, cx + 0.27, cz - 0.2, 0, 0.95, 'chair', false);
    }
    navBlocks.push({ x0: cx - 0.3, z0: cz - 0.3, x1: cx + 0.3, z1: cz + 0.3 });
    seats[room].push({ x: cx, z: cz, y: 0.42, yaw: faceNorth ? Math.PI : 0, room, taken: null, approach: { x: cx, z: appZ } });
  };
  const plant = (x, z, s = 1) => {
    B(x - 0.26 * s, z - 0.26 * s, x + 0.26 * s, z + 0.26 * s, 0, 0.38 * s, 'pot');
    B(x - 0.38 * s, z - 0.38 * s, x + 0.38 * s, z + 0.38 * s, 0.38 * s, 0.86 * s, 'leaf');
    B(x - 0.24 * s, z - 0.24 * s, x + 0.24 * s, z + 0.24 * s, 0.86 * s, 1.18 * s, 'leaf2', false);
    B(x + 0.05 * s, z - 0.12 * s, x + 0.2 * s, z + 0.04 * s, 1.18 * s, 1.34 * s, 'leaf2', false);
  };

  // ---------------------------------------------------------------- keynote hall
  const fx = { screens: [], markers: [], machine: null };
  B(2.6, T, 13.4, 2.6, 0, 0.45, 'stage');
  B(2.6, 2.48, 13.4, 2.6, 0.32, 0.45, 'trim', false); // lime stage edge
  B(3.4, 2.6, 4.1, 3.1, 0, 0.22, 'stage', false);     // step
  // main screen on the back wall (content is fx)
  B(3.8, T, 12.2, T + 0.12, 0.85, 2.25, 'screen', false);
  fx.screens.push({ x0: 4.0, x1: 12.0, y0: 1.0, y1: 2.1, z: T + 0.13, cols: 16, rows: 6, big: true });
  B(11.2, 1.3, 11.8, 1.8, 0.45, 1.35, 'woodDark', false); // lectern
  B(11.15, 1.25, 11.85, 1.85, 1.35, 1.42, 'trim', false);
  B(1.2, T, 2.2, 1.3, 0, 1.4, 'ink', false);   // speaker stacks
  B(13.8, T, 14.8, 1.3, 0, 1.4, 'ink', false);
  B(1.35, 1.3, 2.05, 1.32, 0.3, 1.2, 'metal', false);
  B(13.95, 1.3, 14.65, 1.32, 0.3, 1.2, 'metal', false);
  const rowZ = [4.0, 5.4, 6.8];
  const colsL = [1.6, 2.55, 3.5, 4.45, 5.4, 6.35];
  const colsR = [9.65, 10.6, 11.55, 12.5, 13.45, 14.4];
  rowZ.forEach((z) => [...colsL, ...colsR].forEach((x) => chair(x, z, true, 'keynote', z + 0.78)));
  plant(0.95, 8.4);
  plant(15.3, 8.4);
  stands.keynote.push({ x: 15.0, z: 3.4, yaw: -Math.PI * 0.75 }, { x: 1.0, z: 3.6, yaw: Math.PI * 0.75 }, { x: 1.0, z: 7.7, yaw: Math.PI }, { x: 15.1, z: 7.5, yaw: Math.PI });
  const speaker = { x0: 5.0, x1: 10.2, z: 1.7, y: 0.45 };
  // cable from the lectern to the desk side of the stage
  B(11.5, 1.85, 11.6, 3.1, 0.45, 0.47, 'cable', false);

  // ---------------------------------------------------------------- breakouts B1..B3
  for (const id of ['room-a', 'room-b', 'room-c']) {
    const r = rooms[id];
    const cx = (r.x0 + r.x1) / 2;
    B(cx - 1.9, r.z0, cx + 1.9, r.z0 + 0.1, 0.85, 1.95, 'screen', false);
    fx.screens.push({ x0: cx - 1.75, x1: cx + 1.75, y0: 0.95, y1: 1.85, z: r.z0 + 0.11, cols: 7, rows: 4, room: id });
    B(cx + 1.3, 1.25, cx + 1.8, 1.65, 0, 1.0, 'woodDark', false); // small lectern
    for (const [rz] of [[4.0], [5.6]]) for (const dx of [-1.8, -0.6, 0.6, 1.8]) chair(cx + dx, rz, true, id, rz + 0.78);
    plant(r.x0 + 0.65, 1.0, 0.85);
    stands[id].push({ x: r.x0 + 0.9, z: 7.4, yaw: Math.PI }, { x: r.x1 - 0.9, z: 7.5, yaw: Math.PI }, { x: r.x1 - 0.75, z: 3.0, yaw: -Math.PI / 2 });
  }

  // ---------------------------------------------------------------- B4 workshop
  {
    B(28.0, 18.0, 32.2, 19.4, 0, 0.72, 'creamDark');
    B(27.95, 17.95, 32.25, 19.45, 0.72, 0.8, 'cream', false);
    for (const x of [28.5, 29.5, 30.5, 31.5]) {
      chair(x, 17.35, false, 'room-d', 16.55);
      chair(x, 20.05, true, 'room-d', 20.85);
      B(x - 0.22, 18.2, x + 0.22, 18.45, 0.8, 0.84, 'ink', false); // laptops
      B(x - 0.22, 18.95, x + 0.22, 19.2, 0.8, 0.84, 'ink', false);
      B(x - 0.22, 18.15, x + 0.22, 18.2, 0.84, 1.08, 'ink', false);
      B(x - 0.22, 19.2, x + 0.22, 19.25, 0.84, 1.08, 'ink', false);
    }
    B(VW - T - 0.1, 16.5, VW - T, 20.5, 0.8, 1.75, 'paper', false); // whiteboard on the east wall
    B(VW - T - 0.12, 17.0, VW - T - 0.1, 17.6, 1.2, 1.5, 'booth', false);
    B(VW - T - 0.12, 18.2, VW - T - 0.1, 19.4, 1.0, 1.1, 'sofa', false);
    plant(33.0, 23.0, 0.85);
    plant(27.0, 23.0, 0.85);
    stands['room-d'].push({ x: 33.0, z: 18.0, yaw: -Math.PI / 2 }, { x: 33.0, z: 19.4, yaw: -Math.PI / 2 }, { x: 27.2, z: 21.8, yaw: Math.PI / 2 });
  }

  // ---------------------------------------------------------------- lobby: entrance + registration desk
  const desk = { x0: 3.0, x1: 8.2, z0: 17.0, z1: 17.9 };
  B(desk.x0, desk.z0, desk.x1, desk.z1, 0, 0.92, 'creamDark');
  B(desk.x0 - 0.05, desk.z0 - 0.05, desk.x1 + 0.05, desk.z1 + 0.05, 0.92, 1.0, 'cream', false);
  B(desk.x0, desk.z1, desk.x1, desk.z1 + 0.04, 0.25, 0.55, 'trim', false); // lime band on the desk front
  B(6.4, 17.15, 7.1, 17.3, 1.0, 1.42, 'ink', false);   // monitor
  B(6.65, 17.3, 6.85, 17.45, 1.0, 1.1, 'ink', false);
  B(3.4, 17.2, 4.1, 17.7, 1.0, 1.25, 'metal', false); // badge printer
  B(3.55, 17.7, 3.95, 17.75, 1.05, 1.12, 'paper', false);
  B(7.5, 17.25, 8.0, 17.65, 1.0, 1.12, 'woodDark', false); // badge box
  B(7.55, 17.3, 7.95, 17.6, 1.12, 1.14, 'paper', false);
  const host = { x: 5.4, z: 16.35, yaw: 0 };
  const deskQ = [0, 1, 2, 3, 4, 5].map((k) => ({ x: k ? 5.4 : 5.75, z: 18.65 + 0.85 * k }));
  // banner stand by the entrance
  B(9.3, 22.6, 9.5, 22.8, 0, 2.2, 'metal', false);
  B(9.3, 22.6, 11.3, 22.72, 1.0, 2.2, 'banner', false);
  B(11.1, 22.6, 11.3, 22.8, 0, 2.2, 'metal', false);
  // banner print: a stacked mark and two lines of "text" in dark pixels on the lime cloth
  for (const [x0, x1, y0, y1] of [[9.7, 10.0, 1.75, 2.05], [9.7, 10.0, 1.4, 1.65], [10.15, 11.0, 1.9, 2.0], [10.15, 10.8, 1.72, 1.8], [10.15, 10.95, 1.45, 1.53], [9.7, 10.9, 1.15, 1.22]]) {
    B(x0, 22.72, x1, 22.74, y0, y1, 'ink', false);
  }
  navBlocks.push({ x0: 9.2, z0: 22.5, x1: 11.4, z1: 22.9 });
  // floor mat at the entrance, cables from the desk to the wall
  B(5.0, 23.0, 8.0, 23.6, 0, 0.02, 'rug', false);
  B(2.0, 17.4, 3.0, 17.5, 0, 0.02, 'cable', false);
  B(1.0, 17.4, 2.0, 17.5, 0, 0.02, 'cable', false);
  B(0.9, 15.0, 1.0, 17.5, 0, 0.02, 'cable', false);
  plant(1.0, 14.9);
  plant(1.0, 22.9);
  plant(12.4, 22.9, 0.9);
  // bench on the west wall
  B(0.5, 19.0, 1.2, 21.6, 0, 0.42, 'wood');
  for (const z of [19.6, 20.9]) seats.lounge.push({ x: 0.9, z, y: 0.42, yaw: Math.PI / 2, room: 'lobby', taken: null, approach: { x: 1.75, z } });
  stands.lobby.push({ x: 10.6, z: 15.4, yaw: Math.PI / 2 }, { x: 11.5, z: 15.4, yaw: -Math.PI / 2 },
    { x: 10.4, z: 19.6, yaw: Math.PI / 2 }, { x: 11.3, z: 19.6, yaw: -Math.PI / 2 },
    { x: 2.4, z: 22.3, yaw: Math.PI / 2 }, { x: 3.3, z: 22.3, yaw: -Math.PI / 2 });

  // ---------------------------------------------------------------- lounge + coffee bar + sponsor booth
  // coffee bar on the south wall
  B(13.8, 21.5, 18.6, 22.2, 0, 0.95, 'woodDark');
  B(13.75, 21.45, 18.65, 22.25, 0.95, 1.03, 'cream', false);
  B(14.1, 21.6, 14.8, 22.1, 1.03, 1.55, 'ink', false); // espresso machine
  fx.machine = { x: 14.45, y: 1.4, z: 21.58 };
  for (const x of [15.4, 16.0, 16.6, 17.4]) B(x, 21.65, x + 0.18, 21.83, 1.03, 1.2, 'cup', false);
  const barista = { x: 16.2, z: 22.85, yaw: Math.PI };
  stands.bar.push({ x: 15.2, z: 20.75, yaw: Math.PI }, { x: 16.4, z: 20.75, yaw: Math.PI }, { x: 17.6, z: 20.75, yaw: Math.PI });
  // standing tables with coffee cups
  const tables = [[15.8, 17.3], [19.4, 16.6], [22.6, 18.1], [19.6, 19.9]];
  for (const [x, z] of tables) {
    B(x - 0.12, z - 0.12, x + 0.12, z + 0.12, 0, 0.95, 'ink');
    B(x - 0.46, z - 0.46, x + 0.46, z + 0.46, 0.95, 1.03, 'cream', false);
    B(x - 0.3, z - 0.25, x - 0.12, z - 0.07, 1.03, 1.2, 'cup', false);
    B(x + 0.1, z + 0.08, x + 0.28, z + 0.26, 1.03, 1.2, 'cup', false);
    navBlocks.push({ x0: x - 0.46, z0: z - 0.46, x1: x + 0.46, z1: z + 0.46 });
    stands.lounge.push({ x: x - 0.95, z, yaw: Math.PI / 2, pair: true }, { x: x + 0.95, z, yaw: -Math.PI / 2, pair: true });
  }
  // sofa + low table
  B(20.0, 22.7, 24.2, 23.6, 0, 0.42, 'sofa');
  B(20.0, 23.25, 24.2, 23.6, 0.42, 0.95, 'sofaDark', false);
  B(19.7, 22.7, 20.0, 23.6, 0, 0.7, 'sofaDark', false);
  B(24.2, 22.7, 24.5, 23.6, 0, 0.7, 'sofaDark', false);
  for (const x of [20.8, 22.1, 23.4]) seats.lounge.push({ x, z: 23.0, y: 0.42, yaw: Math.PI, room: 'lounge', taken: null, approach: { x, z: 22.15 } });
  B(21.2, 21.3, 23.0, 21.8, 0, 0.4, 'wood');
  B(21.5, 21.4, 21.68, 21.58, 0.4, 0.56, 'cup', false);
  // rug under the lounge
  B(18.0, 15.4, 24.6, 22.4, 0, 0.012, 'rug', false);
  // sponsor booth against the workshop wall
  B(25.55, 15.0, 25.98, 18.6, 0, 1.9, 'booth', false);
  B(25.5, 15.6, 25.55, 18.0, 1.1, 1.6, 'paper', false);
  B(24.3, 15.5, 25.1, 18.1, 0, 0.9, 'cream');
  B(24.25, 15.45, 25.15, 18.15, 0.9, 0.97, 'trim', false);
  navBlocks.push({ x0: 25.4, z0: 15.0, x1: 26.0, z1: 18.6 });
  stands.sponsor.push({ x: 23.55, z: 16.1, yaw: -Math.PI / 2 }, { x: 23.55, z: 17.5, yaw: -Math.PI / 2 });
  plant(25.4, 23.0, 0.9);
  plant(13.5, 15.0, 0.9);

  // ---------------------------------------------------------------- hallway
  stands.hall.push({ x: 2.6, z: 12.9, yaw: Math.PI / 2 }, { x: 3.5, z: 12.9, yaw: -Math.PI / 2 },
    { x: 13.4, z: 10.4, yaw: Math.PI / 2 }, { x: 14.3, z: 10.4, yaw: -Math.PI / 2 },
    { x: 21.6, z: 12.9, yaw: Math.PI / 2 }, { x: 22.5, z: 12.9, yaw: -Math.PI / 2 },
    { x: 32.4, z: 12.6, yaw: Math.PI / 2 }, { x: 33.2, z: 12.6, yaw: -Math.PI / 2 });
  // wayfinding sign pillar in the hallway
  B(16.3, 11.9, 16.7, 12.3, 0, 1.2, 'ink');
  B(15.9, 11.95, 17.1, 12.25, 1.2, 1.9, 'ink', false);
  B(16.0, 12.25, 17.0, 12.27, 1.3, 1.8, 'trim', false);
  plant(0.95, 10.2, 0.9);
  plant(33.1, 10.2, 0.9);

  // recommended-room markers (live fx): floor arrow + pin over the door
  for (const id of RECOMMENDED) {
    const d = doorById[id];
    fx.markers.push({ door: id, x: d.cx, z: d.wz1 + 1.6, pinY: 2.05 });
  }

  // ---------------------------------------------------------------- cluster gathering spots (clusters shot)
  // teal amber coral green blue other
  const clusterSpots = [
    { x: 6.6, z: 11.7 }, { x: 21.8, z: 18.6 }, { x: 6.8, z: 20.8 }, { x: 27.6, z: 11.7 }, { x: 17.0, z: 11.6 }, { x: 13.4, z: 19.2 },
    { x: 10.6, z: 15.6 }, { x: 16.7, z: 15.9 }, // small groups that fold into "other"
  ];

  // guided navigation: where a guided person ends up in each room, where they start, and three Bluetooth receivers installed at the venue
  const guideDest = {
    keynote: { x: 8.0, z: 5.0 }, 'room-a': { x: doorById['room-a'].cx, z: 7.2 }, 'room-b': { x: doorById['room-b'].cx, z: 7.2 },
    'room-c': { x: doorById['room-c'].cx, z: 7.2 }, 'room-d': { x: 30.0, z: 21.6 }, lounge: { x: 17.6, z: 18.9 },
  };
  const guideStart = { x: 7.0, z: 22.8 };
  const receivers = [{ x: 0.62, y: 1.7, z: 16.5 }, { x: 12.3, y: 1.15, z: 9.2 }, { x: 26.2, y: 1.15, z: 20.6 }];
  for (const b of receivers) B(b.x - 0.16, b.z - 0.16, b.x + 0.16, b.z + 0.16, b.y - 0.1, b.y + 0.04, 'paper', false);
  return { guideDest, guideStart, receivers, boxes, walls, navBlocks, rooms, doors, doorById, seats, stands, desk, deskQ, host, barista, speaker, fx, clusterSpots };
}
