import assert from 'node:assert/strict'
import test from 'node:test'

import { planProjectReframeService, readVariantReframePlanService, variantReframePlanRowId } from '../../src/v2/application/plan-project-reframe.ts'
import { parseVariantReframePlanRecord } from '../../src/v2/domain/variant-reframe-plan.ts'
import { SOURCE, SPECS, SAFE_AREA } from './helpers/reframe-trajectory-fixtures.mjs'
import { sealedSourceWindow } from './helpers/face-source-envelope-v3.mjs'

/**
 * The planning service over an in-memory repository that keeps the semantics the PostgreSQL one has (a chain per Version and variant,
 * the same content is the same row) and over REAL sealed source windows: the V9 producer the registry accepts, their seals recomputed by
 * `collectFaceSourceEvidenceStream`. The boxes come from the fixture's detector rows, so the service is proven over the whole real path
 * from window to record, not over a hand-made stream.
 */
const FACE_ROWS = (frame) => [[0.95, 0.40 + frame / 3000, 0.20, 0.50 + frame / 3000, 0.50]]
const clip = (extra = {}) => ({
  clipId: 'clip-1', sourceArtifactId: SOURCE.artifactId, sourceSha256: SOURCE.sha256, sourceWidth: SOURCE.width, sourceHeight: SOURCE.height,
  sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150, rate: 1, fps: 30, hasStaticCrop: false, ...extra,
})
const specOf = (spec) => ({ outputSpecRevisionId: spec.outputSpecRevisionId, specHash: spec.specHash, aspectRatio: spec.aspectRatio, safeArea: SAFE_AREA, width: spec.width, height: spec.height, fps: spec.fps })

function memoryRepository({ spec = SPECS.vertical, versionId = 'version-1', clips = [clip()], overrideHeads = [], throws } = {}) {
  const rows = []
  const reads = []
  return {
    rows, reads,
    async readContext(input) {
      reads.push(input)
      if (throws) throw throws
      if (input.projectId !== 'project-1') return null
      return { workspaceId: input.workspaceId, projectId: input.projectId, version: { id: versionId, baseHash: 'a'.repeat(64) }, variantId: input.variantId, spec: specOf(spec),
        timeline: { fps: 30, durationFrames: 150 }, source: SOURCE, clips, overrideHeads }
    },
    async readHead(input) {
      return rows.filter((row) => row.projectVersionId === input.projectVersionId && row.record.variantId === input.variantId).at(-1) ?? null
    },
    async persistOrReplay(input) {
      const chain = rows.filter((row) => row.projectVersionId === input.projectVersionId && row.record.variantId === input.variantId)
      if (chain.at(-1)?.record.recordHash === input.record.recordHash) return { stored: chain.at(-1), replayed: true }
      const stored = { id: input.id, sequence: chain.length + 1, projectVersionId: input.projectVersionId, record: parseVariantReframePlanRecord(JSON.parse(JSON.stringify(input.record))), createdAt: input.createdAt }
      rows.push(stored)
      return { stored, replayed: false }
    },
  }
}
const readerOf = (windows) => ({ calls: [], async listSourceWindows(input) {
  this.calls.push(input)
  return windows.filter((window) => window.window.startSourceFrame < input.toSourceFrame && window.window.endSourceFrame > input.fromSourceFrame)
    .map((envelope) => ({ envelope, authentication: { authenticated: true, reasons: [] } }))
} })
const cleanWindows = () => [0, 50, 100].map((start) => sealedSourceWindow({ start, end: Math.min(start + 50, 150), rowsAt: FACE_ROWS, id: `face-window-${start}` }))
const request = (extra = {}) => ({ workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'version-1', variantId: SPECS.vertical.variantId, ...extra })
const service = (repository, reader) => planProjectReframeService({ plans: repository, ...(reader ? { faceEvidence: reader } : {}), clock: () => new Date('2026-10-19T12:00:00.000Z') })

test('W66r real sealed windows produce a persisted, content-addressed plan for the stable variant, and the same inputs are the same row', async () => {
  const repository = memoryRepository()
  const reader = readerOf(cleanWindows())
  const first = await service(repository, reader)(request())
  assert.equal(first.schemaVersion, 'reframe-plan-request-result/v3')
  assert.equal(first.status, 'ready')
  assert.equal(first.variantId, SPECS.vertical.variantId)
  assert.equal(first.format, '9:16')
  assert.equal(first.replayed, false)
  assert.equal(first.plan.sequence, 1)
  assert.equal(first.plan.renderPlan.variantId, SPECS.vertical.variantId)
  assert.equal(first.plan.roi.face.status, 'present')
  assert.deepEqual([first.plan.roi.object.reasonCode, first.plan.roi.screen.reasonCode], ['NO_VERIFIED_DETECTOR', 'NO_VERIFIED_PRODUCER'])
  assert.equal(first.plan.evidence[0].trustedWindowCount, 3)
  assert.equal(first.plan.policy.hash.length, 64)
  assert.ok(reader.calls.every((call) => call.projectId === 'project-1' && call.sourceArtifactId === SOURCE.artifactId && call.workspaceId === 'workspace-1'))
  // the same evidence and the same Version: the same record, the same row, no second sequence
  const again = await service(repository, readerOf(cleanWindows()))(request())
  assert.equal(again.replayed, true)
  assert.equal(again.plan.recordHash, first.plan.recordHash)
  assert.equal(again.plan.planRecordId, first.plan.planRecordId)
  assert.equal(repository.rows.length, 1)
  assert.equal(first.plan.planRecordId, variantReframePlanRowId({ projectVersionId: 'version-1', variantId: SPECS.vertical.variantId, recordHash: first.plan.recordHash }))
  // reading is not planning
  const read = await readVariantReframePlanService({ plans: repository })({ workspaceId: 'workspace-1', projectId: 'project-1', variantId: SPECS.vertical.variantId })
  assert.equal(read.projectVersionId, 'version-1')
  assert.equal(read.plan.recordHash, first.plan.recordHash)
  assert.equal((await readVariantReframePlanService({ plans: repository })({ workspaceId: 'workspace-1', projectId: 'project-1', variantId: SPECS.wide.variantId, projectVersionId: 'version-other' })).plan, null)
})

test('W66r new evidence appends to the chain of the Version instead of replacing the plan the renders consumed', async () => {
  const repository = memoryRepository()
  const first = await service(repository, readerOf(cleanWindows()))(request())
  // a window that disagrees with a stored one makes both untrusted (EVIDENCE_CONFLICT): the stream changes, so the record does
  const conflicting = [...cleanWindows(), sealedSourceWindow({ start: 0, end: 50, rowsAt: () => [], id: 'face-window-conflict' })]
  const second = await service(repository, readerOf(conflicting))(request())
  assert.notEqual(second.plan.recordHash, first.plan.recordHash)
  assert.equal(second.plan.sequence, 2)
  assert.equal(repository.rows.length, 2)
  assert.ok(second.plan.evidence[0].untrustedWindows.length >= 1, 'the contradicted windows are listed, not used')
  assert.equal(repository.rows[0].record.recordHash, first.plan.recordHash, 'the first record is untouched')
})

test('W66r without authenticated evidence nothing is decided, the windows that would be needed are listed, and a crop that hides nothing needs none', async () => {
  const repository = memoryRepository()
  const none = await service(repository, readerOf([]))(request())
  assert.deepEqual([none.status, none.plan, none.reasonCode], ['review-required', null, 'FACE_PERCEPTION_UNAVAILABLE'])
  assert.deepEqual(none.requiredFaceWindows[0].sourceArtifactId, SOURCE.artifactId)
  assert.ok(none.requiredFaceWindows[0].windows.length >= 1)
  assert.equal(repository.rows.length, 0, 'nothing is persisted without evidence')
  const noReader = await service(repository)(request())
  assert.equal(noReader.reasonCode, 'FACE_PERCEPTION_UNAVAILABLE')
  // a window sealed over other bytes is not evidence of this source
  const foreign = [sealedSourceWindow({ start: 0, end: 50, rowsAt: FACE_ROWS, overrides: { sourceSha256: 'f'.repeat(64) } })]
  const refused = await service(repository, readerOf(foreign))(request())
  assert.equal(refused.reasonCode, 'FACE_PERCEPTION_UNAVAILABLE')
  // the 16:9 variant of 16:9 footage shows the whole frame: nothing can be cut, so it is ready without any window
  const wideRepository = memoryRepository({ spec: SPECS.wide })
  const wide = await service(wideRepository, readerOf([]))(request({ variantId: SPECS.wide.variantId }))
  assert.equal(wide.status, 'ready')
  assert.deepEqual(wide.plan.renderPlan.ranges.map((range) => [range.source, range.keyframes.length]), [['plan', 1]])
  assert.deepEqual(wide.plan.issues, [])
})

test('W66r a stale base, an unknown project and a spelling that is not a stable id are refused; rights and variant refusals are the store\'s and pass through', async () => {
  const repository = memoryRepository()
  await assert.rejects(() => service(repository, readerOf(cleanWindows()))(request({ baseVersionId: 'version-stale' })), (error) => error.code === 'VERSION_CONFLICT' && /stale/.test(error.message))
  await assert.rejects(() => service(repository, readerOf(cleanWindows()))(request({ projectId: 'project-other' })), (error) => error.code === 'PROJECT_NOT_FOUND')
  await assert.rejects(() => service(repository, readerOf(cleanWindows()))(request({ variantId: 'v' })), (error) => error.code === 'INVALID_ARGUMENT' && /variantId/.test(error.message))
  const blocked = Object.assign(new Error('rights'), { code: 'ASSET_RIGHTS_BLOCKED' })
  await assert.rejects(() => service(memoryRepository({ throws: blocked }), readerOf(cleanWindows()))(request()), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
  assert.equal(repository.rows.length, 0, 'a refused request writes nothing')
})
