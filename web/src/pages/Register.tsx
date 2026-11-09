import { useState, type FormEvent } from "react";
import { api, setToken } from "../api.js";
import { useNavigate } from "react-router-dom";
import { TopicChoices } from "./TopicChoices.js";
import "./attendee.css";

export function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [interests, setInterests] = useState<string[]>([]);
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [clusterMap, setClusterMap] = useState(false);
  const [qrCheckin, setQrCheckin] = useState(false);
  const [status, setStatus] = useState<string>("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setStatus("");
    try {
      const res = await api.register({
        name: name.trim(),
        email: email.trim(),
        interests,
        consent: { clusterMap, qrCheckin },
      });
      setToken(res.token);
      navigate("/onboarding");
    } catch (err) {
      setStatus("Registration failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="attendee-form" onSubmit={onSubmit} aria-busy={pending}>
      <h1>Register</h1>
      <p>Create your conference profile, then find talks that fit your interests.</p>
      <label htmlFor="name">Name</label>
      <input id="name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} required pattern=".*\S.*" />
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} required />
      <TopicChoices selected={interests} onChange={setInterests} />
      <fieldset>
        <legend>What we store and why</legend>
        <p>
          We store your name, email, interests and consent choices to create your profile and recommend talks.
          Attendee-level data, including your schedule and room entitlements, is deleted after 24 hours.
        </p>
        <p>Both choices below are optional and start off. You can get recommendations without selecting either.</p>
        <label>
          <input type="checkbox" checked={clusterMap} onChange={(e) => setClusterMap(e.target.checked)} /> Include my
          interests in the aggregate map (only groups of at least 5 are shown)
        </label>
        <label>
          <input type="checkbox" checked={qrCheckin} onChange={(e) => setQrCheckin(e.target.checked)} /> Allow QR
          check-in per room
        </label>
      </fieldset>
      <button type="submit" disabled={pending}>{pending ? "Registering…" : "Register"}</button>
      {status && <p role="alert">{status}</p>}
    </form>
  );
}
