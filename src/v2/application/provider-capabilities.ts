import { assertDomain } from '../domain/errors.ts'
import {
  PROVIDER_COMPLETION_MODES,
  PROVIDER_OPERATIONS,
  type ProviderCapabilities,
  type ProviderCompletionMode,
  type ProviderOperation,
} from './ports/async-media-provider.ts'

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9.:+_/-]{0,127}$/

function tokens(value: unknown, field: string): readonly string[] {
  assertDomain(Array.isArray(value) && value.length > 0, 'INVALID_ARGUMENT', `${field} must be a non-empty array`)
  const normalized = value.map((item) => {
    assertDomain(typeof item === 'string' && item === item.trim() && TOKEN.test(item), 'INVALID_ARGUMENT', `${field} contains an invalid token`)
    return item
  })
  assertDomain(new Set(normalized).size === normalized.length, 'INVALID_ARGUMENT', `${field} contains duplicates`)
  return Object.freeze(normalized)
}

export function validateProviderCapabilities(value: unknown): Readonly<ProviderCapabilities> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', 'Provider capabilities must be an object')
  const input = value as Record<string, unknown>
  const allowed = new Set(['operations', 'inputFormats', 'outputFormats', 'locales', 'aspectRatios', 'duration', 'identityReference', 'backgroundModes', 'supportsSeed', 'supportsIdempotency', 'supportsCancellation', 'completion', 'concurrencyLimit', 'regionRestrictions', 'fetchedAt', 'expiresAt'])
  assertDomain(Object.keys(input).every((key) => allowed.has(key)), 'INVALID_ARGUMENT', 'Provider capabilities contain unsupported fields')
  const operations = tokens(input.operations, 'operations')
  assertDomain(operations.every((item) => PROVIDER_OPERATIONS.includes(item as ProviderOperation)), 'INVALID_ARGUMENT', 'Provider capabilities contain an unsupported operation')
  assertDomain(typeof input.duration === 'object' && input.duration !== null, 'INVALID_ARGUMENT', 'Provider duration is required')
  const duration = input.duration as Record<string, unknown>
  assertDomain(Object.keys(duration).every((key) => key === 'minSeconds' || key === 'maxSeconds'), 'INVALID_ARGUMENT', 'Provider duration contains unsupported fields')
  assertDomain(typeof duration.minSeconds === 'number' && Number.isFinite(duration.minSeconds) && duration.minSeconds >= 0, 'INVALID_ARGUMENT', 'Provider minimum duration is invalid')
  assertDomain(typeof duration.maxSeconds === 'number' && Number.isFinite(duration.maxSeconds) && duration.maxSeconds >= duration.minSeconds, 'INVALID_ARGUMENT', 'Provider maximum duration is invalid')
  assertDomain(['none', 'image', 'video', 'profile-id'].includes(String(input.identityReference)), 'INVALID_ARGUMENT', 'Provider identity reference is invalid')
  assertDomain(typeof input.supportsSeed === 'boolean' && typeof input.supportsIdempotency === 'boolean' && typeof input.supportsCancellation === 'boolean', 'INVALID_ARGUMENT', 'Provider capability flags are invalid')
  assertDomain(PROVIDER_COMPLETION_MODES.includes(input.completion as ProviderCompletionMode), 'INVALID_ARGUMENT', 'Provider completion mode is invalid')
  if (input.concurrencyLimit !== undefined) assertDomain(Number.isSafeInteger(input.concurrencyLimit) && Number(input.concurrencyLimit) > 0, 'INVALID_ARGUMENT', 'Provider concurrency limit is invalid')
  const fetchedAt = Date.parse(String(input.fetchedAt))
  const expiresAt = Date.parse(String(input.expiresAt))
  assertDomain(Number.isFinite(fetchedAt) && Number.isFinite(expiresAt) && expiresAt > fetchedAt, 'INVALID_ARGUMENT', 'Provider capability TTL is invalid')

  return Object.freeze({
    ...input,
    operations: operations as readonly ProviderOperation[],
    inputFormats: tokens(input.inputFormats, 'inputFormats'),
    outputFormats: tokens(input.outputFormats, 'outputFormats'),
    ...(input.locales === undefined ? {} : { locales: tokens(input.locales, 'locales') }),
    ...(input.aspectRatios === undefined ? {} : { aspectRatios: tokens(input.aspectRatios, 'aspectRatios') }),
    ...(input.backgroundModes === undefined ? {} : { backgroundModes: tokens(input.backgroundModes, 'backgroundModes') }),
    ...(input.regionRestrictions === undefined ? {} : { regionRestrictions: tokens(input.regionRestrictions, 'regionRestrictions') }),
    duration: Object.freeze({ minSeconds: duration.minSeconds, maxSeconds: duration.maxSeconds }),
  }) as Readonly<ProviderCapabilities>
}
