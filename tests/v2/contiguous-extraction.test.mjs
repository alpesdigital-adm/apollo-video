import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateContiguousMomentEvaluationHash,
  extractContiguous,
} from '../../src/v2/domain/contiguous-extraction.ts'

const sha = (value) =>
  value.repeat(64).slice(0, 64)

function score(value, evidence) {
  return { value, evidenceRefs: [evidence] }
}

function moment(overrides = {}) {
  const value = {
    id: 'moment-contiguous-1',
    momentHash: sha('a'),
    evaluationId: 'evaluation-contiguous-1',
    evaluationHash: '',
    indexRunId: 'long-form-index-run-1',
    sourceArtifactId: 'artifact-contiguous-1',
    sourceArtifactSha256: sha('b'),
    sourceManifestId: 'manifest-contiguous-1',
    sourceManifestHash: sha('c'),
    chapterId: 'chapter-contiguous-1',
    topic: 'aquisição por anúncios',
    objectiveTags: ['education'],
    recommendedRangeMs: [3_500_000, 3_610_000],
    semanticRangeMs: [3_495_000, 3_615_000],
    sourceDurationMs: 7_200_000,
    rightsSnapshotId: 'rights-contiguous-1',
    rightsStatus: 'approved',
    consentStatus: 'not-required',
    scores: {
      selfContained: score(0.9, 'evidence-self-contained-1'),
      density: score(0.8, 'evidence-density-1'),
      integrity: score(1, 'evidence-integrity-1'),
      audio: score(0.9, 'evidence-audio-1'),
      visual: score(0.8, 'evidence-visual-1'),
    },
    ...overrides,
  }
  return {
    ...value,
    evaluationHash:
      overrides.evaluationHash ??
      calculateContiguousMomentEvaluationHash({
        momentId: value.id,
        momentHash: value.momentHash,
        indexRunId: value.indexRunId,
        objectiveTags: value.objectiveTags,
        semanticRangeMs: value.semanticRangeMs,
        scores: value.scores,
      }),
  }
}

function request(moments) {
  return {
    id: 'contiguous-extraction-1',
    workspaceId: 'workspace-contiguous-1',
    projectId: 'project-contiguous-1',
    objective: 'education',
    topic: 'aquisição por anúncios',
    targetDurationMs: 120_000,
    toleranceMs: 15_000,
    fps: 30,
    moments,
  }
}

test('T-FR-134 selects one semantic two-minute range and compiles canonical single-source plans', () => {
  const result = extractContiguous(request([
    moment(),
    moment({
      id: 'moment-contiguous-wrong-topic',
      momentHash: sha('d'),
      topic: 'outro assunto',
      semanticRangeMs: [0, 120_000],
      recommendedRangeMs: [0, 120_000],
      scores: {
        selfContained: score(1, 'evidence-self-contained-2'),
        density: score(1, 'evidence-density-2'),
        integrity: score(1, 'evidence-integrity-2'),
        audio: score(1, 'evidence-audio-2'),
        visual: score(1, 'evidence-visual-2'),
      },
    }),
  ]))

  assert.deepEqual(
    result.candidates[0].sourceRangeMs,
    [3_495_000, 3_615_000],
  )
  assert.equal(result.storyPlan.mode, 'contiguous')
  assert.equal(result.storyPlan.blocks.length, 1)
  assert.equal(
    result.storyPlan.blocks[0].sourceCandidateIds[0],
    'moment-contiguous-1',
  )
  assert.equal(result.editPlan.synthesizedRanges, false)
  assert.equal(result.editPlan.videoTracks[0].clips.length, 1)
  assert.equal(result.editPlan.durationFrames, 3_600)
  assert.equal(
    result.editPlan.movementPolicy.automaticZoom,
    false,
  )
  assert.match(result.resultHash, /^[a-f0-9]{64}$/)
})

test('T-FR-134 ranks all five evidenced quality dimensions and breaks ties deterministically', () => {
  const lower = moment({
    id: 'moment-contiguous-lower',
    momentHash: sha('d'),
    semanticRangeMs: [1_000_000, 1_120_000],
    recommendedRangeMs: [1_005_000, 1_115_000],
    scores: {
      selfContained: score(0.7, 'lower-self'),
      density: score(0.7, 'lower-density'),
      integrity: score(0.7, 'lower-integrity'),
      audio: score(0.7, 'lower-audio'),
      visual: score(0.7, 'lower-visual'),
    },
  })
  const result = extractContiguous(request([
    lower,
    moment(),
  ]))

  assert.equal(
    result.candidates[0].sourceMomentId,
    'moment-contiguous-1',
  )
  assert.deepEqual(
    Object.keys(result.candidates[0].scoreBreakdown),
    [
      'selfContained',
      'density',
      'integrity',
      'audio',
      'visual',
      'duration',
    ],
  )
  assert.equal(result.candidates[0].evidenceRefs.length, 5)
})

test('T-FR-134 fails closed on missing evidence, unauthorized moments and non-semantic ranges', () => {
  assert.throws(
    () => extractContiguous(request([
      moment({
        scores: {
          ...moment().scores,
          audio: score(0.9, ''),
        },
      }),
    ])),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => extractContiguous(request([
      moment({ rightsStatus: 'blocked' }),
    ])),
    (error) => error.code === 'PRECONDITION_REQUIRED',
  )
  assert.throws(
    () => extractContiguous(request([
      moment({
        semanticRangeMs: [3_505_000, 3_600_000],
      }),
    ])),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})

test('T-FR-134 binds output identity to source lineage, quality evidence and policy', () => {
  const first = extractContiguous(request([moment()]))
  const replay = extractContiguous(request([moment()]))
  const changed = extractContiguous(request([
    moment({
      scores: {
        ...moment().scores,
        visual: score(0.79, 'evidence-visual-1'),
      },
    }),
  ]))

  assert.equal(first.resultHash, replay.resultHash)
  assert.notEqual(first.resultHash, changed.resultHash)
  assert.notEqual(
    first.selectedCandidateHash,
    changed.selectedCandidateHash,
  )
  assert.ok(
    first.editPlan.lineageRefs.includes('rights-contiguous-1'),
  )
  assert.ok(
    first.editPlan.lineageRefs.includes('evidence-integrity-1'),
  )
})
