import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { readArtifactInvalidationsService } from '../../src/v2/application/manual-edit.ts'
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
import { PrismaManualEditRepository } from '../../src/v2/infrastructure/prisma/manual-edit-repository.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
import { createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION, FFMPEG_EDITORIAL_RENDERER_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { buildRenderElementMap, materializePatchEditPlan, renderElementMapHash } from '../../src/v2/domain/review-system.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
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

function controlledSourceRightsRow(artifactId) {
  const rights = createAssetRightsSnapshot({ id: `rights-${artifactId}`, workspaceId,
    artifactId, sequence: 1,
    draft: { status: 'approved', allowedUses: ['rendering'], prohibitedUses: [],
      consent: { status: 'not-required', allowedUses: [] } },
    createdBy: { type: 'user', id: 'owner-impact' }, createdAt })
  return { ...rights, allowedUsesJson: '["rendering"]', prohibitedUsesJson: '[]',
    allowedWorkspaceIdsJson: JSON.stringify(rights.allowedWorkspaceIds),
    consentStatus: rights.consent.status, allowedMarketsJson: null, allowedLocalesJson: null,
    allowedSyntheticOperationsJson: null, consentAllowedUsesJson: '[]',
    consentAllowedMarketsJson: null, consentAllowedLocalesJson: null,
    consentSyntheticOperationsJson: null, consentExpiresAt: null,
    consentDocumentArtifactId: null, createdByType: 'user', createdById: 'owner-impact',
    createdAt: new Date(createdAt), expiresAt: null, owner: null, license: null,
    sourceNote: null }
}

function controlledReusableProxyFixture({
  operationId = 'operation-proxy-9x16',
  manifestId = 'manifest-proxy-9x16',
  artifactKey = 'editorial-proxies/base.mp4',
  onOperationLookup = () => {},
} = {}) {
  const artifactId = 'artifact-proxy-9x16'
  const sha256 = 'd'.repeat(64)
  const rendererDigest = createHash('sha256')
    .update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`).digest('hex')
  const createManifest = ({ recipeVersion = EDITORIAL_PROXY_RECIPE_VERSION, digest = rendererDigest } = {}) =>
    createMediaArtifactManifestV2({
      artifactKey, artifactSha256: sha256, byteSize: 8_192, mediaType: 'video', container: 'mp4',
      recipe: { id: 'editorial-proxy', version: recipeVersion,
        parameters: { inputHash: 'b'.repeat(64), projectVersionId: baseVersionId,
          editPlanSnapshotId: 'snapshot-edit-1', ocrReceipt: null } },
      sources: [{ artifactKey: 'masters/source.mp4', sha256: 'c'.repeat(64),
        role: 'source-master', execution: { tool: { id: 'ffmpeg', version: 'static', digest } } }],
    })
  const manifest = createManifest()
  // This controlled proxy has no drawn captions; it does not assert face approval.
  const map = buildRenderElementMap({
    proxyHash: sha256, fps: 30, durationFrames: 180,
    canvas: { width: 540, height: 960 }, source: { width: 1920, height: 1080 },
    clips: plan().videoTracks[0].clips, subtitleCues: [],
  })
  const rows = {
    operation: { operationId, outputArtifactId: artifactId, outputManifestId: manifestId },
    artifact: { id: artifactId, workspaceId, status: 'available', artifactKey,
      sha256, byteSize: 8_192n, manifests: [{ id: manifestId, workspaceId, artifactId,
        manifestHash: manifest.manifestHash, manifestJson: JSON.stringify(manifest) }] },
    map: { id: `map-${operationId}`, workspaceId, projectId, projectVersionId: baseVersionId,
      proxyArtifactId: artifactId, proxyHash: sha256, schemaVersion: map.schemaVersion,
      fps: map.fps, durationFrames: map.durationFrames,
      canvasWidth: map.canvas.width, canvasHeight: map.canvas.height,
      mapHash: renderElementMapHash(map), elementsJson: JSON.stringify(map.elements),
      createdAt: new Date(createdAt) },
  }
  return { rows, map, createManifest, persistence: {
    v2ProjectProxyRenderOperation: { async findFirst(query) {
      onOperationLookup(query)
      return rows.operation
    } },
    v2MediaArtifact: { async findFirst() { return rows.artifact } },
    v2RenderElementMap: { async findFirst() { return rows.map } },
  } }
}

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
  assert.equal(capability.version, '10.0.0')
  assert.equal(capability.inputSchemaRef, 'apollo://schemas/apply-project-edit-command-request/v7')
  assert.equal(capability.outputSchemaRef, 'apollo://schemas/project-edit-command-applied/v8')
  for (const previousRef of [
    'apollo://schemas/project-edit-command-applied/v3',
    'apollo://schemas/project-edit-command-applied/v4',
    'apollo://schemas/project-edit-command-applied/v5',
    'apollo://schemas/project-edit-command-applied/v6',
    'apollo://schemas/project-edit-command-applied/v7',
  ]) {
    assert.equal(getPublicSchema(previousRef).ref, previousRef)
  }

  const validate = addFormats(new Ajv2020({ strict: false, allErrors: true }))
    .compile(getPublicSchema('apollo://schemas/project-edit-command-applied/v8').schema)
  for (const example of publicSchemaExamples(getPublicSchema('apollo://schemas/project-edit-command-applied/v8'))) {
    const body = structuredClone(example)
    body.data.version = presentProjectVersionV2(
      body.data.version,
      { current: true, previewAvailable: false },
    )
    assert.equal(validate(body), true, JSON.stringify(validate.errors))
    const mismatched = structuredClone(body)
    mismatched.data.version.visibleState.label = 'superseded'
    assert.equal(validate(mismatched), false)
  }
})

test('apollo.projects.commands.apply 10.0.0 names the output variant a spoken-content removal edits and states only sealed exclusions', () => {
  const ajv = () => addFormats(new Ajv2020({ strict: false, allErrors: true }))
  const request = ajv().compile(getPublicSchema('apollo://schemas/apply-project-edit-command-request/v7').schema)
  const [removal, replacement, direction] = publicSchemaExamples(getPublicSchema('apollo://schemas/apply-project-edit-command-request/v7'))
  for (const example of [removal, replacement, direction]) assert.equal(request(example), true, JSON.stringify(request.errors))

  const { variantId: _variantId, ...withoutVariant } = removal
  assert.equal(request(withoutVariant), false, 'a removal that does not name its variant is not a command')
  assert.equal(request({ ...replacement, variantId: removal.variantId }), false, 'only the removal edits a variant')
  assert.equal(request({ ...direction, variantId: removal.variantId }), false, 'only the removal edits a variant')

  const response = ajv().compile(getPublicSchema('apollo://schemas/project-edit-command-applied/v8').schema)
  const [editorial] = publicSchemaExamples(getPublicSchema('apollo://schemas/project-edit-command-applied/v8'))
  assert.equal(editorial.data.command.type, 'remove-spoken-content')
  const present = (body) => {
    const copy = structuredClone(body)
    copy.data.version = presentProjectVersionV2(copy.data.version, { current: true, previewAvailable: false })
    return copy
  }
  assert.equal(response(present(editorial)), true, JSON.stringify(response.errors))
  const promised = structuredClone(editorial)
  promised.data.editorial.exclusions[0].labels = ['31 de janeiro']
  promised.data.editorial.exclusions[0].matchedText = '31 de janeiro'
  assert.equal(response(present(promised)), false, 'the response does not promise labels or matchedText the seal does not carry')
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

// The Command a manual crop persists, rebuilt here from the same domain constructors the service uses. The apply
// service and the repository against a sealed Version3 parent are covered by manual-edit-apply.test.mjs; this test
// is about what the proxy repositories do with the persisted result.
test('T-FR-233 a manual Command result reuses proxy ranges or the unchanged proxy only with the attested base proxy map', async () => {
  const basePlan = plan()
  const operation = { kind: 'crop', clipId: 'clip-1', crop: { x: 0.2, y: 0, width: 0.6, height: 1 } }
  const afterPlan = materializeManualEditPlan({ editPlan: basePlan, operation, newVersionId: resultVersionId, createdAt,
    availableAssetIds: ['source-1'], variantId: '9:16' })
  const cropImpact = createManualCommandImpact({ commandId, baseVersionId, resultVersionId, variantId: '9:16', targetId: 'clip-1',
    action: 'apply', operation, beforeEditPlan: basePlan, afterEditPlan: afterPlan, outputReferences: outputs })
  const committed = {
    command: { id: commandId, payload: { schemaVersion: 2, action: 'apply', expectedRevision: 1, variantId: '9:16', targetId: 'clip-1', operation, impact: cropImpact } },
    version: { snapshotRefs: { editPlan: 'project-snapshot-impact-2' } },
    snapshot: { contentJson: stableSerialize(afterPlan), contentHash: calculateVersionHash(afterPlan) },
  }
  const persistedInvalidations = createCommandArtifactInvalidations({ impact: cropImpact, createdAt }).map((item) => ({
    ...item, workspaceId, projectId, dependencyTypesJson: JSON.stringify(item.dependencyTypes),
    affectedRangesJson: JSON.stringify(item.affectedRanges), createdAt: new Date(item.createdAt),
  }))
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
  const reusableProxyFixture = controlledReusableProxyFixture({
    onOperationLookup: (query) => { proxyLookup = query },
  })
  const reusableProxyRepository = new PrismaProjectProxyRenderRepository({ async $queryRawUnsafe() { return [] },
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
          currentRightsSnapshot: controlledSourceRightsRow('source-1'),
          manifests: [{
            id: 'manifest-source-1',
            manifestJson: JSON.stringify({ artifact: { artifactKey: 'masters/source.mp4' } }),
          }],
        },
      }],
    } } },
    ...reusableProxyFixture.persistence,
  })
  const reusableSource = await reusableProxyRepository.readCurrentSource({ workspaceId, projectId })
  assert.equal(reusableSource.projectVersionId, resultVersionId)
  assert.equal(reusableSource.rangeReuse.commandId, commandId)
  assert.deepEqual(reusableSource.rangeReuse.ranges, [{ startFrame: 0, endFrame: 90 }])
  assert.equal(reusableSource.rangeReuse.artifactId, 'artifact-proxy-9x16')
  assert.deepEqual(proxyLookup.where.operation, { status: 'succeeded', phase: 'completed' })
  assert.equal(proxyLookup.where.projectVersionId, baseVersionId)
  assert.equal(proxyLookup.where.operationId, 'operation-proxy-9x16')
  assert.equal(reusableProxyFixture.rows.map.projectVersionId, baseVersionId)

  const selectionImpact = impact({
    operation: { kind: 'select', clipId: 'clip-1' },
  })
  const selectionFixture = controlledReusableProxyFixture()
  const selectionRepository = new PrismaProjectProxyRenderRepository({ async $queryRawUnsafe() { return [] },
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
          currentRightsSnapshot: controlledSourceRightsRow('source-1'),
          manifests: [{
            id: 'manifest-source-1',
            manifestJson: JSON.stringify({ artifact: { artifactKey: 'masters/source.mp4' } }),
          }],
        },
      }],
    } } },
    ...selectionFixture.persistence,
  })
  const selectionSource = await selectionRepository.readCurrentSource({ workspaceId, projectId })
  assert.equal(selectionSource.projectVersionId, resultVersionId)
  assert.equal(selectionSource.unchangedReuseRequired, true)
  assert.equal(selectionSource.unchangedReuse.operationId, 'operation-proxy-9x16')
  assert.equal(selectionSource.unchangedReuse.artifactId, 'artifact-proxy-9x16')
  assert.equal(selectionSource.unchangedReuse.impactHash, selectionImpact.impactHash)

  for (const [repository, fixture, reuseKind] of [
    [reusableProxyRepository, reusableProxyFixture, 'rangeReuse'],
    [selectionRepository, selectionFixture, 'unchangedReuse'],
  ]) {
    const validArtifact = fixture.rows.artifact
    const validMap = fixture.rows.map
    const withManifest = (manifest) => ({ ...validArtifact, manifests: [{
      ...validArtifact.manifests[0], manifestHash: manifest.manifestHash,
      manifestJson: JSON.stringify(manifest),
    }] })
    const tamperedManifest = JSON.parse(validArtifact.manifests[0].manifestJson)
    tamperedManifest.recipe.parametersHash = 'e'.repeat(64)
    const tamperedElements = JSON.parse(validMap.elementsJson)
    tamperedElements[0].opacity = 0.5
    const subtitleMap = { ...fixture.map, elements: [...fixture.map.elements, {
      ...fixture.map.elements[0], type: 'subtitle', elementId: 'subtitle:cue-1',
    }] }
    const cases = [
      ['missing map', () => { fixture.rows.map = null }],
      ['missing manifest', () => { fixture.rows.artifact = { ...validArtifact, manifests: [] } }],
      ['tampered manifest', () => { fixture.rows.artifact = withManifest(tamperedManifest) }],
      ['substituted output checksum', () => {
        fixture.rows.artifact = { ...validArtifact, sha256: 'e'.repeat(64) }
      }],
      ['tampered map hash', () => { fixture.rows.map = { ...validMap, mapHash: 'e'.repeat(64) } }],
      ['tampered map content', () => {
        fixture.rows.map = { ...validMap, elementsJson: JSON.stringify(tamperedElements) }
      }],
      ['map bound to result instead of base version', () => {
        fixture.rows.map = { ...validMap, projectVersionId: resultVersionId }
      }],
      ['manifest from another workspace', () => {
        fixture.rows.artifact = { ...validArtifact, manifests: [{
          ...validArtifact.manifests[0], workspaceId: 'workspace-other',
        }] }
      }],
      ['old recipe with a valid manifest hash', () => {
        fixture.rows.artifact = withManifest(fixture.createManifest({ recipeVersion: '1.12.0' }))
      }],
      ['wrong renderer provenance with a valid manifest hash', () => {
        fixture.rows.artifact = withManifest(fixture.createManifest({ digest: 'f'.repeat(64) }))
      }],
      ['authenticated map with drawn subtitles', () => {
        fixture.rows.map = { ...validMap, mapHash: renderElementMapHash(subtitleMap),
          elementsJson: JSON.stringify(subtitleMap.elements) }
      }],
    ]
    for (const [reason, mutate] of cases) {
      fixture.rows.artifact = validArtifact
      fixture.rows.map = validMap
      mutate()
      const rejected = await repository.readCurrentSource({ workspaceId, projectId })
      assert.equal(rejected[reuseKind], undefined, `${reuseKind}: ${reason}`)
      if (reuseKind === 'unchangedReuse') assert.equal(rejected.unchangedReuseRequired, true, reason)
    }
    fixture.rows.artifact = validArtifact
    fixture.rows.map = validMap
    assert.equal((await repository.readCurrentSource({ workspaceId, projectId }))[reuseKind].artifactId,
      validArtifact.id, `${reuseKind}: intact receipt remains reusable`)
  }
})

test('T-FR-233 completed proxy atomically records scoped invalidation resolutions', async () => {
  let invalidationQuery
  const resolutionUpserts = []
  const recipeParameters = { ocrReceipt: null, inputHash: 'a'.repeat(64), format: '9:16',
    projectVersionId: resultVersionId, editPlanSnapshotId: 'edit-plan-proxy-2' }
  const outputManifest = createMediaArtifactManifestV2({
    artifactKey: 'proxies/replacement.mp4', artifactSha256: 'd'.repeat(64),
    byteSize: 8_192, mediaType: 'video', container: 'mp4',
    recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
      parameters: recipeParameters },
    sources: [{ artifactKey: 'source/proxy-2.mp4', sha256: 'c'.repeat(64),
      role: 'source-master', execution: { tool: { id: 'ffmpeg', version: 'static',
        digest: 'f'.repeat(64) } } }],
  })
  const sourceArtifactId = 'source-proxy-2'
  const sourceManifestId = 'source-manifest-proxy-2'
  const sourceSha256 = 'c'.repeat(64)
  const sourcePlan = { schemaVersion: 2, state: 'compiled', videoTracks: [{ kind: 'base-video',
    clips: [{ sourceArtifactId, sourceInFrame: 0, sourceOutFrame: 30,
      timelineInFrame: 0, timelineOutFrame: 30, rate: 1 }] }], audioTracks: [] }
  const rights = createAssetRightsSnapshot({ id: 'rights-proxy-2', workspaceId,
    artifactId: sourceArtifactId, sequence: 1,
    draft: { status: 'approved', allowedUses: ['rendering'], prohibitedUses: [],
      consent: { status: 'not-required', allowedUses: [] } },
    createdBy: { type: 'user', id: 'owner-proxy-2' }, createdAt })
  const repository = new PrismaProjectProxyRenderRepository({ async $queryRawUnsafe() { return [] },
    async $transaction(callback) {
      return callback({
        v2ProjectProxyRenderOperation: { async findFirst() { return {
          operationId: 'operation-proxy-2', inputHash: recipeParameters.inputHash,
          projectVersionId: resultVersionId, editPlanSnapshotId: recipeParameters.editPlanSnapshotId,
          sourceArtifactId, sourceManifestId,
        } } },
        v2MediaArtifact: { async findFirst() { return { id: 'artifact-proxy-replacement',
          artifactKey: 'proxies/replacement.mp4', sha256: 'd'.repeat(64), byteSize: 8_192n,
          mediaType: 'video', container: 'mp4' } } },
        v2MediaArtifactManifest: { async findFirst() { return { id: 'manifest-proxy-replacement',
          manifestHash: outputManifest.manifestHash, manifestJson: JSON.stringify(outputManifest) } } },
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
  // The unit checks invalidation writes; its current source is controlled context. PostgreSQL
  // integration separately exercises the real scoped reader and transactional rights check.
  repository.assertCompletionLease = async () => new Date(createdAt)
  repository.lockCompletionSources = async () => new Date(createdAt)
  repository.completeProxyTransaction = async () => {}
  repository.queryProject = async () => ({ id: projectId, workspaceId, locale: 'pt-BR',
    format: '9:16', currentVersionId: resultVersionId,
    versions: [{ id: resultVersionId, editPlanSnapshotId: recipeParameters.editPlanSnapshotId,
      editPlanSnapshot: { workspaceId, projectId, contentJson: JSON.stringify(sourcePlan),
        contentHash: calculateVersionHash(sourcePlan) }, directorRunAsResult: null }],
    mediaAssets: [{ artifactId: sourceArtifactId, role: 'source-master',
      originalFileName: 'source.mp4', createdAt: new Date(createdAt), upload: null,
      artifact: { id: sourceArtifactId, sha256: sourceSha256, byteSize: 1_024n,
        mediaType: 'video', container: 'mp4', status: 'available',
        currentRightsSnapshot: { ...rights, allowedUsesJson: '["rendering"]',
          prohibitedUsesJson: '[]', allowedWorkspaceIdsJson: JSON.stringify(rights.allowedWorkspaceIds),
          consentStatus: rights.consent.status,
          allowedMarketsJson: null, allowedLocalesJson: null,
          allowedSyntheticOperationsJson: null, consentAllowedUsesJson: '[]',
          consentAllowedMarketsJson: null, consentAllowedLocalesJson: null,
          consentSyntheticOperationsJson: null, consentExpiresAt: null,
          consentDocumentArtifactId: null, createdByType: 'user', createdById: 'owner-proxy-2',
          createdAt: new Date(createdAt), expiresAt: null, owner: null, license: null,
          sourceNote: null },
        manifests: [{ id: sourceManifestId,
          manifestJson: JSON.stringify({ artifact: { artifactKey: 'source/proxy-2.mp4' } }) }] } }],
  })
  await repository.attachCompletedOutput({
    workspaceId, operationId: 'operation-proxy-2', projectId,
    projectVersionId: resultVersionId, variantId: '9:16',
    outputArtifactId: 'artifact-proxy-replacement',
    outputManifestId: 'manifest-proxy-replacement',
    originalFileName: 'replacement.mp4', createdAt, recipeParameters, ocrReceipt: null,
    lease: { owner: 'controlled-unit', attempt: 1, now: createdAt }, review: {},
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

test('W65 renderable snapshot attachment accepts only its own sealed null-OCR recipe', async () => {
  const inputHash = 'a'.repeat(64)
  const planHash = '7'.repeat(64)
  const snapshotId = 'snapshot-renderable-proxy-2'
  const artifactId = 'artifact-snapshot-proxy-2'
  const manifestId = 'manifest-snapshot-proxy-2'
  const sourceArtifactId = 'source-snapshot-proxy-2'
  const sourceManifestId = 'source-manifest-snapshot-proxy-2'
  const sourceKey = 'source/snapshot-proxy-2.mp4'
  const sourceSha256 = 'c'.repeat(64)
  const parameters = { inputHash, projectVersionId: resultVersionId,
    editPlanSnapshotId: snapshotId, format: '9:16', ocrReceipt: null }
  const manifest = createMediaArtifactManifestV2({
    artifactKey: 'proxies/snapshot-proxy-2.mp4', artifactSha256: 'd'.repeat(64),
    byteSize: 2_048, mediaType: 'video', container: 'mp4',
    recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
      parameters },
    sources: [{ artifactKey: sourceKey, sha256: sourceSha256, role: 'source-master',
      execution: { tool: { id: 'ffmpeg', version: 'static', digest: 'f'.repeat(64) } } }],
  })
  let attached = 0
  const repository = new PrismaProjectProxyRenderRepository({ async $queryRawUnsafe() { return [] },
    async $transaction(callback) {
      return callback({
        v2ProjectProxyRenderOperation: { async findFirst() { return {
          inputHash, projectVersionId: resultVersionId, editPlanSnapshotId: snapshotId,
          sourceArtifactId, sourceManifestId, renderablePlanId: 'plan-snapshot-proxy-2',
          renderablePlanHash: planHash, renderableVariantId: '9:16', renderableFormat: '9:16',
        } } },
        v2MediaArtifact: { async findFirst() { return { artifactKey: 'proxies/snapshot-proxy-2.mp4',
          sha256: 'd'.repeat(64), byteSize: 2_048n, mediaType: 'video', container: 'mp4' } } },
        v2MediaArtifactManifest: { async findFirst() { return {
          manifestJson: JSON.stringify(manifest), manifestHash: manifest.manifestHash } } },
        v2ProjectMediaAsset: { async upsert() { attached += 1 } },
      })
    },
  })
  repository.readRenderableSnapshotSource = async () => ({
    projectVersionId: resultVersionId, editPlanSnapshotId: snapshotId,
    editPlanHash: planHash, sourceArtifactId, sourceManifestId,
    renderSources: [{ artifactKey: sourceKey, sha256: sourceSha256, role: 'source-master' }],
  })
  // Isolate recipe/source binding here; transaction fencing is covered by PostgreSQL.
  repository.assertCompletionLease = async () => new Date(createdAt)
  repository.lockCompletionSources = async () => new Date(createdAt)
  repository.completeProxyTransaction = async () => {}
  const attach = (recipeParameters, ocrReceipt) => repository.attachCompletedSnapshotOutput({
    workspaceId, operationId: 'operation-snapshot-proxy-2', projectId,
    variantId: '9:16', outputArtifactId: artifactId, outputManifestId: manifestId,
    originalFileName: 'snapshot-proxy.mp4', createdAt,
    recipeParameters, ocrReceipt,
    lease: { owner: 'controlled-unit', attempt: 1, now: createdAt }, review: {},
  })
  await assert.rejects(attach({ ...parameters, ocrReceipt: { envelopeId: 'forged' } }, null),
    /receipt|recipe/i)
  await assert.rejects(attach(parameters, { envelopeId: 'forged' }), /receipt|recipe/i)
  assert.equal(attached, 0)
  await attach(parameters, null)
  assert.equal(attached, 1)
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

// The batch apply service (against a sealed Version3 parent) is covered by review-patch-batch-apply.test.mjs.

// The Command a review patch apply persists, rebuilt here from the same domain constructors the service uses.
// The apply service itself (against a sealed Version3 parent) is covered by review-patch-apply.test.mjs.
test('T-FR-233 a review patch result reuses proxy ranges only with the attested base proxy map', async () => {
  const patch = {
    id: 'patch-impact-1', baseVersionId,
    operations: [{ op: 'update-layout', targetId: 'subtitle:cue-1', value: { anchor: 'bottom' }, rangeMs: [1000, 1000] }],
    annotationIds: ['annotation-impact-1'], estimatedCost: 0, invalidatedRanges: [[1000, 1000]],
  }
  const patchedPlan = materializePatchEditPlan({ editPlan: plan(), patch, newVersionId: resultVersionId, createdAt, availableAssetIds: ['source-1'] })
  const reviewImpact = createReviewPatchCommandImpact({
    commandId: 'edit-command-review-impact-4', baseVersionId, resultVersionId, variantIds: ['9:16'],
    operations: patch.operations, invalidatedRangesMs: patch.invalidatedRanges,
    beforeEditPlan: plan(), afterEditPlan: patchedPlan, outputReferences: outputs,
  })
  const committed = {
    command: { id: 'edit-command-review-impact-4', payload: { schemaVersion: 2, proposalId: 'review-proposal-impact-1', annotationIds: patch.annotationIds, patch, impact: reviewImpact } },
    version: { snapshotRefs: { editPlan: 'project-snapshot-review-impact-2' } },
    snapshot: { contentJson: stableSerialize(patchedPlan), contentHash: calculateVersionHash(patchedPlan) },
  }
  const result = { impact: reviewImpact, invalidations: createCommandArtifactInvalidations({ impact: reviewImpact, createdAt }) }
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 30, endFrame: 31 }])
  assert.equal(result.invalidations.length, 2)

  const persistedInvalidations = result.invalidations.map((invalidation) => ({
    ...invalidation,
    dependencyTypesJson: JSON.stringify(invalidation.dependencyTypes),
    affectedRangesJson: JSON.stringify(invalidation.affectedRanges),
    createdAt: new Date(invalidation.createdAt),
    resolutions: [],
  }))
  const rangeFixture = controlledReusableProxyFixture({
    operationId: 'operation-review-base-1', manifestId: 'manifest-review-base-1',
    artifactKey: 'editorial-proxies/review-base.mp4',
  })
  const rangeRepository = new PrismaProjectProxyRenderRepository({ async $queryRawUnsafe() { return [] },
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
          currentRightsSnapshot: controlledSourceRightsRow('source-1'),
          manifests: [{ id: 'manifest-source-1', manifestJson: JSON.stringify({ artifact: { artifactKey: 'masters/source.mp4' } }) }],
        },
      }],
    } } },
    ...rangeFixture.persistence,
  })
  const rangeSource = await rangeRepository.readCurrentSource({ workspaceId, projectId })
  assert.equal(rangeSource.projectVersionId, resultVersionId)
  assert.equal(rangeSource.rangeReuse.commandId, committed.command.id)
  assert.deepEqual(rangeSource.rangeReuse.ranges, [{ startFrame: 30, endFrame: 31 }])
  assert.equal(rangeSource.rangeReuse.artifactId, 'artifact-proxy-9x16')
  assert.equal(rangeFixture.rows.map.projectVersionId, baseVersionId)
  const validMap = rangeFixture.rows.map
  rangeFixture.rows.map = null
  assert.equal((await rangeRepository.readCurrentSource({ workspaceId, projectId })).rangeReuse, undefined,
    'a review patch cannot reuse ranges without the base proxy map')
  rangeFixture.rows.map = { ...validMap, proxyHash: 'e'.repeat(64) }
  assert.equal((await rangeRepository.readCurrentSource({ workspaceId, projectId })).rangeReuse, undefined,
    'a review patch cannot reuse a map attesting different MP4 bytes')
  rangeFixture.rows.map = validMap
  assert.equal((await rangeRepository.readCurrentSource({ workspaceId, projectId })).rangeReuse.artifactId,
    'artifact-proxy-9x16')
})
