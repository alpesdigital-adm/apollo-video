#!/usr/bin/env bash
set -euo pipefail

IMAGE="${APOLLO_IMAGE:-apollo-video:latest}"
CONTAINER="${APOLLO_CONTAINER:-apollo-video}"
INGEST_WORKER="${APOLLO_INGEST_WORKER_CONTAINER:-${CONTAINER}-ingest-worker}"
RENDER_WORKER="${APOLLO_RENDER_WORKER_CONTAINER:-${CONTAINER}-render-worker}"
WEBHOOK_WORKER="${APOLLO_WEBHOOK_WORKER_CONTAINER:-${CONTAINER}-webhook-worker}"
LONG_FORM_WORKER="${APOLLO_LONG_FORM_WORKER_CONTAINER:-${CONTAINER}-long-form-worker}"
PROVIDER_WORKER="${APOLLO_PROVIDER_WORKER_CONTAINER:-${CONTAINER}-provider-worker}"
CAPTURE_SYNC_WORKER="${APOLLO_CAPTURE_SYNC_WORKER_CONTAINER:-${CONTAINER}-capture-sync-worker}"
MUSIC_ANALYSIS_WORKER="${APOLLO_MUSIC_ANALYSIS_WORKER_CONTAINER:-${CONTAINER}-music-analysis-worker}"
LOCALIZATION_TRANSLATION_WORKER="${APOLLO_LOCALIZATION_TRANSLATION_WORKER_CONTAINER:-${CONTAINER}-localization-translation-worker}"
LOCALIZATION_MEDIA_WORKER="${APOLLO_LOCALIZATION_MEDIA_WORKER_CONTAINER:-${CONTAINER}-localization-media-worker}"
APP_ROOT="${APOLLO_APP_ROOT:-/apps/apollo-video}"
ENV_FILE="${APOLLO_ENV_FILE:-${APP_ROOT}/.env}"
DOMAIN="${APOLLO_DOMAIN:-apollo.alpesd.com.br}"
PROVIDER_WORK_ROOT="${APOLLO_V2_PROVIDER_WORK_ROOT:-/app/tmp/provider-results}"

test -f "${ENV_FILE}"
docker network inspect easypanel >/dev/null

for directory in tmp artifacts render-outputs; do
  install -d -o 1000 -g 1000 "${APP_ROOT}/${directory}"
done
install -d -o 1000 -g 1000 "${APP_ROOT}/tmp/provider-results"

DEPLOYMENT_CONFIGURATION="$(docker run --rm \
  --env-file "${ENV_FILE}" \
  "${IMAGE}" \
  node -e '
    const secret = process.env.APOLLO_MEDIA_UPLOAD_SIGNING_SECRET ?? "";
    if (secret.length < 32) {
      console.error("APOLLO_MEDIA_UPLOAD_SIGNING_SECRET must contain at least 32 characters");
      process.exit(1);
    }
    let baseUrl;
    try {
      baseUrl = new URL(process.env.APOLLO_MEDIA_UPLOAD_BASE_URL ?? "");
    } catch {
      console.error("APOLLO_MEDIA_UPLOAD_BASE_URL must be a valid absolute URL");
      process.exit(1);
    }
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      console.error("APOLLO_MEDIA_UPLOAD_BASE_URL must be a clean HTTPS origin");
      process.exit(1);
    }
    const longFormPricing = [
      ["GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR", process.env.GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR],
      ["OPENAI_DIARIZATION_COST_MINOR_UNITS_PER_HOUR", process.env.OPENAI_DIARIZATION_COST_MINOR_UNITS_PER_HOUR],
    ];
    for (const [name, raw] of longFormPricing) {
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1) {
        console.error(name + " must be a positive integer");
        process.exit(1);
      }
    }
    if ((process.env.GROQ_API_KEY ?? "").length < 20 || (process.env.OPENAI_API_KEY ?? "").length < 20) {
      console.error("Long-form provider credentials are not configured");
      process.exit(1);
    }
    const boundedInteger = (name, minimum, maximum) => {
      const value = Number(process.env[name]);
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        console.error(name + " must be an integer between " + minimum + " and " + maximum);
        process.exit(1);
      }
      return value;
    };
    const memoryLimit = (name, fallback) => {
      const value = (process.env[name] ?? fallback).trim().toLowerCase();
      if (!/^[1-9][0-9]*[mg]$/.test(value)) {
        console.error(name + " must be a positive Docker memory limit ending in m or g");
        process.exit(1);
      }
      return value;
    };
    const cpuLimit = (name, fallback) => {
      const value = (process.env[name] ?? fallback).trim();
      const numeric = Number(value);
      if (!/^([0-9]+)([.][0-9]+)?$/.test(value) || !Number.isFinite(numeric) || numeric <= 0 || numeric > 8) {
        console.error(name + " must be a positive CPU limit no greater than 8");
        process.exit(1);
      }
      return value;
    };
    const localizationFlag = (process.env.APOLLO_LOCALIZATION_WORKER_ENABLED ?? "false").trim().toLowerCase();
    if (localizationFlag !== "true" && localizationFlag !== "false") {
      console.error("APOLLO_LOCALIZATION_WORKER_ENABLED must be true or false");
      process.exit(1);
    }
    if (localizationFlag === "true") {
      let localizationBaseUrl;
      try {
        localizationBaseUrl = new URL(process.env.APOLLO_LOCALIZATION_PROVIDER_BASE_URL ?? "");
      } catch {
        console.error("APOLLO_LOCALIZATION_PROVIDER_BASE_URL must be a valid absolute URL");
        process.exit(1);
      }
      if (
        localizationBaseUrl.protocol !== "https:" ||
        localizationBaseUrl.username ||
        localizationBaseUrl.password ||
        localizationBaseUrl.search ||
        localizationBaseUrl.hash
      ) {
        console.error("APOLLO_LOCALIZATION_PROVIDER_BASE_URL must be a clean HTTPS base URL");
        process.exit(1);
      }
      if ((process.env.APOLLO_LOCALIZATION_PROVIDER_API_KEY ?? "").length < 20) {
        console.error("APOLLO_LOCALIZATION_PROVIDER_API_KEY is not configured");
        process.exit(1);
      }
      if (!(process.env.APOLLO_LOCALIZATION_PROVIDER_MODEL ?? "").trim()) {
        console.error("APOLLO_LOCALIZATION_PROVIDER_MODEL is not configured");
        process.exit(1);
      }
      if (!/^[A-Z]{3}$/.test((process.env.APOLLO_LOCALIZATION_PRICE_CURRENCY ?? "").trim().toUpperCase())) {
        console.error("APOLLO_LOCALIZATION_PRICE_CURRENCY must be an ISO-style three-letter code");
        process.exit(1);
      }
      boundedInteger("APOLLO_LOCALIZATION_PROVIDER_TIMEOUT_MS", 1_000, 600_000);
      boundedInteger("APOLLO_LOCALIZATION_PROVIDER_MAX_RESPONSE_BYTES", 1_024, 8 * 1024 * 1024);
      boundedInteger("APOLLO_LOCALIZATION_PROVIDER_MAX_COMPLETION_TOKENS", 1, 32_768);
      boundedInteger("APOLLO_LOCALIZATION_EXECUTION_TIMEOUT_MS", 1_000, 599_000);
      boundedInteger("APOLLO_LOCALIZATION_PRICE_MICROS_PER_1K_INPUT_CHARS", 0, Number.MAX_SAFE_INTEGER);
      boundedInteger("APOLLO_LOCALIZATION_PRICE_MICROS_PER_1K_OUTPUT_TOKENS", 0, Number.MAX_SAFE_INTEGER);
      boundedInteger("APOLLO_LOCALIZATION_MAX_COST_MICROS", 0, Number.MAX_SAFE_INTEGER);
      boundedInteger("APOLLO_LOCALIZATION_PREFLIGHT_TTL_MS", 10_000, 900_000);
    }
    const captureLease = process.env.APOLLO_V2_CAPTURE_SYNC_LEASE_MS?.trim()
      ? boundedInteger("APOLLO_V2_CAPTURE_SYNC_LEASE_MS", 300_000, 3_600_000)
      : 300_000;
    process.stdout.write([
      localizationFlag,
      captureLease,
      memoryLimit("APOLLO_CAPTURE_SYNC_WORKER_MEMORY", "768m"),
      cpuLimit("APOLLO_CAPTURE_SYNC_WORKER_CPUS", "1"),
      memoryLimit("APOLLO_MUSIC_ANALYSIS_WORKER_MEMORY", "768m"),
      cpuLimit("APOLLO_MUSIC_ANALYSIS_WORKER_CPUS", "1"),
      memoryLimit("APOLLO_LOCALIZATION_TRANSLATION_WORKER_MEMORY", "512m"),
      cpuLimit("APOLLO_LOCALIZATION_TRANSLATION_WORKER_CPUS", "0.5"),
      memoryLimit("APOLLO_LOCALIZATION_MEDIA_WORKER_MEMORY", "2g"),
      cpuLimit("APOLLO_LOCALIZATION_MEDIA_WORKER_CPUS", "2"),
    ].join("|"));
  ')"

IFS='|' read -r \
  LOCALIZATION_WORKER_ENABLED \
  CAPTURE_SYNC_LEASE_MS \
  CAPTURE_SYNC_WORKER_MEMORY \
  CAPTURE_SYNC_WORKER_CPUS \
  MUSIC_ANALYSIS_WORKER_MEMORY \
  MUSIC_ANALYSIS_WORKER_CPUS \
  LOCALIZATION_TRANSLATION_WORKER_MEMORY \
  LOCALIZATION_TRANSLATION_WORKER_CPUS \
  LOCALIZATION_MEDIA_WORKER_MEMORY \
  LOCALIZATION_MEDIA_WORKER_CPUS \
  <<< "${DEPLOYMENT_CONFIGURATION}"

COMMON_RUNTIME=(
  --restart unless-stopped
  --init
  --env-file "${ENV_FILE}"
  --add-host host.docker.internal:host-gateway
  --network easypanel
  --env APOLLO_V2_PROVIDER_WORK_ROOT="${PROVIDER_WORK_ROOT}"
  --env APOLLO_V2_CAPTURE_SYNC_LEASE_MS="${CAPTURE_SYNC_LEASE_MS}"
  --env APOLLO_V2_FFMPEG_PATH=/usr/bin/ffmpeg
  --env APOLLO_FFMPEG_PATH=/usr/bin/ffmpeg
  --env FFMPEG_PATH=/usr/bin/ffmpeg
  --env APOLLO_FFPROBE_PATH=/usr/bin/ffprobe
  --env FFPROBE_PATH=/usr/bin/ffprobe
  -v "${APP_ROOT}/tmp:/app/tmp"
  -v "${APP_ROOT}/artifacts:/app/artifacts"
  -v "${APP_ROOT}/render-outputs:/app/render-outputs"
)

remove_container() {
  docker stop --timeout 30 "$1" 2>/dev/null || true
  docker rm "$1" 2>/dev/null || true
}

docker run --rm \
  --env-file "${ENV_FILE}" \
  --add-host host.docker.internal:host-gateway \
  --network easypanel \
  "${IMAGE}" \
  sh -lc '
    set -e
    node -e "
      const net = require(\"node:net\");
      const url = new URL(process.env.V2_DATABASE_URL);
      const host = url.hostname;
      const port = Number(url.port || 5432);
      const deadline = Date.now() + 30_000;
      const connect = () => {
        let settled = false;
        const socket = net.connect({ host, port });
        socket.setTimeout(2_000);
        socket.once(\"connect\", () => {
          if (settled) return;
          settled = true;
          socket.end();
          process.exit(0);
        });
        const retry = () => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (Date.now() >= deadline) {
            console.error(\"PostgreSQL unavailable at \" + host + \":\" + port + \" after 30s\");
            process.exit(1);
          }
          setTimeout(connect, 500);
        };
        socket.once(\"error\", retry);
        socket.once(\"timeout\", retry);
      };
      connect();
    "
    npm run db:v2:migrate:deploy
  '

remove_container "${CONTAINER}"
remove_container "${INGEST_WORKER}"
remove_container "${RENDER_WORKER}"
remove_container "${WEBHOOK_WORKER}"
remove_container "${LONG_FORM_WORKER}"
remove_container "${PROVIDER_WORKER}"
remove_container "${CAPTURE_SYNC_WORKER}"
remove_container "${MUSIC_ANALYSIS_WORKER}"
remove_container "${LOCALIZATION_TRANSLATION_WORKER}"
remove_container "${LOCALIZATION_MEDIA_WORKER}"

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
  ./node_modules/.bin/tsx scripts/run-v2-ingest-worker.mjs

docker run -d \
  --name "${RENDER_WORKER}" \
  --memory 4g \
  --cpus 4 \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  ./node_modules/.bin/tsx scripts/run-v2-render-worker.mjs

docker run -d \
  --name "${WEBHOOK_WORKER}" \
  --memory 1g \
  --cpus 1 \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  ./node_modules/.bin/tsx scripts/run-v2-webhook-worker.mjs

docker run -d \
  --name "${LONG_FORM_WORKER}" \
  --memory 2g \
  --cpus 2 \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  ./node_modules/.bin/tsx scripts/run-v2-long-form-worker.mjs

docker run -d \
  --name "${PROVIDER_WORKER}" \
  --memory 2g \
  --cpus 2 \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  ./node_modules/.bin/tsx scripts/run-v2-provider-worker.mjs

docker run -d \
  --name "${CAPTURE_SYNC_WORKER}" \
  --memory "${CAPTURE_SYNC_WORKER_MEMORY}" \
  --cpus "${CAPTURE_SYNC_WORKER_CPUS}" \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  ./node_modules/.bin/tsx scripts/run-v2-capture-sync-worker.mjs

docker run -d \
  --name "${MUSIC_ANALYSIS_WORKER}" \
  --memory "${MUSIC_ANALYSIS_WORKER_MEMORY}" \
  --cpus "${MUSIC_ANALYSIS_WORKER_CPUS}" \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  ./node_modules/.bin/tsx scripts/run-v2-music-analysis-worker.mjs

if [[ "${LOCALIZATION_WORKER_ENABLED}" == "true" ]]; then
  docker run -d \
    --name "${LOCALIZATION_TRANSLATION_WORKER}" \
    --memory "${LOCALIZATION_TRANSLATION_WORKER_MEMORY}" \
    --cpus "${LOCALIZATION_TRANSLATION_WORKER_CPUS}" \
    "${COMMON_RUNTIME[@]}" \
    "${IMAGE}" \
    ./node_modules/.bin/tsx scripts/run-v2-localization-translation-worker.mjs
fi

docker run -d \
  --name "${LOCALIZATION_MEDIA_WORKER}" \
  --memory "${LOCALIZATION_MEDIA_WORKER_MEMORY}" \
  --cpus "${LOCALIZATION_MEDIA_WORKER_CPUS}" \
  "${COMMON_RUNTIME[@]}" \
  "${IMAGE}" \
  ./node_modules/.bin/tsx scripts/run-v2-localization-media-worker.mjs

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

WORKERS=(
  "${INGEST_WORKER}"
  "${RENDER_WORKER}"
  "${WEBHOOK_WORKER}"
  "${LONG_FORM_WORKER}"
  "${PROVIDER_WORKER}"
  "${CAPTURE_SYNC_WORKER}"
  "${MUSIC_ANALYSIS_WORKER}"
  "${LOCALIZATION_MEDIA_WORKER}"
)
if [[ "${LOCALIZATION_WORKER_ENABLED}" == "true" ]]; then
  WORKERS+=("${LOCALIZATION_TRANSLATION_WORKER}")
fi

test "$(docker inspect --format '{{.State.Health.Status}}' "${CONTAINER}")" = "healthy"
for worker in "${WORKERS[@]}"; do
  test "$(docker inspect --format '{{.State.Running}}' "${worker}")" = "true"
done

sleep 20
for worker in "${WORKERS[@]}"; do
  test "$(docker inspect --format '{{.State.Running}}' "${worker}")" = "true"
  test "$(docker inspect --format '{{.RestartCount}}' "${worker}")" = "0"
done

docker exec "${CONTAINER}" node -e \
  "fetch('http://127.0.0.1:3333/v1/health').then(async r=>{if(!r.ok)throw new Error(await r.text())}).catch(()=>process.exit(1))"
