import assert from 'node:assert/strict'
import test from 'node:test'

import { createSyntheticAudioMasterService } from '../../src/v2/application/synthetic-audio-masters.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { assertSyntheticAudioMaster, createSyntheticAudioMaster, createSyntheticAvatarAudioRange } from '../../src/v2/domain/synthetic-audio-master.ts'

const hash = (value) => value.repeat(64)
function master(overrides = {}) {
  return createSyntheticAudioMaster({
    id: 'audio-master-one', workspaceId: 'workspace-one', projectId: 'project-one', projectVersionId: 'version-one', profileSnapshotId: 'profile-one',
    source: { kind: 'tts', text: 'Olá, mundo!', providerJobId: 'provider-job-tts-one' },
    audio: { artifactId: 'artifact-audio-one', artifactSha256: hash('a'), durationMs: 1_250, locale: 'pt-BR' },
    alignmentEvidence: { artifactId: 'artifact-alignment-one', artifactSha256: hash('b') },
    words: [{ word: 'Olá', startMs: 0, endMs: 500, confidence: 0.99 }, { word: 'mundo', startMs: 550, endMs: 1_200, confidence: 0.98 }],
    approvedAt: '2029-01-01T00:00:00.000Z', approvalCriticHash: hash('c'), createdAt: '2029-01-01T00:00:01.000Z',
    ...overrides,
  })
}

test('T-FR-100 seals approved TTS audio and alignment before avatar ranges exist', () => {
  const value = master()
  assertSyntheticAudioMaster(value)
  assert.match(value.masterHash, /^[a-f0-9]{64}$/)
  assert.notEqual(value.wordsHash, value.masterHash)
})

test('T-FR-100 accepts uploaded audio as a canonical approved master', () => {
  const value = master({ source: { kind: 'uploaded' } })
  assert.equal(value.source.kind, 'uploaded')
  assert.equal(value.audio.durationMs, 1_250)
})

test('T-FR-100 audio timing governs avatar range and survives provider-only changes', () => {
  const value = master()
  const first = createSyntheticAvatarAudioRange({ master: value, startWordIndex: 0, endWordIndex: 2 })
  const anotherProvider = createSyntheticAvatarAudioRange({ master: value, startWordIndex: 0, endWordIndex: 2 })
  assert.deepEqual(first, anotherProvider)
  assert.deepEqual([first.startMs, first.endMs, first.durationMs], [0, 1_200, 1_200])
})

test('T-FR-100 regenerated audio changes the master and every dependent range hash', () => {
  const original = master()
  const regenerated = master({
    id: 'audio-master-two',
    source: { kind: 'tts', text: 'Olá, mundo!', providerJobId: 'provider-job-tts-two' },
    audio: { ...original.audio, artifactId: 'artifact-audio-two', artifactSha256: hash('d'), durationMs: 1_400 },
    words: [{ word: 'Olá', startMs: 0, endMs: 600, confidence: 0.99 }, { word: 'mundo', startMs: 650, endMs: 1_350, confidence: 0.98 }],
  })
  assert.notEqual(regenerated.masterHash, original.masterHash)
  assert.notEqual(createSyntheticAvatarAudioRange({ master: regenerated, startWordIndex: 0, endWordIndex: 2 }).rangeHash, createSyntheticAvatarAudioRange({ master: original, startWordIndex: 0, endWordIndex: 2 }).rangeHash)
})

test('T-FR-100 fails closed on text/alignment mismatch, timing drift and stored tamper', () => {
  assert.throws(() => master({ source: { kind: 'tts', text: 'Outro texto', providerJobId: 'provider-job-tts-one' } }), /does not match/)
  assert.throws(() => master({ words: [{ word: 'Olá', startMs: 0, endMs: 700, confidence: 1 }, { word: 'mundo', startMs: 600, endMs: 1_200, confidence: 1 }] }), /timing/)
  const value = master()
  assert.throws(() => assertSyntheticAudioMaster({ ...value, audio: { ...value.audio, durationMs: 2_000 } }), /hash/)
})

test('T-FR-100 service refuses caller word timing that differs from the approved stored alignment', async () => {
  const workspaceId = 'workspace-audio-service'
  const projectId = 'project-audio-service'
  const profileSnapshotId = 'profile-audio-service:v1'
  const audioArtifactId = 'artifact-audio-service'
  const alignmentArtifactId = 'artifact-alignment-service'
  const reportHash = hash('c')
  let creates = 0
  const rightsByArtifact = new Map([audioArtifactId, alignmentArtifactId].map((artifactId, index) => [
    artifactId,
    createAssetRightsSnapshot({
      id: `rights-audio-service-${index}`, workspaceId, artifactId, sequence: 1,
      draft: {
        status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedSyntheticOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
        consent: { status: 'not-required', allowedUses: [] },
      },
      createdBy: { type: 'api-client', id: 'audio-service-client' }, createdAt: '2029-01-01T00:00:00.000Z',
    }),
  ]))
  const actor = Object.freeze({
    clientId: 'audio-service-client', credentialId: 'audio-service-credential', workspaceId,
    environment: 'production', actor: Object.freeze({ type: 'api-client', id: 'audio-service-client' }),
    scopes: new Set(['projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active',
    auditContext: Object.freeze({
      clientId: 'audio-service-client', credentialId: 'audio-service-credential', workspaceId,
      environment: 'production', actor: Object.freeze({ type: 'api-client', id: 'audio-service-client' }),
    }),
  })
  const profile = {
    id: 'profile-audio-service', version: 1, status: 'active', snapshotHash: hash('p'),
    consent: {
      granted: true, revokedAt: null, expiresAt: '2030-01-01T00:00:00.000Z',
      allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
      allowedOperations: ['tts', 'audio-avatar'],
    },
  }
  const execute = createSyntheticAudioMasterService({
    repository: {
      findReplay: async () => null,
      create: async () => { creates += 1; throw new Error('must not persist') },
    },
    projects: { read: async () => ({ project: { currentVersionId: 'version-audio-service' }, version: { id: 'version-audio-service' } }) },
    profiles: { readProfile: async () => ({ snapshot: profile, profileSnapshotId }) },
    providerJobs: { read: async () => ({ job: {
      status: 'approved', operation: 'tts', authorization: { profileSnapshotId, profileSnapshotHash: profile.snapshotHash },
      resultArtifact: { artifactId: audioArtifactId, artifactSha256: hash('a') }, criticResultHash: reportHash,
      input: { scriptHash: hash('s'), text: 'Olá mundo', locale: 'pt-BR' }, completedAt: '2029-01-01T00:00:01.000Z',
    } }) },
    artifacts: { findById: async (_workspaceId, artifactId) => artifactId === audioArtifactId
      ? { id: artifactId, artifactKey: 'audio-service.mp3', sha256: hash('a'), byteSize: 32n, status: 'available', mediaType: 'audio' }
      : { id: artifactId, artifactKey: 'audio-service-alignment.json', sha256: hash('b'), byteSize: 32n, status: 'available', mediaType: 'data' } },
    rights: { findCurrentForArtifacts: async () => rightsByArtifact },
    criticReports: { readByHash: async () => ({
      decision: 'approved', expectationHash: hash('e'), evaluationContextHash: hash('c'), thresholdsVersion: 'synthetic-critic-thresholds/tts/v2',
      capability: 'tts', adapterId: 'elevenlabs-tts', reportHash, projectId, artifactSha256: hash('a'),
      profileSnapshotId, scriptHash: hash('s'), alignmentArtifactId,
    }) },
    alignment: { readWords: async () => [{ word: 'Olá', startMs: 0, endMs: 400 }, { word: 'mundo', startMs: 450, endMs: 1_000 }] },
    audioDurations: { measure: async () => 1_000 },
    clock: () => new Date('2029-01-01T00:00:02.000Z'), createId: () => 'audio-master-service',
  })

  await assert.rejects(execute({
    workspaceId, projectId, projectVersionId: 'version-audio-service', profileSnapshotId,
    source: { kind: 'tts', text: 'Olá mundo', providerJobId: 'provider-job-audio-service' },
    audioArtifactId, alignmentEvidenceArtifactId: alignmentArtifactId, durationMs: 1_000, locale: 'pt-BR',
    words: [{ word: 'Olá', startMs: 0, endMs: 500, confidence: 0.99 }, { word: 'mundo', startMs: 500, endMs: 1_000, confidence: 0.98 }],
    approvedAt: '2029-01-01T00:00:01.000Z', approvalCriticHash: reportHash,
    use: 'ads', market: 'BRA', actor, idempotencyKey: 'audio-service-key',
  }), (error) => error.code === 'PERSISTENCE_CONFLICT' && /persisted alignment/.test(error.message))
  assert.equal(creates, 0)
})
