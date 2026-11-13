# Build from the repo root:  docker build -f api/Dockerfile -t cc-api .
# Debian (glibc) base, not alpine: onnxruntime-node ships no musl binaries, and the
# API embeds search queries with multilingual-e5-small in-process.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY shared shared
COPY api api
RUN npm run build -w shared && npm run build -w api

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --ignore-scripts --omit=dev --workspace=@cc/api --include-workspace-root=false

# The model is baked into the image so a running pod never calls the Hugging Face hub.
FROM deps AS model
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/api/package.json api/package.json
COPY --from=build /app/api/dist api/dist
ENV MODEL_CACHE_DIR=/app/models
RUN cd api && node dist/embed/fetch-model.js

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
# The runtime never calls npm; its bundled deps (brace-expansion, pacote, sigstore, ...) only
# add CVEs the Trivy gate in CI would flag. Remove them from the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production PORT=3000 MODEL_CACHE_DIR=/app/models MODEL_ALLOW_DOWNLOAD=false
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
# npm nests some deps (e.g. @opentelemetry/sdk-node, because of the @opentelemetry/api
# version split) under api/node_modules; without this the app crash-loops with
# ERR_MODULE_NOT_FOUND (task #39).
COPY --from=deps /app/api/node_modules api/node_modules
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/api/package.json api/package.json
COPY --from=build /app/api/dist api/dist
COPY --from=model /app/models models
COPY data/talks.json /app/data/talks.json
USER node
EXPOSE 3000
WORKDIR /app/api
CMD ["node", "--import", "./dist/telemetry/instrument.js", "dist/index.js"]
