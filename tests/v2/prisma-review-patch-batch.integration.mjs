import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/v1/health`)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('T-FR-215 batch review persists atomic apply, conflict rollback, explicit partial retry and transaction rollback', {
  skip: process.env.APOLLO_REVIEW_PATCH_BATCH_E2E !== '1' && 'set APOLLO_REVIEW_PATCH_BATCH_E2E=1 and use an isolated V2 database',
}, async () => {
  const { proposeReviewPatchBatchService, applyReviewPatchBatchService } = await import('../../src/v2/application/review-patch-batch.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaReviewPatchBatchRepository } = await import('../../src/v2/infrastructure/prisma/review-patch-batch-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `batch-review-workspace-${suffix}`
  const projectId = `batch-review-project-${suffix}`
  const artifactId = `batch-review-artifact-${suffix}`
  const initialVersionId = `batch-review-version-${suffix}`
  const createdAt = new Date('2026-07-26T14:00:00.000Z')
  const artifactHash = calculateVersionHash({ artifactId })
  const repository = new PrismaReviewPatchBatchRepository(client)
  let server
  let authenticatedActor

  const cleanup = async () => {
    await client.v2CommandArtifactInvalidation.deleteMany({ where: { workspaceId } })
    await client.v2ReviewPatchBatch.deleteMany({ where: { workspaceId } })
    await client.v2ReviewPatchProposal.deleteMany({ where: { workspaceId } })
    await client.v2ReviewAnnotation.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2ProjectProxyRenderOperation.deleteMany({ where: { workspaceId } })
    await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  const seedAnnotationAndProposal = async ({ versionId, targetId, text, operationText }) => {
    const audit = materializeActorAuditContext(authenticatedActor)
    const actorAuditData = {
      actorClientId: audit.clientId,
      actorCredentialId: audit.credentialId,
      actorEnvironment: audit.environment,
      actorAuthenticationKind: audit.authenticationKind,
      actorContextHash: audit.contextHash,
      delegatedUserId: audit.delegatedUserId ?? null,
      delegatedIdentityId: audit.delegatedIdentityId ?? null,
      workspaceRole: audit.workspaceRole ?? null,
    }
    const annotationId = randomUUID()
    const proposalId = randomUUID()
    const frame = targetId.endsWith('2') ? 60 : 30
    const patch = {
      id: `patch-${randomUUID()}`,
      baseVersionId: versionId,
      operations: [{ op: 'update-text', targetId, value: { text: operationText }, rangeMs: [frame * 33, frame * 33] }],
      annotationIds: [annotationId],
      estimatedCost: 0,
      invalidatedRanges: [[frame * 33, frame * 33]],
    }
    const impact = {
      operationCount: 1,
      cost: 0,
      invalidatedRanges: patch.invalidatedRanges,
      changedTargets: [targetId],
      expectedScoreDelta: 1,
      invalidatedArtifacts: ['proxy', 'final'],
    }
    await client.v2ReviewAnnotation.create({ data: {
      id: annotationId, workspaceId, projectId, projectVersionId: versionId, proxyArtifactId: artifactId, proxyHash: artifactHash,
      frame, timeStartMs: frame * 33, timeEndMs: frame * 33, scope: 'point',
      targetIdsJson: stableSerialize([targetId]), applicationScopeJson: stableSerialize({ kind: 'scene', targetIds: ['scene:clip-1'], formatIds: ['9:16'], localeIds: ['pt-BR'], recipeIds: ['project-proxy-render'], global: false }),
      affectedCount: 1, screenshotRef: 'data:image/jpeg;base64,/9j/2Q==', text,
      authorType: 'api-client', authorId: audit.clientId, authorName: audit.clientId, status: 'open',
      ...actorAuditData,
      idempotencyKey: `annotation-${annotationId}`, requestFingerprint: calculateVersionHash({ annotationId }), createdAt, updatedAt: createdAt,
    } })
    await client.v2ReviewPatchProposal.create({ data: {
      id: proposalId, workspaceId, projectId, annotationId, baseVersionId: versionId, status: 'ready',
      interpretationVersion: 'review-patch-interpreter/1.0.0+review-patch-policy/1.0.0',
      choicesJson: '[]', patchJson: stableSerialize(patch), impactJson: stableSerialize(impact),
      gatesJson: stableSerialize([
        { gate: 'ambiguity', passed: true, message: 'resolved', targetIds: [targetId] },
        { gate: 'protected-elements', passed: true, message: 'allowed', targetIds: [] },
        { gate: 'policy', passed: true, message: 'allowed', targetIds: [targetId] },
        { gate: 'budget', passed: true, message: 'allowed', targetIds: [targetId] },
      ]),
      ...actorAuditData,
      idempotencyKey: `proposal-${proposalId}`, requestFingerprint: calculateVersionHash({ proposalId }), createdAt, updatedAt: createdAt,
    } })
    return { annotationId, proposalId }
  }

  const proposeBatch = (proposalIds, mode, key) => proposeReviewPatchBatchService({
    repository,
    clock: () => createdAt,
    createId: (kind) => kind === 'patch' ? `patch-${randomUUID()}` : randomUUID(),
  })({ workspaceId, projectId, proposalIds, mode, actor: authenticatedActor, idempotencyKey: key })

  const applyBatch = (batchId, key, selectedRepository = repository) => applyReviewPatchBatchService({
    repository: selectedRepository,
    clock: () => new Date(createdAt.getTime() + 1_000),
    createId: (kind) => `${kind}-${randomUUID()}`,
    createEventId: randomUUID,
  })({
    workspaceId, projectId, batchId, confirmed: true,
    actor: authenticatedActor,
    idempotencyKey: key,
  })

  try {
    await cleanup()
    const brief = { schemaVersion: 1, objective: 'discovery', createdAt: createdAt.toISOString() }
    const policies = { schemaVersion: 1, state: 'configured', createdAt: createdAt.toISOString() }
    const editPlan = {
      schemaVersion: 2, state: 'compiled', id: `edit-plan-${initialVersionId}`, projectVersionId: initialVersionId,
      storyPlanId: 'story-batch', treatmentPlanId: 'treatment-batch', directorRunId: 'director-batch', fps: 30, durationFrames: 150,
      sources: [{ id: artifactId, artifactId, kind: 'video', durationSeconds: 5 }],
      videoTracks: [{ id: 'track-primary-video', kind: 'base-video', clips: [{ id: 'clip-1', sourceArtifactId: artifactId, sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150, rate: 1 }] }],
      overlayTracks: [],
      subtitleTracks: [{ id: 'track-captions', kind: 'captions', presetId: 'clean-color', anchor: 'bottom', faceProtection: true, maxLines: 2, maxCharactersPerBlock: 32, cues: [
        { id: 'cue-1', startFrame: 0, endFrame: 75, text: 'Primeira legenda', anchor: 'bottom' },
        { id: 'cue-2', startFrame: 75, endFrame: 150, text: 'Segunda legenda', anchor: 'bottom' },
      ] }],
      audioTracks: [], effectTracks: [], markers: [], transitions: [], protectedElements: [], localeVariantRefs: [], formatVariantRefs: [],
      lineageRefs: [artifactId], movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
      subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
      composition: { layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1, verticalPosition: 0.5 },
      director: { plannerVersion: 'batch-e2e', decisions: [], assumptions: [] }, createdAt: createdAt.toISOString(),
    }
    const briefId = `batch-brief-${suffix}`
    const policiesId = `batch-policies-${suffix}`
    const editPlanId = `batch-edit-plan-${suffix}`
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Batch Review Workspace', status: 'active', createdAt, updatedAt: createdAt } })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `batch-test-client-${suffix}`,
      workspaceId,
      name: 'Batch Review E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const auditContext = createExternalAuditContext({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
    })
    authenticatedActor = Object.freeze({
      ...auditContext,
      scopes: new Set(['projects:read', 'projects:write']),
      authenticationKind: 'bearer',
      clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active',
      workspaceAccessStatus: 'active',
      auditContext,
    })
    await client.v2Project.create({ data: { id: projectId, workspaceId, name: 'Batch Review Project', status: 'reviewing-proxy', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdByType: 'api-client', createdById: 'batch-test-client', createdAt, updatedAt: createdAt } })
    for (const [id, kind, content] of [[briefId, 'brief', brief], [policiesId, 'policies', policies], [editPlanId, 'edit-plan', editPlan]]) {
      await client.v2ProjectSnapshot.create({ data: { id, workspaceId, projectId, kind, schemaVersion: kind === 'edit-plan' ? 2 : 1, contentJson: stableSerialize(content), contentHash: calculateVersionHash(content), createdAt } })
    }
    await client.v2ProjectVersion.create({ data: { id: initialVersionId, workspaceId, projectId, sequence: 1, briefSnapshotId: briefId, editPlanSnapshotId: editPlanId, policiesSnapshotId: policiesId, baseHash: calculateVersionHash({ projectId, editPlan }), createdBy: 'batch-test-client', createdAt } })
    await client.v2Project.update({ where: { id: projectId }, data: { currentVersionId: initialVersionId } })
    await client.v2MediaArtifact.create({ data: { id: artifactId, workspaceId, artifactKey: `batch/${artifactId}.mp4`, sha256: artifactHash, byteSize: 1n, mediaType: 'video', container: 'mp4', status: 'available', createdAt } })
    await client.v2MediaArtifactManifest.create({ data: {
      id: `batch-review-manifest-${suffix}`, workspaceId, artifactId,
      schemaVersion: 'media-artifact-manifest/v2', manifestHash: calculateVersionHash({ artifactId, manifest: true }),
      recipeId: 'batch-review-source', recipeVersion: '1.0.0', parametersHash: calculateVersionHash({ source: true }),
      manifestJson: stableSerialize({ artifact: { artifactKey: `batch/${artifactId}.mp4` }, probe: { width: 640, height: 360, duration: 5, fps: 30 } }),
      createdAt,
    } })
    await client.v2ProjectMediaAsset.createMany({ data: [
      { id: randomUUID(), workspaceId, projectId, artifactId, role: 'source-master', originalFileName: 'batch.mp4', createdAt },
      { id: randomUUID(), workspaceId, projectId, artifactId, role: 'editing-proxy', originalFileName: 'batch.mp4', createdAt },
    ] })
    const seedOperationId = `batch-review-seed-operation-${suffix}`
    const seedAuthenticationAudit = materializeActorAuditContext(authenticatedActor)
    await client.v2PublicOperation.create({ data: {
      id: seedOperationId, workspaceId, projectId, clientId: issued.client.id, type: 'project-proxy-render',
      actorClientId: seedAuthenticationAudit.clientId,
      actorCredentialId: seedAuthenticationAudit.credentialId,
      actorEnvironment: seedAuthenticationAudit.environment,
      actorAuthenticationKind: seedAuthenticationAudit.authenticationKind,
      actorContextHash: seedAuthenticationAudit.contextHash,
      status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: artifactId,
      cancelable: false, retryable: false, attempt: 1, resultJson: stableSerialize({ artifactId }),
      idempotencyKey: `batch-review-seed-${suffix}`, requestFingerprint: calculateVersionHash({ seedOperationId }),
      createdAt, updatedAt: createdAt, startedAt: createdAt, completedAt: createdAt,
    } })
    await client.v2ProjectProxyRenderOperation.create({ data: {
      operationId: seedOperationId, workspaceId, projectId, projectVersionId: initialVersionId,
      editPlanSnapshotId: editPlanId, sourceArtifactId: artifactId,
      sourceManifestId: `batch-review-manifest-${suffix}`,
      inputHash: calculateVersionHash({ seedOperationId, input: true }), outputArtifactId: artifactId,
      outputManifestId: `batch-review-manifest-${suffix}`, originalFileName: 'batch.mp4', createdAt,
    } })

    const first = await seedAnnotationAndProposal({ versionId: initialVersionId, targetId: 'subtitle:cue-1', text: 'Trocar primeira legenda.', operationText: 'Primeira corrigida' })
    const second = await seedAnnotationAndProposal({ versionId: initialVersionId, targetId: 'subtitle:cue-2', text: 'Trocar segunda legenda.', operationText: 'Segunda corrigida' })
    const ready = await proposeBatch([first.proposalId, second.proposalId], 'all-or-nothing', `batch-ready-${suffix}`)
    assert.equal(ready.batch.status, 'ready')
    assert.equal(ready.batch.authenticationAudit.credentialId, authenticatedActor.credentialId)
    const storedReadyBatch = await client.v2ReviewPatchBatch.findUniqueOrThrow({
      where: { id: ready.batch.id },
    })
    assert.equal(storedReadyBatch.actorClientId, authenticatedActor.clientId)
    assert.equal(storedReadyBatch.actorCredentialId, authenticatedActor.credentialId)
    assert.match(storedReadyBatch.actorContextHash, /^[a-f0-9]{64}$/)
    assert.equal(ready.batch.patch.operations.length, 2)
    const applied = await applyBatch(ready.batch.id, `batch-ready-apply-${suffix}`)
    assert.equal(applied.version.sequence, 2)
    assert.equal(applied.batch.items.filter((item) => item.status === 'applied').length, 2)
    assert.equal(applied.impact.commandType, 'apply-review-patch-batch')
    assert.deepEqual(applied.impact.affectedRanges, [{ startFrame: 29, endFrame: 30 }, { startFrame: 59, endFrame: 60 }])
    assert.equal(applied.invalidations.length, 1)
    assert.equal(applied.invalidations[0].artifactId, artifactId)
    const appliedCommand = await client.v2EditCommand.findUniqueOrThrow({ where: { id: applied.command.id } })
    assert.equal(appliedCommand.actorId, issued.client.id)
    assert.equal(appliedCommand.actorCredentialId, issued.credential.id)
    assert.match(appliedCommand.actorContextHash, /^[a-f0-9]{64}$/)
    const persistedInvalidations = await client.v2CommandArtifactInvalidation.findMany({ where: { commandId: applied.command.id } })
    assert.equal(persistedInvalidations.length, 1)
    const replayed = await applyBatch(ready.batch.id, `batch-ready-apply-${suffix}`)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.impact.impactHash, applied.impact.impactHash)
    assert.equal(replayed.invalidations.length, 1)
    const firstResolutionEvents = await client.v2PublicEventOutbox.findMany({
      where: {
        workspaceId,
        type: 'annotation.resolved',
        resourceId: { in: [first.annotationId, second.annotationId] },
      },
    })
    assert.equal(firstResolutionEvents.length, 2)
    assert.ok(firstResolutionEvents.every((event) => {
      const data = JSON.parse(event.dataJson)
      return data.batchId === ready.batch.id && data.status === 'applied' && !('text' in data)
    }))
    assert.match(JSON.stringify(applied.editPlan), /Primeira corrigida/)
    assert.match(JSON.stringify(applied.editPlan), /Segunda corrigida/)

    const currentVersionId = applied.version.id
    const conflictA = await seedAnnotationAndProposal({ versionId: currentVersionId, targetId: 'subtitle:cue-1', text: 'Usar texto A.', operationText: 'Texto A' })
    const conflictB = await seedAnnotationAndProposal({ versionId: currentVersionId, targetId: 'subtitle:cue-1', text: 'Usar texto B.', operationText: 'Texto B' })
    const safe = await seedAnnotationAndProposal({ versionId: currentVersionId, targetId: 'subtitle:cue-2', text: 'Usar texto seguro.', operationText: 'Texto seguro' })
    const atomic = await proposeBatch([conflictA.proposalId, conflictB.proposalId, safe.proposalId], 'all-or-nothing', `batch-conflict-${suffix}`)
    assert.equal(atomic.batch.status, 'conflict')
    assert.equal(atomic.batch.patch, null)
    assert.ok(atomic.batch.items.every((item) => item.status === 'rolled-back'))
    await assert.rejects(() => applyBatch(atomic.batch.id, `batch-conflict-apply-${suffix}`), (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED')
    assert.equal((await client.v2Project.findUnique({ where: { id: projectId } })).currentVersionId, currentVersionId)

    const partial = await proposeBatch([conflictA.proposalId, conflictB.proposalId, safe.proposalId], 'partial-retry', `batch-partial-${suffix}`)
    assert.equal(partial.batch.status, 'partial')
    assert.deepEqual(partial.batch.patch.annotationIds, [safe.annotationId])
    const partialApplied = await applyBatch(partial.batch.id, `batch-partial-apply-${suffix}`)
    assert.equal(partialApplied.version.sequence, 3)
    assert.equal(partialApplied.batch.items.find((item) => item.annotationId === safe.annotationId).status, 'applied')
    assert.equal(partialApplied.batch.items.find((item) => item.annotationId === conflictA.annotationId).status, 'retryable')
    assert.equal((await client.v2PublicEventOutbox.count({
      where: { workspaceId, type: 'annotation.resolved', resourceId: safe.annotationId },
    })), 1)
    const conflictRows = await client.v2ReviewAnnotation.findMany({ where: { id: { in: [conflictA.annotationId, conflictB.annotationId] } }, select: { status: true } })
    assert.ok(conflictRows.every((row) => row.status === 'open'))

    const rollbackVersionId = partialApplied.version.id
    const rollbackA = await seedAnnotationAndProposal({ versionId: rollbackVersionId, targetId: 'subtitle:cue-1', text: 'Rollback A.', operationText: 'Rollback A' })
    const rollbackB = await seedAnnotationAndProposal({ versionId: rollbackVersionId, targetId: 'subtitle:cue-2', text: 'Rollback B.', operationText: 'Rollback B' })
    const rollbackBatch = await proposeBatch([rollbackA.proposalId, rollbackB.proposalId], 'all-or-nothing', `batch-rollback-${suffix}`)
    const failingRepository = new Proxy(repository, {
      get(target, property) {
        if (property === 'commitOrReplay') {
          return async (bundle) => {
            await client.v2ReviewPatchProposal.update({ where: { id: rollbackB.proposalId }, data: { status: 'ambiguous' } })
            return target.commitOrReplay(bundle)
          }
        }
        const value = target[property]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await assert.rejects(() => applyBatch(rollbackBatch.batch.id, `batch-rollback-apply-${suffix}`, failingRepository), (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT')
    const afterRollback = await client.v2Project.findUnique({ where: { id: projectId }, include: { versions: true } })
    assert.equal(afterRollback.currentVersionId, rollbackVersionId)
    assert.equal(afterRollback.versions.length, 3)
    const rollbackAnnotations = await client.v2ReviewAnnotation.findMany({ where: { id: { in: [rollbackA.annotationId, rollbackB.annotationId] } }, select: { status: true } })
    assert.ok(rollbackAnnotations.every((row) => row.status === 'open'))
    assert.equal((await client.v2PublicEventOutbox.count({
      where: {
        workspaceId,
        type: 'annotation.resolved',
        resourceId: { in: [rollbackA.annotationId, rollbackB.annotationId] },
      },
    })), 0)
    const persistedRollbackBatch = await client.v2ReviewPatchBatch.findUnique({ where: { id: rollbackBatch.batch.id } })
    assert.equal(persistedRollbackBatch.status, 'ready')

    const publicA = await seedAnnotationAndProposal({ versionId: rollbackVersionId, targetId: 'subtitle:cue-1', text: 'API A.', operationText: 'Texto público A' })
    const publicB = await seedAnnotationAndProposal({ versionId: rollbackVersionId, targetId: 'subtitle:cue-2', text: 'API B.', operationText: 'Texto público B' })
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    let serverLogs = ''
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', APOLLO_API_ENVIRONMENT: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`
    const headers = (key) => ({ authorization, 'content-type': 'application/json', 'idempotency-key': key })
    const createResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/patch-batches`, {
      method: 'POST',
      headers: headers(`public-batch-${suffix}`),
      body: JSON.stringify({ proposalIds: [publicA.proposalId, publicB.proposalId] }),
    })
    const created = await createResponse.json()
    assert.equal(createResponse.status, 201, `${JSON.stringify(created)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(created.data.batch.status, 'ready')
    assert.equal(created.data.batch.mode, 'all-or-nothing')
    const readResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/patch-batches/${created.data.batch.id}`, { headers: { authorization } })
    const read = await readResponse.json()
    assert.equal(readResponse.status, 200, JSON.stringify(read))
    assert.equal(read.data.batch.items.length, 2)
    const applyResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/patch-batches/${created.data.batch.id}/apply`, {
      method: 'POST',
      headers: headers(`public-batch-apply-${suffix}`),
      body: JSON.stringify({ confirmed: true }),
    })
    const publicApplied = await applyResponse.json()
    assert.equal(applyResponse.status, 201, `${JSON.stringify(publicApplied)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(publicApplied.data.version.sequence, 4)
    assert.equal(publicApplied.data.operation.status, 'queued')
    assert.equal(publicApplied.data.batch.items.filter((item) => item.status === 'applied').length, 2)
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    await cleanup()
    await client.$disconnect()
  }
})
