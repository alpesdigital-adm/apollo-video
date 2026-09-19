# shellcheck shell=bash
#
# Shared mechanics of the Apollo VPS orchestrator.
#
# The host is assumed to have bash and docker and NOT Node: every Node-side
# decision (the resource budget, the host-safety verdict, the monitor) runs inside
# a container built from the Apollo image, and this shell only performs effects.
# That is also why the lock owner, the latch and the journal are written here in
# bash rather than by a container: a PID recorded inside a container's namespace is
# useless to the host rule that decides whether a lock is an orphan.
#
# Nothing in this file prints an environment value. The containers receive their
# configuration through `--env-file`, so no secret passes through this shell, and
# the journal records names, ids, statuses and counts only.

apollo_log() {
  printf '%s %s\n' "$(apollo_iso_now)" "$*" >&2
}

apollo_fail() {
  printf '%s deploy: %s\n' "$(apollo_iso_now)" "$*" >&2
  return 1
}

apollo_iso_now() {
  date -u +%Y-%m-%dT%H:%M:%S.000Z
}

# Milliseconds since boot, from /proc/uptime.
#
# This is CLOCK_BOOTTIME, not the CLOCK_MONOTONIC the monitor publishes, so it is
# used for ORDERING journal lines on this host and never compared with the
# monitor's `issuedAtMonotonicMs`. Freshness of a decision is judged by the verdict
# container, which reads the same clock the monitor wrote.
apollo_uptime_ms() {
  if [[ -r /proc/uptime ]]; then
    awk '{ printf "%.0f", $1 * 1000 }' /proc/uptime
  else
    # No procfs (a developer machine running the suite): a wall-clock millisecond
    # count still orders the lines, and nothing compares it across processes.
    date -u +%s000
  fi
}

apollo_boot_id() {
  if [[ -r /proc/sys/kernel/random/boot_id ]]; then
    tr -d '\n' < /proc/sys/kernel/random/boot_id
  else
    printf 'no-boot-id-%s' "$(hostname)"
  fi
}

# Escapes one scalar for embedding in JSON. Control characters are dropped rather
# than encoded: a journal line must stay one line.
apollo_json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="$(printf '%s' "$value" | tr -d '\000-\037')"
  printf '%s' "$value"
}

apollo_require_env() {
  local name="$1"
  local description="$2"
  if [[ -z "${!name:-}" ]]; then
    apollo_fail "${name} is required (${description}); this script defines no default for it"
    return 1
  fi
}

apollo_require_command() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || {
    apollo_fail "${name} is not available on this host"
    return 1
  }
}

# Rounds a possibly fractional CPU quota to the NanoCpus the daemon will report.
apollo_nano_cpus() {
  awk -v cpus="$1" 'BEGIN { printf "%.0f", cpus * 1000000000 }'
}

apollo_generate_run_id() {
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local suffix
  if [[ -r /dev/urandom ]]; then
    suffix="$(od -An -tx1 -N3 < /dev/urandom | tr -d ' \n')"
  else
    suffix="$$"
  fi
  printf 'deploy-%s-%s' "$stamp" "$suffix"
}
