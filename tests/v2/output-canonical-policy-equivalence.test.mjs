import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateOutputCanonicalHash, serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'

/**
 * The canonical serializer is the hot path of every output transaction (a State and its receipt reach megabytes and are serialized
 * several times in one commit), so it was rewritten to make the same checks without a descriptor map per object. This file keeps the
 * policy it replaced, verbatim, as the oracle: for every value, the new one answers the same text, and for every refusal it raises the
 * same error (code and message). Nothing here weakens a check; it pins that none was lost.
 */
const assertDomain = (condition, code, message) => { if (!condition) throw new DomainError(code, message) }
function referenceJsonString(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      assertDomain(next >= 0xdc00 && next <= 0xdfff, 'INVALID_OUTPUT_SPEC', 'Malformed Unicode in output seal')
    } else assertDomain(code < 0xdc00 || code > 0xdfff, 'INVALID_OUTPUT_SPEC', 'Malformed Unicode in output seal')
  }
  return JSON.stringify(value)
}
function referenceSerialize(value) {
  const ancestors = new Set()
  const encode = (item) => {
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'string') return referenceJsonString(item)
    if (typeof item === 'number') {
      assertDomain(Number.isFinite(item), 'INVALID_OUTPUT_SPEC', 'Non-finite output dependency')
      return JSON.stringify(item)
    }
    assertDomain(typeof item === 'object' && item !== null, 'INVALID_OUTPUT_SPEC', 'Non-JSON output dependency')
    assertDomain(!ancestors.has(item), 'INVALID_OUTPUT_SPEC', 'Cyclic output dependency')
    assertDomain(Object.getOwnPropertySymbols(item).length === 0, 'INVALID_OUTPUT_SPEC', 'Symbol output dependency')
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        assertDomain(Object.getPrototypeOf(item) === Array.prototype, 'INVALID_OUTPUT_SPEC', 'Output array must have the JSON array prototype')
        const descriptors = Object.getOwnPropertyDescriptors(item)
        assertDomain(Object.keys(descriptors).length === item.length + 1 && Object.keys(item).length === item.length &&
          Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, index) &&
            'value' in descriptors[index] && descriptors[index].enumerable).every(Boolean),
        'INVALID_OUTPUT_SPEC', 'Sparse or decorated output array')
        const elements = []
        for (let index = 0; index < item.length; index++) elements.push(encode(descriptors[index].value))
        return `[${elements.join(',')}]`
      }
      assertDomain(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null,
        'INVALID_OUTPUT_SPEC', 'Output dependency must be a JSON object')
      const descriptors = Object.getOwnPropertyDescriptors(item)
      assertDomain(Object.values(descriptors).every((descriptor) => 'value' in descriptor && descriptor.enumerable),
        'INVALID_OUTPUT_SPEC', 'Accessor or hidden output dependency')
      const keys = Object.keys(descriptors).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      return `{${keys.map((key) => `${referenceJsonString(key)}:${encode(descriptors[key].value)}`).join(',')}}`
    } finally { ancestors.delete(item) }
  }
  return encode(value)
}

const outcome = (serialize, value) => {
  try { return { text: serialize(value) } } catch (error) { return { code: error.code, message: error.message } }
}
const sameOutcome = (value, label) => assert.deepEqual(outcome(serializeOutputCanonicalJson, value), outcome(referenceSerialize, value), label)

// A deterministic generator of JSON-shaped values: nested objects and arrays, numeric-looking keys, unicode, extremes of numbers.
function generator(seed) {
  let state = seed >>> 0
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
  const KEYS = ['id', 'b', 'a', 'z', '10', '2', '1', '', 'é', 'ä', '\u{1F600}', '￿', 'schemaVersion', '__proto__', 'constructor', 'k k', 'ａ']
  const STRINGS = ['', 'plain', 'quote"back\\slash', 'line\nbreak\ttab', '\u0000\u001f', 'é', '\u{1F600}', '  ', 'ａｂ']
  const NUMBERS = [0, -0, 1, -1, 0.5, 1e21, 1e-7, 123456789012, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, 3.14159]
  const make = (depth) => {
    const pick = next()
    if (depth <= 0 || pick < 0.3) {
      const leaf = next()
      if (leaf < 0.3) return STRINGS[Math.floor(next() * STRINGS.length)]
      if (leaf < 0.7) return NUMBERS[Math.floor(next() * NUMBERS.length)]
      return leaf < 0.8 ? null : leaf < 0.9
    }
    if (pick < 0.6) return Array.from({ length: Math.floor(next() * 6) }, () => make(depth - 1))
    const object = next() < 0.2 ? Object.create(null) : {}
    for (let index = Math.floor(next() * 7); index > 0; index--) {
      Object.defineProperty(object, KEYS[Math.floor(next() * KEYS.length)], { value: make(depth - 1), enumerable: true, writable: true, configurable: true })
    }
    return object
  }
  return make
}

test('the serializer answers the text the policy it replaced answered, for 4000 generated values', () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const value = generator(seed)(5)
    const reference = outcome(referenceSerialize, value)
    assert.ok('text' in reference, `seed ${seed}: the generator makes valid values`)
    assert.equal(serializeOutputCanonicalJson(value), reference.text, `seed ${seed}`)
    assert.equal(calculateOutputCanonicalHash(value), calculateOutputCanonicalHash(JSON.parse(reference.text)), `seed ${seed}: the hash is of the text`)
  }
})

test('the serializer refuses every malformed value with the same code and message', () => {
  const sparse = [1, 2, 3]; delete sparse[1]
  const decorated = [1, 2]; decorated.extra = true
  const hiddenIndex = [1, 2]; Object.defineProperty(hiddenIndex, 1, { value: 2, enumerable: false })
  const accessorIndex = [1]; Object.defineProperty(accessorIndex, 0, { get: () => 1, enumerable: true })
  const accessor = {}; Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true })
  const hidden = { a: 1 }; Object.defineProperty(hidden, 'b', { value: 2, enumerable: false })
  const symbolKey = { a: 1, [Symbol('s')]: 2 }
  const cyclic = { a: [] }; cyclic.a.push(cyclic)
  const cyclicArray = []; cyclicArray.push(cyclicArray)
  class Special { constructor() { this.a = 1 } }
  class SubArray extends Array {}
  const sharedLeaf = { n: 1 }
  const cases = {
    undefined, function: () => 1, symbol: Symbol('x'), bigint: 1n, nan: NaN, infinity: Infinity, negativeInfinity: -Infinity,
    loneHigh: '\ud800', loneHighThenText: '\ud800x', loneLow: '\udc00', lowFirst: '\udc00\ud800', loneHighKey: { '\ud800': 1 }, nestedLone: { a: [{ b: 'x\udfffy' }] },
    sparse, decorated, hiddenIndex, accessorIndex, accessor, hidden, symbolKey, cyclic, cyclicArray, date: new Date(0), map: new Map(),
    special: new Special(), subArray: SubArray.from([1]), typed: new Uint8Array(2), nestedUndefined: { a: undefined }, arrayUndefined: [undefined],
    // A value shared by two siblings is not a cycle.
    shared: { a: sharedLeaf, b: sharedLeaf, c: [sharedLeaf, sharedLeaf] },
  }
  for (const [label, value] of Object.entries(cases)) sameOutcome(value, label)
  // The refusals still happen: the reference raises on every case but the shared one.
  for (const [label, value] of Object.entries(cases)) {
    if (label === 'shared') { assert.equal(typeof serializeOutputCanonicalJson(value), 'string'); continue }
    assert.throws(() => serializeOutputCanonicalJson(value), (error) => error instanceof DomainError && error.code === 'INVALID_OUTPUT_SPEC', label)
  }
})

test('a large receipt-shaped document serializes to the same text, faster than the policy it replaced', () => {
  const frames = Array.from({ length: 40_000 }, (_, index) => ({ pts: index, key: index % 30 === 0, size: 1000 + (index % 97), type: index % 30 === 0 ? 'I' : 'P', flags: ['a', 'b'], note: 'frame é ' + index }))
  const document = { schemaVersion: 'receipt/v1', source: { artifactId: 'a', manifest: { id: 'm', hash: 'h'.repeat(64) } }, probe: { frames, audio: frames.slice(0, 10_000).map((f) => ({ ...f })) } }
  const time = (serialize) => { const started = performance.now(); const text = serialize(document); return { text, ms: performance.now() - started } }
  time(serializeOutputCanonicalJson); time(referenceSerialize)
  const fast = [time(serializeOutputCanonicalJson), time(serializeOutputCanonicalJson), time(serializeOutputCanonicalJson)]
  const slow = [time(referenceSerialize), time(referenceSerialize), time(referenceSerialize)]
  assert.equal(fast[0].text, slow[0].text)
  const median = (items) => items.map((item) => item.ms).sort((a, b) => a - b)[1]
  console.log(`canonical serialization of ${(fast[0].text.length / 1e6).toFixed(1)} MB: new ${fast.map((i) => i.ms.toFixed(0)).join('/')} ms, replaced ${slow.map((i) => i.ms.toFixed(0)).join('/')} ms (N=3 each)`)
  // Evidence of the gain, with room for a loaded machine: the median of three must not be slower than the one it replaced.
  assert.ok(median(fast) <= median(slow), `new ${median(fast)} ms vs replaced ${median(slow)} ms`)
})

test('a frozen document is serialized once and answers the same text; a document that can still change never does', () => {
  const rows = Array.from({ length: 2_000 }, (_, index) => ({ pts: index, note: 'frame é ' + index, flags: ['a', 'b'] }))
  const deepFreeze = (value) => { if (value !== null && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) } return value }
  const frozen = deepFreeze({ schemaVersion: 'receipt/v1', rows: structuredClone(rows) })
  const expected = referenceSerialize({ schemaVersion: 'receipt/v1', rows })
  assert.ok(expected.length > 16_384, 'large enough to be remembered')
  assert.equal(serializeOutputCanonicalJson(frozen), expected)
  assert.equal(serializeOutputCanonicalJson(frozen), expected, 'the second call answers from what the first remembered')
  // The frozen document inside another document: the text of the whole is the same as ever.
  assert.equal(serializeOutputCanonicalJson({ z: 1, doc: frozen, a: [frozen] }), referenceSerialize({ z: 1, doc: { schemaVersion: 'receipt/v1', rows }, a: [{ schemaVersion: 'receipt/v1', rows }] }))
  // Frozen outside only: the child can still change, so the text of the parent is never remembered and follows the child.
  const child = structuredClone(rows)
  const shallow = Object.freeze({ schemaVersion: 'receipt/v1', rows: child })
  const first = serializeOutputCanonicalJson(shallow)
  assert.equal(first, expected)
  child[0].note = 'changed'
  assert.notEqual(serializeOutputCanonicalJson(shallow), first, 'a document with something not frozen under it is serialized afresh')
  assert.equal(serializeOutputCanonicalJson(shallow), referenceSerialize(shallow))
  // A document that is not frozen at all is never remembered.
  const open = { schemaVersion: 'receipt/v1', rows: structuredClone(rows) }
  const before = serializeOutputCanonicalJson(open)
  open.rows.push({ pts: -1, note: 'x', flags: [] })
  assert.notEqual(serializeOutputCanonicalJson(open), before)
  // A frozen document that breaks the policy is still refused (the refusal is not remembered away).
  const bad = Object.freeze({ rows: Object.freeze([Object.freeze({ text: 'x\ud800y' })]) })
  assert.throws(() => serializeOutputCanonicalJson(bad), (error) => error.code === 'INVALID_OUTPUT_SPEC')
  assert.throws(() => serializeOutputCanonicalJson(bad), (error) => error.code === 'INVALID_OUTPUT_SPEC')
})
