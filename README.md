# Kubecon 2026

Secured Elasticsearch: see [deployment and bootstrap](docs/es-deployment.md).

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

Registration loads public talk tags from `GET /api/catalog/topics` (`{ topics: string[] }`).
This reads a keyword terms aggregation on `talks.tags` (up to 1,000 distinct tags),
not attendee interests. Empty user queries on `/api/search` remain invalid.
If the catalog is unavailable the form offers a retry rather than sending an
empty search. To smoke-test a deployed app without API mocks, set
`LIVE_APP_URL` to its origin and run `npm run test:a11y -w web -- --grep "live catalog"`.
The smoke test only reads catalog metadata and selects a checkbox; it creates no attendee.
