import { ALTERNATIVES_PATH, type AlternativesResponse } from "@cc/shared";

/** Thrown with the HTTP status so the UI can tell "warming up" (503) from other failures. */
export class AlternativesError extends Error {
  constructor(readonly status: number) {
    super(`alternatives failed: ${status}`);
    this.name = "AlternativesError";
  }
}

/** Public endpoint (no session token): similar talks running at the same time in other rooms. */
export async function fetchAlternatives(talkId: string, size = 3): Promise<AlternativesResponse> {
  const res = await fetch(`${ALTERNATIVES_PATH.replace(":id", encodeURIComponent(talkId))}?size=${size}`);
  if (!res.ok) throw new AlternativesError(res.status);
  return (await res.json()) as AlternativesResponse;
}
