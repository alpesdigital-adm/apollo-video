import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Controlled PostgreSQL rows, not rendered media or editorial acceptance.
// Run only in an exclusively owned disposable V2 database. Unique IDs and no
// teardown DELETE preserve immutable snapshots; owner resets after clients/PG0.
test('workspace availability reads one repeatable PG snapshot and rejects stored manifest/operation contradictions', {
  skip: process.env.APOLLO_WORKSPACE_REVIEW_AVAILABILITY_PG !== '1' && 'requires exclusive disposable V2 PostgreSQL',
  timeout: 60_000,
}, async () => {
  const { PrismaClient } = await import('../../generated/prisma-v2/index.js')
  const { PrismaProjectWorkspaceQueryRepository } = await import('../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts')
  const { readReviewPreviewContext } = await import('../../src/v2/infrastructure/prisma/review-annotation-repository.ts')
  const { calculateVersionHash: hash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { calculateProxyReviewHash } = await import('../../src/v2/application/render-workflow.ts')
  const { assertMediaArtifactManifest, createMediaArtifactManifest } = await import('../../src/v2/domain/media-artifact.ts')
  const { createProductionBrief } = await import('../../src/v2/domain/production-brief.ts')
  const { createApiAccessAuditContext } = await import('../../src/v2/domain/api-access-control.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const runId = randomUUID(), workspaceId = `review-availability-${runId}`, clientId = `review-client-${runId}`
  const at = new Date('2026-10-12T10:00:00.000Z'), client = new PrismaClient()
  const repository = new PrismaProjectWorkspaceQueryRepository(client)
  let releaseSnapshot, snapshotRead, pendingRead, latchTimer
  try {
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Controlled review availability', status: 'active', createdAt: at, updatedAt: at } })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => at,
    })({ id: clientId, workspaceId, name: 'Controlled PG review contract', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const audit = createApiAccessAuditContext({ clientId, credentialId: issued.credential.id,
      workspaceId, environment: 'production', authenticationKind: 'bearer' })
    const project = async (label) => {
      const id = `project-${label}-${runId}`
      await client.v2Project.create({ data: { id, workspaceId, name: `Controlled ${label}`, status: 'draft',
        format: '9:16', locale: 'pt-BR', objective: 'discovery', createdByType: 'api-client', createdById: clientId, createdAt: at, updatedAt: at } })
      return id
    }
    const version = async (projectId, sequence, parentVersionId) => {
      const id = `version-${sequence}-${projectId}`, snapshots = {}
      for (const kind of ['brief', 'policies', 'edit-plan']) {
        const content = kind === 'brief' ? { schemaVersion: 1, productionBrief: createProductionBrief({ ownerText: 'Contrato controlado de leitura, sem aceite editorial.' }) }
          : kind === 'edit-plan' ? { schemaVersion: 2, id: `plan-${id}`, projectVersionId: id, state: 'compiled', fps: 30,
              durationFrames: 60, videoTracks: [], markers: [], movementPolicy: { automaticZoom: false }, subtitlePolicy: { faceProtection: true } }
            : { schemaVersion: 1, state: 'configured' }
        const facts = { workspaceId, projectId, kind, schemaVersion: kind === 'edit-plan' ? 2 : 1,
          contentJson: stableSerialize(content), contentHash: hash(content) }
        const existing = await client.v2ProjectSnapshot.findUnique({ where: {
          projectId_kind_contentHash: { projectId, kind, contentHash: facts.contentHash },
        } })
        if (existing) {
          assert.notEqual(kind, 'edit-plan', 'Each fixture version materializes its own EditPlan identity')
          for (const [key, value] of Object.entries(facts)) {
            assert.equal(existing[key], value, `Immutable fixture snapshot ${kind}: ${key}`)
          }
          snapshots[kind] = existing.id
        } else {
          snapshots[kind] = `snapshot-${kind}-${id}`
          await client.v2ProjectSnapshot.create({ data: { id: snapshots[kind], ...facts, createdAt: at } })
        }
      }
      await client.v2ProjectVersion.create({ data: { id, workspaceId, projectId, sequence, parentVersionId,
        briefSnapshotId: snapshots.brief, policiesSnapshotId: snapshots.policies, editPlanSnapshotId: snapshots['edit-plan'],
        baseHash: hash({ projectId, id, snapshots }), createdBy: clientId, createdAt: at } })
      return { id, snapshots }
    }
    const manifestFacts = new Map()
    const artifact = async (label) => {
      const id = `artifact-${label}-${runId}`, manifestId = `manifest-${label}-${runId}`, sha256 = hash({ label, runId })
      const artifactKey = `controlled-review/${runId}/${label}.mp4`
      const manifest = createMediaArtifactManifest({ artifactKey, artifactSha256: sha256, byteSize: 4096, mediaType: 'video', container: 'mp4',
        recipe: { id: 'controlled-review-fixture', version: '1.0.0', parameters: { label, runId } },
        probe: { width: 540, height: 960, duration: 2, fps: 30 } })
      await client.v2MediaArtifact.create({ data: { id, workspaceId, artifactKey, sha256, byteSize: 4096n, mediaType: 'video', container: 'mp4', status: 'available', createdAt: at } })
      await client.v2MediaArtifactManifest.create({ data: { id: manifestId, workspaceId, artifactId: id, schemaVersion: manifest.schemaVersion,
        manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version,
        parametersHash: manifest.recipe.parametersHash, manifestJson: stableSerialize(manifest), createdAt: at } })
      manifestFacts.set(id, { manifest, parameters: { label, runId } })
      return { id, manifestId, sha256 }
    }
    const published = async (tx, projectId, v, source, output, ordinal, withReport = true) => {
      const operationId = `operation-${ordinal}-${projectId}`, inputHash = hash({ operationId, versionId: v.id, source, output })
      const createdAt = new Date(at.getTime() + ordinal * 10_000), completedAt = new Date(createdAt.getTime() + 2_000)
      // Explicit controlled references exercise stored binding syntax only.
      // No compiled pixels, actual color compilation or worker success is claimed.
      const binding = { sourceArtifactId: source.id, sourceManifestId: source.manifestId,
        compilationId: `controlled-color-${operationId}`, compilationHash: hash({ operationId, kind: 'compilation' }), pipelineHash: hash({ operationId, kind: 'pipeline' }) }
      await tx.v2PublicOperation.create({ data: { id: operationId, workspaceId, projectId, clientId,
        actorCredentialId: audit.credentialId, actorEnvironment: audit.environment, actorAuthenticationKind: audit.authenticationKind, actorContextHash: audit.contextHash,
        type: 'project-proxy-render', status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: output.id,
        progressCompleted: 4, progressTotal: 4, progressUnit: 'render', cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
        idempotencyKey: `${operationId}-request`, requestFingerprint: inputHash, createdAt, updatedAt: completedAt,
        startedAt: new Date(createdAt.getTime() + 1_000), completedAt,
        resultJson: stableSerialize({ resource: { type: 'media-artifact', id: output.id, manifestId: output.manifestId } }) } })
      await tx.v2ProjectProxyRenderOperation.create({ data: { operationId, workspaceId, projectId, projectVersionId: v.id,
        editPlanSnapshotId: v.snapshots['edit-plan'], sourceArtifactId: source.id, sourceManifestId: source.manifestId,
        colorPipelineBindingsJson: stableSerialize([binding]), inputHash, outputArtifactId: output.id, outputManifestId: output.manifestId,
        originalFileName: 'controlled.mp4', createdAt } })
      const reviewId = `report-${operationId}`
      if (withReport) {
        const body = { schemaVersion: 'proxy-review/v1', projectVersionId: v.id, proxyArtifactId: output.id, proxyManifestId: output.manifestId,
          inputHash, outputSpecId: 'proxy-review-controlled-1', rangeCacheKey: hash({ operationId, range: true }),
          spec: { width: 540, height: 960, codec: 'h264', container: 'mp4', quality: 'review', reusableRanges: true },
          status: 'blocked', technicalIssues: [], criticIssues: [{ code: 'FACE_PERCEPTION_UNAVAILABLE', severity: 'hard', category: 'editorial',
            message: 'Controlled fixture has no detector authority.', correctable: true }],
          warningsAcknowledged: false, finalAllowed: false, uploadReceivedAt: createdAt.toISOString(), renderCompletedAt: completedAt.toISOString(), timeToFirstProxyMs: 2_000 }
        await tx.v2ProxyReview.create({ data: { id: reviewId, workspaceId, projectId, projectVersionId: v.id, operationId,
          proxyArtifactId: output.id, proxyManifestId: output.manifestId, inputHash, outputSpecId: body.outputSpecId, rangeCacheKey: body.rangeCacheKey,
          specJson: stableSerialize(body.spec), status: 'blocked', technicalIssuesJson: '[]', criticIssuesJson: stableSerialize(body.criticIssues),
          warningsAcknowledged: false, finalAllowed: false, reviewHash: calculateProxyReviewHash(body), revision: 1,
          uploadReceivedAt: createdAt, renderCompletedAt: completedAt, timeToFirstProxyMs: 2_000n, createdAt, updatedAt: completedAt } })
      }
      return { operationId, reviewId, output }
    }
    const scope = (projectId) => ({ workspaceId, projectId })
    const emptyId = await project('no-version'), empty = await repository.read(scope(emptyId))
    assert.equal(empty.reviewAvailability.requestedVersionId, null)
    assert.deepEqual(empty.reviewAvailability.annotations, { state: 'unavailable', reason: 'no-version' })
    assert.deepEqual(empty.reviewAvailability.proxyReview, { state: 'unavailable', reason: 'no-version' })
    const projectId = await project('main'), v1 = await version(projectId, 1)
    await client.v2Project.update({ where: { id: projectId }, data: { currentVersionId: v1.id } })
    const source = await artifact('source')
    await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId: source.id,
      role: 'source-master', originalFileName: 'source.mp4', createdAt: at } })
    const noProxy = await repository.read(scope(projectId))
    assert.equal(noProxy.media.length, 1)
    assert.deepEqual(noProxy.reviewAvailability.annotations, { state: 'unavailable', reason: 'no-proxy' })
    assert.deepEqual(noProxy.reviewAvailability.proxyReview, { state: 'unavailable', reason: 'no-report' })
    assert.equal(await readReviewPreviewContext(client, { ...scope(projectId), projectVersionId: `missing-${runId}` }), null)
    const fallback = await artifact('editing')
    await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId: fallback.id,
      role: 'editing-proxy', originalFileName: 'editing.mp4', createdAt: at } })
    const editing = await repository.read(scope(projectId))
    assert.equal(editing.reviewAvailability.annotations.sourceVersionId, null)
    assert.equal(editing.reviewAvailability.annotations.proxyArtifactId, fallback.id)
    assert.equal(editing.reviewAvailability.annotations.stale, true)
    const firstOutput = await artifact('first')
    const first = await client.$transaction((tx) => published(tx, projectId, v1, source, firstOutput, 1))
    const current = await repository.read(scope(projectId))
    assert.equal(current.reviewAvailability.annotations.sourceVersionId, v1.id)
    assert.equal(current.reviewAvailability.annotations.stale, false)
    assert.equal(current.reviewAvailability.proxyReview.reviewId, first.reviewId)
    assert.equal(current.operations[0].id, first.operationId)
    const v2 = await version(projectId, 2, v1.id)
    await client.v2Project.update({ where: { id: projectId }, data: { currentVersionId: v2.id } })
    const stale = await repository.read(scope(projectId))
    assert.equal(stale.reviewAvailability.requestedVersionId, v2.id)
    assert.equal(stale.reviewAvailability.annotations.sourceVersionId, v1.id)
    assert.equal(stale.reviewAvailability.annotations.stale, true)
    assert.deepEqual(stale.reviewAvailability.proxyReview, { state: 'unavailable', reason: 'no-report' })
    const secondOutput = await artifact('second')
    const second = await client.$transaction((tx) => published(tx, projectId, v2, source, secondOutput, 2, false))
    const noReport = await repository.read(scope(projectId))
    assert.equal(noReport.reviewAvailability.annotations.sourceVersionId, v2.id)
    assert.equal(noReport.reviewAvailability.annotations.proxyArtifactId, secondOutput.id)
    assert.deepEqual(noReport.reviewAvailability.proxyReview, { state: 'unavailable', reason: 'no-report' })

    // First SELECT fixes MVCC. Commit head+operation+blocked report on another
    // connection while the reader is latched, then require the OLD coherent
    // aggregate and a NEW coherent aggregate on the next read.
    const reached = new Promise((resolve) => { snapshotRead = resolve })
    const release = new Promise((resolve) => { releaseSnapshot = resolve })
    let firstSelect = true
    const latched = new PrismaProjectWorkspaceQueryRepository({
      $transaction(action, options) {
        return client.$transaction((tx) => action(new Proxy(tx, {
          get(target, key) {
            if (key !== 'v2Project') return target[key]
            return new Proxy(target.v2Project, { get(delegate, method) {
              if (method !== 'findFirst') return delegate[method]
              return async (args) => {
                const value = await delegate.findFirst(args)
                if (firstSelect) { firstSelect = false; snapshotRead(); await release }
                return value
              }
            } })
          },
        })), options)
      },
    })
    pendingRead = latched.read(scope(projectId))
    void pendingRead.catch(() => {}) // Later awaited; prevent an early latch failure becoming an unhandled rejection.
    await Promise.race([reached, new Promise((_, reject) => { latchTimer = setTimeout(() => reject(new Error('snapshot latch not reached')), 5_000) })])
    clearTimeout(latchTimer)
    const v3 = await version(projectId, 3, v2.id), thirdOutput = await artifact('third')
    const third = await client.$transaction(async (tx) => {
      const result = await published(tx, projectId, v3, source, thirdOutput, 3)
      await tx.v2Project.update({ where: { id: projectId }, data: { currentVersionId: v3.id } })
      return result
    })
    releaseSnapshot()
    const before = await pendingRead
    assert.equal(before.version.id, v2.id)
    assert.equal(before.reviewAvailability.requestedVersionId, v2.id)
    assert.equal(before.reviewAvailability.annotations.sourceVersionId, v2.id)
    assert.equal(before.reviewAvailability.annotations.proxyArtifactId, secondOutput.id)
    assert.equal(before.operations[0].id, second.operationId)
    assert.equal(before.operations.some((op) => op.id === third.operationId), false)
    assert.deepEqual(before.reviewAvailability.proxyReview, { state: 'unavailable', reason: 'no-report' })
    const after = await repository.read(scope(projectId))
    assert.equal(after.version.id, v3.id)
    assert.equal(after.reviewAvailability.annotations.sourceVersionId, v3.id)
    assert.equal(after.reviewAvailability.annotations.proxyArtifactId, thirdOutput.id)
    assert.equal(after.reviewAvailability.proxyReview.reviewId, third.reviewId)
    assert.equal(after.operations[0].id, third.operationId)
    const rollback = new Error('controlled negative rolled back')
    for (const [label, mutate] of [
      ['report hash', (tx) => tx.v2ProxyReview.update({ where: { id: third.reviewId }, data: { reviewHash: '0'.repeat(64) } })],
      ['publication artifact', (tx) => tx.v2ProjectProxyRenderOperation.update({ where: { operationId: third.operationId }, data: { outputArtifactId: firstOutput.id } })],
      ['unavailable artifact', (tx) => tx.v2MediaArtifact.update({ where: { id: thirdOutput.id }, data: { status: 'quarantined' } })],
    ]) {
      await assert.rejects(() => client.$transaction(async (tx) => {
        await mutate(tx)
        const sameSnapshot = new PrismaProjectWorkspaceQueryRepository({ $transaction: (action) => action(tx) })
        await assert.rejects(() => sameSnapshot.read(scope(projectId)), (error) => error.code === 'PERSISTENCE_CONFLICT', label)
        throw rollback
      }), (error) => error === rollback, label)
    }

    // New integrity negatives stay in the same real PG suite/latch setup.
    // Documents resealed with the domain constructor must still match rows;
    // every corruption is rolled back and both stored row facts read back.
    const originalManifestRow = await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: thirdOutput.manifestId } })
    const originalArtifactRow = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: thirdOutput.id } })
    const original = manifestFacts.get(thirdOutput.id)
    const reseal = (override) => createMediaArtifactManifest({ artifactKey: original.manifest.artifact.artifactKey,
      artifactSha256: original.manifest.artifact.sha256, byteSize: original.manifest.artifact.byteSize,
      mediaType: original.manifest.artifact.mediaType, container: original.manifest.artifact.container,
      recipe: { id: original.manifest.recipe.id, version: original.manifest.recipe.version, parameters: original.parameters },
      probe: original.manifest.probe, ...override })
    const storeResealed = async (tx, document) => {
      assertMediaArtifactManifest(document) // Independently prove domain validity before the reader.
      await tx.v2MediaArtifactManifest.update({ where: { id: thirdOutput.manifestId }, data: {
        schemaVersion: document.schemaVersion, manifestHash: document.manifestHash, recipeId: document.recipe.id,
        recipeVersion: document.recipe.version, parametersHash: document.recipe.parametersHash, manifestJson: stableSerialize(document) } })
    }
    const alteredProbe = { ...original.manifest, probe: { ...original.manifest.probe, fps: 60 } }
    const manifestNegatives = [
      ['JSON without reseal', (tx) => tx.v2MediaArtifactManifest.update({ where: { id: thirdOutput.manifestId }, data: { manifestJson: stableSerialize(alteredProbe) } })],
      ['stored schema', (tx) => tx.v2MediaArtifactManifest.update({ where: { id: thirdOutput.manifestId }, data: { schemaVersion: 'media-artifact-manifest/v2' } })],
      ['stored recipe ID', (tx) => tx.v2MediaArtifactManifest.update({ where: { id: thirdOutput.manifestId }, data: { recipeId: 'different-valid-recipe' } })],
      ['stored recipe version', (tx) => tx.v2MediaArtifactManifest.update({ where: { id: thirdOutput.manifestId }, data: { recipeVersion: '2.0.0' } })],
      ['stored parameters hash', (tx) => tx.v2MediaArtifactManifest.update({ where: { id: thirdOutput.manifestId }, data: { parametersHash: 'f'.repeat(64) } })],
      ...Object.entries({ artifactKey: `controlled-review/${runId}/forged.mp4`, artifactSha256: 'f'.repeat(64),
        byteSize: 8192, mediaType: 'audio', container: 'mkv' }).map(([field, value]) =>
        [`fully resealed ${field} contradicts artifact row`, (tx) => storeResealed(tx, reseal({ [field]: value }))]),
    ]
    const manifestConflict = (error) => error.code === 'PERSISTENCE_CONFLICT' &&
      error.message === 'Stored projection manifest failed integrity or row binding validation' &&
      error.details?.manifestId === thirdOutput.manifestId
    for (const [label, mutate] of manifestNegatives) {
      await assert.rejects(() => client.$transaction(async (tx) => {
        await mutate(tx)
        await assert.rejects(() => readReviewPreviewContext(tx, { ...scope(projectId), projectVersionId: v3.id }), manifestConflict, label)
        const sameSnapshot = new PrismaProjectWorkspaceQueryRepository({ $transaction: (action) => action(tx) })
        await assert.rejects(() => sameSnapshot.read(scope(projectId)), manifestConflict, label)
        throw rollback
      }), (error) => error === rollback, label)
      assert.deepEqual(await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: thirdOutput.manifestId } }), originalManifestRow, label)
      assert.deepEqual(await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: thirdOutput.id } }), originalArtifactRow, label)
    }
    const sourceManifestRow = await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: source.manifestId } })
    const sourceFacts = manifestFacts.get(source.id)
    const sourceResealed = createMediaArtifactManifest({ artifactKey: `controlled-review/${runId}/forged-source.mp4`,
      artifactSha256: sourceFacts.manifest.artifact.sha256, byteSize: sourceFacts.manifest.artifact.byteSize,
      mediaType: sourceFacts.manifest.artifact.mediaType, container: sourceFacts.manifest.artifact.container,
      recipe: { id: sourceFacts.manifest.recipe.id, version: sourceFacts.manifest.recipe.version, parameters: sourceFacts.parameters },
      probe: sourceFacts.manifest.probe })
    assertMediaArtifactManifest(sourceResealed)
    await assert.rejects(() => client.$transaction(async (tx) => {
      await tx.v2MediaArtifactManifest.update({ where: { id: source.manifestId }, data: {
        manifestHash: sourceResealed.manifestHash, manifestJson: stableSerialize(sourceResealed) } })
      // Preview/report artifacts remain intact. Only workspace media hydration
      // confronts this valid resealed source document with its original row.
      assert.equal((await readReviewPreviewContext(tx, { ...scope(projectId), projectVersionId: v3.id })).proxyArtifactId, thirdOutput.id)
      const sameSnapshot = new PrismaProjectWorkspaceQueryRepository({ $transaction: (action) => action(tx) })
      await assert.rejects(() => sameSnapshot.read(scope(projectId)), (error) => error.code === 'PERSISTENCE_CONFLICT' &&
        error.message === 'Stored projection manifest failed integrity or row binding validation' && error.details?.manifestId === source.manifestId)
      throw rollback
    }), (error) => error === rollback)
    assert.deepEqual(await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: source.manifestId } }), sourceManifestRow)

    // The detail belongs to main while its actual operation row is changed to
    // an existing sister project. A where-filter on the detail cannot bless it.
    const originalOperationRow = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: third.operationId } })
    await assert.rejects(() => client.$transaction(async (tx) => {
      await tx.v2PublicOperation.update({ where: { id: third.operationId }, data: { projectId: emptyId } })
      const operationConflict = (error) => error.code === 'PERSISTENCE_CONFLICT' && error.message === 'Review preview operation belongs to another project'
      await assert.rejects(() => readReviewPreviewContext(tx, { ...scope(projectId), projectVersionId: v3.id }), operationConflict)
      const sameSnapshot = new PrismaProjectWorkspaceQueryRepository({ $transaction: (action) => action(tx) })
      await assert.rejects(() => sameSnapshot.read(scope(projectId)), operationConflict)
      throw rollback
    }), (error) => error === rollback)
    assert.deepEqual(await client.v2PublicOperation.findUniqueOrThrow({ where: { id: third.operationId } }), originalOperationRow)
    assert.equal((await repository.read(scope(projectId))).reviewAvailability.proxyReview.reviewId, third.reviewId)
  } finally {
    clearTimeout(latchTimer)
    releaseSnapshot?.()
    if (pendingRead) await pendingRead.catch(() => {})
    await client.$disconnect()
  }
})
