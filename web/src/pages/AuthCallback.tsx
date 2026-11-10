import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import type { AuthCallbackResponse } from "@cc/shared";
import { api } from "../api.js";
import { siteNavigation } from "../App.js";
import { ErrorState, LoadingState } from "../components/PageState.js";

const LINKED_KEY = "cc.linked.v1";
const PROFILE_PATH = "/site/profile.html";

/** Merges the linked account into localStorage `cc.linked.v1` (browser only; the server keeps nothing). */
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

/**
 * OAuth redirect target: /auth/:provider/callback?code=&state=. Posts the code to the API (which holds
 * the client secret), stores the returned profile in this browser, then goes back to where sign-in began.
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
        const linked = await api.authCallback(provider, { code, state });
        if (cancelled) return;
        storeLinked(linked);
        if (linked.app) {
          const url = `confcompanion://linked?provider=${encodeURIComponent(linked.provider)}&name=${encodeURIComponent(linked.displayName)}`;
          setAppLink(url);
          siteNavigation.replace(url);
        } else {
          siteNavigation.replace(linked.return);
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
