# Build from the repo root:  docker build -f api/Dockerfile -t cc-api .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY api api
RUN npm run build -w shared && npm run build -w api

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=@cc/api --include-workspace-root=false

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/api/package.json api/package.json
COPY --from=build /app/api/dist api/dist
USER node
EXPOSE 3000
WORKDIR /app/api
CMD ["node", "--import", "./dist/telemetry/instrument.js", "dist/index.js"]
