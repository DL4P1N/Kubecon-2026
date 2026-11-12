# Application deployment

One replica each of the API, web and collector, plus CronJobs, as Kubernetes manifests. The data lives in an
external Postgres (Supabase), not in the cluster. This is a personal-demo deployment, not a high-availability one.
The toghouse homelab adds TLS, secrets and the tunnel in [`../overlays/toghouse`](../overlays/toghouse), which Argo CD syncs.

## Prerequisites

- A Postgres database with `pgvector` and `pg_trgm` (see [docs/database.md](../../../docs/database.md)). The API creates
  the schema itself on start.
- A namespace and the Secret `companion-app-secrets` with these keys (the toghouse overlay builds it from Vault
  `kv/apps/conference-companion/app` through external-secrets; never commit values):

  | Key | Meaning |
  | --- | --- |
  | `DATABASE_URL` | Postgres connection string with the password URL-encoded; on Supabase use the session pooler |
  | `TOKEN_SIGNING_KEY` | random, at least 32 bytes; the API refuses to start in production with a missing or placeholder key |
  | `IDENTITY_HASH_KEY` | random, at least 32 characters; required when any OAuth provider is configured |
  | `<PROVIDER>_CLIENT_ID`, `_CLIENT_SECRET`, `_OAUTH_REDIRECT_URI` | for `GITHUB`, `GOOGLE`, `LINKEDIN`; a provider missing any of the three is disabled |

- A ConfigMap `companion-database-ca` with the CA that signed the database certificate (key `supabase-ca.crt` for
  Supabase). It is optional: omit it, and unset `DATABASE_CA_FILE`, for a database with a publicly trusted certificate.

```sh
kubectl -n "$NAMESPACE" create secret generic companion-app-secrets \
  --from-file=DATABASE_URL=/secure/path/database-url \
  --from-file=TOKEN_SIGNING_KEY=/secure/path/token-signing-key \
  --from-file=IDENTITY_HASH_KEY=/secure/path/identity-hash-key
```

Files must not contain trailing newlines.

## Build and publish

Run from the repository root. Use an immutable commit tag and build for the node architecture, not the laptop's. The
API image is Debian based (onnxruntime ships no musl build) and contains the embedding model, so a pod never downloads it.

```sh
export IMAGE_BASE=ghcr.io/<owner>/conference-companion
export IMAGE_TAG="$(git rev-parse HEAD)"
docker buildx build --platform linux/amd64 -f api/Dockerfile -t "$IMAGE_BASE-api:$IMAGE_TAG" --push .
docker buildx build --platform linux/amd64 -f web/Dockerfile -t "$IMAGE_BASE-web:$IMAGE_TAG" --push .
```

The base manifests reference `cc-api:local` and `cc-web:local`; set each image's `newName`/`newTag` in a Kustomization
(see the toghouse overlay) rather than editing the base. The packages must be public, or the cluster needs an
imagePullSecret.

```sh
kubectl kustomize deploy/k8s/app > /tmp/companion-app-release.yaml
kubectl -n "$NAMESPACE" apply --dry-run=server -f /tmp/companion-app-release.yaml
kubectl -n "$NAMESPACE" apply -f /tmp/companion-app-release.yaml
kubectl -n "$NAMESPACE" rollout status deployment/api --timeout=180s
```

## Access and probes

```sh
kubectl -n "$NAMESPACE" port-forward service/web 8080:8080
curl --fail http://127.0.0.1:8080/healthz
```

`/healthz` on web proxies to the API; it proves that hop, not database health. The API runs the schema migration and
loads the embedding model before it listens, so its startup probe allows about two minutes. Both workloads run
non-root with dropped capabilities, no API token mount and read-only root filesystems.

Only ClusterIP Services are created: there is no ingress here. Public access is the Cloudflare tunnel in the toghouse
overlay. See [../tls/README.md](../tls/README.md) for pod-to-pod TLS.

## Seed the catalog

The API image includes `data/talks.json`. The Job embeds all 417 talks (about 20 seconds):

```sh
kubectl -n "$NAMESPACE" apply -f deploy/k8s/app/seed-job.yaml
kubectl -n "$NAMESPACE" wait --for=condition=complete job/seed-talks --timeout=600s
kubectl -n "$NAMESPACE" logs job/seed-talks
```

The Job is outside the base Kustomization on purpose: seeding is a deliberate one-shot. To rerun it, delete
`job/seed-talks` and apply the manifest again.
