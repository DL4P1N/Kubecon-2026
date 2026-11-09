import type { ExperienceLevel, OnboardingAnswers } from "@cc/shared";

/** Alias of the talks index (see api/src/es/mappings.ts). */
export const TALKS_INDEX = "talks";
/** `semantic_text` field filled by Elasticsearch built-in inference (task #19). */
export const SEMANTIC_FIELD = "content_semantic";

export const KEYWORD_FIELDS = ["title^3", "tags^2", "abstract"] as const;
export const SOURCE_FIELDS = [
  "id", "title", "abstract", "speaker", "speakers", "track", "level", "room", "start", "end", "tags",
];

/** Retriever names; they come back in `matched_queries` and map to SearchLeg. */
export const LEG_KEYWORD = "keyword";
export const LEG_SEMANTIC = "semantic";

export const RANK_WINDOW_SIZE = 50;
export const RANK_CONSTANT = 60;

export interface SearchFilters {
  levels?: ExperienceLevel[];
  /** Talk must start at or after this ISO timestamp. */
  from?: string;
  /** Talk must end at or before this ISO timestamp. */
  to?: string;
}

export type EsBody = Record<string, unknown>;

/** Levels worth showing to someone of the given experience: their own and one step up. */
const LEVELS_FOR: Record<ExperienceLevel, ExperienceLevel[]> = {
  beginner: ["beginner", "intermediate"],
  intermediate: ["intermediate", "advanced"],
  advanced: ["intermediate", "advanced"],
};

export function levelsFor(experience: ExperienceLevel): ExperienceLevel[] {
  return LEVELS_FOR[experience];
}

/** Bool-filter clauses for level and time windows. */
export function filterClauses(f: SearchFilters = {}): object[] {
  const clauses: object[] = [];
  if (f.levels && f.levels.length > 0) clauses.push({ terms: { level: f.levels } });
  if (f.from) clauses.push({ range: { start: { gte: f.from } } });
  if (f.to) clauses.push({ range: { end: { lte: f.to } } });
  return clauses;
}

function keywordQuery(text: string) {
  return {
    multi_match: {
      query: text,
      fields: [...KEYWORD_FIELDS],
      type: "best_fields",
      _name: LEG_KEYWORD,
    },
  };
}

/** Plain BM25 multi_match over title/abstract/tags, filters applied. */
export function buildKeywordBody(text: string, size: number, filters: SearchFilters = {}): EsBody {
  return {
    size,
    _source: SOURCE_FIELDS,
    query: { bool: { must: [keywordQuery(text)], filter: filterClauses(filters) } },
  };
}

/**
 * Hybrid body: an RRF retriever fusing a BM25 `standard` retriever with a
 * `standard` retriever running a `semantic` query on `content_semantic`.
 * Embedding of the query text happens inside Elasticsearch (inference
 * endpoint attached to the semantic_text field), not in this service.
 * Filters are repeated on each leg so both only rank eligible talks.
 */
export function buildHybridBody(text: string, size: number, filters: SearchFilters = {}): EsBody {
  const filter = filterClauses(filters);
  return {
    size,
    _source: SOURCE_FIELDS,
    retriever: {
      rrf: {
        retrievers: [
          {
            standard: {
              _name: LEG_KEYWORD,
              query: { bool: { must: [keywordQuery(text)], filter } },
            },
          },
          {
            standard: {
              _name: LEG_SEMANTIC,
              query: { bool: { must: [{ semantic: { field: SEMANTIC_FIELD, query: text } }], filter } },
            },
          },
        ],
        rank_window_size: Math.max(RANK_WINDOW_SIZE, size),
        rank_constant: RANK_CONSTANT,
      },
    },
  };
}

/** Turn onboarding answers into query text (topics, goals, then free text). */
export function onboardingText(a: OnboardingAnswers): string {
  return [...(a.topics ?? []), ...(a.goals ?? []), a.freeText ?? ""]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

export function onboardingFilters(a: OnboardingAnswers): SearchFilters {
  return {
    levels: a.experience ? levelsFor(a.experience) : undefined,
    from: a.availableFrom,
    to: a.availableTo,
  };
}
