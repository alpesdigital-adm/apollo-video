import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import {
  applyManualEditService,
  readArtifactInvalidationsService,
} from '../../src/v2/application/manual-edit.ts'
import {
  materializeManualEditPlan,
  timelineViewModelFromEditPlan,
} from '../../src/v2/domain/manual-editing.ts'
import {
  canonicalCommandImpactRanges,
  createCommandArtifactInvalidations,
  createManualCommandImpact,
  createReviewPatchCommandImpact,
  parseCommandArtifactInvalidation,
  parseCommandImpact,
} from '../../src/v2/domain/command-impact.ts'
import { applyReviewPatchService } from '../../src/v2/application/review-patch.ts'
import { applyReviewPatchBatchService } from '../../src/v2/application/review-patch-batch.ts'
import { PrismaManualEditRepository } from '../../src/v2/infrastructure/prisma/manual-edit-repository.ts'
import { PrismaReviewPatchRepository } from '../../src/v2/infrastructure/prisma/review-patch-repository.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
import { PrismaProjectFinalExportRepository } from '../../src/v2/infrastructure/prisma/project-final-export-repository.ts'
import {
  presentArtifactInvalidationViewV2,
  presentProjectVersionV2,
} from '../../src/v2/public-api/presenters.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import {
  createExternalAuditContext,
  materializeActorAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import {
  editCommandExternalActorAuditData,
  hydrateEditCommandExternalActorAudit,
} from '../../src/v2/infrastructure/prisma/edit-command-actor-audit.ts'

const workspaceId = 'workspace-impact-1'
const projectId = 'project-impact-1'
const baseVersionId = 'project-version-impact-1'
const resultVersionId = 'project-version-impact-2'
const commandId = 'edit-command-impact-1'
const createdAt = '2026-07-31T19:00:00.000Z'

function impactActor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-impact-1', credentialId: 'credential-impact-1',
    workspaceId, environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:write']),
    authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
    workspaceAccessStatus: 'active', auditContext,
  })
}

test('T-FR-236 exposes the resulting Command version as the current project head', () => {
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.projects.commands.apply')
  assert.equal(capability.version, '7.0.0')
  assert.equal(capability.outputSchemaRef, 'apollo://schemas/project-edit-command-applied/v6')
  assert.equal(getPublicSchema('apollo://schemas/project-edit-command-applied/v5').ref, 'apollo://schemas/project-edit-command-applied/v5')

  const validate = addFormats(new Ajv2020({ strict: false, allErrors: true }))
    .compile(getPublicSchema('apollo://schemas/project-edit-command-applied/v6').schema)
  for (const previousRef of [
    'apollo://schemas/project-edit-command-applied/v4',
    'apollo://schemas/project-edit-command-applied/v5',
    'apollo://schemas/project-edit-command-applied/v3',
  ]) {
    const body = structuredClone(publicSchemaExamples(getPublicSchema(previousRef))[0])
    body.data.version = presentProjectVersionV2(
      body.data.version,
      { current: true, previewAvailable: false },
    )
    assert.equal(validate(body), true, `${previousRef}: ${JSON.stringify(validate.errors)}`)
    const mismatched = structuredClone(body)
    mismatched.data.version.visibleState.label = 'superseded'
    assert.equal(validate(mismatched), false, previousRef)
  }
})

test('T-FR-236 exposes manual apply, undo, redo and restore result versions as current', () => {
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.projects.manual-edits.apply')
  assert.equal(capability.version, '3.0.0')
  assert.equal(capability.outputSchemaRef, 'apollo://schemas/project-manual-edit-applied/v3')
  assert.equal(getPublicSchema('apollo://schemas/project-manual-edit-applied/v2').ref, 'apollo://schemas/project-manual-edit-applied/v2')

  const validate = addFormats(new Ajv2020({ strict: false, allErrors: true }))
    .compile(getPublicSchema('apollo://schemas/project-manual-edit-applied/v3').schema)
  const previous = publicSchemaExamples(getPublicSchema('apollo://schemas/project-manual-edit-applied/v2'))[0]
  for (const action of ['apply', 'undo', 'redo', 'restore']) {
    const body = structuredClone(previous)
    body.data.command.action = action
    body.data.command.payload.action = action
    body.data.comparison.action = action
    body.data.version = presentProjectVersionV2(
      body.data.version,
      { current: true, previewAvailable: false },
    )
    assert.equal(validate(body), true, `${action}: ${JSON.stringify(validate.errors)}`)
    const mismatched = structuredClone(body)
    mismatched.data.version.visibleState.primaryAction = 'inspect-history'
    assert.equal(validate(mismatched), false, action)
  }
})

test('T-FR-236 exposes individual and batch patch result versions as current', () => {
  const capabilities = new Map(FOUNDATION_CAPABILITIES.map((item) => [item.id, item]))
  const cases = [
    ['apollo.projects.review-patches.apply', 'review-patch-applied'],
    ['apollo.projects.review-patch-batches.apply', 'review-patch-batch-applied'],
  ]
  for (const [capabilityId, schemaName] of cases) {
    assert.equal(capabilities.get(capabilityId).version, '3.0.0')
    assert.equal(capabilities.get(capabilityId).outputSchemaRef, `apollo://schemas/${schemaName}/v3`)
    assert.equal(getPublicSchema(`apollo://schemas/${schemaName}/v2`).ref, `apollo://schemas/${schemaName}/v2`)
    const validate = addFormats(new Ajv2020({ strict: false, allErrors: true }))
      .compile(getPublicSchema(`apollo://schemas/${schemaName}/v3`).schema)
    const body = structuredClone(publicSchemaExamples(getPublicSchema(`apollo://schemas/${schemaName}/v2`))[0])
    body.data.version = presentProjectVersionV2(
      body.data.version,
      { current: true, previewAvailable: false },
    )
    assert.equal(validate(body), true, `${schemaName}: ${JSON.stringify(validate.errors)}`)
    const mismatched = structuredClone(body)
    mismatched.data.version.visibleState.terminal = true
    assert.equal(validate(mismatched), false, schemaName)
  }
})

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
    overlayTracks: [], subtitleTracks: [{
      id: 'captions', kind: 'captions', presetId: 'clean-color', anchor: 'bottom',
      faceProtection: true, maxLines: 2, maxCharactersPerBlock: 32,
      cues: [{ id: 'cue-1', startFrame: 15, endFrame: 45, text: 'Texto original', anchor: 'bottom' }],
    }], audioTracks: [], effectTracks: [], markers: [], transitions: [],
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
  const beforeEditPlan = plan()
  const operation = { kind: 'inspect', clipId: 'clip-1', patch: { text: 'Texto revisado' } }
  const afterEditPlan = materializeManualEditPlan({
    editPlan: beforeEditPlan,
    operation,
    newVersionId: resultVersionId,
    createdAt,
    availableAssetIds: ['source-1'],
    variantId: '9:16',
  })
  return createManualCommandImpact({
    commandId,
    baseVersionId,
    resultVersionId,
    variantId: '9:16',
    targetId: 'clip-1',
    action: 'apply',
    operation,
    beforeEditPlan,
    afterEditPlan,
    outputReferences: outputs,
    ...overrides,
  })
}

test('T-FR-233 manual subtitle impact scopes exact range, variant and historical outputs', () => {
  const value = impact()
  assert.equal(value.schemaVersion, 'command-impact/v1')
  assert.deepEqual(value.changeKinds, ['inspect:text'])
  assert.deepEqual(value.dependencyTypes, ['visual'])
  assert.deepEqual(value.affectedRanges, [{ startFrame: 15, endFrame: 45 }])
  assert.deepEqual(value.affectedVariantIds, ['9:16'])
  assert.deepEqual(value.affectedArtifacts.map((item) => item.artifactId), [
    'artifact-final-9x16', 'artifact-proxy-9x16',
  ])
  assert.deepEqual(value.minimalRenders, [{
    kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 15, endFrame: 45 }],
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
  const combinedInspector = impact({
    operation: { kind: 'inspect', clipId: 'clip-1', patch: { text: 'Texto revisado', layout: 'portrait-safe' } },
  })
  assert.deepEqual(combinedInspector.affectedRanges, [{ startFrame: 0, endFrame: 90 }])
})

test('T-FR-236 presents stale as a version-scoped relation without changing artifact availability', () => {
  const invalidation = createCommandArtifactInvalidations({
    impact: impact(),
    createdAt,
  })[0]
  assert.ok(invalidation)
  const presented = presentArtifactInvalidationViewV2({
    projectId,
    resultVersionId,
    invalidations: [invalidation],
  })
  assert.equal(presented.invalidations[0].status, 'stale')
  assert.equal(presented.invalidations[0].availabilityEffect, 'none')
  assert.deepEqual(presented.invalidations[0].visibleState, {
    schemaVersion: 'visible-state/v1',
    label: 'stale-output',
    tone: 'warning',
    progress: { mode: 'none' },
    primaryAction: 'rebuild-output',
    availableActions: ['rebuild-output', 'open-historical-output'],
    terminal: false,
  })
  assert.equal(presented.invalidations[0].artifactId, invalidation.artifactId)
  assert.equal(presented.invalidations[0].baseVersionId, baseVersionId)
  assert.equal(presented.invalidations[0].resultVersionId, resultVersionId)
  assert.throws(() => presented.invalidations.push(presented.invalidations[0]))
  assert.throws(
    () => presentArtifactInvalidationViewV2({
      projectId,
      resultVersionId,
      invalidations: [{ ...invalidation, status: 'available' }],
    }),
    /fields are invalid|invalid/,
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
    actor: impactActor(),
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
      actor: impactActor(),
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
              actorCredentialId: committed.authenticationAudit.credentialId,
              actorEnvironment: committed.authenticationAudit.environment,
              actorAuthenticationKind: committed.authenticationAudit.authenticationKind,
              actorContextHash: committed.authenticationAudit.contextHash,
              actorDelegatedIdentityId: null, actorWorkspaceRole: null,
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
      id: projectId, workspaceId, format: '9:16', currentVersionId: resultVersionId,
      versions: [{
        id: resultVersionId, editPlanSnapshotId: committed.version.snapshotRefs.editPlan,
        editPlanSnapshot: {
          workspaceId, projectId,
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
      id: projectId, workspaceId, format: '9:16', currentVersionId: resultVersionId,
      versions: [{
        id: resultVersionId, editPlanSnapshotId: committed.version.snapshotRefs.editPlan,
        editPlanSnapshot: {
          workspaceId, projectId,
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
  const resolutionUpserts = []
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
        v2CommandArtifactInvalidationResolution: { async upsert(input) { resolutionUpserts.push(input) } },
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
  assert.deepEqual(resolutionUpserts.map((entry) => ({
    invalidationId: entry.where.invalidationId_operationId.invalidationId,
    operationId: entry.where.invalidationId_operationId.operationId,
    replacementArtifactId: entry.update.replacementArtifactId,
    replacementManifestId: entry.update.replacementManifestId,
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

test('T-FR-233 stale ranges are canonicalized into an ordered, strictly disjoint list', () => {
  // Adjacent ranges are FUSED, never rejected: [0,30] + [30,60] is one [0,60].
  assert.deepEqual(
    canonicalCommandImpactRanges([{ startFrame: 0, endFrame: 30 }, { startFrame: 30, endFrame: 60 }]),
    [{ startFrame: 0, endFrame: 60 }],
  )
  // Overlaps fuse too, and the widest end wins.
  assert.deepEqual(
    canonicalCommandImpactRanges([{ startFrame: 0, endFrame: 40 }, { startFrame: 20, endFrame: 60 }]),
    [{ startFrame: 0, endFrame: 60 }],
  )
  assert.deepEqual(
    canonicalCommandImpactRanges([{ startFrame: 0, endFrame: 90 }, { startFrame: 20, endFrame: 30 }]),
    [{ startFrame: 0, endFrame: 90 }],
  )
  // Duplicates collapse.
  assert.deepEqual(
    canonicalCommandImpactRanges([{ startFrame: 10, endFrame: 20 }, { startFrame: 10, endFrame: 20 }]),
    [{ startFrame: 10, endFrame: 20 }],
  )
  // Genuinely separated ranges survive as separate entries, sorted by start.
  assert.deepEqual(
    canonicalCommandImpactRanges([{ startFrame: 120, endFrame: 150 }, { startFrame: 0, endFrame: 30 }]),
    [{ startFrame: 0, endFrame: 30 }, { startFrame: 120, endFrame: 150 }],
  )
  assert.deepEqual(
    canonicalCommandImpactRanges([
      { startFrame: 150, endFrame: 180 },
      { startFrame: 0, endFrame: 30 },
      { startFrame: 60, endFrame: 90 },
      { startFrame: 89, endFrame: 100 },
    ]),
    [
      { startFrame: 0, endFrame: 30 },
      { startFrame: 60, endFrame: 100 },
      { startFrame: 150, endFrame: 180 },
    ],
  )
  // The canonical list is deeply frozen and never merely touching.
  const canonical = canonicalCommandImpactRanges([
    { startFrame: 0, endFrame: 30 }, { startFrame: 120, endFrame: 150 },
  ])
  assert.ok(Object.isFrozen(canonical) && canonical.every((range) => Object.isFrozen(range)))
  assert.ok(canonical.every((range, index) =>
    index === 0 || range.startFrame > canonical[index - 1].endFrame))
  for (const invalid of [
    [{ startFrame: -1, endFrame: 10 }],
    [{ startFrame: 10, endFrame: 10 }],
    [{ startFrame: 10, endFrame: 5 }],
    [{ startFrame: 0.5, endFrame: 10 }],
    [{ startFrame: 0, endFrame: Number.NaN }],
  ]) {
    assert.throws(
      () => canonicalCommandImpactRanges(invalid),
      (error) => error.code === 'INVALID_ARGUMENT' && /range is invalid/.test(error.message),
    )
  }
})

test('T-FR-233 a moved clip invalidates the continuous downstream timing envelope', () => {
  const beforeEditPlan = plan()
  beforeEditPlan.videoTracks[0].clips = [
    { id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
    { id: 'clip-2', sourceArtifactId: 'source-1', sourceInFrame: 30, sourceOutFrame: 180, timelineInFrame: 30, timelineOutFrame: 180, rate: 1 },
  ]
  const afterEditPlan = plan(resultVersionId)
  afterEditPlan.videoTracks[0].clips = [
    { id: 'clip-2', sourceArtifactId: 'source-1', sourceInFrame: 30, sourceOutFrame: 180, timelineInFrame: 0, timelineOutFrame: 150, rate: 1 },
    { id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 150, timelineOutFrame: 180, rate: 1 },
  ]
  const moved = impact({
    operation: { kind: 'move', clipId: 'clip-1', toMs: 5000 },
    beforeEditPlan,
    afterEditPlan,
  })
  // The clip left [0,30] and landed at [150,180], shifting clip-2 throughout
  // the middle. Reusing [30,150] would preserve frames with the wrong source
  // timing, so the safe impact is one continuous envelope through the end.
  assert.deepEqual(moved.affectedRanges, [{ startFrame: 0, endFrame: 180 }])
  assert.deepEqual(moved.changeKinds, ['move'])
  assert.deepEqual(moved.minimalRenders, [{
    kind: 'proxy', variantId: '9:16', ranges: moved.affectedRanges,
  }])
  // The persisted round trip keeps affectedRanges and minimalRenders[].ranges
  // hash-identical, so a multi-range impact survives storage unchanged.
  const parsed = parseCommandImpact(JSON.parse(JSON.stringify(moved)))
  assert.deepEqual(parsed.affectedRanges, moved.affectedRanges)
  assert.deepEqual(parsed.minimalRenders[0].ranges, moved.affectedRanges)
  const invalidations = createCommandArtifactInvalidations({ impact: moved, createdAt })
  assert.ok(invalidations.length >= 1)
  assert.deepEqual(invalidations[0].affectedRanges, moved.affectedRanges)
})

test('T-FR-233 completed final export resolves only stale finals for its exact variant', async () => {
  let invalidationQuery
  const resolutionUpserts = []
  let projectUpdate
  const repository = new PrismaProjectFinalExportRepository({
    async $transaction(callback) {
      return callback({
        v2ProjectFinalExportOperation: { async findFirst() { return {
          operationId: 'operation-final-2', outputAspectRatio: '16:9',
        } } },
        v2MediaArtifact: { async findFirst() { return { id: 'artifact-final-replacement' } } },
        v2MediaArtifactManifest: { async findFirst() { return { id: 'manifest-final-replacement' } } },
        v2ProjectMediaAsset: { async upsert() {} },
        v2CommandArtifactInvalidation: { async findMany(query) {
          invalidationQuery = query
          return [{ id: '3'.repeat(64) }]
        } },
        v2CommandArtifactInvalidationResolution: { async upsert(input) { resolutionUpserts.push(input) } },
        v2Project: { async updateMany(query) { projectUpdate = query; return { count: 1 } } },
      })
    },
  })
  await repository.attachCompletedOutput({
    workspaceId, operationId: 'operation-final-2', projectId,
    projectVersionId: resultVersionId,
    outputArtifactId: 'artifact-final-replacement',
    outputManifestId: 'manifest-final-replacement',
    originalFileName: 'replacement-final.mp4', createdAt,
  })
  await repository.attachCompletedOutput({
    workspaceId, operationId: 'operation-final-2', projectId,
    projectVersionId: resultVersionId,
    outputArtifactId: 'artifact-final-retry-winner',
    outputManifestId: 'manifest-final-retry-winner',
    originalFileName: 'replacement-final.mp4', createdAt: '2026-07-31T19:01:00.000Z',
  })
  assert.deepEqual(invalidationQuery.where, {
    workspaceId, projectId, resultVersionId,
    kind: 'final', variantId: '16:9',
    resolutions: { none: { operation: { status: 'succeeded' } } },
  })
  assert.deepEqual(resolutionUpserts.map((entry) => ({
    invalidationId: entry.where.invalidationId_operationId.invalidationId,
    operationId: entry.where.invalidationId_operationId.operationId,
    replacementArtifactId: entry.update.replacementArtifactId,
    replacementManifestId: entry.update.replacementManifestId,
  })), [
    {
      invalidationId: '3'.repeat(64), operationId: 'operation-final-2',
      replacementArtifactId: 'artifact-final-replacement',
      replacementManifestId: 'manifest-final-replacement',
    },
    {
      invalidationId: '3'.repeat(64), operationId: 'operation-final-2',
      replacementArtifactId: 'artifact-final-retry-winner',
      replacementManifestId: 'manifest-final-retry-winner',
    },
  ])
  assert.deepEqual(projectUpdate.where, {
    id: projectId, workspaceId, currentVersionId: resultVersionId,
    status: { in: ['rendering-final', 'completed'] },
  })
})

test('T-FR-242 external EditCommand audit round-trips canonically and rejects tampering', () => {
  const actor = impactActor()
  const audit = materializeActorAuditContext(actor)
  const stored = {
    workspaceId,
    actorType: 'api-client',
    actorId: actor.clientId,
    delegatedUserId: null,
    ...editCommandExternalActorAuditData(audit, workspaceId, actor.auditContext.actor),
  }
  assert.deepEqual(hydrateEditCommandExternalActorAudit(stored), audit)

  for (const mutation of [
    { actorCredentialId: null },
    { actorContextHash: 'f'.repeat(64) },
    { actorEnvironment: 'sandbox' },
    { actorAuthenticationKind: 'ui-session' },
    { actorType: 'system' },
  ]) {
    assert.throws(
      () => hydrateEditCommandExternalActorAudit({ ...stored, ...mutation }),
      (error) => error.code === 'PERSISTENCE_CONFLICT',
    )
  }
  assert.throws(
    () => editCommandExternalActorAuditData(
      audit,
      workspaceId,
      { type: 'api-client', id: 'client-impact-other' },
    ),
    (error) => error.code === 'AUTH_INVALID',
  )
})

test('T-FR-233 the real manual move materializer does not underinvalidate shifted middle clips', () => {
  const beforeEditPlan = plan()
  beforeEditPlan.videoTracks = [
    {
      id: 'base-video', kind: 'base-video', clips: [
        { id: 'clip-1', sourceArtifactId: 'source-1', sourceInFrame: 0, sourceOutFrame: 30, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
        { id: 'clip-2', sourceArtifactId: 'source-1', sourceInFrame: 30, sourceOutFrame: 180, timelineInFrame: 30, timelineOutFrame: 180, rate: 1 },
      ],
    },
    {
      id: 'alternate-video', kind: 'b-roll', clips: [
        { id: 'clip-3', sourceArtifactId: 'source-1', sourceInFrame: 30, sourceOutFrame: 180, timelineInFrame: 0, timelineOutFrame: 150, rate: 1 },
      ],
    },
  ]
  const operation = { kind: 'move', clipId: 'clip-1', startMs: 5000, track: 1 }
  const afterEditPlan = materializeManualEditPlan({
    editPlan: beforeEditPlan, operation, newVersionId: resultVersionId, createdAt,
    availableAssetIds: ['source-1'], variantId: '9:16',
  })
  assert.deepEqual(
    afterEditPlan.videoTracks[1].clips.map((clip) => ({ id: clip.id, start: clip.timelineInFrame, end: clip.timelineOutFrame })),
    [{ id: 'clip-3', start: 0, end: 150 }, { id: 'clip-1', start: 150, end: 180 }],
  )
  const moved = impact({ operation, beforeEditPlan, afterEditPlan })
  assert.deepEqual(moved.affectedRanges, [{ startFrame: 0, endFrame: 180 }])
  assert.deepEqual(moved.minimalRenders[0].ranges, moved.affectedRanges)
})

test('T-FR-233 a single-clip edit still yields exactly one canonical range', () => {
  // Regression guard: the multi-range path must not fragment the common case.
  const single = impact()
  assert.equal(single.affectedRanges.length, 1)
  assert.deepEqual(single.affectedRanges, [{ startFrame: 15, endFrame: 45 }])
})

test('T-FR-233 review patch converts millisecond points to frame ranges and fences scoped outputs', () => {
  const value = createReviewPatchCommandImpact({
    commandId: 'edit-command-review-impact-1',
    baseVersionId,
    resultVersionId,
    variantIds: ['9:16'],
    operations: [{ op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1000] }],
    invalidatedRangesMs: [[1000, 1000]],
    beforeEditPlan: plan(),
    afterEditPlan: plan(resultVersionId),
    outputReferences: outputs,
  })
  assert.equal(value.commandType, 'apply-review-patch')
  assert.deepEqual(value.changeKinds, ['update-layout'])
  assert.deepEqual(value.dependencyTypes, ['visual'])
  assert.deepEqual(value.affectedRanges, [{ startFrame: 30, endFrame: 31 }])
  assert.deepEqual(value.affectedArtifacts.map((item) => item.artifactId), [
    'artifact-final-9x16', 'artifact-proxy-9x16',
  ])
  assert.deepEqual(parseCommandImpact(JSON.parse(JSON.stringify(value))), value)
  assert.equal(createCommandArtifactInvalidations({ impact: value, createdAt }).length, 2)

  const trim = createReviewPatchCommandImpact({
    commandId: 'edit-command-review-impact-2',
    baseVersionId,
    resultVersionId,
    variantIds: ['9:16'],
    operations: [{ op: 'trim', targetId: 'clip:clip-1', value: {}, rangeMs: [1000, 2000] }],
    invalidatedRangesMs: [[1000, 2000]],
    beforeEditPlan: plan(),
    afterEditPlan: { ...plan(resultVersionId), durationFrames: 150 },
    outputReferences: outputs,
  })
  assert.deepEqual(trim.dependencyTypes, ['audio', 'timing', 'visual'])
  assert.deepEqual(trim.affectedRanges, [{ startFrame: 0, endFrame: 180 }])
  const movedPlan = plan(resultVersionId)
  movedPlan.videoTracks[0].clips = [
    { ...movedPlan.videoTracks[0].clips[1], timelineInFrame: 0, timelineOutFrame: 90 },
    { ...movedPlan.videoTracks[0].clips[0], timelineInFrame: 90, timelineOutFrame: 180 },
  ]
  const moved = createReviewPatchCommandImpact({
    commandId: 'edit-command-review-impact-move', baseVersionId, resultVersionId,
    variantIds: ['9:16'],
    operations: [{ op: 'move', targetId: 'clip:clip-1', value: { afterTargetId: 'clip-2' }, rangeMs: [4000, 4000] }],
    invalidatedRangesMs: [[4000, 4000]], beforeEditPlan: plan(), afterEditPlan: movedPlan,
    outputReferences: outputs,
  })
  assert.deepEqual(moved.affectedRanges, [{ startFrame: 0, endFrame: 180 }])
  assert.throws(
    () => createReviewPatchCommandImpact({
      commandId: 'edit-command-review-impact-3', baseVersionId, resultVersionId,
      variantIds: ['9:16'], operations: [{ op: 'update-layout', targetId: 'subtitle:cue-1', value: {} }],
      invalidatedRangesMs: [[7000, 7000]], beforeEditPlan: plan(), afterEditPlan: plan(resultVersionId), outputReferences: outputs,
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /outside the timeline/.test(error.message),
  )
})

test('T-FR-233 batch review preserves disjoint canonical ranges under its own command identity', () => {
  const value = createReviewPatchCommandImpact({
    commandType: 'apply-review-patch-batch',
    commandId: 'edit-command-review-batch-impact-1',
    baseVersionId,
    resultVersionId,
    variantIds: ['9:16', '16:9'],
    operations: [
      { op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1500] },
      { op: 'update-text', targetId: 'subtitle:cue-2', value: { text: 'Revisado' }, rangeMs: [4000, 4500] },
    ],
    invalidatedRangesMs: [[4000, 4500], [1000, 1500]],
    beforeEditPlan: plan(),
    afterEditPlan: plan(resultVersionId),
    outputReferences: outputs,
  })
  assert.equal(value.commandType, 'apply-review-patch-batch')
  assert.deepEqual(value.changeKinds, ['update-layout', 'update-text'])
  assert.deepEqual(value.dependencyTypes, ['content', 'visual'])
  assert.deepEqual(value.affectedRanges, [
    { startFrame: 30, endFrame: 45 },
    { startFrame: 120, endFrame: 135 },
  ])
  assert.deepEqual(value.affectedVariantIds, ['16:9', '9:16'])
  assert.equal(value.affectedArtifacts.length, 3)
  assert.deepEqual(parseCommandImpact(JSON.parse(JSON.stringify(value))), value)
})

test('T-FR-233 applied review batch persists impact v2 and normalized invalidations', async () => {
  let committed
  const patch = {
    id: 'patch-batch-impact-1', baseVersionId,
    operations: [
      { op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1500] },
      { op: 'update-text', targetId: 'subtitle:cue-1', value: { text: 'Texto revisado' }, rangeMs: [4000, 4500] },
    ],
    annotationIds: ['annotation-batch-impact-1', 'annotation-batch-impact-2'],
    estimatedCost: 0,
    invalidatedRanges: [[1000, 1500], [4000, 4500]],
  }
  const service = applyReviewPatchBatchService({
    repository: {
      async readApplyContext() {
        return {
          currentVersion: {
            id: baseVersionId, workspaceId, projectId, sequence: 1,
            snapshotRefs: { brief: 'snapshot-brief-1', editPlan: 'snapshot-edit-1', policies: 'snapshot-policy-1' },
            baseHash: 'a'.repeat(64), createdBy: 'client-impact-1', createdAt,
          },
          editPlan: plan(), editPlanHash: 'b'.repeat(64), availableAssetIds: ['source-1'],
          renderVariantIds: ['9:16'], outputReferences: outputs,
          entries: [],
          batch: {
            id: 'review-patch-batch-impact-1', workspaceId, projectId, baseVersionId,
            mode: 'all-or-nothing', status: 'ready', patch,
            impact: { operationCount: 2, cost: 0, invalidatedRanges: patch.invalidatedRanges, changedTargets: ['subtitle:cue-1'], expectedScoreDelta: 2, invalidatedArtifacts: ['proxy', 'final'] },
            conflicts: [],
            items: patch.annotationIds.map((annotationId, index) => ({
              id: `review-patch-batch-item-impact-${index + 1}`, annotationId,
              proposalId: `review-patch-proposal-impact-${index + 1}`, status: 'included',
              operation: patch.operations[index], conflictIds: [], createdAt, updatedAt: createdAt,
            })),
            createdAt, updatedAt: createdAt,
          },
        }
      },
      async commitOrReplay(bundle) {
        committed = bundle
        return {
          batch: { id: bundle.batchId }, command: bundle.command, version: bundle.version,
          editPlan: JSON.parse(bundle.snapshot.contentJson), comparison: bundle.comparison,
          impact: bundle.impact,
          invalidations: createCommandArtifactInvalidations({ impact: bundle.impact, createdAt: bundle.command.createdAt }),
          replayed: false,
        }
      },
    },
    clock: () => new Date('2026-08-01T02:00:00.000Z'),
    createId: (kind) => ({
      'edit-command': 'edit-command-review-batch-impact-2',
      'project-version': resultVersionId,
      'project-snapshot': 'project-snapshot-review-batch-impact-2',
    })[kind],
    createEventId: () => '4e0a7962-5347-4bef-a810-95ab71340456',
  })
  const result = await service({
    workspaceId, projectId, batchId: 'review-patch-batch-impact-1', confirmed: true,
    actor: impactActor(), idempotencyKey: 'review-batch-impact-apply-1',
  })
  assert.equal(committed.command.payload.schemaVersion, 2)
  assert.equal(result.impact.commandType, 'apply-review-patch-batch')
  assert.equal(committed.command.payload.impact.impactHash, result.impact.impactHash)
  assert.equal(committed.event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(committed.event.data.artifactInvalidationCount, 2)
  assert.deepEqual(result.impact.affectedRanges, [
    { startFrame: 30, endFrame: 45 },
    { startFrame: 120, endFrame: 135 },
  ])
  assert.equal(result.invalidations.length, 2)
})

test('T-FR-233 applied review patch persists impact v2 and normalized invalidations', async () => {
  let committed
  const service = applyReviewPatchService({
    repository: {
      async readApplyContext() {
        return {
          annotation: {
            id: 'annotation-impact-1', projectVersionId: baseVersionId, frame: 30,
            timeRangeMs: [1000, 1000], screenshotRef: 'screenshot-impact-1', scope: 'point',
            targetIds: ['subtitle:cue-1'], applicationScope: { kind: 'frame', targetIds: ['subtitle:cue-1'], formatIds: ['9:16'], localeIds: ['pt-BR'], recipeIds: [], global: false },
            affectedCount: 1, text: 'Mover legenda', author: { id: 'client-impact-1', name: 'Client', type: 'api-client' }, status: 'open', createdAt,
          },
          currentVersion: {
            id: baseVersionId, workspaceId, projectId, sequence: 1,
            snapshotRefs: { brief: 'snapshot-brief-1', editPlan: 'snapshot-edit-1', policies: 'snapshot-policy-1' },
            baseHash: 'a'.repeat(64), createdBy: 'client-impact-1', createdAt,
          },
          editPlan: plan(), editPlanHash: 'b'.repeat(64), policies: {}, availableAssetIds: ['source-1'],
          renderVariantIds: ['9:16'], outputReferences: outputs,
          proposal: {
            id: 'review-proposal-impact-1', workspaceId, projectId, annotationId: 'annotation-impact-1', baseVersionId,
            status: 'ready', interpretationVersion: 'review-patch-interpreter/1.0.0', choices: [],
            patch: { id: 'patch-impact-1', baseVersionId, operations: [{ op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1000] }], annotationIds: ['annotation-impact-1'], estimatedCost: 0, invalidatedRanges: [[1000, 1000]] },
            impact: { operationCount: 1, cost: 0, invalidatedRanges: [[1000, 1000]], changedTargets: ['subtitle:cue-1'], expectedScoreDelta: 3, invalidatedArtifacts: ['proxy', 'final'] },
            gates: [], createdAt, updatedAt: createdAt,
          },
        }
      },
      async commitOrReplay(bundle) {
        committed = bundle
        return {
          proposal: { id: bundle.proposalId }, command: bundle.command, version: bundle.version,
          editPlan: JSON.parse(bundle.snapshot.contentJson), comparison: bundle.comparison,
          impact: bundle.impact,
          invalidations: createCommandArtifactInvalidations({ impact: bundle.impact, createdAt: bundle.command.createdAt }),
          replayed: false,
        }
      },
    },
    clock: () => new Date('2026-08-01T01:00:00.000Z'),
    createId: (kind) => ({
      'edit-command': 'edit-command-review-impact-4',
      'project-version': resultVersionId,
      'project-snapshot': 'project-snapshot-review-impact-2',
    })[kind],
    createEventId: () => '3e0a7962-5347-4bef-a810-95ab71340456',
  })
  const result = await service({
    workspaceId, projectId, proposalId: 'review-proposal-impact-1', confirmed: true,
    actor: impactActor(), idempotencyKey: 'review-impact-apply-1',
  })
  assert.equal(committed.command.payload.schemaVersion, 2)
  assert.equal(committed.command.payload.impact.impactHash, result.impact.impactHash)
  assert.equal(committed.event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(committed.event.data.artifactInvalidationCount, 2)
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 30, endFrame: 31 }])
  assert.equal(result.invalidations.length, 2)

  const driftRepository = new PrismaReviewPatchRepository({
    v2ReviewPatchProposal: { async findFirst() { return null } },
    async $transaction(callback) {
      return callback({
        v2ReviewPatchProposal: { async findFirst() { return { id: committed.proposalId, status: 'ready', baseVersionId } } },
        v2Project: { async findFirst() { return { format: '9:16', currentVersion: { id: baseVersionId, sequence: 1 } } } },
        v2ProjectProxyRenderOperation: { async findMany() { return [
          { outputArtifactId: 'artifact-proxy-9x16' }, { outputArtifactId: 'artifact-proxy-concurrent' },
        ] } },
        v2ProjectFinalExportOperation: { async findMany() { return [{ outputArtifactId: 'artifact-final-9x16', outputAspectRatio: '9:16' }] } },
      })
    },
  })
  await assert.rejects(
    () => driftRepository.commitOrReplay(committed),
    (error) => error.code === 'VERSION_CONFLICT' && /outputs changed/.test(error.message),
  )

  const persistedInvalidations = result.invalidations.map((invalidation) => ({
    ...invalidation,
    dependencyTypesJson: JSON.stringify(invalidation.dependencyTypes),
    affectedRangesJson: JSON.stringify(invalidation.affectedRanges),
    createdAt: new Date(invalidation.createdAt),
    resolutions: [],
  }))
  const rangeRepository = new PrismaProjectProxyRenderRepository({
    v2Project: { async findFirst() { return {
      id: projectId, workspaceId, format: '9:16', currentVersionId: resultVersionId,
      versions: [{
        id: resultVersionId, editPlanSnapshotId: committed.version.snapshotRefs.editPlan,
        editPlanSnapshot: { workspaceId, projectId, contentJson: committed.snapshot.contentJson, contentHash: committed.snapshot.contentHash },
        directorRunAsResult: null,
        command: {
          id: committed.command.id, type: 'apply-review-patch', baseVersionId,
          payloadJson: JSON.stringify(committed.command.payload), artifactInvalidations: persistedInvalidations,
        },
      }],
      mediaAssets: [{
        role: 'source-master', artifactId: 'source-1', originalFileName: 'source.mp4', createdAt: new Date(createdAt), upload: null,
        artifact: {
          id: 'source-1', status: 'available', mediaType: 'video', container: 'mp4', sha256: 'c'.repeat(64), byteSize: 4096n,
          manifests: [{ id: 'manifest-source-1', manifestJson: JSON.stringify({ artifact: { artifactKey: 'masters/source.mp4' } }) }],
        },
      }],
    } } },
    v2ProjectProxyRenderOperation: { async findFirst() { return {
      operationId: 'operation-review-base-1', outputArtifactId: 'artifact-proxy-9x16', outputManifestId: 'manifest-review-base-1',
    } } },
    v2MediaArtifact: { async findFirst() { return {
      id: 'artifact-proxy-9x16', sha256: 'd'.repeat(64), byteSize: 8192n,
      manifests: [{ id: 'manifest-review-base-1', manifestJson: JSON.stringify({ artifact: { artifactKey: 'editorial-proxies/review-base.mp4' } }) }],
    } } },
  })
  const rangeSource = await rangeRepository.readCurrentSource({ workspaceId, projectId })
  assert.equal(rangeSource.rangeReuse.commandId, committed.command.id)
  assert.deepEqual(rangeSource.rangeReuse.ranges, [{ startFrame: 30, endFrame: 31 }])
  assert.equal(rangeSource.rangeReuse.artifactId, 'artifact-proxy-9x16')
})
