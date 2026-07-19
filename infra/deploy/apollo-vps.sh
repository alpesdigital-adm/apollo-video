#!/usr/bin/env bash
set -euo pipefail

IMAGE="${APOLLO_IMAGE:-apollo-video:latest}"
CONTAINER="${APOLLO_CONTAINER:-apollo-video}"
INGEST_WORKER="${APOLLO_INGEST_WORKER_CONTAINER:-${CONTAINER}-ingest-worker}"
RENDER_WORKER="${APOLLO_RENDER_WORKER_CONTAINER:-${CONTAINER}-render-worker}"
WEBHOOK_WORKER="${APOLLO_WEBHOOK_WORKER_CONTAINER:-${CONTAINER}-webhook-worker}"
APP_ROOT="${APOLLO_APP_ROOT:-/apps/apollo-video}"
ENV_FILE="${APOLLO_ENV_FILE:-${APP_ROOT}/.env}"
DOMAIN="${APOLLO_DOMAIN:-apollo.alpesd.com.br}"

test -f "${ENV_FILE}"
docker network inspect easypanel >/dev/null

for directory in tmp artifacts render-outputs; do
  install -d -o 1000 -g 1000 "${APP_ROOT}/${directory}"
done

COMMON_RUNTIME=(
  --restart unless-stopped
  --init
  --env-file "${ENV_FILE}"
  --add-host host.docker.internal:host-gateway
  --network easypanel
  -v "${APP_ROOT}/tmp:/app/tmp"
  -v "${APP_ROOT}/artifacts:/app/artifacts"
  -v "${APP_ROOT}/render-outputs:/app/render-outputs"
)

remove_container() {
  docker stop --time 30 "$1" 2>/dev/null || true
  docker rm "$1" 2>/dev/null || true
}

docker run --rm \
  --env-file "${ENV_FILE}" \
  --add-host host.docker.internal:host-gateway \
  --network easypanel \
  "${IMAGE}" \
  npm run db:v2:migrate:deploy

remove_container "${CONTAINER}"
remove_container "${INGEST_WORKER}"
remove_container "${RENDER_WORKER}"
remove_container "${WEBHOOK_WORKER}"

docker run -d \
  --name "${CONTAINER}" \
  --memory 3g \
  --cpus 4 \
  "${COMMON_RUNTIME[@]}" \
  --health-cmd "node -e \"fetch('http://127.0.0.1:3333/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\"" \
  --health-interval 15s \
  --health-timeout 5s \
  --health-retries 5 \
  --health-start-period 30s \
  --label traefik.enable=true \
  --label traefik.docker.network=easypanel \
  --label "traefik.http.middlewares.apollo-buffer.buffering.maxRequestBodyBytes=4294967296" \
  --label "traefik.http.middlewares.apollo-buffer.buffering.memRequestBodyBytes=67108864" \
  --label traefik.http.middlewares.apollo-redirect.redirectscheme.scheme=https \
  --label traefik.http.middlewares.apollo-redirect.redirectscheme.permanent=true \
  --label "traefik.http.routers.apollo-api-http.rule=Host(\`${DOMAIN}\`) && PathPrefix(\`/v1\`)" \
  --label traefik.http.routers.apollo-api-http.entrypoints=http \
  --label traefik.http.routers.apollo-api-http.middlewares=apollo-redirect \
  --label traefik.http.routers.apollo-api-http.priority=100 \
  --label "traefik.http.routers.apollo-api-https.rule=Host(\`${DOMAIN}\`) && PathPrefix(\`/v1\`)" \
  --label traefik.http.routers.apollo-api-https.entrypoints=https \
  --label traefik.http.routers.apollo-api-https.middlewares=apollo-buffer \
  --label traefik.http.routers.apollo-api-https.priority=100 \
  --label traefik.http.routers.apollo-api-https.tls=true \
  --label traefik.http.routers.apollo-api-https.tls.certresolver=letsencrypt \
  --label "traefik.http.routers.apollo-http.rule=Host(\`${DOMAIN}\`)" \
  --label traefik.http.routers.apollo-http.entrypoints=http \
  --label traefik.http.routers.apollo-http.middlewares=apollo-redirect \
  --label traefik.http.routers.apollo-http.priority=10 \
  --label "traefik.http.routers.apollo-https.rule=Host(\`${DOMAIN}\`)" \
  --label traefik.http.routers.apollo-https.entrypoints=https \
  --label traefik.http.routers.apollo-https.middlewares=apollo-buffer \
  --label traefik.http.routers.apollo-https.priority=10 \
  --label traefik.http.routers.apollo-https.tls=true \
  --label traefik.http.routers.apollo-https.tls.certresolver=letsencrypt \
  --label traefik.http.services.apollo-video.loadbalancer.server.port=3333 \
  "${IMAGE}"

docker run -d \
  --name "${INGEST_WORKER}" \
  --memory 2g \
  --cpus 2 \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  npm run worker:v2:ingest

docker run -d \
  --name "${RENDER_WORKER}" \
  --memory 4g \
  --cpus 4 \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  npm run worker:v2:render

docker run -d \
  --name "${WEBHOOK_WORKER}" \
  --memory 1g \
  --cpus 1 \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  npm run worker:v2:webhook

for attempt in $(seq 1 30); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${CONTAINER}")"
  if [[ "${health}" == "healthy" ]]; then
    break
  fi
  if [[ "${health}" == "unhealthy" || "${health}" == "exited" || "${health}" == "dead" ]]; then
    docker logs --tail 100 "${CONTAINER}" >&2
    exit 1
  fi
  sleep 2
done

test "$(docker inspect --format '{{.State.Health.Status}}' "${CONTAINER}")" = "healthy"
for worker in "${INGEST_WORKER}" "${RENDER_WORKER}" "${WEBHOOK_WORKER}"; do
  test "$(docker inspect --format '{{.State.Running}}' "${worker}")" = "true"
done

docker exec "${CONTAINER}" node -e \
  "fetch('http://127.0.0.1:3333/v1/health').then(async r=>{if(!r.ok)throw new Error(await r.text())}).catch(()=>process.exit(1))"
