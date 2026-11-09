# TLS transport overlay

This overlay encrypts attendee HTTPS -> nginx -> API and browser/API OTLP ->
collector. Nginx verifies the transport CA and upstream DNS names. Node trusts
a bundle containing transport and Elasticsearch CAs. The collector keeps its
existing allowlist/exporter config and merges only TLS receiver settings from
a second file. Dash0 export already uses its authenticated HTTPS endpoint.

The base app/Compose setup remains suitable for local HTTP development; apply
this overlay for the attendee deployment. Do not claim live TLS acceptance
until the verification below passes. There is no verification bypass flag.

## Provision and deploy

On the cluster owner's machine, set `KUBE_CONTEXT=kind-conference-companion`
and `KUBE_NAMESPACE=conference-companion`, then run
`node scripts/provision-transport-tls.mjs`. Requires kubectl and OpenSSL.
`OPENSSL` can name an absolute executable path. The script explicitly targets
that context/namespace, generates seven-day demo certificates, and provisions
three Secrets without printing their values. Keys stay in a private temporary
directory outside the repository. It reads the existing public ES CA from
`elasticsearch-http-ca`. Do not commit generated material.
`TLS_PUBLIC_HOST` adds the attendee DNS hostname to the web certificate
(default `companion.localhost`).

Render first with `kubectl kustomize deploy/k8s/tls`. Set the API/web images to
the release being deployed (the base uses cc-api:local / cc-web:local) and apply
with `kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" apply -k deploy/k8s/tls`.
API, web and collector each need to roll out. Secret updates require restarts
of those deployments. The public certificate covers localhost/127.0.0.1 and
the web Service DNS names. For a public hostname, issue a certificate covering
that hostname from an appropriate trusted CA before exposing the Service.
Radar's admin UI must remain private.
If ingress-nginx is installed, adapt `ingress.example.yaml` and apply
`-k deploy/k8s/tls/ingress` rather than the direct-service overlay; it
terminates attendee TLS and verifies TLS again to the web backend. Its host
and Secret namespace annotation must match the provisioned release. The
example is deliberately not auto-applied on kind hosts without a controller.
The ingress overlay also sets `TRUST_PROXY=2` for ingress -> web -> API;
the direct-service overlay keeps `TRUST_PROXY=1`. Nginx preserves the forwarded
chain, and the API trusts only the configured nearest hops. The ingress must
overwrite untrusted external forwarded headers, and API/web Services must not
be externally exposed around that ingress. Restart API after changing hops.
Do not use the two-hop overlay for direct web access: it would trust one hop too
many. Render the selected overlay to confirm the intended topology first.

## Verify without bypassing trust

Forward web port 8080 to local 8443. Use the **public CA path printed by the
provisioner** with `curl --cacert <ca.crt> https://localhost:8443/healthz` and
`https://localhost:8443/register`. Both must return 200. To use a real browser,
trust that public CA in the test browser/OS trust store through the owner's
approved local trust procedure; never use ignore-certificate-errors flags.

Check the API from inside the namespace using a client with the public CA:
`https://api:3000/healthz`. Check collector `https://otel-collector:4318/v1/traces`
with an empty valid OTLP JSON payload. Verify API export reaches Dash0 with
zero send failures. Repeat with a wrong CA and wrong DNS name; both must fail.
Nginx `/healthz` exercises its CA-verified API connection. Query `/otlp/v1/traces`
through web to exercise its CA-verified collector connection.

Kubernetes HTTPS probes encrypt transport but kubelet does not validate server
certificates; they are availability checks, not the TLS trust evidence above.
The collector's own metrics/admin ports are private management surfaces, not
attendee transport endpoints. Existing standalone seed/retention jobs are not
included by the base app Kustomization: if deploying them, mount the API TLS
Secret's CA bundle and set their Node trust/OTLP endpoint as in api-tls.yaml.
Do not run an instrumented job against a plaintext collector address after
enabling this overlay.

References: [Fastify HTTPS](https://fastify.dev/docs/latest/Reference/Server/#https),
[Collector merged configuration and TLS](https://opentelemetry.io/docs/collector/configuration/).

Live rollout and browser trust verification: pending deployment owner.
