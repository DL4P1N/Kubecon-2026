/**
 * Embedding helper. Search and seed both go through `embed()` so vectors are
 * always produced the same way.
 *
 * Provider is picked with EMBEDDINGS_PROVIDER:
 *   - "local" (default): deterministic hashed bag-of-words, no network, no keys.
 *   - anything else: not implemented yet. Add a new `Embedder` below and
 *     register it in `createEmbedder`; the rest of the code does not change.
 *
 * EMBEDDING_DIMS sets the vector size for the local embedder (default 256).
 * The `dense_vector` mapping uses the same value, so changing it means bumping
 * the index schema version (see mappings.ts).
 */

export interface Embedder {
  readonly provider: string;
  readonly dims: number;
  embed(text: string): Promise<number[]>;
}

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

export function createEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder {
  const provider = (env.EMBEDDINGS_PROVIDER || "local").toLowerCase();
  if (provider === "local") {
    const dims = Number(env.EMBEDDING_DIMS ?? DEFAULT_EMBEDDING_DIMS);
    if (!Number.isInteger(dims) || dims < 8 || dims > 4096) {
      throw new Error(`Invalid EMBEDDING_DIMS: ${env.EMBEDDING_DIMS}`);
    }
    return new LocalHashEmbedder(dims);
  }
  throw new Error(
    `Unsupported EMBEDDINGS_PROVIDER "${provider}". Only "local" is implemented; add a provider in api/src/es/embeddings.ts.`,
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
  return createEmbedder(env).dims;
}
