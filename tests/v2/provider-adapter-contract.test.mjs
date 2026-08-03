import test from 'node:test'
import assert from 'node:assert/strict'
import { validateProviderCapabilities } from '../../src/v2/application/provider-capabilities.ts'

const valid = {
  operations: ['tts', 'lip-sync'],
  inputFormats: ['audio/wav'],
  outputFormats: ['video/mp4'],
  locales: ['pt-BR'],
  aspectRatios: ['9:16'],
  duration: { minSeconds: 1, maxSeconds: 60 },
  identityReference: 'profile-id',
  supportsSeed: true,
  supportsIdempotency: true,
  completion: 'both',
  concurrencyLimit: 4,
  regionRestrictions: ['BR'],
  fetchedAt: '2026-08-03T00:00:00.000Z',
  expiresAt: '2026-08-03T00:05:00.000Z',
}

test('T-F0-033 Provider adapter capabilities match Spec 06 and are immutable', () => {
  const capabilities = validateProviderCapabilities(valid)
  assert.deepEqual(capabilities.operations, ['tts', 'lip-sync'])
  assert.equal(capabilities.completion, 'both')
  assert.ok(Object.isFrozen(capabilities))
  assert.ok(Object.isFrozen(capabilities.operations))
  assert.ok(Object.isFrozen(capabilities.duration))
})

test('T-F0-033 Provider capability boundary rejects drift, secrets, duplicates and stale TTL shape', () => {
  for (const candidate of [
    { ...valid, apiKey: 'secret' },
    { ...valid, operations: ['tts', 'tts'] },
    { ...valid, operations: ['unknown'] },
    { ...valid, duration: { minSeconds: 10, maxSeconds: 1 } },
    { ...valid, expiresAt: valid.fetchedAt },
  ]) assert.throws(() => validateProviderCapabilities(candidate), (error) => error?.code === 'INVALID_ARGUMENT')
})
