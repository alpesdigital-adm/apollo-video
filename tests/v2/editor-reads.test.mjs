import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyReadFailure,
  createEditorReads,
  parseRetryAfter,
  RATE_LIMIT_FALLBACK_WAIT_MS,
} from '../../src/app/_operator/editor-reads.ts'

/**
 * The editor page's transport, driven against a fake network and a fake clock.
 *
 * Every test here is a defect the live page had: a late answer overwriting a
 * fresh one, the same read issued twice in one frame, a 429 answered with more
 * requests, and polling rounds stacking on top of a slow one. None of them can
 * be caught by reading the source — they only appear when two things happen in
 * the wrong order — so nothing here greps a file.
 *
 * No real timer is ever armed and no socket is ever opened: the clock is
 * stepped by hand, which is also the only way to assert "did not ask again
 * before the server said so" without spending the wait.
 */

/** A clock whose time only moves when a test moves it. */
function createClock(start = 1_700_000_000_000) {
  let now = start
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (handler, timeoutMs) => {
      const id = nextId++
      timers.set(id, { at: now + timeoutMs, handler })
      return id
    },
    clearTimeout: (id) => { timers.delete(id) },
    pending: () => timers.size,
    /** Moves time forward, firing what falls due, letting each round settle. */
    advance: async (ms) => {
      const target = now + ms
      for (;;) {
        let dueId
        let due
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === undefined || timer.at < due.at)) {
            dueId = id
            due = timer
          }
        }
        if (due === undefined) break
        timers.delete(dueId)
        now = due.at
        due.handler()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

/** Lets already-resolved promises and their continuations run. */
async function flush(turns = 12) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: new Headers(headers),
    json: async () => body,
  }
}

/** A transport that records what it was asked and answers from a script. */
function createFakeFetch(answer) {
  const calls = []
  const fetch = async (url, init) => {
    const call = { url, init, signal: init.signal }
    calls.push(call)
    return answer(call, calls.length)
  }
  return { fetch, calls }
}

function createReads({ answer, hidden = () => false, clock = createClock() }) {
  const transport = createFakeFetch(answer)
  const reads = createEditorReads({
    fetch: transport.fetch,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    isDocumentHidden: hidden,
  })
  reads.setScope({ projectId: 'prj-1', versionId: 'ver-1', sessionEpoch: 1 })
  return { reads, transport, clock }
}

const WORKSPACE = { name: 'workspace', url: '/v1/projects/prj-1/workspace' }

test('parseRetryAfter reads delta-seconds, HTTP-dates and refuses the rest', () => {
  const now = Date.parse('Mon, 01 Sep 2026 12:00:00 GMT')
  assert.equal(parseRetryAfter('3', now), 3_000)
  assert.equal(parseRetryAfter(' 120 ', now), 120_000)
  assert.equal(parseRetryAfter('Mon, 01 Sep 2026 12:00:30 GMT', now), 30_000)
  // A date the server says has already passed is a wait of zero, which is not
  // the same answer as "no header at all".
  assert.equal(parseRetryAfter('Mon, 01 Sep 2026 11:59:00 GMT', now), 0)
  assert.equal(parseRetryAfter(null, now), undefined)
  assert.equal(parseRetryAfter('', now), undefined)
  assert.equal(parseRetryAfter('-5', now), undefined)
  assert.equal(parseRetryAfter('3.5', now), undefined)
  assert.equal(parseRetryAfter('soon', now), undefined)
})

test('classifyReadFailure names the refusal and keeps the 409 code', () => {
  const now = 1_000
  const conflict = classifyReadFailure(
    409,
    { error: { code: 'PERSISTENCE_CONFLICT', requestId: 'req-9' } },
    new Headers(),
    now,
  )
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.code, 'PERSISTENCE_CONFLICT')
  assert.equal(conflict.requestId, 'req-9')
  assert.match(conflict.message, /recarregue/i)

  const repeated = classifyReadFailure(409, { error: { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' } }, new Headers(), now)
  assert.equal(repeated.kind, 'conflict')
  assert.notEqual(repeated.message, conflict.message)

  assert.equal(classifyReadFailure(401, { error: { code: 'AUTH_INVALID' } }, new Headers(), now).kind, 'auth')
  assert.equal(classifyReadFailure(403, { error: { code: 'AUTH_SCOPE_REQUIRED' } }, new Headers(), now).kind, 'forbidden')
  assert.equal(classifyReadFailure(404, undefined, new Headers(), now).kind, 'not-found')
  assert.equal(classifyReadFailure(500, undefined, new Headers(), now).kind, 'error')

  const limited = classifyReadFailure(
    429,
    { error: { code: 'REQUEST_RATE_ANOMALY' } },
    new Headers({ 'retry-after': '7' }),
    now,
  )
  assert.equal(limited.kind, 'rate-limited')
  assert.equal(limited.retryAfterMs, 7_000)
})

test('classifyReadFailure never puts a credential on screen', () => {
  const leaky = classifyReadFailure(
    401,
    { error: { code: 'AUTH_INVALID', message: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 rejeitado' } },
    new Headers(),
    0,
  )
  assert.equal(leaky.kind, 'auth')
  assert.ok(!leaky.message.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'))
  assert.ok(!/bearer/i.test(leaky.message))

  const html = classifyReadFailure(502, { error: { message: '<html><body>gateway</body></html>' } }, new Headers(), 0)
  assert.ok(!html.message.includes('<'))
  assert.match(html.message, /502/)
})

test('the same read in flight is one request and one promise', async () => {
  const { reads, transport } = createReads({
    answer: () => jsonResponse(200, { data: { version: 'ver-1' } }),
  })
  const first = reads.read(WORKSPACE)
  const second = reads.read(WORKSPACE)
  assert.equal(first, second, 'the second caller must get the promise already in flight')
  const [a, b] = await Promise.all([first, second])
  assert.equal(transport.calls.length, 1)
  assert.deepEqual(a, { ok: true, data: { version: 'ver-1' } })
  assert.equal(a, b)
  assert.deepEqual(reads.snapshot().workspace, { issued: 1, deduplicated: 1, dropped: 0 })
})

test('different reads are different requests', async () => {
  const { reads, transport } = createReads({
    answer: () => jsonResponse(200, { data: {} }),
  })
  await Promise.all([
    reads.read(WORKSPACE),
    reads.read({ name: 'review', url: '/v1/projects/prj-1/annotations?limit=50', query: 'limit=50' }),
    reads.read({ name: 'review', url: '/v1/projects/prj-1/annotations?limit=10', query: 'limit=10' }),
  ])
  assert.equal(transport.calls.length, 3)
  assert.equal(reads.snapshot().review.issued, 2)
  assert.equal(reads.snapshot().review.deduplicated, 0)
})

test('an answer that arrives after the scope changed is dropped', async () => {
  const slow = deferred()
  const { reads, transport } = createReads({
    answer: (call, index) => (index === 1 ? slow.promise : jsonResponse(200, { data: { version: 'ver-2' } })),
  })
  const stale = reads.read(WORKSPACE)
  reads.setScope({ projectId: 'prj-1', versionId: 'ver-2', sessionEpoch: 1 })
  const fresh = await reads.read(WORKSPACE)
  assert.deepEqual(fresh, { ok: true, data: { version: 'ver-2' } })

  // The transport ignores the abort and answers anyway — the guard is the
  // scope the read was issued under, not the signal.
  slow.resolve(jsonResponse(200, { data: { version: 'ver-1' } }))
  const late = await stale
  assert.equal(late.ok, false)
  assert.equal(late.failure.dropped, true)
  assert.equal(reads.snapshot().workspace.dropped, 1)
  assert.equal(reads.snapshot().workspace.issued, 2)
  assert.equal(transport.calls[0].signal.aborted, true)
})

test('abortAll aborts what is in flight', async () => {
  const pending = deferred()
  const { reads, transport } = createReads({ answer: () => pending.promise })
  const inFlight = reads.read(WORKSPACE)
  assert.equal(transport.calls[0].signal.aborted, false)
  reads.abortAll()
  assert.equal(transport.calls[0].signal.aborted, true)
  pending.resolve(jsonResponse(200, { data: {} }))
  const result = await inFlight
  assert.equal(result.ok, false)
  assert.equal(result.failure.dropped, true)
})

test('a 429 with Retry-After: 3 is not asked again inside those three seconds', async () => {
  const clock = createClock()
  const { reads, transport } = createReads({
    clock,
    answer: () => jsonResponse(429, { error: { code: 'REQUEST_RATE_ANOMALY' } }, { 'retry-after': '3' }),
  })
  const first = await reads.read(WORKSPACE)
  assert.equal(first.ok, false)
  assert.equal(first.failure.kind, 'rate-limited')
  assert.equal(first.failure.retryAfterMs, 3_000)
  assert.equal(transport.calls.length, 1)

  await clock.advance(1_000)
  const tooSoon = await reads.read(WORKSPACE)
  assert.equal(transport.calls.length, 1, 'the page must not ask again inside the wait it was given')
  assert.equal(tooSoon.failure.kind, 'rate-limited')
  assert.equal(tooSoon.failure.retryAfterMs, 2_000, 'the remaining wait, never shortened')

  await clock.advance(2_000)
  await reads.read(WORKSPACE)
  assert.equal(transport.calls.length, 2)
})

test('a 429 dated in the future waits until that date', async () => {
  const clock = createClock()
  const at = new Date(clock.now() + 45_000).toUTCString()
  const { reads, transport } = createReads({
    clock,
    answer: () => jsonResponse(429, { error: { code: 'GOVERNANCE_LIMIT_EXCEEDED' } }, { 'retry-after': at }),
  })
  const first = await reads.read(WORKSPACE)
  assert.equal(first.failure.kind, 'rate-limited')
  assert.ok(first.failure.retryAfterMs >= 44_000 && first.failure.retryAfterMs <= 45_000)
  await clock.advance(30_000)
  await reads.read(WORKSPACE)
  assert.equal(transport.calls.length, 1)
  await clock.advance(16_000)
  await reads.read(WORKSPACE)
  assert.equal(transport.calls.length, 2)
})

test('a 429 without a usable Retry-After falls back to the named constant', async () => {
  const clock = createClock()
  const { reads, transport } = createReads({
    clock,
    answer: () => jsonResponse(429, { error: { code: 'REQUEST_RATE_ANOMALY' } }, { 'retry-after': 'quando der' }),
  })
  const first = await reads.read(WORKSPACE)
  assert.equal(first.failure.retryAfterMs, RATE_LIMIT_FALLBACK_WAIT_MS)
  await clock.advance(RATE_LIMIT_FALLBACK_WAIT_MS - 1)
  await reads.read(WORKSPACE)
  assert.equal(transport.calls.length, 1)
  await clock.advance(1)
  await reads.read(WORKSPACE)
  assert.equal(transport.calls.length, 2)
})

test('the fallback is used only when the server named no wait', async () => {
  const clock = createClock()
  const { reads } = createReads({
    clock,
    answer: () => jsonResponse(429, {}, { 'retry-after': '60' }),
  })
  const first = await reads.read(WORKSPACE)
  assert.equal(first.failure.retryAfterMs, 60_000)
  assert.notEqual(first.failure.retryAfterMs, RATE_LIMIT_FALLBACK_WAIT_MS)
})

test('a 401 closes the coordinator and later reads never reach the network', async () => {
  const { reads, transport } = createReads({
    answer: () => jsonResponse(401, { error: { code: 'AUTH_INVALID', requestId: 'req-401' } }),
  })
  const first = await reads.read(WORKSPACE)
  assert.equal(first.ok, false)
  assert.equal(first.failure.kind, 'auth')
  assert.equal(first.failure.requestId, 'req-401')

  const afterwards = await reads.read({ name: 'review', url: '/v1/projects/prj-1/annotations' })
  assert.equal(afterwards.ok, false)
  assert.equal(afterwards.failure.kind, 'auth')
  assert.equal(transport.calls.length, 1, 'a closed coordinator asks nothing more')
})

test('403 and 409 are returned and never retried on their own', async () => {
  const { reads, transport } = createReads({
    answer: (call, index) => (index === 1
      ? jsonResponse(403, { error: { code: 'AUTH_SCOPE_REQUIRED' } })
      : jsonResponse(409, { error: { code: 'PERSISTENCE_CONFLICT' } })),
  })
  const forbidden = await reads.read(WORKSPACE)
  assert.equal(forbidden.failure.kind, 'forbidden')
  const conflict = await reads.read({ name: 'timeline', url: '/v1/projects/prj-1/timeline' })
  assert.equal(conflict.failure.kind, 'conflict')
  assert.equal(conflict.failure.code, 'PERSISTENCE_CONFLICT')
  assert.equal(transport.calls.length, 2, 'two reads, two requests — no retry of its own')
})

test('read() refuses anything that is not a GET', () => {
  const { reads, transport } = createReads({ answer: () => jsonResponse(200, { data: {} }) })
  assert.throws(
    () => reads.read({ name: 'commit', url: '/v1/projects/prj-1/commands', method: 'POST' }),
    /GET/,
  )
  assert.equal(transport.calls.length, 0)
})

test('a round slower than the interval never overlaps itself', async () => {
  const clock = createClock()
  const { reads } = createReads({ clock, answer: () => jsonResponse(200, { data: {} }) })
  let starts = 0
  let finishes = 0
  let gate = deferred()
  const handle = reads.poll(async () => {
    starts += 1
    await gate.promise
    finishes += 1
  }, { intervalMs: 2_500, isTerminal: () => false })

  await clock.advance(2_500)
  assert.equal(starts, 1)
  await clock.advance(10_000)
  assert.equal(starts, 1, 'the clock kept moving; the round had not finished')
  assert.equal(finishes, 0)

  const first = gate
  gate = deferred()
  first.resolve()
  await flush()
  assert.equal(finishes, 1)
  assert.equal(starts, 1, 'the next round waits for its own interval')

  await clock.advance(2_500)
  assert.equal(starts, 2)
  gate.resolve()
  await flush()
  handle.stop()
  assert.equal(clock.pending(), 0, 'stop() leaves no timer armed')
})

test('poll stops at the terminal state and arms no further timer', async () => {
  const clock = createClock()
  const { reads } = createReads({ clock, answer: () => jsonResponse(200, { data: {} }) })
  let rounds = 0
  let terminal = false
  reads.poll(async () => {
    rounds += 1
    if (rounds === 2) terminal = true
  }, { intervalMs: 1_000, isTerminal: () => terminal })

  await clock.advance(5_000)
  assert.equal(rounds, 2)
  assert.equal(clock.pending(), 0, 'a finished operation leaves nothing polling')
})

test('poll goes quiet while the tab is hidden and comes back with it', async () => {
  const clock = createClock()
  let hidden = false
  const { reads } = createReads({ clock, hidden: () => hidden, answer: () => jsonResponse(200, { data: {} }) })
  let rounds = 0
  const handle = reads.poll(async () => { rounds += 1 }, { intervalMs: 1_000, isTerminal: () => false })

  await clock.advance(1_000)
  assert.equal(rounds, 1)
  hidden = true
  await clock.advance(5_000)
  assert.equal(rounds, 1, 'a hidden tab asks nothing')
  assert.equal(clock.pending(), 1, 'but it keeps its place in the queue')
  hidden = false
  await clock.advance(1_000)
  assert.equal(rounds, 2, 'and resumes on the next tick after coming back')
  handle.stop()
})

test('poll stops once a 401 has closed the coordinator', async () => {
  const clock = createClock()
  const { reads } = createReads({
    clock,
    answer: () => jsonResponse(401, { error: { code: 'AUTH_INVALID' } }),
  })
  let rounds = 0
  reads.poll(async () => {
    rounds += 1
    await reads.read(WORKSPACE)
  }, { intervalMs: 1_000, isTerminal: () => false })

  await clock.advance(4_000)
  assert.equal(rounds, 1, 'the round that met the 401 is the last one')
  assert.equal(clock.pending(), 0)
})

test('abortAll stops the polls the page had running', async () => {
  const clock = createClock()
  const { reads } = createReads({ clock, answer: () => jsonResponse(200, { data: {} }) })
  let rounds = 0
  reads.poll(async () => { rounds += 1 }, { intervalMs: 1_000, isTerminal: () => false })
  await clock.advance(1_000)
  assert.equal(rounds, 1)
  reads.abortAll()
  assert.equal(clock.pending(), 0)
  await clock.advance(10_000)
  assert.equal(rounds, 1)
})

test('snapshot counts each read by name and copies what it hands out', async () => {
  const { reads } = createReads({ answer: () => jsonResponse(200, { data: {} }) })
  await Promise.all([reads.read(WORKSPACE), reads.read(WORKSPACE)])
  const first = reads.snapshot()
  first.workspace.issued = 99
  assert.equal(reads.snapshot().workspace.issued, 1)
  assert.deepEqual(reads.snapshot(), { workspace: { issued: 1, deduplicated: 1, dropped: 0 } })
})
