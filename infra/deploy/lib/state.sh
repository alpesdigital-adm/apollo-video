# shellcheck shell=bash
#
# Host operational state: lock, latch and journal, written by the shell that owns
# the operation.
#
# The formats are the ones `src/v2/infrastructure/host-safety/{lock,latch,journal,
# gate-file}.ts` read, and `tests/v2/deploy-fake-docker.test.mjs` parses what this
# file writes with those TypeScript readers — the two halves exist because the host
# has no Node, so the only defence against them drifting apart is a test that makes
# one read the other.
#
# The directory holds host operational state only: gate.json, latch.json, lock/ and
# journal/. No job, version or artifact ever appears here; product state lives in
# PostgreSQL.

APOLLO_LOCK_ORPHAN_AFTER_MS=600000

apollo_state_paths() {
  APOLLO_LOCK_DIR="${APOLLO_OPS_STATE_DIR}/lock"
  APOLLO_LOCK_OWNER="${APOLLO_LOCK_DIR}/owner.json"
  APOLLO_LATCH_FILE="${APOLLO_OPS_STATE_DIR}/latch.json"
  APOLLO_GATE_FILE="${APOLLO_OPS_STATE_DIR}/gate.json"
  APOLLO_JOURNAL_DIR="${APOLLO_OPS_STATE_DIR}/journal"
}

apollo_state_prepare() {
  apollo_state_paths
  [[ -d "${APOLLO_OPS_STATE_DIR}" ]] || {
    apollo_fail "APOLLO_OPS_STATE_DIR ${APOLLO_OPS_STATE_DIR} does not exist; create it on the host before deploying"
    return 1
  }
  mkdir -p "${APOLLO_JOURNAL_DIR}"
}

# Appends one event to journal/<runId>.ndjson. `data` is a JSON fragment the caller
# builds from names, ids and counts; never from an environment value.
apollo_journal() {
  # `plan` and `status` are read-only commands: they never write a journal line, so
  # "the plan mutated nothing" is true of the state directory as well as of Docker.
  [[ "${APOLLO_JOURNAL_ENABLED:-1}" == '1' ]] || return 0
  # Self-sufficient on purpose. The journal is the evidence that a step happened, and
  # the first thing several paths journal is the refusal that stopped them — so it must
  # not depend on an earlier step having prepared the directory. Both calls are cheap
  # and idempotent; a caller that sourced the libraries directly gets the same trail as
  # the orchestrator.
  [[ -n "${APOLLO_JOURNAL_DIR:-}" ]] || apollo_state_paths
  mkdir -p "${APOLLO_JOURNAL_DIR}"
  local event="$1"
  local data="${2:-null}"
  local line
  line="{\"tIso\":\"$(apollo_iso_now)\",\"monotonicMs\":$(apollo_uptime_ms),\"runId\":\"$(apollo_json_escape "${APOLLO_RUN_ID}")\",\"event\":\"$(apollo_json_escape "${event}")\",\"data\":${data}}"
  printf '%s\n' "${line}" >> "${APOLLO_JOURNAL_DIR}/${APOLLO_RUN_ID}.ndjson"
}

apollo_latch_engaged() {
  [[ -e "${APOLLO_LATCH_FILE}" ]]
}

# Engages the latch and keeps the first cause: a second failure must not overwrite
# the evidence of what actually went wrong.
apollo_latch_engage() {
  local reason="$1"
  local detail="$2"
  if apollo_latch_engaged; then
    apollo_log "latch already engaged; keeping the first cause"
    apollo_journal 'latch-engaged' "{\"reason\":\"$(apollo_json_escape "${reason}")\",\"alreadyEngaged\":true}"
    return 0
  fi
  local temporary="${APOLLO_LATCH_FILE}.$$.tmp"
  cat > "${temporary}" <<JSON
{
  "schemaVersion": "apollo-ops-latch/v1",
  "engagedAtIso": "$(apollo_iso_now)",
  "runId": "$(apollo_json_escape "${APOLLO_RUN_ID}")",
  "reason": "$(apollo_json_escape "${reason}")",
  "detail": "$(apollo_json_escape "${detail}")",
  "evidence": {
    "journal": "journal/$(apollo_json_escape "${APOLLO_RUN_ID}").ndjson",
    "lastSampleSeq": null
  }
}
JSON
  mv "${temporary}" "${APOLLO_LATCH_FILE}"
  apollo_journal 'latch-engaged' "{\"reason\":\"$(apollo_json_escape "${reason}")\",\"detail\":\"$(apollo_json_escape "${detail}")\"}"
  apollo_log "LATCH ENGAGED (${reason}): ${detail}"
  apollo_log "no further container is touched; release with: apollo-vps.sh latch release --reason \"<text>\""
}

# Moves the latch into journal/ with the operator's reason. Never removes it.
apollo_latch_release() {
  local reason="$1"
  apollo_latch_engaged || {
    apollo_fail 'no latch is engaged'
    return 1
  }
  local engaged_at
  engaged_at="$(sed -n 's/.*"engagedAtIso": *"\([^"]*\)".*/\1/p' "${APOLLO_LATCH_FILE}" | head -n 1)"
  [[ -n "${engaged_at}" ]] || engaged_at="$(apollo_iso_now)"
  local slug
  slug="$(printf '%s' "${engaged_at}" | tr -cd '0-9A-Za-z')"
  local archived="${APOLLO_JOURNAL_DIR}/latch-${slug}.released.json"
  # The archive is written before the latch stops being the host's answer: a crash
  # between the two leaves the latch engaged, which is the safe side of the failure.
  apollo_latch_write_release_record "${archived}" "${reason}"
  mv "${APOLLO_LATCH_FILE}" "${archived}.source"
  apollo_journal 'latch-released' "{\"reason\":\"$(apollo_json_escape "${reason}")\",\"archivedAt\":\"$(apollo_json_escape "${archived}")\"}"
  apollo_log "latch released and archived at ${archived}"
}

# Writes the release record without needing a JSON tool on the host; the original
# latch document is preserved verbatim next to it as `<archive>.source`, so the
# release adds evidence and removes none.
apollo_latch_write_release_record() {
  local archived="$1"
  local reason="$2"
  cat > "${archived}" <<JSON
{
  "schemaVersion": "apollo-ops-latch-release/v1",
  "releasedAtIso": "$(apollo_iso_now)",
  "releaseReason": "$(apollo_json_escape "${reason}")",
  "releasedByRunId": "$(apollo_json_escape "${APOLLO_RUN_ID}")",
  "source": "$(apollo_json_escape "$(basename "${archived}").source")"
}
JSON
}

# Acquires the one mutable operation lock. `mkdir` is the compare-and-set; identity,
# never age, decides whether an existing lock may be taken over.
apollo_lock_acquire() {
  local command="$1"
  local boot_id
  boot_id="$(apollo_boot_id)"
  if mkdir "${APOLLO_LOCK_DIR}" 2>/dev/null; then
    apollo_lock_write_owner "${command}" "${boot_id}"
    apollo_journal 'lock-acquired' "{\"command\":\"$(apollo_json_escape "${command}")\",\"pid\":$$,\"tookOverOrphan\":null}"
    return 0
  fi
  # The loser of a `mkdir` race can arrive between the winner's `mkdir` and the moment
  # its owner.json is in place. Reading that half-written file and comparing its empty
  # `bootId` with the real one used to "prove" the lock was from another boot, and the
  # loser took it over: two deploys, both believing they held the lock (CI run
  # 35450914276). A few short re-reads cover the window; after that an incomplete owner
  # is a HELD lock whose owner is unreadable, never an orphan.
  local holder_run holder_pid holder_boot holder_started holder_host
  local attempt
  for attempt in 1 2 3; do
    holder_run="$(apollo_lock_field runId)"
    holder_pid="$(apollo_lock_field pid)"
    holder_boot="$(apollo_lock_field bootId)"
    holder_started="$(apollo_lock_field startedAtIso)"
    holder_host="$(apollo_lock_field hostname)"
    [[ -n "${holder_run}" && -n "${holder_pid}" && -n "${holder_boot}" && -n "${holder_started}" ]] && break
    sleep 0.2
  done
  if [[ -z "${holder_run}" || -z "${holder_pid}" || -z "${holder_boot}" || -z "${holder_started}" ]]; then
    apollo_fail "the operation lock ${APOLLO_LOCK_DIR} is held and its owner.json is missing, empty or still being written; it is never treated as an orphan"
    return 1
  fi
  local orphan_because=''
  if [[ "${holder_boot}" != "${boot_id}" ]]; then
    orphan_because='different-boot-id'
  elif ! kill -0 "${holder_pid}" 2>/dev/null; then
    local started_epoch now_epoch
    started_epoch="$(date -u -d "${holder_started}" +%s 2>/dev/null || echo 0)"
    now_epoch="$(date -u +%s)"
    if (( started_epoch > 0 )) && (( (now_epoch - started_epoch) * 1000 > APOLLO_LOCK_ORPHAN_AFTER_MS )); then
      orphan_because='pid-absent-and-older-than-grace'
    fi
  fi
  if [[ -z "${orphan_because}" ]]; then
    apollo_fail "another operation holds the lock: run ${holder_run} pid ${holder_pid} on ${holder_host} since ${holder_started}"
    return 1
  fi
  local archived="${APOLLO_JOURNAL_DIR}/lock-${holder_run}.orphaned.json"
  mv "${APOLLO_LOCK_OWNER}" "${archived}"
  rmdir "${APOLLO_LOCK_DIR}" 2>/dev/null || rm -rf "${APOLLO_LOCK_DIR}"
  mkdir "${APOLLO_LOCK_DIR}" || {
    apollo_fail 'another run acquired the lock while the orphan was being archived'
    return 1
  }
  apollo_lock_write_owner "${command}" "${boot_id}"
  apollo_journal 'lock-acquired' "{\"command\":\"$(apollo_json_escape "${command}")\",\"pid\":$$,\"tookOverOrphan\":\"$(apollo_json_escape "${archived}")\",\"orphanedBecause\":\"${orphan_because}\"}"
  apollo_log "took over an orphaned lock (${orphan_because}) from run ${holder_run}"
}

# Publishes the owner atomically.
#
# `cat > owner.json` makes the file appear empty and then fill up, which is precisely
# the state another racer must never read as evidence. A temporary file inside the lock
# directory followed by `mv` means the file either is not there or is complete.
apollo_lock_write_owner() {
  local command="$1"
  local boot_id="$2"
  local temporary="${APOLLO_LOCK_DIR}/.owner.$$.tmp"
  cat > "${temporary}" <<JSON
{
  "schemaVersion": "apollo-ops-lock/v1",
  "runId": "$(apollo_json_escape "${APOLLO_RUN_ID}")",
  "pid": $$,
  "startedAtIso": "$(apollo_iso_now)",
  "bootId": "$(apollo_json_escape "${boot_id}")",
  "command": "$(apollo_json_escape "${command}")",
  "hostname": "$(apollo_json_escape "$(hostname)")"
}
JSON
  mv "${temporary}" "${APOLLO_LOCK_OWNER}"
}

apollo_lock_field() {
  [[ -r "${APOLLO_LOCK_OWNER}" ]] || return 0
  sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\},\{0,1\}.*/\1/p" "${APOLLO_LOCK_OWNER}" | head -n 1
}

apollo_lock_release() {
  [[ -r "${APOLLO_LOCK_OWNER}" ]] || return 0
  local holder_run
  holder_run="$(apollo_lock_field runId)"
  if [[ "${holder_run}" != "${APOLLO_RUN_ID}" ]]; then
    apollo_log "not releasing a lock owned by run ${holder_run}"
    return 0
  fi
  apollo_journal 'lock-released' 'null'
  rm -f "${APOLLO_LOCK_OWNER}"
  rmdir "${APOLLO_LOCK_DIR}" 2>/dev/null || rm -rf "${APOLLO_LOCK_DIR}"
}

# Absence of gate.json is the open state, so the end of a green run removes it.
apollo_gate_clear() {
  local reason="$1"
  rm -f "${APOLLO_GATE_FILE}"
  apollo_journal 'gate-opened' "{\"reason\":\"$(apollo_json_escape "${reason}")\"}"
}
