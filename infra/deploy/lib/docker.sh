# shellcheck shell=bash
#
# Every Docker interaction of the orchestrator, with the confirmations that turn a
# command into a fact.
#
# The two `|| true` of the previous version are gone. They swallowed any failure of
# `docker stop` and `docker rm`, which is how a deploy could report success while a
# container it believed replaced was still running and still holding PostgreSQL
# backends. AGENTS.md line 223 forbids claiming something stopped without verifying
# the terminal state and the absence of the run's processes and connections, so a
# stop here is followed by three separate confirmations and an ambiguous answer
# aborts instead of retrying (line 225: a timeout without confirmation forbids
# stacking commands).
#
# The inspect format strings are literal on purpose: they are the contract the fake
# Docker of the test suite answers, so a change here breaks a test instead of
# silently returning an empty string (a Go template for a field that does not exist
# prints nothing and exits 0 — the projection trap).

APOLLO_INSPECT_IDENTITY_FORMAT='{{index .Config.Labels "apollo.managed"}}|{{index .Config.Labels "apollo.role"}}|{{.Config.Image}}|{{.Id}}'
APOLLO_INSPECT_LIMITS_FORMAT='{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}'
APOLLO_INSPECT_NETWORKS_FORMAT='{{.Config.Image}}|{{range $name, $value := .NetworkSettings.Networks}}{{$name}} {{end}}'

apollo_container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

apollo_inspect() {
  docker inspect --format "$2" "$1" 2>/dev/null
}

apollo_container_id() {
  apollo_inspect "$1" '{{.Id}}'
}

# Refuses to touch a container that does not prove it is ours.
#
# An unlabelled container is almost certainly the fleet from before this wave, and
# adopting it silently would mean the identity check can be satisfied by anything
# that happens to carry the right name. The operator may adopt it once, explicitly,
# and the adoption is journalled with the image and networks that were inspected.
apollo_require_identity() {
  local name="$1"
  local role="$2"
  local identity
  identity="$(apollo_inspect "${name}" "${APOLLO_INSPECT_IDENTITY_FORMAT}")"
  local managed="${identity%%|*}"
  local rest="${identity#*|}"
  local observed_role="${rest%%|*}"
  rest="${rest#*|}"
  local image="${rest%%|*}"
  local id="${rest#*|}"
  if [[ "${managed}" == 'true' && "${observed_role}" == "${role}" ]]; then
    return 0
  fi
  if [[ "${APOLLO_ADOPT_UNLABELLED}" == "${name}" ]]; then
    local evidence
    evidence="$(apollo_inspect "${name}" "${APOLLO_INSPECT_NETWORKS_FORMAT}")"
    apollo_journal 'adopt-unlabelled' "{\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "${id}")\",\"role\":\"$(apollo_json_escape "${role}")\"},\"observed\":{\"managed\":\"$(apollo_json_escape "${managed}")\",\"role\":\"$(apollo_json_escape "${observed_role}")\",\"image\":\"$(apollo_json_escape "${image}")\",\"inspected\":\"$(apollo_json_escape "${evidence}")\"}}"
    apollo_log "adopting unlabelled container ${name} once, as authorised by --adopt-unlabelled"
    return 0
  fi
  apollo_journal 'step-blocked' "{\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "${id}")\",\"role\":\"$(apollo_json_escape "${role}")\"},\"observed\":{\"managed\":\"$(apollo_json_escape "${managed}")\",\"role\":\"$(apollo_json_escape "${observed_role}")\",\"image\":\"$(apollo_json_escape "${image}")\"},\"reason\":\"identity-not-proven\"}"
  apollo_log "BLOCKED: ${name} does not carry apollo.managed=true and apollo.role=${role}."
  apollo_log "This deploy will not stop a container whose identity it cannot prove."
  apollo_log "Regularise it once, in one of two ways:"
  apollo_log "  1. stop and remove it by hand after confirming what it is, then deploy again; or"
  apollo_log "  2. re-run this deploy with --adopt-unlabelled ${name}, which records the"
  apollo_log "     inspected image and networks in the journal before replacing it."
  return 1
}

# Stops one container and confirms it: terminal status, no PID, and — through the
# monitor's samples — no PostgreSQL backend left under its application_name.
# Returns 1 on any ambiguity, so the caller can latch instead of retrying.
apollo_stop_confirmed() {
  local name="$1"
  local role="$2"
  local id
  id="$(apollo_container_id "${name}")"
  apollo_journal 'step-start' "{\"step\":\"stop\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "${id}")\",\"labels\":{\"apollo.role\":\"$(apollo_json_escape "${role}")\"}}}"
  if ! docker stop --timeout 30 "${name}" >/dev/null; then
    apollo_journal 'step-inconclusive' "{\"step\":\"stop\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "${id}")\"},\"reason\":\"docker-stop-failed\"}"
    return 1
  fi
  local status pid
  status="$(apollo_inspect "${name}" '{{.State.Status}}')"
  pid="$(apollo_inspect "${name}" '{{.State.Pid}}')"
  if [[ "${status}" != 'exited' && "${status}" != 'dead' ]]; then
    apollo_journal 'step-inconclusive' "{\"step\":\"stop\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "${id}")\"},\"verify\":{\"status\":\"$(apollo_json_escape "${status}")\",\"pid\":\"$(apollo_json_escape "${pid}")\"},\"reason\":\"not-terminal\"}"
    return 1
  fi
  if [[ "${pid}" != '0' ]]; then
    apollo_journal 'step-inconclusive' "{\"step\":\"stop\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "${id}")\"},\"verify\":{\"status\":\"$(apollo_json_escape "${status}")\",\"pid\":\"$(apollo_json_escape "${pid}")\"},\"reason\":\"pid-still-present\"}"
    return 1
  fi
  if ! apollo_await_zero_backends "apollo-video-${role}"; then
    apollo_journal 'step-inconclusive' "{\"step\":\"stop\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "${id}")\"},\"verify\":{\"status\":\"$(apollo_json_escape "${status}")\",\"pid\":0,\"backends\":\"not-zero\"},\"reason\":\"backends-remain\"}"
    return 1
  fi
  apollo_journal 'step-verify' "{\"step\":\"stop\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\",\"id\":\"$(apollo_json_escape "${id}")\"},\"verify\":{\"status\":\"$(apollo_json_escape "${status}")\",\"pid\":0,\"backends\":0}}"
}

apollo_remove_confirmed() {
  local name="$1"
  if ! docker rm "${name}" >/dev/null; then
    apollo_journal 'step-inconclusive' "{\"step\":\"remove\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"},\"reason\":\"docker-rm-failed\"}"
    return 1
  fi
  if apollo_container_exists "${name}"; then
    apollo_journal 'step-inconclusive' "{\"step\":\"remove\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"},\"reason\":\"still-present-after-rm\"}"
    return 1
  fi
  apollo_journal 'step-done' "{\"step\":\"remove\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"}}"
}

# Confirms the daemon really applied the quota. A limit the daemon silently dropped
# is a container with no ceiling on a shared host, which is the failure the budget
# exists to prevent, so a mismatch is inconclusive rather than a warning.
apollo_readback_limits() {
  local name="$1"
  local cpus="$2"
  local memory_bytes="$3"
  local pids="$4"
  local expected
  expected="$(apollo_nano_cpus "${cpus}")|${memory_bytes}|${memory_bytes}|${pids}"
  local observed
  observed="$(apollo_inspect "${name}" "${APOLLO_INSPECT_LIMITS_FORMAT}")"
  if [[ "${observed}" != "${expected}" ]]; then
    apollo_journal 'step-inconclusive' "{\"step\":\"readback\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"},\"verify\":{\"expected\":\"$(apollo_json_escape "${expected}")\",\"observed\":\"$(apollo_json_escape "${observed}")\"},\"reason\":\"limit-readback-mismatch\"}"
    return 1
  fi
  apollo_journal 'step-verify' "{\"step\":\"readback\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"},\"verify\":{\"limits\":\"$(apollo_json_escape "${observed}")\"}}"
}

# Host-side OOM check, before the monitor even starts.
#
# The collector can only see an OOM kill that happens between two of the run's own
# samples: `oom_kill` is a cumulative counter, so a kill two minutes before the deploy
# began is invisible to it. The daemon, however, remembers per container, and this
# costs one inspect each. Any Apollo container killed for memory inside the recent
# window — or killed with no usable timestamp — closes the gate before anything is
# touched.
#
# What this does NOT cover: an OOM kill of a process outside an Apollo container, or
# one whose container has since been removed. Reading the kernel log (`journalctl -k`)
# would find those, and is deliberately not attempted: it needs privileges this
# operation does not have and is not portable across the hosts this script runs on.
# The honest claim is therefore "OOM kills of Apollo containers, plus any kill observed
# during the run's own window".
apollo_preflight_container_oom() {
  local recent_window_ms="$1"
  if [[ -z "${recent_window_ms}" || ! "${recent_window_ms}" =~ ^[0-9]+$ ]]; then
    apollo_fail 'the OOM recency window is not configured; the policy cannot judge a recent OOM'
    return 1
  fi
  local now_epoch
  now_epoch="$(date -u +%s)"
  local role name observation killed finished finished_epoch age_ms
  for role in "${APOLLO_ROLES[@]}"; do
    name="$(apollo_container_for_role "${role}")"
    apollo_container_exists "${name}" || continue
    observation="$(apollo_inspect "${name}" '{{.State.OOMKilled}}|{{.State.FinishedAt}}')"
    killed="${observation%%|*}"
    finished="${observation#*|}"
    [[ "${killed}" == 'true' ]] || continue
    finished_epoch="$(date -u -d "${finished%%.*}Z" +%s 2>/dev/null || echo 0)"
    if (( finished_epoch <= 0 )); then
      apollo_journal 'preflight-verdict' "{\"admit\":false,\"reasons\":\"oom-recent\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"},\"observed\":\"$(apollo_json_escape "${observation}")\",\"detail\":\"no usable FinishedAt\"}"
      apollo_fail "${name} was OOM killed and the daemon reports no usable timestamp; treat it as recent"
      return 1
    fi
    age_ms=$(( (now_epoch - finished_epoch) * 1000 ))
    if (( age_ms <= recent_window_ms )); then
      apollo_journal 'preflight-verdict' "{\"admit\":false,\"reasons\":\"oom-recent\",\"target\":{\"name\":\"$(apollo_json_escape "${name}")\"},\"observed\":\"$(apollo_json_escape "${observation}")\",\"ageMs\":${age_ms}}"
      apollo_fail "${name} was OOM killed ${age_ms}ms ago, inside the ${recent_window_ms}ms recency window"
      return 1
    fi
  done
  apollo_journal 'step-verify' "{\"step\":\"container-oom\",\"verify\":{\"recentWindowMs\":${recent_window_ms},\"oomKilled\":0}}"
}

apollo_cgroup_capability() {
  local capability
  capability="$(docker info --format '{{.CgroupVersion}}|{{.CgroupDriver}}')" || {
    apollo_fail 'docker info did not answer; the daemon cannot be interrogated'
    return 1
  }
  local version="${capability%%|*}"
  local driver="${capability#*|}"
  local warnings
  warnings="$(docker info --format '{{range .Warnings}}{{.}}
{{end}}' 2>/dev/null || true)"
  apollo_journal 'cgroup-capability' "{\"version\":\"$(apollo_json_escape "${version}")\",\"driver\":\"$(apollo_json_escape "${driver}")\",\"warnings\":\"$(apollo_json_escape "${warnings}")\"}"
  if [[ "${version}" != '2' ]]; then
    apollo_fail "the daemon reports cgroup version '${version}'; the aggregate budget requires cgroup v2 to be enforceable"
    return 1
  fi
  if [[ "${driver}" != 'systemd' && "${driver}" != 'cgroupfs' ]]; then
    apollo_fail "unrecognised cgroup driver '${driver}'"
    return 1
  fi
  if printf '%s' "${warnings}" | grep -Eqi 'no (memory|swap|cpu|pids|cfs) .*support|limit support'; then
    apollo_fail "the daemon warns that a limit is not supported; quotas would be accepted and not applied: ${warnings}"
    return 1
  fi
}
