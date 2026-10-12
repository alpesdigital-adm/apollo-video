import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readlinkSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLinuxProcessStat, parseLinuxProcessCredentials } from './run-perception-ci.mjs'

export const CI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const CI_PIDFD_SOURCE_PATHS = Object.freeze([
  'scripts/validation/perception-pidfd.c', 'scripts/validation/perception-pidfd.mjs',
  'scripts/validation/perception-addon-registry.mjs', 'scripts/validation/build-perception-pidfd.sh',
  'scripts/validation/build-perception-pidfd.mjs', 'scripts/validation/perception-ci-child-bootstrap.mjs',
  'scripts/validation/run-perception-addon-consumer.mjs', 'scripts/validation/cleanup-perception-pidfd.mjs',
  'scripts/validation/run-perception-ci.mjs', 'scripts/validation/run-perception-ci-namespace.mjs',
  'scripts/validation/run-perception-namespace-gates.mjs', 'scripts/validation/perception_namespace_warden.py',
  'scripts/validation/perception-observer-channel.mjs',
  'scripts/validation/perception-outer-host-death.mjs',
  'scripts/validation/perception-namespace-node-bootstrap.mjs',
])
export const identityKey = (value) => `${value.pid}:${value.starttime}`
export const liveIdentity = (value) => value && !['Z', 'X', 'x'].includes(value.state)
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const jsonDigest = (value) => digest(Buffer.from(JSON.stringify(value)))
const allowedRoot = /^apollo-ci-pidfd\.[A-Za-z0-9_-]+$/

function admissionCheck(deadlineAt, signal) {
  assert.ok(!signal?.aborted && Date.now() < deadlineAt, 'Registry admission deadline exhausted')
}

function readAdmissionFile(path, limit, deadlineAt = Infinity, signal) {
  admissionCheck(deadlineAt, signal)
  const fd = openSync(path, 'r')
  try {
    admissionCheck(deadlineAt, signal)
    const metadata = fstatSync(fd)
    assert.ok(metadata.isFile() && metadata.size <= limit, 'Registry admission input exceeds byte bound')
    const chunks = []; let size = 0
    while (true) {
      admissionCheck(deadlineAt, signal)
      const chunk = Buffer.alloc(Math.min(65536, limit - size + 1))
      const bytes = readSync(fd, chunk, 0, chunk.length, null)
      admissionCheck(deadlineAt, signal)
      if (!bytes) break
      size += bytes
      assert.ok(size <= limit, 'Registry admission input grew beyond byte bound')
      chunks.push(chunk.subarray(0, bytes))
    }
    return Buffer.concat(chunks, size)
  } finally { closeSync(fd) }
}

export function readAuthorityIdentitySync(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const identity = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const credentials = parseLinuxProcessCredentials(status)
  const namespace = readlinkSync(`/proc/${pid}/ns/pid`)
  const verified = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  assert.equal(identityKey(verified), identityKey(identity), 'Identity changed during synchronous birth capture')
  assert.match(namespace, /^pid:\[\d+\]$/)
  const nspids = /^NSpid:\s+([\d\s]+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number)
  assert.ok(nspids?.length && nspids[0] === pid)
  return Object.freeze({ ...verified, ...credentials, namespace, nspids })
}

export async function budget(action, deadlineAt, limit, label) {
  const saldo = deadlineAt - Date.now()
  assert.ok(saldo > 0, `${label}: expired before action`)
  let timer
  try { return await Promise.race([action(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), Math.min(saldo, limit))
  })]) } finally { clearTimeout(timer) }
}

export function assertOwnedRoot(root, env = process.env, expected) {
  assert.ok(env.RUNNER_TEMP && resolve(root).startsWith(resolve(env.RUNNER_TEMP) + '/'))
  assert.match(root.slice(root.lastIndexOf('/') + 1), allowedRoot)
  const actual = lstatSync(root)
  assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.uid === process.getuid() && (actual.mode & 0o777) === 0o700)
  if (expected) { assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino) }
  return { path: resolve(root), dev: actual.dev, ino: actual.ino, uid: actual.uid }
}

export function readRegistry(root, env = process.env, { deadlineAt = Infinity, signal } = {}) {
  admissionCheck(deadlineAt, signal)
  assertOwnedRoot(root, env)
  const path = join(root, 'registry.json'), entry = lstatSync(path)
  assert.ok(entry.isFile() && !entry.isSymbolicLink() && entry.uid === process.getuid() && entry.size <= 65536)
  const registry = JSON.parse(readAdmissionFile(path, 65536, deadlineAt, signal).toString('utf8'))
  assert.equal(registry.schemaVersion, 'perception-pidfd-registry/v1')
  assert.equal(registry.sourceCommit, env.GITHUB_SHA)
  assertOwnedRoot(root, env, registry.root)
  assert.match(registry.runId, /^pidfd-build-[a-f0-9-]+$/)
  return registry
}

export function writeRegistry(root, value) {
  const path = join(root, 'registry.json'), pending = join(root, `registry.${randomUUID()}.pending`)
  writeFileSync(pending, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
  renameSync(pending, path)
}

export async function registryLock(root, action, { env = process.env, deadlineAt = Date.now() + 750, signal } = {}) {
  admissionCheck(deadlineAt, signal)
  assertOwnedRoot(root, env)
  const lock = join(root, 'admission.lock')
  let acquired = false
  while (Date.now() < deadlineAt) {
    admissionCheck(deadlineAt, signal)
    try { mkdirSync(lock, { mode: 0o700 }); acquired = true; break }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    await new Promise((done) => setTimeout(done, Math.min(10, Math.max(0, deadlineAt - Date.now()))))
  }
  assert.ok(acquired, 'Registry admission lock deadline; no stale-lock deletion')
  try {
    admissionCheck(deadlineAt, signal)
    const result = await action()
    admissionCheck(deadlineAt, signal)
    return result
  }
  finally { rmdirSync(lock) }
}

export function initializeRegistry(root, runId, env = process.env) {
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0 && process.getgid() > 0)
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/)
  const owner = readAuthorityIdentitySync(process.pid)
  assert.ok(liveIdentity(owner)); assert.deepEqual(owner.uids, Array(4).fill(process.getuid()))
  const registry = { schemaVersion: 'perception-pidfd-registry/v1', runId, sourceCommit: env.GITHUB_SHA,
    root: assertOwnedRoot(root, env), creator: owner, admission: 'building', sourceFiles: [],
    createdAt: new Date().toISOString() }
  mkdirSync(join(root, 'owners'), { mode: 0o700 })
  mkdirSync(join(root, 'receipts'), { mode: 0o700 })
  writeFileSync(join(root, 'registry.json'), JSON.stringify(registry, null, 2), { flag: 'wx', mode: 0o600 })
  return registry
}

export function sourceFingerprint({ deadlineAt = Infinity, signal } = {}) {
  // Explicit allowlist includes new untracked source files; never deps/evidence.
  return CI_PIDFD_SOURCE_PATHS.map((path) => {
    const sha256 = digest(readAdmissionFile(join(CI_ROOT, path), 1024 * 1024, deadlineAt, signal))
    admissionCheck(deadlineAt, signal)
    return { path, sha256 }
  })
}

export async function registerAddonConsumer(env = process.env, { deadlineAt = Date.now() + 3500, signal } = {}) {
  admissionCheck(deadlineAt, signal)
  const root = env.APOLLO_PERCEPTION_PIDFD_ROOT
  assert.ok(root, 'CI addon requires an explicit closed-admission registry')
  return registryLock(root, async () => {
    const registry = readRegistry(root, env, { deadlineAt, signal })
    assert.equal(registry.admission, 'open', 'CI addon admission is closed')
    assert.deepEqual(sourceFingerprint({ deadlineAt, signal }), registry.sourceFiles, 'CI authority source changed before native admission/cache')
    assert.equal(registry.addonSha256, env.APOLLO_PERCEPTION_PIDFD_SHA256)
    assert.equal(registry.addonSha256, digest(readAdmissionFile(env.APOLLO_PERCEPTION_PIDFD_ADDON, 16 * 1024 * 1024, deadlineAt, signal)), 'Addon changed before cache admission')
    assert.equal(registry.provenanceSha256, digest(readAdmissionFile(env.APOLLO_PERCEPTION_PIDFD_PROVENANCE, 1024 * 1024, deadlineAt, signal)))
    assert.equal(env.APOLLO_PERCEPTION_PIDFD_ADDON, join(root, 'perception-pidfd.node'))
    assert.equal(env.APOLLO_PERCEPTION_PIDFD_PROVENANCE, join(root, 'provenance.json'))
    admissionCheck(deadlineAt, signal)
    const identity = readAuthorityIdentitySync(process.pid)
    admissionCheck(deadlineAt, signal)
    assert.ok(liveIdentity(identity)); assert.deepEqual(identity.uids, Array(4).fill(process.getuid()))
    assert.match(env.APOLLO_PERCEPTION_CONSUMER_RUN_ID ?? '', /^pidfd-consumer-[a-z-]+-[a-f0-9-]+$/)
    const entry = { schemaVersion: 'perception-pidfd-consumer/v1', identity, buildRunId: registry.runId,
      consumerRunId: env.APOLLO_PERCEPTION_CONSUMER_RUN_ID,
      observerRunId: env.APOLLO_OBSERVER_RUN_ID ?? env.APOLLO_PERCEPTION_RUN_ID ?? null,
      sourceCommit: env.GITHUB_SHA, addonSha256: registry.addonSha256, provenanceSha256: registry.provenanceSha256,
      registrationIsNotProcessClose: true }
    const id = jsonDigest([identity.namespace, identity.pid, identity.starttime])
    const path = join(root, 'owners', `${id}.json`)
    admissionCheck(deadlineAt, signal)
    try { writeFileSync(path, JSON.stringify(entry, null, 2), { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = JSON.parse(readAdmissionFile(path, 65536, deadlineAt, signal).toString('utf8'))
      for (const key of ['buildRunId', 'consumerRunId', 'observerRunId', 'sourceCommit', 'addonSha256', 'provenanceSha256']) assert.equal(existing[key], entry[key])
      assert.equal(identityKey(existing.identity), identityKey(identity)); assert.equal(existing.identity.namespace, identity.namespace)
      assert.deepEqual(existing.identity.uids, identity.uids)
    }
    admissionCheck(deadlineAt, signal)
    return Object.freeze({ id, path, entry, registry })
  }, { env, deadlineAt: Math.min(deadlineAt, Date.now() + 750), signal })
}
