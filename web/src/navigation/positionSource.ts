import { DEFAULT_MODEL, distanceToRssi, type PathLossModel } from "./trilaterate.js";
import { FLOOR, type Floor } from "./floor.js";

/** One signal reading: which receiver and how strong (dBm). */
export interface ReceiverReading { receiverId: string; rssi: number }

/** Where signal readings come from: the strength (RSSI, dBm) of Bluetooth Low Energy signals as heard by the receivers installed
 *  at the venue. A web page cannot broadcast or scan Bluetooth for this, so the only implementation here is simulatedWalk.
 *  A real source needs the venue's receivers plus a native app or a badge that transmits; it would implement this interface
 *  (reporting each receiver's id and RSSI) and nothing else changes. Path-loss constants in trilaterate.ts are BLE ones
 *  (about -59 dBm at 1 m, exponent about 2.0 to 2.5) and should be calibrated on site. */
export interface PositionSource {
  /** Short label shown next to the readings, for example "Simulated signals". */
  readonly label: string;
  /** True when the source has no more readings (a live scanner is never done). */
  readonly done: boolean;
  /** The next set of readings; receivers that are out of range are left out. */
  next(): ReceiverReading[];
  reset(): void;
}

export interface SimulatedWalk extends PositionSource {
  /** Where the simulated attendee really was for the latest readings (tests and the simulator only; never shown as a measurement). */
  truth(): { x: number; y: number };
}

export interface WalkOptions {
  floor?: Floor;
  /** Graph node ids to walk through, in order. Default: registration desk, up to the hallway, along it, into the lounge. */
  path?: string[];
  stepMeters?: number;
  /** Standard deviation of the shadowing noise in dB. */
  noiseDb?: number;
  seed?: number;
  /** The simulated world's path-loss model; differs a little from the estimator's on purpose. */
  world?: PathLossModel;
}

const SENSITIVITY_DBM = -95;
const DEFAULT_PATH = ["lobby", "lobby-door", "h6", "h8", "h17", "h20", "lounge-door", "lounge"];

/** Small deterministic PRNG so the walk is repeatable. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A made-up attendee walking a fixed path, with noisy Bluetooth signal strengths computed from the log-distance model. */
export function simulatedWalk(options: WalkOptions = {}): SimulatedWalk {
  const floor = options.floor ?? FLOOR;
  const stepMeters = options.stepMeters ?? 1.2;
  const noiseDb = options.noiseDb ?? 1.5;
  const world = options.world ?? { txPower: DEFAULT_MODEL.txPower, exponent: 2.3 };
  const seed = options.seed ?? 7;
  const nodes = (options.path ?? DEFAULT_PATH).map((id) => {
    const node = floor.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Unknown node ${id}`);
    return node;
  });
  const total = nodes.slice(1).reduce((sum, n, i) => sum + Math.hypot(n.x - nodes[i]!.x, n.y - nodes[i]!.y), 0);
  const pointAt = (distance: number) => {
    let left = Math.min(Math.max(distance, 0), total);
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1]!, b = nodes[i]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (left <= length) { const t = length === 0 ? 0 : left / length; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
      left -= length;
    }
    const last = nodes[nodes.length - 1]!;
    return { x: last.x, y: last.y };
  };
  let travelled = 0;
  let sampled = pointAt(0);
  let random = mulberry32(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

  return {
    label: "Simulated signals",
    get done() { return travelled >= total; },
    truth: () => sampled,
    next() {
      sampled = pointAt(travelled);
      const readings = floor.receivers.flatMap((rx) => {
        const rssi = Math.round(distanceToRssi(Math.hypot(rx.x - sampled.x, rx.y - sampled.y), world) + noiseDb * gaussian());
        return rssi >= SENSITIVITY_DBM ? [{ receiverId: rx.id, rssi }] : [];
      });
      travelled = Math.min(total, travelled + stepMeters);
      return readings;
    },
    reset() { travelled = 0; sampled = pointAt(0); random = mulberry32(seed); },
  };
}
