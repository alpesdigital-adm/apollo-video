import assert from 'node:assert/strict'
import test from 'node:test'
import { stat } from 'node:fs/promises'
import { createWorld, startOpsSimulator } from '../fixtures/host-safety/fake-docker/harness.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
test('world cleanup drains one blocked publisher before removing files and permits no overlapping ticks', { timeout: 10_000 }, async (t) => {
  const world = await createWorld(t)
  let enter, release, calls = 0
  const entered = new Promise((resolve) => { enter = resolve })
  const blocked = new Promise((resolve) => { release = resolve })
  t.signal.addEventListener('abort', () => release(), { once: true })
  t.after(() => release())
  const { simulator } = await startOpsSimulator(t, world, { closeWhen: async () => {
    calls += 1
    if (calls > 1) { enter(); await blocked }
    return false
  } })
  try {
    await entered
    await delay(450)
    assert.equal(calls, 2, 'timer cannot overlap the blocked tick')
    let cleaned = false
    const cleanup = world.cleanup().then(() => { cleaned = true })
    await delay(20)
    assert.equal(cleaned, false)
    assert.ok(await stat(world.directory))
    release()
    await cleanup
    assert.equal(await stat(world.directory).catch(() => null), null)
    const finalSeq = simulator.seq
    await delay(250)
    assert.equal(simulator.seq, finalSeq)
    assert.equal(calls, 2)
  } finally { release() }
})

test('publisher failure closes timer, is reported by cleanup, and still removes owned directory', { timeout: 10_000 }, async () => {
  const world = await createWorld({ after() {} })
  const failure = new Error('controlled publisher failure')
  let calls = 0, enter
  const entered = new Promise((resolve) => { enter = resolve })
  try {
    await startOpsSimulator(null, world, { closeWhen: async () => {
      if (++calls > 1) { enter(); throw failure }
      return false
    } })
    await entered
    await assert.rejects(world.cleanup(), (error) => error instanceof AggregateError && error.errors.includes(failure))
    assert.equal(await stat(world.directory).catch(() => null), null)
    await delay(250)
    assert.equal(calls, 2)
  } finally { await world.cleanup().catch(() => {}) }
})
