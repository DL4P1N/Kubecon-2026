# Kubecon 2026

## Development

Node 20+ and npm workspaces: `shared/` (API contract in `shared/src/contract.ts`), `api/` (Fastify, stub routes), `web/` (Vite + React).

```
npm ci
npm run build
npm test
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173, proxies /api to the api
```

API config comes from env vars (see `.env.example`): `ES_URL`, `ES_USERNAME`, `ES_PASSWORD`, `TOKEN_SIGNING_KEY`, `OTEL_EXPORTER_OTLP_ENDPOINT`. Elasticsearch indices, seeding and embeddings: see `docs/elasticsearch.md`.

Docker (build from repo root): `docker build -f api/Dockerfile -t cc-api .` and `docker build -f web/Dockerfile -t cc-web .` (web listens on 8080, `API_UPSTREAM` sets the api URL).
