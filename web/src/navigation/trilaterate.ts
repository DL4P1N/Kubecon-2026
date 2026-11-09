/** Position from Bluetooth Low Energy signal strength: log-distance path loss, linearised weighted least squares, smoothing.
 *  Pure maths, no I/O. Units: metres, dBm. */

/** RSSI measured 1 m from a BLE transmitter (dBm). BLE beacons calibrate to about -59 dBm at 1 m. */
export const TX_POWER_DBM = -59;
/** Path-loss exponent: 2.0 in free space, about 2.0 to 2.5 in an open indoor hall (higher with walls and crowds). */
export const PATH_LOSS_EXPONENT = 2.2;
/** Assumed relative error of a range estimate; sets the floor of the reported accuracy. */
export const RANGE_ERROR_FRACTION = 0.1;

export interface PathLossModel { txPower: number; exponent: number }
export const DEFAULT_MODEL: PathLossModel = { txPower: TX_POWER_DBM, exponent: PATH_LOSS_EXPONENT };

export interface Reading { x: number; y: number; rssi: number }
export interface Position { x: number; y: number; accuracyMeters: number }

/** Log-distance model: rssi = txPower - 10 n log10(d), so d = 10 ^ ((txPower - rssi) / (10 n)). */
export function rssiToDistance(rssi: number, model: PathLossModel = DEFAULT_MODEL): number {
  return 10 ** ((model.txPower - rssi) / (10 * model.exponent));
}

/** Inverse of rssiToDistance (used by the simulator and tests). Distances under 0.1 m are treated as 0.1 m. */
export function distanceToRssi(distance: number, model: PathLossModel = DEFAULT_MODEL): number {
  return model.txPower - 10 * model.exponent * Math.log10(Math.max(distance, 0.1));
}

/** Weighted least squares position from at least three usable receiver readings; null otherwise.
 *  Subtracting the circle equation of the nearest receiver from the others removes the quadratic terms:
 *  2(xi-x0)x + 2(yi-y0)y = d0^2 - di^2 + xi^2 - x0^2 + yi^2 - y0^2. Each row is weighted 1/di^2 (near receivers are trusted more).
 *  accuracyMeters combines the fit residual with a range-error floor so three exactly consistent circles do not claim 0 m. */
export function trilaterate(readings: Reading[], model: PathLossModel = DEFAULT_MODEL): Position | null {
  const usable = readings
    .filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.rssi))
    .map((r) => ({ x: r.x, y: r.y, d: rssiToDistance(r.rssi, model) }));
  if (usable.length < 3) return null;
  usable.sort((a, b) => a.d - b.d);
  const [ref, ...rest] = usable as [typeof usable[0], ...typeof usable];
  let sxx = 0, sxy = 0, syy = 0, sxb = 0, syb = 0;
  for (const p of rest) {
    const ax = 2 * (p.x - ref.x), ay = 2 * (p.y - ref.y);
    const b = ref.d ** 2 - p.d ** 2 + p.x ** 2 - ref.x ** 2 + p.y ** 2 - ref.y ** 2;
    const w = 1 / Math.max(p.d, 1) ** 2;
    sxx += w * ax * ax; sxy += w * ax * ay; syy += w * ay * ay; sxb += w * ax * b; syb += w * ay * b;
  }
  const det = sxx * syy - sxy * sxy;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9 * Math.max(sxx * syy, 1)) return null; // collinear receivers: no unique fix
  const x = (syy * sxb - sxy * syb) / det;
  const y = (sxx * syb - sxy * sxb) / det;
  const rms = Math.sqrt(usable.reduce((sum, p) => sum + (Math.hypot(x - p.x, y - p.y) - p.d) ** 2, 0) / usable.length);
  const meanRange = usable.reduce((sum, p) => sum + p.d, 0) / usable.length;
  return { x, y, accuracyMeters: Math.hypot(rms, RANGE_ERROR_FRACTION * meanRange) };
}

/** Exponential moving average so the dot does not jump: new = prev + alpha (next - prev). alpha in (0, 1]; 1 = no smoothing. */
export function smoothPosition(previous: Position | null, next: Position, alpha = 0.45): Position {
  if (!previous) return next;
  const a = Math.min(1, Math.max(0.01, alpha));
  return {
    x: previous.x + a * (next.x - previous.x),
    y: previous.y + a * (next.y - previous.y),
    accuracyMeters: previous.accuracyMeters + a * (next.accuracyMeters - previous.accuracyMeters),
  };
}
