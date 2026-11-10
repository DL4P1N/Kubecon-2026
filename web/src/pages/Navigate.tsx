import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { loadAvatar, spriteRects, SPRITE_H, SPRITE_W, type Avatar } from "../navigation/avatar.js";
import { createCrowd, type Person } from "../navigation/crowd.js";
import { FLOOR, clampToFloor, resolveRoom, roomAt, route } from "../navigation/floor.js";
import { simulatedWalk, type ReceiverReading } from "../navigation/positionSource.js";
import { smoothPosition, trilaterate, type Position } from "../navigation/trilaterate.js";
import "./navigate.css";

const CROWD_SIZE = 16;

/** A pixel person as crisp SVG rectangles; (x, y) is where they stand, cell is the size of one pixel in metres. */
function PixelPerson({ avatar, x, y, cell, className }: { avatar: Avatar; x: number; y: number; cell: number; className: string }) {
  const rects = useMemo(() => spriteRects(avatar), [avatar]);
  return (
    <g className={className} style={{ transform: `translate(${x - (SPRITE_W * cell) / 2}px, ${y - (SPRITE_H - 2) * cell}px)` }} shapeRendering="crispEdges">
      {rects.map((r, i) => <rect key={i} x={r.x * cell} y={r.y * cell} width={r.w * cell} height={cell} fill={r.fill} />)}
    </g>
  );
}

const TICK_MS = 800;
const dbm = (value: number) => `${String(value).replace("-", "−")} dBm`;

/** Find my room: a position estimated from Bluetooth receiver signal strengths, and a walking route to a chosen room.
 *  Everything stays in this component: no network calls, no telemetry attributes, nothing about position is stored or sent. */
export function Navigate() {
  const [params, setParams] = useSearchParams();
  const dest = resolveRoom(params.get("to")) ?? "main-stage";
  const me = useMemo(() => loadAvatar(), []);
  const crowd = useRef(createCrowd({ count: CROWD_SIZE }));
  const [others, setOthers] = useState<Person[]>(() => crowd.current.people());

  const source = useRef(simulatedWalk());
  const smoothed = useRef<Position | null>(null);
  const [fix, setFix] = useState<Position | null>(null);
  const [readings, setReadings] = useState<ReceiverReading[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const tick = useCallback(() => {
    const next = source.current.next();
    crowd.current.step();
    setOthers(crowd.current.people());
    setReadings(next);
    const raw = trilaterate(next.flatMap((r) => {
      const rx = FLOOR.receivers.find((a) => a.id === r.receiverId);
      return rx ? [{ x: rx.x, y: rx.y, rssi: r.rssi }] : [];
    }));
    if (raw) {
      const clamped = { ...raw, ...clampToFloor(raw) };
      smoothed.current = smoothPosition(smoothed.current, clamped);
      setFix(smoothed.current);
    }
    if (source.current.done) { setRunning(false); setFinished(true); }
  }, []);

  useEffect(() => { source.current.reset(); crowd.current.reset(); smoothed.current = null; tick(); }, [tick]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [running, tick]);

  const reset = () => { setRunning(false); setFinished(false); source.current.reset(); crowd.current.reset(); smoothed.current = null; tick(); };

  const here = fix ? roomAt(fix.x, fix.y) : null;
  const target = FLOOR.rooms.find((r) => r.id === dest)!;
  const path = useMemo(() => (fix ? route(fix, dest) : null), [fix, dest]);

  // polite announcements: a new destination, a new room, arrival (once per destination)
  const lastRoom = useRef<string | null>(null);
  const arrivedAt = useRef<string | null>(null);
  const lastDest = useRef(dest);
  useEffect(() => {
    if (lastDest.current !== dest) { lastDest.current = dest; arrivedAt.current = null; setAnnouncement(`Destination: ${target.name}.`); }
    if (!here) return;
    if (here.id === dest && arrivedAt.current !== dest) { arrivedAt.current = dest; lastRoom.current = here.id; setAnnouncement(`You have arrived at ${target.name}.`); return; }
    if (here.id !== dest) arrivedAt.current = null;
    if (lastRoom.current !== here.id) { lastRoom.current = here.id; setAnnouncement(`You are now in ${here.name}.`); }
  }, [here, dest, target.name]);

  const heard = new Map(readings.map((r) => [r.receiverId, r.rssi]));
  const arrived = here?.id === dest;
  const state = finished ? "Walk finished" : running ? "Walking" : "Paused";

  return (
    <section className="nav-page" aria-labelledby="nav-title">
      <h1 id="nav-title">Find my room</h1>
      <p>Pick a room to see a walking route from where the venue's Bluetooth receivers place you.</p>

      <div className="nav-layout">
        <figure className="nav-plan">
          <svg viewBox="-0.5 -0.5 35 25" role="img"
            aria-label={`Floor plan with six areas. ${here ? `You are in ${here.name}.` : "Position not known yet."} Destination: ${target.name}.`}>
            <g aria-hidden="true">
              {FLOOR.rooms.map((r) => (
                <g key={r.id} className={r.id === dest ? "nav-room is-dest" : "nav-room"}>
                  <rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} />
                  <text x={r.x0 + 0.6} y={r.y0 + 1.7}>{r.short}</text>
                </g>
              ))}
              {others.map((p) => <PixelPerson key={p.id} avatar={p.avatar} x={p.x} y={p.y} cell={0.12} className="nav-person nav-other" />)}
              {path && path.points.length > 1 && !arrived && (
                <polyline className="nav-route" points={path.points.map((p) => `${p.x},${p.y}`).join(" ")} />
              )}
              {FLOOR.receivers.map((r) => (
                <g key={r.id} className="nav-rx">
                  <rect x={r.x - 0.45} y={r.y - 0.45} width="0.9" height="0.9" />
                  <text x={r.x + 0.8} y={r.y + 0.4}>{r.name.replace("Receiver ", "")}</text>
                </g>
              ))}
              {fix && (
                <g className="nav-dot" style={{ transform: `translate(${fix.x}px, ${fix.y}px)` }}>
                  <circle className="nav-ring" r={Math.max(0.6, fix.accuracyMeters)} />
                </g>
              )}
              {fix && <PixelPerson avatar={me} x={fix.x} y={fix.y} cell={0.17} className="nav-person nav-me" />}
            </g>
          </svg>
          <figcaption className="nav-legend">
            <span><i className="key key-me" /> You (estimated)</span>
            <span><i className="key key-rx" /> Bluetooth receiver</span>
            <span><i className="key key-route" /> Route</span>
          </figcaption>
          <p className="nav-meta nav-crowd">{others.length} other attendees shown (simulated)</p>
        </figure>

        <div className="nav-side">
          <div className="nav-card">
            <label htmlFor="nav-to">Where to?</label>
            <select id="nav-to" value={dest} onChange={(event) => setParams({ to: event.target.value }, { replace: true })}>
              {FLOOR.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <p className="nav-here"><strong>You are in: {here?.name ?? "finding you…"}</strong></p>
            {fix && <p className="nav-meta">Accuracy about {"±"}{Math.round(fix.accuracyMeters)} m</p>}
            {arrived ? <p className="nav-arrived"><strong>You have arrived at {target.name}.</strong></p>
              : path && <>
                <p className="nav-meta">Distance: <strong>{Math.round(path.meters)} m</strong></p>
                <ol className="nav-steps" aria-label={`Steps to ${target.name}`}>
                  {path.steps.map((step, i) => <li key={i}>{step.text}</li>)}
                </ol>
              </>}
          </div>

          <div className="nav-card">
            <div className="nav-head">
              <h2>Bluetooth receivers</h2>
              <span className="nav-tag">{source.current.label}</span>
            </div>
            <ul className="nav-readings">
              {FLOOR.receivers.map((r) => (
                <li key={r.id}>{r.name} <span aria-hidden="true">{"·"}</span> <span className="nav-dbm">{heard.has(r.id) ? dbm(heard.get(r.id)!) : "no signal"}</span></li>
              ))}
            </ul>
            <p className="nav-meta" role="group" aria-label="Walk state">{state}</p>
            <div className="nav-controls">
              <button type="button" onClick={() => setRunning(true)} disabled={running || finished}>Start</button>
              <button type="button" className="btn-secondary" onClick={() => setRunning(false)} disabled={!running}>Pause</button>
              <button type="button" className="btn-secondary" onClick={reset}>Reset</button>
            </div>
          </div>
        </div>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}
