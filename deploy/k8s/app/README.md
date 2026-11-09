# Application deployment

Task #6. The human selected a new local `conference-companion` kind cluster,
not `toghouse`. One replica each is the hackathon resource baseline; this is
not a highly available production deployment.

## Dedicated local cluster

```sh
brew install kind
kind create cluster --name conference-companion \
  --kubeconfig "$HOME/.kube/conference-companion" --wait 120s
export KUBECONFIG="$HOME/.kube/conference-companion"
export CONTEXT=kind-conference-companion NAMESPACE=conference-companion
kubectl --context "$CONTEXT" create namespace "$NAMESPACE"
```

The separate kubeconfig leaves the existing default context untouched. For this
local arm64 cluster, build and load images instead of publishing multiarch tags:

```sh
docker build -f api/Dockerfile -t cc-api:local .
docker build -f web/Dockerfile -t cc-web:local .
kind load docker-image --name conference-companion cc-api:local cc-web:local
```

After creating the dependency Secrets and deploying ES/collector, keep the
default local image names and apply with `kubectl --context "$CONTEXT"
-n "$NAMESPACE" apply -k deploy/k8s/app`. The publish section below is for
remote/shared clusters, not required for kind-loaded images.

## Prerequisites

- Use context `kind-conference-companion`, namespace `conference-companion`,
  and the dedicated kubeconfig below. Do not overwrite the `toghouse` context.
- Elasticsearch and `otel-collector` must be in the same namespace. The API
  uses the least-privilege application user, never `elastic`.
- The ES HTTP CA Secret is `elasticsearch-http-ca`, key `ca.crt`; if the ES
  owner supplies another name, change the `es-ca` volume before deployment.
  `NODE_EXTRA_CA_CERTS` adds this CA without disabling certificate verification.
- Create `companion-app-secrets` with keys `ES_USERNAME`, `ES_PASSWORD`, and
  `TOKEN_SIGNING_KEY` from files supplied securely by the credential owner.
  The signing key must be cryptographically random (at least 32 bytes).
  Do not commit credentials or print Secret YAML into the board.

```sh
export KUBECONFIG="$HOME/.kube/conference-companion"
export CONTEXT=kind-conference-companion NAMESPACE=conference-companion
kubectl --context "$CONTEXT" get namespace "$NAMESPACE"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic companion-app-secrets \
  --from-file=ES_USERNAME=/secure/path/es-username \
  --from-file=ES_PASSWORD=/secure/path/es-password \
  --from-file=TOKEN_SIGNING_KEY=/secure/path/token-signing-key
```

Files must not contain trailing newlines. The CA is public trust material;
create its Secret from the certificate provided by the ES owner, not a new CA.

```sh
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic elasticsearch-http-ca \
  --from-file=ca.crt=/secure/path/es-http-ca.crt
```

## Build and publish

Run from the repository root. Use an immutable commit tag and build for the
cluster node architecture, not automatically the developer laptop architecture.
The registry owner must grant push permission, and the cluster must be able to
pull the package (public package or namespace imagePullSecret).

```sh
export IMAGE_BASE=ghcr.io/dl4p1n/conference-companion
export IMAGE_TAG="$(git rev-parse HEAD)"
# Authenticate using your registry credential manager; never paste a token here.
docker buildx build --platform linux/amd64,linux/arm64 \
  -f api/Dockerfile -t "$IMAGE_BASE-api:$IMAGE_TAG" --push .
docker buildx build --platform linux/amd64,linux/arm64 \
  -f web/Dockerfile -t "$IMAGE_BASE-web:$IMAGE_TAG" --push .
```

The committed `cc-api:local` and `cc-web:local` image references are for images
loaded into a local cluster, not registry-published releases. In
`deploy/k8s/app/kustomization.yaml`, set each image's `newName` to the published
registry name (`$IMAGE_BASE-api` / `$IMAGE_BASE-web`) and `newTag` to the exact
commit tag. These fields are literal YAML values; shell variables are not
expanded by Kustomize. Render and inspect both image references before applying:

```sh
kubectl kustomize deploy/k8s/app > /tmp/companion-app-release.yaml
kubectl --context "$CONTEXT" -n "$NAMESPACE" apply --dry-run=server \
  -f /tmp/companion-app-release.yaml
kubectl --context "$CONTEXT" -n "$NAMESPACE" apply -f /tmp/companion-app-release.yaml
kubectl --context "$CONTEXT" -n "$NAMESPACE" rollout status deployment/api --timeout=120s
kubectl --context "$CONTEXT" -n "$NAMESPACE" rollout status deployment/web --timeout=120s
kubectl --context "$CONTEXT" -n "$NAMESPACE" get pods,services \
  -l app.kubernetes.io/part-of=conference-companion
```

For pre-pull, have the cluster owner pull the exact published tags onto the
eligible nodes before the demo (or use the cluster's approved image cache).
A laptop `docker pull` does not populate remote Kubernetes nodes.

## Access and probes

```sh
kubectl --context "$CONTEXT" -n "$NAMESPACE" port-forward service/web 8080:8080
# In a second terminal:
curl --fail http://127.0.0.1:8080/healthz
```

`/healthz` on web proxies to API; it proves that hop, not Elasticsearch health,
inference availability, or that stub routes have been replaced. Web startup and
liveness probe local `/index.html`; only readiness depends on API `/healthz`,
so an API outage removes web from service without restarting healthy nginx.
Both workloads have startup, readiness and liveness probes. They run non-root, with dropped
capabilities, no API token mount, and read-only root filesystems; nginx config
and temporary files use bounded emptyDir volumes.

Only ClusterIP Services are created: there is no public HTTP ingress. A real
attendee deployment requires the assigned TLS ingress host/certificate and
internal transport TLS to meet Design Doc §6. Port-forward is a local developer
access path, not evidence of end-to-end TLS compliance. The current collector
interface is plaintext OTLP on the cluster network, inherited from #4; resolve
transport TLS before claiming the complete security requirement.

## Judge evidence

Follow [the Radar runbook](../../../docs/radar.md). Capture Running **and Ready**
pods, `/healthz`, Radar workload topology and a real investigation. If a fault
is deliberately injected, label it controlled. No live deployment or Radar
connection is implied by successful YAML/schema validation.
