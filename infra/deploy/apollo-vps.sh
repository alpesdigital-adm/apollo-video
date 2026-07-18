#!/usr/bin/env bash
set -euo pipefail

IMAGE="${APOLLO_IMAGE:-apollo-video:latest}"
CONTAINER="${APOLLO_CONTAINER:-apollo-video}"
APP_ROOT="${APOLLO_APP_ROOT:-/apps/apollo-video}"
ENV_FILE="${APOLLO_ENV_FILE:-${APP_ROOT}/.env}"
DOMAIN="${APOLLO_DOMAIN:-apollo.alpesd.com.br}"

test -f "${ENV_FILE}"
docker network inspect easypanel >/dev/null

for directory in data uploads renders tmp artifacts render-outputs; do
  install -d -o 1000 -g 1000 "${APP_ROOT}/${directory}"
done

docker run --rm \
  --env-file "${ENV_FILE}" \
  --add-host host.docker.internal:host-gateway \
  "${IMAGE}" \
  npm run db:v2:migrate:deploy

docker run --rm \
  --env-file "${ENV_FILE}" \
  -v "${APP_ROOT}/data:/app/data" \
  "${IMAGE}" \
  npx prisma db push --skip-generate

docker stop "${CONTAINER}" 2>/dev/null || true
docker rm "${CONTAINER}" 2>/dev/null || true

docker run -d \
  --name "${CONTAINER}" \
  --restart unless-stopped \
  --init \
  --memory 3g \
  --cpus 4 \
  --env-file "${ENV_FILE}" \
  --add-host host.docker.internal:host-gateway \
  --network easypanel \
  -v "${APP_ROOT}/data:/app/data" \
  -v "${APP_ROOT}/uploads:/app/uploads" \
  -v "${APP_ROOT}/renders:/app/renders" \
  -v "${APP_ROOT}/tmp:/app/tmp" \
  -v "${APP_ROOT}/artifacts:/app/artifacts" \
  -v "${APP_ROOT}/render-outputs:/app/render-outputs" \
  --health-cmd "node -e \"fetch('http://127.0.0.1:3333/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\"" \
  --health-interval 15s \
  --health-timeout 5s \
  --health-retries 5 \
  --health-start-period 30s \
  --label traefik.enable=true \
  --label traefik.docker.network=easypanel \
  --label "traefik.http.middlewares.apollo-buffer.buffering.maxRequestBodyBytes=4294967296" \
  --label "traefik.http.middlewares.apollo-buffer.buffering.memRequestBodyBytes=67108864" \
  --label "traefik.http.routers.apollo-http.rule=Host(\`${DOMAIN}\`)" \
  --label traefik.http.routers.apollo-http.entrypoints=http \
  --label traefik.http.routers.apollo-http.middlewares=apollo-buffer \
  --label "traefik.http.routers.apollo-https.rule=Host(\`${DOMAIN}\`)" \
  --label traefik.http.routers.apollo-https.entrypoints=https \
  --label traefik.http.routers.apollo-https.middlewares=apollo-buffer \
  --label traefik.http.routers.apollo-https.tls=true \
  --label traefik.http.routers.apollo-https.tls.certresolver=letsencrypt \
  --label traefik.http.services.apollo-video.loadbalancer.server.port=3333 \
  "${IMAGE}"
