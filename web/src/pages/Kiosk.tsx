import { useState, type FormEvent } from "react";
import type { ScanResponse } from "@cc/shared";
import { api } from "../api.js";

/** Demo scanner page: paste or scan a token and a room to see the server decision. */
export function Kiosk() {
  const [token, setToken] = useState("");
  const [room, setRoom] = useState("room-a");
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState("");

  async function getToken() {
    try {
      setToken((await api.accessToken()).token);
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }

  async function onScan(e: FormEvent) {
    e.preventDefault();
    try {
      setResult(await api.scan({ token, room }));
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <section>
      <h1>Room check-in</h1>
      <button type="button" onClick={getToken}>
        Get my QR token
      </button>
      <form onSubmit={onScan}>
        <label htmlFor="token">Token</label>
        <input id="token" value={token} onChange={(e) => setToken(e.target.value)} />
        <label htmlFor="room">Room</label>
        <input id="room" value={room} onChange={(e) => setRoom(e.target.value)} />
        <button type="submit">Scan</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <p role="status">
          {result.decision === "allow" ? "Access granted" : "Access denied"} for {result.room}
          {result.reason ? ` (${result.reason})` : ""}
        </p>
      )}
    </section>
  );
}
