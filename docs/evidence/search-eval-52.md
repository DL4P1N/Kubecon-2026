# Search relevance after attendee-vocabulary expansion (task #52)

Measured 2026-11-09 on the live `kind-conference-companion` cluster.

- Index: `talks` alias, **417 real KubeCon NA 2026 sessions**, ES 8.19.6 with the
  `.multilingual-e5-small-elasticsearch` inference endpoint (`semantic_text`).
- Harness: `scripts/search-eval.ts`, the committed `EVAL_SET` of 12 hand-judged
  paraphrased attendee questions, `size=10`. Judgments and relevant ids are
  unchanged; nothing was tuned to the ground truth.
- Command: `npx tsx scripts/search-eval.ts --variants pre-expansion,current`
  with the application's `companion_svc` credentials over CA-validated HTTPS.

## Result

| variant | keyword hit@3 | hybrid hit@3 | keyword MRR@10 | hybrid MRR@10 | hybrid wins / ties / losses |
|---|---|---|---|---|---|
| `pre-expansion` (previous production) | 0/12 | 4/12 | 0.042 | 0.313 | 5 / 7 / 0 |
| `current` (this change) | **9/12** | **10/12** | **0.750** | **0.815** | 3 / 8 / 1 |

`current` adds one curated, term-level vocabulary bridge (`expandQueryText`)
applied once to the text both retrieval legs rank. It is general, not a
per-query lookup: eleven phrase rules covering supply-chain security, on-call
incident response, cost/rightsizing, authorization, private RAG, image-pull
startup latency, secrets hygiene, autoscaling, GPU sharing, agent sandboxes and
backup/restore.

## Honest boundaries

- **One hybrid-vs-keyword loss.** On the supply-chain query the expanded keyword
  leg ranks a judged talk first (RR 1.0) while the fused hybrid ranks it third
  (RR 0.333). Hybrid still leads on every aggregate metric, but it is not
  uniformly better per query.
- **Keyword mode improved a lot too** (0/12 to 9/12). The expansion is shared
  query understanding, not a hybrid-only trick, so the demo should present the
  improvement as "query understanding" and hybrid's remaining edge separately
  rather than claiming hybrid alone fixes these queries.
- **Expanding only the semantic leg was much weaker** (hybrid MRR 0.351,
  4/12 hit@3), which is why both legs receive the same expanded text.
- One short run on one catalog; no longitudinal or A/B traffic data.
- A cached-semantics trap in the harness was fixed alongside: keyword results
  were cached per excluded-track list, so variants differing only in fuzziness
  or expansion shared stale keyword results. The cache key is now the whole
  tuning object.

## Tuning variants that did not help

Fresh measurement of the existing variants on the same index: `rankConstant 20`
0.246, `minimum_should_match 30%` 0.125, `linear` fusion 0.097 (weight 1) and
0.139 (weight 2), `rankWindowSize 100` unchanged at 0.306. Fusion knobs were not
changed.
