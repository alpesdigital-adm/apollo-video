#!/usr/bin/env bash
#
# Apollo production orchestrator for the shared Hostinger VPS.
#
#   apollo-vps.sh plan [--with-budget]
#   apollo-vps.sh deploy [--adopt-unlabelled <container>]
#   apollo-vps.sh status
#   apollo-vps.sh latch release --reason "<operator text>"
#   apollo-vps.sh gate open --reason "<operator text>"
#
# What changed and why, in one paragraph: the previous version of this script ran
# `docker stop ... || true` and `docker rm ... || true` over ten containers at once,
# with permissive per-container limits whose sum exceeded the host several times
# over, no lock, no identity check, no plan, no journal and no measurement of the
# machine it was mutating. On a shared VPS whose support confirmed throttling under
# sustained use — 4 vCPUs, load 208 and steal between 92% and 95% were measured on
# 12 September 2026 — that is a deploy that can neither prove what it stopped nor
# notice that it is the reason the host is unwell. AGENTS.md lines 166-236 spell out
# what has to be true instead; this script is that section, executable.
#
# The order is not negotiable: lock, then no latch, then an aggregate budget, then
# proof that the daemon can enforce it, then a monitor of our own, then sixty real
# seconds of preflight — and only then the first mutation, one container at a time,
# each one confirmed before the next is touched. Any ambiguity engages the latch and
# stops: no retry, no rollback that starts containers under load, no second attempt
# "to see if it works".
set -euo pipefail

APOLLO_DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=lib/common.sh
. "${APOLLO_DEPLOY_LIB_DIR}/common.sh"
# shellcheck source=lib/state.sh
. "${APOLLO_DEPLOY_LIB_DIR}/state.sh"
# shellcheck source=lib/docker.sh
. "${APOLLO_DEPLOY_LIB_DIR}/docker.sh"
# shellcheck source=lib/ops.sh
. "${APOLLO_DEPLOY_LIB_DIR}/ops.sh"

# Names keep their environment overrides so an operator's existing overrides survive,
# but nothing about SAFETY has a default: profile, state directory, health URL,
# environment file and image must all be declared.
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
DOMAIN="${APOLLO_DOMAIN:-apollo.alpesd.com.br}"
PROVIDER_WORK_ROOT="${APOLLO_V2_PROVIDER_WORK_ROOT:-/app/tmp/provider-results}"

IMAGE="${APOLLO_IMAGE:-}"
ENV_FILE="${APOLLO_ENV_FILE:-}"
APOLLO_ADOPT_UNLABELLED=''
APOLLO_OPERATOR_REASON=''
APOLLO_PLAN_WITH_BUDGET=0
APOLLO_VERDICT_SEQUENCE=1
APOLLO_LAST_GATE_SEQ=0
APOLLO_LOCALIZATION_ENABLED='false'
APOLLO_RUN_ID="$(apollo_generate_run_id)"

# Container replacement order. The app goes first so the operator sees the new API
# before the fleet behind it moves, and every worker follows one at a time.
APOLLO_ROLES=(
  app
  ingest-worker
  render-worker
  webhook-worker
  long-form-worker
  provider-worker
  capture-sync-worker
  music-analysis-worker
  localization-translation-worker
  localization-media-worker
)

apollo_container_for_role() {
  case "$1" in
    app) printf '%s' "${CONTAINER}" ;;
    ingest-worker) printf '%s' "${INGEST_WORKER}" ;;
    render-worker) printf '%s' "${RENDER_WORKER}" ;;
    webhook-worker) printf '%s' "${WEBHOOK_WORKER}" ;;
    long-form-worker) printf '%s' "${LONG_FORM_WORKER}" ;;
    provider-worker) printf '%s' "${PROVIDER_WORKER}" ;;
    capture-sync-worker) printf '%s' "${CAPTURE_SYNC_WORKER}" ;;
    music-analysis-worker) printf '%s' "${MUSIC_ANALYSIS_WORKER}" ;;
    localization-translation-worker) printf '%s' "${LOCALIZATION_TRANSLATION_WORKER}" ;;
    localization-media-worker) printf '%s' "${LOCALIZATION_MEDIA_WORKER}" ;;
    *) return 1 ;;
  esac
}

apollo_role_enabled() {
  [[ "$1" != 'localization-translation-worker' ]] && return 0
  [[ "${APOLLO_LOCALIZATION_ENABLED}" == 'true' ]]
}

apollo_usage() {
  sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

apollo_parse_arguments() {
  APOLLO_COMMAND="${1:-}"
  shift || true
  case "${APOLLO_COMMAND}" in
    plan|deploy|status) ;;
    latch)
      [[ "${1:-}" == 'release' ]] || { apollo_fail 'the only latch subcommand is: latch release --reason "<text>"'; return 1; }
      APOLLO_COMMAND='latch-release'
      shift
      ;;
    gate)
      [[ "${1:-}" == 'open' ]] || { apollo_fail 'the only gate subcommand is: gate open --reason "<text>"'; return 1; }
      APOLLO_COMMAND='gate-open'
      shift
      ;;
    *)
      apollo_usage >&2
      apollo_fail "unknown command '${APOLLO_COMMAND}'"
      return 1
      ;;
  esac
  while (( $# > 0 )); do
    case "$1" in
      --adopt-unlabelled)
        [[ -n "${2:-}" ]] || { apollo_fail '--adopt-unlabelled requires a container name'; return 1; }
        APOLLO_ADOPT_UNLABELLED="$2"
        shift 2
        ;;
      --reason)
        [[ -n "${2:-}" ]] || { apollo_fail '--reason requires text'; return 1; }
        APOLLO_OPERATOR_REASON="$2"
        shift 2
        ;;
      --run-id)
        [[ -n "${2:-}" ]] || { apollo_fail '--run-id requires a value'; return 1; }
        APOLLO_RUN_ID="$2"
        shift 2
        ;;
      --with-budget)
        APOLLO_PLAN_WITH_BUDGET=1
        shift
        ;;
      *)
        apollo_fail "unknown option '$1'"
        return 1
        ;;
    esac
  done
  if [[ "${APOLLO_COMMAND}" == 'latch-release' || "${APOLLO_COMMAND}" == 'gate-open' ]]; then
    [[ -n "${APOLLO_OPERATOR_REASON}" ]] || {
      apollo_fail "${APOLLO_COMMAND} requires --reason \"<text>\": the reason is the record of who decided it was safe"
      return 1
    }
  fi
}

apollo_validate_environment() {
  apollo_require_command docker
  apollo_require_env APOLLO_OPS_STATE_DIR 'host directory holding gate.json, latch.json, lock/ and journal/'
  apollo_require_env APOLLO_RESOURCE_PROFILE 'isolated-ci | local-dev | shared-production'
  case "${APOLLO_RESOURCE_PROFILE}" in
    isolated-ci|local-dev|shared-production) ;;
    *)
      apollo_fail "APOLLO_RESOURCE_PROFILE must be isolated-ci, local-dev or shared-production, not '${APOLLO_RESOURCE_PROFILE}'"
      return 1
      ;;
  esac
  if [[ "${APOLLO_COMMAND}" == 'plan' || "${APOLLO_COMMAND}" == 'deploy' ]]; then
    apollo_require_env APOLLO_ENV_FILE 'path of the environment file handed to the containers'
    apollo_require_env APOLLO_IMAGE 'image the fleet runs; it must already be present on the host'
    apollo_require_env APOLLO_OPS_HEALTH_URL 'URL of /v1/health the monitor probes'
    test -f "${ENV_FILE}"
    if [[ "${APOLLO_RESOURCE_PROFILE}" == 'shared-production' ]]; then
      apollo_require_env APOLLO_RESOURCE_BUDGET_APPROVED_FILE 'operator-approved budget document; the shared profile defaults no quota'
      test -f "${APOLLO_RESOURCE_BUDGET_APPROVED_FILE}"
    fi
    local flag
    flag="$(apollo_env_file_flag APOLLO_LOCALIZATION_WORKER_ENABLED)"
    [[ -n "${flag}" ]] || flag='false'
    case "${flag}" in
      true|false) APOLLO_LOCALIZATION_ENABLED="${flag}" ;;
      *)
        apollo_fail 'APOLLO_LOCALIZATION_WORKER_ENABLED must be true or false in the environment file'
        return 1
        ;;
    esac
  fi
}

# The image must already exist on the host.
#
# `docker load`, `docker pull`, decompression and hashing are performed by the Docker
# daemon, not inside any container's cgroup, so no `--cpus`/`--memory` bounds them —
# the budget reports them as `uncoveredHostWork`. AGENTS.md line 195 puts them behind
# the same gates as everything else, and a gate that cannot be enforced is not a
# gate, so on the shared profile they are simply not this script's business: the
# image arrives by a separate, separately authorised operation.
apollo_require_image_present() {
  if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    # The explanation is printed before the failure: `apollo_fail` returns non-zero,
    # and under `set -e` nothing after it in this function would run.
    apollo_log 'This script never imports an image: docker load, docker pull, decompression and'
    apollo_log 'hashing run in the daemon, outside every container cgroup, so no quota can bound'
    apollo_log 'them (uncoveredHostWork). Import the image in a separate, separately authorised'
    apollo_log 'operation and then run the deploy.'
    apollo_fail "image ${IMAGE} is not present on this host"
    return 1
  fi
  APOLLO_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${IMAGE}")"
  APOLLO_IMAGE_DIGESTS="$(docker image inspect --format '{{join .RepoDigests ","}}' "${IMAGE}" 2>/dev/null || true)"
}

apollo_common_runtime_arguments() {
  # Every value the previous version passed is still passed; the ops-state mount,
  # the process role and the labels are what is new.
  printf '%s\n' \
    --restart unless-stopped \
    --init \
    --env-file "${ENV_FILE}" \
    --add-host host.docker.internal:host-gateway \
    --network easypanel \
    --env "APOLLO_V2_PROVIDER_WORK_ROOT=${PROVIDER_WORK_ROOT}" \
    --env "APOLLO_V2_CAPTURE_SYNC_LEASE_MS=${CAPTURE_SYNC_LEASE_MS}" \
    --env APOLLO_V2_FFMPEG_PATH=/usr/bin/ffmpeg \
    --env APOLLO_FFMPEG_PATH=/usr/bin/ffmpeg \
    --env FFMPEG_PATH=/usr/bin/ffmpeg \
    --env APOLLO_FFPROBE_PATH=/usr/bin/ffprobe \
    --env FFPROBE_PATH=/usr/bin/ffprobe \
    --env APOLLO_OPS_STATE_DIR=/app/ops-state \
    -v "${APP_ROOT}/tmp:/app/tmp" \
    -v "${APP_ROOT}/artifacts:/app/artifacts" \
    -v "${APP_ROOT}/render-outputs:/app/render-outputs" \
    -v "$(apollo_ops_state_mount_ro)"
}

apollo_validate_configuration() {
  # The configuration is validated by the image itself, because the host has no Node.
  # Only two derived values leave this container now: the localization flag and the
  # capture-sync lease. The per-worker memory and CPU limits it used to print are
  # gone: quotas come from the aggregate budget, never from a per-worker environment
  # variable whose sum nobody checked.
  # shellcheck disable=SC2046
  DEPLOYMENT_CONFIGURATION="$(docker run --rm \
    --name "apollo-ops-config-check-${APOLLO_RUN_ID}" \
    --label apollo.managed=true \
    --label apollo.role=config-check \
    --label "apollo.deployment=${APOLLO_RUN_ID}" \
    $(apollo_budget_limit_arguments config-check) \
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
      process.stdout.write([localizationFlag, captureLease].join("|"));
    ')"

  IFS='|' read -r LOCALIZATION_WORKER_ENABLED CAPTURE_SYNC_LEASE_MS <<< "${DEPLOYMENT_CONFIGURATION}"
  if [[ "${LOCALIZATION_WORKER_ENABLED}" != "${APOLLO_LOCALIZATION_ENABLED}" ]]; then
    apollo_fail "the environment file's localization flag (${APOLLO_LOCALIZATION_ENABLED}) disagrees with the validated value (${LOCALIZATION_WORKER_ENABLED}); the budget was resolved for the wrong fleet"
    return 1
  fi
  apollo_journal 'step-done' "{\"step\":\"config-check\",\"localizationEnabled\":\"$(apollo_json_escape "${LOCALIZATION_WORKER_ENABLED}")\",\"captureSyncLeaseMs\":${CAPTURE_SYNC_LEASE_MS}}"
}

apollo_wait_for_postgres_and_migrate() {
  # shellcheck disable=SC2046
  docker run --rm \
    --name "apollo-ops-migrate-${APOLLO_RUN_ID}" \
    --label apollo.managed=true \
    --label apollo.role=migrate \
    --label "apollo.deployment=${APOLLO_RUN_ID}" \
    $(apollo_budget_limit_arguments migrate) \
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
  apollo_journal 'step-done' '{"step":"migrate"}'
}

apollo_start_container() {
  local role="$1"
  local name="$2"
  local runtime=()
  while IFS= read -r argument; do runtime+=("${argument}"); done < <(apollo_common_runtime_arguments)
  local -a limits
  read -r -a limits <<< "$(apollo_budget_limit_arguments "${role}")"
  if [[ "${role}" == 'app' ]]; then
    docker run -d \
      --name "${name}" \
      --label apollo.managed=true \
      --label "apollo.role=${role}" \
      --label "apollo.deployment=${APOLLO_RUN_ID}" \
      "${limits[@]}" \
      "${runtime[@]}" \
      --env "APOLLO_PROCESS_ROLE=${role}" \
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
      "${IMAGE}" >/dev/null
    return 0
  fi
  docker run -d \
    --name "${name}" \
    --label apollo.managed=true \
    --label "apollo.role=${role}" \
    --label "apollo.deployment=${APOLLO_RUN_ID}" \
    "${limits[@]}" \
    "${runtime[@]}" \
    --env "APOLLO_PROCESS_ROLE=${role}" \
    "${IMAGE}" \
    ./node_modules/.bin/tsx "scripts/run-v2-${role}.mjs" >/dev/null
}

apollo_container_healthy() {
  local role="$1"
  local name="$2"
  if [[ "${role}" == 'app' ]]; then
    local attempts="${APOLLO_OPS_HEALTH_ATTEMPTS:-30}"
    local attempt=1
    while (( attempt <= attempts )); do
      local health
      health="$(apollo_inspect "${name}" '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
      [[ "${health}" == 'healthy' ]] && return 0
      if [[ "${health}" == 'unhealthy' || "${health}" == 'exited' || "${health}" == 'dead' ]]; then
        docker logs --tail 100 "${name}" >&2 || true
        return 1
      fi
      sleep "${APOLLO_OPS_HEALTH_SLEEP_S:-2}"
      attempt=$(( attempt + 1 ))
    done
    return 1
  fi
  [[ "$(apollo_inspect "${name}" '{{.State.Running}}')" == 'true' ]] || return 1
  [[ "$(apollo_inspect "${name}" '{{.RestartCount}}')" == '0' ]] || return 1
}

# Replaces one container and confirms every stage of it.
#
# Return 2 means BLOCKED before anything was touched — the container's identity could
# not be proven — and the operator has a decision to make; nothing is half-done, so
# no latch is engaged. Return 1 means INCONCLUSIVE: a mutation happened and its
# outcome is not certain, which is what the latch is for.
apollo_replace_container() {
  local role="$1"
  local name
  name="$(apollo_container_for_role "${role}")"
  apollo_log "replacing ${name} (role ${role})"
  if apollo_container_exists "${name}"; then
    apollo_require_identity "${name}" "${role}" || return 2
    apollo_stop_confirmed "${name}" "${role}" || return 1
    apollo_remove_confirmed "${name}" || return 1
  else
    apollo_journal 'step-done' "{\"step\":\"stop\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"},\"verify\":{\"status\":\"absent\"}}"
  fi
  apollo_journal 'step-start' "{\"step\":\"run\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"labels\":{\"apollo.role\":\"$(apollo_json_escape "${role}")\"}}}"
  apollo_start_container "${role}" "${name}" || {
    apollo_journal 'step-inconclusive' "{\"step\":\"run\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"},\"reason\":\"docker-run-failed\"}"
    return 1
  }
  apollo_readback_limits "${name}" "${APOLLO_BUDGET_CPUS[${role}]}" "${APOLLO_BUDGET_MEMORY[${role}]}" "${APOLLO_BUDGET_PIDS[${role}]}" || return 1
  apollo_container_healthy "${role}" "${name}" || {
    apollo_journal 'step-inconclusive' "{\"step\":\"health\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"},\"reason\":\"not-healthy\"}"
    return 1
  }
  apollo_journal 'step-done' "{\"step\":\"run\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "$(apollo_container_id "${name}")")\"}}"
}

# Containment after an inconclusive step: engage the latch, stop nothing that was
# already there, and release the lock so the operator is not locked out of `status`
# and `latch release`. AGENTS.md line 218 allows containment of the run's own
# processes only, and explicitly forbids a rollback that starts containers.
apollo_contain_and_latch() {
  local reason="$1"
  local detail="$2"
  apollo_latch_engage "${reason}" "${detail}"
  apollo_monitor_stop
  apollo_lock_release
}

cmd_plan() {
  # Read-only by construction: journalling is off, and the only Docker verbs used
  # are inspect, info and image inspect. `--with-budget` additionally runs the
  # budget CLI in one `--rm` container — the host has no Node, so the numbers cannot
  # be computed any other way — and that is opt-in precisely so that a plain plan
  # can be proven to start nothing at all.
  APOLLO_JOURNAL_ENABLED=0
  apollo_state_paths
  apollo_require_image_present
  printf 'Apollo deploy plan\n'
  printf '  run id                %s\n' "${APOLLO_RUN_ID}"
  printf '  profile               %s\n' "${APOLLO_RESOURCE_PROFILE}"
  printf '  image                 %s\n' "${IMAGE}"
  printf '  image id              %s\n' "${APOLLO_IMAGE_ID}"
  printf '  image digests         %s\n' "${APOLLO_IMAGE_DIGESTS:-<none recorded>}"
  printf '  state directory       %s\n' "${APOLLO_OPS_STATE_DIR}"
  printf '  health URL            %s\n' "${APOLLO_OPS_HEALTH_URL}"
  printf '  environment file      %s (present: %s; no value is read or printed except the localization flag)\n' \
    "${ENV_FILE}" "$( [[ -f "${ENV_FILE}" ]] && printf yes || printf no )"
  printf '  localization worker   %s\n' "${APOLLO_LOCALIZATION_ENABLED}"
  printf '  lock                  %s\n' "$( [[ -d "${APOLLO_LOCK_DIR}" ]] && printf 'HELD by run %s' "$(apollo_lock_field runId)" || printf free )"
  printf '  latch                 %s\n' "$( apollo_latch_engaged && printf 'ENGAGED (deploy refused)' || printf clear )"
  printf '  gate file             %s\n' "$( [[ -f "${APOLLO_GATE_FILE}" ]] && printf present || printf 'absent (open)' )"
  printf '  cgroup                %s\n' "$(docker info --format '{{.CgroupVersion}}|{{.CgroupDriver}}' 2>/dev/null || printf unknown)"
  printf '\nBudget\n'
  local role
  if [[ "${APOLLO_PLAN_WITH_BUDGET}" != '1' ]]; then
    printf '  not resolved here: pass --with-budget to run the budget CLI in one --rm container.\n'
    printf '  At deploy time the quotas come from profile %s of config/resource-budget.json,\n' "${APOLLO_RESOURCE_PROFILE}"
    printf '  resolved before the first mutation; exit code 2 aborts the deploy at that point.\n'
  elif apollo_resolve_budget >/dev/null 2>&1; then
    printf '  envelope              %s\n' "${APOLLO_BUDGET_ENVELOPE}"
    printf '  charged sum           %s\n' "${APOLLO_BUDGET_SUM}"
    for role in "${APOLLO_ROLES[@]}"; do
      apollo_role_enabled "${role}" || { printf '  %-30s disabled by configuration\n' "${role}"; continue; }
      printf '  %-30s %s cpus / %s bytes / %s pids\n' "${role}" "${APOLLO_BUDGET_CPUS[${role}]}" "${APOLLO_BUDGET_MEMORY[${role}]}" "${APOLLO_BUDGET_PIDS[${role}]}"
    done
    for role in monitor config-check migrate; do
      printf '  %-30s %s cpus / %s bytes / %s pids (auxiliary)\n' "${role}" "${APOLLO_BUDGET_CPUS[${role}]}" "${APOLLO_BUDGET_MEMORY[${role}]}" "${APOLLO_BUDGET_PIDS[${role}]}"
    done
  else
    printf '  REFUSED: the aggregate budget does not resolve for this profile; deploy would abort here\n'
  fi
  printf '\nTargets, in replacement order\n'
  local name
  for role in "${APOLLO_ROLES[@]}"; do
    apollo_role_enabled "${role}" || continue
    name="$(apollo_container_for_role "${role}")"
    if apollo_container_exists "${name}"; then
      printf '  %-40s present id %s labels %s\n' "${name}" "$(apollo_container_id "${name}")" "$(apollo_inspect "${name}" "${APOLLO_INSPECT_IDENTITY_FORMAT}")"
    else
      printf '  %-40s absent (will be created)\n' "${name}"
    fi
  done
  printf '\nSteps\n'
  printf '  1. acquire the operation lock (mkdir, owner recorded)\n'
  printf '  2. refuse if latch.json exists\n'
  printf '  3. resolve the aggregate budget in a container; exit 2 aborts before any mutation\n'
  printf '  4. confirm the daemon can enforce quotas (cgroup v2, no limit-support warning)\n'
  printf '  5. start the run monitor container and wait 60s of real preflight samples\n'
  printf '  6. create the host directories\n'
  printf '  7. validate the configuration in a container\n'
  printf '  8. wait for PostgreSQL and run migrations in a container\n'
  printf '  9. for each container above, one at a time: identity, stop, terminal state, pid 0,\n'
  printf '     zero PostgreSQL backends, rm, run with quotas, limit readback, health, re-read gate\n'
  printf ' 10. 60s of postflight, then remove gate.json, stop the monitor and release the lock\n'
  printf '\nBlocked on this profile\n'
  if [[ "${APOLLO_RESOURCE_PROFILE}" == 'shared-production' ]]; then
    printf '  docker load, docker pull, image decompression, image hashing and backups run in the\n'
    printf '  daemon, outside every container cgroup, so no --cpus/--memory bounds them\n'
    printf '  (uncoveredHostWork). This script never performs them: the image must already be\n'
    printf '  present, and its import is a separate, separately authorised operation.\n'
  else
    printf '  nothing: this profile is a disposable host.\n'
  fi
  printf '\nPredicted impact\n'
  printf '  each replacement interrupts that one role for the duration of its stop and start;\n'
  printf '  the workers stop admitting new work while the gate is closed and lose no persisted\n'
  printf '  state, since every job lives in PostgreSQL. No host service is restarted, no volume\n'
  printf '  is removed, and no container outside the list above is touched.\n'
  printf '\nThis plan performed no mutation: only docker inspect, docker info, docker image\n'
  printf 'inspect and one --rm budget container ran.\n'
}

cmd_status() {
  APOLLO_JOURNAL_ENABLED=0
  apollo_state_paths
  printf 'lock   %s\n' "$( [[ -d "${APOLLO_LOCK_DIR}" ]] && printf 'held by run %s (pid %s, since %s)' "$(apollo_lock_field runId)" "$(apollo_lock_field pid)" "$(apollo_lock_field startedAtIso)" || printf free )"
  printf 'latch  %s\n' "$( apollo_latch_engaged && printf 'ENGAGED: %s' "$(sed -n 's/.*"reason": *"\([^"]*\)".*/\1/p' "${APOLLO_LATCH_FILE}" | head -n 1)" || printf clear )"
  printf 'gate   %s\n' "$( [[ -f "${APOLLO_GATE_FILE}" ]] && sed -n 's/.*"state": *"\([^"]*\)".*/\1/p' "${APOLLO_GATE_FILE}" | head -n 1 || printf 'absent (open)' )"
  local role name
  for role in "${APOLLO_ROLES[@]}"; do
    name="$(apollo_container_for_role "${role}")"
    if apollo_container_exists "${name}"; then
      printf '%-42s %s %s\n' "${name}" "$(apollo_inspect "${name}" '{{.State.Status}}')" "$(apollo_inspect "${name}" "${APOLLO_INSPECT_LIMITS_FORMAT}")"
    else
      printf '%-42s absent\n' "${name}"
    fi
  done
}

cmd_latch_release() {
  apollo_state_prepare
  apollo_lock_acquire latch-release
  trap 'apollo_lock_release' EXIT
  apollo_latch_release "${APOLLO_OPERATOR_REASON}"
  apollo_log 'the latch is released; the next deploy still requires five minutes of stable samples'
}

cmd_gate_open() {
  apollo_state_prepare
  if apollo_latch_engaged; then
    apollo_fail 'a latch is engaged; release the latch before reopening the gate'
    return 1
  fi
  apollo_lock_acquire gate-open
  trap 'apollo_lock_release' EXIT
  apollo_gate_clear "${APOLLO_OPERATOR_REASON}"
  apollo_log 'gate.json removed; the absence of the file is the open state'
}

cmd_deploy() {
  apollo_state_prepare
  apollo_lock_acquire deploy
  trap 'apollo_lock_release' EXIT
  if apollo_latch_engaged; then
    apollo_fail 'an incident latch is engaged; no deploy, test or restart happens until the owner releases it'
    return 1
  fi
  apollo_require_image_present
  apollo_journal 'plan' "{\"profile\":\"$(apollo_json_escape "${APOLLO_RESOURCE_PROFILE}")\",\"image\":\"$(apollo_json_escape "${IMAGE}")\",\"imageId\":\"$(apollo_json_escape "${APOLLO_IMAGE_ID}")\",\"digests\":\"$(apollo_json_escape "${APOLLO_IMAGE_DIGESTS}")\"}"
  docker network inspect easypanel >/dev/null

  apollo_resolve_budget
  apollo_cgroup_capability
  # Two host-side checks the monitor cannot make: whether the policy is configured at
  # all, and whether the daemon remembers OOM-killing one of these containers before
  # this run had any samples of its own.
  apollo_load_policy_observation
  apollo_preflight_container_oom "${APOLLO_VERDICT_OOM_WINDOW_MS}"

  apollo_monitor_start
  if ! apollo_await_phase preflight "${APOLLO_OPS_PREFLIGHT_TIMEOUT_S:-180}"; then
    apollo_monitor_stop
    return 1
  fi

  # From here on every command is a mutation, one at a time, each confirmed.
  if [[ "${APOLLO_DEPLOY_SKIP_CHOWN:-0}" == '1' ]]; then
    # Test seam: the suite runs as a user that cannot chown, and the ownership of a
    # directory is not what this script is proving.
    for directory in tmp artifacts render-outputs; do
      install -d "${APP_ROOT}/${directory}"
    done
    install -d "${APP_ROOT}/tmp/provider-results"
  else
    for directory in tmp artifacts render-outputs; do
      install -d -o 1000 -g 1000 "${APP_ROOT}/${directory}"
    done
    install -d -o 1000 -g 1000 "${APP_ROOT}/tmp/provider-results"
  fi
  apollo_journal 'step-done' '{"step":"directories"}'

  apollo_validate_configuration
  apollo_wait_for_postgres_and_migrate

  local role
  for role in "${APOLLO_ROLES[@]}"; do
    apollo_role_enabled "${role}" || continue
    if ! apollo_gate_still_open; then
      apollo_contain_and_latch 'gate-closed' "the admission gate closed before ${role} was replaced: ${APOLLO_VERDICT_REASONS}"
      return 1
    fi
    local replacement=0
    apollo_replace_container "${role}" || replacement=$?
    if (( replacement == 2 )); then
      # Blocked before any mutation: no latch, because nothing is half-done. The
      # operator decides, and the next deploy starts from the same clean state.
      apollo_monitor_stop
      apollo_lock_release
      apollo_fail "blocked at ${role}: the container's identity could not be proven"
      return 1
    fi
    if (( replacement != 0 )); then
      apollo_contain_and_latch 'step-inconclusive' "replacing ${role} did not reach a confirmed state; nothing else was touched"
      return 1
    fi
  done

  if ! apollo_await_phase postflight "${APOLLO_OPS_POSTFLIGHT_TIMEOUT_S:-180}"; then
    apollo_contain_and_latch 'postflight-inconclusive' 'the postflight window was not established after the last replacement'
    return 1
  fi
  apollo_gate_clear 'postflight established; the run is over'
  apollo_monitor_stop
  apollo_lock_release
  trap - EXIT
  apollo_log "deploy ${APOLLO_RUN_ID} complete; journal at ${APOLLO_JOURNAL_DIR}/${APOLLO_RUN_ID}.ndjson"
}

apollo_parse_arguments "$@"
apollo_validate_environment
case "${APOLLO_COMMAND}" in
  plan) cmd_plan ;;
  deploy) cmd_deploy ;;
  status) cmd_status ;;
  latch-release) cmd_latch_release ;;
  gate-open) cmd_gate_open ;;
esac
