# shellcheck shell=bash
#
# The Node half of the operation, reached the only way a host without Node can
# reach it: as containers built from the Apollo image.
#
# Three of them exist, and each has a different job:
#
# - the BUDGET container resolves one profile into per-container quotas and refuses
#   with exit 2 before anything has been touched;
# - the MONITOR container is the single owner of gate.json for the run: it samples
#   the host every cadence and publishes the admission decision;
# - the VERDICT container reads the monitor's journal, the latch and gate.json and
#   answers one phase with an exit code. Decisions stay in Node; effects stay in
#   bash.
#
# The budget and verdict containers are bounded by a small bootstrap literal rather
# than by the budget, because the budget is what one of them computes and the other
# must be able to run even when the resolution failed. They are short-lived Node
# processes reading files; the literal is deliberately smaller than any profile's
# auxiliary quota.

# Documented test seam: which policy catalog the monitor and the verdict read. The
# production default is the file shipped in the image. A test supplies its own so the
# suite can prove the SEQUENCE of a deploy in seconds instead of in the ten real
# minutes the production windows require; the windows themselves are proven by the
# policy unit tests and by the assertion that the shipped catalog declares 60 s.
APOLLO_POLICY_CATALOG="${APOLLO_OPS_POLICY_CATALOG:-config/host-safety-policy.json}"

# Defaulted here so the libraries work when sourced directly (the e2e suites drive one
# function at a time), not only when the orchestrator has initialised everything.
APOLLO_VERDICT_SEQUENCE="${APOLLO_VERDICT_SEQUENCE:-1}"

APOLLO_BOOTSTRAP_CPUS="${APOLLO_OPS_BOOTSTRAP_CPUS:-0.25}"
APOLLO_BOOTSTRAP_MEMORY_BYTES="${APOLLO_OPS_BOOTSTRAP_MEMORY_BYTES:-268435456}"
APOLLO_BOOTSTRAP_PIDS="${APOLLO_OPS_BOOTSTRAP_PIDS:-64}"

declare -A APOLLO_BUDGET_CPUS=()
declare -A APOLLO_BUDGET_MEMORY=()
declare -A APOLLO_BUDGET_PIDS=()
declare -A APOLLO_BUDGET_KIND=()
APOLLO_BUDGET_ENVELOPE=''
APOLLO_BUDGET_SUM=''

# Reads one declared value out of the environment file.
#
# Only `APOLLO_LOCALIZATION_WORKER_ENABLED` is read this way, because the aggregate
# budget has to know whether the optional worker counts before any container runs.
# The value is validated to be `true` or `false` and never journalled or printed;
# the file's other lines are never touched, and the containers keep receiving their
# configuration through `--env-file`.
apollo_env_file_flag() {
  local name="$1"
  local raw
  raw="$(sed -n "s/^[[:space:]]*${name}[[:space:]]*=[[:space:]]*//p" "${APOLLO_ENV_FILE}" | tail -n 1)"
  raw="${raw%$'\r'}"
  raw="${raw%\"}"
  raw="${raw#\"}"
  raw="${raw%\'}"
  raw="${raw#\'}"
  printf '%s' "${raw}"
}

apollo_ops_state_mount_ro() {
  printf '%s:/app/ops-state:ro' "${APOLLO_OPS_STATE_DIR}"
}

# Resolves the aggregate budget. Exit 2 from the CLI aborts before the first
# mutation, which is the whole point of resolving it here.
apollo_resolve_budget() {
  local arguments=(--profile "${APOLLO_RESOURCE_PROFILE}" --localization-enabled "${APOLLO_LOCALIZATION_ENABLED}" --format shell)
  local mounts=()
  if [[ "${APOLLO_RESOURCE_PROFILE}" == 'shared-production' ]]; then
    mounts+=(-v "${APOLLO_RESOURCE_BUDGET_APPROVED_FILE}:/app/ops-budget/approved.json:ro")
    arguments+=(--approved-file /app/ops-budget/approved.json)
  fi
  local output=''
  local status=0
  # shellcheck disable=SC2046
  output="$(docker run --rm \
    --name "apollo-ops-budget-${APOLLO_RUN_ID}" \
    --label apollo.managed=true \
    --label apollo.role=budget \
    --label "apollo.deployment=${APOLLO_RUN_ID}" \
    --cpus "${APOLLO_BOOTSTRAP_CPUS}" \
    --memory "${APOLLO_BOOTSTRAP_MEMORY_BYTES}b" \
    --memory-swap "${APOLLO_BOOTSTRAP_MEMORY_BYTES}b" \
    --pids-limit "${APOLLO_BOOTSTRAP_PIDS}" \
    "${mounts[@]}" \
    "${APOLLO_IMAGE}" \
    ./node_modules/.bin/tsx scripts/ops/resource-budget.mjs "${arguments[@]}")" || status=$?
  if (( status != 0 )); then
    apollo_journal 'budget-rejected' "{\"profile\":\"$(apollo_json_escape "${APOLLO_RESOURCE_PROFILE}")\",\"exitCode\":${status}}"
    apollo_fail "the aggregate resource budget was refused (exit ${status}); nothing has been mutated"
    return 1
  fi
  local kind role cpus memory pids
  while IFS='|' read -r kind role cpus memory pids; do
    [[ -n "${kind}" ]] || continue
    case "${kind}" in
      container|auxiliary)
        APOLLO_BUDGET_KIND["${role}"]="${kind}"
        APOLLO_BUDGET_CPUS["${role}"]="${cpus}"
        APOLLO_BUDGET_MEMORY["${role}"]="${memory}"
        APOLLO_BUDGET_PIDS["${role}"]="${pids}"
        ;;
      envelope)
        APOLLO_BUDGET_ENVELOPE="${cpus} cpus / ${memory} bytes / ${pids} pids"
        ;;
      sum)
        APOLLO_BUDGET_SUM="${cpus} cpus / ${memory} bytes / ${pids} pids"
        ;;
    esac
  done <<< "${output}"
  if [[ -z "${APOLLO_BUDGET_CPUS[app]:-}" || -z "${APOLLO_BUDGET_CPUS[monitor]:-}" ]]; then
    apollo_fail 'the budget did not describe the app container and the monitor auxiliary'
    return 1
  fi
  apollo_journal 'budget-resolved' "{\"profile\":\"$(apollo_json_escape "${APOLLO_RESOURCE_PROFILE}")\",\"envelope\":\"$(apollo_json_escape "${APOLLO_BUDGET_ENVELOPE}")\",\"sum\":\"$(apollo_json_escape "${APOLLO_BUDGET_SUM}")\",\"localizationEnabled\":${APOLLO_LOCALIZATION_ENABLED}}"
}

apollo_budget_limit_arguments() {
  local role="$1"
  printf -- '--cpus %s --memory %sb --memory-swap %sb --pids-limit %s' \
    "${APOLLO_BUDGET_CPUS[${role}]}" \
    "${APOLLO_BUDGET_MEMORY[${role}]}" \
    "${APOLLO_BUDGET_MEMORY[${role}]}" \
    "${APOLLO_BUDGET_PIDS[${role}]}"
}

apollo_monitor_container_name() {
  printf 'apollo-ops-monitor-%s' "${APOLLO_RUN_ID}"
}

# Starts the run's monitor. It is the only container this orchestrator is allowed to
# stop besides the Apollo containers it is replacing, because it is the only one it
# started that is not part of the product.
apollo_monitor_start() {
  if [[ "${APOLLO_OPS_MONITOR_MODE:-container}" == 'external' ]]; then
    # A documented test seam only: the suite supplies the samples itself. Accepting
    # it on the shared profile would mean a deploy could claim a preflight that
    # nothing measured.
    if [[ "${APOLLO_RESOURCE_PROFILE}" != 'isolated-ci' ]]; then
      apollo_fail 'APOLLO_OPS_MONITOR_MODE=external is only accepted with APOLLO_RESOURCE_PROFILE=isolated-ci'
      return 1
    fi
    apollo_journal 'monitor-started' '{"mode":"external"}'
    return 0
  fi
  local name
  name="$(apollo_monitor_container_name)"
  # The monitor is the only container that mounts the state directory writable, and it
  # runs as uid 1000; the grant happens here, under the lock, because this is the one
  # step that needs it. `latch release` and `gate open` never touch the permissions.
  apollo_state_grant_monitor_access
  # shellcheck disable=SC2046
  docker run -d \
    --name "${name}" \
    --label apollo.managed=true \
    --label apollo.role=monitor \
    --label "apollo.deployment=${APOLLO_RUN_ID}" \
    $(apollo_budget_limit_arguments monitor) \
    --init \
    --env-file "${APOLLO_ENV_FILE}" \
    --add-host host.docker.internal:host-gateway \
    --network easypanel \
    -v "${APOLLO_OPS_STATE_DIR}:/app/ops-state" \
    -e APOLLO_OPS_STATE_DIR=/app/ops-state \
    -e "APOLLO_OPS_HEALTH_URL=${APOLLO_OPS_HEALTH_URL}" \
    -e APOLLO_PROCESS_ROLE="ops-monitor-${APOLLO_RUN_ID}" \
    "${APOLLO_IMAGE}" \
    ./node_modules/.bin/tsx scripts/ops/host-safety-monitor.mjs \
    --run-id "${APOLLO_RUN_ID}" \
    --profile "${APOLLO_RESOURCE_PROFILE}" \
    --catalog "${APOLLO_POLICY_CATALOG}" \
    --state-dir /app/ops-state >/dev/null || {
    apollo_fail 'the host safety monitor could not be started; no work may begin without it'
    return 1
  }
  apollo_journal 'monitor-started' "{\"mode\":\"container\",\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "$(apollo_container_id "${name}")")\"}"
}

apollo_monitor_alive() {
  [[ "${APOLLO_OPS_MONITOR_MODE:-container}" == 'external' ]] && return 0
  local name
  name="$(apollo_monitor_container_name)"
  [[ "$(apollo_inspect "${name}" '{{.State.Running}}')" == 'true' ]]
}

# Stops the run's own monitor and confirms it, like every other stop.
#
# The monitor belongs to this operation, so stopping it is allowed where stopping a
# foreign container is not — but "stopped" is still a claim. A monitor left running
# keeps republishing gate.json for a run that is over, which is how a finished deploy
# would leave the workers' admission gate under the control of a process nobody owns.
# Returns non-zero when the stop was not confirmed; the caller decides whether that
# ends a green run (it does) or is recorded on the way to a latch (it is).
#
# A removal that fails is journalled and not fatal: an exited container publishes
# nothing and its name carries this run's id, so it collides with no future run.
apollo_monitor_stop() {
  [[ "${APOLLO_OPS_MONITOR_MODE:-container}" == 'external' ]] && {
    apollo_journal 'monitor-stopped' '{"mode":"external"}'
    return 0
  }
  local name
  name="$(apollo_monitor_container_name)"
  apollo_container_exists "${name}" || return 0
  if ! docker stop --timeout 15 "${name}" >/dev/null; then
    apollo_journal 'monitor-stop-inconclusive' "{\"name\":\"$(apollo_json_escape "${name}")\",\"reason\":\"docker-stop-failed\"}"
    apollo_log "the run monitor ${name} did not answer docker stop"
    return 1
  fi
  local status
  status="$(apollo_inspect "${name}" '{{.State.Status}}')"
  if [[ "${status}" != 'exited' && "${status}" != 'dead' ]]; then
    apollo_journal 'monitor-stop-inconclusive' "{\"name\":\"$(apollo_json_escape "${name}")\",\"verify\":{\"status\":\"$(apollo_json_escape "${status}")\"},\"reason\":\"not-terminal\"}"
    apollo_log "the run monitor ${name} is still ${status:-unknown} after docker stop"
    return 1
  fi
  if ! docker rm "${name}" >/dev/null 2>&1; then
    apollo_journal 'monitor-remove-inconclusive' "{\"name\":\"$(apollo_json_escape "${name}")\",\"verify\":{\"status\":\"$(apollo_json_escape "${status}")\"},\"reason\":\"docker-rm-failed\"}"
    apollo_log "the run monitor ${name} stopped but could not be removed"
    return 0
  fi
  apollo_journal 'monitor-stopped' "{\"name\":\"$(apollo_json_escape "${name}")\",\"verify\":{\"status\":\"$(apollo_json_escape "${status}")\"}}"
}

# Asks the verdict container about one phase. Sets APOLLO_VERDICT_ADMIT and
# APOLLO_VERDICT_REASONS; returns non-zero when the phase is refused.
apollo_phase_verdict() {
  local phase="$1"
  shift
  local output=''
  local status=0
  output="$(docker run --rm \
    --name "apollo-ops-verdict-${APOLLO_RUN_ID}-${APOLLO_VERDICT_SEQUENCE}" \
    --label apollo.managed=true \
    --label apollo.role=verdict \
    --label "apollo.deployment=${APOLLO_RUN_ID}" \
    --cpus "${APOLLO_BOOTSTRAP_CPUS}" \
    --memory "${APOLLO_BOOTSTRAP_MEMORY_BYTES}b" \
    --memory-swap "${APOLLO_BOOTSTRAP_MEMORY_BYTES}b" \
    --pids-limit "${APOLLO_BOOTSTRAP_PIDS}" \
    -v "$(apollo_ops_state_mount_ro)" \
    "${APOLLO_IMAGE}" \
    ./node_modules/.bin/tsx scripts/ops/host-safety-verdict.mjs \
    --run-id "${APOLLO_RUN_ID}" \
    --profile "${APOLLO_RESOURCE_PROFILE}" \
    --catalog "${APOLLO_POLICY_CATALOG}" \
    --phase "${phase}" \
    --state-dir /app/ops-state \
    --format shell "$@")" || status=$?
  APOLLO_VERDICT_SEQUENCE=$((APOLLO_VERDICT_SEQUENCE + 1))
  APOLLO_VERDICT_ADMIT="$(printf '%s\n' "${output}" | sed -n 's/^admit=//p' | head -n 1)"
  APOLLO_VERDICT_REASONS="$(printf '%s\n' "${output}" | sed -n 's/^reasons=//p' | head -n 1)"
  APOLLO_VERDICT_GATE_SEQ="$(printf '%s\n' "${output}" | sed -n 's/^gateSeq=//p' | head -n 1)"
  APOLLO_VERDICT_COVERED_MS="$(printf '%s\n' "${output}" | sed -n 's/^coveredMs=//p' | head -n 1)"
  APOLLO_VERDICT_OOM_WINDOW_MS="$(printf '%s\n' "${output}" | sed -n 's/^oomRecentWindowMs=//p' | head -n 1)"
  APOLLO_VERDICT_GATE_AGE_MS="$(printf '%s\n' "${output}" | sed -n 's/^gateAgeMs=//p' | head -n 1)"
  [[ "${APOLLO_VERDICT_ADMIT}" == 'true' ]] && return 0
  return 1
}

# Asks the policy for the values the HOST side needs, before the monitor exists.
#
# An unconfigured policy cannot answer, and an operation whose thresholds are not
# declared must not begin: the refusal here is the same fail-closed answer the workers
# would get from a closed gate.
apollo_load_policy_observation() {
  apollo_phase_verdict during --no-require-gate >/dev/null 2>&1 || true
  if [[ -z "${APOLLO_VERDICT_OOM_WINDOW_MS:-}" || "${APOLLO_VERDICT_OOM_WINDOW_MS}" == '0' ]]; then
    apollo_fail "profile ${APOLLO_RESOURCE_PROFILE} does not declare oomRecentWindowMs (and the other observation values); the policy cannot judge this host until the owner sets them"
    return 1
  fi
}

# Waits for a phase to be admitted, bounded. The monitor must be alive throughout:
# a dead monitor closes the gate (AGENTS.md line 205) and the wait ends immediately
# rather than idling until the timeout.
apollo_await_phase() {
  local phase="$1"
  local timeout_s="$2"
  local sleep_s="${APOLLO_OPS_POLL_SLEEP_S:-10}"
  local waited=0
  while :; do
    if ! apollo_monitor_alive; then
      apollo_journal "${phase}-verdict" "{\"admit\":false,\"reasons\":\"monitor-not-running\"}"
      apollo_fail "the host safety monitor is not running; ${phase} cannot be established"
      return 1
    fi
    if apollo_phase_verdict "${phase}" --max-decision-age-ms 20000; then
      apollo_journal "${phase}-verdict" "{\"admit\":true,\"gateSeq\":${APOLLO_VERDICT_GATE_SEQ:-0},\"coveredMs\":${APOLLO_VERDICT_COVERED_MS:-0}}"
      apollo_log "${phase} established (${APOLLO_VERDICT_COVERED_MS} ms of samples covered)"
      return 0
    fi
    if (( waited >= timeout_s )); then
      apollo_journal "${phase}-verdict" "{\"admit\":false,\"reasons\":\"$(apollo_json_escape "${APOLLO_VERDICT_REASONS}")\",\"waitedSeconds\":${waited}}"
      apollo_fail "${phase} was not established within ${timeout_s}s: reasons=${APOLLO_VERDICT_REASONS} gateSeq=${APOLLO_VERDICT_GATE_SEQ:-?} gateAgeMs=${APOLLO_VERDICT_GATE_AGE_MS:-?} coveredMs=${APOLLO_VERDICT_COVERED_MS:-?}"
      return 1
    fi
    sleep "${sleep_s}"
    waited=$(( waited + sleep_s ))
  done
}

# Re-reads the admission decision between two steps. The gate must be open, fresh
# and advancing: a monitor that hung keeps a recent file and a frozen seq.
apollo_gate_still_open() {
  if ! apollo_monitor_alive; then
    APOLLO_VERDICT_REASONS='monitor-not-running'
    return 1
  fi
  local previous="${APOLLO_LAST_GATE_SEQ:-0}"
  if apollo_phase_verdict during --max-decision-age-ms 20000 --last-seen-seq "${previous}"; then
    APOLLO_LAST_GATE_SEQ="${APOLLO_VERDICT_GATE_SEQ}"
    return 0
  fi
  return 1
}

# Bounded wait for the PostgreSQL backends of one application_name to reach zero in
# the monitor's samples. A stopped container that still has a backend is the 29 July
# failure: the exit status said stopped and the client kept reconnecting.
apollo_await_zero_backends() {
  local application_name="$1"
  local attempts="${APOLLO_OPS_BACKEND_WAIT_ATTEMPTS:-6}"
  local sleep_s="${APOLLO_OPS_BACKEND_WAIT_SLEEP_S:-10}"
  local attempt=1
  while (( attempt <= attempts )); do
    if apollo_phase_verdict during --max-decision-age-ms 20000 --require-zero-backends "${application_name}"; then
      return 0
    fi
    case "${APOLLO_VERDICT_REASONS}" in
      *pg-backends-present*|*pg-backends-unobserved*)
        # The only retryable answer: the backends are closing.
        ;;
      *)
        # Print what the decision actually said, not only that it said no: the reasons,
        # the seq and the age the verdict judged separate "the host is busy" from "nobody
        # published a sample for twenty seconds".
        apollo_log "the gate closed while waiting for ${application_name} backends: reasons=${APOLLO_VERDICT_REASONS} gateSeq=${APOLLO_VERDICT_GATE_SEQ:-?} gateAgeMs=${APOLLO_VERDICT_GATE_AGE_MS:-?} coveredMs=${APOLLO_VERDICT_COVERED_MS:-?}"
        return 1
        ;;
    esac
    sleep "${sleep_s}"
    attempt=$(( attempt + 1 ))
  done
  apollo_log "backends of ${application_name} did not reach zero after ${attempts} attempts: reasons=${APOLLO_VERDICT_REASONS} gateAgeMs=${APOLLO_VERDICT_GATE_AGE_MS:-?}"
  return 1
}
