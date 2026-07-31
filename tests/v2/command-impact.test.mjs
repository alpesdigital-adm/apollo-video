import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyManualEditService,
  readArtifactInvalidationsService,
} from '../../src/v2/application/manual-edit.ts'
import {
  materializeManualEditPlan,
  timelineViewModelFromEditPlan,
} from '../../src/v2/domain/manual-editing.ts'
import {
  createCommandArtifactInvalidations,
  createManualCommandImpact,
  parseCommandArtifactInvalidation,
  parseCommandImpact,
} from '../../src/v2/domain/command-impact.ts'
import { PrismaManualEditRepository } from '../../src/v2/infrastructure/prisma/manual-edit-repository.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'

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
  const invalidations = createCommandArtifactInvalidations({ impact: value, createdAt })
  assert.equal(invalidations.length, 2)
  assert.deepEqual(invalidations.map((item) => [item.artifactId, item.status]), [
    ['artifact-final-9x16', 'stale'], ['artifact-proxy-9x16', 'stale'],
  ])
  assert.ok(invalidations.every((item) => item.resultVersionId === resultVersionId))
  assert.ok(invalidations.every((item) => item.id.length === 64))
  assert.throws(
    () => parseCommandArtifactInvalidation({ ...invalidations[0], status: 'available' }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
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
  assert.deepEqual(createCommandArtifactInvalidations({ impact: selection, createdAt }), [])
})

test('T-FR-233 crop materializes a normalized clip region and invalidates only its range and variant', () => {
  const crop = { x: 0.2, y: 0.1, width: 0.6, height: 0.8 }
  const afterCrop = materializeManualEditPlan({
    editPlan: plan(),
    operation: { kind: 'crop', clipId: 'clip-1', crop },
    newVersionId: resultVersionId,
    createdAt,
    availableAssetIds: ['source-1'],
    variantId: '9:16',
  })
  assert.deepEqual(afterCrop.videoTracks[0].clips[0].crop, crop)
  assert.equal(afterCrop.videoTracks[0].clips[1].crop, undefined)
  const value = impact({
    operation: { kind: 'crop', clipId: 'clip-1', crop },
    afterEditPlan: afterCrop,
  })
  assert.deepEqual(value.changeKinds, ['crop'])
  assert.deepEqual(value.dependencyTypes, ['visual'])
  assert.deepEqual(value.affectedRanges, [{ startFrame: 0, endFrame: 90 }])
  assert.deepEqual(value.affectedVariantIds, ['9:16'])
  assert.deepEqual(value.affectedArtifacts.map((item) => item.artifactId), [
    'artifact-final-9x16', 'artifact-proxy-9x16',
  ])
  assert.deepEqual(value.minimalRenders, [{
    kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: 90 }],
  }])
  assert.throws(
    () => materializeManualEditPlan({
      editPlan: plan(),
      operation: {
        kind: 'crop', clipId: 'clip-1',
        crop: { x: 0.6, y: 0, width: 0.5, height: 1 },
      },
      newVersionId: resultVersionId,
      createdAt,
      availableAssetIds: ['source-1'],
      variantId: '9:16',
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /Crop region/.test(error.message),
  )
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
          invalidations: createCommandArtifactInvalidations({
            impact: bundle.impact,
            createdAt: bundle.command.createdAt,
          }),
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
    operation: {
      kind: 'crop', clipId: 'clip-1',
      crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
    },
    actor: { type: 'api-client', id: 'client-impact-1' },
    idempotencyKey: 'command-impact-test-1',
  })
  assert.equal(committed.command.payload.schemaVersion, 2)
  assert.equal(committed.command.payload.impact.impactHash, result.impact.impactHash)
  assert.equal(committed.event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(committed.event.data.invalidatedArtifactCount, 2)
  assert.equal(committed.event.data.minimalRenderCount, 1)
  assert.equal(committed.command.payload.impact.changeKinds[0], 'crop')
  assert.deepEqual(JSON.parse(committed.snapshot.contentJson).videoTracks[0].clips[0].crop, {
    x: 0.2, y: 0, width: 0.6, height: 1,
  })
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

  let persistedInvalidations = []
  const baseVersionRow = {
    id: baseVersionId, workspaceId, projectId, sequence: 1, parentVersionId: null,
    briefSnapshotId: 'snapshot-brief-1', treatmentSnapshotId: null, storySnapshotId: null,
    editPlanSnapshotId: 'snapshot-edit-1', policiesSnapshotId: 'snapshot-policy-1',
    baseHash: 'a'.repeat(64), createdBy: 'client-impact-1', commandId: null,
    createdAt: new Date(createdAt),
    editPlanSnapshot: { contentJson: JSON.stringify(basePlan), contentHash: 'b'.repeat(64) },
  }
  const resultPlan = JSON.parse(committed.snapshot.contentJson)
  const resultVersionRow = {
    id: committed.version.id, workspaceId, projectId, sequence: committed.version.sequence,
    parentVersionId: committed.version.parentVersionId,
    briefSnapshotId: committed.version.snapshotRefs.brief,
    treatmentSnapshotId: null, storySnapshotId: null,
    editPlanSnapshotId: committed.version.snapshotRefs.editPlan,
    policiesSnapshotId: committed.version.snapshotRefs.policies,
    baseHash: committed.version.baseHash, createdBy: committed.version.createdBy,
    commandId: committed.command.id, createdAt: new Date(committed.version.createdAt),
    editPlanSnapshot: {
      contentJson: JSON.stringify(resultPlan), contentHash: committed.snapshot.contentHash,
    },
  }
  const persistedRepository = new PrismaManualEditRepository({
    async $transaction(callback) {
      const transaction = {
        v2EditCommand: {
          async findUnique() { return null },
          async create() {},
          async findUniqueOrThrow() {
            return {
              id: committed.command.id, workspaceId, projectId,
              baseVersionId, baseHash: committed.command.baseHash,
              type: 'manual-edit', scopeJson: JSON.stringify(committed.command.scope),
              payloadJson: JSON.stringify(committed.command.payload), reason: null,
              actorType: committed.command.author.type, actorId: committed.command.author.id,
              delegatedUserId: null, idempotencyKey: committed.command.idempotencyKey,
              requestFingerprint: committed.requestFingerprint,
              createdAt: new Date(committed.command.createdAt),
              baseVersion: baseVersionRow, resultVersion: resultVersionRow,
              artifactInvalidations: persistedInvalidations,
            }
          },
        },
        v2Project: {
          async findFirst() { return {
            format: '9:16', currentVersion: { id: baseVersionId, baseHash: 'a'.repeat(64), sequence: 1 },
          } },
          async updateMany() { return { count: 1 } },
        },
        v2ProjectProxyRenderOperation: { async findMany() { return [{ outputArtifactId: 'artifact-proxy-9x16' }] } },
        v2ProjectFinalExportOperation: { async findMany() { return [{ outputArtifactId: 'artifact-final-9x16', outputAspectRatio: '9:16' }] } },
        v2ProjectSnapshot: { async create() {} },
        v2ProjectVersion: { async create() {} },
        v2CommandArtifactInvalidation: { async createMany({ data }) { persistedInvalidations = data } },
        v2PublicEventOutbox: { async create() {} },
      }
      return callback(transaction)
    },
  })
  const persisted = await persistedRepository.commitOrReplay(committed)
  assert.deepEqual(persisted.invalidations.map((item) => item.artifactId).toSorted(), [
    'artifact-final-9x16', 'artifact-proxy-9x16',
  ])
  assert.equal(persistedInvalidations.length, 2)
  assert.ok(persistedInvalidations.every((item) => item.status === 'stale'))
  assert.ok(persistedInvalidations.every((item) => item.resultVersionId === resultVersionId))

  let invalidationQuery
  const queryRepository = new PrismaManualEditRepository({
    v2Project: { async findFirst() { return { currentVersionId: resultVersionId } } },
    v2ProjectVersion: { async findFirst() { return { id: resultVersionId } } },
    v2CommandArtifactInvalidation: { async findMany(query) {
      invalidationQuery = query
      return persistedInvalidations
    } },
  })
  const view = await readArtifactInvalidationsService({ repository: queryRepository })({
    workspaceId, projectId, resultVersionId,
  })
  assert.equal(view.resultVersionId, resultVersionId)
  assert.deepEqual(view.invalidations.map((item) => item.artifactId), [
    'artifact-final-9x16', 'artifact-proxy-9x16',
  ])
  assert.deepEqual(invalidationQuery.where, {
    workspaceId, projectId, resultVersionId,
    resolutions: { none: { operation: { status: 'succeeded' } } },
  })

  let proxyLookup
  const reusableProxyRepository = new PrismaProjectProxyRenderRepository({
    v2Project: { async findFirst() { return {
      id: projectId, format: '9:16', currentVersionId: resultVersionId,
      versions: [{
        id: resultVersionId, editPlanSnapshotId: committed.version.snapshotRefs.editPlan,
        editPlanSnapshot: {
          contentJson: committed.snapshot.contentJson,
          contentHash: committed.snapshot.contentHash,
        },
        directorRunAsResult: null,
        command: {
          id: commandId, type: 'manual-edit', baseVersionId,
          payloadJson: JSON.stringify(committed.command.payload),
          artifactInvalidations: persistedInvalidations.map((invalidation) => ({
            ...invalidation,
            resolutions: [],
          })),
        },
      }],
      mediaAssets: [{
        role: 'source-master', artifactId: 'source-1', originalFileName: 'source.mp4',
        createdAt: new Date(createdAt), upload: null,
        artifact: {
          id: 'source-1', status: 'available', mediaType: 'video', container: 'mp4',
          sha256: 'c'.repeat(64), byteSize: 4_096n,
          manifests: [{
            id: 'manifest-source-1',
            manifestJson: JSON.stringify({ artifact: { artifactKey: 'masters/source.mp4' } }),
          }],
        },
      }],
    } } },
    v2ProjectProxyRenderOperation: { async findFirst(query) {
      proxyLookup = query
      return {
        operationId: 'operation-proxy-9x16',
        outputArtifactId: 'artifact-proxy-9x16',
        outputManifestId: 'manifest-proxy-9x16',
      }
    } },
    v2MediaArtifact: { async findFirst() { return {
      id: 'artifact-proxy-9x16', sha256: 'd'.repeat(64), byteSize: 8_192n,
      manifests: [{
        id: 'manifest-proxy-9x16',
        manifestJson: JSON.stringify({ artifact: { artifactKey: 'editorial-proxies/base.mp4' } }),
      }],
    } } },
  })
  const reusableSource = await reusableProxyRepository.readCurrentSource({ workspaceId, projectId })
  assert.equal(reusableSource.rangeReuse.commandId, commandId)
  assert.deepEqual(reusableSource.rangeReuse.ranges, [{ startFrame: 0, endFrame: 90 }])
  assert.equal(reusableSource.rangeReuse.artifactId, 'artifact-proxy-9x16')
  assert.deepEqual(proxyLookup.where.operation, { status: 'succeeded', phase: 'completed' })

  const selectionImpact = impact({
    operation: { kind: 'select', clipId: 'clip-1' },
  })
  const selectionRepository = new PrismaProjectProxyRenderRepository({
    v2Project: { async findFirst() { return {
      id: projectId, format: '9:16', currentVersionId: resultVersionId,
      versions: [{
        id: resultVersionId, editPlanSnapshotId: committed.version.snapshotRefs.editPlan,
        editPlanSnapshot: {
          contentJson: committed.snapshot.contentJson,
          contentHash: committed.snapshot.contentHash,
        },
        directorRunAsResult: null,
        command: {
          id: commandId, type: 'manual-edit', baseVersionId,
          payloadJson: JSON.stringify({ impact: selectionImpact }),
          artifactInvalidations: [],
        },
      }],
      mediaAssets: [{
        role: 'source-master', artifactId: 'source-1', originalFileName: 'source.mp4',
        createdAt: new Date(createdAt), upload: null,
        artifact: {
          id: 'source-1', status: 'available', mediaType: 'video', container: 'mp4',
          sha256: 'c'.repeat(64), byteSize: 4_096n,
          manifests: [{
            id: 'manifest-source-1',
            manifestJson: JSON.stringify({ artifact: { artifactKey: 'masters/source.mp4' } }),
          }],
        },
      }],
    } } },
    v2ProjectProxyRenderOperation: { async findFirst() { return {
      operationId: 'operation-proxy-9x16',
      outputArtifactId: 'artifact-proxy-9x16',
      outputManifestId: 'manifest-proxy-9x16',
    } } },
    v2MediaArtifact: { async findFirst() { return {
      id: 'artifact-proxy-9x16', sha256: 'd'.repeat(64), byteSize: 8_192n,
      manifests: [{
        id: 'manifest-proxy-9x16',
        manifestJson: JSON.stringify({ artifact: { artifactKey: 'editorial-proxies/base.mp4' } }),
      }],
    } } },
  })
  const selectionSource = await selectionRepository.readCurrentSource({ workspaceId, projectId })
  assert.equal(selectionSource.unchangedReuseRequired, true)
  assert.equal(selectionSource.unchangedReuse.operationId, 'operation-proxy-9x16')
  assert.equal(selectionSource.unchangedReuse.artifactId, 'artifact-proxy-9x16')
  assert.equal(selectionSource.unchangedReuse.impactHash, selectionImpact.impactHash)
})

test('T-FR-233 completed proxy atomically records scoped invalidation resolutions', async () => {
  let invalidationQuery
  let resolutionRows
  const repository = new PrismaProjectProxyRenderRepository({
    async $transaction(callback) {
      return callback({
        v2ProjectProxyRenderOperation: { async findFirst() { return { operationId: 'operation-proxy-2' } } },
        v2MediaArtifact: { async findFirst() { return { id: 'artifact-proxy-replacement' } } },
        v2MediaArtifactManifest: { async findFirst() { return { id: 'manifest-proxy-replacement' } } },
        v2ProjectMediaAsset: { async upsert() {} },
        v2CommandArtifactInvalidation: { async findMany(query) {
          invalidationQuery = query
          return [{ id: '1'.repeat(64) }, { id: '2'.repeat(64) }]
        } },
        v2CommandArtifactInvalidationResolution: { async createMany({ data }) { resolutionRows = data } },
        v2DirectorRun: { async updateMany() {} },
      })
    },
  })
  await repository.attachCompletedOutput({
    workspaceId, operationId: 'operation-proxy-2', projectId,
    projectVersionId: resultVersionId, variantId: '9:16',
    outputArtifactId: 'artifact-proxy-replacement',
    outputManifestId: 'manifest-proxy-replacement',
    originalFileName: 'replacement.mp4', createdAt,
  })
  assert.deepEqual(invalidationQuery.where, {
    workspaceId, projectId, resultVersionId,
    kind: 'proxy', variantId: '9:16',
    resolutions: { none: { operation: { status: 'succeeded' } } },
  })
  assert.deepEqual(resolutionRows.map((row) => ({
    invalidationId: row.invalidationId,
    operationId: row.operationId,
    replacementArtifactId: row.replacementArtifactId,
    replacementManifestId: row.replacementManifestId,
  })), [
    { invalidationId: '1'.repeat(64), operationId: 'operation-proxy-2', replacementArtifactId: 'artifact-proxy-replacement', replacementManifestId: 'manifest-proxy-replacement' },
    { invalidationId: '2'.repeat(64), operationId: 'operation-proxy-2', replacementArtifactId: 'artifact-proxy-replacement', replacementManifestId: 'manifest-proxy-replacement' },
  ])
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
    assert.deepEqual(query.where.operation, { status: 'succeeded', phase: 'completed' })
  }
})
