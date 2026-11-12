import { useId, useState } from "react";
import type { AlternativesResponse, Talk } from "@cc/shared";
import { AlternativesError, fetchAlternatives } from "../alternativesApi.js";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * "Room full? Similar talks now": loads up to three talks running at the same
 * time in other rooms, ranked by meaning (embedding similarity), each
 * with the tags it shares with the talk being replaced.
 */
export function Alternatives({ talk, load = fetchAlternatives }: { talk: Talk; load?: typeof fetchAlternatives }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "warming" | "error">("idle");
  const [result, setResult] = useState<AlternativesResponse | null>(null);
  const regionId = useId();

  async function onClick() {
    if (state === "loading") return;
    setState("loading");
    try {
      setResult(await load(talk.id));
      setState("done");
    } catch (err) {
      setState(err instanceof AlternativesError && err.status === 503 ? "warming" : "error");
    }
  }

  return (
    <div className="alternatives">
      <button type="button" aria-label={`${state === "loading" ? "Finding similar talks…" : "Room full? Similar talks now"} for ${talk.title}`} aria-expanded={state !== "idle"} aria-controls={regionId} disabled={state === "loading"} onClick={onClick}>
        {state === "loading" ? "Finding similar talks…" : "Room full? Similar talks now"}
      </button>
      <div id={regionId} aria-live="polite">
        {state === "warming" && <p>Similar-talk search is warming up. Try again in a few seconds.</p>}
        {state === "error" && <p role="alert">Similar talks could not be loaded. Please try again.</p>}
        {state === "done" && result && result.alternatives.length === 0 && (
          <p>No other sessions are running at this time that match this talk.</p>
        )}
        {state === "done" && result && result.alternatives.length > 0 && (
          <>
            <p>Talks at the same time as “{talk.title}”, most similar first:</p>
            <ol className="alternatives-list">
              {result.alternatives.map(({ talk: alt, sharedTags }) => (
                <li key={alt.id}>
                  <strong>{alt.title}</strong>
                  <br />
                  {alt.room} · <time dateTime={alt.start}>{time(alt.start)}</time>–<time dateTime={alt.end}>{time(alt.end)}</time>
                  <br />
                  {sharedTags.length > 0 ? `Why: shares ${sharedTags.join(", ")}` : "Why: similar topic"}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
