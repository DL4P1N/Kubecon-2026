import { loadConfig } from "../config.js";
import { createEsClient, type EsClient } from "./client.js";
import { DEFAULT_INFERENCE_DIMS, resolveInferenceId } from "./inference.js";

/**
 * Embedding helper. Talk vectors are NOT produced here: the `talks` index has a
 * `semantic_text` field (`content_semantic`) and Elasticsearch embeds title +
 * abstract at index time, so seeding sends text only.
 *
 * `embed()` is for the vectors the client still needs (attendee interest
 * vectors, cluster centroids) and is picked with EMBEDDINGS_PROVIDER:
 *   - "es-inference" (default): asks Elasticsearch to embed the text through the
 *     same dense inference endpoint (ES_INFERENCE_ID, default
 *     `.multilingual-e5-small-elasticsearch`, 384 dims) via
 *     `POST /_inference/text_embedding/<id>`. Needs a dense endpoint; a sparse
 *     one such as ELSER works for `semantic_text` but not for `embed()`.
 *   - "local": deterministic hashed bag-of-words, no network, no keys. Offline
 *     fallback and what the unit tests use. Lexical quality only.
 *
 * EMBEDDING_DIMS sets the vector size (default 384 for es-inference, 256 for
 * local). The `dense_vector` mappings on `attendees` and `interest_clusters`
 * use the same value, so changing it means bumping the index schema version
 * (see mappings.ts).
 */

export interface Embedder {
  readonly provider: string;
  readonly dims: number;
  embed(text: string): Promise<number[]>;
}

/** Default size of the local hashed embedder. */
export const DEFAULT_EMBEDDING_DIMS = 256;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in",
  "is", "it", "of", "on", "or", "our", "that", "the", "this", "to", "we", "with",
  "you", "your",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** 32-bit FNV-1a with a seed so we can derive independent bucket and sign hashes. */
function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Hashed bag-of-words: each token (and adjacent-token bigram, at lower weight)
 * adds +/-1 to one of `dims` buckets, then the vector is L2-normalised so
 * cosine similarity behaves. Deterministic and dependency free.
 */
export function hashEmbed(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);
  const add = (term: string, weight: number) => {
    const bucket = fnv1a(term, 0) % dims;
    const sign = fnv1a(term, 0x9e3779b9) & 1 ? 1 : -1;
    vec[bucket] += sign * weight;
  };
  tokens.forEach((t, i) => {
    add(t, 1);
    if (i > 0) add(`${tokens[i - 1]}_${t}`, 0.5);
  });
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    // Empty or all-stopword text: return a fixed unit vector (cosine needs non-zero).
    vec[0] = 1;
    return vec;
  }
  return vec.map((v) => v / norm);
}

export class LocalHashEmbedder implements Embedder {
  readonly provider = "local";
  constructor(readonly dims: number = DEFAULT_EMBEDDING_DIMS) {}
  async embed(text: string): Promise<number[]> {
    return hashEmbed(text, this.dims);
  }
}

/** Dense vectors from an Elasticsearch inference endpoint (text_embedding task). */
export class EsInferenceEmbedder implements Embedder {
  readonly provider = "es-inference";
  constructor(
    private readonly es: EsClient,
    private readonly inferenceId: string,
    readonly dims: number = DEFAULT_INFERENCE_DIMS,
  ) {}
  async embed(text: string): Promise<number[]> {
    const res = await this.es.request<{ text_embedding?: { embedding: number[] }[] }>(
      "POST",
      `/_inference/text_embedding/${encodeURIComponent(this.inferenceId)}`,
      { input: [text] },
    );
    const vec = res.body.text_embedding?.[0]?.embedding;
    if (!vec) {
      throw new Error(
        `Inference endpoint "${this.inferenceId}" returned no dense embedding; embed() needs a text_embedding endpoint (ELSER is sparse).`,
      );
    }
    if (vec.length !== this.dims) {
      throw new Error(`Inference endpoint returned ${vec.length} dims but EMBEDDING_DIMS is ${this.dims}.`);
    }
    return vec;
  }
}

function parseDims(env: NodeJS.ProcessEnv, dflt: number): number {
  const dims = Number(env.EMBEDDING_DIMS ?? dflt);
  if (!Number.isInteger(dims) || dims < 8 || dims > 4096) {
    throw new Error(`Invalid EMBEDDING_DIMS: ${env.EMBEDDING_DIMS}`);
  }
  return dims;
}

export const DEFAULT_PROVIDER = "es-inference";

/** `es` is only used by the es-inference provider; it defaults to a client built from the environment. */
export function createEmbedder(env: NodeJS.ProcessEnv = process.env, es?: EsClient): Embedder {
  const provider = (env.EMBEDDINGS_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  if (provider === "local") return new LocalHashEmbedder(parseDims(env, DEFAULT_EMBEDDING_DIMS));
  if (provider === "es-inference") {
    return new EsInferenceEmbedder(es ?? createEsClient(loadConfig(env)), resolveInferenceId(env), parseDims(env, DEFAULT_INFERENCE_DIMS));
  }
  throw new Error(
    `Unsupported EMBEDDINGS_PROVIDER "${provider}". Use "es-inference" (default) or "local"; add providers in api/src/es/embeddings.ts.`,
  );
}

let defaultEmbedder: Embedder | undefined;

/** Embed text with the provider configured in the environment. */
export function embed(text: string): Promise<number[]> {
  defaultEmbedder ??= createEmbedder();
  return defaultEmbedder.embed(text);
}

/** Vector size the configured provider produces (used for index mappings). */
export function embeddingDims(env: NodeJS.ProcessEnv = process.env): number {
  return createEmbedder(env).dims; // no network call: the embedder only talks to ES when embed() is used
}
