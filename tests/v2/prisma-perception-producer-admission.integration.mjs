import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { enqueuePerceptionProducerRunService } from '../../src/v2/application/enqueue-perception-producer-run.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaPerceptionProducerRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

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
