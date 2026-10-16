import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { pendingOwnedIo, OwnedIoInconclusive } from '../../src/v2/infrastructure/media/ffmpeg-owned-io.ts'
import { NodeOwnedFfmpegExecutor, OwnedFfmpegProcessFailure, OwnedFfmpegTerminalInconclusive,
  OwnedFfmpegAdmissionFailure, pendingOwnedFfmpegTerminations } from '../../src/v2/infrastructure/media/ffmpeg-owned-process.ts'

// Controlled ChildProcess event/stream contract only. These units neither spawn
// an OS child nor claim physical termination. The supervised collector remains
// the separate physical gate; exit and accepted signals never count as close.
function controlledChild(onSpawn = () => {}, onKill = () => {}) {
  const child = new EventEmitter(), signals = []
  child.pid = 24680; child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.closed = false
  child.kill = (signal) => { signals.push(signal); onKill(child, signal); return true }
  child.close = (code = 0, signal = null) => {
    if (child.closed) return
    child.closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code, signal)
  }
  const calls = []
  const spawnChild = (...args) => {
    calls.push(args); queueMicrotask(() => { child.emit('spawn'); onSpawn(child) }); return child
  }
  return { child, signals, calls, executor: new NodeOwnedFfmpegExecutor({ spawnChild }) }
}
function options(operation, extra = {}) {
  return { executable: 'controlled-not-an-os-process', args: ['literal'], owner: { runId: 'executor-unit', operation },
    timeoutMs: 160, maxOutputBytes: 1024, ...extra }
}
async function release(child) {
  child.close(); await nextTurn(); await nextTurn()
  assert.deepEqual(pendingOwnedFfmpegTerminations(), [], 'controlled real-close event releases registry')
}

test('normal close completes observation and literal spawn defaults without publishing a process handle', async () => {
  const control = controlledChild((child) => { child.stdout.write('out'); child.stderr.write('err'); child.emit('exit', 0, null); child.close() })
  const observed = []
  try {
    const result = await control.executor.execute(options('normal', { observe: (value) => { observed.push(value) } }))
    assert.equal(result.closeObserved, true); assert.equal(result.spawnObserved, true); assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.toString(), 'out'); assert.equal(result.stderr.toString(), 'err')
    assert.equal(result.ownerKey.runId, 'executor-unit'); assert.equal(result.ownerKey.operation, 'normal')
    assert.equal(typeof result.ownerKey.executionId, 'string'); assert.equal(observed.length, 1)
    assert.equal('child' in result, false); assert.equal('kill' in result, false)
    assert.deepEqual(control.calls[0][2], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    assert.deepEqual(control.signals, [])
  } finally { await release(control.child) }
})

test('work timeout reserves TERM and actual close inside the absolute owner bound', async () => {
  const control = controlledChild(() => {}, (child, signal) => {
    if (signal === 'SIGTERM') queueMicrotask(() => { child.emit('exit', null, 'SIGTERM'); child.close(null, 'SIGTERM') })
  })
  try {
    await assert.rejects(() => control.executor.execute(options('timeout-close', { deadlineMonotonicMs: performance.now() + 120 })), (error) => {
      assert(error instanceof OwnedFfmpegProcessFailure); assert.equal(error.observation.closeObserved, true)
      assert.equal(error.observation.timedOut, true); assert.equal(error.primaryProcessError.message, 'Synthetic render inspection timed out')
      return true
    })
    assert.deepEqual(control.signals, ['SIGTERM']); assert.deepEqual(pendingOwnedFfmpegTerminations(), [])
  } finally { await release(control.child) }
})

test('late no-close retains opaque ownership across instances, exit does not release, real close releases', async () => {
  const control = controlledChild(), late = []; let failure
  try {
    await assert.rejects(() => control.executor.execute(options('retained', { observeLateClose: (value) => { late.push(value) } })), (error) => {
      failure = error; assert(error instanceof OwnedFfmpegTerminalInconclusive)
      assert.equal(error.closeObserved, false); assert.equal('pid' in error, false); assert.equal('observation' in error, false)
      assert.equal('child' in error, false); assert.equal('kill' in error, false); assert.equal(late.length, 0)
      return true
    })
    assert.deepEqual(control.signals, ['SIGTERM', 'SIGKILL'])
    assert.deepEqual(pendingOwnedFfmpegTerminations(), [{ ownerKey: failure.ownerKey, closeObserved: false }])
    const blocked = controlledChild()
    await assert.rejects(() => blocked.executor.execute(options('next-admission')), (error) => error instanceof OwnedFfmpegAdmissionFailure && error.noChildStarted === true)
    assert.equal(blocked.calls.length, 0, 'new instance cannot spawn after retained owner')
    control.child.emit('exit', 0, null)
    assert.equal(pendingOwnedFfmpegTerminations().length, 1, 'exit alone is insufficient')
    await assert.rejects(() => blocked.executor.execute(options('after-exit')), (error) => error.noChildStarted === true)
    assert.equal(blocked.calls.length, 0)
    await release(control.child)
    assert.equal(late.length, 1); assert.equal(late[0].closeObserved, true)
    assert.equal(failure.closeObserved, false, 'original inconclusive result remains failed')
    const next = controlledChild((child) => child.close())
    try { assert.equal((await next.executor.execute(options('after-close'))).closeObserved, true) }
    finally { await release(next.child) }
  } finally { await release(control.child) }
})

test('exit before timeout still retains until close and prevents signals after observed exit', async () => {
  const control = controlledChild((child) => child.emit('exit', 0, null))
  try {
    await assert.rejects(() => control.executor.execute(options('exit-only')), (error) => error instanceof OwnedFfmpegTerminalInconclusive)
    assert.deepEqual(control.signals, [], 'never signal the exited process handle')
    assert.equal(pendingOwnedFfmpegTerminations().length, 1)
  } finally { await release(control.child) }
})

test('cancel retains cancellation cause while requiring actual close', async () => {
  const abort = new AbortController()
  const control = controlledChild(() => abort.abort(), (child) => queueMicrotask(() => child.close(null, 'SIGTERM')))
  try {
    await assert.rejects(() => control.executor.execute(options('cancel', { signal: abort.signal })), (error) => {
      assert(error instanceof OwnedFfmpegProcessFailure); assert.equal(error.code, 'RENDER_EXECUTION_FAILED')
      assert.equal(error.observation.aborted, true); assert.equal(error.observation.closeObserved, true)
      assert.equal(error.primaryProcessError.message, 'Synthetic render inspection was cancelled'); return true
    })
  } finally { await release(control.child) }
})

test('overflow retains total and bounded captured byte counts and stops with close', async () => {
  const control = controlledChild((child) => child.stdout.write('12345'), (child) => queueMicrotask(() => child.close(null, 'SIGTERM')))
  try {
    await assert.rejects(() => control.executor.execute(options('overflow', { maxOutputBytes: 4 })), (error) => {
      assert(error instanceof OwnedFfmpegProcessFailure); assert.equal(error.observation.outputExceeded, true)
      assert.equal(error.observation.stdoutBytes, 5); assert.equal(error.observation.capturedStdoutBytes, 4)
      assert.equal(error.observation.stdout.toString(), '1234'); assert.equal(error.observation.closeObserved, true)
      assert.equal(error.primaryProcessError.message, 'Synthetic render inspection output exceeded its limit'); return true
    })
  } finally { await release(control.child) }
})

test('process error remains primary when observer archive also fails', async () => {
  const original = new Error('controlled process cause'), archive = new Error('controlled archive failure')
  const control = controlledChild((child) => child.emit('error', original), (child) => queueMicrotask(() => child.close(1)))
  try {
    await assert.rejects(() => control.executor.execute(options('primary', { observe: () => { throw archive } })), (error) => {
      assert(error instanceof OwnedFfmpegProcessFailure); assert.equal(error.primaryProcessError, original)
      assert(error.ioFailures.includes(archive)); assert.equal(error.observation.closeObserved, true); return true
    })
  } finally { await release(control.child) }
})

test('late observer failure is attached to retained primary without changing the failed outcome', async () => {
  const archive = new Error('controlled late archive failure'), control = controlledChild(); let failure
  try {
    await assert.rejects(() => control.executor.execute(options('late-io', { observeLateClose: () => { throw archive } })), (error) => {
      failure = error; return error instanceof OwnedFfmpegTerminalInconclusive
    })
    const original = failure.primaryProcessError
    await release(control.child)
    assert.equal(failure.primaryProcessError, original); assert.equal(failure.closeObserved, false)
    assert(failure.ioFailures.includes(archive)); assert.deepEqual(pendingOwnedFfmpegTerminations(), [])
  } finally { await release(control.child) }
})

test('pre-abort and expired owner deny admission before invoking spawn', async () => {
  const abort = new AbortController(); abort.abort(); const control = controlledChild()
  await assert.rejects(() => control.executor.execute(options('pre-abort', { signal: abort.signal })), (error) => error.noChildStarted === true)
  await assert.rejects(() => control.executor.execute(options('expired', { deadlineMonotonicMs: performance.now() - 1 })), (error) => error.noChildStarted === true)
  assert.equal(control.calls.length, 0)
})

test('observer deadline preserves process cause and blocks next admission until callback settlement', async () => {
  const control = controlledChild((child) => child.close(1)); let complete, original
  const callback = new Promise((resolve) => { complete = resolve })
  try {
    await assert.rejects(() => control.executor.execute(options('archive-deadline', { observe: () => callback })), (error) => {
      original = error; assert(error instanceof OwnedFfmpegProcessFailure); assert.equal(error.observation.closeObserved, true)
      assert.equal(error.primaryProcessError.message, 'Synthetic render full decode failed')
      assert(error.ioFailures.some((failure) => failure instanceof OwnedIoInconclusive && failure.processCloseObserved)); return true
    })
    assert.equal(pendingOwnedIo().length, 1); assert.equal(pendingOwnedIo()[0].processCloseObserved, true)
    assert.deepEqual(pendingOwnedFfmpegTerminations(), [], 'process itself really closed')
    const blocked = controlledChild()
    await assert.rejects(() => blocked.executor.execute(options('blocked-observation')), (error) => error.noChildStarted === true)
    assert.equal(blocked.calls.length, 0)
    complete(); await nextTurn(); await nextTurn()
    assert.deepEqual(pendingOwnedIo(), []); assert.equal(original.primaryProcessError.message, 'Synthetic render full decode failed')
  } finally { complete(); await release(control.child) }
})
test('early close without observer does not create a 180s observation budget for a long ingest owner', async () => {
  const control=controlledChild(child=>child.close())
  try {
    const result=await control.executor.execute(options('long-ingest',{timeoutMs:1800000,deadlineMonotonicMs:performance.now()+1800000}))
    assert.equal(result.closeObserved,true);assert.equal(result.exitCode,0)
    assert.deepEqual(pendingOwnedIo(),[]);assert.deepEqual(pendingOwnedFfmpegTerminations(),[])
    const next=controlledChild(child=>child.close())
    try {assert.equal((await next.executor.execute(options('after-long-ingest'))).closeObserved,true)}
    finally {await release(next.child)}
  } finally {await release(control.child)}
})
test('observer remains subject to declared IO budget when a long owner closes early', async () => {
  const control=controlledChild(child=>child.close());let calls=0
  try {
    await assert.rejects(()=>control.executor.execute(options('long-observer',{timeoutMs:1800000,
      deadlineMonotonicMs:performance.now()+1800000,observe:()=>{calls++}})),error=>{
      assert(error instanceof OwnedFfmpegProcessFailure);assert.equal(error.observation.closeObserved,true)
      assert.equal(error.ioFailures.length,1);return true
    })
    assert.equal(calls,0);assert.deepEqual(pendingOwnedIo(),[])
  } finally {await release(control.child)}
})
test('close delivered after the absolute deadline fails even before an overdue timer runs', async (t) => {
  let now=1000
  t.mock.method(performance,'now',()=>now)
  const control=controlledChild(child=>{now=1011;child.close()})
  try {
    await assert.rejects(()=>control.executor.execute(options('overdue-close',{timeoutMs:10})),error=>{
      assert(error instanceof OwnedFfmpegProcessFailure);assert.equal(error.observation.closeObserved,true)
      assert.equal(error.observation.timedOut,true);return true
    })
  } finally {await release(control.child)}
})
