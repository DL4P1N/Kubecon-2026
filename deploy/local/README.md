# Reproducible local Kubernetes deployment

This runner creates a dedicated **kind** cluster (`companion-local`), separate kubeconfig, private local state, secured Elasticsearch, and the application using the existing `deploy/k8s` manifests. It does not use or update the default kubeconfig, existing `conference-companion` cluster, root `.env`, or preexisting certificate files. Do not use this as a production deployment.

## Prerequisites

- macOS/Linux workstation with Node.js **22.15+**, npm dependencies installed (`npm ci` at repository root), Docker Desktop/Engine, kind, kubectl, OpenSSL, curl, and bash.
- Allocate at least 7.65 GiB to Docker; Elasticsearch itself requests/limits 4 GiB and uses a 1 GiB heap, with 50% ML memory allowance. Other workloads and kind nodes need additional headroom. Single-node Elasticsearch is not HA; its PVC is retained in the cluster.
- A usable Elastic license with NLP inference support. On a new cluster Elastic may offer a one-time trial. Read Elastic's trial terms before opting in. Inference model deployment and initial 417-talk catalog indexing can take many minutes; the CLI waits up to 30 minutes for the real seed Job and verifies inference endpoint access.

## Fresh setup and reruns

Run from the repository root. First run may stop before trial activation and ask for explicit acceptance:

```sh
node deploy/local/companion.mjs up
# Only if an inference-capable license is unavailable and you accept Elastic's trial terms:
node deploy/local/companion.mjs up --accept-elastic-trial
```

`up` builds and loads cluster-specific tagged images, waits for Elasticsearch, bootstraps the exact least-privilege service role through `scripts/es-setup.sh`, installs the privacy-filtered collector, deploys the workloads and scheduled jobs, and seeds the real bundled `data/talks.json` catalog when the `talks` index does not hold all 417 talks. It finishes by calling `/api/status` and a real `/api/search` through the API service. Check a running stack at any time with:

```sh
node deploy/local/companion.mjs status
```

Rerun `up` after source changes; it keeps generated credentials, TLS certificate, and the Elasticsearch PVC (catalog and attendee data) in place. The seed Job runs again only if the catalog is incomplete; it upserts talks by ID and never touches attendee indices. If private state is lost or corrupted, do not delete or regenerate it against an existing cluster: recover its kubeconfig/credentials/certificate securely or manually inspect the cluster and its data first. A different isolated cluster name is selected with `--name NAME`.

The generated organizer key (for organizer-only views such as room placement and interest clusters) is `organizerKey` in `deploy/local/.state/<name>/credentials.json`.

## Serve

```sh
node deploy/local/companion.mjs serve
# Optional loopback port:
node deploy/local/companion.mjs serve --port 8081
```

The foreground port-forward binds only `127.0.0.1`; Ctrl-C stops it. Open `http://127.0.0.1:8080` (or the selected port). `status` lists pods/services and reports the API's `/api/status` state, Elasticsearch reachability, and the hit count of one real catalog search; it prints no catalog or attendee content. Internal port-forwards for `up`/`status` use ephemeral loopback ports.

## Optional runtime integrations

No credentials are needed for normal local use. Dash0 is disabled by default: the runner parses the committed collector configuration and retains its existing transform allowlist and redaction rules, routing to local debug output only. To enable Dash0 for one invocation, explicitly export both `DASH0_OTLP_ENDPOINT` and `DASH0_AUTH_TOKEN` before `up`; values are installed in a Kubernetes Secret and are not persisted in local state or Terraform. Do not place state credentials in Terraform.

OAuth provider settings are optional and accepted only from explicitly exported environment variables (the CLI never loads `.env`): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`; and `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_OAUTH_REDIRECT_URI`. A provider is enabled only when its complete triple is supplied; a partial triple is rejected. All three values go into the `companion-app-secrets` Secret. Register callbacks matching the frontend's local origin, typically `http://127.0.0.1:8080/auth/<provider>/callback` or the corresponding `localhost` URL if that is the origin used. Keep secrets out of frontend variables and command-line arguments.

## Safety, test boundary, and cleanup

- All cluster operations pass the generated kubeconfig and explicit `kind-<name>` context. A cluster with the requested name but no private ownership marker is refused; missing kubeconfig or absent owned cluster also causes refusal rather than adoption/recreation.
- Private state (`deploy/local/.state/<name>/`) includes kubeconfig, generated credentials, and the self-signed ES TLS private key. It must remain private and excluded from Git/Docker build context. Directory/file permissions are 0700/0600. Do not copy in live certificates or credentials.
- The runner preserves Elasticsearch's 4 GiB PVC, so the real catalog and any attendee data survive reruns. `serve` and `status` require existing private owned state and do not create a cluster.
- The documented smoke scenario is: run `up` on a fresh checkout; confirm CLI reports success after the seed Job completes; run `status`; serve in a second terminal; open the app and perform a real catalog search; stop serving; rerun `up` and `status` and confirm catalog/search still work. Run this only against this dedicated local cluster, never a currently running conference-companion environment or default kubeconfig. This repository contributor workflow does not claim a cluster-independent automated smoke test.
- **There is intentionally no teardown command.** Deleting the kind cluster destroys the Elasticsearch PVC and all local data. After verifying the selected name and accepting data loss, explicitly run `kind delete cluster --name NAME` (default `companion-local`) and remove only that cluster's private `deploy/local/.state/NAME/` directory. Never run this against any other cluster name. Keep any backup of generated secrets and certificates private.
