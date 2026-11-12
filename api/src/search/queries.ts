import { EVENT_UTC_OFFSET, type ExperienceLevel, type OnboardingAnswers } from "@cc/shared";
import { tokenize } from "../embed/hash.js";

/** Columns of `talks` the API returns (never the vector or the generated tsvector). */
export const TALK_COLUMNS = "id, title, abstract, speaker, track, level, room, start_at, end_at, tags";

export const RANK_WINDOW_SIZE = 50;
export const RANK_CONSTANT = 60;

/**
 * Knobs for how the SQL is built. Production uses DEFAULT_TUNING; the offline
 * eval (scripts/search-eval.ts) passes variants to measure them.
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
  /**
   * Keyword leg term semantics. "any" (default, like the old BM25 `multi_match`
   * OR) matches talks containing at least one query term, ranking talks with
   * more terms higher; "all" is Postgres' `websearch_to_tsquery` AND.
   */
  keywordMatch?: "any" | "all";
  /**
   * Typo tolerance on the keyword leg (both modes): pg_trgm `word_similarity`
   * of each query word against title and tags must reach this value (0..1) for
   * the talk to match. Unset means exact (stemmed) matching only.
   */
  fuzzyThreshold?: number;
  /**
   * Whether both retrieval legs receive the curated attendee-vocabulary
   * expansion of the query text (#52). The text is expanded once and both legs
   * rank the same string; an ablation under an earlier (rejected) rule set found
   * semantic-leg-only expansion far weaker than both legs, so the default
   * applies it to both.
   */
  queryExpansion?: "off" | "both";
}

/**
 * Attendee phrasing that does not share vocabulary with the talk catalog.
 * Applied term-wise to every query; triggers are single terms or catalog
 * phrases, never wording taken from the judged eval questions. Measured live on
 * the 417-talk index (docs/evidence/search-eval-52.md): held-out 8 questions
 * hybrid hit@3 3/8 -> 6/8, MRR@10 0.215 -> 0.642; the 12 tuned questions
 * 4/12 -> 6/12, 0.313 -> 0.500. No per-query regression on either set.
 */
const QUERY_EXPANSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bpager\b|\bon-?call\b|\balert(?:s|ing)?\b/i, "on-call incident response alert triage"],
  [/\bbackups?\b|\brestor(?:e|ed|ing)\b|\brecover(?:y|ed)?\b/i, "backup restore disaster recovery velero"],
  [/\bgpus?\b/i, "GPU sharing time-slicing DRA"],
  [/\bcanary\b|\brollout\b|\bprogressive delivery\b/i, "canary progressive delivery rollout"],
  [/\bfinops\b|\bcost\b|\bspend(?:ing)?\b|\bbill\b/i, "kubernetes cost optimization finops opencost"],
  [/\bsupply chain\b|\battestation\b|\bprovenance\b|\bsbom\b/i,
    "supply chain security attestation sigstore sbom in-toto"],
  [/\bsandbox(?:es|ed|ing)?\b|\buntrusted\b/i, "agent sandbox isolation runtime untrusted"],
  [/\bnetwork polic(?:y|ies)\b|\bnetworkpolicy\b/i, "network policy cilium ebpf"],
  [/\bsecrets?\b|\bpasswords?\b|\bcredentials?\b/i, "kubernetes secrets rotation external secrets"],
  [/\bautoscal(?:e|er|ing)\b/i, "autoscaling HPA KEDA"],
  [/\bimage pull\b|\bpull time\b|\bdownload(?:ing)? (?:the )?image\b/i,
    "container image pull latency startup"],
  [/\brbac\b|\bauthoriz(?:ed|ation)\b/i, "kubernetes authorization RBAC OPA policy"],
  [/\brag\b|\bprivate (?:data|documents)\b/i,
    "RAG retrieval augmented generation self-hosted LLM vector search"],
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
  keywordMatch: "any",
  fuzzyThreshold: 0.45,
  queryExpansion: "both",
};

export interface SearchFilters {
  levels?: ExperienceLevel[];
  /** Talk must start at or after this ISO timestamp. */
  from?: string;
  /** Talk must end at or before this ISO timestamp. */
  to?: string;
  /** Talk track must be one of these (exact match). */
  tracks?: string[];
  /** Talk must start on this local conference day (`YYYY-MM-DD`, EVENT_UTC_OFFSET). */
  day?: string;
}

/** A parameterised statement. `text` holds `$n` placeholders only; user input lives in `params`. */
export interface SqlQuery {
  text: string;
  params: unknown[];
}

/** Levels worth showing to someone of the given experience: their own and one step up. */
const LEVELS_FOR: Record<ExperienceLevel, ExperienceLevel[]> = {
  beginner: ["beginner", "intermediate"],
  intermediate: ["intermediate", "advanced"],
  advanced: ["intermediate", "advanced"],
};

export function levelsFor(experience: ExperienceLevel): ExperienceLevel[] {
  return LEVELS_FOR[experience];
}

/** Collects parameters and hands out their `$n` placeholders. */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown, cast = ""): string {
    this.values.push(value);
    return `$${this.values.length}${cast}`;
  }
}

/** Midnight of a local conference day, and 24 h later, as ISO instants (fixed EVENT_UTC_OFFSET, no DST). */
export function dayBounds(day: string): { start: string; end: string } {
  const start = new Date(`${day}T00:00:00${EVENT_UTC_OFFSET}`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

/** WHERE conditions (on alias `t`) for level, time window, track, day and the tuning's track exclusion. */
export function eligibilityConditions(p: Params, f: SearchFilters = {}, tuning: SearchTuning = DEFAULT_TUNING): string[] {
  const c: string[] = [];
  if (f.levels && f.levels.length > 0) c.push(`t.level = any(${p.add(f.levels, "::text[]")})`);
  if (f.from) c.push(`t.start_at >= ${p.add(f.from, "::timestamptz")}`);
  if (f.to) c.push(`t.end_at <= ${p.add(f.to, "::timestamptz")}`);
  if (f.tracks && f.tracks.length > 0) c.push(`t.track = any(${p.add(f.tracks, "::text[]")})`);
  if (f.day) {
    const { start, end } = dayBounds(f.day);
    c.push(`t.start_at >= ${p.add(start, "::timestamptz")} and t.start_at < ${p.add(end, "::timestamptz")}`);
  }
  if (tuning.excludeTracks.length > 0) c.push(`not (t.track = any(${p.add([...tuning.excludeTracks], "::text[]")}))`);
  return c;
}

/** Text both retrieval legs rank, with the attendee-vocabulary bridge when enabled. */
export function expandedText(text: string, tuning: SearchTuning = DEFAULT_TUNING): string {
  return tuning.queryExpansion === "both" ? expandQueryText(text) : text;
}

const MAX_FUZZY_TERMS = 12;
const MIN_FUZZY_TERM_LENGTH = 5;

/** Distinct content words worth a typo-tolerant lookup (stopwords and very short words never are). */
export function fuzzyTerms(text: string): string[] {
  return [...new Set(tokenize(text).filter((w) => w.length >= MIN_FUZZY_TERM_LENGTH))].slice(0, MAX_FUZZY_TERMS);
}

/**
 * ts_rank_cd weights, {D, C, B, A}: abstract, speaker, tags, title. Mirrors the
 * old multi_match boosts title^3, tags^2, abstract^1 (speaker was only in the
 * catch-all field, so it counts least).
 */
const RANK_WEIGHTS = "{0.3, 0.2, 0.67, 1.0}";
/** Fuzzy matches add this share of their similarity to the score, so exact stems always lead. */
const FUZZY_WEIGHT = 0.3;

/**
 * Keyword leg as a CTE body: `id, score` for every eligible talk matching the
 * text, best first. Exact stems come from the weighted `fts` tsvector; typos
 * come from pg_trgm word similarity of each query word against the title and
 * the tags.
 */
function keywordLeg(p: Params, text: string, filters: SearchFilters, tuning: SearchTuning): string {
  const t = p.add(text);
  const rawQuery = `websearch_to_tsquery('english', ${t})`;
  const tsq =
    tuning.keywordMatch === "all"
      ? rawQuery
      // websearch_to_tsquery already stemmed the lexemes: re-parse with 'simple' so they are not stemmed twice.
      : `to_tsquery('simple', replace(${rawQuery}::text, '&', '|'))`;
  const where = eligibilityConditions(p, filters, tuning);
  const terms = tuning.fuzzyThreshold !== undefined ? fuzzyTerms(text) : [];
  let scoreExpr = `ts_rank_cd('${RANK_WEIGHTS}', t.fts, ${tsq}, 32)`;
  let match = `t.fts @@ ${tsq}`;
  if (terms.length > 0) {
    const ts = p.add(terms, "::text[]");
    const th = p.add(tuning.fuzzyThreshold);
    const fuzzy =
      `coalesce((select max(greatest(word_similarity(w, t.title), word_similarity(w, immutable_array_to_string(t.tags, ' '))))` +
      ` from unnest(${ts}) as w), 0)`;
    scoreExpr += ` + ${FUZZY_WEIGHT} * case when ${fuzzy} >= ${th}::real then ${fuzzy} else 0 end`;
    match = `(${match} or ${fuzzy} >= ${th}::real)`;
  }
  return `select t.id, (${scoreExpr}) as score from talks t where ${[match, ...where].join(" and ")}`;
}

/** Semantic leg: nearest talks by cosine distance to the query vector (`distance`, smaller is closer). */
function semanticLeg(p: Params, qvec: string, filters: SearchFilters, tuning: SearchTuning, window: number): string {
  const v = p.add(qvec, "::vector");
  const where = ["t.embedding is not null", ...eligibilityConditions(p, filters, tuning)];
  return `select t.id, (t.embedding <=> ${v}) as distance from talks t where ${where.join(" and ")} order by distance, t.id limit ${window}`;
}

export interface SearchPlan {
  /** Ranked page of hits: talk columns, `score`, `in_keyword`, `in_semantic`. */
  hits: SqlQuery;
  /** Candidate ids behind the hits (`id`): what the facets count. */
  candidates: SqlQuery;
  /** CTE prefix shared by `hits` and facet statements, ending with a `cand` CTE (`id`). */
  withClause: string;
  params: unknown[];
}

const intLiteral = (n: number) => String(Math.max(1, Math.floor(n)));

/**
 * Plain keyword search over title/tags/abstract: stemmed full text plus typo
 * tolerance, ranked by ts_rank_cd. Every eligible match is a candidate; `size` caps the page.
 */
export function buildKeywordPlan(text: string, size: number, filters: SearchFilters = {}, tuning: SearchTuning = DEFAULT_TUNING): SearchPlan {
  const p = new Params();
  const withClause = `with kw as (${keywordLeg(p, expandedText(text, tuning), filters, tuning)}), cand as (select id from kw)`;
  const hits =
    `${withClause} select ${prefixed("t")}, kw.score as score, true as in_keyword, false as in_semantic ` +
    `from kw join talks t on t.id = kw.id order by kw.score desc, t.id limit ${intLiteral(size)}`;
  return { hits: { text: hits, params: p.values }, candidates: { text: `${withClause} select id from cand`, params: p.values }, withClause, params: p.values };
}

/**
 * Hybrid search in one statement: a keyword leg and a semantic leg, each over the
 * eligible talks and limited to the rank window, fused by reciprocal rank fusion
 * (or min-max-normalized weighted sum for `linear`). `qvec` is the pgvector text
 * of the embedded query.
 */
export function buildHybridPlan(
  text: string,
  qvec: string,
  size: number,
  filters: SearchFilters = {},
  tuning: SearchTuning = DEFAULT_TUNING,
): SearchPlan {
  const p = new Params();
  const window = Math.max(tuning.rankWindowSize, size);
  const kwSql = keywordLeg(p, expandedText(text, tuning), filters, tuning);
  const semSql = semanticLeg(p, qvec, filters, tuning, window);
  const kwRank = `kw as (select id, score, row_number() over (order by score desc, id) as rnk from (${kwSql}) s order by score desc, id limit ${window})`;
  const semRank = `sem as (select id, 1 - distance as score, row_number() over (order by distance, id) as rnk from (${semSql}) s)`;
  // Only parameters the statement references are bound (Postgres rejects unused ones as untyped).
  let fusedScore: string;
  if (tuning.fusion === "linear") {
    const w = p.add(tuning.semanticWeight, "::float8");
    fusedScore = `coalesce(${norm("kw")}, 0) + ${w} * coalesce(${norm("sem")}, 0)`;
  } else {
    const k = p.add(tuning.rankConstant, "::float8");
    fusedScore = `coalesce(1.0 / (${k} + kw.rnk), 0) + coalesce(1.0 / (${k} + sem.rnk), 0)`;
  }
  const fused =
    `cand as (select coalesce(kw.id, sem.id) as id, (${fusedScore}) as score, ` +
    `kw.id is not null as in_keyword, sem.id is not null as in_semantic from kw full join sem on kw.id = sem.id)`;
  const withClause = `with ${kwRank}, ${semRank}, ${fused}`;
  const hits =
    `${withClause} select ${prefixed("t")}, cand.score as score, cand.in_keyword, cand.in_semantic ` +
    `from cand join talks t on t.id = cand.id order by cand.score desc, t.id limit ${intLiteral(size)}`;
  return { hits: { text: hits, params: p.values }, candidates: { text: `${withClause} select id from cand`, params: p.values }, withClause, params: p.values };
}

/** Min-max normalisation of a leg's score over its window; a leg whose scores are all equal normalises to 1. */
function norm(leg: "kw" | "sem"): string {
  return `case when max(${leg}.score) over () = min(${leg}.score) over () then 1.0 else (${leg}.score - min(${leg}.score) over ()) / (max(${leg}.score) over () - min(${leg}.score) over ()) end`;
}

function prefixed(alias: string): string {
  return TALK_COLUMNS.split(", ").map((c) => `${alias}.${c}`).join(", ");
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
