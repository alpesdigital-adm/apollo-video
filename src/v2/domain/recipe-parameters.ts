import { Buffer } from 'node:buffer'

import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_CANONICAL_BYTES = 1024 * 1024

export interface RecipeParameterPayload {
  ref: string
  parametersHash: string
  canonicalJson: string
  canonicalByteSize: number
}

export function recipeParameterRef(parametersHash: string): string {
  assertDomain(
    SHA256_PATTERN.test(parametersHash),
    'INVALID_MEDIA_ARTIFACT',
    'Recipe parameters hash is invalid',
  )
  return `recipe-parameters/sha256/${parametersHash}`
}

export function createRecipeParameterPayload(parameters: unknown): RecipeParameterPayload {
  let canonicalJson: string
  try {
    canonicalJson = stableSerialize(parameters)
  } catch {
    throw new DomainError(
      'INVALID_MEDIA_ARTIFACT',
      'Recipe parameters must be canonically serializable',
    )
  }
  assertDomain(
    typeof canonicalJson === 'string',
    'INVALID_MEDIA_ARTIFACT',
    'Recipe parameters must be canonically serializable',
  )
  const parametersHash = calculateCanonicalHash(parameters)
  const canonicalByteSize = Buffer.byteLength(canonicalJson, 'utf8')
  assertDomain(
    canonicalByteSize > 0 && canonicalByteSize <= MAX_CANONICAL_BYTES,
    'INVALID_MEDIA_ARTIFACT',
    'Recipe parameters exceed the protected payload limit',
  )
  return {
    ref: recipeParameterRef(parametersHash),
    parametersHash,
    canonicalJson,
    canonicalByteSize,
  }
}

export function assertRecipeParameterPayload(payload: RecipeParameterPayload): void {
  assertDomain(
    payload.ref === recipeParameterRef(payload.parametersHash),
    'INVALID_MEDIA_ARTIFACT',
    'Recipe parameter reference does not match its hash',
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(payload.canonicalJson)
  } catch {
    throw new DomainError(
      'INVALID_MEDIA_ARTIFACT',
      'Recipe parameter payload is not valid JSON',
    )
  }
  assertDomain(
    stableSerialize(parsed) === payload.canonicalJson &&
      calculateCanonicalHash(parsed) === payload.parametersHash,
    'INVALID_MEDIA_ARTIFACT',
    'Recipe parameter payload does not match its canonical hash',
  )
  assertDomain(
    Buffer.byteLength(payload.canonicalJson, 'utf8') === payload.canonicalByteSize &&
      payload.canonicalByteSize > 0 &&
      payload.canonicalByteSize <= MAX_CANONICAL_BYTES,
    'INVALID_MEDIA_ARTIFACT',
    'Recipe parameter payload byte size is invalid',
  )
}
