import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { readAuthorityIdentitySync, identityKey, liveIdentity, registerAddonConsumer, sourceFingerprint } from '../../scripts/validation/perception-addon-registry.mjs'
import { loadPidfdBinding, openObservedPidfd, signalViaPidfd, withPidfdLoadBudget } from '../../scripts/validation/perception-pidfd.mjs'
import { containObservedIdentities, readLinuxProcessIdentity } from '../../scripts/validation/run-perception-ci.mjs'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(action, deadlineAt) {
  while (Date.now() < deadlineAt) { const value = await action(); if (value) return value; await pause(10) }
  throw new Error('Owned native pidfd test deadline exhausted')
}

test('pidfd wrapper closes on recycled, terminal, failed and timed-out rechecks without signaling', async () => {
  const calls = [], expected = { pid: 123, starttime: '456', state: 'S' }
  const binding = { open(pid) { calls.push(['open', pid]); return {} },
    close() { calls.push(['close']); return true }, signal() { calls.push(['signal']); return true } }
  for (const current of [null, { ...expected, starttime: '457' }, { ...expected, state: 'Z' }]) {
    const owned = await openObservedPidfd(expected, { binding, deadlineAt: Date.now() + 1000,
      readIdentity: async () => { calls.push(['read']); return current } })
    assert.equal(owned.terminal, true); assert.equal(owned.close(), false)
  }
  await assert.rejects(openObservedPidfd(expected, { binding, deadlineAt: Date.now() + 1000,
    readIdentity: async () => { throw new Error('inconclusive') } }), /inconclusive/)
  await assert.rejects(openObservedPidfd(expected, { binding, deadlineAt: Date.now() + 1000,
    verifyDeadlineAt: Date.now() + 20, readIdentity: () => new Promise(() => {}) }), /timed out/)
  assert.equal(calls.filter(([kind]) => kind === 'open').length, 5)
  assert.equal(calls.filter(([kind]) => kind === 'close').length, 5)
  assert.equal(calls.filter(([kind]) => kind === 'signal').length, 0)
  assert.deepEqual(calls.slice(0, 3), [['open', 123], ['read'], ['close']])
  const before = calls.length
  await assert.rejects(openObservedPidfd(expected, { binding, deadlineAt: Date.now() - 1,
    readIdentity: async () => expected }), /exhausted/)
  assert.equal(calls.length, before, 'Expired budget must not open a descriptor')
})

// One scenario, two clocks: the aggregate cleanup deadline is 100 ms, the second identity's read never answers and the third must never be tried.
async function aggregateDeadlineScenario() {
  const calls = [], children = [10, 11, 12].map((pid) => ({ pid, starttime: String(pid), state: 'S' }))
  const binding = { open(pid) { calls.push(['open', pid]); return { pid } },
    close(token) { calls.push(['close', token.pid]); return true },
    signal(token) { calls.push(['signal', token.pid]); return true } }
  let reads = 0, finishRead
  const started = Date.now(), deadlineAt = started + 100
  const result = await containObservedIdentities(children, 'SIGTERM', deadlineAt, {
    pidfdSignal: (identity, signal, _runId, limit) => signalViaPidfd(identity, signal, {
      binding, deadlineAt: limit, readIdentity: async () => {
        reads++
        if (reads === 1) return identity
        return new Promise((resolve) => { finishRead = () => resolve(identity) })
      },
    }),
  })
  assert.ok(Date.now() - started < 230)
  assert.equal(result.signals.length, 1)
  assert.ok(result.errors.some((error) => /deadline|timed out/.test(error)))
  assert.equal(reads, 2)
  assert.deepEqual(calls, [['open', 12], ['signal', 12], ['close', 12], ['open', 11], ['close', 11]])
  finishRead(); await Promise.resolve(); await Promise.resolve()
  assert.equal(calls.filter(([kind]) => kind === 'signal').length, 1, 'Late read must never signal')
  assert.equal(calls.filter(([kind]) => kind === 'open').length, calls.filter(([kind]) => kind === 'close').length)
}

test('aggregate deadline closes the real wrapper token on a pending read without a late signal', aggregateDeadlineScenario)

// Node fires a timer up to a few milliseconds before Date.now() reaches the deadline it was armed for (libuv counts whole milliseconds from a
// clock cached at the start of the loop iteration). The CI run that failed this suite with reads 3 !== 2 had exactly that: the recheck timeout
// fired early, Date.now() was still before the aggregate deadline, and a third identity was attempted with nothing left. Model it with timers that
// fire 40 ms early (far more than the real case, so that the platform timer granularity cannot hide it).
test('aggregate deadline holds when every timer fires before the wall clock reaches its deadline', async () => {
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, delay, ...rest) => realSetTimeout(callback, Math.max(0, Number(delay) - 40), ...rest)
  try { await aggregateDeadlineScenario() } finally { globalThis.setTimeout = realSetTimeout }
})

test('addon load abort owns its deadline and cannot promote a late load to native open', async () => {
  const calls = [], expected = { pid: 123, starttime: '456', state: 'S' }
  const binding = { open() { calls.push('open'); return {} }, close() { calls.push('close') }, signal() { calls.push('signal') } }
  let aborted = false, promoted = false
  await assert.rejects(openObservedPidfd(expected, { deadlineAt: Date.now() + 20,
    readIdentity: async () => expected,
    loadBinding: (_env, options) => withPidfdLoadBudget(async (budget) => {
      await new Promise((resolve) => budget.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      budget.check() // Same check required before cache/require/publication in the real loader.
      promoted = true
      return { binding }
    }, options),
  }), /deadline/)
  assert.equal(aborted, true); assert.equal(promoted, false); assert.deepEqual(calls, [])
  await assert.rejects(withPidfdLoadBudget(() => assert.fail('Expired admission must not run'), {
    deadlineAt: Date.now() - 1,
  }), /deadline/)
})

test('registry admission and source reads fail before work after deadline or abort', async () => {
  await assert.rejects(registerAddonConsumer({}, { deadlineAt: Date.now() - 1 }), /admission deadline/)
  assert.throws(() => sourceFingerprint({ deadlineAt: Date.now() - 1 }), /admission deadline/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(registerAddonConsumer({}, { deadlineAt: Date.now() + 1000, signal: controller.signal }), /admission deadline/)
  assert.throws(() => sourceFingerprint({ signal: controller.signal }), /admission deadline/)
})

test('CI native pidfd prerequisite fails closed without an explicit addon',
  { skip: process.platform !== 'linux' }, async () => {
    assert.ok(process.getuid() > 0)
    await assert.rejects(loadPidfdBinding({}), /Missing explicit CI pidfd addon/)
  })

test('real unprivileged Node-API pidfd tokens reject forgery, unsupported signals and double use after close',
  { skip: process.platform !== 'linux' }, async () => {
    const { binding } = await loadPidfdBinding()
    const token = binding.open(process.pid)
    try {
      assert.deepEqual(Object.getOwnPropertyNames(token), [], 'Raw descriptor must remain opaque')
      for (const forged of [{}, 0, null, Object.create(token)]) {
        assert.throws(() => binding.signal(forged, 'SIGKILL'), { code: 'ERR_PIDFD_TOKEN' })
        assert.throws(() => binding.close(forged), { code: 'ERR_PIDFD_TOKEN' })
      }
      for (const value of ['SIGSTOP', 'SIGINT', 9, 'SIGKILL\0extra']) {
        assert.throws(() => binding.signal(token, value), { code: 'ERR_PIDFD_SIGNAL' })
      }
      assert.equal(binding.close(token), true); assert.equal(binding.close(token), false)
      assert.throws(() => binding.signal(token, 'SIGKILL'), { code: 'ERR_PIDFD_CLOSED' })
      assert.throws(() => binding.open(0), { code: 'ERR_PIDFD_PID' })
      assert.throws(() => binding.open(process.pid, 0), { code: 'ERR_PIDFD_PID' })
    } finally { binding.close(token) }
  })

async function ownedStoppedFixture(injectFirstReadFailure = false) {
    const { binding } = await loadPidfdBinding() // Missing prerequisites fail before any child.
    const deadlineAt = Date.now() + 8000
    // Deliberately fixed normal-UID child: reports its inherited pidfds, then
    // stops itself. The owner addon never offers SIGSTOP or arbitrary signals.
    const source = `import { readdirSync, readlinkSync } from 'node:fs';
      const pidfds = readdirSync('/proc/self/fd').filter(name => {
        try { return readlinkSync('/proc/self/fd/' + name) === 'anon_inode:[pidfd]' } catch { return false }
      }); console.log(JSON.stringify({ pid: process.pid, pidfds }));
      const timer = setTimeout(() => { process.exitCode = 125; process.stdin.destroy(); }, 2000);
      process.stdin.once('end', () => { clearTimeout(timer); process.exitCode = 125; });
      process.stdin.once('data', data => { clearTimeout(timer);
        if (data.toString() !== 'G') { process.exitCode = 125; process.stdin.destroy(); return; }
        process.kill(process.pid, 'SIGSTOP'); });`
    const self = await readLinuxProcessIdentity(process.pid)
    const inheritedToken = await openObservedPidfd(self, { readIdentity: readLinuxProcessIdentity, deadlineAt })
    let child, expected, birthToken, closed = false, code, terminationSignal, stdout = '', primaryError
    const injected = new Error('controlled first identity read failed')
    let containmentSent = false, closeObserved = false, terminalObservation
    try {
      child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
      // Root-approved birth rule: this DIRECT child cannot be reaped by libuv
      // before yielding. No await/callback/lookup before this synchronous open.
      try {
        assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
        birthToken = binding.open(child.pid)
        expected = readAuthorityIdentitySync(child.pid)
        assert.equal(expected.ppid, process.pid); assert.ok(liveIdentity(expected))
      } finally {
        child.once('close', (exitCode, exitSignal) => { closed = true; closeObserved = true; code = exitCode; terminationSignal = exitSignal })
        child.once('error', (error) => { primaryError ??= error })
        child.stdin.on('error', (error) => { if (!closed) primaryError ??= error })
        child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 4096) primaryError ??= new Error('Fixture output exceeded bound') })
        child.stderr.resume()
      }
      if (injectFirstReadFailure) throw injected
      const verified = await readLinuxProcessIdentity(expected.pid)
      assert.equal(identityKey(verified), identityKey(expected)); assert.equal(verified.ppid, process.pid)
      assert.ok(liveIdentity(verified), 'Actual spawned identity must be rechecked before ACK')
      child.stdin.write('G')
      const stopped = await until(async () => {
        const current = await readLinuxProcessIdentity(expected.pid)
        return current?.starttime === expected.starttime && ['T', 't'].includes(current.state) && current
      }, deadlineAt - 3000)
      assert.ok(stopped)
      await until(() => stdout.includes('\n'), deadlineAt - 3000)
      const facts = JSON.parse(stdout)
      assert.equal(facts.pid, expected.pid); assert.deepEqual(facts.pidfds, [], 'CLOEXEC pidfd leaked into child exec')
      binding.signal(birthToken, 'SIGKILL'); containmentSent = true
      assert.equal(closed, false, 'Signal result cannot substitute for close')
    } catch (error) { primaryError ??= error }
    finally {
      try {
        if (birthToken && !closed) { binding.signal(birthToken, 'SIGKILL'); containmentSent = true }
        else if (child && !closed) child.stdin.end() // Gated EOF exits without ACK if open failed.
        await until(() => closed, deadlineAt)
        if (expected) terminalObservation = await until(async () => {
          const value = await readLinuxProcessIdentity(expected.pid)
          return !value ? 'absent' : value.starttime !== expected.starttime ? 'pid-recycled'
            : ['Z', 'X', 'x'].includes(value.state) && value.state
        }, deadlineAt)
      } catch (error) { primaryError ??= error }
      if (birthToken) binding.close(birthToken)
      inheritedToken.close()
    }
    if (injectFirstReadFailure) assert.equal(primaryError, injected)
    else if (primaryError) throw primaryError
    assert.ok(expected && terminalObservation)
    assert.equal(containmentSent, true); assert.equal(closeObserved, true)
    assert.equal(code, null); assert.equal(terminationSignal, 'SIGKILL')
    assert.ok(await readFile('/proc/self/status', 'utf8'))
}

test('real native pidfd is CLOEXEC and contains a gated self-stopped child with observed close and terminality',
  { skip: process.platform !== 'linux', timeout: 10_000 }, () => ownedStoppedFixture())

test('direct-child birth pidfd contains a failed first lookup without releasing the fixture gate',
  { skip: process.platform !== 'linux', timeout: 10_000 }, () => ownedStoppedFixture(true))
