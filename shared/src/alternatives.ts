import type { Talk } from "./contract.js";

/** "Room full? Go here instead" (task #53). Kept in its own file so it does not collide with contract.ts edits. */
export const ALTERNATIVES_PATH = "/api/talks/:id/alternatives";

export interface AlternativeTalk {
  talk: Talk;
  /** Semantic similarity score from Elasticsearch (relative, not a percentage). */
  score: number;
  /** Tags this talk shares with the one being replaced: a readable "why". */
  sharedTags: string[];
}

/** Talks running at the same time as `talkId`, most similar first. Public, no attendee data. */
export interface AlternativesResponse {
  talkId: string;
  /** The window the alternatives overlap: the original talk's start and end. */
  window: { start: string; end: string };
  alternatives: AlternativeTalk[];
}
