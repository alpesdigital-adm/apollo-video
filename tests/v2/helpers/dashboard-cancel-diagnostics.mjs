import assert from 'node:assert/strict'

// Serialized by Playwright as an init script. Keep this function self-contained.
// It observes JS API calls only; no Promise reactions, body reads or cancellation.
export function installDashboardCancelDiagnostics(config, target = globalThis) {
  const apply = Reflect.apply, descriptor = Object.getOwnPropertyDescriptor
  const define = Object.defineProperty, NativeURL = target.URL, NativeError = target.Error
  const encoder = new target.TextEncoder(), decoder = new target.TextDecoder()
  const key = '__apolloDashboardCancelDiagnostics'
  if (Object.hasOwn(target, key)) throw new NativeError('Cancel diagnostic control already present')
  const patches = [], events = [], errors = []
  const refs = new WeakMap(), signals = new WeakMap(), responses = new WeakMap()
  const streams = new WeakMap(), readers = new WeakMap()
  const scripts = new Map(config.scripts), paths = new Set(config.paths)
  const clock = target.performance.timeOrigin
  let sequence = 0, identifiers = 0, disabled = false, overflow = false, unmapped = 0, unmappedStackFrames = 0, restoredDescriptors = 0
  const error = (kind) => { if (errors.length < 16) errors.push({ kind }); else overflow = true }
  const safe = (action) => { if (!disabled && !overflow) { try { return action() } catch { error('OBSERVATION_FAILED') } } }
  const id = (value, kind) => {
    if (!value || !['object', 'function'].includes(typeof value)) return null
    let existing = refs.get(value)
    if (!existing) { existing = `${kind}-${++identifiers}`; refs.set(value, existing) }
    return existing
  }
  const scoped = (value) => {
    if (typeof value !== 'string') return null
    const url = new NativeURL(value, config.origin)
    return url.origin === config.origin && paths.has(url.pathname) ? url.pathname : null
  }
  const stack = () => {
    const frames = []
    const raw = new NativeError().stack
    if (typeof raw !== 'string') { error('STACK_UNAVAILABLE'); return frames }
    const text = decoder.decode(encoder.encode(raw.slice(0, 4096)).subarray(0, 4096))
    for (const line of text.split('\n').slice(0, 17)) {
      const matched = /(https?:\/\/[^\s)]+):(\d+):(\d+)/.exec(line)
      if (!matched) continue
      const url = new NativeURL(matched[1])
      if (url.origin !== config.origin || !url.pathname.startsWith('/_next/static/') ||
          url.pathname.length > 512 || /[\\\0]/.test(url.pathname) ||
          url.pathname.split('/').some((part) => part === '.' || part === '..')) continue
      if (!scripts.has(url.pathname)) { unmappedStackFrames++; continue }
      const frame = { scriptPath: url.pathname, line: Number(matched[2]), column: Number(matched[3]),
        scriptSha256: scripts.get(url.pathname) ?? null,
        sourceBinding: scripts.has(url.pathname) ? 'exact-frozen-manifest-path' : 'unmapped' }
      if (!Number.isSafeInteger(frame.line) || !Number.isSafeInteger(frame.column)) continue
      if (frames.length === 16 || encoder.encode(JSON.stringify([...frames, frame])).length > 4096) break
      frames.push(frame)
    }
    return frames
  }
  const emit = (kind, values = {}) => {
    if (sequence === 1024) { overflow = true; return }
    events.push({ seq: ++sequence, kind, at: clock + target.performance.now(), pageId: config.pageId,
      documentTimeOrigin: clock, ...values, stack: stack() })
  }
  const get = (holder, name) => {
    const value = descriptor(holder, name)?.get
    if (typeof value !== 'function') throw new NativeError('Required native getter unavailable')
    return value
  }
  let responseURL, responseBody, requestURL, requestMethod, requestSignal, urlHref, controllerSignal
  const signalInfo = (signal) => {
    let value = signals.get(signal)
    if (!value) { value = { signalId: id(signal, 'signal'), fetchIds: [] }; signals.set(signal, value) }
    return value
  }
  const responseInfo = (response) => {
    let value = responses.get(response)
    if (value) return value
    const path = scoped(apply(responseURL, response, []))
    if (!path) return null
    value = { responseId: id(response, 'response'), path, method: null, fetchId: null }
    responses.set(response, value)
    return value
  }
  const streamInfo = (stream, response, via) => {
    if (!stream || !response) return null
    let value = streams.get(stream)
    if (!value) { value = { ...response, streamId: id(stream, 'stream'), via }; streams.set(stream, value) }
    return value
  }
  const install = (holder, name, factory, getter = false) => {
    const original = descriptor(holder, name)
    const field = getter ? 'get' : 'value'
    if (!original || typeof original[field] !== 'function') throw new NativeError('Required descriptor unavailable')
    const wrapper = factory(original[field])
    const installed = { ...original, [field]: wrapper }
    define(holder, name, installed)
    patches.push({ holder, name, original, installed })
  }
  // No observer ever calls then/catch/finally on the returned fetch Promise.
  const fetchInfo = (input, hasInit) => {
    if (typeof input === 'string') return { path: scoped(input), method: null, signal: null, requestId: null }
    if (input && ['object', 'function'].includes(typeof input)) {
      try { return { path: scoped(apply(urlHref, input, [])), method: null, signal: null, requestId: null } }
      catch { /* Native brand probe only; no user getter or coercion. */ }
      try {
        const path = scoped(apply(requestURL, input, []))
        // An opaque init may override these Request fields. The input identity
        // and URL remain observable; its method/signal are not effective facts.
        return { path, method: hasInit ? null : apply(requestMethod, input, []),
          signal: hasInit ? null : apply(requestSignal, input, []), requestId: id(input, 'request') }
      } catch { error('FETCH_INPUT_UNOBSERVABLE') }
    }
    return null
  }
  try {
    responseURL = get(target.Response.prototype, 'url'); responseBody = get(target.Response.prototype, 'body')
    requestURL = get(target.Request.prototype, 'url'); requestMethod = get(target.Request.prototype, 'method')
    requestSignal = get(target.Request.prototype, 'signal'); urlHref = get(target.URL.prototype, 'href')
    controllerSignal = get(target.AbortController.prototype, 'signal')
    install(target, 'fetch', (original) => function (...args) {
      let result
      try { result = apply(original, this, args) }
      catch (failure) { safe(() => {
        const info = fetchInfo(args[0], args.length > 1 && args[1] !== undefined)
        if (info?.path) emit('fetch-throw', { path: info.path, method: info.method })
      }); throw failure }
      safe(() => {
        const info = fetchInfo(args[0], args.length > 1 && args[1] !== undefined)
        if (!info?.path) { unmapped++; return }
        const fetchId = id(result, 'fetch-promise')
        let signalId = null
        if (info.signal) {
          const linked = signalInfo(info.signal); signalId = linked.signalId
          if (linked.fetchIds.length < 1024) linked.fetchIds.push(fetchId); else overflow = true
        }
        emit('fetch-returned', { path: info.path, method: info.method, fetchId, requestId: info.requestId, signalId,
          initInspected: false, promiseObserved: false })
      })
      return result
    })
    install(target.AbortController.prototype, 'abort', (original) => function (...args) {
      safe(() => {
        const value = signalInfo(apply(controllerSignal, this, []))
        emit('abort-called', { controllerId: id(this, 'controller'), signalId: value.signalId,
          fetchIds: [...value.fetchIds], path: null, method: null, association: value.fetchIds.length ? 'native-request-signal' : 'unmapped' })
      })
      return apply(original, this, args)
    })
    install(target.Response.prototype, 'body', (original) => function () {
      const result = apply(original, this, [])
      safe(() => {
        const value = streamInfo(result, responseInfo(this), 'response-body-getter')
        if (value) emit('response-body-reference', value)
      })
      return result
    }, true)
    install(target.Response.prototype, 'clone', (original) => function (...args) {
      const result = apply(original, this, args)
      safe(() => {
        const parent = responseInfo(this), child = responseInfo(result)
        if (!parent || !child) return
        streamInfo(apply(responseBody, this, []), parent, 'response-clone-source')
        streamInfo(apply(responseBody, result, []), child, 'response-clone-result')
        emit('response-clone', { path: parent.path, method: null, fetchId: null,
          responseId: parent.responseId, cloneResponseId: child.responseId, nativeTeeNotObserved: true })
      })
      return result
    })
    install(target.ReadableStream.prototype, 'tee', (original) => function (...args) {
      const result = apply(original, this, args)
      safe(() => {
        const parent = streams.get(this); if (!parent) { unmapped++; return }
        const first = streamInfo(result[0], parent, 'js-tee-0'), second = streamInfo(result[1], parent, 'js-tee-1')
        emit('stream-tee', { ...parent, branchStreamIds: [first.streamId, second.streamId] })
      })
      return result
    })
    install(target.ReadableStream.prototype, 'getReader', (original) => function (...args) {
      const result = apply(original, this, args)
      safe(() => {
        const parent = streams.get(this); if (!parent) { unmapped++; return }
        const value = { ...parent, readerId: id(result, 'reader') }; readers.set(result, value)
        emit('reader-acquired', value)
      })
      return result
    })
    const cancel = (holder, reader) => install(holder, 'cancel', (original) => function (...args) {
      safe(() => {
        const value = (reader ? readers : streams).get(this)
        if (value) emit(reader ? 'reader-cancel-called' : 'stream-cancel-called', value); else unmapped++
      })
      return apply(original, this, args)
    })
    cancel(target.ReadableStream.prototype, false)
    cancel(target.ReadableStreamDefaultReader.prototype, true)
    cancel(target.ReadableStreamBYOBReader.prototype, true)
  } catch { error('INSTALL_FAILED') }
  const control = {
    drain(newPaths = []) {
      for (const path of newPaths) {
        if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/') || /[?#\\\0]/.test(path)) {
          error('PATH_UPDATE_INVALID'); continue
        }
        paths.add(path)
      }
      return { events: events.splice(0), errors: [...errors], overflow, unmapped, unmappedStackFrames, restored: disabled,
        installedDescriptors: patches.length, restoredDescriptors,
        documentTimeOrigin: clock, pageId: config.pageId,
        limitations: ['no-promise-reactions', 'no-init-inspection', 'no-body-bytes', 'no-native-internal-cancel-proof',
          'response-fetch-link-is-not-observed', 'cancel-called-does-not-prove-transport-abort'] }
    },
    restore() {
      if (disabled) return control.drain()
      disabled = true
      for (const patch of patches.reverse()) {
        try {
          const actual = descriptor(patch.holder, patch.name)
          if (!actual || Object.keys(actual).length !== Object.keys(patch.installed).length ||
            Object.keys(patch.installed).some((field) => actual[field] !== patch.installed[field])) {
            error('RESTORE_DESCRIPTOR_CHANGED'); continue
          }
          define(patch.holder, patch.name, patch.original)
          const verified = descriptor(patch.holder, patch.name)
          if (Object.keys(patch.original).some((field) => verified?.[field] !== patch.original[field])) {
            error('RESTORE_FAILED'); continue
          }
          restoredDescriptors++
        } catch { error('RESTORE_FAILED') }
      }
      return control.drain()
    },
  }
  try { define(target, key, { value: control, configurable: true }) } catch { error('CONTROL_INSTALL_FAILED') }
  return control
}

// Candidates are observational joins, never proof that cancel caused a failure.
export function joinDashboardCancelEvents(events, networks) {
  assert.ok(Array.isArray(events) && events.length <= 2048 && Array.isArray(networks) && networks.length <= 512)
  const fetches = new Map(), reciprocal = new Map()
  const candidates = events.map((event) => {
    if (!event.path) return []
    const found = networks.filter((network) => network.pageId === event.pageId && network.path === event.path &&
      (event.method === null || network.method === event.method) && Number.isFinite(network.wallTimeMs) &&
      network.wallTimeMs >= event.documentTimeOrigin - 50 &&
      (event.kind === 'fetch-returned' || event.kind === 'fetch-throw'
        ? Math.abs(network.wallTimeMs - event.at) <= 50
        : Number.isFinite(network.responseWallTimeMs) && network.responseWallTimeMs <= event.at + 50 &&
          event.at - network.responseWallTimeMs <= 10000))
    if (event.kind === 'fetch-returned') {
      fetches.set(`${event.pageId}:${event.documentTimeOrigin}:${event.fetchId}`, found)
      for (const value of found) reciprocal.set(value, (reciprocal.get(value) ?? 0) + 1)
    }
    return found
  })
  return events.map((event, index) => {
    let found = candidates[index]
    if (event.kind === 'abort-called' && event.fetchIds.length) {
      found = [...new Set(event.fetchIds.flatMap((id) => fetches.get(`${event.pageId}:${event.documentTimeOrigin}:${id}`) ?? []))]
    }
    const requiresReciprocal = event.kind === 'fetch-returned' || event.kind === 'abort-called'
    const unique = found.length === 1 && (!requiresReciprocal || reciprocal.get(found[0]) === 1)
    return { ...event, join: { policy: 'same-page-document-path-method-timing-candidates/v1',
      state: unique ? 'unique-candidate' : found.length ? 'ambiguous' : 'unmatched',
      cdpRequestId: unique ? found[0].cdpRequestId : null, loaderId: unique ? found[0].loaderId : null,
      candidateRequestIds: found.slice(0, 8).map((value) => value.cdpRequestId), candidateCount: found.length,
      cancelCausalityEstablished: false, responseFetchIdentityEstablished: false } }
  })
}

export function validateDashboardCancelSnapshot(value, pageId, paths, scripts) {
  assert.ok(value && typeof value === 'object')
  const keys = ['events', 'errors', 'overflow', 'unmapped', 'unmappedStackFrames', 'restored', 'installedDescriptors',
    'restoredDescriptors', 'documentTimeOrigin', 'pageId', 'limitations']
  assert.deepEqual(Object.keys(value).sort(), keys.sort())
  assert.equal(value.pageId, pageId); assert.ok(Number.isFinite(value.documentTimeOrigin))
  assert.ok(Array.isArray(value.events) && value.events.length <= 1024 && Array.isArray(value.errors) && value.errors.length <= 16)
  assert.ok(typeof value.overflow === 'boolean' && typeof value.restored === 'boolean')
  for (const field of ['unmapped', 'unmappedStackFrames', 'installedDescriptors', 'restoredDescriptors'])
    assert.ok(Number.isSafeInteger(value[field]) && value[field] >= 0)
  assert.ok(value.installedDescriptors <= 9 && value.restoredDescriptors <= value.installedDescriptors)
  assert.deepEqual(value.limitations, ['no-promise-reactions', 'no-init-inspection', 'no-body-bytes',
    'no-native-internal-cancel-proof', 'response-fetch-link-is-not-observed', 'cancel-called-does-not-prove-transport-abort'])
  const types = {
    'fetch-returned': ['fetchId', 'requestId', 'signalId', 'initInspected', 'promiseObserved'], 'fetch-throw': [],
    'abort-called': ['controllerId', 'signalId', 'fetchIds', 'association'],
    'response-body-reference': ['responseId', 'fetchId', 'streamId', 'via'],
    'response-clone': ['responseId', 'cloneResponseId', 'fetchId', 'nativeTeeNotObserved'],
    'stream-tee': ['responseId', 'fetchId', 'streamId', 'via', 'branchStreamIds'],
    'reader-acquired': ['responseId', 'fetchId', 'streamId', 'via', 'readerId'],
    'reader-cancel-called': ['responseId', 'fetchId', 'streamId', 'via', 'readerId'],
    'stream-cancel-called': ['responseId', 'fetchId', 'streamId', 'via'],
  }
  const identifier = (item) => assert.ok(item === null || (typeof item === 'string' && /^[a-z-]{1,32}-\d{1,8}$/.test(item)))
  for (const event of value.events) {
    assert.ok(Object.hasOwn(types, event.kind))
    assert.deepEqual(Object.keys(event).sort(), ['seq', 'kind', 'at', 'pageId', 'documentTimeOrigin', 'path', 'method', 'stack', ...types[event.kind]].sort())
    assert.equal(event.pageId, pageId); assert.equal(event.documentTimeOrigin, value.documentTimeOrigin)
    assert.ok(Number.isSafeInteger(event.seq) && event.seq > 0 && event.seq <= 1024 && Number.isFinite(event.at))
    assert.ok(event.path === null || paths.has(event.path))
    assert.ok(event.method === null || (typeof event.method === 'string' && /^[A-Z]{1,16}$/.test(event.method)))
    assert.ok(Array.isArray(event.stack) && event.stack.length <= 16 && Buffer.byteLength(JSON.stringify(event.stack)) <= 4096)
    for (const frame of event.stack) {
      assert.deepEqual(Object.keys(frame).sort(), ['scriptPath', 'line', 'column', 'scriptSha256', 'sourceBinding'].sort())
      assert.ok(scripts.has(frame.scriptPath)); assert.equal(frame.scriptSha256, scripts.get(frame.scriptPath))
      assert.equal(frame.sourceBinding, 'exact-frozen-manifest-path')
      assert.ok(Number.isSafeInteger(frame.line) && Number.isSafeInteger(frame.column) && frame.line >= 0 && frame.column >= 0)
    }
    for (const field of types[event.kind]) {
      if (field.endsWith('Id')) identifier(event[field])
      if (field.endsWith('Ids')) { assert.ok(Array.isArray(event[field]) && event[field].length <= 1024); event[field].forEach(identifier) }
    }
    if (Object.hasOwn(event, 'via')) assert.ok(['response-body-getter', 'response-clone-source', 'response-clone-result', 'js-tee-0', 'js-tee-1'].includes(event.via))
    if (event.kind === 'fetch-returned') { assert.equal(event.initInspected, false); assert.equal(event.promiseObserved, false) }
    if (event.kind === 'response-clone') assert.equal(event.nativeTeeNotObserved, true)
    if (event.kind === 'abort-called') assert.ok(['native-request-signal', 'unmapped'].includes(event.association))
  }
  const errors = ['OBSERVATION_FAILED', 'STACK_UNAVAILABLE', 'FETCH_INPUT_UNOBSERVABLE', 'INSTALL_FAILED',
    'PATH_UPDATE_INVALID', 'RESTORE_DESCRIPTOR_CHANGED', 'RESTORE_FAILED', 'CONTROL_INSTALL_FAILED']
  for (const error of value.errors) { assert.deepEqual(Object.keys(error), ['kind']); assert.ok(errors.includes(error.kind)) }
  return value
}
