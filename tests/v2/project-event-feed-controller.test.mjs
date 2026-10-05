import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROJECT_EVENT_FEED_POLICY,
  createProjectEventFeedController,
  projectEventFeedBackoffMs,
} from '../../src/v2/ui/project-event-feed-controller.ts'

/** Deterministic clock, visibility and transport: no real timers or network. */
function harness(script) {
  let now = 0
  let nextHandle = 1
  const timers = new Map()
  const visibilityListeners = new Set()
  const state = {
    visible: true, reads: [], relevant: 0, unauthorized: 0, stopped: [],
    aborted: 0, pending: [],
  }
  const controller = createProjectEventFeedController({
    transport: {
      read(input) {
        state.reads.push({ at: now, after: input.after })
        const next = script.shift()
        if (next === 'hang') {
          return new Promise((resolve, reject) => {
            input.signal.addEventListener('abort', () => {
              state.aborted += 1
              reject(new DOMException('aborted', 'AbortError'))
            })
            state.pending.push(resolve)
          })
        }
        return Promise.resolve(next ?? { kind: 'error' })
      },
    },
    onRelevantEvent: () => { state.relevant += 1 },
    onUnauthorized: () => { state.unauthorized += 1 },
    onStopped: (reason) => state.stopped.push(reason),
    setTimer(callback, delay) {
      const handle = nextHandle++
      timers.set(handle, { at: now + delay, callback })
      return handle
    },
    clearTimer(handle) { timers.delete(handle) },
    isVisible: () => state.visible,
    subscribeVisibility(callback) {
      visibilityListeners.add(callback)
      return () => visibilityListeners.delete(callback)
    },
  })
  async function settle() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }
  return {
    state, controller, timers,
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].callback()
        await settle()
      }
      now = target
      await settle()
    },
    async setVisible(visible) {
      state.visible = visible
      for (const listener of [...visibilityListeners]) listener()
      await settle()
    },
    listeners: visibilityListeners,
    async start() { controller.start(); await settle() },
  }
}

const page = (types = [], cursor = 'cursor-1', hasMore = false) =>
  ({ kind: 'page', eventTypes: types, nextCursor: cursor, hasMore })

test('F1.001 feed poller starts at the head, never refetches for history and polls on a fixed interval', async () => {
  const world = harness([page([], 'c1'), page([], 'c2'), page([], 'c3'), page([], 'c4')])
  await world.start()
  assert.deepEqual(world.state.reads.map((read) => read.after), [undefined])
  await world.advance(PROJECT_EVENT_FEED_POLICY.intervalMs * 3)
  assert.deepEqual(world.state.reads.map((read) => read.at), [0, 4000, 8000, 12000])
  assert.deepEqual(world.state.reads.map((read) => read.after), [undefined, 'c1', 'c2', 'c3'])
  assert.equal(world.state.relevant, 0)
  world.controller.stop()
})

test('F1.001 feed poller invalidates only for relevant project events after bootstrap', async () => {
  const world = harness([
    page(['project.name.changed'], 'c1'), // bootstrap page: history must be ignored
    page(['operation.succeeded', 'annotation.created'], 'c2'),
    page(['operation.succeeded', 'project.status.changed'], 'c3'),
    page([], 'c4'),
  ])
  await world.start()
  await world.advance(4000)
  assert.equal(world.state.relevant, 1)
  await world.advance(4000)
  assert.equal(world.state.relevant, 2)
  await world.advance(4000)
  assert.equal(world.state.relevant, 2)
  world.controller.stop()
})

test('F1.001 full pages are drained quickly without extra invalidations per page', async () => {
  const world = harness([page([], 'c0'), page(['project.created'], 'c1', true), page(['project.created'], 'c2', false)])
  await world.start()
  await world.advance(4000)
  await world.advance(PROJECT_EVENT_FEED_POLICY.continuationDelayMs)
  assert.deepEqual(world.state.reads.map((read) => read.at), [0, 4000, 4250])
  assert.equal(world.state.relevant, 2)
  world.controller.stop()
})

test('F1.001 feed poller backs off exponentially, is capped and stops after the failure limit', async () => {
  const policy = PROJECT_EVENT_FEED_POLICY
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((failures) => projectEventFeedBackoffMs(failures)),
    [8000, 16000, 30000, 30000, 30000],
  )
  const world = harness([{ kind: 'error' }, { kind: 'error' }, { kind: 'error' }, { kind: 'error' }, page([], 'late')])
  await world.start()
  await world.advance(10 * 60_000)
  assert.deepEqual(world.state.reads.map((read) => read.at), [0, 8000, 24000, 54000])
  assert.equal(world.state.reads.length, policy.maxConsecutiveFailures)
  assert.deepEqual(world.state.stopped, ['retry-limit'])
  assert.equal(world.timers.size, 0, 'no timer survives the retry limit')
  assert.equal(world.state.relevant, 0)
  world.controller.stop()
})

test('F1.001 a success resets the failure budget and a thrown transport counts as a failure', async () => {
  const world = harness([{ kind: 'error' }, page([], 'c1'), { kind: 'error' }, { kind: 'error' }, page([], 'c2')])
  await world.start()
  await world.advance(8000 + 4000 + 8000 + 16000)
  assert.deepEqual(world.state.reads.map((read) => read.at), [0, 8000, 12000, 20000, 36000])
  assert.deepEqual(world.state.stopped, [])
  world.controller.stop()
})

test('F1.001 unauthorized stops for good and asks for the login redirect once', async () => {
  const world = harness([page([], 'c1'), { kind: 'unauthorized' }, page([], 'never')])
  await world.start()
  await world.advance(60_000)
  assert.equal(world.state.unauthorized, 1)
  assert.deepEqual(world.state.stopped, ['unauthorized'])
  assert.equal(world.state.reads.length, 2)
})

test('F1.001 a rejected cursor re-bootstraps from the head and refetches once', async () => {
  const world = harness([page([], 'c1'), { kind: 'cursor-rejected' }, page([], 'c2'), page([], 'c3')])
  await world.start()
  await world.advance(4000)
  assert.equal(world.state.relevant, 1)
  await world.advance(4000)
  assert.deepEqual(world.state.reads.map((read) => read.after), [undefined, 'c1', undefined])
  await world.advance(4000)
  assert.equal(world.state.relevant, 1)
  world.controller.stop()
})

test('F1.001 a rejected bootstrap is a failure, not a refetch loop', async () => {
  const world = harness([{ kind: 'cursor-rejected' }, { kind: 'cursor-rejected' }, { kind: 'cursor-rejected' }, { kind: 'cursor-rejected' }])
  await world.start()
  await world.advance(5 * 60_000)
  assert.equal(world.state.relevant, 0)
  assert.deepEqual(world.state.stopped, ['retry-limit'])
})

test('F1.001 hidden tabs stop polling and abort the in-flight read; returning resumes with the kept cursor', async () => {
  const world = harness([page([], 'c1'), 'hang', page(['project.name.changed'], 'c2')])
  await world.start()
  await world.advance(4000)
  assert.equal(world.state.reads.length, 2)
  await world.setVisible(false)
  assert.equal(world.state.aborted, 1)
  assert.equal(world.timers.size, 0)
  await world.advance(60_000)
  assert.equal(world.state.reads.length, 2, 'no request while hidden')
  await world.setVisible(true)
  assert.equal(world.state.reads.length, 3)
  assert.equal(world.state.reads[2].after, 'c1')
  assert.equal(world.state.relevant, 1, 'what happened while hidden is delivered on return')
  world.controller.stop()
})

test('F1.001 unmount stops timers, in-flight reads and the visibility subscription', async () => {
  const world = harness([page([], 'c1'), 'hang'])
  await world.start()
  await world.advance(4000)
  assert.equal(world.listeners.size, 1)
  world.controller.stop()
  assert.equal(world.state.aborted, 1)
  assert.equal(world.timers.size, 0)
  assert.equal(world.listeners.size, 0)
  await world.advance(5 * 60_000)
  assert.equal(world.state.reads.length, 2)
  assert.equal(world.state.relevant, 0)
})

test('F1.001 a stale in-flight read never invalidates after stop', async () => {
  const world = harness(['hang'])
  await world.start()
  world.controller.stop()
  for (const resolve of world.state.pending) resolve(page(['project.name.changed'], 'late'))
  await Promise.resolve()
  assert.equal(world.state.relevant, 0)
})
