import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertSyntheticPresenterPolicy,
  evaluateSyntheticPresenterPolicy,
} from '../../src/v2/domain/synthetic-presenter-policy-engine.ts'
import { createSyntheticPresenterProfileSnapshot } from '../../src/v2/domain/synthetic-production.ts'

const hash = (character) => character.repeat(64)
const now = new Date('2026-08-29T12:00:00.000Z')

const snapshot = (overrides = {}, consentOverrides = {}) => createSyntheticPresenterProfileSnapshot({
  id: 'policy-presenter', version: 1, actorIdentityId: 'policy-identity',
  avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_policy' },
  voice: { id: 'voice_policy', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
  defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
  consent: {
    id: 'policy-consent', evidenceArtifactId: 'policy-evidence', evidenceSha256: hash('a'), granted: true,
    allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
    allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
    ...consentOverrides,
  },
  ...overrides,
})

const context = (overrides = {}) => ({
  operation: 'tts', use: 'ads', market: 'BRA', locale: 'pt-BR',
  workspaceId: 'policy-workspace', now, ...overrides,
})

const codesFor = (input) => evaluateSyntheticPresenterPolicy(input).reasons.map(({ code }) => code)

test('T-FR-103 a valid active consented profile is allowed for classified operations', () => {
  for (const operation of ['tts', 'audio-avatar']) {
    const decision = evaluateSyntheticPresenterPolicy({
      snapshot: snapshot(), snapshotWorkspaceId: 'policy-workspace', context: context({ operation }),
    })
    assert.equal(decision.allowed, true, JSON.stringify(decision.reasons))
  }
  assert.doesNotThrow(() => assertSyntheticPresenterPolicy({
    snapshot: snapshot(), snapshotWorkspaceId: 'policy-workspace', context: context(),
  }))
})

test('T-FR-103 unclassified operations are denied fail-closed', () => {
  for (const operation of ['voice-clone', 'lip-sync', 'face-swap', 'anything-new']) {
    const codes = codesFor({ snapshot: snapshot(), snapshotWorkspaceId: 'policy-workspace', context: context({ operation }) })
    assert.ok(codes.includes('OPERATION_UNCLASSIFIED'), `${operation}: ${codes}`)
  }
})

test('T-FR-103 every consent dimension denies with its own reason', () => {
  assert.ok(codesFor({ snapshot: snapshot({}, { granted: false }), snapshotWorkspaceId: 'policy-workspace', context: context() }).includes('CONSENT_MISSING'))
  assert.ok(codesFor({ snapshot: snapshot({}, { revokedAt: '2026-01-01T00:00:00.000Z' }), snapshotWorkspaceId: 'policy-workspace', context: context() }).includes('CONSENT_REVOKED'))
  assert.ok(codesFor({ snapshot: snapshot({}, { expiresAt: '2026-01-01T00:00:00.000Z' }), snapshotWorkspaceId: 'policy-workspace', context: context() }).includes('CONSENT_EXPIRED'))
  assert.ok(codesFor({ snapshot: snapshot(), snapshotWorkspaceId: 'policy-workspace', context: context({ use: 'organic' }) }).includes('USE_NOT_ALLOWED'))
  assert.ok(codesFor({ snapshot: snapshot(), snapshotWorkspaceId: 'policy-workspace', context: context({ market: 'USA' }) }).includes('MARKET_NOT_ALLOWED'))
  assert.ok(codesFor({ snapshot: snapshot(), snapshotWorkspaceId: 'policy-workspace', context: context({ locale: 'en-US' }) }).includes('LOCALE_NOT_ALLOWED'))
  assert.ok(codesFor({ snapshot: snapshot({}, { allowedOperations: ['audio-avatar'] }), snapshotWorkspaceId: 'policy-workspace', context: context() }).includes('OPERATION_NOT_CONSENTED'))
  assert.ok(codesFor({ snapshot: snapshot({ status: 'disabled' }), snapshotWorkspaceId: 'policy-workspace', context: context() }).includes('PROFILE_NOT_ACTIVE'))
  assert.ok(codesFor({ snapshot: snapshot(), snapshotWorkspaceId: 'other-workspace', context: context() }).includes('WORKSPACE_MISMATCH'))
})

test('T-FR-103 a future revocation is not yet a revocation', () => {
  const decision = evaluateSyntheticPresenterPolicy({
    snapshot: snapshot({}, { revokedAt: '2029-01-01T00:00:00.000Z' }),
    snapshotWorkspaceId: 'policy-workspace', context: context(),
  })
  assert.equal(decision.allowed, true, JSON.stringify(decision.reasons))
})

test('T-FR-103 a tampered snapshot payload is denied fail-closed', () => {
  const tampered = { ...snapshot(), disclosure: 'Divulgação adulterada depois do hash' }
  assert.ok(codesFor({ snapshot: tampered, snapshotWorkspaceId: 'policy-workspace', context: context() }).includes('PAYLOAD_TAMPERED'))
})

test('T-FR-103 the head expresses the actor\'s latest will over older snapshots', () => {
  const old = snapshot()
  const revokedCurrent = snapshot({ version: 3 }, { id: 'policy-consent-3', revokedAt: '2026-06-01T00:00:00.000Z' })
  const codes = codesFor({
    snapshot: old, snapshotWorkspaceId: 'policy-workspace',
    head: { currentVersion: 3, current: revokedCurrent }, context: context(),
  })
  assert.ok(codes.includes('CURRENT_CONSENT_REVOKED'), String(codes))
  const disabledCurrent = snapshot({ version: 3, status: 'disabled' }, { id: 'policy-consent-3' })
  assert.ok(codesFor({
    snapshot: old, snapshotWorkspaceId: 'policy-workspace',
    head: { currentVersion: 3, current: disabledCurrent }, context: context(),
  }).includes('CURRENT_VERSION_NOT_ACTIVE'))
  // A healthy newer version does NOT block a pinned older snapshot unless the
  // caller explicitly requires the active version.
  const healthyCurrent = snapshot({ version: 3 }, { id: 'policy-consent-3' })
  const pinned = evaluateSyntheticPresenterPolicy({
    snapshot: old, snapshotWorkspaceId: 'policy-workspace',
    head: { currentVersion: 3, current: healthyCurrent }, context: context(),
  })
  assert.equal(pinned.allowed, true, JSON.stringify(pinned.reasons))
  assert.ok(codesFor({
    snapshot: old, snapshotWorkspaceId: 'policy-workspace',
    head: { currentVersion: 3, current: healthyCurrent }, context: context({ requireActiveVersion: true }),
  }).includes('VERSION_SUPERSEDED'))
})

test('T-FR-103 the assertion carries every denial reason for auditability', () => {
  assert.throws(
    () => assertSyntheticPresenterPolicy({
      snapshot: snapshot({ status: 'disabled' }, { granted: false }),
      snapshotWorkspaceId: 'policy-workspace',
      context: context({ operation: 'voice-clone' }),
    }),
    (error) => error.code === 'ASSET_RIGHTS_BLOCKED' &&
      /OPERATION_UNCLASSIFIED/.test(error.message) &&
      /PROFILE_NOT_ACTIVE/.test(error.message) &&
      /CONSENT_MISSING/.test(error.message),
  )
})
