import type { Embedder } from "./embedder.js";

/** Size of the hashed fallback vectors; equals the schema's vector columns so both providers fit one table. */
export const DEFAULT_HASH_DIMS = 384;

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

/** Offline, deterministic, keyless. Lexical quality only; used by tests and `EMBEDDINGS_PROVIDER=local`. */
export class LocalHashEmbedder implements Embedder {
  readonly provider = "local";
  constructor(readonly dims: number = DEFAULT_HASH_DIMS) {}
  async embed(text: string): Promise<number[]> {
    return hashEmbed(text, this.dims);
  }
}
