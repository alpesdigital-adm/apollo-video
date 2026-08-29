import assert from 'node:assert/strict'
import test from 'node:test'

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
