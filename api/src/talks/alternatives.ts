import type { AlternativeTalk, AlternativesResponse, RelatedTalksResponse, Talk } from "@cc/shared";
import type { Db } from "../db/client.js";
import { runQuery } from "../search/errors.js";
import { TALK_COLUMNS } from "../search/queries.js";
import { getTalksByIds, toTalk, type TalkRow } from "../search/service.js";

/** Tracks that are not regular sessions (hands-on contribution workshops); never suggested as a swap. */
export const NON_SESSION_TRACKS = ["Contribfest"] as const;
export const DEFAULT_ALTERNATIVES = 3;
export const MAX_ALTERNATIVES = 10;

const COLUMNS = TALK_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ");

/**
 * Talks that overlap the original's time window in another room, ranked by
 * cosine similarity of the stored embeddings ($1 focus talk id, $2 excluded
 * tracks, $3 size). Overlap means start < original.end and end > original.start.
 * Score is the cosine similarity (1 = identical direction).
 */
export const ALTERNATIVES_SQL = `
  select ${COLUMNS}, 1 - (t.embedding <=> f.embedding) as score
  from talks f join talks t on t.id <> f.id
  where f.id = $1 and f.embedding is not null and t.embedding is not null
    and t.start_at < f.end_at and t.end_at > f.start_at
    and (coalesce(f.room, '') = '' or t.room is distinct from f.room)
    and not (t.track = any($2::text[]))
  order by t.embedding <=> f.embedding, t.id
  limit $3`;

/** Related talks: the same similarity ranking, at any time, excluding only the talk itself and non-session tracks. */
export const RELATED_SQL = `
  select ${COLUMNS}, 1 - (t.embedding <=> f.embedding) as score
  from talks f join talks t on t.id <> f.id
  where f.id = $1 and f.embedding is not null and t.embedding is not null
    and not (t.track = any($2::text[]))
  order by t.embedding <=> f.embedding, t.id
  limit $3`;

export function sharedTags(a: Talk, b: Talk): string[] {
  const mine = new Set(a.tags);
  return b.tags.filter((t) => mine.has(t));
}

type ScoredRow = TalkRow & { score: number | string };

async function similar(db: Db, sql: string, talkId: string, size: number): Promise<{ talk: Talk; score: number }[]> {
  const rows = await runQuery<ScoredRow>(db, sql, [talkId, [...NON_SESSION_TRACKS], size]);
  return rows.map((r) => ({ talk: toTalk(r), score: Number(r.score) }));
}

/** Returns undefined when the talk does not exist. */
export async function findAlternatives(db: Db, talkId: string, size: number): Promise<AlternativesResponse | undefined> {
  const [talk] = await getTalksByIds(db, [talkId]);
  if (!talk) return undefined;
  // Without a time window there is nothing to overlap.
  if (!talk.start || !talk.end) return { talkId: talk.id, window: { start: talk.start, end: talk.end }, alternatives: [] };
  const alternatives: AlternativeTalk[] = (await similar(db, ALTERNATIVES_SQL, talk.id, size))
    // Defence in depth: the SQL already does this, but never suggest the talk itself or a same-room talk.
    .filter((a) => a.talk.id !== talk.id && !(talk.room && a.talk.room === talk.room))
    .slice(0, size)
    .map((a) => ({ ...a, sharedTags: sharedTags(talk, a.talk) }));
  return { talkId: talk.id, window: { start: talk.start, end: talk.end }, alternatives };
}

export const DEFAULT_RELATED = 5;

/** Talks on similar topics at any time, most similar first. Undefined when the talk does not exist. */
export async function findRelated(db: Db, talkId: string, size: number): Promise<RelatedTalksResponse | undefined> {
  const [talk] = await getTalksByIds(db, [talkId]);
  if (!talk) return undefined;
  const related: AlternativeTalk[] = (await similar(db, RELATED_SQL, talk.id, size))
    .filter((r) => r.talk.id !== talk.id)
    .slice(0, size)
    .map((r) => ({ ...r, sharedTags: sharedTags(talk, r.talk) }));
  return { talkId: talk.id, related };
}

/** One talk by id; undefined when it does not exist. */
export async function findTalk(db: Db, talkId: string): Promise<Talk | undefined> {
  return (await getTalksByIds(db, [talkId]))[0];
}
