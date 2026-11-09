# Radar resource check: usage versus requests and limits

Task #61. Raw data: [radar-resources.json](radar-resources.json).

Scope: the four running workloads in namespace `conference-companion` on the local
kind cluster `kind-conference-companion` (Kubernetes v1.37.0): `api` and `web`
Deployments, `elasticsearch` StatefulSet, and `otel-collector` Deployment. Images
in the measured run were `cc-api:b9f7ffe`, `cc-web:b9f7ffe`,
`docker.elastic.co/elasticsearch/elasticsearch:8.19.6` and
`otel/opentelemetry-collector-contrib:0.116.1`.

## What was measured, and by whom

| Data | Source | Attribution |
| --- | --- | --- |
| CPU, working set, PSI, restart counter | `docker exec conference-companion-control-plane crictl stats -o json` | Operator-collected container runtime statistics |
| Restart counts, pod phase, node conditions | `kubectl get pods` / `get nodes` with the assigned kubeconfig, `crictl` restart annotation | Operator-collected Kubernetes/CRI |
| Topology, requests/limits, readiness, live issues, warning events | Radar MCP read-only `get_dashboard`, `get_resource` (`include=metrics,issues`), `issues` | Radar |

Radar's `metrics` field returned `null` for all four workloads, and the UI shows
"Requires metrics-server to display CPU & memory usage". No metrics-server or
Prometheus backs this cluster, so **null means the metrics API is unavailable,
not that usage is zero**. No usage figure in this report comes from Radar, and
no metric was estimated. Installing a metrics stack just to fill that field was
out of scope for this task.

## Sample protocol

- 10 samples at roughly 1.1 s intervals, 2026-11-09T21:09:01Z to 21:09:12Z.
- Each sample records a fresh CRI row per running container with the CRI
  timestamp; completed Job entries (`retention`, `clusters`) were excluded
  because their zero rows carry no timestamp and are not part of the serving path.
- Workload during sampling was **operator-generated read-only search** against
  `http://127.0.0.1:18086/api/search`: 10 requests, alternating `mode=keyword`
  and `mode=hybrid`, `size=10`, at or below 2 req/s, all HTTP 200. This is
  labelled test load, not production traffic, and no fault was injected.
- PSI `Total` counters are cumulative since container start; only the
  `Avg10`/`Avg60`/`Avg300` gauges describe recent pressure.

## Results

Peaks over the 10 samples, against the limits declared in the manifests and
confirmed by Radar's `get_resource`:

| Container | Peak CPU | CPU limit | CPU used | Peak working set | Memory limit | Memory used | Restarts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `elasticsearch` | 200.2 mCPU | 2 (2000 m) | 10.0% | 2376.6 MiB | 4 GiB | 58.0% | 0 |
| `otel-collector` | 38.2 mCPU | 500 m | 7.6% | 68.9 MiB | 512 MiB | 13.4% | 0 |
| `api` | 41.3 mCPU | 1 (1000 m) | 4.1% | 54.5 MiB | 512 MiB | 10.6% | 0 |
| `web` | 2.4 mCPU | 500 m | 0.5% | 15.8 MiB | 128 MiB | 12.3% | 0 |

Mean CPU over the window was 98.3 mCPU (ES), 15.5 mCPU (api), 8.0 mCPU
(collector) and 0.9 mCPU (web); memory was flat for every container, with
sub-5 MiB spread between the minimum and maximum working set.

Configured values (unchanged):

- `api`: requests 100m / 128Mi, limits 1 CPU / 512Mi.
- `web`: requests 50m / 32Mi, limits 500m / 128Mi.
- `otel-collector`: requests 100m / 128Mi, limits 500m / 512Mi.
- `elasticsearch`: requests 500m / 4Gi, limits 2 CPU / 4Gi, `ES_JAVA_OPTS=-Xms1g -Xmx1g`,
  `xpack.ml.max_machine_memory_percent=50`.

Every peak sits below its CPU request as well, so no container was throttled by
its request either.

## Radar signals

At collection time Radar reported, for namespace `conference-companion`:

- 1/1 nodes Ready; node conditions `MemoryPressure=False`, `DiskPressure=False`,
  `PIDPressure=False`.
- 6 healthy pods, 0 warning pods, 0 error pods, `totalProblems: 0`.
- 3/3 Deployments and 1/1 StatefulSet ready; topology 21 nodes / 22 edges.
- `issues`: 0 critical and 0 warning issues; `get_resource` returned
  `relatedIssuesTotal: 0` for all four workloads.
- 2 warning event groups, both `UnexpectedJob` from the retention/clusters
  CronJobs (`smoke47-retention-*`, `smoke47-clusters-*`, 5 occurrences each,
  last seen 2026-11-09T13:48Z — from the #47 smoke run). These are CronJob
  bookkeeping warnings owned by task #47, not resource pressure.

PSI `Avg10`/`Avg60`/`Avg300` were `0` for CPU, memory and I/O in all 40
container-samples. No OOMKill and no restart was observed in a container
(`restartCount` 0 on every pod). Cumulative PSI totals only reflect lifetime
container age and are therefore not used as pressure evidence here.

## Decision

**No change needed.** The manifests keep the current requests and limits.

- Peak usage is 0.5%–10.0% of the CPU limits and 10.6%–58.0% of the memory
  limits, with the largest consumer (Elasticsearch) still 42% below its 4 GiB
  limit.
- No restarts, no OOMKills, and zero recent PSI stall averages across the
  sampled window; Radar reports zero live issues.
- Shrinking requests or limits from one gentle 11-second window would be an
  arbitrary optimization, and it would trade away exactly the headroom that the
  earlier ES ML incident (30% → 50% memory budget under a 4 GiB limit) showed is
  needed. Resizing for a demo cluster at this utilization is not justified.

Constraints preserved: Elasticsearch stays at 4 GiB with a 50% ML memory budget;
no resource, manifest, or CronJob file was modified by this task.

## Boundaries

- The measurement window is short (10 samples, ~11 s) and driven by gentle
  synthetic read-only search. It is sufficient to rule out saturation at this
  baseline, not to characterize worst-case or long-running load. A soak or
  peak-load test is separate work.
- CPU/memory/restart/PSI figures are operator CRI observations; topology,
  configuration, readiness and issue classification are Radar's.
- Radar metrics are unavailable, so no Radar usage claim is made.
- No screenshot is attached: in this session the headless browser hung on
  Radar's canvas view for both Puppeteer `page.screenshot` and CDP
  `Page.captureScreenshot`. The raw Radar MCP responses are committed verbatim
  in the JSON instead. A real UI capture of the resource/topology view remains
  open and can be added by an owner with a working browser; it does not change
  the measurements above.
- Interpretation of Radar-returned metrics/issues at this depth is owner-review
  territory only if the metrics API is enabled later; the current null-metrics
  conclusion is a straightforward availability fact, not an interpretation.
- Elasticsearch ML allocation health was not re-measured in this task; the
  earlier operator verification in `docs/demo/radar-ml-verification.json` remains
  the reference.
