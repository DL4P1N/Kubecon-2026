# Application deployment

The Kustomize base contains the API and web Deployments and Services plus app configuration. Separate manifests provide
optional CronJobs and one-shot Jobs. It does not provision a database, ingress controller, TLS issuer, secret manager,
container registry, storage, or cluster nodes. Those are operator-supplied Kubernetes/environment dependencies. No
specific distribution, node topology, or hosting provider is required.

## Prerequisites

- A Kubernetes cluster supporting the standard `apps/v1`, `batch/v1` and core APIs used by the manifests.
- A reachable PostgreSQL database with `pgvector` and `pg_trgm`. The API creates its schema on startup. The database
  may be managed inside or outside the cluster.
- A namespace and a Kubernetes Secret named `companion-app-secrets` with:

  | Key | Meaning |
  | --- | --- |
  | `DATABASE_URL` | PostgreSQL connection string; URL-encode the password |
  | `TOKEN_SIGNING_KEY` | Random, at least 32 bytes; required in production |
  | `IDENTITY_HASH_KEY` | Random, at least 32 characters; required when an OAuth provider is configured |
  | `<PROVIDER>_CLIENT_ID`, `_CLIENT_SECRET`, `_OAUTH_REDIRECT_URI` | Optional OAuth settings for `GITHUB`, `GOOGLE`, `LINKEDIN`; incomplete providers are disabled |

- If the database certificate chains to a private CA, a ConfigMap named `companion-database-ca` with key
  `database-ca.crt` and `DATABASE_CA_FILE=/etc/database/database-ca.crt` in `companion-app-config`. The base works
  without this ConfigMap when the database certificate chains to system roots.
- An image registry reachable by the cluster. Configure public images or provide an `imagePullSecret`.
- To expose the app publicly, an operator-managed ingress, Gateway, load balancer, or tunnel that routes to the `web`
  Service. Supply any DNS, TLS certificates, and ingress controller independently.

Create the app Secret from protected files; never commit secret values:

```sh
kubectl -n "$NAMESPACE" create secret generic companion-app-secrets \
  --from-file=DATABASE_URL=/secure/path/database-url \
  --from-file=TOKEN_SIGNING_KEY=/secure/path/token-signing-key \
  --from-file=IDENTITY_HASH_KEY=/secure/path/identity-hash-key
```

Files must not contain trailing newlines.

## Build and publish

Build for the Linux platforms supported by the target cluster and native dependencies. The API image uses Debian/glibc
because ONNX Runtime does not ship musl binaries; it includes the embedding model and does not download it at runtime.

```sh
export IMAGE_BASE=ghcr.io/<owner>/conference-companion
export IMAGE_TAG="$(git rev-parse HEAD)"
: "${TARGET_PLATFORMS:?Set to the target cluster's Linux platform(s)}"
docker buildx build --platform "$TARGET_PLATFORMS" -f api/Dockerfile -t "$IMAGE_BASE-api:$IMAGE_TAG" --push .
docker buildx build --platform "$TARGET_PLATFORMS" -f web/Dockerfile -t "$IMAGE_BASE-web:$IMAGE_TAG" --push .
```

The base uses local placeholder image names. Set `newName`/`newTag` in a Kustomize overlay in this repository rather
than editing the base. Keep environment-specific ingress, TLS, registry and secret-provider configuration in that
overlay. The application and deployment manifests are maintained in this repository; updating app code or image tags
does not require changes to a separate infrastructure repository. A cluster may reconcile this repository with GitOps
or an operator may apply the rendered manifests.

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

The Services are `ClusterIP`; the cluster operator supplies public routing. This keeps the application manifests
independent of any one ingress, DNS, TLS, or secrets implementation.

## Seed the catalog

The API image includes `data/talks.json`. The Job embeds all 417 talks (about 20 seconds):

```sh
kubectl -n "$NAMESPACE" apply -f deploy/k8s/app/seed-job.yaml
kubectl -n "$NAMESPACE" wait --for=condition=complete job/seed-talks --timeout=600s
kubectl -n "$NAMESPACE" logs job/seed-talks
```

The Job is outside the base Kustomization on purpose: seeding is a deliberate one-shot. To rerun it, delete
`job/seed-talks` and apply the manifest again.
