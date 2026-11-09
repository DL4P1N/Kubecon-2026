# Hybrid vs keyword search: demo queries

Track evidence for the Elasticsearch track (design doc section 7): hybrid search should visibly beat keyword search on the demo queries, with the query shown.

**Status: results are TO BE FILLED.** This document was written without access to a live Elasticsearch cluster, so no result below has been observed. The queries are chosen so the wording differs from the catalog vocabulary; "Expected" lines are hypotheses to confirm, not measurements. Fill the tables from a real run and delete any query where hybrid does not win.

## How the two modes work

Code: `api/src/search/queries.ts` (bodies), `api/src/search/service.ts` (execution), `api/src/routes/search.ts` (routes).

| Mode | Elasticsearch request |
|---|---|
| `keyword` | `bool.must: multi_match` (BM25, `best_fields`) over `title^3`, `tags^2`, `abstract`, with optional level/time `filter` |
| `hybrid` | `retriever.rrf` (rank_constant 60, window 50) over two `standard` retrievers: the same BM25 `multi_match`, and a `semantic` query on the `content_semantic` field (`semantic_text`, embedded by Elasticsearch built-in inference; no client-side vectors) |

Both retrievers are named `keyword` and `semantic`; hits report which leg matched in `matched` (taken from `matched_queries`). Hybrid scores are RRF-fused rank scores (small numbers, comparable only within one response), keyword scores are raw BM25.

Add `debug=1` to see the exact request body in the response (`debug` field). That is the "show the query" demo step.

## Reproduce

Seed first (`npm run es:init && npm run seed`, see `docs/elasticsearch.md`), start the API with `ES_URL`, `ES_USERNAME`, `ES_PASSWORD` set, then for each query below:

```
Q='make sure nobody can tamper with the software I ship to customers'
curl -sG localhost:3000/api/search --data-urlencode "q=$Q" -d mode=keyword -d size=5 | jq '.hits[] | {id: .talk.id, title: .talk.title, score, matched}'
curl -sG localhost:3000/api/search --data-urlencode "q=$Q" -d mode=hybrid  -d size=5 -d debug=1 | jq '.hits[] | {id: .talk.id, title: .talk.title, score, matched}'
```

Run the same query in both modes, copy the top 5 into the table, and mark whether the relevant talk appears.

## Queries

### 1. Supply chain, paraphrased

Query: `make sure nobody can tamper with the software I ship to customers`
Expected: hybrid ranks a supply-chain security talk (signing, SBOMs, provenance) near the top via the semantic leg; keyword has little overlap with the talk wording.

| Rank | keyword | hybrid |
|---|---|---|
| 1 | TO BE FILLED | TO BE FILLED |
| 2 | TO BE FILLED | TO BE FILLED |
| 3 | TO BE FILLED | TO BE FILLED |
| 4 | TO BE FILLED | TO BE FILLED |
| 5 | TO BE FILLED | TO BE FILLED |

### 2. On-call pain, no shared vocabulary

Query: `my pager keeps going off at night and I want a computer to help figure out why`
Expected: hybrid surfaces AI SRE / incident response talks; keyword latches onto generic words ("help", "why").

| Rank | keyword | hybrid |
|---|---|---|
| 1 | TO BE FILLED | TO BE FILLED |
| 2 | TO BE FILLED | TO BE FILLED |
| 3 | TO BE FILLED | TO BE FILLED |
| 4 | TO BE FILLED | TO BE FILLED |
| 5 | TO BE FILLED | TO BE FILLED |

### 3. Cloud bill

Query: `spend less money on the machines my containers run on`
Expected: hybrid finds FinOps, rightsizing, spot and autoscaling talks; keyword has no term for "cost" or "FinOps".

| Rank | keyword | hybrid |
|---|---|---|
| 1 | TO BE FILLED | TO BE FILLED |
| 2 | TO BE FILLED | TO BE FILLED |
| 3 | TO BE FILLED | TO BE FILLED |
| 4 | TO BE FILLED | TO BE FILLED |
| 5 | TO BE FILLED | TO BE FILLED |

### 4. Access control

Query: `who is allowed to do what inside my cluster`
Expected: hybrid finds RBAC and policy-as-code talks; keyword only matches talks that happen to say "cluster".

| Rank | keyword | hybrid |
|---|---|---|
| 1 | TO BE FILLED | TO BE FILLED |
| 2 | TO BE FILLED | TO BE FILLED |
| 3 | TO BE FILLED | TO BE FILLED |
| 4 | TO BE FILLED | TO BE FILLED |
| 5 | TO BE FILLED | TO BE FILLED |

### 5. Chat over private documents

Query: `let people ask questions about our internal documents without sending them to a third party`
Expected: hybrid finds RAG, vector search and self-hosted LLM talks.

| Rank | keyword | hybrid |
|---|---|---|
| 1 | TO BE FILLED | TO BE FILLED |
| 2 | TO BE FILLED | TO BE FILLED |
| 3 | TO BE FILLED | TO BE FILLED |
| 4 | TO BE FILLED | TO BE FILLED |
| 5 | TO BE FILLED | TO BE FILLED |

## Onboarding and schedule endpoints

- `POST /api/onboarding?debug=1` with `{answers: {topics, experience, goals, freeText, availableFrom?, availableTo?}}` builds a hybrid query from topics, goals and free text. `experience` maps to a level filter (beginner: beginner and intermediate; intermediate and advanced: intermediate and advanced); `availableFrom`/`availableTo` become `start`/`end` range filters. Returns the query and ranked talks.
- `POST /api/schedule` with `{answers}` (or `{talkIds}` in priority order, optional `maxTalks`) keeps talks greedily by score with no time overlaps (back-to-back is allowed), saves the ids to the `schedules` index (24 hour expiry), and returns them with `droppedTalkIds`. `GET /api/schedule` reads it back.
- Until signed attendee tokens land, the attendee is `attendee-stub-1`, or the id in `Authorization: Bearer stub.<id>`. The id is never logged or put on spans.

## Spans

`search` (`search.mode`, `search.hits`), `embed` (wraps the hybrid request, since the query is embedded inside Elasticsearch by the inference endpoint, so its duration includes the search), `schedule.build`. Spans go through `api/src/telemetry/span.ts`, a no-op until the OpenTelemetry SDK registers a runner with `setSpanRunner`.
