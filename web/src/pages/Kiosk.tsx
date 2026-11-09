import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ScanResponse } from "@cc/shared";
import { api } from "../api.js";
import "./kiosk.css";

const REASONS: Record<string, string> = {
  not_entitled: "This pass does not include this room.",
  no_entitlement: "No active pass was found.",
  token_expired: "The code has expired. Ask the attendee to show a new one.",
  token_invalid: "The code is not valid.",
};

const CAMERA_ELEMENT_ID = "kiosk-camera";

interface CameraScanner {
  start(
    camera: { facingMode: string },
    config: { fps: number; qrbox: number },
    onSuccess: (text: string) => void,
    onFailure: () => void,
  ): Promise<unknown>;
  stop(): Promise<void>;
  clear(): void;
}

/**
 * Room kiosk: pick a room, then scan an attendee's QR with the camera or paste
 * the token text. The decision comes from the server; the kiosk never sees
 * who the attendee is. The result is shown as an icon plus words, so it does
 * not depend on colour, and is announced through a live region.
 */
export function Kiosk() {
  const [token, setToken] = useState("");
  const [room, setRoom] = useState("");
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const scanner = useRef<CameraScanner | null>(null);
  const generation = useRef(0);
  const tokenInput = useRef<HTMLInputElement>(null);
  const roomRef = useRef(room);
  roomRef.current = room;

  async function check(value: string) {
    const trimmedRoom = roomRef.current.trim();
    if (!trimmedRoom) {
      setError("Choose a room first.");
      return;
    }
    if (!value.trim()) {
      setError("Scan a QR code or paste a token first.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.scan({ token: value.trim(), room: trimmedRoom }));
      setError("");
    } catch {
      setError("Could not check access. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function stopCamera() {
    generation.current++; // cancels a start that is still pending
    const s = scanner.current;
    scanner.current = null;
    setCameraOn(false);
    if (!s) return;
    try {
      await s.stop();
      s.clear();
    } catch {
      // already stopped
    }
  }

  useEffect(() => () => void stopCamera(), []);

  async function startCamera() {
    const mine = ++generation.current;
    const cancelled = () => mine !== generation.current;
    setError("");
    setCameraOn(true);
    let handled = false;
    let qr: CameraScanner | null = null;
    try {
      // Lazy-loaded: the camera library is only fetched when someone uses it.
      const { Html5Qrcode } = await import("html5-qrcode");
      if (cancelled()) return;
      qr = new Html5Qrcode(CAMERA_ELEMENT_ID);
      scanner.current = qr;
      await qr.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        (text) => {
          // The library reports every decoded frame until stop() resolves; act on the first only.
          if (handled || cancelled()) return;
          handled = true;
          setToken(text);
          void stopCamera().then(() => check(text));
        },
        () => {},
      );
      if (cancelled()) {
        // Stopped or unmounted while the camera was starting: release it now.
        if (scanner.current === qr) scanner.current = null;
        await qr.stop().catch(() => {});
        qr.clear();
      }
    } catch {
      if (cancelled()) return;
      scanner.current = null;
      setCameraOn(false);
      setError("The camera is not available or permission was denied. Type or paste the token below instead.");
      // Move straight to the text fallback so the kiosk operator can keep going.
      tokenInput.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void check(token);
  }

  const allowed = result?.decision === "allow";

  return (
    <section className="kiosk">
      <h1>Room check-in</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="room">Room</label>
        <input id="room" value={room} onChange={(e) => setRoom(e.target.value)} maxLength={200} autoComplete="off" />
        <div id={CAMERA_ELEMENT_ID} hidden={!cameraOn} />
        {cameraOn ? (
          <button type="button" onClick={() => void stopCamera()}>
            Stop camera
          </button>
        ) : (
          <button type="button" onClick={() => void startCamera()}>
            Scan with camera
          </button>
        )}
        <label htmlFor="token">Token (if the camera is not used)</label>
        <input id="token" ref={tokenInput} value={token} onChange={(e) => setToken(e.target.value)} maxLength={1024} autoComplete="off" />
        <button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Check access"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <div role="status" aria-live="polite" className="kiosk-result-region">
        {result && (
          <div className={`kiosk-result ${allowed ? "kiosk-allow" : "kiosk-deny"}`}>
            <span className="kiosk-icon" aria-hidden="true">
              {allowed ? "✓" : "✕"}
            </span>
            <p className="kiosk-decision">{allowed ? "Access granted" : "Access denied"}</p>
            <p>{result.room}</p>
            {!allowed && result.reason && <p>{REASONS[result.reason] ?? "Access is not permitted."}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
