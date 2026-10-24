import { createHash } from 'node:crypto'
import { assertDomain } from './errors.ts'

/** Only new W66 seals use this policy. Existing plan, Command and audit hashes
 * retain canonical-hash.ts unchanged. Object keys use UTF-16 ordinal ordering;
 * numeric-looking keys are emitted directly, never through JS object iteration.
 * Strings are not normalized. Undefined, sparse arrays, cycles, accessors,
 * symbols and malformed Unicode are rejected; finite numbers use JSON syntax. */
export const OUTPUT_CANONICAL_POLICY_VERSION = 'output-canonical-json/v1' as const
export type OutputCanonicalPolicy = Readonly<{
  canonicalPolicyVersion: typeof OUTPUT_CANONICAL_POLICY_VERSION
}>

export function validateOutputCanonicalPolicy(value: unknown): asserts value is OutputCanonicalPolicy {
  const descriptor = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, 'canonicalPolicyVersion') : undefined
  assertDomain(descriptor !== undefined && 'value' in descriptor && descriptor.enumerable &&
    descriptor.value === OUTPUT_CANONICAL_POLICY_VERSION,
  'INVALID_OUTPUT_SPEC', 'Output canonical policy is missing or unsupported')
}

const MALFORMED_UNICODE = 'Malformed Unicode in output seal'
const nativeIsWellFormed = (String.prototype as unknown as { isWellFormed?: (this: string) => boolean }).isWellFormed

/**
 * The JSON text of a string that holds no lone surrogate. `isWellFormed` is the engine's own scan for exactly that (a high surrogate
 * not followed by a low one, or a low one on its own); without it the same scan runs here, one code unit at a time.
 */
function jsonString(value: string): string {
  if (nativeIsWellFormed !== undefined) {
    if (!nativeIsWellFormed.call(value)) assertDomain(false, 'INVALID_OUTPUT_SPEC', MALFORMED_UNICODE)
  } else {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index)
        assertDomain(next >= 0xdc00 && next <= 0xdfff, 'INVALID_OUTPUT_SPEC', MALFORMED_UNICODE)
      } else assertDomain(code < 0xdc00 || code > 0xdfff, 'INVALID_OUTPUT_SPEC', MALFORMED_UNICODE)
    }
  }
  return JSON.stringify(value)
}

/**
 * The canonical text of a document that can no longer change: an object (and everything under it) that has been frozen. The same frozen
 * document is canonicalized again and again while a State is built, validated, hashed and stored (each sealed part is serialized for its
 * hash, for its column and for the hash of the part that holds it), and a frozen document answers the same text every time, so it is
 * serialized once. Only documents large enough for the saving to matter are kept, and only for as long as the document itself lives.
 */
const FROZEN_TEXT_MIN_LENGTH = 16_384
const frozenText = new WeakMap<object, string>()

/**
 * The canonical text of a value (see the policy above). A multi-megabyte State or receipt is serialized several times in one commit, so
 * this is the hot path of every output transaction: the checks are the same ones, made without building a descriptor map for every
 * object and array (an object's own properties are read one descriptor at a time, an array is checked by length and by index), and an
 * object key is escaped once per call however many objects carry it. The text it answers and the refusals it raises are unchanged.
 */
export function serializeOutputCanonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const keyText = new Map<string, string>()
  // Whether everything met since it was last reset is frozen (a primitive is immutable by nature).
  let allFrozen = true
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'string') return jsonString(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) assertDomain(false, 'INVALID_OUTPUT_SPEC', 'Non-finite output dependency')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object') assertDomain(false, 'INVALID_OUTPUT_SPEC', 'Non-JSON output dependency')
    // A frozen document already canonicalized (its shape was checked when its text was made, and a frozen one cannot have changed since).
    const known = frozenText.get(item as object)
    if (known !== undefined) return known
    if (ancestors.has(item as object)) assertDomain(false, 'INVALID_OUTPUT_SPEC', 'Cyclic output dependency')
    if (Object.getOwnPropertySymbols(item as object).length !== 0) assertDomain(false, 'INVALID_OUTPUT_SPEC', 'Symbol output dependency')
    ancestors.add(item as object)
    const outerFrozen = allFrozen
    allFrozen = true
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) assertDomain(false, 'INVALID_OUTPUT_SPEC', 'Output array must have the JSON array prototype')
        const length = item.length
        // Own names are exactly the indices and `length`; each index is an own, enumerable data property.
        if (Object.getOwnPropertyNames(item).length !== length + 1) assertDomain(false, 'INVALID_OUTPUT_SPEC', 'Sparse or decorated output array')
        let text = '['
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index)
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) assertDomain(false, 'INVALID_OUTPUT_SPEC', 'Sparse or decorated output array')
          text += (index === 0 ? '' : ',') + encode(descriptor.value)
        }
        return keep(item as object, text + ']', outerFrozen)
      }
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) assertDomain(false, 'INVALID_OUTPUT_SPEC', 'Output dependency must be a JSON object')
      const names = Object.getOwnPropertyNames(item)
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(item, name)!
        if (!('value' in descriptor) || !descriptor.enumerable) assertDomain(false, 'INVALID_OUTPUT_SPEC', 'Accessor or hidden output dependency')
      }
      const record = item as Record<string, unknown>
      // The default order of `sort` is the UTF-16 code-unit order the policy names.
      names.sort()
      let text = '{'
      for (let index = 0; index < names.length; index++) {
        const name = names[index]!
        let key = keyText.get(name)
        if (key === undefined) { key = jsonString(name); keyText.set(name, key) }
        text += (index === 0 ? '' : ',') + key + ':' + encode(record[name])
      }
      return keep(item as object, text + '}', outerFrozen)
    } finally { ancestors.delete(item as object) }
  }
  // Called with the text of a node whose children are all encoded: remembers it when the node and all it holds are frozen.
  const keep = (node: object, text: string, outerFrozen: boolean): string => {
    const frozen = allFrozen && Object.isFrozen(node)
    if (frozen && text.length >= FROZEN_TEXT_MIN_LENGTH) frozenText.set(node, text)
    allFrozen = outerFrozen && frozen
    return text
  }
  return encode(value)
}

export function calculateOutputCanonicalHash(value: unknown): string {
  return createHash('sha256').update(serializeOutputCanonicalJson(value), 'utf8').digest('hex')
}
