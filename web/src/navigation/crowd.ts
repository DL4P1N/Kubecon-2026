import type { Avatar } from "./avatar.js";
import { FLOOR, route, type Floor } from "./floor.js";
import { mulberry32 } from "./prng.js";

export interface Person { id: number; x: number; y: number; avatar: Avatar }
export interface Crowd {
  people(): Person[];
  /** One tick: everyone walks on along their route (or waits at a door, then picks a new room). */
  step(): void;
  reset(): void;
}

const SKIN = ["f1c9a5", "d9a066", "a8693c", "6f4426", "f4d6bc"];
const HAIR = ["2b1b12", "5a3a1e", "c9a227", "b34a2a", "1a1a1a", "d8d8d0"];
const SHIRT = ["4fd1c5", "f0c24b", "ff7a59", "7bd88f", "6aa8ff", "f4f7ee", "e8e1c9"]; // no violet
const PANTS = ["24324a", "3a3a3a", "5c4a33", "1f3d2a", "8a8f98"];

/** Decorative simulated attendees: seeded and deterministic, walking between rooms along the same graph as route().
 *  They are not tied to any real person. Speed is metres per tick. */
export function createCrowd(options: { count?: number; seed?: number; floor?: Floor; speed?: number } = {}): Crowd {
  const floor = options.floor ?? FLOOR;
  const count = options.count ?? 16;
  const seed = options.seed ?? 11;
  const speed = options.speed ?? 1.1;

  interface State extends Person { pts: { x: number; y: number }[]; pace: number; wait: number }
  let random = mulberry32(seed);
  let state: State[] = [];
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;

  const choose = (p: State) => {
    // any room; picking the one they are already in just means a short wait
    const goals = floor.rooms.map((r) => r.id);
    const target = pick(goals);
    const r = route({ x: p.x, y: p.y }, target, floor);
    p.pts = r ? r.points.slice(1) : [];
    p.wait = r && r.meters > 1 ? 0 : 1;
  };

  const init = () => {
    random = mulberry32(seed);
    state = Array.from({ length: count }, (_, id) => {
      const node = pick(floor.nodes);
      const avatar: Avatar = { skin: pick(SKIN), hair: pick(HAIR), shirt: pick(SHIRT), pants: pick(PANTS), hat: random() < 0.25 };
      const p: State = { id, x: node.x + (random() - 0.5), y: node.y + (random() - 0.5), avatar, pts: [], pace: 0.7 + random() * 0.6, wait: Math.floor(random() * 4) };
      return p;
    });
  };
  init();

  return {
    people: () => state.map(({ id, x, y, avatar }) => ({ id, x, y, avatar })),
    step() {
      for (const p of state) {
        if (p.wait > 0) { p.wait--; if (p.wait === 0 && p.pts.length === 0) choose(p); continue; }
        if (p.pts.length === 0) { choose(p); continue; }
        let left = speed * p.pace;
        while (left > 0 && p.pts.length > 0) {
          const next = p.pts[0]!;
          const d = Math.hypot(next.x - p.x, next.y - p.y);
          if (d <= left) { left -= d; p.x = next.x; p.y = next.y; p.pts.shift(); }
          else { p.x += ((next.x - p.x) / d) * left; p.y += ((next.y - p.y) / d) * left; left = 0; }
        }
        if (p.pts.length === 0) p.wait = 1 + Math.floor(random() * 4); // linger at the destination
      }
    },
    reset: init,
  };
}

