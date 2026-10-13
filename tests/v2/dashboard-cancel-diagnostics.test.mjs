import assert from 'node:assert/strict'
import test from 'node:test'
import { installDashboardCancelDiagnostics, joinDashboardCancelEvents, validateDashboardCancelSnapshot } from './helpers/dashboard-cancel-diagnostics.mjs'

const origin = 'http://127.0.0.1:3100'
const path = '/projects/controlled'
const scriptPath = '/_next/static/chunks/controlled.js'
const hash = 'a'.repeat(64)
const config = { origin, pageId: 'page-1', paths: [path], scripts: [[scriptPath, hash]] }

// Brand-checked methods let us prove that instrumentation does not inspect
// caller getters/Proxy fields or add Promise reactions. No browser or I/O.
function fixture() {
  const requests = new WeakMap(), responses = new WeakMap(), controllers = new WeakMap()
  const streams = new WeakSet(), readers = new WeakSet(), urls = new WeakMap()
  const calls = [], promise = new Promise(() => {})
  let reactions = 0, fetchFailure, cancelFailure, cloneResult, teeResult, readerResult
  for (const key of ['then', 'catch', 'finally']) Object.defineProperty(promise, key, {
    get() { reactions++; throw new Error('Promise reaction access is forbidden') }, configurable: true,
  })
  const requireBrand = (store, object) => {
    if (!store.has(object)) throw new TypeError('Native brand failure')
    return store.get ? store.get(object) : undefined
  }
  class FixtureURL {
    constructor(value, base) { urls.set(this, new URL(value, base)) }
    get href() { return requireBrand(urls, this).href }
    get pathname() { return requireBrand(urls, this).pathname }
    get origin() { return requireBrand(urls, this).origin }
  }
  class FixtureRequest {
    constructor(url, method = 'GET', signal = {}) { requests.set(this, { url, method, signal }) }
    get url() { return requireBrand(requests, this).url }
    get method() { return requireBrand(requests, this).method }
    get signal() { return requireBrand(requests, this).signal }
  }
  class FixtureStream {
    constructor() { streams.add(this) }
    tee(...args) {
      requireBrand(streams, this); calls.push({ method: 'tee', receiver: this, args })
      return teeResult ?? [new FixtureStream(), new FixtureStream()]
    }
    getReader(...args) {
      requireBrand(streams, this); calls.push({ method: 'getReader', receiver: this, args })
      return readerResult ?? new FixtureReader()
    }
    cancel(...args) {
      requireBrand(streams, this); calls.push({ method: 'streamCancel', receiver: this, args })
      if (cancelFailure) throw cancelFailure
      return promise
    }
  }
  class FixtureReader {
    constructor() { readers.add(this) }
    cancel(...args) {
      requireBrand(readers, this); calls.push({ method: 'readerCancel', receiver: this, args })
      if (cancelFailure) throw cancelFailure
      return promise
    }
  }
  class FixtureByobReader {
    constructor() { readers.add(this) }
    cancel(...args) {
      requireBrand(readers, this); calls.push({ method: 'byobCancel', receiver: this, args })
      if (cancelFailure) throw cancelFailure
      return promise
    }
  }
  class FixtureResponse {
    constructor(url = origin + path, body = new FixtureStream()) { responses.set(this, { url, body }) }
    get url() { return requireBrand(responses, this).url }
    get body() { return requireBrand(responses, this).body }
    clone(...args) {
      requireBrand(responses, this); calls.push({ method: 'clone', receiver: this, args })
      return cloneResult ?? new FixtureResponse(this.url)
    }
  }
  class FixtureController {
    constructor(signal = {}) { controllers.set(this, signal) }
    get signal() { return requireBrand(controllers, this) }
    abort(...args) { requireBrand(controllers, this); calls.push({ method: 'abort', receiver: this, args }); return undefined }
  }
  class FixtureError extends Error {
    constructor(message) {
      super(message)
      this.stack = `Error\n at callback (${origin}${scriptPath}?secret=forbidden#fragment:20:3)\n` +
        ` at ignored (${origin}/private/file.js?token=forbidden:1:1)\n` +
        ` at foreign (https://foreign.invalid/_next/static/chunk.js:1:1)`
    }
  }
  const target = { URL: FixtureURL, Request: FixtureRequest, Response: FixtureResponse,
    ReadableStream: FixtureStream, ReadableStreamDefaultReader: FixtureReader, ReadableStreamBYOBReader: FixtureByobReader,
    AbortController: FixtureController, Error: FixtureError, TextEncoder, TextDecoder,
    performance: { timeOrigin: 1000, now: () => 100 },
    fetch(...args) { calls.push({ method: 'fetch', receiver: this, args }); if (fetchFailure) throw fetchFailure; return promise },
  }
  const holders = [[target, 'fetch'], [FixtureController.prototype, 'abort'], [FixtureResponse.prototype, 'body'],
    [FixtureResponse.prototype, 'clone'], [FixtureStream.prototype, 'tee'], [FixtureStream.prototype, 'getReader'],
    [FixtureStream.prototype, 'cancel'], [FixtureReader.prototype, 'cancel'], [FixtureByobReader.prototype, 'cancel']]
  const originals = holders.map(([holder, key]) => Object.getOwnPropertyDescriptor(holder, key))
  return { target, calls, promise, holders, originals, reactions: () => reactions,
    failFetch: (value) => { fetchFailure = value }, failCancel: (value) => { cancelFailure = value },
    results: (clone, tee, reader) => { cloneResult = clone; teeResult = tee; readerResult = reader } }
}

function withFixture(action) {
  const value = fixture(), control = installDashboardCancelDiagnostics(config, value.target)
  try { action(value, control) } finally { control.restore() }
}

test('cancel diagnostics preserve fetch Promise/receiver/arguments without init or Proxy inspection', () => {
  withFixture((value, control) => {
    let inspected = 0
    const init = new Proxy({}, { get() { inspected++; throw new Error('Unexpected init access') },
      getOwnPropertyDescriptor() { inspected++; throw new Error('Unexpected descriptor access') } })
    const receiver = {}, result = Reflect.apply(value.target.fetch, receiver, [origin + path + '?private=1', init])
    assert.equal(result, value.promise); assert.equal(value.reactions(), 0); assert.equal(inspected, 0)
    assert.equal(value.calls.length, 1); assert.equal(value.calls[0].receiver, receiver)
    assert.equal(value.calls[0].args[1], init)
    const snapshot = validateDashboardCancelSnapshot(control.drain(), 'page-1', new Set([path]), new Map(config.scripts))
    assert.equal(snapshot.events[0].path, path); assert.equal(snapshot.events[0].method, null)
    assert.equal(snapshot.events[0].promiseObserved, false); assert.equal(snapshot.events[0].initInspected, false)
    assert.equal(JSON.stringify(snapshot).includes('private=1'), false)
    assert.deepEqual(snapshot.events[0].stack, [{ scriptPath, line: 20, column: 3, scriptSha256: hash,
      sourceBinding: 'exact-frozen-manifest-path' }])
    let inputAccess = 0
    const input = new Proxy({}, { get() { inputAccess++; throw new Error('Unexpected input access') },
      getOwnPropertyDescriptor() { inputAccess++; throw new Error('Unexpected input descriptor access') } })
    assert.equal(value.target.fetch(input, init), result)
    assert.equal(inputAccess, 0); assert.equal(inspected, 0); assert.equal(value.reactions(), 0)
    assert.deepEqual(control.drain().errors, [{ kind: 'FETCH_INPUT_UNOBSERVABLE' }])
  })
})

test('fetch errors are rethrown by identity without observing a rejection', () => {
  withFixture((value, control) => {
    const failure = new TypeError('Controlled original failure'); value.failFetch(failure)
    assert.throws(() => value.target.fetch(origin + path), (error) => error === failure)
    assert.equal(value.calls.length, 1); assert.equal(value.reactions(), 0)
    assert.equal(control.drain().events[0].kind, 'fetch-throw')
  })
})

test('native Request signal reference associates abort without reading its reason', () => {
  withFixture((value, control) => {
    const signal = {}, controller = new value.target.AbortController(signal)
    const request = new value.target.Request(origin + path, 'POST', signal)
    value.target.fetch(request)
    const reason = new Proxy({}, { get() { throw new Error('Reason must not be inspected') } })
    assert.equal(controller.abort(reason), undefined)
    const events = control.drain().events
    assert.equal(events[0].method, 'POST'); assert.equal(events[1].signalId, events[0].signalId)
    assert.deepEqual(events[1].fetchIds, [events[0].fetchId]); assert.equal(events[1].association, 'native-request-signal')
    assert.equal(value.calls[1].receiver, controller); assert.equal(value.calls[1].args[0], reason)
  })
})

test('opaque Request init overrides leave effective method/signal unknown without extra Proxy reads', () => {
  const value = fixture(), original = value.target.fetch, reads = []
  const requestSignal = {}, effectiveSignal = {}, inputController = new value.target.AbortController(requestSignal)
  const effectiveController = new value.target.AbortController(effectiveSignal)
  const request = new value.target.Request(origin + path, 'POST', requestSignal)
  const init = new Proxy({ method: 'PUT', signal: effectiveSignal }, {
    get(target, key) { reads.push(key); return Reflect.get(target, key) },
    getOwnPropertyDescriptor() { throw new Error('Observer must not inspect init descriptors') },
  })
  let nativeFacts
  value.target.fetch = function (...args) {
    // Only this controlled native behavior reads the override. Instrumentation
    // must not duplicate reads or attribute either signal without observing it.
    nativeFacts = { method: args[1].method, signal: args[1].signal }
    return Reflect.apply(original, this, args)
  }
  const control = installDashboardCancelDiagnostics(config, value.target)
  try {
    const receiver = {}
    assert.equal(Reflect.apply(value.target.fetch, receiver, [request, init]), value.promise)
    assert.deepEqual(nativeFacts, { method: 'PUT', signal: effectiveSignal })
    assert.deepEqual(reads, ['method', 'signal']); assert.equal(value.reactions(), 0)
    assert.equal(value.calls[0].receiver, receiver); assert.equal(value.calls[0].args[1], init)
    inputController.abort(); effectiveController.abort()
    const events = validateDashboardCancelSnapshot(control.drain(), 'page-1', new Set([path]), new Map(config.scripts)).events
    assert.equal(events[0].path, path); assert.match(events[0].requestId, /^request-/)
    assert.equal(events[0].method, null); assert.equal(events[0].signalId, null); assert.equal(events[0].initInspected, false)
    for (const event of events.slice(1)) { assert.deepEqual(event.fetchIds, []); assert.equal(event.association, 'unmapped') }
    value.failFetch(new TypeError('Controlled original failure'))
    assert.throws(() => value.target.fetch(request, init), /Controlled original failure/)
    assert.equal(control.drain().events[0].method, null)
    assert.deepEqual(reads, ['method', 'signal', 'method', 'signal'])
  } finally { control.restore() }
})

test('clone/body/tee/readers retain native object and Promise identities, with no native tee claim', () => {
  withFixture((value, control) => {
    const response = new value.target.Response(), clone = new value.target.Response()
    const branches = [new value.target.ReadableStream(), new value.target.ReadableStream()]
    Object.defineProperty(branches, 'map', { get() { throw new Error('Returned array methods must not be inspected') } })
    const reader = new value.target.ReadableStreamDefaultReader()
    value.results(clone, branches, reader)
    assert.equal(response.clone(), clone)
    const stream = clone.body
    assert.equal(stream.tee(), branches); assert.equal(branches[0].getReader(), reader)
    const reason = {}; assert.equal(reader.cancel(reason), value.promise)
    assert.equal(branches[1].cancel(reason), value.promise)
    assert.equal(value.reactions(), 0)
    const snapshot = validateDashboardCancelSnapshot(control.drain(), 'page-1', new Set([path]), new Map(config.scripts))
    const events = snapshot.events
    assert.equal(events[0].kind, 'response-clone'); assert.equal(events[0].nativeTeeNotObserved, true)
    assert.equal(events.every((event) => event.fetchId === null), true)
    assert.deepEqual(events.map((event) => event.kind), ['response-clone', 'response-body-reference', 'stream-tee',
      'reader-acquired', 'reader-cancel-called', 'stream-cancel-called'])
    assert.equal(events[4].readerId, events[3].readerId)
    assert.equal(events[5].streamId, events[2].branchStreamIds[1])
    const failure = new Error('Original cancel error'); value.failCancel(failure)
    assert.throws(() => reader.cancel(reason), (error) => error === failure)
    assert.equal(value.calls.filter((call) => call.method === 'readerCancel').length, 2)
  })
})

test('wrong native getter receiver keeps the original brand-check error', () => {
  withFixture((value, control) => {
    const original = value.originals[2].get, wrapped = Object.getOwnPropertyDescriptor(value.target.Response.prototype, 'body').get
    assert.throws(() => Reflect.apply(original, {}, []), { name: 'TypeError', message: 'Native brand failure' })
    assert.throws(() => Reflect.apply(wrapped, {}, []), { name: 'TypeError', message: 'Native brand failure' })
    assert.deepEqual(control.drain().events, [])
  })
})

test('BYOB reader cancellation forwards the same arguments, receiver and Promise', () => {
  withFixture((value, control) => {
    const response = new value.target.Response(), reader = new value.target.ReadableStreamBYOBReader()
    value.results(undefined, undefined, reader)
    assert.equal(response.body.getReader({ mode: 'byob' }), reader)
    const reason = {}; assert.equal(reader.cancel(reason), value.promise)
    const observed = control.drain().events
    assert.equal(observed.at(-1).kind, 'reader-cancel-called')
    const call = value.calls.find((item) => item.method === 'byobCancel')
    assert.equal(call.receiver, reader); assert.equal(call.args[0], reason); assert.equal(value.reactions(), 0)
  })
})

test('all original descriptors are restored exactly; replacement descriptors are never overwritten', () => {
  const value = fixture(), control = installDashboardCancelDiagnostics(config, value.target)
  const restored = control.restore()
  assert.equal(restored.restoredDescriptors, 9); assert.deepEqual(restored.errors, [])
  value.holders.forEach(([holder, key], index) => assert.deepEqual(Object.getOwnPropertyDescriptor(holder, key), value.originals[index]))
  assert.equal(control.restore().restoredDescriptors, 9)
  const other = fixture(), second = installDashboardCancelDiagnostics(config, other.target)
  const replacement = () => 'product replacement'
  Object.defineProperty(other.target, 'fetch', { ...Object.getOwnPropertyDescriptor(other.target, 'fetch'), value: replacement })
  const failed = second.restore()
  assert.equal(other.target.fetch, replacement); assert.equal(failed.restoredDescriptors, 8)
  assert.deepEqual(failed.errors, [{ kind: 'RESTORE_DESCRIPTOR_CHANGED' }])
})

test('partial install and duplicate install fail closed and still restore owned descriptors', () => {
  const value = fixture()
  delete value.target.ReadableStreamBYOBReader.prototype.cancel
  const control = installDashboardCancelDiagnostics(config, value.target)
  assert.deepEqual(control.drain().errors, [{ kind: 'INSTALL_FAILED' }])
  assert.throws(() => installDashboardCancelDiagnostics(config, value.target), /already present/)
  const snapshot = control.restore()
  assert.equal(snapshot.installedDescriptors, 8); assert.equal(snapshot.restoredDescriptors, 8)
  assert.equal(value.target.__apolloDashboardCancelDiagnostics, control)
})

test('the 1024 event limit persists across drains while original calls continue', () => {
  withFixture((value, control) => {
    for (let index = 0; index < 1024; index++) assert.equal(value.target.fetch(origin + path), value.promise)
    assert.equal(control.drain().events.length, 1024)
    assert.equal(value.target.fetch(origin + path), value.promise)
    assert.equal(control.drain().overflow, true); assert.equal(value.calls.length, 1025)
    assert.equal(value.reactions(), 0)
  })
})

test('stack evidence requires exact manifest paths and contains no query, fragment or arbitrary source', () => {
  const value = fixture(), control = installDashboardCancelDiagnostics({ ...config, scripts: [] }, value.target)
  try {
    value.target.fetch(origin + path)
    const snapshot = control.drain()
    assert.deepEqual(snapshot.events[0].stack, []); assert.equal(snapshot.unmappedStackFrames, 1)
    assert.equal(/forbidden|foreign|private\/file/.test(JSON.stringify(snapshot)), false)
    control.drain(['/bad?secret=1'])
    assert.deepEqual(control.drain().errors, [{ kind: 'PATH_UPDATE_INVALID' }])
  } finally { control.restore() }
})

test('stack frames obey both the 16-frame and 4 KiB limits before leaving the instrumented realm', () => {
  const value = fixture(), longPath = '/_next/static/' + 'x'.repeat(450) + '.js'
  value.target.Error = class extends Error {
    constructor() {
      super()
      this.stack = 'Error\n' + Array.from({ length: 40 }, () => ` at function (${origin}${longPath}?private=1:22:5)`).join('\n')
    }
  }
  const scripts = new Map([[longPath, hash]])
  const control = installDashboardCancelDiagnostics({ ...config, scripts: [...scripts] }, value.target)
  try {
    value.target.fetch(origin + path)
    const snapshot = validateDashboardCancelSnapshot(control.drain(), 'page-1', new Set([path]), scripts)
    assert.ok(snapshot.events[0].stack.length > 0 && snapshot.events[0].stack.length <= 16)
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.events[0].stack)) <= 4096)
    assert.equal(JSON.stringify(snapshot).includes('private=1'), false)
  } finally { control.restore() }
})

const fetchEvent = (extra = {}) => ({ kind: 'fetch-returned', pageId: 'page-1', documentTimeOrigin: 1000,
  at: 1100, path, method: 'GET', fetchId: 'fetch-promise-1', ...extra })
const network = (extra = {}) => ({ pageId: 'page-1', path, method: 'GET', wallTimeMs: 1101,
  responseWallTimeMs: 1120, cdpRequestId: 'cdp-1', loaderId: 'loader-1', ...extra })

test('CDP joins require unique candidates and remain explicitly noncausal', () => {
  const unique = joinDashboardCancelEvents([fetchEvent()], [network()])[0].join
  assert.equal(unique.state, 'unique-candidate'); assert.equal(unique.cdpRequestId, 'cdp-1')
  assert.equal(unique.cancelCausalityEstablished, false); assert.equal(unique.responseFetchIdentityEstablished, false)
  const cases = [[network(), network({ cdpRequestId: 'cdp-2' })],
    [network(), network({ wallTimeMs: 1110 })]] // Includes same-ID redirect ambiguity.
  for (const networks of cases) {
    const value = joinDashboardCancelEvents([fetchEvent()], networks)[0].join
    assert.equal(value.state, 'ambiguous'); assert.equal(value.cdpRequestId, null); assert.equal(value.candidateCount, 2)
  }
  const competing = joinDashboardCancelEvents([fetchEvent(), fetchEvent({ fetchId: 'fetch-promise-2' })], [network()])
  assert.ok(competing.every((event) => event.join.state === 'ambiguous'))
  for (const changed of [{ pageId: 'page-2' }, { method: 'POST' }, { wallTimeMs: 700 }, { path: '/other' }])
    assert.equal(joinDashboardCancelEvents([fetchEvent()], [network(changed)])[0].join.state, 'unmatched')
  assert.equal(joinDashboardCancelEvents([fetchEvent({ documentTimeOrigin: 1200 })], [network()])[0].join.state, 'unmatched')
})

test('abort and reader cancellation joins do not establish fetch/Response identity or transport cause', () => {
  const abort = { kind: 'abort-called', pageId: 'page-1', documentTimeOrigin: 1000, at: 1130,
    path: null, method: null, fetchIds: ['fetch-promise-1'] }
  const body = { kind: 'reader-cancel-called', pageId: 'page-1', documentTimeOrigin: 1000, at: 1130,
    path, method: null, fetchId: null }
  const joined = joinDashboardCancelEvents([fetchEvent(), abort, body], [network()])
  assert.equal(joined[1].join.state, 'unique-candidate'); assert.equal(joined[2].fetchId, null)
  assert.equal(joined[2].join.state, 'unique-candidate')
  assert.ok(joined.every((event) => !event.join.cancelCausalityEstablished && !event.join.responseFetchIdentityEstablished))
  const ambiguous = joinDashboardCancelEvents([fetchEvent(), fetchEvent({ fetchId: 'fetch-promise-2' }), abort], [network()])
  assert.equal(ambiguous.at(-1).join.state, 'ambiguous'); assert.equal(ambiguous.at(-1).join.cdpRequestId, null)
})

test('snapshot validation rejects extra data, unknown sources and violated bounds before persistence', () => {
  withFixture((value, control) => {
    value.target.fetch(origin + path)
    const snapshot = control.drain()
    validateDashboardCancelSnapshot(snapshot, 'page-1', new Set([path]), new Map(config.scripts))
    const changes = [
      (copy) => { copy.headers = { authorization: 'forbidden' } },
      (copy) => { copy.events[0].path = path + '?token=forbidden' },
      (copy) => { copy.events[0].stack[0].scriptSha256 = 'b'.repeat(64) },
      (copy) => { copy.events[0].stack[0].scriptPath = '/private/file.js' },
      (copy) => { copy.events[0].stack = Array(17).fill(copy.events[0].stack[0]) },
      (copy) => { copy.events[0].promiseObserved = true },
      (copy) => { copy.events[0].fetchId = 'invalid token' },
      (copy) => { copy.events[0].rawStack = 'forbidden' },
      (copy) => { copy.errors = {} },
    ]
    for (const change of changes) {
      const copy = structuredClone(snapshot); change(copy)
      assert.throws(() => validateDashboardCancelSnapshot(copy, 'page-1', new Set([path]), new Map(config.scripts)))
    }
  })
})

test('native Web API Response/stream methods preserve identity without browser or network', () => {
  const target = { URL, Request, Response, ReadableStream, ReadableStreamDefaultReader, ReadableStreamBYOBReader,
    AbortController, Error, TextEncoder, TextDecoder, performance, fetch: () => promise }
  const promise = new Promise(() => {})
  const control = installDashboardCancelDiagnostics(config, target)
  try {
    assert.equal(target.fetch(origin + path), promise)
    const response = new Response(null)
    assert.equal(response.body, null)
    const clone = response.clone()
    assert.ok(clone instanceof Response)
    // A constructed native Response has an empty URL: no invented source link.
    assert.equal(control.drain().events.some((event) => event.kind === 'response-clone'), false)
  } finally { assert.deepEqual(control.restore().errors, []) }
})
