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

function jsonString(value: string): string {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      assertDomain(next >= 0xdc00 && next <= 0xdfff, 'INVALID_OUTPUT_SPEC', 'Malformed Unicode in output seal')
    } else assertDomain(code < 0xdc00 || code > 0xdfff, 'INVALID_OUTPUT_SPEC', 'Malformed Unicode in output seal')
  }
  return JSON.stringify(value)
}

export function serializeOutputCanonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'string') return jsonString(item)
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
        assertDomain(Object.getPrototypeOf(item) === Array.prototype,
          'INVALID_OUTPUT_SPEC', 'Output array must have the JSON array prototype')
        const descriptors = Object.getOwnPropertyDescriptors(item)
        assertDomain(Object.keys(descriptors).length === item.length + 1 && Object.keys(item).length === item.length &&
          Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, index) &&
            'value' in descriptors[index] && descriptors[index].enumerable).every(Boolean),
        'INVALID_OUTPUT_SPEC', 'Sparse or decorated output array')
        const elements: string[] = []
        for (let index = 0; index < item.length; index++) elements.push(encode(descriptors[index].value))
        return `[${elements.join(',')}]`
      }
      assertDomain(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null,
        'INVALID_OUTPUT_SPEC', 'Output dependency must be a JSON object')
      const descriptors = Object.getOwnPropertyDescriptors(item)
      assertDomain(Object.values(descriptors).every((descriptor) => 'value' in descriptor && descriptor.enumerable),
        'INVALID_OUTPUT_SPEC', 'Accessor or hidden output dependency')
      const keys = Object.keys(descriptors).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      return `{${keys.map((key) => `${jsonString(key)}:${encode(descriptors[key].value)}`).join(',')}}`
    } finally { ancestors.delete(item) }
  }
  return encode(value)
}

export function calculateOutputCanonicalHash(value: unknown): string {
  return createHash('sha256').update(serializeOutputCanonicalJson(value), 'utf8').digest('hex')
}
