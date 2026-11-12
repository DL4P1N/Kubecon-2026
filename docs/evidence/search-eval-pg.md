# Search relevance on Postgres + pgvector (Elasticsearch replaced)

Measured 2026-11-12 against the live Supabase database (read-only: SELECTs only), the
same **417 real KubeCon NA 2026 sessions** as `search-eval-52.md`, with the production
`multilingual-e5-small` embeddings (query side: `query: ` prefix; stored side: passages).
Harness: `scripts/search-heldout-eval.mts` and `scripts/search-eval.ts`
(`DATABASE_URL`, `DATABASE_CA_FILE`, `MODEL_CACHE_DIR`), which call the API's own
`runSearch`, so they measure what `GET /api/search` runs. Size 10.

## What changed in the ranking

| | Elasticsearch (#52) | Postgres |
|---|---|---|
| keyword leg | BM25 `multi_match` title^3, tags^2, abstract, OR of terms, `fuzziness AUTO` | `fts @@` OR-ed `websearch_to_tsquery` (stemmed), ranked by `ts_rank_cd` with weights title 1.0 / tags 0.67 / abstract 0.3 / speaker 0.2; plus pg_trgm `word_similarity >= 0.45` of each 5+ letter query word against title and tags (adds up to 0.3 to the score) |
| semantic leg | `semantic_text` inference in ES | `embedding <=> $qvec` (cosine), e5 query embedding computed in the API |
| fusion | ES `rrf`, k 60, window 50 | RRF k 60, window 50 in one SQL statement (two CTEs, full join); `linear` min-max kept as a tuning option |
| expansion | `expandQueryText` on both legs | unchanged |

## Result

Held-out set (8 questions, primary evidence):

| held-out (n=8) | keyword hit@3 | keyword MRR@10 | hybrid hit@3 | hybrid MRR@10 |
|---|---|---|---|---|
| expansion off | 3/8 | 0.292 | 4/8 | 0.358 |
| expansion on (shipped) | 5/8 | 0.542 | **6/8** | **0.713** |

Tuned set (12 questions, in-sample):

| tuned (n=12) | keyword hit@3 | keyword MRR@10 | hybrid hit@3 | hybrid MRR@10 |
|---|---|---|---|---|
| expansion off | 1/12 | 0.104 | 3/12 | 0.232 |
| expansion on (shipped) | 4/12 | 0.354 | **5/12** | **0.438** |

Hybrid on vs off: held-out 4 wins / 4 ties / 0 losses; tuned 3 / 9 / 0.

## Against Elasticsearch (`search-eval-52.md`)

| | ES hit@3 / MRR@10 | Postgres hit@3 / MRR@10 |
|---|---|---|
| held-out hybrid | 6/8, 0.642 | 6/8, 0.713 |
| held-out keyword | 4/8, 0.516 | 5/8, 0.542 |
| tuned hybrid | 6/12, 0.500 | 5/12, 0.438 |
| tuned keyword | 3/12, 0.208 | 4/12, 0.354 |

Held-out quality is equal or slightly better (same hit@3, higher MRR); the in-sample tuned
set is one question and 0.06 MRR worse in hybrid mode. Both sets are tiny, so these
differences are within noise, and the e5 encoder is a different runtime (in-process
instead of the ES inference endpoint), which also moves scores.

## Variants (tuned set, `npx tsx scripts/search-eval.ts --variants ...`)

Hybrid MRR@10 / hit@3 without expansion and with exact-only stemming (`baseline`)
0.228 / 3, `excl` (Contribfest excluded) 0.228 / 3, `excl-k20` 0.225 / 3, `excl-linear`
0.188 / 2, `excl-all-terms` (AND instead of OR keyword leg) 0.201 / 3, `pre-expansion`
(fuzzy, no expansion) 0.232 / 3, shipped `current` 0.438 / 5. As with ES, fusion knobs do
not help; OR-ing the terms beats websearch AND semantics (keyword mode drops to 0/12
with AND), which is why `keywordMatch` defaults to `"any"`.

## Boundaries

- Same 8 + 12 questions and author as the ES evidence: the claim is "equal on these
  judged paraphrases", not a general quality guarantee. No latency measurement was
  made against the remote database.
- Trigram typo tolerance is weaker than Lucene's Damerau fuzziness for short words, so
  only words of 5+ letters are fuzzed (e.g. `kuberentes`, a transposition, needs the
  0.45 threshold).
- Facet counts in hybrid mode cover the fused candidate window (keyword window plus the
  50 nearest talks), so they are close to catalog-wide counts; in keyword mode they
  count every match.
