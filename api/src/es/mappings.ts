import type { EsClient } from "./client.js";
import { resolveInferenceId } from "./inference.js";

/**
 * Index definitions. Each logical index (alias) maps to a physical index named
 * `<alias>-v<SCHEMA_VERSION>`. Bump SCHEMA_VERSION whenever a mapping changes
 * (including the embedding dimension or inference endpoint); `ensureIndices`
 * then creates the new versioned index alongside the old one. Moving the alias
 * after a reindex is a manual step (documented in docs/elasticsearch.md).
 *
 * v1: talks had a client-side `embedding` dense_vector (local hashed embedder).
 * v2: talks use a `semantic_text` field, `content_semantic`, embedded by
 *     Elasticsearch at index time; `embedding` is gone.
 */
export const SCHEMA_VERSION = 2;

export const INDEX_NAMES = ["talks", "attendees", "schedules", "entitlements", "interest_clusters"] as const;
export type IndexAlias = (typeof INDEX_NAMES)[number];

export function physicalName(alias: IndexAlias, version = SCHEMA_VERSION): string {
  return `${alias}-v${version}`;
}

type Properties = Record<string, unknown>;

const textWithKeyword = { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } };

function denseVector(dims: number) {
  return { type: "dense_vector", dims, index: true, similarity: "cosine" };
}

/**
 * `inferenceId` is the endpoint behind `talks.content_semantic` (ES_INFERENCE_ID,
 * default `.multilingual-e5-small-elasticsearch`). `dims` sizes the
 * client-produced dense_vector fields (attendees, interest_clusters).
 */
export function buildMappings(dims: number, inferenceId: string = resolveInferenceId()): Record<IndexAlias, Properties> {
  return {
    talks: {
      id: { type: "keyword" },
      // title and abstract (in that order) feed both BM25 (all_text) and the
      // semantic_text field, so seeding never sends vectors.
      title: { ...textWithKeyword, copy_to: ["all_text", "content_semantic"] },
      abstract: { type: "text", copy_to: ["all_text", "content_semantic"] },
      speaker: { ...textWithKeyword, copy_to: "all_text" },
      track: { type: "keyword" },
      level: { type: "keyword" },
      room: { type: "keyword" },
      start: { type: "date" },
      end: { type: "date" },
      tags: { type: "keyword", copy_to: "all_text" },
      all_text: { type: "text" },
      content_semantic: { type: "semantic_text", inference_id: inferenceId },
    },
    attendees: {
      id: { type: "keyword" },
      display_name: textWithKeyword,
      interests: { type: "keyword" },
      interest_vector: denseVector(dims),
      consent: {
        properties: {
          cluster_map: { type: "boolean" },
          qr_checkin: { type: "boolean" },
        },
      },
      created_at: { type: "date" },
      // Profiles are kept by default (NO_EXPIRY sentinel); ATTENDEE_RETENTION_HOURS=24 restores timed deletion.
      expires_at: { type: "date" },
    },
    schedules: {
      attendee_id: { type: "keyword" },
      talk_ids: { type: "keyword" },
      updated_at: { type: "date" },
      expires_at: { type: "date" },
    },
    entitlements: {
      attendee_id: { type: "keyword" },
      pass_type: { type: "keyword" },
      rooms: { type: "keyword" },
      updated_at: { type: "date" },
      expires_at: { type: "date" },
    },
    interest_clusters: {
      cluster_id: { type: "keyword" },
      run_id: { type: "keyword" },
      label: textWithKeyword,
      size: { type: "integer" },
      top_interests: { type: "keyword" },
      centroid: denseVector(dims),
      computed_at: { type: "date" },
    },
  };
}

export function indexBody(alias: IndexAlias, dims: number, inferenceId: string = resolveInferenceId()) {
  return {
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: {
      dynamic: "strict",
      _meta: { schema_version: SCHEMA_VERSION },
      properties: buildMappings(dims, inferenceId)[alias],
    },
  };
}

export interface EnsureResult {
  alias: IndexAlias;
  index: string;
  created: boolean;
}

/** Create any missing versioned indices. Safe to run repeatedly. */
export async function ensureIndices(
  es: EsClient,
  dims: number,
  inferenceId: string = resolveInferenceId(),
): Promise<EnsureResult[]> {
  const results: EnsureResult[] = [];
  for (const alias of INDEX_NAMES) {
    const index = physicalName(alias);
    const head = await es.request("HEAD", `/${index}`, undefined, [404]);
    if (head.status === 200) {
      results.push({ alias, index, created: false });
      continue;
    }
    const aliasHead = await es.request("HEAD", `/_alias/${alias}`, undefined, [404]);
    const body: Record<string, unknown> = indexBody(alias, dims, inferenceId);
    // Only claim the alias when nothing owns it yet, so a newer version never
    // steals it before data has been reindexed.
    if (aliasHead.status === 404) body.aliases = { [alias]: {} };
    try {
      await es.request("PUT", `/${index}`, body);
    } catch (err) {
      // Lost a race with another starter: that's fine.
      if ((err as { status?: number }).status === 400 && String(err).includes("resource_already_exists")) {
        results.push({ alias, index, created: false });
        continue;
      }
      throw err;
    }
    results.push({ alias, index, created: true });
  }
  return results;
}
