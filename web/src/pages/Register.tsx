import { useState, type FormEvent } from "react";
import { api, setToken } from "../api.js";

export function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [interests, setInterests] = useState("");
  const [clusterMap, setClusterMap] = useState(false);
  const [qrCheckin, setQrCheckin] = useState(false);
  const [status, setStatus] = useState<string>("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api.register({
        name,
        email,
        interests: interests.split(",").map((s) => s.trim()).filter(Boolean),
        consent: { clusterMap, qrCheckin },
      });
      setToken(res.token);
      setStatus("Registered.");
    } catch (err) {
      setStatus(String(err));
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <h1>Register</h1>
      <label htmlFor="name">Name</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
      <label htmlFor="email">Email</label>
      <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <label htmlFor="interests">Interests (comma separated)</label>
      <input id="interests" value={interests} onChange={(e) => setInterests(e.target.value)} />
      <fieldset>
        <legend>What we store and why</legend>
        <p>
          Your profile and interests are stored to recommend talks. Attendee-level data is deleted after 24 hours.
        </p>
        <label>
          <input type="checkbox" checked={clusterMap} onChange={(e) => setClusterMap(e.target.checked)} /> Include my
          interests in the aggregate map
        </label>
        <label>
          <input type="checkbox" checked={qrCheckin} onChange={(e) => setQrCheckin(e.target.checked)} /> Allow QR
          check-in per room
        </label>
      </fieldset>
      <button type="submit">Register</button>
      <p role="status">{status}</p>
    </form>
  );
}
