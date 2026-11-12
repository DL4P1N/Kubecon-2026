import type { Suggestion } from "@cc/shared";
import type { Db } from "../db/client.js";
import { runQuery } from "../search/errors.js";

export const MIN_SUGGEST_CHARS = 2;
export const MAX_SUGGEST_CHARS = 100;
export const MAX_SUGGESTIONS = 8;
/** Talks fetched per request; several can share a speaker, so this is above MAX_SUGGESTIONS. */
const FETCH_SIZE = 12;

/** Typed words that take part in matching (at most this many, so one request cannot build a huge predicate). */
const MAX_WORDS = 8;
/** Typo tolerance: pg_trgm word_similarity of a whole typed word against the title; only words this long are fuzzy-matched. */
const FUZZY_MIN_LENGTH = 5;
const FUZZY_THRESHOLD = 0.45;

/**
 * Search-as-you-type statement. Each typed word counts when it starts a word of
 * the title or speaker (completion, so the last word may be unfinished) or, for
 * words of at least 4 letters, is close to a title word by trigram similarity
 * (e.g. "kuberentes" -> "Kubernetes"). Talks matching more words rank first;
 * title matches weigh double. Words are plain letters and digits, so the LIKE
 * patterns hold no wildcards.
 */
export const SUGGEST_SQL = `
  select id, title, speaker from (
    select t.id, t.title, t.speaker,
      (select count(*) from unnest($1::text[]) w where (' ' || lower(t.title)) like '% ' || w || '%') as title_hits,
      (select count(*) from unnest($1::text[]) w where (' ' || lower(t.speaker)) like '% ' || w || '%') as speaker_hits,
      (select coalesce(max(word_similarity(w, t.title)), 0) from unnest($1::text[]) w where length(w) >= ${FUZZY_MIN_LENGTH}) as fuzzy
    from talks t
  ) s
  where title_hits + speaker_hits > 0 or fuzzy >= ${FUZZY_THRESHOLD}
  order by 2 * title_hits + speaker_hits + 0.5 * fuzzy desc, title, id
  limit ${FETCH_SIZE}`;

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_SUGGEST_CHARS);

/** A speaker is suggested when one of the typed words starts one of their name's words. */
function speakerMatches(speaker: string, q: string): boolean {
  const name = words(speaker);
  return words(q).some((w) => name.some((n) => n.startsWith(w)));
}

export async function suggest(db: Db, q: string): Promise<Suggestion[]> {
  const typed = [...new Set(words(q))].slice(0, MAX_WORDS);
  if (typed.length === 0) return [];
  const rows = await runQuery<{ id: string; title: string; speaker: string | null }>(db, SUGGEST_SQL, [typed]);
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (kind: Suggestion["kind"], text: string) => {
    const key = `${kind}|${text.toLowerCase()}`;
    if (!text || seen.has(key) || out.length >= MAX_SUGGESTIONS) return;
    seen.add(key);
    out.push({ kind, text });
  };
  for (const t of rows) {
    add("title", t.title);
    if (speakerMatches(t.speaker ?? "", q)) add("speaker", t.speaker ?? "");
  }
  return out;
}
