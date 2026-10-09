import assert from 'node:assert/strict'
import test from 'node:test'

import { createTemporalProducerEnvelope } from '../../src/v2/domain/temporal-producer-envelope.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'

function fixture() {
  const sha = (value) => value.repeat(64)
  const pts = [0, 33, 67, 100]
  const scores = [0.01, 0.9, 0.02]
  const shot = scores.map((changeScore, index) => ({
    startSourcePts: pts[index], endSourcePts: pts[index + 1],
    previousFrame: index, currentFrame: index + 1,
    previousGridSha256: sha('a'), currentGridSha256: sha('b'), changeScore,
  }))
  const motion = [0, 2].map((index) => ({
    startSourcePts: pts[index], endSourcePts: pts[index + 1],
    previousFrame: index, currentFrame: index + 1,
    vectorPxPerSecond: { x: 0, y: 0 }, residualMeanAbsoluteLuma: 0.01,
    ambiguity: 0.2,
  }))
  return {
    id: 'temporal-envelope-1', workspaceId: 'workspace-1', projectId: 'project-1',
    projectVersionId: 'version-1', operationId: 'operation-1', operationAttempt: 1,
    operationFenceHash: sha('1'), sourceArtifactId: 'source-1', sourceSha256: sha('2'),
    editPlanSnapshotId: 'edit-1', editPlanSnapshotHash: sha('3'),
    timelineDurationFrames: 4, timelineFps: { num: 30, den: 1 },
    timeMap: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 4,
      timelineInFrame: 0, timelineOutFrame: 4, rate: 1 }],
    analysis: { algorithmVersion: 'visual-temporal-grid/v1', sourceSha256: sha('2'),
      sourceFps: { num: 30, den: 1 }, sourceTimebase: { num: 1, den: 1000 },
      sourceClock: 'constant-frame-rate', sourceWidth: 640, sourceHeight: 360,
      observedFrameCount: 4, assessedDomain: { startSourcePts: 0, endSourcePts: 100 },
      analysisGrid: { width: 160, height: 90 },
      runtime: { ffmpegSha256: sha('4'), ffprobeSha256: sha('5') },
      shot: { observations: shot, coverage: [{ startSourcePts: 0, endSourcePts: 100 }], gaps: [] },
      motion: { observations: motion,
        coverage: [{ startSourcePts: 0, endSourcePts: 33 },
          { startSourcePts: 67, endSourcePts: 100 }],
        gaps: [{ startSourcePts: 33, endSourcePts: 67,
          reasonCode: 'UNRELIABLE_FRAME_DIFFERENCE' }] },
    }, createdAt: '2026-10-08T20:00:00.000Z',
  }
}

test('temporal envelope seals raw scores and separate shot/motion coverage with final-frame gap', () => {
  const input = fixture()
  const envelope = createTemporalProducerEnvelope(input)
  assert.equal(envelope.authority, 'server-produced')
  assert.equal(envelope.interpretation, 'raw-measurements-only')
  assert.equal(envelope.faceSafety, 'unknown')
  assert.match(envelope.envelopeHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(envelope.shot.coverage, [{ startTimelineFrame: 0, endTimelineFrame: 3 }])
  assert.deepEqual(envelope.shot.gaps, [{ startTimelineFrame: 3, endTimelineFrame: 4,
    reasonCode: 'NO_ADJACENT_OBSERVED_PAIR' }])
  assert.deepEqual(envelope.motion.coverage, [
    { startTimelineFrame: 0, endTimelineFrame: 1 },
    { startTimelineFrame: 2, endTimelineFrame: 3 },
  ])
  assert.deepEqual(envelope.motion.gaps, [
    { startTimelineFrame: 1, endTimelineFrame: 2,
      reasonCode: 'UNRELIABLE_FRAME_DIFFERENCE' },
    { startTimelineFrame: 3, endTimelineFrame: 4,
      reasonCode: 'NO_ADJACENT_OBSERVED_PAIR' },
  ])
  assert.equal(envelope.shot.observations[1].changeScore, 0.9)
  assert.equal(Object.isFrozen(envelope.analysis.shot.observations), true)
  input.analysis.shot.observations[0].changeScore = 0.7
  assert.equal(envelope.shot.observations[0].changeScore, 0.01)
})

test('temporal projection omits the pair crossing an editorial source boundary', () => {
  const input = fixture()
  input.timeMap = [
    { clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 2,
      timelineInFrame: 0, timelineOutFrame: 2, rate: 1 },
    { clipId: 'clip-2', sourceInFrame: 2, sourceOutFrame: 4,
      timelineInFrame: 2, timelineOutFrame: 4, rate: 1 },
  ]
  const envelope = createTemporalProducerEnvelope(input)
  assert.deepEqual(envelope.shot.coverage, [
    { startTimelineFrame: 0, endTimelineFrame: 1 },
    { startTimelineFrame: 2, endTimelineFrame: 3 },
  ])
  assert.deepEqual(envelope.shot.gaps, [
    { startTimelineFrame: 1, endTimelineFrame: 2,
      reasonCode: 'NO_ADJACENT_OBSERVED_PAIR' },
    { startTimelineFrame: 3, endTimelineFrame: 4,
      reasonCode: 'NO_ADJACENT_OBSERVED_PAIR' },
  ])
})

test('temporal envelope rejects unsupported clocks, source drift and fabricated pair coverage', () => {
  const mutations = [
    (value) => { value.timeMap[0].rate = 2 },
    (value) => { value.analysis.sourceSha256 = 'f'.repeat(64) },
    (value) => { value.analysis.shot.observations[1].startSourcePts = 34 },
    (value) => { value.analysis.motion.gaps[0].reasonCode = 'UNKNOWN' },
    (value) => { value.analysis.motion.observations[0].vectorPxPerSecond.x = Infinity },
    (value) => { value.analysis.shot.observations[0].extra = 'caller' },
    (value) => { value.timeMap[0].sourceOutFrame = 301 },
    (value) => { value.analysis.motion.gaps = [] },
  ]
  for (const mutate of mutations) {
    const input = fixture()
    mutate(input)
    assert.throws(() => createTemporalProducerEnvelope(input),
      (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT')
  }
})
