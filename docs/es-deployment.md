# Secured Elasticsearch deployment

Elasticsearch 8.19.6 runs with authentication and HTTP/transport TLS. The
single node has a 1 GiB heap and 4 GiB container limit, leaving room for E5
native inference. On a 7.65 GiB Docker host this leaves limited headroom for
kind and the app; inspect memory during model deployment. ELSER is outside
this budget. E5 on arm64 still requires live model deployment verification.

## Local Compose

Generate short-lived demo certificates (seven days) with `bash scripts/es-certs.sh`.
Provision the named certificate volume with container-readable ownership:

```sh
docker volume create companion-es-certs
docker run --rm --user 0 -v "$PWD/deploy/compose/certs:/source:ro" \
  -v companion-es-certs:/target alpine:3.21 \
  sh -c 'cp /source/tls.crt /source/tls.key /target/ && chown 1000:0 /target/tls.* && chmod 640 /target/tls.*'
```

Set a fresh `ELASTIC_PASSWORD` in your shell (do not commit it), then run
`docker compose -f deploy/compose/docker-compose.yml up -d elasticsearch`.
Linux hosts need `vm.max_map_count` configured per Elastic's Docker guidance.
The API is bound to localhost only; transport port 9300 is not published.

```sh
export ES_URL=https://localhost:9200
export ES_CA_CERT="$PWD/deploy/compose/certs/tls.crt"
# Set and export ES_PASSWORD to a fresh companion_svc password securely.
bash scripts/es-setup.sh
export ES_USERNAME=companion_svc
export NODE_EXTRA_CA_CERTS="$ES_CA_CERT"
npm run es:init
npm run seed
```

Bootstrap is an admin operation; application processes receive only
ES_USERNAME/ES_PASSWORD. The script grants monitor_inference and index
management/read/write only for the five aliases and their versioned indices.
Index management is needed for the merged application's mapping/alias setup;
the role has no cluster-settings or user-management privileges. Trial-license
status is returned by Elasticsearch; an already-used trial cannot be restarted.

## Kubernetes

Use namespace `conference-companion`. Provision secrets from local files;
the admin password file must be private and contain the password without a newline.

```sh
kubectl -n conference-companion create secret generic elasticsearch-admin \
  --from-file=password=/private/path/es-admin-password
kubectl -n conference-companion create secret tls elasticsearch-tls \
  --cert=deploy/compose/certs/tls.crt --key=deploy/compose/certs/tls.key
kubectl -n conference-companion apply -k deploy/k8s/elasticsearch
kubectl -n conference-companion port-forward svc/elasticsearch 9200:9200
```

Run bootstrap through the port-forward as above. API pods use
`https://elasticsearch:9200`, mount the public `tls.crt`, and set
`NODE_EXTRA_CA_CERTS` to its path. Credentials belong in the app Secret.
Never disable CA verification. Certificate SANs include this namespace's
Service DNS names; regenerate certificates if the namespace changes.

## Acceptance checks (requires a running instance)

```sh
curl --fail --cacert "$ES_CA_CERT" -u "companion_svc:$ES_PASSWORD" \
  "$ES_URL/_security/_authenticate"
curl --fail --cacert "$ES_CA_CERT" -u "companion_svc:$ES_PASSWORD" \
  -H 'Content-Type: application/json' -X POST "$ES_URL/talks/_doc/security-smoke" \
  -d '{"title":"Synthetic security smoke test"}'
curl --cacert "$ES_CA_CERT" -u "companion_svc:$ES_PASSWORD" \
  -H 'Content-Type: application/json' -X PUT "$ES_URL/_cluster/settings" \
  -d '{"persistent":{}}'
```

The last request must return HTTP 403. Delete the smoke document afterward
using the same service credentials. Live authentication, inference, and
memory checks remain pending until the cluster owner runs them.

References: [Elastic TLS settings](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/security-settings),
[E5 model](https://www.elastic.co/docs/explore-analyze/machine-learning/nlp/ml-nlp-e5).
