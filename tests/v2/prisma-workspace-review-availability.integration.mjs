import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Controlled PostgreSQL rows, not rendered media or editorial acceptance.
// Run only in an exclusively owned disposable V2 database. Unique IDs and no
// teardown DELETE preserve immutable snapshots; owner resets after clients/PG0.
// The project and its Versions are the sealed ones the product writes (creation Command, one explicit output variant, no-op
// child Commands: tests/v2/helpers/pg-output-world.mjs). Manifest rows are append-only, so a stored contradiction is INSERTED
// (a newer, forged manifest row of the same artifact, which is the one a reader takes) and never updated in place.
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
  const { createApiAccessAuditContext } = await import('../../src/v2/domain/api-access-control.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { commitSealedChild, seedSealedProject, testActor } = await import('./helpers/pg-output-world.mjs')
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
    // A project that has no Version at all: a row without a Version is still insertable (and has no format: 6.0.0 creates none).
    const emptyProject = async (label) => {
      const id = `project-${label}-${runId}`
      await client.v2Project.create({ data: { id, workspaceId, name: `Controlled ${label}`, status: 'draft',
        locale: 'pt-BR', objective: 'discovery', createdByType: 'api-client', createdById: clientId, createdAt: at, updatedAt: at } })
      return id
    }
    // The main project is the sealed world the product builds: creation Command, then one explicit output variant as its head.
    const actor = testActor({ workspaceId, clientId, credentialId: issued.credential.id, environment: 'production' })
    const world = await seedSealedProject(client, { workspaceId, actor, prefix: 'review-availability',
      ids: { project: `project-main-${runId}` }, name: 'Controlled main' })
    // What a proxy publication names of a Version: its id and its EditPlan snapshot.
    const versionRef = (bundle) => ({ id: bundle.version.id, editPlanSnapshotId: bundle.editPlanSnapshot.id })
    // A real no-op child Command (the head moves unless `moveHead` is false), one Version per label.
    const child = async (label, options = {}) => versionRef(await commitSealedChild(client,
      { workspaceId, projectId: world.projectId, actor, suffix: `review-availability-${runId}-${label}`, ...options }))
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
        editPlanSnapshotId: v.editPlanSnapshotId, sourceArtifactId: source.id, sourceManifestId: source.manifestId,
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
    const emptyId = await emptyProject('no-version'), empty = await repository.read(scope(emptyId))
    assert.equal(empty.reviewAvailability.requestedVersionId, null)
    assert.deepEqual(empty.reviewAvailability.annotations, { state: 'unavailable', reason: 'no-version' })
    assert.deepEqual(empty.reviewAvailability.proxyReview, { state: 'unavailable', reason: 'no-version' })
    const projectId = world.projectId, v1 = versionRef(world.head)
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId, v1.id)
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
    const v2 = await child('v2')
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId, v2.id)
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
    // The next Version is stored first (a sealed Version is slow to write: the reader's own transaction is bounded to 10 s) and
    // the head stays on v2; the head moves with the publication below, in one commit, while the reader is latched.
    const v3 = await child('v3', { moveHead: false }), thirdOutput = await artifact('third')
    pendingRead = latched.read(scope(projectId))
    void pendingRead.catch(() => {}) // Later awaited; prevent an early latch failure becoming an unhandled rejection.
    await Promise.race([reached, new Promise((_, reject) => { latchTimer = setTimeout(() => reject(new Error('snapshot latch not reached')), 5_000) })])
    clearTimeout(latchTimer)
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
    // Documents resealed with the domain constructor must still match rows. A stored manifest row is append-only (a
    // trigger refuses UPDATE and DELETE), so a corruption is a forged manifest row INSERTED for the same artifact, newer than
    // the honest one: the readers take the newest manifest of an artifact. Every forgery is rolled back with its transaction
    // and the honest rows read back unchanged.
    const originalManifestRow = await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: thirdOutput.manifestId } })
    const originalArtifactRow = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: thirdOutput.id } })
    const original = manifestFacts.get(thirdOutput.id)
    const forgedAt = new Date(at.getTime() + 3_600_000)
    // The forged document is valid for the domain; `label` is a recipe parameter, so every forgery has its own manifest hash
    // (an artifact keeps one row per manifest hash).
    const forge = (facts, label, override = {}) => createMediaArtifactManifest({ artifactKey: facts.manifest.artifact.artifactKey,
      artifactSha256: facts.manifest.artifact.sha256, byteSize: facts.manifest.artifact.byteSize,
      mediaType: facts.manifest.artifact.mediaType, container: facts.manifest.artifact.container,
      recipe: { id: facts.manifest.recipe.id, version: facts.manifest.recipe.version, parameters: { ...facts.parameters, forged: label } },
      probe: facts.manifest.probe, ...override })
    let forgeries = 0
    // The row stores the document's own facts unless a column is overridden; the row id is unique to the run and the forgery.
    const insertForged = async (tx, artifactId, document, columns = {}) => {
      const id = `manifest-forged-${++forgeries}-${runId}`
      await tx.v2MediaArtifactManifest.create({ data: { id, workspaceId, artifactId, schemaVersion: document.schemaVersion,
        manifestHash: document.manifestHash, recipeId: document.recipe.id, recipeVersion: document.recipe.version,
        parametersHash: document.recipe.parametersHash, manifestJson: stableSerialize(document), createdAt: forgedAt, ...columns } })
      return id
    }
    const storeResealed = async (tx, document) => {
      assertMediaArtifactManifest(document) // Independently prove domain validity before the reader.
      return insertForged(tx, thirdOutput.id, document)
    }
    const alteredProbe = (document) => ({ ...document, probe: { ...document.probe, fps: 60 } })
    const manifestNegatives = [
      ['JSON without reseal', (tx) => insertForged(tx, thirdOutput.id, forge(original, 'json'), {
        manifestJson: stableSerialize(alteredProbe(forge(original, 'json'))) })],
      ['stored schema', (tx) => insertForged(tx, thirdOutput.id, forge(original, 'schema'), { schemaVersion: 'media-artifact-manifest/v2' })],
      ['stored recipe ID', (tx) => insertForged(tx, thirdOutput.id, forge(original, 'recipe-id'), { recipeId: 'different-valid-recipe' })],
      ['stored recipe version', (tx) => insertForged(tx, thirdOutput.id, forge(original, 'recipe-version'), { recipeVersion: '2.0.0' })],
      ['stored parameters hash', (tx) => insertForged(tx, thirdOutput.id, forge(original, 'parameters-hash'), { parametersHash: 'f'.repeat(64) })],
      ...Object.entries({ artifactKey: `controlled-review/${runId}/forged.mp4`, artifactSha256: 'f'.repeat(64),
        byteSize: 8192, mediaType: 'audio', container: 'mkv' }).map(([field, value]) =>
        [`fully resealed ${field} contradicts artifact row`, (tx) => storeResealed(tx, forge(original, field, { [field]: value }))]),
    ]
    for (const [label, mutate] of manifestNegatives) {
      await assert.rejects(() => client.$transaction(async (tx) => {
        const forgedId = await mutate(tx)
        const manifestConflict = (error) => error.code === 'PERSISTENCE_CONFLICT' &&
          error.message === 'Stored projection manifest failed integrity or row binding validation' &&
          error.details?.manifestId === forgedId
        await assert.rejects(() => readReviewPreviewContext(tx, { ...scope(projectId), projectVersionId: v3.id }), manifestConflict, label)
        const sameSnapshot = new PrismaProjectWorkspaceQueryRepository({ $transaction: (action) => action(tx) })
        await assert.rejects(() => sameSnapshot.read(scope(projectId)), manifestConflict, label)
        throw rollback
      }), (error) => error === rollback, label)
      assert.deepEqual(await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: thirdOutput.manifestId } }), originalManifestRow, label)
      assert.equal(await client.v2MediaArtifactManifest.count({ where: { artifactId: thirdOutput.id } }), 1, `${label}: the forgery was rolled back`)
      assert.deepEqual(await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: thirdOutput.id } }), originalArtifactRow, label)
    }
    const sourceManifestRow = await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: source.manifestId } })
    const sourceFacts = manifestFacts.get(source.id)
    const sourceResealed = forge(sourceFacts, 'source', { artifactKey: `controlled-review/${runId}/forged-source.mp4` })
    assertMediaArtifactManifest(sourceResealed)
    await assert.rejects(() => client.$transaction(async (tx) => {
      const forgedId = await insertForged(tx, source.id, sourceResealed)
      // Preview/report artifacts remain intact. Only workspace media hydration
      // confronts this valid resealed source document with its original row.
      assert.equal((await readReviewPreviewContext(tx, { ...scope(projectId), projectVersionId: v3.id })).proxyArtifactId, thirdOutput.id)
      const sameSnapshot = new PrismaProjectWorkspaceQueryRepository({ $transaction: (action) => action(tx) })
      await assert.rejects(() => sameSnapshot.read(scope(projectId)), (error) => error.code === 'PERSISTENCE_CONFLICT' &&
        error.message === 'Stored projection manifest failed integrity or row binding validation' && error.details?.manifestId === forgedId)
      throw rollback
    }), (error) => error === rollback)
    assert.deepEqual(await client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: source.manifestId } }), sourceManifestRow)
    assert.equal(await client.v2MediaArtifactManifest.count({ where: { artifactId: source.id } }), 1, 'the source forgery was rolled back')

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
