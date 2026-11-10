/** One floor plan as data: rooms, Bluetooth receivers and a walkable graph. Metres; x runs east, y runs south.
 *  The six areas and their arrangement mirror the site's pixel venue (landing/scene/layout.js): the stage and breakouts along
 *  the north wall, the hallway across the middle, the lobby with registration south-west and the lounge south-east.
 *  The pixel venue's other rooms (C, D) are left out to keep this plan to six areas. Receiver positions are illustrative, not surveyed. */

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Room extends Rect { id: string; name: string; short: string }
export interface Receiver { id: string; name: string; x: number; y: number }
export interface GraphNode { id: string; label: string; x: number; y: number; room: string }
export interface Floor {
  width: number; height: number; rooms: Room[]; receivers: Receiver[];
  nodes: GraphNode[]; edges: [string, string][]; entrances: Record<string, string>;
}

export const FLOOR: Floor = {
  width: 34,
  height: 24,
  rooms: [
    { id: "main-stage", short: "Main stage", name: "Main stage", x0: 0, y0: 0, x1: 16, y1: 9 },
    { id: "room-a", short: "Room A", name: "Breakout room A", x0: 16, y0: 0, x1: 25, y1: 9 },
    { id: "room-b", short: "Room B", name: "Breakout room B", x0: 25, y0: 0, x1: 34, y1: 9 },
    { id: "hallway", short: "Hallway", name: "Hallway", x0: 0, y0: 9, x1: 34, y1: 14 },
    { id: "lobby", short: "Lobby", name: "Lobby and registration", x0: 0, y0: 14, x1: 13, y1: 24 },
    { id: "lounge", short: "Lounge", name: "Lounge", x0: 13, y0: 14, x1: 34, y1: 24 },
  ],
  receivers: [
    { id: "rx-b1", name: "Receiver B1", x: 8, y: 2 },
    { id: "rx-b2", name: "Receiver B2", x: 22, y: 3 },
    { id: "rx-b3", name: "Receiver B3", x: 30, y: 7 },
    { id: "rx-b4", name: "Receiver B4", x: 17, y: 12 },
    { id: "rx-b5", name: "Receiver B5", x: 3, y: 22 },
    { id: "rx-b6", name: "Receiver B6", x: 28, y: 22 },
  ],
  nodes: [
    { id: "stage", label: "the Main stage", x: 8, y: 4.5, room: "main-stage" },
    { id: "stage-door", label: "the Main stage door", x: 8, y: 9, room: "main-stage" },
    { id: "a", label: "Breakout room A", x: 20.5, y: 4.5, room: "room-a" },
    { id: "a-door", label: "the Room A door", x: 20.5, y: 9, room: "room-a" },
    { id: "b", label: "Breakout room B", x: 29.5, y: 4.5, room: "room-b" },
    { id: "b-door", label: "the Room B door", x: 29.5, y: 9, room: "room-b" },
    { id: "h6", label: "the hallway", x: 6.5, y: 11.5, room: "hallway" },
    { id: "h8", label: "the hallway", x: 8, y: 11.5, room: "hallway" },
    { id: "h17", label: "the middle of the hallway", x: 17, y: 11.5, room: "hallway" },
    { id: "h20", label: "the hallway", x: 20.5, y: 11.5, room: "hallway" },
    { id: "h29", label: "the hallway", x: 29.5, y: 11.5, room: "hallway" },
    { id: "lobby-door", label: "the lobby entrance", x: 6.5, y: 14, room: "lobby" },
    { id: "lobby", label: "the registration desk", x: 6.5, y: 19, room: "lobby" },
    { id: "lounge-door", label: "the lounge entrance", x: 20.5, y: 14, room: "lounge" },
    { id: "lounge", label: "the lounge", x: 20.5, y: 19, room: "lounge" },
  ],
  edges: [
    ["stage", "stage-door"], ["stage-door", "h8"], ["h6", "h8"], ["h8", "h17"], ["h17", "h20"], ["h20", "h29"],
    ["a", "a-door"], ["a-door", "h20"], ["b", "b-door"], ["b-door", "h29"],
    ["h6", "lobby-door"], ["lobby-door", "lobby"], ["h20", "lounge-door"], ["lounge-door", "lounge"],
  ],
  // where you are heading for each room (the hallway is its own destination: the middle of it)
  entrances: { "main-stage": "stage", "room-a": "a", "room-b": "b", hallway: "h17", lobby: "lobby", lounge: "lounge" },
};

/** Destination ids the site's pixel venue uses, mapped to this plan's six areas. The plan has no Room C or Room D:
 *  Room C maps to the neighbouring Breakout room B, Room D (the south-east workshop) to the Lounge. */
export const ROOM_ALIASES: Record<string, string> = {
  stage: "main-stage", keynote: "main-stage", scan: "room-b", "room-c": "room-b", "room-d": "lounge",
};

/** A room id or a site alias to a room on this plan; null when it is neither. */
export function resolveRoom(id: string | null | undefined, floor: Floor = FLOOR): string | null {
  if (!id) return null;
  const key = id.trim().toLowerCase();
  const canonical = Object.prototype.hasOwnProperty.call(ROOM_ALIASES, key) ? ROOM_ALIASES[key]! : key;
  return floor.rooms.some((r) => r.id === canonical) ? canonical : null;
}

export function roomAt(x: number, y: number, floor: Floor = FLOOR): Room | null {
  return floor.rooms.find((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)
    ?? floor.rooms.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) ?? null; // points on the outer edge
}

export function clampToFloor(p: { x: number; y: number }, floor: Floor = FLOOR): { x: number; y: number } {
  return { x: Math.min(floor.width, Math.max(0, p.x)), y: Math.min(floor.height, Math.max(0, p.y)) };
}

export interface RouteStep { text: string; meters: number }
export interface Route { points: { x: number; y: number }[]; meters: number; steps: RouteStep[]; arrived: boolean }

const COMPASS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"]; // y runs south
const compass = (dx: number, dy: number) => COMPASS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8]!;

/** Closest point to p on the segment a-b. */
function project(p: { x: number; y: number }, a: GraphNode, b: GraphNode) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx === 0 && dy === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Shortest walking route from a point to a room. The point joins the walkable graph at its closest spot on a corridor
 *  (preferring corridors that touch the room it is in, so the route does not cut through walls), then Dijkstra runs over the
 *  graph to the room's entrance node, so you are never sent the wrong way along a corridor first. Null for an unknown room. */
export function route(from: { x: number; y: number }, toRoom: string, floor: Floor = FLOOR): Route | null {
  const goalId = floor.entrances[toRoom];
  if (!goalId || !floor.rooms.some((r) => r.id === toRoom)) return null;
  const byId = new Map(floor.nodes.map((n) => [n.id, n]));
  const here = roomAt(from.x, from.y, floor)?.id;
  const edges = floor.edges.map(([a, b]) => ({ a: byId.get(a)!, b: byId.get(b)! }));
  const local = edges.filter((e) => e.a.room === here || e.b.room === here);
  const pool = local.length ? local : edges;
  const near = pool.map((e) => ({ e, at: project(from, e.a, e.b) }))
    .reduce((best, c) => (Math.hypot(c.at.x - from.x, c.at.y - from.y) < Math.hypot(best.at.x - from.x, best.at.y - from.y) ? c : best));
  const join = near.at;
  const toJoin = Math.hypot(join.x - from.x, join.y - from.y);
  const adjacency = new Map<string, string[]>();
  for (const [a, b] of floor.edges) {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  // the point can step onto either end of its corridor
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  for (const n of [near.e.a, near.e.b]) dist.set(n.id, toJoin + Math.hypot(n.x - join.x, n.y - join.y));
  const todo = new Set(floor.nodes.map((n) => n.id));
  while (todo.size) {
    let current: string | null = null;
    for (const id of todo) if (dist.has(id) && (current === null || dist.get(id)! < dist.get(current)!)) current = id;
    if (current === null || current === goalId) break;
    todo.delete(current);
    const a = byId.get(current)!;
    for (const next of adjacency.get(current) ?? []) {
      const b = byId.get(next)!;
      const d = dist.get(current)! + Math.hypot(a.x - b.x, a.y - b.y);
      if (d < (dist.get(next) ?? Infinity)) { dist.set(next, d); prev.set(next, current); }
    }
  }
  if (!dist.has(goalId)) return null;
  const ids = [goalId];
  while (prev.has(ids[0]!)) ids.unshift(prev.get(ids[0]!)!);
  const nodes = ids.map((id) => byId.get(id)!);
  const points = [{ x: from.x, y: from.y }, join, ...nodes.map((n) => ({ x: n.x, y: n.y }))];
  const all = points.slice(1).map((p, i) => ({ dx: p.x - points[i]!.x, dy: p.y - points[i]!.y, to: nodes[Math.max(0, i - 1)]! }));
  const meters = all.reduce((sum, leg) => sum + Math.hypot(leg.dx, leg.dy), 0);
  const legs = all
    .filter((leg) => Math.hypot(leg.dx, leg.dy) > 0.8); // shorter hops are not worth a spoken step
  // merge consecutive legs that go the same way, then describe each as one step
  const merged: typeof legs = [];
  for (const leg of legs) {
    const last = merged[merged.length - 1];
    if (last && compass(last.dx, last.dy) === compass(leg.dx, leg.dy)) merged[merged.length - 1] = { dx: last.dx + leg.dx, dy: last.dy + leg.dy, to: leg.to };
    else merged.push({ ...leg });
  }
  const steps: RouteStep[] = merged.map((leg, i) => {
    const length = Math.hypot(leg.dx, leg.dy);
    const before = merged[i - 1];
    let verb = "Head";
    if (before) {
      const cross = before.dx * leg.dy - before.dy * leg.dx; // y runs down, so positive is a right turn
      verb = cross > 0 ? "Turn right and walk" : "Turn left and walk";
    }
    return { text: `${verb} ${compass(leg.dx, leg.dy)} for ${Math.max(1, Math.round(length))} m to ${leg.to.label}.`, meters: length };
  });
  return { points, meters, steps, arrived: here === toRoom };
}
