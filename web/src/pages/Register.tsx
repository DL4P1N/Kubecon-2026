import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, setToken } from "../api.js";
import { Link, useNavigate } from "react-router-dom";
import { TopicChoices } from "./TopicChoices.js";
import "./attendee.css";
const CLAIM_KEY = "cc.identity-claim";
const LINKED_KEY = "cc.linked.v1";

function readIdentityClaim(): string | null {
  try {
    const claim = JSON.parse(sessionStorage.getItem(CLAIM_KEY) ?? "null");
    return claim && typeof claim.token === "string" && Date.parse(claim.expiresAt) > Date.now() ? claim.token : null;
  } catch { return null; }
}

function linkedDisplayName(): string {
  try {
    const linked = JSON.parse(localStorage.getItem(LINKED_KEY) ?? "null");
    if (!linked || typeof linked !== "object") return "";
    for (const provider of ["github"]) {
      const name = linked[provider]?.displayName;
      if (typeof name === "string" && name.trim()) return name.trim().slice(0, 80);
    }
  } catch { /* storage unavailable or corrupt */ }
  return "";
}

function clearIdentityClaim(): void {
  try { sessionStorage.removeItem(CLAIM_KEY); } catch { /* storage unavailable */ }
}



function providerName(id: string): string {
  return id === "github" ? "GitHub" : id;
}
export function Register() {
  const [name, setName] = useState(linkedDisplayName);
  const [email, setEmail] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [interests, setInterests] = useState<string[]>([]);
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [clusterMap, setClusterMap] = useState(false);
  const [qrCheckin, setQrCheckin] = useState(false);
  const [status, setStatus] = useState<string>("");
  useEffect(() => {
    api.authProviders().then((r) => setProviders(r.providers.filter((p) => p.enabled).map((p) => p.id))).catch(() => {});
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (interests.length === 0) {
      setStatus("Choose at least one topic before registering.");
      return;
    }
    setPending(true);
    const identityClaim = readIdentityClaim();
    setStatus("");
    try {
      const res = await api.register({
        ...(identityClaim !== null ? { identityClaim } : {}),
        name: name.trim(),
        email: email.trim(),
        interests,
        consent: { clusterMap, qrCheckin },
      });
      clearIdentityClaim();
      setToken(res.token);
      navigate("/onboarding");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        clearIdentityClaim();
        setStatus("That account already has a profile. Sign in again.");
      } else if (err instanceof ApiError && err.code === "invalid_identity_claim") {
        clearIdentityClaim();
        setStatus("Your sign-in expired or could not be verified. Sign in again.");
      } else {
        setStatus("Registration failed. Please try again.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="attendee-form" onSubmit={onSubmit} aria-busy={pending}>
      <h1>Register</h1>
      <p>Already have a profile? {providers.map((p, i) => <span key={p}>{i > 0 ? " / " : ""}<a href={`/api/auth/${p}/start?return=/schedule`}>Sign in with {providerName(p)}</a></span>)}{providers.length === 0 && <Link to="/schedule">Return to My schedule</Link>}</p>
      <p>Create your conference profile, then find talks that fit your interests.</p>
      <label htmlFor="name">Name</label>
      <input id="name" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} required pattern=".*\S.*" />
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="email" maxLength={254} aria-describedby="email-help" value={email} onChange={(e) => setEmail(e.target.value)} />
      <p id="email-help">Optional. Your email is not stored.</p>
      <p>Choose at least one topic to get started.</p>
      <TopicChoices selected={interests} onChange={setInterests} />
      <fieldset>
        <legend>What we store and why</legend>
        <p>
          We store your name, interests and consent choices to create your profile and recommend talks. Your email is not stored.
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
