import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { enqueuePerceptionProducerRunService } from '../../src/v2/application/enqueue-perception-producer-run.ts'
import { enqueueTemporalProducerRunService } from '../../src/v2/application/enqueue-temporal-producer-run.ts'
import { enqueueFaceProducerRunService } from '../../src/v2/application/enqueue-face-producer-run.ts'
import { runNextMediaIngestOperationService } from '../../src/v2/application/run-media-ingest-worker.ts'
import { assetRightsRevision } from '../../src/v2/domain/asset-rights.ts'
import { setAssetRightsService } from '../../src/v2/application/set-asset-rights.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaPerceptionProducerRequestContextRepository, PrismaTemporalProducerRequestContextRepository,
  PrismaFaceProducerRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaPerceptionProducerEnvelopeRepository } from '../../src/v2/infrastructure/prisma/perception-producer-envelope-repository.ts'
import { PrismaTemporalProducerEnvelopeRepository } from '../../src/v2/infrastructure/prisma/temporal-producer-envelope-repository.ts'
import { PrismaFaceProducerEnvelopeRepository } from '../../src/v2/infrastructure/prisma/face-producer-envelope-repository.ts'
import { PrismaAssetRightsRepository } from '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
import { PrismaProjectMediaRepository } from '../../src/v2/infrastructure/prisma/project-media-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'
import { assertDatabaseClockBefore, runProducerPublishLockRace, waitForDatabaseClock } from './helpers/producer-publish-lock-race.mjs'

test('W61 PostgreSQL admission converges concurrent keys and fences source, rights and workspace',
  { skip: !process.env.V2_DATABASE_URL }, async () => {
    const db = new PrismaClient()
    let cleanupScope
    try {
      const { suffix, workspaceId, otherWorkspaceId, clientId, projectId, versionId, sourceId } = await seedPerceptionProducerContext(db)
      cleanupScope = { suffix, workspaceId, clientId }
      const auditContext = createExternalAuditContext({ clientId, credentialId: `w61-credential-${suffix}`,
        workspaceId, environment: 'production' })
      const actor = { ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
        clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
        clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
      const operations = new PrismaPublicOperationRepository(db)
      const enqueue = enqueuePerceptionProducerRunService({
        context: new PrismaPerceptionProducerRequestContextRepository(db), operations,
        createOperationId: () => `w61-operation-${randomUUID()}`,
      })
      const input = { workspaceId, projectId, projectVersionId: versionId, sourceArtifactId: sourceId,
        sampleIntervalFrames: 30, actor, idempotencyKey: `w61-key-${suffix}` }
      const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => enqueue(input)))
      assert.equal(outcomes.every((result) => result.status === 'fulfilled'), true,
        JSON.stringify(outcomes.filter((result) => result.status === 'rejected').map((result) => String(result.reason))))
      const ids = outcomes.map((result) => result.value.operation.id)
      assert.equal(new Set(ids).size, 1)
      assert.equal(outcomes.filter((result) => !result.value.replayed).length, 1)
      const operationId = ids[0]
      assert.equal((await operations.findById(workspaceId, operationId)).operation.type, 'perception-producer-run')
      assert.equal(await operations.findById(otherWorkspaceId, operationId), null)
      assert.equal(await db.v2PerceptionProducerOperation.count({ where: { operationId } }), 1)
      assert.equal(await db.v2PublicEventOutbox.count({ where: { workspaceId, resourceId: operationId } }), 1)
      const crossAudit = createApiAccessAuditContext({ clientId, credentialId: `w61-credential-${suffix}`,
        workspaceId: otherWorkspaceId, environment: 'production', authenticationKind: 'bearer' })
      assert.equal(await operations.cancel({ workspaceId: otherWorkspaceId, operationId,
        commandId: `w61-cross-cancel-${suffix}`, authenticationAudit: crossAudit, canceledAt: new Date().toISOString() }), null)
      const retryRequestedAt = new Date()
      assert.equal(await operations.retry({ workspaceId: otherWorkspaceId, operationId,
        commandId: `w61-cross-retry-${suffix}`, authenticationAudit: crossAudit,
        requestedAt: retryRequestedAt.toISOString(),
        nextAttemptAt: new Date(retryRequestedAt.getTime() + 1000).toISOString() }), null)
      for (const [field, value] of [['type', 'unknown-operation'], ['targetType', 'media-artifact'], ['progressCompleted', 2], ['progressTotal', null]]) {
        await assert.rejects(db.$executeRawUnsafe(`UPDATE "public_operations" SET "${field}" = $1 WHERE "id" = $2`, value, operationId),
          (error) => /check constraint|23514/.test(String(error)), `${field} must remain constrained`)
      }
      await assert.rejects(db.$executeRaw`UPDATE "public_operations" SET "status" = 'running', "phase" = 'directing', "progressCompleted" = 0,
        "startedAt" = NOW(), "leaseOwner" = 'invalid-phase-worker', "leaseExpiresAt" = NOW() + INTERVAL '30 seconds', "heartbeatAt" = NOW()
        WHERE "id" = ${operationId}`,
      (error) => /check constraint|23514/.test(String(error)), 'globally known phase must be rejected for perception subtype')
      assert.equal((await operations.findById(workspaceId, operationId)).operation.status, 'queued')
      await assert.rejects(enqueue({ ...input, sampleIntervalFrames: 31 }),
        (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
      await assert.rejects(enqueue({ ...input, workspaceId: otherWorkspaceId }),
        (error) => error instanceof DomainError && error.code === 'AUTH_INVALID')
      await db.v2MediaArtifact.update({ where: { id: sourceId }, data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
      await assert.rejects(enqueue({ ...input, idempotencyKey: `w61-revoked-${suffix}` }),
        (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED')
      assert.equal((await enqueue(input)).operation.id, operationId, 'exact replay survives later rights revocation')
      const ownAudit = createApiAccessAuditContext({ clientId, credentialId: `w61-credential-${suffix}`,
        workspaceId, environment: 'production', authenticationKind: 'bearer' })
      const canceled = await operations.cancel({ workspaceId, operationId,
        commandId: `w61-owned-cancel-${suffix}`, authenticationAudit: ownAudit, canceledAt: new Date().toISOString() })
      assert.equal(canceled.operation.status, 'canceled')
    } finally {
      try {
        if (cleanupScope) {
          const { suffix, workspaceId, clientId } = cleanupScope
          const audit = createApiAccessAuditContext({ clientId,
            credentialId: `w61-credential-${suffix}`, workspaceId,
            environment: 'production', authenticationKind: 'bearer' })
          const pending = await db.v2PublicOperation.findMany({
            where: { workspaceId, idempotencyKey: `w61-key-${suffix}` },
            select: { id: true, status: true },
          })
          const operations = new PrismaPublicOperationRepository(db)
          for (const row of pending) {
            if (['queued', 'running', 'waiting', 'retrying'].includes(row.status)) {
              await operations.cancel({ workspaceId, operationId: row.id,
                commandId: `w61-cleanup-${randomUUID()}`, authenticationAudit: audit,
                canceledAt: new Date().toISOString() })
            }
          }
        }
      } finally { await db.$disconnect() }
    }
  })

test('W61 PostgreSQL analysis admission and claims use the ingest-produced editing grant for all three modalities',
  { skip: !process.env.V2_DATABASE_URL, timeout: 120000 }, async (t) => {
    const db = new PrismaClient()
    const owned = []
    let authenticationAudit
    let world
    let primaryError
    const receipt = { proofScope: 'controlled-ingest-rights-stage', ingestE2E: false,
      controlledPorts: ['ingest claim/upload/storage/probe/artifact admission', 'normalization stop sentinel'],
      realServices: ['media ingest rights stage', 'Prisma rights persistence', 'producer admission and claim'],
      modalities: [], postflight: {} }
    const operations = new PrismaPublicOperationRepository(db)
    try {
      world = await seedPerceptionProducerContext(db, { seedRights: false })
      const { workspaceId, projectId, sourceId, clientId, suffix } = world
      const rightsRepository = new PrismaAssetRightsRepository(db)
      const auditContext = createExternalAuditContext({ clientId, credentialId: `ingest-rights-${suffix}`,
        workspaceId, environment: 'production' })
      const actor = { ...auditContext, auditContext, scopes: new Set(['projects:write']),
        authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
        clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
      authenticationAudit = createApiAccessAuditContext({ clientId, credentialId: auditContext.credentialId,
        workspaceId, environment: 'production', authenticationKind: 'bearer' })
      const ingestId = `controlled-ingest-${suffix}`
      const uploadId = randomUUID()
      const stopCode = 'CONTROLLED_INGEST_RIGHTS_STAGE_COMPLETE'
      let claimed = false, normalizationStopped = false, terminalError, terminalProjectCalls = 0
      const controlledRecord = { operation: { id: ingestId, workspaceId, projectId, clientId,
        type: 'media-ingest', attempt: 1, maxAttempts: 1 }, authenticationAudit,
        context: { kind: 'media-ingest', projectId, uploadId, originalFileName: 'source.mp4',
          sourceArtifactId: sourceId, sourceManifestId: `controlled-master-manifest-${suffix}` },
        lease: { owner: 'controlled-ingest-rights-worker', attempt: 1 } }
      const ingest = runNextMediaIngestOperationService({ rights: rightsRepository,
        operations: {
          async claimNext() { if (claimed) return null; claimed = true; return controlledRecord },
          async heartbeat() { return true }, async advancePhase() { return controlledRecord },
          async failOrRetry(command) {
            assert.equal(normalizationStopped, true, 'only the identified normalization sentinel may stop this stage')
            assert.equal(command.error.code, stopCode.toLowerCase())
            assert.equal(command.error.message, 'Controlled ingest rights stage complete')
            assert.equal(command.error.retryable, false)
            terminalError = command.error
            return { ...controlledRecord, operation: { ...controlledRecord.operation, status: 'failed' } }
          },
        },
        uploads: { async findUpload() { return { id: uploadId, workspaceId, clientId, projectId,
          kind: 'video', status: 'verified', rightsConfirmed: true, fileName: 'source.mp4',
          mimeType: 'video/mp4', inspectionStatus: 'usable', detectedExtension: 'mp4' } },
        async listUploadParts() { return [] } },
        storage: { async quarantineSource() { return { path: 'controlled-source' } },
          async promoteMaster() { return { path: 'controlled-source', key: world.artifactKey,
            sha256: world.sourceSha256, byteSize: Number(world.byteSize) } } },
        prober: { async probe() { return { width: 320, height: 180, duration: 4, fps: 30 } } },
        artifacts: { async persistOrReplay(request) { return { artifactId: request.artifactId, manifestId: request.manifestId } } },
        inspector: { async inspect() { assert.fail('pre-inspected controlled upload must not invoke inspection') } },
        processor: { async normalize() { normalizationStopped = true;
          throw new DomainError('INVALID_MEDIA_ARTIFACT', 'Controlled ingest rights stage complete', { code: stopCode }) } },
        providers: { async resolveTranscription() { assert.fail('this proof stops before transcription') } },
        // The worker refuses a project that has no explicit output variant before any effect: it reads the real project.
        projectMedia: { readProject: (input) => new PrismaProjectMediaRepository(db).readProject(input), async markIngestFailed() { terminalProjectCalls += 1 } },
      })
      assert.deepEqual(await ingest('controlled-ingest-rights-worker'), { operationId: ingestId, status: 'failed' })
      assert.equal(terminalError?.code, stopCode.toLowerCase())
      assert.equal(terminalProjectCalls, 1)
      const ingestRights = (await rightsRepository.findCurrent(workspaceId, sourceId)).snapshot
      assert.deepEqual(ingestRights.allowedUses, ['distribution', 'editing', 'rendering', 'transcription'])
      assert.deepEqual(JSON.parse(JSON.stringify(ingestRights.consent)), { status: 'not-required', allowedUses: [] })
      assert.equal(ingestRights.allowedUses.includes('editorial-reuse'), false)
      assert.equal(ingestRights.sourceNote, `Rights confirmed during upload ${uploadId}`)
      receipt.rights = { snapshotId: ingestRights.id, snapshotHash: ingestRights.snapshotHash,
        uses: ingestRights.allowedUses, consent: ingestRights.consent, sourceNote: ingestRights.sourceNote,
        terminalSentinel: terminalError.code }
      // The ingest stage wrote the grant; only now can a Version play the recording (its child Command adopts the receipt).
      await world.sealHead()
      const modalities = [
        ['ocr', PrismaPerceptionProducerRequestContextRepository, PrismaPerceptionProducerEnvelopeRepository, enqueuePerceptionProducerRunService],
        ['temporal', PrismaTemporalProducerRequestContextRepository, PrismaTemporalProducerEnvelopeRepository, enqueueTemporalProducerRunService],
        ['face', PrismaFaceProducerRequestContextRepository, PrismaFaceProducerEnvelopeRepository, enqueueFaceProducerRunService],
      ]
      const base = { workspaceId, projectId, projectVersionId: world.versionId, sourceArtifactId: sourceId, actor }
      const setRights = async (change = {}) => {
        const artifact = await db.v2MediaArtifact.findUniqueOrThrow({ where: { id: sourceId } })
        return setAssetRightsService({ repository: rightsRepository, clock: () => new Date(),
          createId: () => `analysis-rights-${randomUUID()}` })({ workspaceId, artifactId: sourceId,
          baseRevision: assetRightsRevision(sourceId, artifact.rightsRevision),
          draft: { status: 'approved', allowedUses: ingestRights.allowedUses, prohibitedUses: [],
            consent: ingestRights.consent, ...change }, actor: { type: 'api-client', id: clientId } })
      }
      const cancelOwned = async (id) => operations.cancel({ workspaceId, operationId: id,
        commandId: `analysis-cleanup-${randomUUID()}`, authenticationAudit, canceledAt: new Date().toISOString() })
      for (const [name, Context, Envelope, enqueueService] of modalities) {
        const context = new Context(db)
        assert.ok(await context.read(base), `${name}: ingest-produced editing is admitted`)
        assert.equal(await context.read({ ...base, workspaceId: world.otherWorkspaceId }), null)
        const enqueue = enqueueService({ context, operations, createOperationId: () => `analysis-${randomUUID()}` })
        await assert.rejects(enqueue({ ...base, workspaceId: world.otherWorkspaceId,
          idempotencyKey: `analysis-other-workspace-${name}-${suffix}` }), { code: 'AUTH_INVALID' })
        const queued = await enqueue({ ...base, idempotencyKey: `ingest-editing-${name}-${suffix}` })
        owned.push(queued.operation.id)
        const claimedSource = await new Envelope(db).claimNext({ leaseOwner: `analysis-${name}-${suffix}`,
          now: new Date(), leaseMs: 30000 })
        assert.equal(claimedSource?.operationId, queued.operation.id)
        assert.equal(claimedSource.sourceArtifactId, sourceId)
        assert.equal(claimedSource.sourceSha256, world.sourceSha256)
        assert.equal((await cancelOwned(queued.operation.id)).operation.status, 'canceled')
        const denials = [
          ['editing-missing', { allowedUses: ['editorial-reuse'] }],
          ['revoked', { status: 'revoked' }],
          ['unknown', { status: 'unknown' }],
          ['expired', { expiresAt: new Date(Date.now() - 1000).toISOString() }],
          ['editing-prohibited', { allowedUses: ['rendering'], prohibitedUses: ['editing'] }],
          ['locale', { allowedLocales: ['en-US'] }],
          ['consent', { consent: { status: 'approved', allowedUses: ['rendering'] } }],
        ]
        for (const [denial, change] of denials) {
          const resolvedBeforeRevocation = await context.read(base)
          assert.ok(resolvedBeforeRevocation)
          await setRights(change)
          assert.equal(await context.read(base), null, `${name}: ${denial} read denied`)
          await assert.rejects(enqueue({ ...base, idempotencyKey: `analysis-denied-${name}-${denial}-${suffix}` }),
            { code: 'PRECONDITION_REQUIRED' })
          const deniedId = `analysis-stale-${randomUUID()}`
          const enqueueStale = enqueueService({ context: { async read() { return resolvedBeforeRevocation } },
            operations, createOperationId: () => deniedId })
          await assert.rejects(enqueueStale({ ...base, idempotencyKey: `analysis-stale-${name}-${denial}-${suffix}` }),
            { code: 'PERSISTENCE_CONFLICT' }, 'transaction revalidates rights despite an earlier accepted read')
          assert.equal(await db.v2PublicOperation.count({ where: { id: deniedId } }), 0)
          assert.equal(await db.v2PublicEventOutbox.count({ where: { workspaceId, resourceId: deniedId } }), 0)
          await setRights()
          const pending = await enqueue({ ...base, idempotencyKey: `analysis-claim-${name}-${denial}-${suffix}` })
          owned.push(pending.operation.id)
          await setRights(change)
          assert.equal(await new Envelope(db).claimNext({ leaseOwner: `analysis-denied-${name}-${suffix}`,
            now: new Date(), leaseMs: 30000 }), null, `${name}: ${denial} blocks source materialization`)
          const failed = await operations.findById(workspaceId, pending.operation.id)
          assert.equal(failed.operation.status, 'failed')
          assert.equal(failed.operation.error.code, 'invalid_producer_context')
          await setRights()
        }
        const requestedAt = new Date()
        const expiresAt = new Date(requestedAt.getTime() + 3000)
        await setRights({ expiresAt: expiresAt.toISOString() })
        const beforeLock = await context.read(base)
        assert.ok(beforeLock)
        const delayedId = `analysis-delayed-${randomUUID()}`
        await runProducerPublishLockRace({ db, label: `analysis-${name}-${suffix}`,
          lockedTable: 'media_artifacts', lockedId: sourceId, expectedCodes: ['PERSISTENCE_CONFLICT'],
          publish: (contender) => enqueueService({ context: { async read() { return beforeLock } },
            operations: new PrismaPublicOperationRepository(contender), clock: () => requestedAt,
            createOperationId: () => delayedId })({ ...base, idempotencyKey: `analysis-after-lock-${name}-${suffix}` }),
          afterWait: async () => ({ beforeExpiry: await assertDatabaseClockBefore(db, expiresAt),
            afterExpiry: await waitForDatabaseClock(db, expiresAt) }),
        })
        assert.equal(await db.v2PublicOperation.count({ where: { id: delayedId } }), 0)
        assert.equal(await db.v2PublicEventOutbox.count({ where: { workspaceId, resourceId: delayedId } }), 0)
        await setRights()
        receipt.modalities.push({ name, admission: 'editing-from-ingest', claim: 'accepted',
          denials: denials.map(([name]) => name), crossWorkspaceRead: 'denied',
          staleAdmissionRead: 'revalidated-in-transaction', lockWaitExpiry: 'denied-with-zero-rows' })
      }
    } catch (error) {
      primaryError = error
      receipt.failure = { name: error.name, message: error.message }
      throw error
    } finally {
      const cleanupErrors = []
      try {
        if (world && authenticationAudit) {
          for (const id of owned) {
            try {
              const stored = await operations.findById(world.workspaceId, id)
              if (stored && ['queued', 'running', 'waiting', 'retrying'].includes(stored.operation.status)) {
                await operations.cancel({ workspaceId: world.workspaceId, operationId: id,
                  commandId: `analysis-finally-${randomUUID()}`, authenticationAudit,
                  canceledAt: new Date().toISOString() })
              }
            } catch (error) { cleanupErrors.push(error) }
          }
          receipt.postflight.activeOwnedOperations = await db.v2PublicOperation.count({ where: {
            id: { in: owned }, workspaceId: world.workspaceId, status: { in: ['queued', 'running', 'waiting', 'retrying'] } } })
          assert.equal(receipt.postflight.activeOwnedOperations, 0)
        }
      } catch (error) { cleanupErrors.push(error) }
      finally {
        try { await db.$disconnect() } catch (error) { cleanupErrors.push(error) }
        receipt.postflight.errors = cleanupErrors.map((error) => error.message)
        t.diagnostic(JSON.stringify(receipt))
      }
      if (cleanupErrors.length) throw new AggregateError(
        [...(primaryError ? [primaryError] : []), ...cleanupErrors], 'Analysis rights proof cleanup failed')
    }
  })
