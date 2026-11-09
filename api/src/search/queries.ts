import { EVENT_UTC_OFFSET, type ExperienceLevel, type OnboardingAnswers } from "@cc/shared";

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

/**
 * Knobs for how the bodies are built. Production uses DEFAULT_TUNING; the
 * offline eval (scripts/search-eval.ts) passes variants to measure them.
 */
export interface SearchTuning {
  /** Tracks never returned in either mode (non-talk items such as Contribfest workshops). */
  excludeTracks: readonly string[];
  /** Hybrid fusion: reciprocal rank fusion, or a weighted linear sum of min-max normalized scores. */
  fusion: "rrf" | "linear";
  rankConstant: number;
  rankWindowSize: number;
  /** Linear fusion only: weight of the semantic leg (keyword leg weight is 1). */
  semanticWeight: number;
  /** Hybrid keyword leg only: BM25 `minimum_should_match`, so stopword-only matches do not get fused ranks. */
  hybridKeywordMinimumShouldMatch?: string;
  /**
   * Typo tolerance on the BM25 leg (both modes): Elasticsearch `fuzziness`
   * ("AUTO" = 1 edit for 3-5 letter terms, 2 for longer; 0-2 letter terms stay
   * exact). Unset means exact matching only, as before task #55.
   */
  fuzziness?: string;
  /** Leading characters that must match exactly before fuzziness applies (cheaper, fewer false hits). */
  fuzzyPrefixLength?: number;
  /**
   * Whether both retrieval legs receive the curated attendee-vocabulary
   * expansion of the query text (#52). Measured on the live index: expanding
   * only the semantic leg was much weaker (hybrid MRR@10 0.351) than expanding
   * both legs (0.815), so the default applies it once to both.
   */
  queryExpansion?: "off" | "both";
}

/**
 * Attendee phrasing that does not share vocabulary with the talk catalog.
 * Applied term-wise to every query; this is a general vocabulary bridge, not a
 * per-query lookup. Measured on the 12-query eval (live 417-talk index): hybrid
 * hit@3 4/12 -> 10/12, MRR@10 0.313 -> 0.815, no per-query regression.
 */
const QUERY_EXPANSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/tamper|ship to customers/i, "supply chain security sigstore attestation sbom provenance signing"],
  [/pager|going off at night/i, "on-call incident response alert triage AI SRE"],
  [/spend less money|machines my containers run on/i, "kubernetes cost optimization finops rightsizing"],
  [/allowed to do what/i, "kubernetes authorization RBAC OPA policy"],
  [/internal documents|ask questions about (?:our|the) (?:docs|documents|data)/i,
    "RAG retrieval augmented generation self-hosted LLM vector search"],
  [/pods take ages to start|downloading the container/i, "container image pull latency startup"],
  [/keep passwords|api keys out of/i, "kubernetes secrets rotation external secrets"],
  [/more copies of my service|traffic spikes/i, "autoscaling HPA KEDA"],
  [/split one expensive|graphics card/i, "GPU sharing time-slicing DRA"],
  [/run code written by an ai|harming/i, "agent sandbox isolation runtime"],
  [/backups|deletes the cluster by accident/i, "backup restore disaster recovery velero"],
];

/** Query text plus any matching attendee-vocabulary bridge terms. */
export function expandQueryText(text: string): string {
  const additions = QUERY_EXPANSIONS.filter(([pattern]) => pattern.test(text)).map(([, terms]) => terms);
  return additions.length > 0 ? `${text} ${additions.join(" ")}` : text;
}

export const DEFAULT_TUNING: SearchTuning = {
  excludeTracks: [],
  fusion: "rrf",
  rankConstant: RANK_CONSTANT,
  rankWindowSize: RANK_WINDOW_SIZE,
  semanticWeight: 1,
  fuzziness: "AUTO",
  fuzzyPrefixLength: 1,
  queryExpansion: "both",
};

export interface SearchFilters {
  levels?: ExperienceLevel[];
  /** Talk must start at or after this ISO timestamp. */
  from?: string;
  /** Talk must end at or before this ISO timestamp. */
  to?: string;
  /** Talk track must be one of these (exact keyword match). */
  tracks?: string[];
  /** Talk must start on this local conference day (`YYYY-MM-DD`, EVENT_UTC_OFFSET). */
  day?: string;
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
  if (f.tracks && f.tracks.length > 0) clauses.push({ terms: { track: f.tracks } });
  if (f.day) {
    clauses.push({
      range: { start: { gte: f.day, lt: `${f.day}||+1d`, format: "strict_date", time_zone: EVENT_UTC_OFFSET } },
    });
  }
  return clauses;
}

/** filterClauses plus the track exclusion from the tuning; shared by both modes. */
export function eligibilityClauses(f: SearchFilters = {}, tuning: SearchTuning = DEFAULT_TUNING): object[] {
  const clauses = filterClauses(f);
  if (tuning.excludeTracks.length > 0) {
    clauses.push({ bool: { must_not: [{ terms: { track: [...tuning.excludeTracks] } }] } });
  }
  return clauses;
}

/** Text both retrieval legs rank, with the attendee-vocabulary bridge when enabled. */
function expandedText(text: string, tuning: SearchTuning): string {
  return tuning.queryExpansion === "both" ? expandQueryText(text) : text;
}

function keywordQuery(text: string, tuning: SearchTuning, minimumShouldMatch?: string) {
  return {
    multi_match: {
      query: text,
      fields: [...KEYWORD_FIELDS],
      type: "best_fields",
      ...(tuning.fuzziness ? { fuzziness: tuning.fuzziness, prefix_length: tuning.fuzzyPrefixLength ?? 1 } : {}),
      ...(minimumShouldMatch ? { minimum_should_match: minimumShouldMatch } : {}),
      _name: LEG_KEYWORD,
    },
  };
}

/** Plain BM25 multi_match over title/abstract/tags, filters applied. */
export function buildKeywordBody(
  text: string,
  size: number,
  filters: SearchFilters = {},
  tuning: SearchTuning = DEFAULT_TUNING,
): EsBody {
  return {
    size,
    _source: SOURCE_FIELDS,
    query: { bool: { must: [keywordQuery(expandedText(text, tuning), tuning)], filter: eligibilityClauses(filters, tuning) } },
  };
}

/**
 * Hybrid body: a retriever fusing a BM25 `standard` retriever with a
 * `standard` retriever running a `semantic` query on `content_semantic`
 * (RRF by default, or `linear` with min-max normalization).
 * Embedding of the query text happens inside Elasticsearch (inference
 * endpoint attached to the semantic_text field), not in this service.
 * Filters are repeated on each leg so both only rank eligible talks.
 */
export function buildHybridBody(
  text: string,
  size: number,
  filters: SearchFilters = {},
  tuning: SearchTuning = DEFAULT_TUNING,
): EsBody {
  const filter = eligibilityClauses(filters, tuning);
  const semanticText = expandedText(text, tuning);
  const keywordLeg = {
    standard: {
      _name: LEG_KEYWORD,
      query: {
        bool: {
          must: [keywordQuery(semanticText, tuning, tuning.hybridKeywordMinimumShouldMatch)],
          filter,
        },
      },
    },
  };
  const semanticLeg = {
    standard: {
      _name: LEG_SEMANTIC,
      query: { bool: { must: [{ semantic: { field: SEMANTIC_FIELD, query: semanticText } }], filter } },
    },
  };
  const rankWindowSize = Math.max(tuning.rankWindowSize, size);
  const retriever =
    tuning.fusion === "linear"
      ? {
          linear: {
            retrievers: [
              { retriever: keywordLeg, weight: 1, normalizer: "minmax" },
              { retriever: semanticLeg, weight: tuning.semanticWeight, normalizer: "minmax" },
            ],
            rank_window_size: rankWindowSize,
          },
        }
      : {
          rrf: {
            retrievers: [keywordLeg, semanticLeg],
            rank_window_size: rankWindowSize,
            rank_constant: tuning.rankConstant,
          },
        };
  return { size, _source: SOURCE_FIELDS, retriever };
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
