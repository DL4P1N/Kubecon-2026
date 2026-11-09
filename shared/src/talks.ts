import type { AlternativeTalk } from "./alternatives.js";
import type { Talk } from "./contract.js";

/** Talk detail page (task #57). Own file so it does not collide with contract.ts edits. */
export const TALK_PATH = "/api/talks/:id";
export const RELATED_PATH = "/api/talks/:id/related";

export interface TalkDetailResponse {
  talk: Talk;
}

/** Talks on similar topics at any time (not only the same slot). Public, no attendee data. */
export interface RelatedTalksResponse {
  talkId: string;
  related: AlternativeTalk[];
}
