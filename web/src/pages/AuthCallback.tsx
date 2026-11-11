import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import type { AuthCallbackResponse } from "@cc/shared";
import { api, setToken } from "../api.js";
import { siteNavigation } from "../App.js";
import { ErrorState, LoadingState } from "../components/PageState.js";

const LINKED_KEY = "cc.linked.v1";
const PROFILE_PATH = "/site/profile.html";
const CLAIM_KEY = "cc.identity-claim";

/** Merges the provider display profile into browser localStorage; server identity linking uses only an HMAC. */
export function storeLinked(r: AuthCallbackResponse): void {
  try {
    const raw = localStorage.getItem(LINKED_KEY);
    const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    localStorage.setItem(LINKED_KEY, JSON.stringify({
      ...base,
      [r.provider]: { displayName: r.displayName, handle: r.handle, avatarUrl: r.avatarUrl, linkedAt: new Date().toISOString() },
    }));
  } catch {
    // storage unavailable or corrupt: the visitor can still carry on without the link being remembered
  }
}

// The state is one-time: under React StrictMode the effect runs twice, so both runs share one request.
const inFlight = new Map<string, Promise<AuthCallbackResponse>>();
function postCallbackOnce(provider: string, code: string, state: string): Promise<AuthCallbackResponse> {
  const key = `${provider}\n${state}`;
  let p = inFlight.get(key);
  if (!p) {
    p = api.authCallback(provider, { code, state });
    inFlight.set(key, p);
    const forget = () => { if (inFlight.get(key) === p) inFlight.delete(key); };
    p.then(forget, forget);
  }
  return p;
}

/**
 * OAuth callback target. Exchanges the code, stores the returned session or short-lived registration claim,
 * and resumes at the validated return path.
 */
export function AuthCallback() {
  const { provider = "" } = useParams();
  const { search } = useLocation();
  const [failed, setFailed] = useState(false);
  const [appLink, setAppLink] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(search);
    const code = q.get("code");
    const state = q.get("state");
    if (q.get("error") || !code || !state) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const linked = await postCallbackOnce(provider, code, state);
        if (linked.session) {
          setToken(linked.session.token);
          try { sessionStorage.removeItem(CLAIM_KEY); } catch { /* no browser storage */ }
        }
        if (linked.claim) {
          try { sessionStorage.setItem(CLAIM_KEY, JSON.stringify(linked.claim)); } catch { /* registration can still proceed without link */ }
        }
        storeLinked(linked);
        if (linked.app) {
          const url = `confcompanion://linked?provider=${encodeURIComponent(linked.provider)}&name=${encodeURIComponent(linked.displayName)}`;
          setAppLink(url);
          siteNavigation.replace(url);
        } else {
          siteNavigation.replace(linked.claim && linked.return === PROFILE_PATH ? `/site/register.html?via=${encodeURIComponent(linked.provider)}` : linked.return);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [provider, search]);

  if (failed) {
    return <ErrorState>
      We could not link that account. <a href={PROFILE_PATH}>Back to your profile</a>
    </ErrorState>;
  }
  if (appLink) return <p role="status">Account linked. <a href={PROFILE_PATH}>Back to your profile</a></p>;
  return <LoadingState>Linking your account…</LoadingState>;
}
