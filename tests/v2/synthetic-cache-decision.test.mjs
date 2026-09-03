import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SYNTHETIC_CACHE_DECISION_FORBIDDEN_FIELDS,
  SYNTHETIC_CACHE_DECISION_OUTCOMES,
  SYNTHETIC_CACHE_DECISION_REASON_CODES,
  SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION,
  assertSyntheticCacheDecisionIntegrity,
  assertSyntheticCacheDecisionPrivacy,
  calculateSyntheticCacheDecisionSubjectHash,
  createSyntheticCacheDecision,
  syntheticCacheDecisionReasonsFor,
} from '../../src/v2/domain/synthetic-cache-decision.ts'
import {
  calculateSyntheticCacheKey,
  createSyntheticAvatarIdentity,
  createSyntheticVoiceIdentity,
} from '../../src/v2/domain/synthetic-cache-identity.ts'

const digest = (character) => character.repeat(64)

const voice = createSyntheticVoiceIdentity({
  adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0', voiceId: 'voice_a', voiceVersion: 1,
  modelRef: null, outputFormat: 'mp3', synthesisConfig: { outputFormat: 'mp3' },
})
const avatar = createSyntheticAvatarIdentity({
  adapterId: 'heygen-v3', adapterVersion: '3.1.0', avatarIdentityRef: 'avatar_a', presenterVersion: 2,
  modelRef: null, outputFormat: 'mp4', audioChecksum: digest('c'),
  renderConfig: { outputFormat: 'mp4' }, direction: null, background: null,
})
const subject = Object.freeze({ operation: 'tts', exactText: 'Primeira ideia do roteiro.', locale: 'pt-BR', voice })
const avatarSubject = Object.freeze({ operation: 'audio-avatar', locale: 'pt-BR', avatar })

const policyVersion = 'synthetic-presenter-eligibility-policy/v1'
const base = {
  id: 'scd-1', workspaceId: 'workspace-a', projectId: 'project-a', subject,
  policyVersion, currency: 'USD', decidedAt: '2029-04-01T00:00:00.000Z',
  estimatedSavingMinorUnits: 0, avoidedCostMinorUnits: 0,
}
const hit = (overrides = {}) => createSyntheticCacheDecision({
  ...base, outcome: 'hit', reasonCode: 'CACHE_HIT_ELIGIBLE',
  reason: 'the approved twin proved blob, rights and consent',
  candidateGenerationId: 'sbg-original', estimatedSavingMinorUnits: 30, avoidedCostMinorUnits: 30,
  ...overrides,
})
const miss = (overrides = {}) => createSyntheticCacheDecision({
  ...base, outcome: 'miss', reasonCode: 'CACHE_MISS_NO_CANDIDATE',
  reason: 'no approved generation carries this exact cache key',
  ...overrides,
})

test('T-FR-105 a cache decision addresses the identity it was taken about and seals itself', () => {
  const decision = hit()
  assert.equal(decision.schemaVersion, SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION)
  assert.equal(decision.operation, 'tts')
  // The ledger names the same cache address the generator would have looked up.
  assert.equal(decision.cacheKey, calculateSyntheticCacheKey(subject))
  assert.equal(decision.cacheKeyVersion, 'synthetic-block-cache-key/v1')
  assert.equal(decision.subjectHash, calculateSyntheticCacheDecisionSubjectHash(subject))
  // The audit digest is domain-separated, so it is never a second copy of the key.
  assert.notEqual(decision.subjectHash, decision.cacheKey)
  assert.equal(decision.decisionHash.length, 64)
  assert.equal(assertSyntheticCacheDecisionIntegrity(decision), decision)

  const avatarDecision = miss({ subject: avatarSubject })
  assert.equal(avatarDecision.operation, 'audio-avatar')
  assert.equal(avatarDecision.cacheKeyVersion, 'synthetic-avatar-cache-key/v1')
  assert.equal(avatarDecision.cacheKey, calculateSyntheticCacheKey(avatarSubject))

  // The same decision taken twice is the same content address: a replay can be
  // recognised and refused instead of booking its economy again.
  assert.equal(hit().decisionHash, decision.decisionHash)
  assert.notEqual(hit({ avoidedCostMinorUnits: 31, estimatedSavingMinorUnits: 31 }).decisionHash, decision.decisionHash)
  assert.notEqual(hit({ decidedAt: '2029-04-01T00:00:01.000Z' }).decisionHash, decision.decisionHash)
})

test('T-FR-105 the ledger never carries the script, the consent evidence or a provider secret', () => {
  const decision = hit()
  const serialized = JSON.stringify(decision)
  assert.doesNotMatch(serialized, /Primeira ideia do roteiro/)
  const keys = new Set(Object.keys(decision))
  for (const forbidden of SYNTHETIC_CACHE_DECISION_FORBIDDEN_FIELDS) {
    assert.equal(keys.has(forbidden), false, `${forbidden} must not be a ledger field`)
  }
  // Cost and currency are banned from the cache key precisely because they are
  // observational, which is why they belong in the ledger.
  assert.equal(keys.has('currency'), true)
  assert.equal(keys.has('avoidedCostMinorUnits'), true)
  assert.throws(
    () => assertSyntheticCacheDecisionPrivacy({ ...decision, exactText: 'Primeira ideia do roteiro.' }),
    /must not carry exactText/,
  )
})

test('T-FR-105 only a real reuse may claim avoided money', () => {
  assert.equal(hit().avoidedCostMinorUnits, 30)
  assert.throws(
    () => hit({ candidateGenerationId: null, candidateMasterId: null }),
    /must name the candidate it reused/,
  )
  assert.throws(
    () => hit({ avoidedCostMinorUnits: 0, estimatedSavingMinorUnits: 0 }),
    /must record the cost it actually avoided/,
  )
  for (const outcome of ['miss', 'forced-regenerate', 'blocked']) {
    const reasonCode = syntheticCacheDecisionReasonsFor(outcome)[0]
    assert.throws(
      () => createSyntheticCacheDecision({
        ...base, outcome, reasonCode, reason: 'nothing was reused here',
        estimatedSavingMinorUnits: 30, avoidedCostMinorUnits: 30,
      }),
      /avoided no cost and must not claim one/,
      `${outcome} must not claim an avoided cost`,
    )
  }
  assert.throws(
    () => hit({ estimatedSavingMinorUnits: 10 }),
    /cannot have avoided more than it estimated/,
  )
})

test('T-FR-105 a blocked decision never points at a reusable candidate', () => {
  const blocked = createSyntheticCacheDecision({
    ...base, outcome: 'blocked', reasonCode: 'CONSENT_REVOKED',
    reason: 'presenter policy refused this operation before any cache lookup',
  })
  assert.equal(blocked.candidateGenerationId, null)
  assert.equal(blocked.candidateMasterId, null)
  assert.equal(blocked.avoidedCostMinorUnits, 0)
  // An in-flight twin is a block that may still name the price it was quoted.
  const twin = createSyntheticCacheDecision({
    ...base, outcome: 'blocked', reasonCode: 'IN_FLIGHT_TWIN',
    reason: 'an in-flight generation already carries this exact cache key',
    estimatedSavingMinorUnits: 30,
  })
  assert.equal(twin.estimatedSavingMinorUnits, 30)
  assert.equal(twin.avoidedCostMinorUnits, 0)
  assert.throws(
    () => createSyntheticCacheDecision({
      ...base, outcome: 'blocked', reasonCode: 'CONSENT_REVOKED',
      reason: 'consent was revoked', candidateGenerationId: 'sbg-original',
    }),
    /must not name a reusable candidate/,
  )
})

test('T-FR-105 a reason code can only justify the outcomes it belongs to', () => {
  assert.deepEqual([...SYNTHETIC_CACHE_DECISION_OUTCOMES], ['hit', 'miss', 'forced-regenerate', 'blocked'])
  assert.deepEqual(syntheticCacheDecisionReasonsFor('hit'), ['CACHE_HIT_ELIGIBLE'])
  assert.deepEqual(syntheticCacheDecisionReasonsFor('forced-regenerate'), ['MUST_REGENERATE'])
  assert.deepEqual(syntheticCacheDecisionReasonsFor('blocked'), ['CONSENT_REVOKED', 'IN_FLIGHT_TWIN'])
  // A candidate can be refused for its absence, its blob, its bytes, its
  // output shape, its critic report or its rights: six different truths, all
  // ending in the same paid regeneration.
  assert.deepEqual(syntheticCacheDecisionReasonsFor('miss'), [
    'CACHE_MISS_NO_CANDIDATE', 'CANDIDATE_BLOB_UNAVAILABLE',
    'CANDIDATE_CHECKSUM_DRIFT', 'CANDIDATE_OUTPUT_MISMATCH',
    'CANDIDATE_CRITIC_REJECTED', 'CANDIDATE_RIGHTS_BLOCKED',
  ])
  // Every canonical code justifies at least one outcome and no more than it should.
  for (const code of SYNTHETIC_CACHE_DECISION_REASON_CODES) {
    const outcomes = SYNTHETIC_CACHE_DECISION_OUTCOMES
      .filter((outcome) => syntheticCacheDecisionReasonsFor(outcome).includes(code))
    assert.equal(outcomes.length, 1, `${code} must justify exactly one outcome`)
  }
  assert.throws(() => miss({ reasonCode: 'CONSENT_REVOKED' }), /cannot justify outcome miss/)
  assert.throws(() => miss({ reasonCode: 'NOT_A_CODE' }), /is not canonical/)
  assert.throws(() => miss({ outcome: 'skipped' }), /is not part of the ledger/)
})

test('T-FR-105 malformed ledger entries are refused instead of stored', () => {
  assert.throws(() => miss({ reason: 'no' }), /between 3 and 500 characters/)
  assert.throws(() => miss({ reason: 'x'.repeat(501) }), /between 3 and 500 characters/)
  assert.throws(() => miss({ currency: 'usd' }), /currency is invalid/)
  assert.throws(() => miss({ decidedAt: '2029-04-01' }), /canonical ISO instant/)
  assert.throws(() => miss({ policyVersion: '' }), /policyVersion is invalid/)
  assert.throws(() => miss({ criticReportHash: 'nope' }), /criticReportHash is invalid/)
  assert.throws(() => miss({ estimatedSavingMinorUnits: -1 }), /non-negative integer amount/)
  assert.throws(() => miss({ estimatedSavingMinorUnits: 1.5 }), /non-negative integer amount/)
})

test('T-FR-105 a tampered ledger entry stops verifying', () => {
  const decision = hit()
  assert.throws(
    () => assertSyntheticCacheDecisionIntegrity({ ...decision, avoidedCostMinorUnits: 3_000 }),
    /hash does not match its stored content/,
  )
  assert.throws(
    () => assertSyntheticCacheDecisionIntegrity({ ...decision, outcome: 'miss' }),
    /hash does not match its stored content/,
  )
  assert.throws(
    () => assertSyntheticCacheDecisionIntegrity({ ...decision, schemaVersion: 'synthetic-cache-decision/v0' }),
    /is not the ledger schema/,
  )
  assert.throws(
    () => assertSyntheticCacheDecisionIntegrity({ ...decision, cacheKey: 'short' }),
    /carries an invalid digest/,
  )
})
