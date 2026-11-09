import type { AlternativeTalk, AlternativesResponse, RelatedTalksResponse, Talk } from "@cc/shared";
import type { EsClient } from "../es/client.js";
import { SEMANTIC_FIELD, SOURCE_FIELDS, TALKS_INDEX, type EsBody } from "../search/queries.js";
import { getTalksByIds, toTalk } from "../search/service.js";

/** Tracks that are not regular sessions (hands-on contribution workshops); never suggested as a swap. */
export const NON_SESSION_TRACKS = ["Contribfest"] as const;
export const DEFAULT_ALTERNATIVES = 3;
export const MAX_ALTERNATIVES = 10;
/** Enough of the abstract to carry the topic without sending a whole page to the inference endpoint. */
const MAX_ABSTRACT_CHARS = 600;

/** Text used as the semantic query: the talk's own title and the start of its abstract. */
export function similarityText(talk: Talk): string {
  return `${talk.title}. ${talk.abstract.slice(0, MAX_ABSTRACT_CHARS)}`.trim();
}

/**
 * ES body: talks that overlap the original's time window in another room,
 * ranked by semantic similarity to the original (embedding of the query text
 * happens inside Elasticsearch via the semantic_text inference endpoint).
 * Overlap means start < original.end and end > original.start.
 */
export function buildAlternativesBody(talk: Talk, size: number): EsBody {
  return {
    size,
    _source: SOURCE_FIELDS,
    query: {
      bool: {
        must: [{ semantic: { field: SEMANTIC_FIELD, query: similarityText(talk) } }],
        filter: [
          { range: { start: { lt: talk.end } } },
          { range: { end: { gt: talk.start } } },
        ],
        must_not: [
          { term: { id: talk.id } },
          ...(talk.room ? [{ term: { room: talk.room } }] : []),
          { terms: { track: [...NON_SESSION_TRACKS] } },
        ],
      },
    },
  };
}

/**
 * ES body for related talks: the same semantic query as the alternatives, but
 * at any time, excluding only the talk itself and non-session tracks.
 */
export function buildRelatedBody(talk: Talk, size: number): EsBody {
  return {
    size,
    _source: SOURCE_FIELDS,
    query: {
      bool: {
        must: [{ semantic: { field: SEMANTIC_FIELD, query: similarityText(talk) } }],
        must_not: [{ term: { id: talk.id } }, { terms: { track: [...NON_SESSION_TRACKS] } }],
      },
    },
  };
}

export function sharedTags(a: Talk, b: Talk): string[] {
  const mine = new Set(a.tags);
  return b.tags.filter((t) => mine.has(t));
}

interface EsHit {
  _id: string;
  _score: number | null;
  _source?: Record<string, unknown>;
}

/** Returns undefined when the talk does not exist. */
export async function findAlternatives(es: EsClient, talkId: string, size: number): Promise<AlternativesResponse | undefined> {
  const [talk] = await getTalksByIds(es, [talkId]);
  if (!talk) return undefined;
  const res = await es.request<{ hits: { hits: EsHit[] } }>("POST", `/${TALKS_INDEX}/_search`, buildAlternativesBody(talk, size));
  const alternatives: AlternativeTalk[] = res.body.hits.hits
    // Defence in depth: the filter already does this, but never suggest the talk itself or a same-room talk.
    .map((h) => ({ talk: toTalk(h._id, h._source ?? {}), score: h._score ?? 0 }))
    .filter((a) => a.talk.id !== talk.id && a.talk.room !== talk.room)
    .slice(0, size)
    .map((a) => ({ ...a, sharedTags: sharedTags(talk, a.talk) }));
  return { talkId: talk.id, window: { start: talk.start, end: talk.end }, alternatives };
}

export const DEFAULT_RELATED = 5;

/** Talks on similar topics at any time, most similar first. Undefined when the talk does not exist. */
export async function findRelated(es: EsClient, talkId: string, size: number): Promise<RelatedTalksResponse | undefined> {
  const [talk] = await getTalksByIds(es, [talkId]);
  if (!talk) return undefined;
  const res = await es.request<{ hits: { hits: EsHit[] } }>("POST", `/${TALKS_INDEX}/_search`, buildRelatedBody(talk, size));
  const related: AlternativeTalk[] = res.body.hits.hits
    .map((h) => ({ talk: toTalk(h._id, h._source ?? {}), score: h._score ?? 0 }))
    .filter((r) => r.talk.id !== talk.id)
    .slice(0, size)
    .map((r) => ({ ...r, sharedTags: sharedTags(talk, r.talk) }));
  return { talkId: talk.id, related };
}

/** One talk by id; undefined when it does not exist. */
export async function findTalk(es: EsClient, talkId: string): Promise<Talk | undefined> {
  return (await getTalksByIds(es, [talkId]))[0];
}
