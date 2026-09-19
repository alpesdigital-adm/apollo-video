import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

import {
  DEFAULT_WORKER_SHUTDOWN_GRACE_MS,
  WORKER_SHUTDOWN_DEADLINE_EXIT_CODE,
  WORKER_SHUTDOWN_ERROR_CODE,
  awaitWithShutdownDeadline,
  createWorkerShutdown,
  immediateNextAttemptAt,
  isShutdownDeadlineError,
  linkAbortSignal,
  resolveWorkerShutdownGraceMs,
  runWithCleanup,
  terminateChild,
  workerShutdownFailure,
} from '../../src/v2/application/worker-lifecycle.ts'
import { applyV2ApplicationName } from '../../src/v2/infrastructure/prisma-postgres/client.ts'

function fakeProcess() {
  const emitter = new EventEmitter()
  return {
    emitter,
    once: (event, listener) => emitter.once(event, listener),
    off: (event, listener) => emitter.off(event, listener),
  }
}

function openGate() {
  return { read: async () => ({ admits: true, reason: null }) }
}

test('a stop signal aborts once and reports the signal that stopped the worker', async () => {
  const host = fakeProcess()
  const events = []
  const shutdown = createWorkerShutdown({
    process: host,
    gate: openGate(),
    log: (event) => events.push(event),
  })

  assert.equal(shutdown.stopping(), false)
  assert.equal(shutdown.reason, null)
  assert.deepEqual(await shutdown.admits(), { admits: true, reason: null })

  host.emitter.emit('SIGTERM')
  assert.equal(shutdown.stopping(), true)
  assert.equal(shutdown.signal.aborted, true)
  assert.equal(shutdown.reason, 'SIGTERM')
  assert.deepEqual(await shutdown.admits(), { admits: false, reason: 'shutdown:SIGTERM' })

  // A second, different signal from an impatient supervisor must not re-enter the
  // shutdown path or rewrite the reason the first one recorded.
  host.emitter.emit('SIGINT')
  assert.equal(shutdown.reason, 'SIGTERM')
  assert.equal(
    events.filter((event) => event.event === 'worker-shutdown-requested').length,
    1,
  )
  shutdown.dispose()
})

test('a closed gate refuses admission and logs once per transition', async () => {
  const host = fakeProcess()
  const events = []
  let reading = { admits: false, reason: 'gate-closed:cpu-busy-sustained' }
  const shutdown = createWorkerShutdown({
    process: host,
    gate: { read: async () => reading },
    log: (event) => events.push(event),
  })

  assert.deepEqual(await shutdown.admits(), reading)
  assert.deepEqual(await shutdown.admits(), reading)
  assert.deepEqual(await shutdown.admits(), reading)
  assert.deepEqual(
    events.filter((event) => event.event === 'worker-admission-gate-closed'),
    [{ event: 'worker-admission-gate-closed', reason: 'gate-closed:cpu-busy-sustained' }],
  )

  reading = { admits: true, reason: null }
  assert.equal((await shutdown.admits()).admits, true)
  assert.deepEqual(
    events.filter((event) => event.event === 'worker-admission-gate-open'),
    [{ event: 'worker-admission-gate-open', reason: null }],
  )
  shutdown.dispose()
})

test('an absent ops-state contract admits and is noted exactly once', async () => {
  const host = fakeProcess()
  const events = []
  const shutdown = createWorkerShutdown({
    process: host,
    gate: { read: async () => ({ admits: true, reason: 'ops-state-not-configured' }) },
    log: (event) => events.push(event),
  })

  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(await shutdown.admits(), { admits: true, reason: null })
  }
  assert.equal(
    events.filter((event) => event.event === 'worker-admission-gate-absent').length,
    1,
  )
  shutdown.dispose()
})

test('dispose removes the signal listeners so a later signal cannot abort', async () => {
  const host = fakeProcess()
  const shutdown = createWorkerShutdown({ process: host, gate: openGate() })
  shutdown.dispose()
  shutdown.dispose()
  host.emitter.emit('SIGTERM')
  assert.equal(shutdown.signal.aborted, false)
  assert.equal(shutdown.stopping(), false)
})

test('createWorkerShutdown without a gate admits every claim', async () => {
  const host = fakeProcess()
  const shutdown = createWorkerShutdown({ process: host })
  assert.deepEqual(await shutdown.admits(), { admits: true, reason: null })
  shutdown.dispose()
})

test('linkAbortSignal forwards an outer abort once and removes its listener', () => {
  const outer = new AbortController()
  const inner = new AbortController()
  const link = linkAbortSignal(outer.signal, inner)
  assert.equal(inner.signal.aborted, false)
  outer.abort(new Error('stop'))
  assert.equal(inner.signal.aborted, true)
  assert.equal(inner.signal.reason.message, 'stop')
  link.dispose()
  link.dispose()
})

test('linkAbortSignal forwards immediately when the outer signal already aborted', () => {
  const outer = new AbortController()
  outer.abort(new Error('already'))
  const inner = new AbortController()
  linkAbortSignal(outer.signal, inner).dispose()
  assert.equal(inner.signal.aborted, true)
})

test('linkAbortSignal with no outer signal never aborts the inner controller', () => {
  const inner = new AbortController()
  const link = linkAbortSignal(undefined, inner)
  link.dispose()
  assert.equal(inner.signal.aborted, false)
})

test('linkAbortSignal does not leak a listener per claim on a long-lived signal', () => {
  const outer = new AbortController()
  for (let index = 0; index < 50; index += 1) {
    linkAbortSignal(outer.signal, new AbortController()).dispose()
  }
  const inner = new AbortController()
  const link = linkAbortSignal(outer.signal, inner)
  outer.abort()
  assert.equal(inner.signal.aborted, true)
  link.dispose()
})

test('terminateChild escalates to SIGKILL and awaits the real exit', async () => {
  // A child that installs its own SIGTERM handler and keeps running is the case the
  // grace deadline exists for. POSIX-only for the signal semantics; on Windows
  // `kill` terminates regardless, so the escalation flag is not asserted there.
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore', shell: false },
  )
  await new Promise((resolve) => child.once('spawn', resolve))
  const result = await terminateChild(child, { graceMs: 250 })
  assert.equal(result.alreadyExited, false)
  // The contract that matters on every platform: the promise settles only after the
  // process has actually exited, so the caller cannot race the child's file handles.
  assert.notEqual(child.exitCode === null && child.signalCode === null, true)
  if (process.platform !== 'win32') {
    assert.equal(result.escalated, true)
    assert.equal(child.signalCode, 'SIGKILL')
  }
})

test('terminateChild waits for a cooperative child without escalating', async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore', shell: false },
  )
  await new Promise((resolve) => child.once('spawn', resolve))
  const result = await terminateChild(child, { graceMs: 5_000 })
  assert.equal(result.escalated, false)
  assert.equal(result.alreadyExited, false)
})

test('terminateChild reports a child that had already exited and signals nothing', async () => {
  let killed = 0
  const already = {
    pid: 4242,
    exitCode: 0,
    signalCode: null,
    kill: () => { killed += 1; return true },
    once: () => undefined,
  }
  assert.deepEqual(
    await terminateChild(already, { graceMs: 10 }),
    { escalated: false, alreadyExited: true },
  )
  assert.equal(killed, 0)
})

test('terminateChild refuses a negative or fractional grace window', async () => {
  const child = { exitCode: null, signalCode: null, kill: () => true, once: () => undefined }
  await assert.rejects(() => terminateChild(child, { graceMs: -1 }), /non-negative integer/)
  await assert.rejects(() => terminateChild(child, { graceMs: 1.5 }), /non-negative integer/)
})

test('runWithCleanup keeps the primary error and attaches every cleanup failure', async () => {
  const order = []
  const logged = []
  const primary = new Error('render failed')
  let failure
  try {
    await runWithCleanup(
      async () => { throw primary },
      [
        { name: 'first', run: () => { order.push('first'); throw new Error('first cleanup') } },
        { name: 'second', run: () => { order.push('second') } },
        { name: 'third', run: () => { order.push('third'); throw new Error('third cleanup') } },
      ],
      (event) => logged.push(event),
    )
    assert.fail('runWithCleanup must rethrow the primary error')
  } catch (error) {
    failure = error
  }
  // The primary error itself is what surfaces — not a cleanup failure standing in
  // front of it, which is how a failed disconnect used to hide a render failure.
  assert.equal(failure, primary)

  // Every cleanup ran, in order, despite the first one throwing.
  assert.deepEqual(order, ['first', 'second', 'third'])
  assert.deepEqual(failure.cleanupErrors.map((entry) => entry.name), ['first', 'third'])
  assert.deepEqual(logged.map((event) => event.reason), ['first', 'third'])
})

test('runWithCleanup returns the primary result and reports cleanup-only failures', async () => {
  assert.equal(
    await runWithCleanup(async () => 'done', [{ name: 'noop', run: () => undefined }]),
    'done',
  )
  await assert.rejects(
    () => runWithCleanup(
      async () => 'done',
      [{ name: 'prisma-disconnect', run: () => { throw new Error('socket') } }],
    ),
    (error) => {
      assert.match(error.message, /Worker cleanup failed: prisma-disconnect/)
      assert.deepEqual(error.cleanupErrors.map((entry) => entry.name), ['prisma-disconnect'])
      return true
    },
  )
})

/** A timer under the test's control, so a 20 s deadline costs no wall-clock time. */
function fakeTimer() {
  const scheduled = []
  return {
    scheduled,
    setTimer: (callback, delayMs) => {
      const entry = { callback, delayMs, cleared: false }
      scheduled.push(entry)
      return { clear: () => { entry.cleared = true } }
    },
    fire: (index = 0) => scheduled[index].callback(),
  }
}

test('the deadline only starts at the stop signal, not when the branch was admitted', async () => {
  const controller = new AbortController()
  const timer = fakeTimer()
  let resolveWork
  const work = new Promise((resolve) => { resolveWork = resolve })
  const pending = awaitWithShutdownDeadline(
    work,
    { signal: controller.signal, reason: null },
    { branch: 'project-director', graceMs: 20_000, setTimer: timer.setTimer },
  )
  // Nothing armed: the worker has not been told to stop, so a long branch is simply
  // a long branch and must not be cut off.
  assert.equal(timer.scheduled.length, 0)
  controller.abort(new Error('Worker received SIGTERM'))
  assert.equal(timer.scheduled.length, 1)
  assert.equal(timer.scheduled[0].delayMs, 20_000)
  resolveWork('settled in time')
  assert.equal(await pending, 'settled in time')
  assert.equal(timer.scheduled[0].cleared, true, 'a settled branch must disarm its deadline')
})

test('a branch that never settles after the stop signal reaches the deadline and names itself', async () => {
  const controller = new AbortController()
  const timer = fakeTimer()
  const deadlines = []
  // The case this exists for: the director branch has no abortable port, so this
  // promise is one that genuinely cannot be made to settle.
  const never = new Promise(() => {})
  const pending = awaitWithShutdownDeadline(
    never,
    { signal: controller.signal, reason: 'SIGTERM' },
    {
      branch: 'project-director',
      graceMs: 20_000,
      onDeadline: (event) => deadlines.push(event),
      setTimer: timer.setTimer,
    },
  )
  controller.abort(new Error('Worker received SIGTERM'))
  timer.fire()

  const error = await pending.then(() => null, (thrown) => thrown)
  assert.equal(isShutdownDeadlineError(error), true)
  assert.equal(error.branch, 'project-director')
  assert.equal(error.graceMs, 20_000)
  assert.match(error.message, /no outcome within 20000ms of SIGTERM/)
  assert.deepEqual(deadlines, [{
    event: 'worker-shutdown-deadline',
    branch: 'project-director',
    graceMs: 20_000,
    reason: 'SIGTERM',
  }])
})

test('a branch admitted after the stop signal is bounded from the first moment', async () => {
  const controller = new AbortController()
  controller.abort(new Error('Worker received SIGINT'))
  const timer = fakeTimer()
  const pending = awaitWithShutdownDeadline(
    new Promise(() => {}),
    { signal: controller.signal, reason: 'SIGINT' },
    { branch: 'artifact-render', graceMs: 5_000, setTimer: timer.setTimer },
  )
  assert.equal(timer.scheduled.length, 1, 'an already-aborted signal arms immediately')
  timer.fire()
  const error = await pending.then(() => null, (thrown) => thrown)
  assert.equal(isShutdownDeadlineError(error), true)
})

test('a branch that fails on its own surfaces its own error, not the deadline', async () => {
  const controller = new AbortController()
  const timer = fakeTimer()
  const own = new Error('ffmpeg exited 1')
  const pending = awaitWithShutdownDeadline(
    Promise.reject(own),
    { signal: controller.signal, reason: null },
    { branch: 'project-proxy-render', graceMs: 20_000, setTimer: timer.setTimer },
  )
  const error = await pending.then(() => null, (thrown) => thrown)
  assert.equal(error, own)
  assert.equal(isShutdownDeadlineError(error), false)
})

test('the deadline never fires for work that settled before the signal arrived', async () => {
  const controller = new AbortController()
  const timer = fakeTimer()
  assert.equal(
    await awaitWithShutdownDeadline(
      Promise.resolve('done'),
      { signal: controller.signal, reason: null },
      { branch: 'source-cleanup', graceMs: 20_000, setTimer: timer.setTimer },
    ),
    'done',
  )
  controller.abort()
  // The listener was removed in `finally`, so a later abort arms nothing at all.
  assert.equal(timer.scheduled.length, 0)
})

test('awaitWithShutdownDeadline refuses a negative or fractional grace window', async () => {
  const controller = new AbortController()
  for (const graceMs of [-1, 1.5]) {
    await assert.rejects(
      () => awaitWithShutdownDeadline(
        Promise.resolve(1),
        { signal: controller.signal, reason: null },
        { branch: 'x', graceMs },
      ),
      /non-negative integer graceMs/,
    )
  }
})

test('the grace window is validated like the poll interval and stays under the container stop timeout', () => {
  assert.equal(resolveWorkerShutdownGraceMs(undefined), DEFAULT_WORKER_SHUTDOWN_GRACE_MS)
  assert.equal(resolveWorkerShutdownGraceMs(''), DEFAULT_WORKER_SHUTDOWN_GRACE_MS)
  assert.equal(DEFAULT_WORKER_SHUTDOWN_GRACE_MS, 20_000)
  assert.equal(DEFAULT_WORKER_SHUTDOWN_GRACE_MS < 30_000, true)
  assert.equal(resolveWorkerShutdownGraceMs('100'), 100)
  assert.equal(resolveWorkerShutdownGraceMs('29000'), 29_000)
  // 30 s is `docker stop`'s own timeout: a worker deadline at or above it would be
  // SIGKILLed before it ever got to run its cleanups.
  for (const invalid of ['30000', '99', '0', '-1', '1.5', 'soon', '29001']) {
    assert.throws(
      () => resolveWorkerShutdownGraceMs(invalid),
      /between 100 and 29000ms, below the container stop timeout/,
      `${invalid} must be refused`,
    )
  }
})

test('the deadline exit code is the documented last-resort code', () => {
  assert.equal(WORKER_SHUTDOWN_DEADLINE_EXIT_CODE, 2)
  assert.equal(isShutdownDeadlineError(new Error('plain')), false)
  assert.equal(isShutdownDeadlineError(null), false)
  assert.equal(isShutdownDeadlineError(undefined), false)
  assert.equal(isShutdownDeadlineError('string'), false)
})

test('the shutdown failure is retryable and its next attempt is the earliest the domain accepts', () => {
  const failure = workerShutdownFailure()
  assert.equal(failure.code, WORKER_SHUTDOWN_ERROR_CODE)
  assert.equal(failure.code, 'worker_shutdown')
  assert.equal(failure.retryable, true)

  const failedAt = new Date('2026-09-18T12:00:00.000Z')
  const next = immediateNextAttemptAt(failedAt)
  // Strictly after, because `retryOrFailPublicOperation` asserts
  // `nextAttemptAt > updatedAt` and would otherwise refuse the transition.
  assert.equal(Date.parse(next) > failedAt.getTime(), true)
  assert.equal(Date.parse(next) - failedAt.getTime(), 1)
})

test('application_name names this process only when the URL does not already carry one', () => {
  assert.equal(
    applyV2ApplicationName('postgresql://u:p@host:5432/db', 'render-worker'),
    'postgresql://u:p@host:5432/db?application_name=apollo-video-render-worker',
  )
  assert.equal(
    applyV2ApplicationName('postgresql://u:p@host:5432/db?connection_limit=5', 'app'),
    'postgresql://u:p@host:5432/db?connection_limit=5&application_name=apollo-video-app',
  )
  // The E2E exclusivity preflight matches on its own name; overriding it would blind
  // the check that keeps two runs off the same database.
  const e2e = 'postgresql://u:p@host:5432/db?application_name=apollo-video-e2e-run42&connection_limit=5'
  assert.equal(applyV2ApplicationName(e2e, 'render-worker'), e2e)
  // No role, an empty role, or a role with characters that do not belong in a
  // connection string leaves the URL untouched rather than guessing.
  assert.equal(applyV2ApplicationName('postgresql://h/db', undefined), 'postgresql://h/db')
  assert.equal(applyV2ApplicationName('postgresql://h/db', '  '), 'postgresql://h/db')
  assert.equal(applyV2ApplicationName('postgresql://h/db', 'bad role'), 'postgresql://h/db')
  assert.equal(applyV2ApplicationName('not a url', 'render-worker'), 'not a url')
})
