import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { OwnedDeadlineIo, OwnedIoAdmissionFailure, OwnedIoInconclusive, pendingOwnedIo } from '../../src/v2/infrastructure/media/ffmpeg-owned-io.ts'
import { NodeOwnedFfmpegExecutor } from '../../src/v2/infrastructure/media/ffmpeg-owned-process.ts'

// Controlled promise/handle/stream lifecycle only: no OS child, filesystem,
// decoding, model or physical-close claim. Close acknowledgement is explicit.
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function owner(dependencies = {}, runId = 'io-unit') {
  const admitted = performance.now()
  return new OwnedDeadlineIo({ runId, workEndMonotonicMs: admitted + 120, hardEndMonotonicMs: admitted + 240, dependencies })
}
function handle(overrides = {}) {
  const calls = { read: 0, write: 0, close: 0 }, writes = []
  return { calls, writes, async read() { calls.read++; return { bytesRead: 0 } },
    async writeFile(bytes) { calls.write++; writes.push(Buffer.from(bytes)) },
    async close() { calls.close++ }, ...overrides }
}
async function flush() { await nextTurn(); await nextTurn() }
const inconclusive = (error) => error instanceof OwnedIoInconclusive && error.ioSettled === false && error.closeObserved === false

test('normal reads/writes settle after close; stat/mkdir/realpath carry the same predeclared owner', async () => {
  const file = handle(), calls = []
  const io = owner({ open: async () => file, stat: async () => ({ size: BigInt(1) }),
    mkdir: async () => { calls.push('mkdir') }, realpath: async () => '/controlled/exact' })
  await io.mkdir('/controlled', { recursive: false }); await io.stat('/controlled/exact')
  assert.equal(await io.realpath('/controlled/exact'), '/controlled/exact')
  assert.equal((await io.readBounded('/controlled/exact', 10)).length, 0)
  await io.writeExclusive('/controlled/evidence', 'literal')
  assert.equal(file.calls.close, 2); assert.equal(file.calls.write, 1); assert.deepEqual(calls, ['mkdir'])
  assert.equal(io.hasPending(), false); io.assertCleanup()
  assert(io.facts().every((fact) => fact.actionSettled && fact.closeObserved && !fact.expired))
  assert.deepEqual(pendingOwnedIo(), [])
})

test('slow open times out, denies another owner and process spawn, then only closes the late handle', async () => {
  const opening = deferred(), file = handle(), io = owner({ open: () => opening.promise })
  let original
  try {
    await assert.rejects(() => io.writeExclusive('/controlled/late', 'never-written'), (error) => { original = error; return inconclusive(error) })
    assert.equal(pendingOwnedIo().length, 1); assert.equal(file.calls.write, 0)
    let otherCalls = 0
    const other = owner({ stat: async () => { otherCalls++; return {} } }, 'io-other')
    await assert.rejects(() => other.stat('/controlled'), (error) => error instanceof OwnedIoAdmissionFailure && error.noIoStarted)
    let spawns = 0
    await assert.rejects(() => new NodeOwnedFfmpegExecutor({ spawnChild: () => { spawns++; throw new Error('must not spawn') } }).execute({
      executable: 'controlled-no-process', args: [], owner: { runId: 'blocked-by-io', operation: 'unit' }, timeoutMs: 100 }), (error) => error.noChildStarted === true)
    assert.equal(otherCalls, 0); assert.equal(spawns, 0)
    opening.resolve(file); await flush()
    assert.equal(file.calls.write, 0); assert.equal(file.calls.close, 1)
    assert.deepEqual(pendingOwnedIo(), []); assert.equal(original.ioSettled, false)
    assert.equal(io.facts()[0].outcome, 'failed'); assert.equal(io.facts()[0].expired, true)
    assert.throws(() => io.assertCleanup(), (error) => error.code === 'RENDER_EXECUTION_FAILED')
  } finally { opening.resolve(file); await flush() }
})

test('admitted manifest write settles late as FAIL, pending bytes never become a final passed marker', async () => {
  const writing = deferred(), file = handle(), marker = JSON.stringify({ outcome: 'observed-pending-owner-confirmation', candidateOutcome: 'passed' })
  file.writeFile = (bytes) => { file.calls.write++; file.writes.push(Buffer.from(bytes)); return writing.promise }
  const io = owner({ open: async () => file }); let failure
  try {
    await assert.rejects(() => io.writeExclusive('/controlled/manifest.json', marker, 'archive'), (error) => { failure = error; return inconclusive(error) })
    assert.equal(file.calls.write, 1); assert.equal(file.calls.close, 0)
    writing.resolve(); await flush()
    assert.equal(file.calls.close, 1); assert.equal(failure.ioSettled, false); assert.equal(io.facts()[0].outcome, 'failed')
    assert.equal(JSON.parse(file.writes[0]).outcome, 'observed-pending-owner-confirmation')
    await assert.rejects(() => io.writeExclusive('/controlled/after-hardEnd', 'forbidden', 'archive'), (error) => error instanceof OwnedIoAdmissionFailure && error.noIoStarted)
    assert.equal(file.calls.write, 1, 'no new write after timeout or hardEnd')
  } finally { writing.resolve(); await flush() }
})

test('slow read is retained and late settlement performs no second read', async () => {
  const reading = deferred(), file = handle()
  file.read = () => { file.calls.read++; return reading.promise }
  const io = owner({ open: async () => file })
  try {
    await assert.rejects(() => io.readBounded('/controlled/read', 10), inconclusive)
    assert.equal(pendingOwnedIo().length, 1); assert.equal(file.calls.close, 0)
    reading.resolve({ bytesRead: 0 }); await flush()
    assert.equal(file.calls.read, 1); assert.equal(file.calls.close, 1)
    assert.equal(io.facts()[0].outcome, 'failed'); assert.deepEqual(pendingOwnedIo(), [])
  } finally { reading.resolve({ bytesRead: 0 }); await flush() }
})

test('hash end without close remains pending, late close records settlement without upgrading FAIL', async () => {
  const stream = new PassThrough({ autoDestroy: false, emitClose: false })
  const io = owner({ stream: () => stream }); const hashing = io.hashFile('/controlled/hash', 1024)
  queueMicrotask(() => stream.end('exact bytes'))
  try {
    await assert.rejects(() => hashing, inconclusive)
    assert.equal(pendingOwnedIo().length, 1); assert.equal(io.facts()[0].closeObserved, false)
    stream.emit('close'); await flush()
    assert.equal(io.facts()[0].closeObserved, true); assert.equal(io.facts()[0].outcome, 'failed')
    assert.deepEqual(pendingOwnedIo(), [])
  } finally { stream.emit('close'); await flush() }
})

test('hash success requires exact bytes plus real controlled stream close', async () => {
  const stream = new PassThrough({ autoDestroy: false, emitClose: false })
  const io = owner({ stream: () => stream }); const hashing = io.hashFile('/controlled/hash', 1024)
  queueMicrotask(() => stream.end('exact bytes'))
  setImmediate(() => stream.emit('close'))
  try {
    assert.deepEqual(await hashing, { sha256: createHash('sha256').update('exact bytes').digest('hex'), byteSize: 11 })
    assert.equal(io.hasPending(), false); assert.equal(io.facts()[0].closeObserved, true)
  } finally { stream.emit('close'); await flush() }
})


test('zero hash bound authenticates empty SHA only after controlled stream close', async () => {
  const stream = new PassThrough({ autoDestroy: false, emitClose: false })
  const io = owner({ stream: () => stream }); let settled = false
  const hashing = io.hashFile('/controlled/empty', 0).finally(() => { settled = true })
  queueMicrotask(() => stream.end())
  try {
    await flush(); assert.equal(settled, false, 'end without close is not terminal')
    assert.equal(io.facts()[0].closeObserved, false)
    stream.emit('close')
    assert.deepEqual(await hashing, { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', byteSize: 0 })
    assert.equal(io.hasPending(), false); io.assertCleanup()
    assert.equal(io.facts()[0].closeObserved, true); assert.deepEqual(pendingOwnedIo(), [])
  } finally { stream.emit('close'); await flush() }
})

test('zero hash bound rejects any byte and still waits for controlled stream close', async () => {
  const stream = new PassThrough({ autoDestroy: false, emitClose: false })
  const io = owner({ stream: () => stream }); let settled = false
  const rejecting = assert.rejects(() => io.hashFile('/controlled/nonempty', 0),
    (error) => error.code === 'INVALID_RENDER_INPUT' && error.message === 'Owned hash exceeded its byte bound')
    .finally(() => { settled = true })
  queueMicrotask(() => stream.end('x'))
  try {
    await flush(); assert.equal(settled, false, 'overflow cannot bypass close')
    assert.equal(io.facts()[0].closeObserved, false)
    stream.emit('close'); await rejecting
    assert.equal(io.hasPending(), false); assert.equal(io.facts()[0].closeObserved, true)
    assert.equal(io.facts()[0].outcome, 'failed'); assert.deepEqual(pendingOwnedIo(), [])
  } finally { stream.emit('close'); await flush() }
})

test('invalid hash bounds reject before starting a stream', async () => {
  let streams = 0
  const io = owner({ stream: () => { streams++; throw new Error('must not open') } })
  for (const bound of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(() => io.hashFile('/controlled/invalid', bound),
      (error) => error.code === 'INVALID_RENDER_INPUT' && error.noIoStarted === true)
  assert.equal(streams, 0); assert.deepEqual(io.facts(), []); assert.deepEqual(pendingOwnedIo(), [])
})

test('late write error preserves original failed result and sanitized ledger facts', async () => {
  const writing = deferred(), file = handle(), cause = new Error('controlled late write cause')
  file.writeFile = () => { file.calls.write++; return writing.promise }
  const io = owner({ open: async () => file }); let original
  try {
    await assert.rejects(() => io.writeExclusive('/controlled/error', 'bytes'), (error) => { original = error; return inconclusive(error) })
    writing.reject(cause); await flush()
    assert.equal(original.primaryIoError, cause); assert(original.ioFailures.includes(cause))
    assert.equal(file.calls.close, 1); assert.equal(io.facts()[0].outcome, 'failed')
    assert.equal(io.facts()[0].errors.some((error) => error.messageSha256 === createHash('sha256').update(cause.message).digest('hex')), true)
    assert.deepEqual(pendingOwnedIo(), [])
  } finally { writing.reject(cause); await flush() }
})

for (const operation of ['stat', 'mkdir', 'realpath']) test(operation + ' pending promise blocks until actual late settlement', async () => {
  const waiting = deferred(), io = owner({ [operation]: () => waiting.promise })
  try {
    await assert.rejects(() => operation === 'mkdir' ? io.mkdir('/controlled', { recursive: false }) : io[operation]('/controlled'), inconclusive)
    assert.equal(pendingOwnedIo().length, 1)
    waiting.resolve(operation === 'realpath' ? '/controlled' : {}); await flush()
    assert.deepEqual(pendingOwnedIo(), []); assert.equal(io.facts()[0].outcome, 'failed')
  } finally { waiting.resolve({}); await flush() }
})

test('FileHandle close must settle; accepted read completion is insufficient', async () => {
  const closing = deferred(), file = handle()
  file.close = () => { file.calls.close++; return closing.promise }
  const io = owner({ open: async () => file })
  try {
    await assert.rejects(() => io.readBounded('/controlled/close', 10), inconclusive)
    assert.equal(io.facts()[0].closeObserved, false); assert.equal(pendingOwnedIo().length, 1)
    closing.resolve(); await flush()
    assert.equal(io.facts()[0].closeObserved, true); assert.equal(io.facts()[0].outcome, 'failed')
    assert.deepEqual(pendingOwnedIo(), [])
  } finally { closing.resolve(); await flush() }
})

test('expired work refuses new IO while predeclared archive window can run; hardEnd refuses all writes', async () => {
  let opens = 0; const file = handle(), now = performance.now()
  const io = new OwnedDeadlineIo({ runId: 'phase-unit', workEndMonotonicMs: now - 1, hardEndMonotonicMs: now + 100,
    dependencies: { open: async () => { opens++; return file } } })
  await assert.rejects(() => io.writeExclusive('/controlled/work', 'forbidden'), (error) => error.noIoStarted === true)
  assert.equal(opens, 0)
  await io.writeExclusive('/controlled/archive', 'allowed', 'archive'); assert.equal(opens, 1)
  const expired = new OwnedDeadlineIo({ runId: 'hard-end-unit', workEndMonotonicMs: now - 2, hardEndMonotonicMs: now - 1,
    dependencies: { open: async () => { opens++; return file } } })
  await assert.rejects(() => expired.writeExclusive('/controlled/late', 'forbidden', 'archive'), (error) => error.noIoStarted === true)
  assert.equal(opens, 1); assert.deepEqual(pendingOwnedIo(), [])
})

test('retained archive wait is bounded and its late settlement never permits a new evidence write', async () => {
  const waiting = deferred(), file = handle(), io = owner({ open: async () => file })
  try {
    await assert.rejects(() => io.wait('archive-settlement', waiting.promise), inconclusive)
    assert.equal(pendingOwnedIo().length, 1)
    await assert.rejects(() => io.writeExclusive('/controlled/finally', 'forbidden', 'archive'), (error) => error.noIoStarted === true)
    assert.equal(file.calls.write, 0)
    waiting.resolve(); await flush()
    assert.equal(io.facts()[0].outcome, 'failed'); assert.deepEqual(pendingOwnedIo(), [])
  } finally { waiting.resolve(); await flush() }
})

test('cancellation of admitted IO retains the actual operation through late settlement', async () => {
  const waiting = deferred(), signal = new AbortController(), now = performance.now()
  const io = new OwnedDeadlineIo({ runId: 'cancelled-io', workEndMonotonicMs: now + 120, hardEndMonotonicMs: now + 240,
    signal: signal.signal, dependencies: { stat: () => waiting.promise } })
  const reading = io.stat('/controlled'); queueMicrotask(() => signal.abort())
  try {
    await assert.rejects(() => reading, inconclusive)
    assert.equal(pendingOwnedIo().length, 1)
    waiting.resolve({}); await flush()
    assert.equal(io.facts()[0].outcome, 'failed'); assert.deepEqual(pendingOwnedIo(), [])
  } finally { waiting.resolve({}); await flush() }
})

for (const operation of ['write', 'read']) test(operation + ' cause survives close failure, retaining handle and blocking another owner', async () => {
  // Separate fixture module has its own retained ledger, with no reset/rescue API.
  // The intentionally unclosed fake handle remains retained for this owner.
  const isolated = await import(new URL('../../src/v2/infrastructure/media/ffmpeg-owned-io.ts?retained-' + operation + '-close-failure', import.meta.url))
  const primary = new Error('controlled ' + operation + ' failure'), close = new Error('controlled close failure')
  const file = handle({ writeFile: async () => { throw primary }, read: async () => { throw primary }, close: async () => { throw close } })
  const now = performance.now(), io = new isolated.OwnedDeadlineIo({ runId: 'primary-' + operation, workEndMonotonicMs: now + 120,
    hardEndMonotonicMs: now + 240, dependencies: { open: async () => file } })
  await assert.rejects(() => operation === 'write' ? io.writeExclusive('/controlled', 'bytes') : io.readBounded('/controlled', 10), (error) => {
    assert(error instanceof isolated.OwnedIoInconclusive); assert.equal(error.primaryIoError, primary)
    assert(error.ioFailures.includes(primary)); assert(error.ioFailures.includes(close)); return true
  })
  assert.equal(io.facts()[0].closeObserved, false); assert.equal(isolated.pendingOwnedIo().length, 1)
  let secondCalls = 0
  const second = new isolated.OwnedDeadlineIo({ runId: 'second-' + operation, workEndMonotonicMs: now + 120, hardEndMonotonicMs: now + 240,
    dependencies: { stat: async () => { secondCalls++; return {} } } })
  await assert.rejects(() => second.stat('/controlled'), (error) => error instanceof isolated.OwnedIoAdmissionFailure && error.noIoStarted)
  assert.equal(secondCalls, 0); assert.equal(isolated.pendingOwnedIo().length, 1)
})

test('fractional IO deadline accepts the represented sum boundary and rejects ceiling plus one', () => {
  const work = 30000.0001, hard = work + 5000
  assert.equal(hard, 35000.000100000005); assert(hard - work > 5000)
  const io = new OwnedDeadlineIo({ runId: 'fractional-boundary', workEndMonotonicMs: work, hardEndMonotonicMs: hard })
  assert.deepEqual(io.facts(), [], 'constructor validates without admitting any IO')
  assert.throws(() => new OwnedDeadlineIo({ runId: 'fractional-over-limit', workEndMonotonicMs: work,
    hardEndMonotonicMs: work + 5001 }), (error) => error.code === 'INVALID_RENDER_INPUT' && error.noIoStarted === true)
})
