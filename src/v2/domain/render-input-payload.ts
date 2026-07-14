import { Buffer } from 'node:buffer'

import { stableSerialize } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import {
  assertRenderInputSpec,
  type RenderInputSpecV1,
} from './render-input.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_CANONICAL_BYTES = 4 * 1024 * 1024

export interface RenderInputPayload {
  ref: string
  inputHash: string
  canonicalJson: string
  canonicalByteSize: number
}

export function renderInputRef(inputHash: string): string {
  assertDomain(
    SHA256_PATTERN.test(inputHash),
    'INVALID_RENDER_INPUT',
    'Render input hash is invalid',
  )
  return `render-input/sha256/${inputHash}`
}

export function createRenderInputPayload(spec: RenderInputSpecV1): RenderInputPayload {
  assertRenderInputSpec(spec)
  const canonicalJson = stableSerialize(spec)
  const canonicalByteSize = Buffer.byteLength(canonicalJson, 'utf8')
  assertDomain(
    canonicalByteSize > 0 && canonicalByteSize <= MAX_CANONICAL_BYTES,
    'INVALID_RENDER_INPUT',
    'Render input exceeds the protected payload limit',
  )
  return Object.freeze({
    ref: renderInputRef(spec.inputHash),
    inputHash: spec.inputHash,
    canonicalJson,
    canonicalByteSize,
  })
}

export function assertRenderInputPayload(payload: RenderInputPayload): void {
  assertDomain(
    payload.ref === renderInputRef(payload.inputHash),
    'INVALID_RENDER_INPUT',
    'Render input payload reference does not match its hash',
  )
  let parsed: RenderInputSpecV1
  try {
    parsed = JSON.parse(payload.canonicalJson) as RenderInputSpecV1
  } catch {
    throw new DomainError('INVALID_RENDER_INPUT', 'Render input payload is not valid JSON')
  }
  assertRenderInputSpec(parsed)
  assertDomain(
    parsed.inputHash === payload.inputHash &&
      stableSerialize(parsed) === payload.canonicalJson,
    'INVALID_RENDER_INPUT',
    'Render input payload does not match its canonical identity',
  )
  assertDomain(
    Buffer.byteLength(payload.canonicalJson, 'utf8') === payload.canonicalByteSize &&
      payload.canonicalByteSize > 0 &&
      payload.canonicalByteSize <= MAX_CANONICAL_BYTES,
    'INVALID_RENDER_INPUT',
    'Render input payload byte size is invalid',
  )
}
