# Dash0: health dashboard, SLOs and check rules as code

Everything Dash0 shows about the app's health is versioned in `deploy/dash0/`:

| File | Kind | What it creates in Dash0 |
| --- | --- | --- |
| `deploy/dash0/dashboard.yaml` | `PersesDashboard` (`perses.dev/v1alpha1`) | Dashboard "Conference Companion - Health" |
| `deploy/dash0/check-rules.yaml` | `PrometheusRule` (`monitoring.coreos.com/v1`) | 6 check rules (SLO thresholds + burn rates) |
| `deploy/dash0/slos/*.yaml` | `SLO` (`openslo.com/v1`, Dash0 subset) | 2 native Dash0 SLOs (28-day error budgets) |

Status: **pending live verification**. The files are validated offline (YAML
parses, all 29 PromQL expressions parse with the Prometheus Lezer grammar,
threshold annotations and SLO constraints checked). Nobody has applied them to
the Dash0 org yet; see "Apply" below.

## Sources (Dash0 docs, read 2026-11-09)

- Dashboards as code (Perses format, operator/Terraform/CLI/"Edit as JSON"):
  https://www.dash0.com/docs/dash0/dashboards/reference-dashboards-as-code
- Check rules as code (PrometheusRule, `$__threshold`, `dash0-threshold-*`):
  https://www.dash0.com/docs/dash0/monitoring/alerting/manage-check-rules-as-code
- Operator sync of `PersesDashboard` / `PrometheusRule` and its prerequisites:
  https://www.dash0.com/docs/dash0/monitoring/kubernetes/dash0-operator/managing-dash0-resources
- SLOs (OpenSLO v1 subset, 28d rolling, `ratioMetric`, `counter: true` needs bare selectors):
  https://www.dash0.com/docs/dash0/monitoring/alerting/create-slos,
  https://www.dash0.com/docs/dash0/monitoring/alerting/manage-slos-as-code,
  https://www.dash0.com/docs/dash0/miscellaneous/tooling/terraform-provider-dash0/resources/slo
- SLO burn-rate alerting (`dash0.slo.burn_rate.fast|slow`):
  https://www.dash0.com/docs/dash0/monitoring/alerting/alert-on-slos
- CLI (`dash0 apply` accepts PersesDashboard, PrometheusRule and SLO):
  https://www.dash0.com/docs/dash0/miscellaneous/tooling/dash0-cli/commands,
  install: https://www.dash0.com/docs/dash0/miscellaneous/tooling/dash0-cli/installation
- OTel metric names in Dash0 PromQL: https://www.dash0.com/docs/dash0/telemetry/metrics/understand-otel-metric-names
- Span metrics (`dash0.spans`, `dash0.spans.duration`): https://www.dash0.com/docs/dash0/opentelemetry/semconvs/metrics/spans
- Perses panel structure (`queries` is a sibling of `plugin`): https://perses.dev/perses/docs/api/dashboard/

Note: the Dash0 dashboard example nests `queries` under `plugin.spec`; upstream
Perses puts them at panel `spec.queries`. We follow upstream Perses. If Dash0
shows empty panels after import, that is the first thing to check.

## Metric name mapping

Dash0 exposes each OTel metric under a Prometheus-translated name (dots to
underscores, unit suffix, `_total` for counters, `_bucket`/`_count`/`_sum` for
histograms) and attribute keys with dots replaced by underscores. Resource
attribute `service.name` becomes `service_name`. Dash0's own check-rule
examples use exactly `http_server_request_duration_seconds_bucket{service_name=...}`
and `http_response_status_code`.

| OTel (what the SDK exports) | Unit | PromQL in Dash0 | Labels used |
| --- | --- | --- | --- |
| `http.server.request.duration` (from `@opentelemetry/instrumentation-http`, stable semconv) | s | `http_server_request_duration_seconds_bucket` / `_count` | `http_route`, `http_request_method`, `http_response_status_code` |
| `companion.search.duration` (`api/src/telemetry/metrics.ts`) | s | `companion_search_duration_seconds_bucket` / `_count` | `search_mode` (`keyword` / `hybrid`) |
| `access.scans` (`metrics.ts`) | 1 | `access_scans_total` | `access_decision`, `room_id` |
| browser `documentLoad` / `browser.error` spans (`web/src/telemetry/rum.ts`) | s | `{otel_metric_name="dash0.spans.duration"}`, `{otel_metric_name="dash0.spans"}` | `service_name="companion-web"`, `otel_span_name` |

All of these labels are on the collector's metric allowlist
(`docs/telemetry-allowlist.md`), so nothing new leaves the cluster.

If a translated name returns no data, the documented fallback is the
`otel_metric_name` selector, e.g.
`histogram_quantile(0.95, sum by (http_route) (rate({otel_metric_name="http.server.request.duration", service_name="companion-api"}[5m])))`
(Dash0 returns that as a native histogram, so no `le` in the `by` clause).
Use the Query Builder's autocomplete to confirm names.

### Bucket fix shipped with this change

`companion.search.duration` had no bucket advice, so the SDK default
boundaries (0, 5, 10, 25 ... 10000, designed for milliseconds) applied to a
value in seconds: every search fell into the 0-5 s bucket and any p95 was
meaningless. `metrics.ts` now uses the same second-based boundaries as
`http.server.request.duration` (0.005 ... 10, including 0.5), covered by
`api/test/telemetry.test.ts`.

## SLOs and why these targets

| SLO | SLI | Target | Window |
| --- | --- | --- | --- |
| Search + onboarding latency | share of `/api/search` + `/api/onboarding` requests with duration <= 0.5 s | >= 95% (that is, p95 < 500 ms) | 1h (check rules) and 28d (native SLO) |
| API availability | share of `companion-api` responses that are not 5xx | >= 99% | 1h (check rules) and 28d (native SLO) |

Why 500 ms: `docs/demo/search-comparison-measured.json` (live cluster, real
417-talk catalog, ES E5 inference) measured keyword search at 11-38 ms and
hybrid search at 90-159 ms per request. Hybrid is the default mode and runs
inference on every query; onboarding runs the same hybrid search. 500 ms is
about 3x the slowest measured request, so normal ES/inference jitter stays
inside the SLO, while a real regression (ML node cold start or capacity
problem like the one in the Radar section of `docs/track-evidence.md`, or a
slow ES) breaks it. 0.5 s is also an exact histogram bucket boundary, so the
SLI counts `le="0.5"` exactly instead of interpolating.

Why 99%: a single-replica demo on kind; anything stricter would be noise.

How each SLO is modelled:

- **1h view = check rules** (`check-rules.yaml`). Dash0 SLOs only support a
  rolling 28-day window, so the "over 1h" objective is a PromQL check rule:
  - `companion-slo - Search and onboarding p95 latency (1h)`: p95 in ms,
    degraded at 400, critical at 500.
  - `companion-slo - API 5xx ratio (1h)`: 5xx percent, degraded at 0.5, critical at 1.
  - Multi-window burn-rate rules (Google SRE workbook pattern):
    fast burn = 1h and 5m burn rate both > 14.4 (latency and availability);
    slow burn = 6h and 30m both > 6 (availability). Burn rate = bad ratio /
    error budget (5% for latency, 1% for availability).
  - `companion-slo - Dash0 SLO burn rate`: the documented pattern on
    Dash0's built-in `dash0.slo.burn_rate.fast|slow` metrics, selected by the
    `slo` label we put on the SLO documents. Fires only after the native SLOs exist.
- **28d view = native Dash0 SLOs** (`slos/`), with an error budget, burn
  rate and burndown chart in the Dash0 SLO UI. `counter: true` with bare
  selectors, exactly as in Dash0's Terraform example. `dash0.com/origin`
  makes re-applying update instead of duplicate.

With no traffic the ratio queries divide by zero and return nothing, so the
rules stay quiet instead of firing (and the SLO tiles show "no data").

## Dashboard panels

| Row | Panel | Shows |
| --- | --- | --- |
| SLOs (last 1h) | p95 latency, search + onboarding | The latency SLO number; orange >= 0.4 s, red >= 0.5 s |
| | Requests <= 500 ms | Same SLI as a ratio (must stay >= 95%) |
| | Availability, non-5xx | Must stay >= 99% |
| | Availability error budget left | 1 - 5xx ratio / 1%; below 0 = budget spent |
| | Burn rate | 5m and 1h burn for both SLOs; 14.4 is the fast-burn alert line |
| API | Request rate by route | req/s by `http.request.method` + `http.route` |
| | p95 latency by route | per route, 5m rate |
| | 5xx error ratio | all routes |
| | 5xx by route and status | which route is failing |
| Search | Search p95 by mode | keyword vs hybrid, API side including ES (the Elasticsearch story in numbers) |
| | Searches per second by mode | traffic split |
| Room access | Scans per minute by room and decision | allow / deny per room |
| | Deny ratio (1h) | share of denied scans |
| Browser | Page load p95 | `documentLoad` span duration from the web SDK, via Dash0 span metrics |
| | Page loads and browser errors per minute | `documentLoad` and `browser.error` spans |

The browser panels rely on the span-name label of Dash0's synthetic span
metrics (`otel_span_name`); the metric registry does not list that label
explicitly, so it is the panel most likely to need a tweak live.

## Apply

Do not paste tokens on the board or commit them. A Dash0 auth token with
"All permissions" is needed for SLOs (Organization Settings > Auth Tokens).

### Option A (recommended): Dash0 CLI, from a checkout of this branch

```sh
# Install: brew install --cask dash0hq/dash0-cli/dash0
#   (or a GitHub release binary, or docker image ghcr.io/dash0hq/cli:latest)
export DASH0_API_URL=<API endpoint of your Dash0 org/region>   # Dash0 org settings
export DASH0_AUTH_TOKEN=<auth token>                           # never on the board
export DASH0_DATASET=default                                   # dataset id the collector exports to

dash0 dashboards create -f deploy/dash0/dashboard.yaml --dry-run   # validation only
dash0 apply -f deploy/dash0/dashboard.yaml
dash0 apply -f deploy/dash0/check-rules.yaml
dash0 apply -f deploy/dash0/slos/
dash0 check-rules list    # expect 6 "companion-slo - ..." rules
dash0 slos list           # expect companion-search-latency, companion-availability
```

### Option B: Dash0 operator on the kind cluster (dashboard + check rules only)

The operator syncs `PersesDashboard` and `PrometheusRule` resources, but only
in namespaces that have a `Dash0Monitoring` resource, and it needs an operator
configuration with the Dash0 `apiEndpoint` and a token. Installing it also
installs the operator's own telemetry collection, which would bypass our
allowlisting collector unless configured off. For the demo, Option A is
simpler and safer. If the operator is already set up:

```sh
kubectl --context kind-conference-companion -n conference-companion apply \
  -f deploy/dash0/dashboard.yaml -f deploy/dash0/check-rules.yaml
kubectl --context kind-conference-companion -n conference-companion describe dash0monitoring
#  -> "Perses Dashboard Synchronization Results" / "Prometheus Rule Synchronization Results"
```

The `PersesDashboard` and `PrometheusRule` CRDs must exist first (perses-operator
CRD and prometheus-operator CRD). SLOs are not synced by the operator; use the
CLI for `deploy/dash0/slos/`.

### Option C: UI only

Dashboards > new dashboard > "Edit as JSON", paste the JSON form of
`deploy/dash0/dashboard.yaml` (`node -e "console.log(JSON.stringify(require('yaml').parse(require('fs').readFileSync('deploy/dash0/dashboard.yaml','utf8')),null,2))"`
after `npm ci`). Check rules can be created by hand from the `expr` fields.

## Live verification steps (ecan0-omp)

1. Make sure the API image running on the cluster includes this change
   (search histogram buckets). Older images still export the search metric,
   but its p95 panel will read ~4.75 s regardless of real latency.
2. Apply (Option A).
3. Generate traffic for ~10 minutes (port-forward the web service as in
   `deploy/k8s/app/README.md`):
   ```sh
   for i in $(seq 1 200); do
     curl -s -o /dev/null "http://localhost:8080/api/search?q=supply+chain+security&mode=hybrid"
     curl -s -o /dev/null "http://localhost:8080/api/search?q=supply+chain+security&mode=keyword"
   done
   ```
   plus one onboarding run, a few room scans (allow and deny) and a couple of
   page loads in the browser.
4. Screenshots into `docs/evidence/`:
   - `dash0-health-dashboard.png`: the whole dashboard (SLO row visible)
   - `dash0-search-p95-by-mode.png`: keyword vs hybrid panel
   - `dash0-check-rules.png`: Alerting > Check rules list with the 6 rules
   - `dash0-slo.png`: one native SLO page (error budget + burn rate)
5. Record in `docs/track-evidence.md` (Dash0 section): what was applied, which
   panels had data, and any query that had to change (update the YAML too).
