# Search relevance after attendee-vocabulary expansion (task #52)

Measured 2026-11-09 on the live `kind-conference-companion` cluster. Machine-readable
copy: `docs/evidence/search-eval-52.json`.

- Index: `talks` alias, **417 real KubeCon NA 2026 sessions**, ES 8.19.6 with the
  `.multilingual-e5-small-elasticsearch` inference endpoint (`semantic_text`), size 10.
- Harness: `npx tsx scripts/search-heldout-eval.mts`, one clean process that runs
  keyword and hybrid with expansion off and on for both judged sets. The sets live in
  the side-effect-free `scripts/search-eval-set.ts` (tuned) and the harness itself
  (held-out); importing them no longer starts the full multi-variant eval.
- Credentials: the application's `companion_svc` user, process env only, over
  CA-validated HTTPS.

## Result

Held-out set: 8 questions written with different wording from the tuned set, judged
against the same catalog. No held-out question was used to write or revise a rule,
so this is the primary evidence.

| held-out (n=8) | keyword hit@3 | keyword MRR@10 | hybrid hit@3 | hybrid MRR@10 |
|---|---|---|---|---|
| expansion off | 0/8 | 0.016 | 3/8 | 0.215 |
| expansion on (shipped) | 4/8 | 0.516 | **6/8** | **0.642** |

Hybrid on vs off: 4 wins / 4 ties / 0 losses.

Tuned set: the 12 judged questions of #36 (`EVAL_SET`). These were read while the
rules were written, so treat them as in-sample.

| tuned (n=12) | keyword hit@3 | keyword MRR@10 | hybrid hit@3 | hybrid MRR@10 |
|---|---|---|---|---|
| expansion off | 0/12 | 0.042 | 4/12 | 0.313 |
| expansion on (shipped) | 3/12 | 0.208 | **6/12** | **0.500** |

Hybrid on vs off: 3 wins / 9 ties / 0 losses. Only three tuned questions contain a
trigger (pager, spend, passwords); each moves a relevant talk to hybrid #1, and the
other nine rank exactly as without expansion.

## What ships

`expandQueryText` in `api/src/search/queries.ts` appends catalog vocabulary when a
query contains an everyday term (pager/alert, backup/restore, gpu, canary/rollout,
cost/spend/bill, supply chain/attestation/sbom, sandbox/untrusted, network policy,
secret/password/credential, autoscale, image pull, rbac/authorization, rag/private
data). Triggers are single terms or catalog phrases, never wording taken from an
eval question. The text is expanded once and both retrieval legs (and keyword mode)
rank the same string (`queryExpansion: "both"`). No index, mapping, seed or inference
endpoint changed.

## Revision history (why the numbers went down)

1. First revision: regexes copied from the tuned questions ("going off at night",
   "deletes the cluster by accident", ...). Measured hybrid 10/12, MRR 0.815. That
   was test-set leakage and was rejected.
2. Second revision (20399c7): generic synonyms, but four triggers were still eval
   phrases ("graphics card", "allowed to do", "internal documents", "traffic
   spikes"). Reported 8/12, MRR 0.683 on the tuned set.
3. Shipped: those four triggers removed. Tuned set 6/12, MRR 0.500. The held-out
   numbers are identical to revision 2, because no held-out question hits a removed
   trigger.

## Honest boundaries

- **Small sets.** 8 held-out and 12 tuned questions, 1-4 judged relevant ids each,
  written by the same author. The claim is "improves these judged paraphrases", not
  arbitrary attendee queries. No live-traffic A/B data.
- **Keyword mode improves too** (held-out 0/8 to 4/8), so the hybrid-versus-keyword
  contrast narrows. Present the change as query understanding, not as hybrid alone
  fixing the misses.
- **Both legs are expanded.** A same-body ablation under the rejected revision 1
  found semantic-leg-only expansion far weaker (hybrid MRR 0.351) than both legs; it
  was not repeated for the shipped table.
- **Latency**, port-forwarded single-node cluster, 36 sequential warm queries per
  mode: median 35 ms keyword, 80 ms hybrid with expansion, 70 ms hybrid without. A
  cold E5 allocation still dominates the first request.
- **Demo queries** (`docs/search-comparison.md`): hybrid #1 is unchanged for all
  three. Query 1 ("keep passwords and API keys...") now also gets a relevant keyword
  #1, so it no longer shows a keyword-vs-hybrid gap.

## Tuning variants that did not help

Fresh measurement of the fusion variants on the same index (hybrid MRR@10):
`rankConstant 20` 0.246, `minimum_should_match 30%` 0.125, `linear` fusion 0.097
(weight 1) and 0.139 (weight 2), `rankWindowSize 100` unchanged at 0.306. Fusion knobs
were not changed.
