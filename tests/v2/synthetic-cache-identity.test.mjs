import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SYNTHETIC_CACHE_IDENTITY_FORBIDDEN_FIELDS,
  assertSyntheticCacheIdentityShape,
  calculateSyntheticBlockCacheKey,
  calculateSyntheticCacheKey,
  createSyntheticAvatarIdentity,
  createSyntheticVoiceIdentity,
  syntheticCacheIdentityBody,
} from '../../src/v2/domain/synthetic-cache-identity.ts'
import {
  calculateSyntheticBlockCacheKey as legacyBlockCacheKey,
  createSyntheticBlockVoiceKey,
} from '../../src/v2/domain/synthetic-block-generation.ts'

const digest = (character) => character.repeat(64)

const voiceInput = {
  adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0', voiceId: 'voice_a', voiceVersion: 1,
  modelRef: null, outputFormat: 'mp3', synthesisConfig: { outputFormat: 'mp3' },
}
const voice = createSyntheticVoiceIdentity(voiceInput)

const avatarInput = {
  adapterId: 'heygen-v3', adapterVersion: '3.0.0', avatarIdentityRef: 'avatar_a', presenterVersion: 2,
  modelRef: null, outputFormat: 'mp4', audioChecksum: digest('c'),
  renderConfig: { outputFormat: 'mp4' }, direction: null, background: null,
}
const avatar = createSyntheticAvatarIdentity(avatarInput)

const ttsSubject = { operation: 'tts', exactText: 'Primeira ideia.', locale: 'pt-BR', voice }
const avatarSubject = { operation: 'audio-avatar', locale: 'pt-BR', avatar }

/**
 * Frozen digests. If a change to the identity shape moves one of these, the
 * change is silently invalidating every generation already persisted under the
 * old address — the test exists to make that deliberate instead of accidental.
 */
const TTS_SENTINEL = '1d49a2d3d64b4e223762d9d6236cf01b449de1a9ea737dd018bf0e81a72c2a89'
const AVATAR_SENTINEL = '1f23325a60daa05959b401420b09f0c2222e255b86b7e437c25fff5f47462f33'

test('T-FR-105 canonical cache identity is frozen by sentinels and stays compatible with persisted keys', () => {
  assert.equal(calculateSyntheticBlockCacheKey({ exactText: 'Primeira ideia.', locale: 'pt-BR', voice }), TTS_SENTINEL)
  assert.equal(calculateSyntheticCacheKey(avatarSubject), AVATAR_SENTINEL)

  // Centralizing the identity must not orphan work the previous
  // implementation already addressed and paid for.
  assert.equal(
    calculateSyntheticBlockCacheKey({ exactText: 'Primeira ideia.', locale: 'pt-BR', voice }),
    legacyBlockCacheKey({ exactText: 'Primeira ideia.', locale: 'pt-BR', voice: createSyntheticBlockVoiceKey(voiceInput) }),
  )

  // Audio and video of the same performance are different work.
  assert.notEqual(calculateSyntheticCacheKey(ttsSubject), calculateSyntheticCacheKey(avatarSubject))
})

test('T-FR-105 only factors that change the bytes belong to the identity', () => {
  const key = calculateSyntheticCacheKey(ttsSubject)

  // Same request twice is the same address.
  assert.equal(calculateSyntheticCacheKey({ ...ttsSubject }), key)

  // Every audible factor moves it.
  assert.notEqual(calculateSyntheticCacheKey({ ...ttsSubject, exactText: 'Segunda ideia.' }), key)
  assert.notEqual(calculateSyntheticCacheKey({ ...ttsSubject, locale: 'pt-PT' }), key)
  assert.notEqual(
    calculateSyntheticCacheKey({ ...ttsSubject, voice: createSyntheticVoiceIdentity({ ...voiceInput, voiceId: 'voice_b' }) }),
    key,
  )
  assert.notEqual(
    calculateSyntheticCacheKey({ ...ttsSubject, voice: createSyntheticVoiceIdentity({ ...voiceInput, adapterVersion: '1.1.0' }) }),
    key,
  )
  assert.notEqual(
    calculateSyntheticCacheKey({ ...ttsSubject, voice: createSyntheticVoiceIdentity({ ...voiceInput, outputFormat: 'wav' }) }),
    key,
  )
  assert.notEqual(
    calculateSyntheticCacheKey({ ...ttsSubject, voice: createSyntheticVoiceIdentity({ ...voiceInput, synthesisConfig: { outputFormat: 'mp3', stability: 0.7 } }) }),
    key,
  )
  assert.notEqual(calculateSyntheticCacheKey({ ...ttsSubject, pronunciationDictionaryRef: 'dict-1' }), key)

  // Avatar identity: the driving audio, direction and background are pixels.
  const avatarKey = calculateSyntheticCacheKey(avatarSubject)
  assert.notEqual(
    calculateSyntheticCacheKey({ ...avatarSubject, avatar: createSyntheticAvatarIdentity({ ...avatarInput, audioChecksum: digest('d') }) }),
    avatarKey,
  )
  assert.notEqual(
    calculateSyntheticCacheKey({ ...avatarSubject, avatar: createSyntheticAvatarIdentity({ ...avatarInput, background: 'estúdio azul' }) }),
    avatarKey,
  )
  assert.notEqual(
    calculateSyntheticCacheKey({ ...avatarSubject, avatar: createSyntheticAvatarIdentity({ ...avatarInput, direction: 'olhar para a câmera' }) }),
    avatarKey,
  )
  assert.notEqual(
    calculateSyntheticCacheKey({ ...avatarSubject, avatar: createSyntheticAvatarIdentity({ ...avatarInput, presenterVersion: 3 }) }),
    avatarKey,
  )
})

test('T-FR-105 eligibility and bookkeeping never enter the identity', () => {
  // The drift sentinel: the canonical body must never grow a field that does
  // not change the bytes. A "just add the project id" would double every bill.
  for (const subject of [ttsSubject, avatarSubject]) {
    assertSyntheticCacheIdentityShape(subject)
    const serialized = JSON.stringify(syntheticCacheIdentityBody(subject))
    for (const forbidden of SYNTHETIC_CACHE_IDENTITY_FORBIDDEN_FIELDS) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, `${forbidden} must not appear in the cache identity`)
    }
  }

  // Consent is eligibility, not identity: the same bytes keep the same address
  // whether consent was just renewed or is about to expire.
  assert.equal(Object.hasOwn(syntheticCacheIdentityBody(ttsSubject), 'consent'), false)
  assert.equal(Object.hasOwn(syntheticCacheIdentityBody(avatarSubject), 'consent'), false)
})

test('T-FR-105 malformed identities fail closed instead of hashing garbage', () => {
  assert.throws(() => calculateSyntheticCacheKey({ ...ttsSubject, exactText: '   ' }), /text is empty/)
  assert.throws(() => calculateSyntheticCacheKey({ ...ttsSubject, locale: 'not a locale' }), /locale is invalid/)
  assert.throws(
    () => createSyntheticAvatarIdentity({ ...avatarInput, audioChecksum: 'not-a-checksum' }),
    /driving audio checksum is invalid/,
  )
  assert.throws(() => createSyntheticVoiceIdentity({ ...voiceInput, voiceVersion: 0 }), /Voice version is invalid/)
})
