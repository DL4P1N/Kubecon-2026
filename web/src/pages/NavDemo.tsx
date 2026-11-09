import { useEffect, useState } from "react";
import replayJson from "../../../data/nav-replay.json?raw";
import { estimateRoom, type Fingerprint } from "../navigation/estimate.js";

const replay = JSON.parse(replayJson) as { fingerprints: Fingerprint[]; frames: number[][] };
export default function NavDemo() {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setFrame((previous) => (previous + 1) % replay.frames.length), 1500);
    return () => window.clearInterval(timer);
  }, [playing]);
  const room = estimateRoom(replay.frames[frame]!, replay.fingerprints);
  return <section>
    <h1>Navigation replay demo</h1>
    <p><strong>Simulated signal replay, not measured at the venue.</strong></p>
    <p>This offline example compares made-up access-point signals with labelled fingerprints using nearest-neighbor distance.
      It reads no device signals and is not a guide to the venue.</p>
    <p role="status" aria-live="polite">Frame {frame + 1} of {replay.frames.length}. Estimated room: {room ?? "Unknown"}.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: ".75rem" }}>
      <button type="button" onClick={() => setPlaying(!playing)}>{playing ? "Pause replay" : "Play replay"}</button>
      <button type="button" disabled={playing} onClick={() => setFrame((frame + 1) % replay.frames.length)}>Next frame</button>
      <button type="button" onClick={() => { setPlaying(false); setFrame(0); }}>Reset replay</button>
    </div>
  </section>;
}
