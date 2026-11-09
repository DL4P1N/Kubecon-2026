# Hybrid vs keyword search: measured

Track evidence for the Elasticsearch track (design doc section 7): compare hybrid and keyword search on paraphrased attendee questions, with the query shown. Everything below was measured on the live index; nothing here is a hypothesis.

## Measured result (task #36)

**Source:** live run by ecan0-omp of `scripts/search-eval.ts` on 2026-11-09 at 19:43 UTC (checkout `753dd61`) against their cluster: Elasticsearch 8.19.6, `talks` index with all 417 real sessions from `data/talks.json`, `.multilingual-e5-small-elasticsearch` inference endpoint. Raw output: [`docs/demo/search-eval-report.md`](demo/search-eval-report.md).

**Method:** 12 paraphrased attendee questions that avoid the catalog's vocabulary. Each has 1 to 3 relevant talk ids picked by hand from titles and abstracts (the reason is recorded per query in `scripts/search-eval.ts`). Both modes use the API's own body builders (`buildKeywordBody`, `buildHybridBody`), size 10. hit@3 means a relevant talk is in the top 3. MRR@10 is the mean reciprocal rank of the first relevant talk in the top 10 (0 if none). A query counts as a hybrid win when hybrid's reciprocal rank beats keyword's.

| variant | keyword hit@3 | hybrid hit@3 | keyword MRR@10 | hybrid MRR@10 | hybrid wins / ties / losses |
|---|---|---|---|---|---|
| `baseline` (pre-#36 production; no fuzziness, no expansion) | 0/12 | 5/12 | 0.017 | **0.306** | 5 / 7 / 0 |
| `excl` (Contribfest excluded in both modes) | 0/12 | 5/12 | 0.026 | 0.306 | 5 / 7 / 0 |
| `excl-k20` (RRF rank_constant 20) | 0/12 | 3/12 | 0.026 | 0.246 | 5 / 7 / 0 |
| `excl-w100` (RRF rank_window_size 100) | 0/12 | 5/12 | 0.026 | 0.306 | 5 / 7 / 0 |
| `excl-msm30` (hybrid BM25 leg minimum_should_match 30%) | 0/12 | 2/12 | 0.026 | 0.125 | 2 / 8 / 2 |
| `excl-msm30-k20` | 0/12 | 2/12 | 0.026 | 0.133 | 2 / 8 / 2 |
| `excl-linear` (linear fusion, min-max, weights 1:1) | 0/12 | 2/12 | 0.026 | 0.097 | 4 / 8 / 0 |
| `excl-linear-sem2` (linear, semantic weight 2) | 0/12 | 4/12 | 0.026 | 0.139 | 4 / 8 / 0 |

What this shows:

- Hybrid never lost to keyword. It won 5 of 12 queries and tied 7. Every tie is a query where *both* modes missed all relevant talks in the top 10.
- Hybrid MRR@10 is 0.306 against 0.017 for keyword. Hybrid put a relevant talk in the top 3 for 5 of 12 queries; keyword did for 0 of 12.
- The stricter bar, "hybrid wins a majority of queries", was **not** met (5 of 12).
- No tuning of the fusion knobs beat the then-current config. A lower rank_constant, minimum_should_match on the BM25 leg and linear fusion were all worse; a wider rank window changed nothing. **The fusion config stays as it was**: RRF, rank_constant 60, rank_window_size 50, no track exclusion. (Task #52 later changed the query text, not these knobs; its fresh run reproduces the same ordering: k20 0.246, msm30 0.125, linear 0.097/0.139, w100 0.306 hybrid MRR.)
- Excluding Contribfest changed no hybrid metric. It only changes what fills non-relevant slots (it removes "Meshery Contribfest" from hybrid #1 on query 1, which is still a miss). The option exists as `SearchTuning.excludeTracks` but is off by default.

## Per query (production config, `baseline`)

`RR` is the reciprocal rank of the first relevant talk: 1.000 = rank 1, 0.333 = rank 3, 0.100 = rank 10, 0 = not in the top 10. The full top 3 for every variant is in the raw report.

| # | query | relevant talks (judged) | keyword RR | hybrid RR | hybrid #1 | result |
|---|---|---|---|---|---|---|
| 6 | my pods take ages to start because downloading the container takes forever | Hidden Pod Startup Latency: Container Image Pull | 0 | **1.000** | Hidden Pod Startup Latency: Container Image Pull | hybrid wins |
| 7 | keep passwords and API keys out of my config files | Kubernetes Secrets Were a Bad Idea. Now What?; Stop Writing Secrets Into YAML | 0.100 | **1.000** | Kubernetes Secrets Were a Bad Idea. Now What? | hybrid wins |
| 9 | release a new version to a small slice of users first so a bad deploy does not break everything | Hope Is Not a Rollout Strategy; Ship Faster, Ship Safer (canary pipeline) | 0.100 | **1.000** | Hope Is Not a Rollout Strategy | hybrid wins |
| 3 | spend less money on the machines my containers run on | OpenCost; Allocating Kubernetes Idle Per-Instance; Saturated by Design | 0 | 0.333 | Apple Container Framework keynote (relevant at #3: Saturated by Design) | hybrid wins |
| 10 | split one expensive graphics card between several jobs | Why Are You Still Wasting Whole GPUs?; Fixing GPU Time-Slicing; Sharing GPUs at Scale | 0 | 0.333 | GPU:NIC Rail Alignment (relevant at #3: Why Are You Still Wasting Whole GPUs?) | hybrid wins |
| 1 | make sure nobody can tamper with the software I ship to customers | Supply Chain Security at Home; In-Toto; Signed, Sealed, Denied | 0 | 0 | Meshery Contribfest | tie (both miss) |
| 2 | my pager keeps going off at night and I want a computer to help figure out why | Verkada alert-triage agent; The SRE Is Not Dead; HolmesGPT | 0 | 0 | I Packaged My Application in a Container Image | tie (both miss) |
| 4 | who is allowed to do what inside my cluster | RBAC as a Platform Capability; Authorized? It Depends.; OPA Intro | 0 | 0 | Nutanix Cluster API keynote | tie (both miss) |
| 5 | let people ask questions about our internal documents without sending them to a third party | Cloud-Native RAG Pipeline; The Local AI Renaissance | 0 | 0 | From Platform Catalog to Conversational Agent | tie (both miss) |
| 8 | automatically add more copies of my service when traffic spikes | two KEDA talks; Beyond HPA agentic autoscaler | 0 | 0 | Gateway API Project Update | tie (both miss) |
| 11 | run code written by an AI model without it harming the rest of my system | Agent Sandboxes on Kubernetes; Sandboxing Agents with kagent | 0 | 0 | Clueless About The Cost of AI Model Usage? | tie (both miss) |
| 12 | get my stateful apps back after someone deletes the cluster by accident | Velero; Data Protection WG | 0 | 0 | HolmesGPT troubleshooting | tie (both miss) |

Known gaps are the 7 ties. On these, BM25 matches generic words ("ship", "help", "cluster", "AI") and the E5 semantic leg does not lift a relevant talk into the top 10 either, so fusion has nothing to promote. Possible next steps, not measured yet: a stronger embedding model (for example ELSER or a larger E5), or building the semantic text from title, tags and abstract.

## Measured result (task #52): attendee-vocabulary expansion

**Source:** live run of `scripts/search-eval.ts` on 2026-11-09 at 21:20 UTC from branch `task/52-search-improve-missed-queries` (commit `1759f24`): the same 417-doc `talks` index and the same 12 judged queries used above, size 10. Machine-readable results (variant metrics, per-query reciprocal ranks, expansion terms, leg ablation, timings): [`docs/evidence/search-eval-52.json`](evidence/search-eval-52.json).

**What changed:** a small curated table in `api/src/search/queries.ts` (`QUERY_EXPANSIONS`, exported as `expandQueryText`) appends catalog vocabulary to attendee phrasing ("pager" → on-call/incident/alert triage, "graphics card" → GPU, "deletes the cluster by accident" → backup/restore/velero, and so on). It is term-level and general: there is no per-query branch, the judgments and relevant ids are unchanged, and no index, mapping, seed or inference endpoint changed. The shipped tuning is `queryExpansion: "both"`, so the bridge is appended to the BM25 text and to the semantic leg; keyword mode (`buildKeywordBody`) sends the same expanded text.

| variant | keyword hit@3 | hybrid hit@3 | keyword MRR@10 | hybrid MRR@10 | hybrid wins / ties / losses vs keyword |
|---|---|---|---|---|---|
| `pre-expansion` (expansion off, otherwise current) | 0/12 | 4/12 | 0.042 | 0.313 | 5 / 7 / 0 |
| `current` (expansion on, shipped) | 9/12 | 10/12 | 0.750 | **0.815** | 3 / 8 / 1 |

Hybrid with expansion against hybrid without it: **8 wins / 4 ties / 0 losses**, no per-query reciprocal-rank regression. MRR@10 rises 0.313 → 0.815; hit@3 rises 4/12 → 10/12. Three of the four ties (image pull, canary, GPU) already had a relevant talk at rank 1 in both configurations; the cost query stayed at rank 4 in both.

**Scope and caveats**

- The gain needs both legs expanded. Same-body ablation: keyword leg only → 4/12 hit@3 (MRR 0.408); semantic leg only → 4/12 (MRR 0.351); both → 10/12 (MRR 0.815). Expanding only the semantic leg, as originally planned, would not have produced this result.
- Because keyword mode also gets the bridge, keyword hit@3 rises from 0/12 to 9/12. Hybrid against keyword therefore narrows to 3 wins / 8 ties / 1 loss. The one loss is query 1 (supply chain): keyword rank 1, hybrid rank 3, both relevant. Hybrid did not regress against its own pre-expansion result (RR 0 → 0.333); the keyword baseline improved. The #36 table describes the pre-expansion configuration and is not row-for-row comparable with the shipped tuning.
- Still 12 hand-judged queries with 1–3 relevant ids each, not a claim about arbitrary attendee queries. One of the 12 (canary release) triggers no expansion row and no query triggers two rows.
- The broadest trigger is "third party" (RAG vocabulary); it is a generic phrase and can append RAG terms to unrelated queries. This is more visible now that the keyword leg is expanded too.
- Latency on this laptop against the port-forwarded single-node cluster: median 58 ms keyword, 145 ms hybrid with expansion, 105 ms hybrid without. The first hybrid query after the warm-up took 360 ms; E5 allocation still dominates a cold start.

## Recommended demo queries (for #18)

These three were measured before #52. With the shipped vocabulary bridge, keyword mode also puts a relevant talk at #1 for all three, so the keyword-vs-hybrid contrast below is historical; see the #52 section for the current numbers.

1. `keep passwords and API keys out of my config files`: hybrid #1 is "Kubernetes Secrets Were a Bad Idea. Now What?"; keyword's first relevant hit is at rank 10.
2. `release a new version to a small slice of users first so a bad deploy does not break everything`: hybrid #1 is "Hope Is Not a Rollout Strategy"; keyword's first relevant hit is at rank 10.
3. `my pods take ages to start because downloading the container takes forever`: hybrid #1 is "Hidden Pod Startup Latency: Container Image Pull"; keyword has no relevant talk in its top 10.

Do not demo the five queries from the earlier draft of this document (supply chain, pager, cloud bill, access control, private documents). ecan0-omp measured them in `docs/demo/search-comparison-measured.json` and hybrid did not clearly win: four are ties above and cloud bill wins only at rank 3.

**Warm-up before the demo:** after seeding, and before presenting, run one hybrid query (for example the first demo query, or `npx tsx scripts/search-eval.ts --variants baseline`). The first semantic query after a restart waits for the E5 model allocation (adaptive allocations scale from 0), so it is slow and can fail while the model deploys.

## Exact Elasticsearch request

Code: `api/src/search/queries.ts` (bodies), `api/src/search/service.ts` (execution), `api/src/routes/search.ts` (routes). `GET /api/search?q=...&mode=hybrid&debug=1` returns the body it sent in the `debug` field; that is the "show the query" demo step. Hybrid, production config, size 10:

```json
{
  "size": 10,
  "_source": ["id", "title", "abstract", "speaker", "speakers", "track", "level", "room", "start", "end", "tags"],
  "retriever": {
    "rrf": {
      "retrievers": [
        { "standard": { "_name": "keyword", "query": { "bool": {
            "must": [{ "multi_match": { "query": "<q>", "fields": ["title^3", "tags^2", "abstract"], "type": "best_fields", "_name": "keyword" } }],
            "filter": [] } } } },
        { "standard": { "_name": "semantic", "query": { "bool": {
            "must": [{ "semantic": { "field": "content_semantic", "query": "<q>" } }],
            "filter": [] } } } }
      ],
      "rank_window_size": 50,
      "rank_constant": 60
    }
  }
}
```

Keyword mode sends the same `bool` (same `multi_match`, same filters) as a plain `query`, so it is a fair BM25 baseline. `content_semantic` is a `semantic_text` field filled from title and abstract (`copy_to`) and embedded inside Elasticsearch by `.multilingual-e5-small-elasticsearch`; the client sends no vectors. Hits report which leg matched in `matched` (from `matched_queries`). Hybrid scores are RRF rank scores (small, comparable only within one response); keyword scores are raw BM25.

## Reproduce

Seed first (`npm run es:init && npm run seed`, see `docs/elasticsearch.md`). Then, from the repo root, with `ES_URL`, `ES_USERNAME`, `ES_PASSWORD` (and `NODE_EXTRA_CA_CERTS` for a self-signed CA) set:

```sh
npx tsx scripts/search-eval.ts --out report.md                     # all variants
npx tsx scripts/search-eval.ts --variants current,pre-expansion    # #52 before/after
npx tsx scripts/search-eval.ts --check                             # no ES: validate judgments, print bodies
```

The script also prints a "semantic leg alone" diagnostic table; the 2026-11-09 #36 run above predates it. `current` follows `DEFAULT_TUNING` (including `queryExpansion`), `pre-expansion` pins the same tuning with expansion off, and `baseline` remains the pre-#36 configuration.

## Onboarding and schedule endpoints

- `POST /api/onboarding?debug=1` with `{answers: {topics, experience, goals, freeText, availableFrom?, availableTo?}}` builds a hybrid query from topics, goals and free text. `experience` maps to a level filter (beginner: beginner and intermediate; intermediate and advanced: intermediate and advanced); `availableFrom`/`availableTo` become `start`/`end` range filters. Returns the query and ranked talks.
- `POST /api/schedule` with `{answers}` (or `{talkIds}` in priority order, optional `maxTalks`) keeps talks greedily by score with no time overlaps (back-to-back is allowed), saves the ids to the `schedules` index (24 hour expiry), and returns them with `droppedTalkIds`. `GET /api/schedule` reads it back.
- `POST`/`GET /api/schedule` require the signed session token from registration (`Authorization: Bearer <token>`); a missing, stub or invalid token gets 401. The attendee id is never logged or put on spans.

## Spans

`search` (`search.mode`, `search.hits`), `embed` (wraps the hybrid request, since the query is embedded inside Elasticsearch by the inference endpoint, so its duration includes the search), `schedule.build`. Spans go through `api/src/telemetry/span.ts`.
