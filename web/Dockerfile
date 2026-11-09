# Build from the repo root:  docker build -f web/Dockerfile -t cc-web .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY web web
COPY data/nav-replay.json data/nav-replay.json
ARG NAV_ESTIMATOR=off
ENV NAV_ESTIMATOR=$NAV_ESTIMATOR
RUN npm run build -w shared && npm run build -w web

FROM nginxinc/nginx-unprivileged:1.27-alpine
# API_UPSTREAM is substituted into the template at container start.
ENV API_UPSTREAM=http://api:3000
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
