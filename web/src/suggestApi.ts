import { SUGGEST_PATH, type Suggestion, type SuggestResponse } from "@cc/shared";

/** Public endpoint (no session token). Pass a signal so a newer keystroke can cancel the request. */
export async function fetchSuggestions(q: string, signal?: AbortSignal): Promise<Suggestion[]> {
  const res = await fetch(`${SUGGEST_PATH}?${new URLSearchParams({ q })}`, { signal });
  if (!res.ok) throw new Error(`suggest failed: ${res.status}`);
  return ((await res.json()) as SuggestResponse).suggestions;
}
