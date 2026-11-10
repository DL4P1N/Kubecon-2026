# Cluster map (Module 4)

An organizer view of what attendees are interested in, built from every
registered attendee's interests (it is not an opt-in) and shown only in groups
of at least 5.

## How it works

1. `npm run clusters` (the API image runs `node dist/clusters/cli.js`) scrolls
   through `attendees` for unexpired records (every registered attendee) that have an
   `interest_vector`. Only vectors and interest tags are read, never IDs or names.
2. **k-means runs in the Node job process.** Elasticsearch stores the input
   vectors and the output documents; it does not run the clustering.
   k is chosen by population: `round(sqrt(n/2))`, capped at 8 and at `n/5`.
   Seeding is k-means++ with a fixed seed and 5 restarts, so a run is reproducible.
3. Any cluster with fewer than 5 members is pooled into "Other". "Other" is
   shown only if the pool itself has 5 or more; otherwise those attendees are
   counted as `suppressed` and not shown. A final guard drops anything under 5
   before writing and again before the API responds.
4. Each cluster is labelled from its top interests. An interest only appears in
   a label or `topInterests` if at least 5 members of that cluster hold it, so a
   one-off free-text interest cannot identify someone.
5. Results go to `interest_clusters` with a `run_id`. The cluster documents are
   written first and a run marker (`cluster_id: "_run"`, `size` = suppressed
   count) last, so readers only ever see complete runs. Runs older than 24 hours
   are pruned at the end of each run.

   The same index also holds the topic counts that `GET /api/interests/aggregate`
   writes (`_id` `aggregate:<topic>`, `cluster_id` `topic:<topic>`, `run_id`
   `aggregate-<time>`). The two writers do not touch each other's documents: k-means
   runs use `run_id` starting `run-` and `_id` `<run_id>:<cluster_id>`; this job's
   prune and the route's reads filter on that prefix (and on the `_run` marker), and the
   aggregate cleanup filters on `aggregate-`. Tests cover both directions.

`GET /api/interests/clusters` returns the latest completed run (empty with
`runId: null` before the first one). Centroids stay server-side. The request needs the
`x-organizer-key` header when `ORGANIZER_KEY` is set, and in production the route
returns 503 until it is set. The web page is `/clusters` (it
states "Thresholds untested on live data"). `/map` and `GET /api/interests/aggregate` are
the separate topic-count view from #16: plain per-topic counts with k >= 5, no k-means,
public. This cluster view is the grouped, organizer-keyed one.

## Demo

```
npm run es:init          # indices, if not yet created
npm run clusters:seed    # 40 synthetic attendees (ids demo-NN, always 24h expiry)
npm run clusters         # writes a run
```

The seed makes three themes (13, 12, 11 people) plus four attendees with
off-topic hobbies, who fall under 5 and so show up only in the "not shown" count.
Use `EMBEDDINGS_PROVIDER=local` for an offline demo.

## Telemetry

The `clusters.run` span carries four counts: `clusters.attendees`, `clusters.k`,
`clusters.shown`, `clusters.suppressed` (see `docs/telemetry-allowlist.md`). No
attendee IDs, locations, interests or labels. The CLI (`api/src/clusters/cli.ts`) starts the
OpenTelemetry SDK as `companion-clusters` (when `OTEL_EXPORTER_OTLP_ENDPOINT` is set) before the
job runs and flushes it on exit, so the CronJob's span is exported; on failure it prints only the
error class or Elasticsearch error type, never an error body.

## Deployment

`deploy/k8s/app/clusters-cronjob.yaml` runs the job every 15 minutes, using the
same ConfigMap, Secret and ES CA as the retention CronJob. Add `ORGANIZER_KEY`
to `companion-app-secrets` for the API. Live Kubernetes execution has not been
validated yet.

## Limits

- The 5-member minimum and the k rule are untested on live data: with 170-200
  attendees the map may be sparse, or everything may land in one or two clusters.
- Hash or small-model embeddings give coarse topic groups, not fine-grained ones.
- Attendees without a vector (embedder unavailable at registration) are skipped.
