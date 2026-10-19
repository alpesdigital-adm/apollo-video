import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { registerAddonConsumer } from './perception-addon-registry.mjs'

const require = createRequire(import.meta.url)
const bindings = new Map()
const key = (value) => `${value.pid}:${value.starttime}`
const live = (value) => value && !['Z', 'X', 'x'].includes(value.state)

/**
 * Calls `onDeadline` once the wall clock has reached `deadlineAt`, and never before; returns its canceller.
 *
 * Every caller compares Date.now() with the same absolute deadline right after its timeout fires (`containObservedIdentities` decides on it whether
 * another identity may still be attempted). A Node timer armed for `deadlineAt - Date.now()` can fire before Date.now() reaches `deadlineAt`: libuv
 * counts in whole milliseconds from a clock it caches at the start of the loop iteration, so it fires up to a few milliseconds early. This timer
 * re-arms for what is left, so the timeout and the comparison cannot disagree.
 */
export function onWallClockDeadline(deadlineAt, onDeadline) {
  let handle, cancelled = false
  const arm = () => {
    if (cancelled) return
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) onDeadline()
    else handle = setTimeout(arm, remaining)
  }
  arm()
  return () => { cancelled = true; clearTimeout(handle) }
}

export async function withPidfdLoadBudget(action, { deadlineAt = Date.now() + 3500 } = {}) {
  assert.ok(Number.isFinite(deadlineAt) && deadlineAt > Date.now(), 'Addon load deadline exhausted before action')
  const controller = new AbortController()
  const check = () => {
    assert.ok(!controller.signal.aborted && Date.now() < deadlineAt, 'Addon load deadline exhausted')
  }
  const timer = setTimeout(() => controller.abort(new Error('Addon load deadline exhausted')), deadlineAt - Date.now())
  try {
    check()
    const value = await action({ deadlineAt, signal: controller.signal, check })
    check()
    return value
  } finally { clearTimeout(timer); controller.abort() }
}

async function readBoundedInput(path, limit, budget) {
  budget.check()
  const metadata = statSync(path)
  budget.check()
  assert.ok(metadata.isFile() && metadata.size <= limit, 'Addon provenance input exceeds byte bound')
  // end is inclusive: read at most limit+1, detecting growth without an unbounded allocation.
  budget.check()
  const stream = createReadStream(path, { end: limit, highWaterMark: 65536, signal: budget.signal })
  const chunks = []; let bytes = 0
  for await (const chunk of stream) {
    budget.check(); bytes += chunk.length
    assert.ok(bytes <= limit, 'Addon provenance input grew beyond byte bound')
    chunks.push(chunk)
  }
  budget.check()
  return Buffer.concat(chunks, bytes)
}

export async function loadPidfdBinding(env = process.env, options = {}) {
  return withPidfdLoadBudget((budget) => loadBindingWithinBudget(env, budget), options)
}

async function loadBindingWithinBudget(env, budget) {
  budget.check()
  assert.equal(process.platform, 'linux', 'CI pidfd addon requires Linux')
  assert.ok(process.getuid() > 0, 'CI pidfd addon must never run in root Node')
  assert.ok(Number(process.versions.napi) >= 8, 'Node-API 8 is required')
  const path = env.APOLLO_PERCEPTION_PIDFD_ADDON, receiptPath = env.APOLLO_PERCEPTION_PIDFD_PROVENANCE
  assert.ok(path && isAbsolute(path) && receiptPath && isAbsolute(receiptPath),
    'Missing explicit CI pidfd addon/provenance; there is no Python or bare-PID fallback')
  assert.match(env.APOLLO_PERCEPTION_PIDFD_SHA256 ?? '', /^[0-9a-f]{64}$/)
  const registration = await registerAddonConsumer(env, { deadlineAt: budget.deadlineAt, signal: budget.signal }) // BEFORE require AND cache lookup.
  budget.check()
  const expected = env.APOLLO_PERCEPTION_PIDFD_SHA256
  const cacheKey = `${path}:${expected}:${receiptPath}`
  if (bindings.has(cacheKey)) return bindings.get(cacheKey)
  const bytes = await readBoundedInput(path, 16 * 1024 * 1024, budget)
  const receipt = JSON.parse((await readBoundedInput(receiptPath, 1024 * 1024, budget)).toString('utf8'))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'CI pidfd addon bytes changed')
  assert.equal(receipt.schemaVersion, 'perception-pidfd-build/v2')
  assert.equal(receipt.runId, registration.registry.runId)
  assert.equal(receipt.success, true)
  assert.equal(receipt.childCloseObserved, true)
  assert.ok(receipt.terminality.length > 0 && receipt.terminality.every((item) => item.terminal))
  assert.equal(receipt.napiVersion, 8); assert.equal(receipt.addon.sha256, expected)
  assert.equal(receipt.compilerExitCode, 0, 'A failed compiler cannot supply runtime authority')
  assert.equal(receipt.sourceCommit, env.GITHUB_SHA, 'CI addon belongs to another source commit')
  assert.equal(receipt.uid, process.getuid(), 'CI addon was not built by this normal owner UID')
  assert.equal(receipt.gid, process.getgid())
  assert.equal(receipt.node.version, process.version)
  assert.equal(receipt.node.path, process.execPath)
  const source = await readBoundedInput(new URL('./perception-pidfd.c', import.meta.url), 1024 * 1024, budget)
  assert.equal(receipt.source.sha256, createHash('sha256').update(source).digest('hex'), 'CI pidfd source changed')
  assert.ok(Array.isArray(receipt.headers) && receipt.headers.length >= 3 && receipt.headers.length <= 64)
  for (const item of [receipt.source, receipt.compiler, receipt.node, receipt.addon, ...receipt.headers]) {
    assert.ok(item && typeof item.path === 'string' && isAbsolute(item.path)); assert.match(item.sha256, /^[0-9a-f]{64}$/)
    assert.equal(createHash('sha256').update(await readBoundedInput(item.path, 256 * 1024 * 1024, budget)).digest('hex'), item.sha256,
      'CI pidfd provenance input bytes changed')
    budget.check()
  }
  budget.check() // No require/cache promotion after deadline or abort.
  const binding = require(path)
  budget.check()
  assert.deepEqual(Object.getOwnPropertyNames(binding).sort(), ['close', 'open', 'signal'])
  for (const name of ['close', 'open', 'signal']) assert.equal(typeof binding[name], 'function')
  const result = { binding, provenance: receipt }
  budget.check()
  bindings.set(cacheKey, result)
  return result
}

export async function openObservedPidfd(expected, { readIdentity, deadlineAt, verifyDeadlineAt = deadlineAt, binding,
  loadBinding = loadPidfdBinding } = {}) {
  assert.ok(Number.isSafeInteger(expected.pid) && expected.pid > 0)
  assert.match(expected.starttime, /^\d+$/)
  assert.equal(typeof readIdentity, 'function')
  assert.ok(deadlineAt > Date.now(), 'Pidfd budget exhausted before open')
  binding ??= (await loadBinding(process.env, { deadlineAt })).binding
  assert.ok(deadlineAt > Date.now(), 'Pidfd budget exhausted after addon loading')
  const token = binding.open(expected.pid) // Attach BEFORE any PID/starttime recheck.
  let closed = false
  const close = () => { if (!closed) { closed = true; return binding.close(token) } return false }
  let stopDeadline
  try {
    const verifyEnd = Math.min(deadlineAt, verifyDeadlineAt)
    assert.ok(verifyEnd - Date.now() > 0, 'Pidfd verification budget exhausted before read')
    // The deadline is inside the owner of the token. An outer Promise.race
    // cannot leave a late identity read holding an unreturned native handle.
    const current = await Promise.race([Promise.resolve().then(() => readIdentity(expected.pid)),
      new Promise((_, reject) => { stopDeadline = onWallClockDeadline(verifyEnd, () => reject(new Error('Pidfd identity recheck timed out'))) })])
    assert.ok(deadlineAt > Date.now(), 'Pidfd verification exceeded its deadline')
    if (!current || key(current) !== key(expected) || !live(current)) {
      close()
      return { expected, current, terminal: true, outcome: !current ? 'absent'
        : key(current) !== key(expected) ? 'pid-recycled' : current.state === 'Z' ? 'zombie' : 'terminal-state', close }
    }
    return { expected, current, terminal: false, close,
      signal(requested) {
        assert.ok(!closed, 'Owned pidfd is closed')
        assert.ok(['SIGTERM', 'SIGKILL'].includes(requested))
        assert.ok(deadlineAt > Date.now(), 'Pidfd budget exhausted before signal')
        return binding.signal(token, requested)
      } }
  } catch (error) { close(); throw error }
  finally { stopDeadline?.() }
}

export async function signalViaPidfd(expected, requested, { readIdentity, deadlineAt, binding, loadBinding } = {}) {
  assert.ok(['SIGTERM', 'SIGKILL'].includes(requested))
  let owned
  try {
    owned = await openObservedPidfd(expected, { readIdentity, deadlineAt, binding, loadBinding })
    if (owned.terminal) return { result: owned.outcome === 'pid-recycled' ? 'pid-recycled' : 'terminal-state' }
    owned.signal(requested)
    return { result: 'signaled' } // Actual terminality still requires a later observation.
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return { result: 'lookup-race' }
    throw error
  } finally { owned?.close() }
}
