import type { Suggestion } from "@cc/shared";
import type { EsClient } from "../es/client.js";
import { TALKS_INDEX, type EsBody } from "../search/queries.js";
import { toTalk } from "../search/service.js";

export const MIN_SUGGEST_CHARS = 2;
export const MAX_SUGGEST_CHARS = 100;
export const MAX_SUGGESTIONS = 8;
/** Talks fetched per request; several can share a speaker, so this is above MAX_SUGGESTIONS. */
const FETCH_SIZE = 12;

/**
 * Search-as-you-type body. A `bool_prefix` clause completes the last word and a
 * fuzzy `best_fields` clause forgives typos in whole words. Both run on the
 * existing analyzed `title` and `speaker` fields: no mapping change, no reindex.
 */
export function buildSuggestBody(q: string): EsBody {
  const fields = ["title^2", "speaker"];
  return {
    size: FETCH_SIZE,
    _source: ["id", "title", "speaker", "speakers"],
    query: {
      bool: {
        should: [
          // Completion: earlier words whole (fuzzy), last word as a prefix. Fuzziness never applies to the
          // last word here, so a finished-but-misspelled word is caught by the next clause.
          { multi_match: { query: q, type: "bool_prefix", fields, fuzziness: "AUTO", prefix_length: 1 } },
          // Typo tolerance for complete words, e.g. "kuberentes" -> "Kubernetes".
          { multi_match: { query: q, type: "best_fields", fields, fuzziness: "AUTO", prefix_length: 1 } },
        ],
        minimum_should_match: 1,
      },
    },
  };
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_SUGGEST_CHARS);

/** A speaker is suggested when one of the typed words starts one of their name's words. */
function speakerMatches(speaker: string, q: string): boolean {
  const name = words(speaker);
  return words(q).some((w) => name.some((n) => n.startsWith(w)));
}

export async function suggest(es: EsClient, q: string): Promise<Suggestion[]> {
  const res = await es.request<{ hits: { hits: { _id: string; _source?: Record<string, unknown> }[] } }>(
    "POST",
    `/${TALKS_INDEX}/_search`,
    buildSuggestBody(q),
  );
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (kind: Suggestion["kind"], text: string) => {
    const key = `${kind}|${text.toLowerCase()}`;
    if (!text || seen.has(key) || out.length >= MAX_SUGGESTIONS) return;
    seen.add(key);
    out.push({ kind, text });
  };
  for (const h of res.body.hits.hits) {
    const t = toTalk(h._id, h._source ?? {});
    add("title", t.title);
    if (speakerMatches(t.speaker, q)) add("speaker", t.speaker);
  }
  return out;
}
