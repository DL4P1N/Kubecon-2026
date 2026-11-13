# Build from the repo root:  docker build -f web/Dockerfile -t cc-web .
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY shared shared
COPY web web
# Static front door (published under /site/ by web/scripts/sync-site.mjs during the web build).
COPY landing landing
COPY data/nav-replay.json data/nav-replay.json
ARG NAV_ESTIMATOR=off
ENV NAV_ESTIMATOR=$NAV_ESTIMATOR
RUN npm run build -w shared && npm run build -w web

FROM nginxinc/nginx-unprivileged:1.30-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
# The pinned base lags Alpine's security fixes (openssl, curl, expat, ...); pull them in so the
# Trivy gate in CI passes. The base image runs as uid 101, so switch to root only for this step.
USER root
RUN apk upgrade --no-cache
USER 101
# API_UPSTREAM is substituted into the template at container start.
ENV API_UPSTREAM=http://api:3000
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
