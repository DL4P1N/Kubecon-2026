import { RELATED_PATH, TALK_PATH, type RelatedTalksResponse, type TalkDetailResponse } from "@cc/shared";

/** Thrown with the HTTP status so the UI can tell 404 (no such talk) and 503 (warming up) from other failures. */
export class TalksError extends Error {
  constructor(readonly status: number) {
    super(`talks request failed: ${status}`);
    this.name = "TalksError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new TalksError(res.status);
  return (await res.json()) as T;
}

/** Public endpoints (no session token). */
export const fetchTalk = (id: string): Promise<TalkDetailResponse> =>
  getJson(TALK_PATH.replace(":id", encodeURIComponent(id)));

export const fetchRelated = (id: string, size = 5): Promise<RelatedTalksResponse> =>
  getJson(`${RELATED_PATH.replace(":id", encodeURIComponent(id))}?size=${size}`);

/** In-app link to a talk's detail page. */
export const talkHref = (id: string): string => `/talks/${encodeURIComponent(id)}`;
