# Radar: Kubernetes judge swimlane

Owner: `ecan0-omp`, board task #6. Deployment instructions:
[application manifests](../deploy/k8s/app/README.md).

## Connect to the assigned cluster

Board question #3 requests the cluster, namespace and kubeconfig. Do not reuse an
unrelated personal cluster or count a disconnected UI as deployment evidence.
Radar OSS runs locally against kubeconfig; it needs no Radar Cloud account.
Cloud enrollment, if required by the team, needs the owner's account and explicit
cluster selection; it is not a prerequisite for the local UI/MCP path.

Official macOS installation and verification:

```sh
brew install skyhook-io/tap/radar
kubectl radar --version
kubectl --context "$CONTEXT" -n "$NAMESPACE" get pods
KUBECONFIG=/secure/path/assigned-kubeconfig \
  kubectl radar --namespace "$NAMESPACE" --namespace-scope --no-browser \
  --mcp-read-only --disable-exec --disable-local-terminal
```

Use a kubeconfig whose selected context is the assigned cluster. The namespace
filter is not a security boundary: use a restricted Kubernetes identity. Radar
binds loopback by default; do not expose this administrative UI through the
public board tunnel. Open `http://127.0.0.1:9280` locally.

## Team MCP setup

Read-only mode exposes **`/mcp-readonly`**, not `/mcp`. Each teammate runs Radar
locally with their own permitted kubeconfig, then connects their agent client:

```sh
claude mcp add radar --transport http http://127.0.0.1:9280/mcp-readonly
codex mcp add radar --url http://127.0.0.1:9280/mcp-readonly
```

For other clients, add a streamable HTTP server named `radar` at that URL using
the client's MCP settings. Restart/reconnect the client and verify that Radar's
read-only tools are actually listed; installing the binary alone is not an MCP
connection. Agent configuration and credentials are local, never committed.
Do not enable pod exec or mutation tools just to collect judging evidence.

## Investigation and evidence

1. Show the assigned namespace's api/web/Elasticsearch/collector topology.
   Capture pod Ready counts and a successful proxied `/healthz` response.
2. Use Radar UI **and** MCP during development. Start with `get_dashboard`,
   `get_resource`, `get_events`, `get_pod_logs`, or `get_topology` as exposed by
   the installed version. Scope requests to the assigned namespace.
3. For a real failure, retain timestamp, symptom, relevant events, diagnosis,
   exact remediation commit/config change, and post-fix readiness/health.
   An empty workload list or refused local cluster connection does not count
   as an investigation of the deployed application.
4. If no natural issue occurs by the Design Doc's checkpoint, obtain owner
   approval for a bounded controlled fault in the demo namespace, capture it,
   and restore the known-good configuration. Label it **controlled** in every
   screenshot/script. Never manufacture a natural-incident story.
5. Add links and screenshots to `docs/track-evidence.md`; redact credentials,
   attendee IDs and sensitive log content. Until these artifacts exist, the
   Radar lane remains unproven.

## Sources

- [Install](https://radarhq.io/docs/install.md)
- [CLI flags and namespace scope](https://radarhq.io/docs/configuration/cli.md)
- [MCP endpoints and read-only mode](https://radarhq.io/docs/features/mcp.md)
- [AI investigations](https://radarhq.io/docs/features/diagnose.md)
- [Cloud cluster connection](https://radarhq.io/docs/cloud/connect-cluster.md)
