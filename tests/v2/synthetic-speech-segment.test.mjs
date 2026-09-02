import assert from 'node:assert/strict'
import test from 'node:test'

import { createSyntheticMasterAsset } from '../../src/v2/domain/synthetic-master-asset.ts'
import {
  assertSyntheticSpeechSegmentIntegrity,
  catalogSyntheticSpeechSegments,
  normalizeSyntheticSpeechText,
} from '../../src/v2/domain/synthetic-speech-segment.ts'

const digest = (character) => character.repeat(64)

const master = createSyntheticMasterAsset({
  id: 'catalog-master', workspaceId: 'catalog-workspace', projectId: 'catalog-project',
  projectVersionId: 'catalog-version', profileId: 'ana', profileSnapshotId: 'ana:v2', profileVersion: 2,
  consentSnapshotHash: digest('e'), authorizationHash: digest('f'), rightsSnapshotId: 'rights-1',
  artifacts: [
    { role: 'provider-original', artifactId: 'artifact-original', sha256: digest('a'), byteSize: 2_048, mediaType: 'video', container: 'mp4' },
    { role: 'normalized-video', artifactId: 'artifact-normalized', sha256: digest('b'), byteSize: 3_072, mediaType: 'video', container: 'mp4' },
    { role: 'final-audio', artifactId: 'artifact-audio', sha256: digest('c'), byteSize: 1_024, mediaType: 'audio', container: 'wav' },
    { role: 'alignment', artifactId: 'artifact-alignment', sha256: digest('d'), byteSize: 512, mediaType: 'data', container: 'json' },
  ],
  scriptText: 'Primeira ideia. Segunda ideia forte.',
  alignmentHash: digest('1'), locale: 'pt-BR',
  durationMs: 4_000, audioDurationMs: 4_000, videoDurationMs: 4_000,
  provenance: {
    adapterId: 'heygen-v3', adapterVersion: '3.0.0', capability: 'audio-avatar', modelRef: null,
    adapterConfigHash: digest('2'), providerJobId: 'job-1', providerJobRef: 'heygen_job_1',
  },
  cost: { currency: 'USD', minorUnits: 150, latencyMs: 8_000 },
  critic: { reportId: 'critic-1', reportHash: digest('3'), decision: 'approved' },
  lineage: ['generation-1', 'generation-2'],
  createdAt: '2029-06-01T00:00:00.000Z',
})

const identity = {
  actorIdentityId: 'ana-identity', profileId: 'ana', profileVersion: 2,
  voiceId: 'voice_ana', voiceVersion: 1, avatarIdentityRef: 'avatar_ana',
  emotion: null, wardrobe: 'blazer azul', background: 'estúdio neutro', framing: 'meio-primeiro-plano',
}

const blocks = [
  { blockId: 'block-1', exactText: 'Primeira ideia.', occurrence: 1 },
  { blockId: 'block-2', exactText: 'Segunda ideia forte.', occurrence: 1 },
]

// A real gap (silence) sits between the two sentences.
const words = [
  { word: 'Primeira', startMs: 0, endMs: 700 },
  { word: 'ideia.', startMs: 700, endMs: 1_200 },
  { word: 'Segunda', startMs: 1_600, endMs: 2_300 },
  { word: 'ideia', startMs: 2_300, endMs: 2_900 },
  { word: 'forte.', startMs: 2_900, endMs: 3_800 },
]

const catalog = (overrides = {}) => catalogSyntheticSpeechSegments({
  master, blocks, words, identity,
  createId: (block) => `segment-${block.blockId}`,
  ...overrides,
})

test('T-FR-104 catalogued segments are deterministic, half-open and carry reuse identity', () => {
  const segments = catalog()
  assert.equal(segments.length, 2)

  assert.equal(segments[0].startMs, 0)
  assert.equal(segments[0].endMs, 1_200)
  assert.equal(segments[1].startMs, 1_600)
  assert.equal(segments[1].endMs, 3_800)
  // Half-open ranges never overlap, and the silence between them stays a real
  // gap instead of being absorbed to fake a contiguous timeline.
  assert.ok(segments[0].endMs < segments[1].startMs)

  assert.equal(segments[0].exactText, 'Primeira ideia.')
  assert.equal(segments[0].normalizedText, 'primeira ideia')
  assert.equal(segments[1].normalizedText, 'segunda ideia forte')
  assert.equal(segments[0].words.length, 2)
  assert.equal(segments[1].words.length, 3)

  // Reuse identity, rights and criticism travel with every segment.
  assert.equal(segments[0].identity.wardrobe, 'blazer azul')
  assert.equal(segments[0].identity.background, 'estúdio neutro')
  assert.equal(segments[0].identity.framing, 'meio-primeiro-plano')
  assert.equal(segments[0].identity.emotion, null, 'emotion has no measured source and must not be invented')
  assert.equal(segments[0].consentSnapshotHash, digest('e'))
  assert.equal(segments[0].rightsSnapshotId, 'rights-1')
  assert.equal(segments[0].criticReportHash, digest('3'))
  assert.equal(segments[0].masterHash, master.masterHash)

  // No media is duplicated: segments point at the master's own artifacts.
  assert.equal(segments[0].audioArtifactId, 'artifact-audio')
  assert.equal(segments[0].videoArtifactId, 'artifact-normalized')
  assert.equal(segments[0].alignmentArtifactId, 'artifact-alignment')

  // Deterministic and content-addressed.
  assert.deepEqual(catalog().map((segment) => segment.segmentHash), segments.map((segment) => segment.segmentHash))
  assert.notEqual(segments[0].segmentHash, segments[1].segmentHash)
  for (const segment of segments) assert.equal(assertSyntheticSpeechSegmentIntegrity(segment), segment)
})

test('T-FR-104 cataloguing fails closed when the alignment does not describe the blocks', () => {
  assert.throws(
    () => catalog({ words: [...words.slice(0, 2), { word: 'Terceira', startMs: 1_600, endMs: 2_300 }, ...words.slice(3)] }),
    /does not match block block-2 word by word/,
  )
  assert.throws(
    () => catalog({ words: words.slice(0, 4) }),
    /does not match block block-2 word by word/,
  )
  assert.throws(
    () => catalog({ words: [...words, { word: 'sobra', startMs: 3_800, endMs: 3_900 }] }),
    /words no approved block claims/,
  )
  assert.throws(
    () => catalog({ words: [{ word: 'Primeira', startMs: 0, endMs: 700 }, { word: 'ideia.', startMs: 600, endMs: 1_200 }, ...words.slice(2)] }),
    /alignment words overlap/,
  )
  assert.throws(() => catalog({ blocks: [] }), /no approved blocks cannot be catalogued/)
  assert.throws(() => catalog({ words: [] }), /carries no words/)
})

test('T-FR-104 a master without a normalization stage cuts segments from the provider video', () => {
  // Masters normally carry three roles today, so the catalog must name the
  // provider's own video instead of assuming a normalized track exists.
  const unnormalized = createSyntheticMasterAsset({
    ...master,
    artifacts: master.artifacts.filter(({ role }) => role !== 'normalized-video'),
  })
  const segments = catalogSyntheticSpeechSegments({
    master: unnormalized, blocks, words, identity,
    createId: (block) => `segment-${block.blockId}`,
  })
  assert.equal(segments.length, 2)
  assert.equal(segments[0].videoArtifactId, 'artifact-original')
  assert.equal(segments[0].audioArtifactId, 'artifact-audio')
  // A different master is a different segment address.
  assert.notEqual(segments[0].segmentHash, catalog()[0].segmentHash)
})

test('T-FR-104 segment normalization is stable across punctuation, case and accents', () => {
  assert.equal(normalizeSyntheticSpeechText('  Olá,   MUNDO!  '), 'olá mundo')
  // Edge punctuation is stripped on both sides of the word-by-word match, so
  // currency and dash markers never decide whether a block aligns.
  assert.equal(normalizeSyntheticSpeechText('R$ 1.500,00 — pronto?'), 'r 1.500,00 pronto')
  assert.equal(normalizeSyntheticSpeechText('1,5 milhão'), '1,5 milhão')
  assert.equal(normalizeSyntheticSpeechText('Ideia.'), normalizeSyntheticSpeechText('ideia'))
})
