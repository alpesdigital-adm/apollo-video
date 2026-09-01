import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const workspaceId = 'review-cleanup-mask-int-workspace'
const clientId = 'review-cleanup-mask-int-client'
const credentialId = 'review-cleanup-mask-int-credential'
const HASH = (value) => value.repeat(64)
const at = (second) => new Date(Date.parse('2029-04-01T00:00:00.000Z') + second * 1_000)

test('T-FR-218 persists, replays and refines a review-derived mask in PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 240_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const cleanup = async () => {
    await client.v2ReviewCleanupMask.deleteMany({ where: { workspaceId } })
    await client.v2ReviewAnnotation.deleteMany({ where: { workspaceId } })
    await client.v2TransformationBrief.deleteMany({ where: { workspaceId } })
    await client.v2ProjectProxyRenderOperation.deleteMany({ where: { workspaceId } })
    await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { createReviewCleanupMaskService, refineReviewCleanupMaskService } = await import('../../src/v2/application/review-cleanup-masks.ts')
    const { createTransformationBrief } = await import('../../src/v2/domain/transformation-brief.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaReviewAnnotationRepository } = await import('../../src/v2/infrastructure/prisma/review-annotation-repository.ts')
    const { PrismaReviewCleanupMaskRepository } = await import('../../src/v2/infrastructure/prisma/review-cleanup-mask-repository.ts')
    const { PrismaTransformationProviderRegistryRepository } = await import('../../src/v2/infrastructure/prisma/transformation-provider-registry-repository.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

    await new PrismaWorkspaceRepository(client).create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Review cleanup mask integration', status: 'active', createdAt: at(0).toISOString() }))
    const issued = await createApiClientService({ repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => at(0) })({ id: clientId, credentialId, workspaceId, name: 'Review mask client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({ ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext })
    let entity = 0
    const created = await createProjectService({ repository: new PrismaProjectCreationRepository(client), clock: () => at(0), createId: (kind) => `${kind}-review-mask-${++entity}`, createEventId: randomUUID })({ workspaceId, name: 'Review mask project', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'review-mask-project' } })

    const sourceArtifactId = 'artifact-review-mask-source'
    const proxyArtifactId = 'artifact-review-mask-proxy'
    await client.v2MediaArtifact.createMany({ data: [
      { id: sourceArtifactId, workspaceId, artifactKey: 'review-mask/source.mp4', sha256: HASH('2'), byteSize: 1000n, mediaType: 'video', container: 'mp4', status: 'available', createdAt: at(1) },
      { id: proxyArtifactId, workspaceId, artifactKey: 'review-mask/proxy.mp4', sha256: HASH('5'), byteSize: 500n, mediaType: 'video', container: 'mp4', status: 'available', createdAt: at(1) },
    ] })
    await client.v2MediaArtifactManifest.create({ data: {
      id: 'manifest-review-mask-proxy', workspaceId, artifactId: proxyArtifactId, schemaVersion: 'media-artifact-manifest/v1', manifestHash: HASH('6'),
      recipeId: 'review-proxy', recipeVersion: '1.0.0', parametersHash: HASH('7'),
      manifestJson: JSON.stringify({ probe: { fps: 30, duration: 5, width: 540, height: 960 } }), createdAt: at(1),
    } })
    await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId: created.project.id, artifactId: proxyArtifactId, role: 'editing-proxy', originalFileName: 'proxy.mp4', createdAt: at(1) } })
    const operationId = 'operation-review-mask-proxy'
    await client.v2PublicOperation.create({ data: {
      id: operationId, workspaceId, projectId: created.project.id, clientId,
      actorClientId: clientId, actorCredentialId: credentialId, actorEnvironment: 'production',
      actorAuthenticationKind: 'bearer', actorContextHash: materializeActorAuditContext(actor).contextHash,
      type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
      targetType: 'media-artifact', targetId: proxyArtifactId, cancelable: false, retryable: false,
      attempt: 1, resultJson: JSON.stringify({ artifactId: proxyArtifactId }),
      idempotencyKey: 'review-mask-proxy-render', requestFingerprint: HASH('a'),
      createdAt: at(1), updatedAt: at(1), startedAt: at(1), completedAt: at(1),
    } })
    await client.v2ProjectProxyRenderOperation.create({ data: {
      operationId, workspaceId, projectId: created.project.id, projectVersionId: created.version.id,
      editPlanSnapshotId: created.version.snapshotRefs.editPlan, sourceArtifactId: proxyArtifactId,
      sourceManifestId: 'manifest-review-mask-proxy', inputHash: HASH('b'),
      outputArtifactId: proxyArtifactId, outputManifestId: 'manifest-review-mask-proxy',
      originalFileName: 'proxy.mp4', createdAt: at(1),
    } })

    const annotations = new PrismaReviewAnnotationRepository(client)
    const annotation = Object.freeze({
      id: randomUUID(), projectVersionId: created.version.id, proxyArtifactId, proxyHash: HASH('5'), frame: 60,
      timeRangeMs: Object.freeze([2_000, 3_000]), screenshotRef: 'data:image/jpeg;base64,AA==', scope: 'region',
      region: Object.freeze({ x: .1, y: .78, width: .8, height: .12 }), targetIds: Object.freeze([]),
      applicationScope: Object.freeze({ kind: 'region', targetIds: Object.freeze([]), formatIds: Object.freeze(['output-vertical']), localeIds: Object.freeze(['pt-BR']), recipeIds: Object.freeze([]), global: false }),
      affectedCount: 1, text: 'Remover a legenda queimada.', author: Object.freeze({ id: clientId, name: clientId, type: 'api-client' }),
      authenticationAudit: materializeActorAuditContext(actor), status: 'open', createdAt: at(2).toISOString(),
    })
    await annotations.create({ workspaceId, projectId: created.project.id, annotation, idempotencyKey: 'annotation-review-mask', requestFingerprint: HASH('8') })

    const brief = createTransformationBrief({
      workspaceId, projectId: created.project.id, projectVersionId: created.version.id, storyPlanId: 'story-review-mask', storyPlanHash: HASH('1'),
      sourceArtifactId, sourceArtifactHash: HASH('2'), sourceRange: { startFrame: 30, endFrame: 150 }, intent: 'world-shift',
      editorialIntent: 'Remover marca sobre o fundo sem alterar a pessoa.', mode: 'object-environment-change', prompt: 'Reconstruir somente pixels sob a máscara.',
      negativeConstraints: ['não alterar a pessoa'], preserve: ['identity', 'speech'], allowedChanges: ['background-pixels-under-mask'], target: { cleanup: 'inpaint' },
      outputSpecIds: ['output-vertical'], intensityBps: 1000, noveltyBps: 500, safety: ['no-face-change'],
      safeZones: [{ x: .3, y: .05, width: .4, height: .55, purpose: 'subject' }], fallbackLadder: ['source-unchanged'],
      rightsSnapshotId: 'rights-review-mask', rightsSnapshotHash: HASH('3'), identitySnapshotId: 'identity-review-mask', identitySnapshotHash: HASH('4'), createdAt: at(2).toISOString(),
    })
    const registry = new PrismaTransformationProviderRegistryRepository(client)
    await registry.persistBrief({ brief })
    const masks = new PrismaReviewCleanupMaskRepository(client)
    const artifacts = new PrismaMediaArtifactRepository(client)
    let maskSequence = 0
    const create = createReviewCleanupMaskService({ masks, annotations, registry, artifacts, clock: () => at(3), createMaskId: () => `review-cleanup-mask-int-${++maskSequence}` })
    const request = { workspaceId, projectId: created.project.id, annotationId: annotation.id, transformationBriefId: brief.id, format: { outputSpecId: 'output-vertical', width: 540, height: 960 }, trackingConfidenceBps: 9000, actor, idempotencyKey: 'create-review-mask-int' }
    const first = await create(request)
    const replay = await create(request)
    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(await client.v2ReviewCleanupMask.count({ where: { workspaceId } }), 1)

    const refine = refineReviewCleanupMaskService({ masks, clock: () => at(4), createMaskId: () => `review-cleanup-mask-int-${++maskSequence}` })
    const prior = first.persisted.mask
    const refined = await refine({ workspaceId, projectId: created.project.id, maskId: prior.id, expectedMaskHash: prior.maskHash, region: prior.region, range: prior.range, keyframes: [...prior.keyframes, { frame: 75, region: { x: .11, y: .79, width: .78, height: .1 } }], trackingStatus: 'tracked', trackingConfidenceBps: 8800, actor, idempotencyKey: 'refine-review-mask-int' })
    assert.equal(refined.persisted.mask.revision, 2)
    assert.equal((await masks.readLatest({ workspaceId, projectId: created.project.id, rootId: prior.rootId })).mask.id, refined.persisted.mask.id)
    await client.v2ReviewCleanupMask.update({ where: { id: refined.persisted.mask.id }, data: { maskHash: HASH('9') } })
    await assert.rejects(() => masks.read({ workspaceId, projectId: created.project.id, maskId: refined.persisted.mask.id }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  } finally {
    await cleanup().catch(() => undefined)
    await client.$disconnect()
  }
})
