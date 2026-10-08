import assert from 'node:assert/strict'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runNextPerceptionProducerOperationService } from '../../src/v2/application/run-perception-producer-worker.ts'

const sha = (letter) => letter.repeat(64)
const claim = {
  operationId: 'operation-ocr-1', workspaceId: 'workspace-ocr-1', projectId: 'project-ocr-1',
  projectVersionId: 'version-ocr-1', sourceArtifactId: 'source-ocr-1', sourceSha256: sha('a'),
  sourceByteSize: 100, artifactKey: 'source.mp4', editPlanSnapshotId: 'edit-plan-ocr-1',
  editPlanSnapshotHash: sha('b'), sampleIntervalFrames: 3, attempt: 1,
  timeMap: [{ clipId: 'clip-ocr-1', sourceInFrame: 0, sourceOutFrame: 4,
    timelineInFrame: 0, timelineOutFrame: 4, rate: 1 }],
  timelineDurationFrames: 4, timelineFps: { num: 30, den: 1 },
}

test('OCR worker publishes a fenced envelope with explicit unsampled gaps and unknown face safety', async () => {
  const stages = [], publications = []
  let cleaned = 0
  const repository = {
    async claimNext() { return claim },
    async heartbeat() { return true },
    async advancePhase({ phase }) { stages.push(phase); return true },
    async currentFenceHash() { return sha('c') },
    async publish(value) { publications.push(value.envelope) },
    async failAttempt() { assert.fail('successful producer must not fail') },
  }
  const result = await runNextPerceptionProducerOperationService({
    repository,
    materializer: { async materialize() { return { path: 'C:/controlled/source.mp4', sha256: sha('a'), byteSize: 100 } },
      async cleanup() { cleaned += 1 } },
    adapter: { async analyze() { return {
      sourceTimebase: { num: 1, den: 1_000_000 }, sourceFps: { num: 30, den: 1 },
      sourcePtsStart: 0, sourceClock: 'constant-frame-rate',
      producer: { name: 'tesseract', executableSha256: sha('d'), executableVersion: 'tesseract 5.5',
        traineddata: [{ language: 'por', sha256: sha('e'), licenseSha256: sha('f') }] },
      runtime: { ffmpegSha256: sha('1'), ffprobeSha256: sha('2') },
      samples: [
        { sourceFrame: 0, sourcePts: 0, sourcePtsEvidenceHash: sha('3'), imageSha256: sha('4'), ocr: [] },
        { sourceFrame: 3, sourcePts: 100000, sourcePtsEvidenceHash: sha('5'), imageSha256: sha('6'), ocr: [] },
      ],
    } } },
    clock: () => new Date('2026-10-08T00:00:00.000Z'),
  })('worker-ocr-1')
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(stages, ['transcribing', 'verifying', 'persisting'])
  assert.equal(cleaned, 1)
  assert.equal(publications.length, 1)
  assert.equal(publications[0].faceSafety, 'unknown')
  assert.deepEqual(publications[0].gaps, [{ startTimelineFrame: 1,
    endTimelineFrame: 3, reasonCode: 'NOT_SAMPLED' }])
  assert.equal(publications[0].operationFenceHash, sha('c'))
})

test('OCR worker never publishes after losing its lease', async () => {
  let failed = 0, cleaned = 0
  const outcome = await runNextPerceptionProducerOperationService({
    repository: {
      async claimNext() { return claim },
      async heartbeat() { return true },
      async advancePhase() { return false },
      async failAttempt() { failed += 1; return true },
      async currentFenceHash() { assert.fail('lost lease cannot seal an envelope') },
      async publish() { assert.fail('lost lease cannot publish') },
    },
    materializer: { async materialize() { return { path: 'C:/controlled/source.mp4', sha256: sha('a'), byteSize: 100 } },
      async cleanup() { cleaned += 1 } },
    adapter: { async analyze() { assert.fail('lost lease cannot invoke OCR') } },
  })('worker-ocr-1')
  assert.equal(outcome.status, 'attempt-failed')
  assert.equal(outcome.settled, true)
  assert.equal(failed, 1)
  assert.equal(cleaned, 1)
})

test('scratch creation failure settles claimed attempt and runs materializer cleanup', async () => {
  let failed = 0, cleaned = 0
  const outcome = await runNextPerceptionProducerOperationService({
    repository: { async claimNext() { return claim }, async failAttempt() { failed += 1; return true } },
    materializer: { async cleanup() { cleaned += 1 } },
    adapter: { async analyze() { assert.fail('OCR must not start without scratch') } },
    createScratch: async () => { throw new Error('scratch unavailable') },
  })('worker-ocr-1')
  assert.equal(outcome.status, 'attempt-failed')
  assert.equal(failed, 1)
  assert.equal(cleaned, 1)
})

test('materializer cleanup failure still removes owned scratch directory', async () => {
  let scratch
  await assert.rejects(runNextPerceptionProducerOperationService({
    repository: { async claimNext() { return claim }, async advancePhase() { return false },
      async failAttempt() { return true } },
    materializer: { async materialize() { return { path: 'C:/controlled/source.mp4' } },
      async cleanup() { throw new Error('cleanup failure') } },
    adapter: { async analyze() { assert.fail('OCR must not start after lease loss') } },
    createScratch: async () => { scratch = await mkdtemp(join(tmpdir(), 'apollo-perception-test-')); return scratch },
  })('worker-ocr-1'), /cleanup failure/)
  await assert.rejects(access(scratch), /ENOENT/)
})

test('deadline abort after analysis blocks publication', async () => {
  let failed = 0
  const outcome = await runNextPerceptionProducerOperationService({
    repository: { async claimNext() { return claim }, async heartbeat() { return true },
      async advancePhase() { return true }, async currentFenceHash() { return sha('c') },
      async publish() { assert.fail('expired analysis must not publish') },
      async failAttempt() { failed += 1; return true } },
    materializer: { async materialize() { return { path: 'C:/controlled/source.mp4' } },
      async cleanup() {} },
    adapter: { async analyze() { await new Promise((resolve) => setTimeout(resolve, 15)); return {
      sourceTimebase: { num: 1, den: 1_000_000 }, sourceFps: { num: 30, den: 1 },
      sourcePtsStart: 0, sourceClock: 'constant-frame-rate',
      producer: { name: 'tesseract', executableSha256: sha('d'), executableVersion: 'tesseract 5.5',
        traineddata: [{ language: 'por', sha256: sha('e'), licenseSha256: sha('f') }] },
      runtime: { ffmpegSha256: sha('1'), ffprobeSha256: sha('2') },
      samples: [{ sourceFrame: 0, sourcePts: 0, sourcePtsEvidenceHash: sha('3'), imageSha256: sha('4'), ocr: [] }],
    } } },
    deadlineMs: 1,
  })('worker-ocr-1')
  assert.equal(outcome.status, 'attempt-failed')
  assert.equal(failed, 1)
})
