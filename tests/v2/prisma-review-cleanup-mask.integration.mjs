import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
}, async (t) => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const cleanup = async () => {
    await client.v2ReviewCleanupMask.deleteMany({ where: { workspaceId } })
    await client.v2ReviewAnnotation.deleteMany({ where: { workspaceId } })
    await client.v2TransformationBrief.deleteMany({ where: { workspaceId } })
    await client.v2ProjectProxyRenderOperation.deleteMany({ where: { workspaceId } })
    await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactLineage.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  let primaryError
  const cleanupErrors = []
  const errorFact = (stage, error) => {
    const message = Buffer.from(String(error?.message ?? error))
    return { stage, name: error?.name ?? null, code: error?.code ?? null,
      messageBytes: message.length, messageSha256: createHash('sha256').update(message).digest('hex') }
  }
  try {
    await cleanup()
    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { createReviewCleanupMaskService, refineReviewCleanupMaskService } = await import('../../src/v2/application/review-cleanup-masks.ts')
    const { createMediaArtifactManifestV2, assertMediaArtifactManifest } = await import('../../src/v2/domain/media-artifact.ts')
    const { calculateCanonicalHash, stableSerialize } = await import('../../src/v2/domain/canonical-hash.ts')
    const { createTransformationBrief } = await import('../../src/v2/domain/transformation-brief.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaCreationOutputBundleRepositoryV2 } = await import('../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts')
    const { PrismaReviewAnnotationRepository, readReviewPreviewContext } = await import('../../src/v2/infrastructure/prisma/review-annotation-repository.ts')
    const { PrismaReviewCleanupMaskRepository } = await import('../../src/v2/infrastructure/prisma/review-cleanup-mask-repository.ts')
    const { PrismaTransformationProviderRegistryRepository } = await import('../../src/v2/infrastructure/prisma/transformation-provider-registry-repository.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

    await new PrismaWorkspaceRepository(client).create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Review cleanup mask integration', status: 'active', createdAt: at(0).toISOString() }))
    const issued = await createApiClientService({ repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => at(0) })({ id: clientId, credentialId, workspaceId, name: 'Review mask client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({ ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext })
    let entity = 0
    const created = await createProjectService({ repository: new PrismaCreationOutputBundleRepositoryV2(client), clock: () => at(0), createId: (kind) => `${kind}-review-mask-${++entity}`, createEventId: randomUUID })({ workspaceId, name: 'Review mask project', objective: 'awareness', actor, idempotencyKey: 'review-mask-project' })

    const sourceArtifactId = 'artifact-review-mask-source'
    const proxyArtifactId = 'artifact-review-mask-proxy'
    // Controlled metadata only: declared artifact bytes/probe do not prove an
    // MP4, decode, FFmpeg execution or editorial approval. The execution tool
    // below authenticates this metadata-fixture script, not a renderer binary.
    const sourceManifestId = 'manifest-review-mask-source'
    const proxyManifestId = 'manifest-review-mask-proxy'
    const fixtureDigest = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')
    const probe = { fps: 30, duration: 5, width: 540, height: 960 }
    const sourceManifest = createMediaArtifactManifestV2({
      artifactKey: 'review-mask/source.mp4', artifactSha256: HASH('2'), byteSize: 1000,
      mediaType: 'video', container: 'mp4', probe,
      recipe: { id: 'fixture.source', version: '1', parameters: { test: 'T-FR-218', evidence: 'metadata-only' } },
      sources: [],
    })
    const proxyManifest = createMediaArtifactManifestV2({
      artifactKey: 'review-mask/proxy.mp4', artifactSha256: HASH('5'), byteSize: 500,
      mediaType: 'video', container: 'mp4', probe,
      recipe: { id: 'review-proxy', version: '1.0.0', parameters: {
        test: 'T-FR-218', evidence: 'metadata-only', sourceArtifactId, sourceManifestId,
        sourceManifestHash: sourceManifest.manifestHash, probe,
      } },
      sources: [{ artifactKey: sourceManifest.artifact.artifactKey, sha256: sourceManifest.artifact.sha256,
        role: 'source-master', execution: { tool: { id: 'metadata-fixture', version: '1', digest: fixtureDigest } } }],
    })
    for (const [artifactId, manifestId, manifest] of [
      [sourceArtifactId, sourceManifestId, sourceManifest], [proxyArtifactId, proxyManifestId, proxyManifest],
    ]) {
      await client.v2MediaArtifact.create({ data: {
        id: artifactId, workspaceId, artifactKey: manifest.artifact.artifactKey, sha256: manifest.artifact.sha256,
        byteSize: BigInt(manifest.artifact.byteSize), mediaType: manifest.artifact.mediaType,
        container: manifest.artifact.container, status: 'available', createdAt: at(1),
      } })
      await client.v2MediaArtifactManifest.create({ data: {
        id: manifestId, workspaceId, artifactId, schemaVersion: manifest.schemaVersion, manifestHash: manifest.manifestHash,
        recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version, parametersHash: manifest.recipe.parametersHash,
        manifestJson: stableSerialize(manifest), createdAt: at(1),
      } })
      const [storedArtifact, storedManifest] = await Promise.all([
        client.v2MediaArtifact.findUniqueOrThrow({ where: { id: artifactId } }),
        client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: manifestId } }),
      ])
      assert.deepEqual([
        storedArtifact.id, storedArtifact.workspaceId, storedArtifact.artifactKey, storedArtifact.sha256,
        storedArtifact.byteSize, storedArtifact.mediaType, storedArtifact.container, storedArtifact.status,
      ], [artifactId, workspaceId, manifest.artifact.artifactKey, manifest.artifact.sha256,
        BigInt(manifest.artifact.byteSize), manifest.artifact.mediaType, manifest.artifact.container, 'available'])
      assert.deepEqual([
        storedManifest.id, storedManifest.workspaceId, storedManifest.artifactId, storedManifest.schemaVersion,
        storedManifest.manifestHash, storedManifest.recipeId, storedManifest.recipeVersion, storedManifest.parametersHash,
        storedManifest.recipeParametersRef, storedManifest.renderInputRef, storedManifest.renderInputHash,
      ], [manifestId, workspaceId, artifactId, manifest.schemaVersion, manifest.manifestHash,
        manifest.recipe.id, manifest.recipe.version, manifest.recipe.parametersHash, null, null, null])
      const parsed = JSON.parse(storedManifest.manifestJson)
      assertMediaArtifactManifest(parsed); assert.deepEqual(parsed, manifest)
    }
    const sourceExecution = proxyManifest.sources[0].execution.tool
    await client.v2MediaArtifactLineage.create({ data: {
      id: 'lineage-review-mask-proxy-source', workspaceId, manifestId: proxyManifestId, sourceArtifactId,
      role: proxyManifest.sources[0].role, ordinal: 0, toolId: sourceExecution.id,
      toolVersion: sourceExecution.version, toolDigest: sourceExecution.digest, createdAt: at(1),
    } })
    const storedLineage = await client.v2MediaArtifactLineage.findUniqueOrThrow({ where: { id: 'lineage-review-mask-proxy-source' } })
    assert.deepEqual([storedLineage.workspaceId, storedLineage.manifestId, storedLineage.sourceArtifactId,
      storedLineage.role, storedLineage.ordinal, storedLineage.toolId, storedLineage.toolVersion, storedLineage.toolDigest],
    [workspaceId, proxyManifestId, sourceArtifactId, 'source-master', 0, sourceExecution.id, sourceExecution.version, sourceExecution.digest])
    await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId: created.projectAtCreation.id, artifactId: proxyArtifactId, role: 'editing-proxy', originalFileName: 'proxy.mp4', createdAt: at(1) } })
    const operationId = 'operation-review-mask-proxy'
    await client.v2PublicOperation.create({ data: {
      id: operationId, workspaceId, projectId: created.projectAtCreation.id, clientId,
      actorCredentialId: credentialId, actorEnvironment: 'production',
      actorAuthenticationKind: 'bearer', actorContextHash: materializeActorAuditContext(actor).contextHash,
      type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
      targetType: 'media-artifact', targetId: proxyArtifactId, cancelable: false, retryable: false,
      progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
      attempt: 1, resultJson: JSON.stringify({ artifactId: proxyArtifactId }),
      idempotencyKey: 'review-mask-proxy-render', requestFingerprint: HASH('a'),
      createdAt: at(1), updatedAt: at(1), startedAt: at(1), completedAt: at(1),
    } })
    await client.v2ProjectProxyRenderOperation.create({ data: {
      operationId, workspaceId, projectId: created.projectAtCreation.id, projectVersionId: created.creationVersion.id,
      editPlanSnapshotId: created.creationVersion.snapshotRefs.editPlan, sourceArtifactId,
      sourceManifestId, colorPipelineBindingsJson: JSON.stringify([]), inputHash: HASH('b'),
      outputArtifactId: proxyArtifactId, outputManifestId: proxyManifestId,
      originalFileName: 'proxy.mp4', createdAt: at(1),
    } })

    const annotations = new PrismaReviewAnnotationRepository(client)
    const previewInput = { workspaceId, projectId: created.projectAtCreation.id, projectVersionId: created.creationVersion.id }
    const preview = await annotations.readPreviewContext(previewInput)
    assert.deepEqual([preview?.proxyArtifactId, preview?.proxyHash, preview?.projectVersionId,
      preview?.sourceVersionId, preview?.fps, preview?.width, preview?.height, preview?.durationFrames, preview?.stale],
    [proxyArtifactId, proxyManifest.artifact.sha256, created.creationVersion.id, created.creationVersion.id, 30, 540, 960, 150, false])
    const fixtureBaseline = async () => ({
      masks: await client.v2ReviewCleanupMask.count({ where: { workspaceId } }),
      annotations: await client.v2ReviewAnnotation.count({ where: { workspaceId } }),
      operations: await client.v2PublicOperation.count({ where: { workspaceId } }),
      outbox: await client.v2PublicEventOutbox.count({ where: { workspaceId } }),
      project: await client.v2Project.findUniqueOrThrow({ where: { id: created.projectAtCreation.id } }),
    })
    const beforeCorruption = await fixtureBaseline()
    const corruptJson = structuredClone(proxyManifest)
    corruptJson.probe.width += 1 // Deliberately retain the original seal.
    const { manifestHash: _priorHash, ...contradictoryBody } = structuredClone(proxyManifest)
    contradictoryBody.artifact.byteSize += 1
    const resealedContradiction = { ...contradictoryBody, manifestHash: calculateCanonicalHash(contradictoryBody) }
    assertMediaArtifactManifest(resealedContradiction)
    assert.notEqual(resealedContradiction.manifestHash, proxyManifest.manifestHash)
    for (const [label, document] of [['manifest-json-tampered', corruptJson],
      ['manifest-resealed-artifact-row-mismatch', resealedContradiction]]) {
      await assert.rejects(() => client.$transaction(async (transaction) => {
        await transaction.v2MediaArtifactManifest.update({ where: { id: proxyManifestId }, data: {
          manifestJson: stableSerialize(document), manifestHash: document.manifestHash,
        } })
        const actual = await transaction.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: proxyManifestId } })
        assert.equal(actual.manifestHash, document.manifestHash)
        assert.deepEqual(JSON.parse(actual.manifestJson), document)
        await readReviewPreviewContext(transaction, previewInput)
        throw new Error('Review preview unexpectedly accepted ' + label) // Always roll back even if the guard regresses.
      }), (error) => error.code === 'PERSISTENCE_CONFLICT' && error.details?.manifestId === proxyManifestId, label)
      const restored = await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: proxyManifestId } })
      assert.equal(restored.manifestHash, proxyManifest.manifestHash)
      assert.deepEqual(JSON.parse(restored.manifestJson), proxyManifest)
      assert.deepEqual(await fixtureBaseline(), beforeCorruption, label + ' has zero persisted effects')
      assert.deepEqual(await annotations.readPreviewContext(previewInput), preview, label + ' restored legitimate preview')
    }

    const annotation = Object.freeze({
      id: randomUUID(), projectVersionId: created.creationVersion.id, proxyArtifactId, proxyHash: HASH('5'), frame: 60,
      timeRangeMs: Object.freeze([2_000, 3_000]), screenshotRef: 'data:image/jpeg;base64,AA==', scope: 'region',
      region: Object.freeze({ x: .1, y: .78, width: .8, height: .12 }), targetIds: Object.freeze([]),
      applicationScope: Object.freeze({ kind: 'region', targetIds: Object.freeze([]), formatIds: Object.freeze(['output-vertical']), localeIds: Object.freeze(['pt-BR']), recipeIds: Object.freeze([]), global: false }),
      affectedCount: 1, text: 'Remover a legenda queimada.', author: Object.freeze({ id: clientId, name: clientId, type: 'api-client' }),
      authenticationAudit: materializeActorAuditContext(actor), status: 'open', createdAt: at(2).toISOString(),
    })
    await annotations.create({ workspaceId, projectId: created.projectAtCreation.id, annotation, idempotencyKey: 'annotation-review-mask', requestFingerprint: HASH('8') })

    const brief = createTransformationBrief({
      workspaceId, projectId: created.projectAtCreation.id, projectVersionId: created.creationVersion.id, storyPlanId: 'story-review-mask', storyPlanHash: HASH('1'),
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
    const request = { workspaceId, projectId: created.projectAtCreation.id, annotationId: annotation.id, transformationBriefId: brief.id, format: { outputSpecId: 'output-vertical', width: 540, height: 960 }, trackingConfidenceBps: 9000, actor, idempotencyKey: 'create-review-mask-int' }
    const first = await create(request)
    const replay = await create(request)
    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(await client.v2ReviewCleanupMask.count({ where: { workspaceId } }), 1)

    const refine = refineReviewCleanupMaskService({ masks, clock: () => at(4), createMaskId: () => `review-cleanup-mask-int-${++maskSequence}` })
    const prior = first.persisted.mask
    const refined = await refine({ workspaceId, projectId: created.projectAtCreation.id, maskId: prior.id, expectedMaskHash: prior.maskHash, region: prior.region, range: prior.range, keyframes: [...prior.keyframes, { frame: 75, region: { x: .11, y: .79, width: .78, height: .1 } }], trackingStatus: 'tracked', trackingConfidenceBps: 8800, actor, idempotencyKey: 'refine-review-mask-int' })
    assert.equal(refined.persisted.mask.revision, 2)
    assert.equal((await masks.readLatest({ workspaceId, projectId: created.projectAtCreation.id, rootId: prior.rootId })).mask.id, refined.persisted.mask.id)
    await client.v2ReviewCleanupMask.update({ where: { id: refined.persisted.mask.id }, data: { maskHash: HASH('9') } })
    await assert.rejects(() => masks.read({ workspaceId, projectId: created.projectAtCreation.id, maskId: refined.persisted.mask.id }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  } catch (error) { primaryError = error }
  finally {
    try { await cleanup() } catch (error) { cleanupErrors.push({ stage: 'fixture-cleanup', error }) }
    try { await client.$disconnect() } catch (error) { cleanupErrors.push({ stage: 'prisma-disconnect', error }) }
    for (const { stage, error } of cleanupErrors) t.diagnostic(JSON.stringify(errorFact(stage, error)))
  }
  if (primaryError) throw primaryError
  if (cleanupErrors.length) throw cleanupErrors[0].error
})
