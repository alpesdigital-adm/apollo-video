import assert from 'node:assert/strict'
import test from 'node:test'

import { applyManualEditService } from '../../src/v2/application/manual-edit.ts'
import { timelineViewModelFromEditPlan } from '../../src/v2/domain/manual-editing.ts'
import {
  createManualCommandImpact,
  parseCommandImpact,
} from '../../src/v2/domain/command-impact.ts'
import { PrismaManualEditRepository } from '../../src/v2/infrastructure/prisma/manual-edit-repository.ts'

const workspaceId = 'workspace-impact-1'
const projectId = 'project-impact-1'
const baseVersionId = 'project-version-impact-1'
const resultVersionId = 'project-version-impact-2'
const commandId = 'edit-command-impact-1'
const createdAt = '2026-07-31T19:00:00.000Z'

function plan(versionId = baseVersionId) {
  return {
    schemaVersion: 2,
    state: 'compiled',
    id: `edit-plan-${versionId}`,
    projectVersionId: versionId,
    fps: 30,
    durationFrames: 180,
    sources: [{ id: 'source-1', artifactId: 'source-1', kind: 'video', durationSeconds: 6 }],
    videoTracks: [{
      id: 'base-video',
      kind: 'base-video',
      clips: [
        { id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 90, rate: 1 },
        { id: 'clip-2', sourceArtifactId: 'source-1', sourceInFrame: 90, sourceOutFrame: 180, timelineInFrame: 90, timelineOutFrame: 180, rate: 1 },
      ],
    }],
    overlayTracks: [], subtitleTracks: [], audioTracks: [], effectTracks: [], markers: [], transitions: [],
    protectedElements: [], localeVariantRefs: [], formatVariantRefs: [], lineageRefs: ['source-1'],
    movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
    subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
    composition: { layout: 'fit', background: 'black', foregroundScale: 1, verticalPosition: 0.5 },
    director: { plannerVersion: 'impact-test', decisions: [], assumptions: [] },
    createdAt,
  }
}

const outputs = [
  { artifactId: 'artifact-final-9x16', kind: 'final', sourceVersionId: baseVersionId, variantId: '9:16' },
  { artifactId: 'artifact-proxy-9x16', kind: 'proxy', sourceVersionId: baseVersionId, variantId: '9:16' },
  { artifactId: 'artifact-final-16x9', kind: 'final', sourceVersionId: baseVersionId, variantId: '16:9' },
]

function impact(overrides = {}) {
  return createManualCommandImpact({
    commandId,
    baseVersionId,
    resultVersionId,
    variantId: '9:16',
    targetId: 'clip-1',
    action: 'apply',
    operation: { kind: 'inspect', clipId: 'clip-1', patch: { subtitle: 'clean-bold' } },
    beforeEditPlan: plan(),
    afterEditPlan: plan(resultVersionId),
    outputReferences: outputs,
    ...overrides,
  })
}

test('T-FR-233 manual subtitle impact scopes exact range, variant and historical outputs', () => {
  const value = impact()
  assert.equal(value.schemaVersion, 'command-impact/v1')
  assert.deepEqual(value.changeKinds, ['inspect:subtitle'])
  assert.deepEqual(value.dependencyTypes, ['visual'])
  assert.deepEqual(value.affectedRanges, [{ startFrame: 0, endFrame: 90 }])
  assert.deepEqual(value.affectedVariantIds, ['9:16'])
  assert.deepEqual(value.affectedArtifacts.map((item) => item.artifactId), [
    'artifact-final-9x16', 'artifact-proxy-9x16',
  ])
  assert.deepEqual(value.minimalRenders, [{
    kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: 90 }],
  }])
  assert.equal(value.impactHash.length, 64)
})

test('T-FR-233 timing impact extends through shifted downstream frames while selection avoids render', () => {
  const afterTrim = plan(resultVersionId)
  afterTrim.videoTracks[0].clips[0].sourceOutFrame = 60
  afterTrim.videoTracks[0].clips[0].timelineOutFrame = 60
  afterTrim.videoTracks[0].clips[1].timelineInFrame = 60
  afterTrim.videoTracks[0].clips[1].timelineOutFrame = 150
  afterTrim.durationFrames = 150
  const timing = impact({
    operation: { kind: 'trim', clipId: 'clip-1', edge: 'end', atMs: 2000 },
    afterEditPlan: afterTrim,
  })
  assert.deepEqual(timing.affectedRanges, [{ startFrame: 0, endFrame: 180 }])
  assert.deepEqual(timing.dependencyTypes, ['timing', 'visual', 'audio'])

  const selection = impact({ operation: { kind: 'select', clipId: 'clip-1' } })
  assert.equal(selection.renderSemanticsChanged, false)
  assert.deepEqual(selection.affectedArtifacts, [])
  assert.deepEqual(selection.affectedVariantIds, [])
  assert.deepEqual(selection.minimalRenders, [])
})

test('T-FR-233 persisted impact is content-addressed and rejects tampering', () => {
  const value = impact()
  assert.deepEqual(parseCommandImpact(value), value)
  assert.throws(
    () => parseCommandImpact({ ...value, affectedVariantIds: ['16:9'] }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('T-FR-233 manual Command persists the impact in payload v2 and binds it to the outbox event', async () => {
  let committed
  const basePlan = plan()
  const service = applyManualEditService({
    repository: {
      async findIdempotentResult() { return null },
      async readContext() {
        return {
          version: {
            id: baseVersionId, workspaceId, projectId, sequence: 1,
            snapshotRefs: { brief: 'snapshot-brief-1', editPlan: 'snapshot-edit-1', policies: 'snapshot-policy-1' },
            baseHash: 'a'.repeat(64), createdBy: 'client-impact-1', createdAt,
          },
          editPlan: basePlan,
          editPlanHash: 'b'.repeat(64),
          availableAssetIds: ['source-1'],
          renderVariantIds: ['9:16'],
          outputReferences: outputs,
          history: [],
        }
      },
      async commitOrReplay(bundle) {
        committed = bundle
        return {
          command: bundle.command,
          version: bundle.version,
          editPlan: JSON.parse(bundle.snapshot.contentJson),
          timeline: timelineViewModelFromEditPlan({
            editPlan: JSON.parse(bundle.snapshot.contentJson),
            versionId: bundle.version.id,
            revision: bundle.version.sequence,
            selectedClipId: 'clip-1',
          }),
          comparison: bundle.comparison,
          impact: bundle.impact,
          replayed: false,
        }
      },
    },
    clock: () => new Date('2026-07-31T19:01:00.000Z'),
    createId: (kind) => ({
      'edit-command': commandId,
      'project-version': resultVersionId,
      'project-snapshot': 'project-snapshot-impact-2',
    })[kind],
    createEventId: () => '8c196f8c-5da2-4ac7-9c51-7a4cf42575f1',
  })
  const result = await service({
    workspaceId, projectId, baseVersionId, baseHash: 'a'.repeat(64), expectedRevision: 1,
    action: 'apply', variantId: '9:16', targetId: 'clip-1',
    operation: { kind: 'inspect', clipId: 'clip-1', patch: { layout: 'safe-close-up' } },
    actor: { type: 'api-client', id: 'client-impact-1' },
    idempotencyKey: 'command-impact-test-1',
  })
  assert.equal(committed.command.payload.schemaVersion, 2)
  assert.equal(committed.command.payload.impact.impactHash, result.impact.impactHash)
  assert.equal(committed.event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(committed.event.data.invalidatedArtifactCount, 2)
  assert.equal(committed.event.data.minimalRenderCount, 1)
  await assert.rejects(
    () => service({
      workspaceId, projectId, baseVersionId, baseHash: 'a'.repeat(64), expectedRevision: 1,
      action: 'apply', variantId: '16:9', targetId: 'clip-1',
      operation: { kind: 'inspect', clipId: 'clip-1', patch: { layout: 'unsafe-scope' } },
      actor: { type: 'api-client', id: 'client-impact-1' },
      idempotencyKey: 'command-impact-invalid-variant',
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /variant/.test(error.message),
  )
  const driftRepository = new PrismaManualEditRepository({
    async $transaction(callback) {
      return callback({
        v2EditCommand: { async findUnique() { return null } },
        v2Project: { async findFirst() { return {
          format: '9:16',
          currentVersion: { id: baseVersionId, baseHash: 'a'.repeat(64), sequence: 1 },
        } } },
        v2ProjectProxyRenderOperation: { async findMany() { return [
          { outputArtifactId: 'artifact-proxy-9x16' },
          { outputArtifactId: 'artifact-proxy-concurrent' },
        ] } },
        v2ProjectFinalExportOperation: { async findMany() { return [
          { outputArtifactId: 'artifact-final-9x16', outputAspectRatio: '9:16' },
        ] } },
      })
    },
  })
  await assert.rejects(
    () => driftRepository.commitOrReplay(committed),
    (error) => error.code === 'VERSION_CONFLICT' && /outputs changed/.test(error.message),
  )
})

test('T-FR-233 Prisma context discovers only completed proxy/final outputs for the immutable base', async () => {
  const queries = []
  const currentVersion = {
    id: baseVersionId, workspaceId, projectId, sequence: 1, parentVersionId: null,
    briefSnapshotId: 'snapshot-brief-1', treatmentSnapshotId: null, storySnapshotId: null,
    editPlanSnapshotId: 'snapshot-edit-1', policiesSnapshotId: 'snapshot-policy-1',
    baseHash: 'a'.repeat(64), createdBy: 'client-impact-1', commandId: null,
    createdAt: new Date(createdAt),
    editPlanSnapshot: {
      id: 'snapshot-edit-1', contentJson: JSON.stringify(plan()), contentHash: 'b'.repeat(64),
    },
  }
  const repository = new PrismaManualEditRepository({
    v2Project: { async findFirst() { return {
      id: projectId, workspaceId, format: '9:16', currentVersion,
      mediaAssets: [{ artifactId: 'source-1' }], versions: [currentVersion],
    } } },
    v2ProjectProxyRenderOperation: { async findMany(query) {
      queries.push(query)
      return [{ outputArtifactId: 'artifact-proxy-9x16' }]
    } },
    v2ProjectFinalExportOperation: { async findMany(query) {
      queries.push(query)
      return [
        { outputArtifactId: 'artifact-final-9x16', outputAspectRatio: '9:16' },
        { outputArtifactId: 'artifact-final-16x9', outputAspectRatio: '16:9' },
      ]
    } },
  })
  const context = await repository.readContext({ workspaceId, projectId })
  assert.deepEqual(context.renderVariantIds, ['9:16'])
  assert.deepEqual(context.outputReferences.map((item) => item.artifactId), [
    'artifact-final-16x9', 'artifact-final-9x16', 'artifact-proxy-9x16',
  ])
  assert.equal(queries.length, 2)
  for (const query of queries) {
    assert.equal(query.where.workspaceId, workspaceId)
    assert.equal(query.where.projectId, projectId)
    assert.equal(query.where.projectVersionId, baseVersionId)
    assert.deepEqual(query.where.operation, { status: 'completed' })
  }
})
