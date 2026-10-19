import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectNamespaceObserver } from './perception-observer-channel.mjs'
import { loadPidfdBinding, signalViaPidfd } from './perception-pidfd.mjs'

// Disposable Linux CI only. Ownership follows PID/starttime and an inherited
// unique run marker, even across setsid/reparenting. Containment is not success.
const RUN_MARKER = 'APOLLO_PERCEPTION_RUN_ID'
// Reserve process containment plus PG postflight, log close and receipt IO.
export const CLEANUP_BUDGET_MS = 90_000
const TREE_CLEANUP_BUDGET_MS = 25_000
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const diagnostic = (error) => String(error?.stack ?? error) +
  (error?.admissionLockDiagnostic ? `\nadmissionLockDiagnostic=${JSON.stringify(error.admissionLockDiagnostic)}` : '')
const identityKey = ({ pid, starttime }) => `${pid}:${starttime}`
const live = (entry) => entry && !['Z', 'X', 'x'].includes(entry.state)

async function bounded(action, ms, label) {
  let timer
  try { return await Promise.race([action(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), ms)
  })]) } finally { clearTimeout(timer) }
}

export function createPerceptionRunId() {
  return `perception-${process.pid}-${Date.now()}-${randomUUID()}`
}

function linuxStatFailureFacts(text, stage) {
  const isText = typeof text === 'string', end = isText ? text.lastIndexOf(')') : -1
  const prefix = isText && /^[1-9]\d* \(/.test(text)
  const delimiter = prefix && end > text.indexOf('(') && text.slice(end, end + 2) === ') '
  const fields = delimiter ? text.slice(end + 2).trim().split(/\s+/) : null
  const invalid = fields ? fields.flatMap((field, index) => index > 0 && !/^-?\d+$/.test(field) ? [index + 3] : []) : []
  const ancestry = fields ? fields.slice(1, 4).map((field) => /^\d+$/.test(field) && Number.isSafeInteger(Number(field))) : []
  let guardCode = stage
  if (stage === 'IDENTITY_CHECK') {
    const pid = Number(text.slice(0, text.indexOf(' ')))
    guardCode = !Number.isSafeInteger(pid) || pid <= 0 ? 'PID_RANGE' : fields.length < 50 ? 'FIELD_COUNT'
      : !/^[RSDZTtWXxIKP]$/.test(fields[0]) ? 'STATE_FORMAT' : !/^\d+$/.test(fields[19]) ? 'STARTTIME_FORMAT'
        : invalid.length ? 'NUMERIC_FIELD_FORMAT' : !ancestry[0] ? 'PPID_FORMAT_OR_RANGE'
          : !ancestry[1] ? 'PGRP_FORMAT_OR_RANGE' : !ancestry[2] ? 'SESSION_FORMAT_OR_RANGE' : 'UNCLASSIFIED_GUARD'
  }
  const statBytes = isText ? Buffer.byteLength(text) : null
  const numericAncestry = fields?.slice(1, 4).map((field) => /^-?\d+$/.test(field) && Number.isSafeInteger(Number(field))
    ? Number(field) : null) ?? []
  const pid = prefix ? Number(text.slice(0, text.indexOf(' '))) : null
  // Linux v6.8 fs/proc/array.c do_task_stat initializes this exact tuple;
  // lock_task_sighand must succeed to fill it. It is NOT a process identity.
  // Recognition alone does not establish a particular read's kernel/cause.
  const unavailable = stage === 'IDENTITY_CHECK' && Number.isSafeInteger(pid) && pid > 0 && fields?.length >= 50 &&
    /^[RSDZTtWXxIKP]$/.test(fields[0]) && /^\d{1,32}$/.test(fields[19]) &&
    fields.slice(1).every((field) => /^-?\d+$/.test(field)) &&
    fields[1] === '0' && fields[2] === '-1' && fields[3] === '-1'
      ? { schemaVersion: 'linux-task-sighand-unavailable/v1', pid, state: fields[0], starttime: fields[19],
        ppid: 0, processGroupId: -1, sessionId: -1, identityEstablished: false, terminalityEstablished: false } : null
  return { schemaVersion: 'linux-proc-stat-diagnostic/v1', stage: 'parse-stat', guardCode,
    statBytes, statSha256: isText && statBytes <= 65536 ? createHash('sha256').update(text).digest('hex') : null,
    statHashScope: !isText ? 'not-string' : statBytes > 65536 ? 'unmeasured-over-bound' : 'complete',
    commFormat: !isText ? 'not-string' : !prefix ? 'invalid-prefix' : !delimiter ? 'invalid-delimiter' : 'valid-delimited',
    fieldCount: fields?.length ?? null, minimumFieldCount: 50,
    invalidNumericFieldCount: invalid.length, invalidNumericFieldNumbers: invalid.slice(0, 8),
    numericAncestry: { ppid: numericAncestry[0] ?? null, processGroupId: numericAncestry[1] ?? null,
      sessionId: numericAncestry[2] ?? null }, unavailableObservation: unavailable }
}

export function parseLinuxProcessStat(text) {
  let stage = 'VALUE_TYPE'
  try {
  assert.equal(typeof text, 'string')
  const end = text.lastIndexOf(')')
  stage = 'PID_PREFIX'
  assert.match(text, /^[1-9]\d* \(/, 'Malformed Linux process identity')
  stage = 'COMM_DELIMITER'
  assert.ok(end > text.indexOf('(') && text.slice(end, end + 2) === ') ', 'Malformed Linux comm delimiter')
  const pid = Number(text.slice(0, text.indexOf(' ')))
  const fields = text.slice(end + 2).trim().split(/\s+/)
  stage = 'IDENTITY_CHECK'
  assert.ok(end > 0 && Number.isSafeInteger(pid) && pid > 0 && fields.length >= 50 &&
    /^[RSDZTtWXxIKP]$/.test(fields[0]) && /^\d+$/.test(fields[19]) &&
    fields.slice(1).every((field) => /^-?\d+$/.test(field)) &&
    fields.slice(1, 4).every((field) => /^\d+$/.test(field) && Number.isSafeInteger(Number(field))),
  'Incomplete Linux process identity')
  return { pid, state: fields[0], ppid: Number(fields[1]),
    processGroupId: Number(fields[2]), sessionId: Number(fields[3]), starttime: fields[19] }
  } catch (error) {
    // Evidence only: all original guards, AssertionError identity/code/message
    // and caller containment remain unchanged. Never serialize comm or stat text.
    try { error.linuxStatDiagnostic = linuxStatFailureFacts(text, stage) } catch { /* Evidence must never replace the original failure. */ }
    throw error
  }
}

export const LINUX_STAT_RECHECK_MS = 500

// A task caught between the release of its signal handler and the removal of
// its /proc entry answers with the kernel's lock_task_sighand-failed tuple
// (ppid 0, pgrp/session -1). That tuple is neither an identity nor a terminality
// proof, so the first sight of it must not be fatal NOR trusted: the task is
// re-read from scratch ONCE inside one bounded window (wall + monotonic).
//  - ENOENT/ESRCH       -> null, exactly like a first-read disappearance;
//  - strict valid stat of the same PID and claimed starttime -> that identity;
//  - sentinel again, anything else, or window exceeded -> the INITIAL error.
export async function readLinuxProcessIdentity(pid, io = { readFile }) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const path = `/proc/${pid}/stat`
  let initial, claim
  try {
    const identity = parseLinuxProcessStat(await io.readFile(path, 'utf8'))
    assert.equal(identity.pid, pid, 'Linux stat PID mismatch')
    return identity
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null
    claim = error.linuxStatDiagnostic?.unavailableObservation
    if (!(claim?.schemaVersion === 'linux-task-sighand-unavailable/v1' && claim.pid === pid &&
        claim.identityEstablished === false && claim.terminalityEstablished === false)) throw error
    initial = error
  }
  const startedAt = Date.now(), startedMonotonic = performance.now()
  try {
    const value = await io.readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(LINUX_STAT_RECHECK_MS) })
    const finishedAt = Date.now(), finishedMonotonic = performance.now()
    assert.ok(finishedAt >= startedAt && finishedAt - startedAt < LINUX_STAT_RECHECK_MS &&
      finishedMonotonic - startedMonotonic < LINUX_STAT_RECHECK_MS, 'Linux stat sentinel recheck deadline exhausted')
    const verified = parseLinuxProcessStat(value)
    assert.equal(verified.pid, pid, 'Linux stat PID mismatch')
    assert.equal(identityKey(verified), identityKey({ pid, starttime: claim.starttime }), 'Linux stat sentinel recheck PID recycled')
    return verified
  } catch (recheckError) {
    if (['ENOENT', 'ESRCH'].includes(recheckError.code)) return null
    try {
      initial.linuxStatRecheckDiagnostic = { schemaVersion: 'linux-stat-unavailable-recheck/v1', requestedPid: pid,
        allocatedMs: LINUX_STAT_RECHECK_MS, outcome: 'inconclusive', terminalityEstablished: false,
        readErrorCode: ['EACCES', 'EPERM', 'EIO', 'ABORT_ERR', 'ERR_ASSERTION'].includes(recheckError.code) ? recheckError.code : null,
        recheckStatDiagnostic: recheckError.linuxStatDiagnostic ?? null }
    } catch { /* Never mask an immutable original Error. */ }
    throw initial
  }
}

export function parseLinuxProcessCredentials(text) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65_536, 'Invalid Linux status document')
  const fields = new Map(text.split('\n').filter((line) => line.includes(':')).map((line) => {
    const index = line.indexOf(':'); return [line.slice(0, index), line.slice(index + 1).trim()]
  }))
  const credentials = {}
  for (const name of ['Uid', 'Gid']) {
    const values = (fields.get(name) ?? '').split(/\s+/)
    assert.ok(values.length === 4 && values.every((value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))),
      'Linux process credentials are unavailable')
    credentials[`${name.toLowerCase()}s`] = values.map(Number)
  }
  return { ...credentials, uid: credentials.uids[0], gid: credentials.gids[0] }
}

async function readMarkerFacts(pid, runId) {
  const environment = await readFile(`/proc/${pid}/environ`)
  assert.ok(environment.length <= 2 * 1024 * 1024, 'Linux process environment exceeds observation bound')
  const variables = environment.toString('utf8').split('\0')
  return { runMarked: variables.includes(`${RUN_MARKER}=${runId}`),
    knownMarker: variables.some((value) => value.startsWith(`${RUN_MARKER}=`) && value !== `${RUN_MARKER}=`) }
}

const linuxObservationIo = {
  entries: () => readdir('/proc'), identity: readLinuxProcessIdentity,
  owner: async (pid) => ({ ...parseLinuxProcessCredentials(await readFile(`/proc/${pid}/status`, 'utf8')),
    inodeUid: (await stat(`/proc/${pid}`)).uid }), markerFacts: readMarkerFacts,
}

export async function createLinuxObservationContext(ownerPid = process.pid, io = linuxObservationIo) {
  const ownerIdentity = await io.identity(ownerPid)
  assert.ok(live(ownerIdentity), 'Supervisor owner identity is unavailable')
  const owner = await io.owner(ownerPid), verified = await io.identity(ownerPid)
  assert.ok(verified && identityKey(verified) === identityKey(ownerIdentity), 'Supervisor owner identity changed')
  assert.ok(Number.isSafeInteger(owner.uid) && owner.uid >= 0, 'Supervisor owner UID is unavailable')
  return { ownerIdentity: { ...verified }, ownerUid: owner.uid, baseline: new Map(),
    captureBaseline: true, observed: new Map(), knownMarkers: new Set(), exclusions: new Map(),
    environmentDenials: new Map(), terminalEnvironmentRechecks: new Map(), rootPid: undefined, observationIo: io }
}

function snapshotParentIdentities(entry, entriesByPid, prior) {
  const parents = new Map((prior?.historicalParentIdentities ?? []).map((parent) => [identityKey(parent), parent]))
  for (const pid of [entry.ppid, entry.recheckedFromPpid]) {
    const parent = entriesByPid.get(pid)
    if (parent && BigInt(parent.starttime) <= BigInt(entry.starttime)) {
      parents.set(identityKey(parent), { pid: parent.pid, starttime: parent.starttime })
    }
  }
  return [...parents.values()]
}

function applyVerifiedObservation(entry, verified) {
  const previousPpid = entry.ppid
  Object.assign(entry, verified)
  // This per-snapshot PID is converted into a parent identity only if that
  // parent is independently confirmed in the same verified inventory.
  if (previousPpid !== verified.ppid) entry.recheckedFromPpid = previousPpid
}

function protectedIdentities(entries, context) {
  const protectedKeys = new Set([identityKey(context.ownerIdentity), ...context.observed.keys(), ...context.knownMarkers])
  for (const entry of entries) if (entry.pid === context.rootPid || entry.runMarked) protectedKeys.add(identityKey(entry))
  const children = new Map(), entriesByPid = new Map(entries.map((entry) => [entry.pid, entry]))
  const queue = entries.filter((entry) => protectedKeys.has(identityKey(entry)))
  for (const entry of entries) {
    for (const parent of snapshotParentIdentities(entry, entriesByPid, context.observed.get(identityKey(entry)))) {
      const parentKey = identityKey(parent), siblings = children.get(parentKey) ?? []
      siblings.push(entry); children.set(parentKey, siblings)
    }
  }
  for (let index = 0; index < queue.length; index += 1) for (const child of children.get(identityKey(queue[index])) ?? []) {
    const key = identityKey(child)
    if (!protectedKeys.has(key)) { protectedKeys.add(key); queue.push(child) }
  }
  return protectedKeys
}

// Both authority backends read real /proc; the privileged ABI returns facts,
// never an invented environment Buffer. Raw environment IO injection is test-only.
export async function observeLinuxProcesses(runId, context, io = linuxObservationIo) {
  assert.ok(context?.ownerIdentity && context.baseline instanceof Map, 'Missing supervisor observation baseline')
  const started = Date.now(), entries = await io.entries(), result = [], denied = [], failures = []
  const ownershipVerified = new Set(), absent = new Set()
  const denialReceipt = (entry, error, recheck, guardReason) => {
    context.environmentDenials.set(identityKey(entry), { pid: entry.pid, starttime: entry.starttime,
      code: error.code ?? null, before: { ...entry }, recheck: recheck ? { ...recheck } : null,
      guardReason, observedAt: new Date().toISOString() })
    assert.ok(context.environmentDenials.size <= 16_384, 'Environment denial inventory exceeds observation bound')
  }
  try {
  assert.ok(entries.length <= 16_384, 'Linux process inventory exceeds observation bound')
  // Metadata first: environment ordering must not hide a later-listed marked
  // parent or a root/observed descendant from an earlier EACCES candidate.
  for (const name of entries.filter((value) => /^\d+$/.test(value))) {
    assert.ok(Date.now() - started < 3000, 'Linux observation exceeded its deadline')
    try {
      const entry = await io.identity(Number(name))
      if (!entry) continue
      const owner = await io.owner(entry.pid)
      assert.ok(Number.isSafeInteger(owner.uid) && owner.uid >= 0, 'Linux process UID is unavailable')
      result.push({ ...entry, uid: owner.uid })
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; failures.push(error) }
  }
  const ownerIdentity = await io.identity(context.ownerIdentity.pid)
  const owner = await io.owner(context.ownerIdentity.pid)
  assert.ok(ownerIdentity && identityKey(ownerIdentity) === identityKey(context.ownerIdentity) &&
    owner.uid === context.ownerUid, 'Supervisor owner identity or UID changed')
  if (context.captureBaseline) {
    assert.equal(context.rootPid, undefined, 'Baseline cannot be established after child spawn')
    assert.equal(failures.length, 0, 'Incomplete metadata inventory cannot establish a baseline')
    for (const entry of result) context.baseline.set(identityKey(entry), Object.freeze({ ...entry }))
    context.captureBaseline = false
    context.baselineCapturedAt = new Date().toISOString()
  }
  for (const entry of result) {
    assert.ok(Date.now() - started < 3000, 'Linux observation exceeded its deadline')
    if (entry.uid !== context.ownerUid || !live(entry)) continue
    let facts
    try {
      if (io.markerFacts) facts = await io.markerFacts(entry.pid, runId)
      else {
        const environment = await io.environment(entry.pid)
        assert.ok(environment.length <= 2 * 1024 * 1024, 'Linux process environment exceeds observation bound')
        const variables = environment.toString('utf8').split('\0')
        facts = { runMarked: variables.includes(`${RUN_MARKER}=${runId}`),
          knownMarker: variables.some((value) => value.startsWith(`${RUN_MARKER}=`) && value !== `${RUN_MARKER}=`) }
      }
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) { absent.add(identityKey(entry)); continue }
      if (error.code === 'EACCES') { denied.push({ entry, error }); continue }
      denialReceipt(entry, error, null, 'environment-error-not-eligible')
      failures.push(error); continue
    }
    try {
      assert.equal(typeof facts.runMarked, 'boolean'); assert.equal(typeof facts.knownMarker, 'boolean')
      const { runMarked, knownMarker } = facts
      const verified = await io.identity(entry.pid)
      if (!verified) { absent.add(identityKey(entry)); continue }
      assert.equal(identityKey(verified), identityKey(entry), 'Linux process identity changed during environment read')
      const currentOwner = await io.owner(entry.pid)
      assert.equal(currentOwner.uid, entry.uid, 'Linux process UID changed during environment read')
      applyVerifiedObservation(entry, verified)
      entry.runMarked = runMarked
      ownershipVerified.add(identityKey(entry))
      if (knownMarker) {
        context.knownMarkers.add(identityKey(entry))
        assert.ok(context.knownMarkers.size <= 16_384, 'Known marker inventory exceeds observation bound')
      }
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) { absent.add(identityKey(entry)); continue }
      denialReceipt(entry, error, null, 'environment-metadata-verification-failed')
      failures.push(error)
    }
  }
  const present = result.filter((entry) => !absent.has(identityKey(entry)))
  const protectedKeys = protectedIdentities(present, context)
  for (const { entry, error } of denied) {
    assert.ok(Date.now() - started < 3000, 'Linux observation exceeded its deadline')
    // A terminal recheck retains the identity in the inventory. A live EACCES
    // peer remains eligible only for the existing strict baseline exception.
    const prior = context.baseline.get(identityKey(entry))
    let verified, currentOwner
    try {
      verified = await io.identity(entry.pid)
      if (!verified) { absent.add(identityKey(entry)); continue }
      currentOwner = await io.owner(entry.pid)
    } catch (recheckError) {
      if (['ENOENT', 'ESRCH'].includes(recheckError.code)) { absent.add(identityKey(entry)); continue }
      denialReceipt(entry, error, verified ? { ...verified, uid: currentOwner?.uid ?? null } : null,
        `recheck-error-${recheckError.code ?? 'inconclusive'}`)
      failures.push(recheckError); continue
    }
    const before = { ...entry }, recheck = { ...verified, uid: currentOwner.uid ?? null }
    const sameIdentity = identityKey(verified) === identityKey(entry)
    const sameUid = Number.isSafeInteger(currentOwner.uid) && currentOwner.uid >= 0 && currentOwner.uid === entry.uid
    if (sameIdentity && sameUid) {
      ownershipVerified.add(identityKey(entry))
      applyVerifiedObservation(entry, verified)
    }
    if (sameIdentity && sameUid && !live(verified)) {
      const terminal = { pid: entry.pid, starttime: entry.starttime, uid: entry.uid,
        before, recheck, observation: 'terminal-state', state: verified.state,
        reason: 'environ-eacces-same-identity-same-uid-terminal', observedAt: new Date().toISOString() }
      context.terminalEnvironmentRechecks.set(identityKey(entry), terminal)
      assert.ok(context.terminalEnvironmentRechecks.size <= 16_384, 'Terminal recheck inventory exceeds observation bound')
      denialReceipt(before, error, recheck, terminal.reason)
      context.exclusions.delete(identityKey(entry))
      continue
    }
    if (!prior || identityKey(verified) !== identityKey(entry) || currentOwner.uid !== entry.uid ||
        prior.uid !== entry.uid || prior.ppid !== before.ppid || verified.ppid !== before.ppid ||
        BigInt(entry.starttime) >= BigInt(context.ownerIdentity.starttime) ||
        protectedKeys.has(identityKey(entry)) || context.knownMarkers.has(identityKey(entry))) {
      denialReceipt(before, error, recheck, !sameIdentity ? 'identity-changed' : !sameUid ? 'uid-changed-or-unavailable'
        : protectedKeys.has(identityKey(entry)) || context.knownMarkers.has(identityKey(entry)) ? 'owned-or-marker-protected'
          : !prior ? 'not-in-frozen-baseline' : 'preexisting-exclusion-guard-failed')
      failures.push(error); continue
    }
    ownershipVerified.add(identityKey(entry))
    denialReceipt(before, error, recheck, 'preexisting-exclusion-guards-confirmed')
    const key = identityKey(entry), previous = context.exclusions.get(key)
    context.exclusions.set(key, { pid: entry.pid, starttime: entry.starttime, uid: entry.uid, ppid: entry.ppid,
      ownerPid: context.ownerIdentity.pid, ownerStarttime: context.ownerIdentity.starttime,
      reason: 'environ-eacces-preexisting-before-owner-unrelated',
      baselineCapturedAt: context.baselineCapturedAt,
      firstObservedAt: previous?.firstObservedAt ?? new Date().toISOString(), lastObservedAt: new Date().toISOString() })
    assert.ok(context.exclusions.size <= 16_384, 'Excluded peer inventory exceeds observation bound')
  }
  if (failures.length) throw failures[0]
  return present.filter((entry) => !absent.has(identityKey(entry)))
  } finally {
    // A later unrelated failure must not erase independently verified ownership.
    // The failed snapshot still throws and never proves absence/terminality.
    collectOwnedIdentities(result.filter((entry) => ownershipVerified.has(identityKey(entry)) &&
      !absent.has(identityKey(entry))), context.observed, context.rootPid)
  }
}

export async function linuxProcessSnapshot(runId, context) {
  assert.equal(process.platform, 'linux')
  assert.equal(context?.ownerUid, process.getuid(), 'Supervisor owner UID does not match its process credentials')
  return observeLinuxProcesses(runId, context, context.observationIo ?? linuxObservationIo)
}

export function collectOwnedIdentities(snapshot, observed, rootPid) {
  assert.ok(snapshot.length <= 16_384 && observed.size <= 4096, 'Owned process inventory exceeds observation bound')
  const owned = new Set([...observed.keys()])
  for (const entry of snapshot) if (entry.runMarked) owned.add(identityKey(entry))
  const children = new Map(), entriesByPid = new Map(snapshot.map((entry) => [entry.pid, entry]))
  const queue = snapshot.filter((entry) => owned.has(identityKey(entry)))
  for (const entry of snapshot) {
    for (const parent of snapshotParentIdentities(entry, entriesByPid, observed.get(identityKey(entry)))) {
      const parentKey = identityKey(parent), list = children.get(parentKey) ?? []
      list.push(entry); children.set(parentKey, list)
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(identityKey(queue[index])) ?? []) {
      if (owned.has(identityKey(child))) continue
      owned.add(identityKey(child)); queue.push(child)
    }
  }
  for (const entry of snapshot) {
    if (!owned.has(identityKey(entry))) continue
    const prior = observed.get(identityKey(entry))
    const historicalParentIdentities = snapshotParentIdentities(entry, entriesByPid, prior)
    assert.ok(historicalParentIdentities.length <= 32, 'Historical ancestry exceeds observation bound')
    const metadata = { ...entry }
    delete metadata.recheckedFromPpid
    observed.set(identityKey(entry), { ...metadata,
      ...(historicalParentIdentities.length ? { historicalParentIdentities } : {}),
      firstObservedAt: prior?.firstObservedAt ?? new Date().toISOString(),
      ownership: prior?.ownership ?? (entry.pid === rootPid ? 'spawn+run-id' : entry.runMarked ? 'run-id' : 'ancestry') })
    assert.ok(observed.size <= 4096, 'Owned process inventory exceeds observation bound')
  }
}

export async function signalObservedIdentity(identity, signal, {
  readIdentity = readLinuxProcessIdentity, pidfdSignal, runId, deadlineAt = Date.now() + 3500,
} = {}) {
  assert.ok(['SIGTERM', 'SIGKILL'].includes(signal))
  pidfdSignal ??= (value, requested, _runId, limit) => signalViaPidfd(value, requested, { readIdentity, deadlineAt: limit })
  assert.ok(deadlineAt > Date.now(), 'Pidfd signal deadline exhausted before action')
  const outcome = await pidfdSignal(identity, signal, runId, deadlineAt)
  assert.ok(deadlineAt > Date.now(), 'Pidfd signal deadline exhausted before accepting outcome')
  assert.ok(['signaled', 'pid-recycled', 'terminal-state', 'lookup-race'].includes(outcome.result), 'Invalid pidfd result')
  if (outcome.result === 'signaled' || outcome.result === 'pid-recycled') return { ...identity, signal, ...outcome }
  const remaining = deadlineAt - Date.now()
  assert.ok(remaining > 0, 'Terminal verification budget exhausted before read')
  const current = await bounded(() => readIdentity(identity.pid), Math.min(1000, remaining), 'Terminal identity verification')
  assert.ok(deadlineAt > Date.now(), 'Terminal identity verification deadline exhausted')
  if (!current) return { ...identity, signal, result: 'absent' }
  if (current.starttime !== identity.starttime) return { ...identity, signal, result: 'pid-recycled' }
  assert.ok(!live(current), 'pidfd lookup failure did not prove terminality')
  return { ...identity, signal, result: current.state === 'Z' ? 'zombie' : 'terminal-state', state: current.state }
}

export async function containObservedIdentities(identities, terminationSignal, deadlineAt, options = {}) {
  const signals = [], errors = []
  for (const identity of [...identities].reverse()) {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) { errors.push('Aggregate cleanup deadline exhausted'); break }
    try {
      signals.push(await signalObservedIdentity(identity, terminationSignal, { ...options,
        deadlineAt: Math.min(deadlineAt, Date.now() + 3500) }))
    } catch (error) { errors.push(diagnostic(error)) }
    if (Date.now() >= deadlineAt) { errors.push('Aggregate cleanup deadline exhausted'); break }
  }
  return { signals, errors }
}

export function requireJobBudget(value, suiteDeadlineMs, now = Date.now()) {
  assert.match(value ?? '', /^\d+$/, 'Missing or invalid aggregate perception job deadline')
  const deadline = Number(value)
  assert.ok(Number.isSafeInteger(deadline) && deadline > now &&
    now + suiteDeadlineMs + CLEANUP_BUDGET_MS <= deadline, 'Insufficient aggregate perception job budget')
  return deadline
}

export function attachSupervisorSignals(controller, report, emitter = process) {
  const handlers = ['SIGINT', 'SIGTERM'].map((name) => {
    const handler = () => { report.interruptedBy ??= name; controller.abort(new Error(`Perception supervisor received ${name}`)) }
    emitter.on(name, handler)
    return [name, handler]
  })
  return () => { for (const [name, handler] of handlers) emitter.removeListener(name, handler) }
}

export async function supervisePerceptionCommand({ command = process.execPath, args, cwd = process.cwd(),
  env = process.env, log, signal, deadlineMs = 300_000, observationIntervalMs = 100,
  snapshot = linuxProcessSnapshot, readIdentity = readLinuxProcessIdentity, observer,
  jobDeadline = env.APOLLO_PERCEPTION_JOB_DEADLINE_MS }) {
  assert.equal(process.platform, 'linux')
  assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 300_000)
  assert.ok(Number.isSafeInteger(observationIntervalMs) && observationIntervalMs >= 20 && observationIntervalMs <= 1000)
  const runId = observer?.runId ?? createPerceptionRunId(), started = Date.now(), observed = new Map()
  const observationIo = observer?.io ?? linuxObservationIo
  if (observer) readIdentity = observer.readIdentity
  const report = { runId, ownerPid: process.pid, startedAt: new Date(started).toISOString(),
    deadlineAt: new Date(started + deadlineMs).toISOString(), observationIntervalMs,
    observations: 0, observationComplete: true, signals: [], cleanupErrors: [] }
  let child, closed = false, processError, primaryError, observationContext
  const observe = async () => {
    try {
      assert.ok(observationContext, 'Supervisor owner baseline is unavailable')
      observationContext.rootPid = child?.pid
      const entries = await bounded(() => snapshot(runId, observationContext), 3500, 'Linux process snapshot')
      collectOwnedIdentities(entries, observed, child?.pid)
      report.excludedPreexistingProcesses = [...observationContext.exclusions.values()]
      const entriesByPid = new Map(entries.map((entry) => [entry.pid, entry]))
      report.observations += 1
      report.zombies = entries.filter((entry) => observed.has(identityKey(entry)) && entry.state === 'Z')
      report.identityStates = [...observed.values()].map((identity) => {
        const current = entriesByPid.get(identity.pid)
        return { pid: identity.pid, starttime: identity.starttime,
          observation: !current ? 'absent' : current.starttime !== identity.starttime ? 'pid-recycled' : current.state }
      })
      return [...observed.values()].filter((entry) => {
        const current = entriesByPid.get(entry.pid)
        return current && identityKey(current) === identityKey(entry) && live(current)
      })
    } catch (error) { report.observationComplete = false; throw error }
  }
  const checkActive = () => {
    if (signal?.aborted) throw signal.reason ?? new Error('Perception supervisor interrupted')
    if (Date.now() >= started + deadlineMs) throw new Error('Perception suite exceeded its deadline')
  }
  try {
    report.jobDeadlineAt = new Date(requireJobBudget(jobDeadline, deadlineMs)).toISOString()
    report.pidfdAuthority = (await loadPidfdBinding(env)).provenance
    observationContext = await bounded(() => createLinuxObservationContext(process.pid, observationIo), 3500, 'Supervisor owner baseline')
    assert.equal(observationContext.ownerUid, process.getuid(), 'Supervisor owner UID does not match its process credentials')
    observationContext.observed = observed
    report.ownerIdentity = observationContext.ownerIdentity
    checkActive(); await observe(); checkActive()
    requireJobBudget(jobDeadline, deadlineMs)
    const childEnv = { ...env, [RUN_MARKER]: runId }
    // Product descendants have no observer API. Kernel SCM_CREDENTIALS also
    // rejects a leaked descriptor from any PID other than the minted owner.
    delete childEnv.APOLLO_OBSERVER_FD; delete childEnv.APOLLO_OBSERVER_RUN_ID
    delete childEnv.APOLLO_PERCEPTION_NAMESPACE_REQUIRED
    delete childEnv.APOLLO_PERCEPTION_NAMESPACE_FAULT
    child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv })
    report.rootPid = child.pid
    if (log) { child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }) }
    else { child.stdout.resume(); child.stderr.resume() }
    child.once('error', (error) => { processError = error })
    child.once('close', (code, terminationSignal) => {
      closed = true; report.code = code; report.terminationSignal = terminationSignal
    })
    while (!closed) {
      checkActive(); await observe()
      if (processError) throw processError
      await delay(Math.min(observationIntervalMs, Math.max(1, started + deadlineMs - Date.now())))
    }
    if (processError) throw processError
    assert.ok([...observed.values()].some((identity) => identity.pid === child.pid &&
      identity.ownership === 'spawn+run-id'), 'Spawned root identity was not observed completely')
    assert.equal(report.code, 0, 'Perception suite did not exit successfully')
    assert.deepEqual(await observe(), [], 'Suite left owned descendants after Node exited')
  } catch (error) { primaryError = error; report.error = diagnostic(error) }
  finally {
    report.cleanupStartedAt = new Date().toISOString()
    report.cleanupDeadlineAt = new Date(Date.now() + CLEANUP_BUDGET_MS).toISOString()
    const cleanupDeadline = Date.now() + TREE_CLEANUP_BUDGET_MS
    const remaining = () => {
      const ms = cleanupDeadline - Date.now()
      assert.ok(ms > 0, 'Aggregate cleanup deadline exhausted')
      return ms
    }
    const cleanupObserve = () => bounded(observe, Math.min(3500, remaining()), 'Cleanup observation')
    let active = []
    try { active = await cleanupObserve() } catch (error) { report.cleanupErrors.push(diagnostic(error)) }
    const contain = async (terminationSignal) => {
      const contained = await containObservedIdentities(observed.values(), terminationSignal, cleanupDeadline, { readIdentity, runId })
      report.signals.push(...contained.signals)
      report.cleanupErrors.push(...contained.errors)
    }
    if ((child && !closed) || active.length || !report.observationComplete) {
      report.containmentRequired = true
      if (child?.pid && ![...observed.values()].some((entry) => entry.pid === child.pid)) {
        try {
          const identity = await bounded(() => readIdentity(child.pid), Math.min(3000, remaining()), 'Root identity')
          if (identity) {
            const facts = await bounded(() => observationIo.markerFacts(child.pid, runId), Math.min(3000, remaining()), 'Root run marker facts')
            const verified = await bounded(() => readIdentity(child.pid), Math.min(3000, remaining()), 'Root identity recheck')
            if (verified?.starttime === identity.starttime && facts.runMarked === true) {
              observed.set(identityKey(identity), { ...identity, ownership: 'spawn+run-id', firstObservedAt: new Date().toISOString() })
            }
          }
        } catch (error) { report.cleanupErrors.push(diagnostic(error)) }
      }
      await contain('SIGTERM')
      const graceRemaining = cleanupDeadline - Date.now()
      if (graceRemaining > 0) await delay(Math.min(500, graceRemaining))
      await contain('SIGKILL')
    }
    do {
      try {
        active = await cleanupObserve()
        if (active.length) { report.containmentRequired = true; await contain('SIGKILL') }
        // ChildProcess close also waits for inherited pipes. Release IO only
        // once all observed processes and the spawned root are terminal.
        if (!active.length && child && !closed && (child.exitCode !== null || child.signalCode !== null)) {
          for (const stream of child.stdio ?? []) stream?.destroy?.()
        }
      } catch (error) { report.cleanupErrors.push(diagnostic(error)); break }
      if ((!child || closed) && active.length === 0) break
      if (Date.now() >= cleanupDeadline) break
      const pollingRemaining = cleanupDeadline - Date.now()
      if (pollingRemaining > 0) await delay(Math.min(100, pollingRemaining))
    } while (Date.now() < cleanupDeadline)
    report.activeSurvivors = active
    report.childClosed = !child || closed
    report.childCloseObserved = Boolean(child && closed)
    report.observedProcesses = [...observed.values()]
    report.excludedPreexistingProcesses = [...(observationContext?.exclusions.values() ?? [])]
    report.environmentDenials = [...(observationContext?.environmentDenials.values() ?? [])]
    report.terminalEnvironmentRechecks = [...(observationContext?.terminalEnvironmentRechecks.values() ?? [])]
    report.processBaseline = observationContext ? {
      ownerIdentity: observationContext.ownerIdentity, ownerUid: observationContext.ownerUid,
      capturedAt: observationContext.baselineCapturedAt ?? null, identityCount: observationContext.baseline.size,
    } : null
    report.processTreeTerminal = report.observationComplete && report.childClosed &&
      active.length === 0 && report.cleanupErrors.length === 0
    report.inventoryInconclusive = !report.observationComplete || report.cleanupErrors.length > 0
    report.success = !primaryError && report.code === 0 && report.processTreeTerminal && !report.containmentRequired
    report.completedAt = new Date().toISOString()
  }
  return report
}

export async function main(args = process.argv.slice(2)) {
assert.equal(process.platform, 'linux')
const [suite, pattern] = args
assert.match(suite ?? '', /^tests\/v2\/[a-z0-9-]+\.integration\.mjs$/)
const root = process.env.APOLLO_LIBRARY_EVIDENCE_ROOT
assert.ok(root?.startsWith('/tmp/') || (process.env.RUNNER_TEMP && root?.startsWith(process.env.RUNNER_TEMP + '/')))
await bounded(() => mkdir(root, { recursive: true }), 5000, 'Evidence directory')
const name = suite.split('/').pop().replace('.integration.mjs', '')
const logPath = join(root, `${name}.log`)
const log = createWriteStream(logPath)
const report = { suite, pattern: pattern ?? null, sourceCommit: process.env.GITHUB_SHA,
  ciRunId: process.env.GITHUB_RUN_ID, runId: createPerceptionRunId(), proofScope: pattern ? 'filtered-suite' : 'full-suite',
  ownerPid: process.pid, startedAt: new Date().toISOString(),
  jobDeadline: process.env.APOLLO_PERCEPTION_JOB_DEADLINE_MS, cleanupBudgetMs: CLEANUP_BUDGET_MS }
const controller = new AbortController()
const removeSignalHandlers = attachSupervisorSignals(controller, report)
log.on('error', (error) => controller.abort(error))
let primaryError, observer
let finalCleanupDeadline
const cleanupWait = (action, limit, label, reserved = 5000) => {
  const remaining = finalCleanupDeadline - reserved - Date.now()
  assert.ok(remaining > 0, `${label}: aggregate cleanup deadline exhausted before action`)
  return bounded(action, Math.min(limit, remaining), label)
}
async function requireEmptyDatabase(cleanup = false) {
  const wait = cleanup ? cleanupWait : bounded
  const { PrismaClient } = await wait(() => import('../../generated/prisma-v2/index.js'), 5000, 'Observer module import')
  const url = new URL(process.env.V2_DATABASE_URL)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.pathname, '/apollo_v2_perception')
  url.username = 'apollo_admin'
  url.searchParams.set('application_name', `apollo-video-e2e-perception-observer-${process.pid}-${randomUUID().slice(0, 8)}`)
  url.searchParams.set('connection_limit', '1')
  url.searchParams.set('pool_timeout', '10')
  url.searchParams.set('connect_timeout', '10')
  const observer = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  try {
    const rows = await wait(() => observer.$queryRawUnsafe('SELECT application_name, count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() GROUP BY application_name'), 12_000, 'PostgreSQL pre/postflight')
    assert.deepEqual(rows, [], 'Another suite still owns PostgreSQL connections')
    return { backendCount: 0, checkedAt: new Date().toISOString() }
  } finally { await wait(() => observer.$disconnect(), 5000, 'Observer disconnect') }
}
try {
  report.jobDeadlineAt = new Date(requireJobBudget(process.env.APOLLO_PERCEPTION_JOB_DEADLINE_MS, 300_000)).toISOString()
  if (process.env.APOLLO_PERCEPTION_NAMESPACE_REQUIRED === '1') {
    observer = await connectNamespaceObserver()
    report.observerAuthority = observer.attestation
  } else assert.equal(process.env.APOLLO_OBSERVER_FD, undefined, 'Inherited observer cannot silently fall back to direct /proc')
  const fault = process.env.APOLLO_PERCEPTION_NAMESPACE_FAULT
  if (fault !== undefined) {
    assert.equal(suite, 'tests/v2/perception-namespace-observer.integration.mjs')
    assert.ok(observer, 'Controlled faults require the real namespace observer')
    assert.ok(['node-owner-death', 'ipc-death', 'ipc-truncated', 'ipc-oversized', 'deadline'].includes(fault))
    report.controlledFault = fault
    if (fault === 'node-owner-death') {
      await signalViaPidfd(observer.attestation.owner, 'SIGKILL', { readIdentity: observer.readIdentity,
        deadlineAt: Date.now() + 2000 })
      assert.fail('Controlled owner death did not terminate this Node')
    }
    if (fault.startsWith('ipc-')) await observer.client.controlledFailure(fault)
  }
  report.preflight = await requireEmptyDatabase()
  if (fault === 'deadline') report.controlledDeadlineMs = 2000
  Object.assign(report, await supervisePerceptionCommand({ args: ['--experimental-transform-types',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', '--test-reporter=spec',
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []), suite], log, signal: controller.signal, observer,
    ...(fault === 'deadline' ? { deadlineMs: report.controlledDeadlineMs } : {}) }))
} catch (error) {
  primaryError = error
  report.error = diagnostic(error)
} finally {
  finalCleanupDeadline = report.cleanupDeadlineAt ? Date.parse(report.cleanupDeadlineAt) : Date.now() + CLEANUP_BUDGET_MS
  report.cleanupDeadlineAt = new Date(finalCleanupDeadline).toISOString()
  try {
    report.postflight = await requireEmptyDatabase(true)
  } catch (error) {
    report.cleanupError = String(error)
    primaryError ??= error
  }
  try {
  await cleanupWait(() => new Promise((resolve, reject) => { log.once('error', reject); log.end(resolve) }), 5000, 'Log close')
  const output = await cleanupWait(() => readFile(logPath, 'utf8'), 5000, 'Log read')
  process.stdout.write(output)
  const passed = /(?:ℹ|#) pass (\d+)/.exec(output)
  const skipped = /(?:ℹ|#) skipped (\d+)/.exec(output)
  report.passed = Number(passed?.[1] ?? 0)
  report.skipped = skipped ? Number(skipped[1]) : null
  if (suite === 'tests/v2/prisma-face-producer.integration.mjs' && pattern === 'publish-race|face control') {
    report.proofScope = 'face-offline-partial'
    report.expectedSelectedTests = 3
    assert.equal(report.passed, 3, 'Face offline filtered proof requires exactly three passing tests')
    const expectedNames = [
      'W61 publish-race rights fixtures hydrate and expire offline',
      'W61 publish-race matcher checks typed codes, not error prose',
      'W61 face control uses scoped canonical audit before the repository transaction',
    ]
    report.selectedTestNames = [...output.matchAll(/^[ \t]*✔ (.+?) \([^\r\n]*\)\r?$/gm)].map((match) => match[1])
    assert.deepEqual(report.selectedTestNames, expectedNames, 'Face proof must contain only the three named offline assertions')
    report.pgCasesExecuted = 0
  }
  report.success = !primaryError && !controller.signal.aborted && report.passed > 0 && report.skipped === 0 &&
    report.processTreeTerminal && report.success === true && !report.containmentRequired
  report.completedAt = new Date().toISOString()
  if (observer) {
    try { await cleanupWait(() => observer.client.request('finish'), 3000, 'Observer finish') }
    catch (error) { report.success = false; report.observerFinishError = diagnostic(error); primaryError ??= error }
  }
  } catch (error) { report.success = false; report.evidenceError = diagnostic(error); primaryError ??= error }
  report.completedAt = new Date().toISOString()
  try { await cleanupWait(() => writeFile(join(root, `${name}.json`), JSON.stringify(report, null, 2)), 5000, 'Receipt write', 0) }
  catch (error) { report.success = false; report.receiptWriteError = diagnostic(error); process.stderr.write(`Perception receipt write failed: ${diagnostic(error)}\n${JSON.stringify(report)}\n`); primaryError ??= error }
  finally { observer?.client.close(); removeSignalHandlers() }
}
if (!report.success) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
