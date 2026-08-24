import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

test('T-FR-235 persists preflight and partial matrix state in PostgreSQL and rejects tampering', {
  skip: process.env.APOLLO_EXPORT_MATRIX_DB !== '1' && 'set APOLLO_EXPORT_MATRIX_DB=1 with an isolated V2 PostgreSQL database',
  timeout: 60_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL is required')
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(databaseName, /(?:^|_)e2e(?:_|$)/, 'destructive export matrix test requires an isolated E2E database')
  const { createApiAccessAuditContext } = await import('../../src/v2/domain/api-access-control.ts')
  const { createExportMatrixDefinition, createExportMatrixPreflight } = await import('../../src/v2/domain/export-matrix.ts')
  const { PrismaExportMatrixRepository } = await import('../../src/v2/infrastructure/prisma/export-matrix-repository.ts')
  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `workspace-export-matrix-${suffix}`
  const clientId = `client-export-matrix-${suffix}`
  const createdAt = '2026-08-24T18:00:00.000Z'
  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.create({ data: { id: workspaceId, slug: `export-matrix-${suffix}`, name: 'Export matrix E2E', createdAt: new Date(createdAt), updatedAt: new Date(createdAt) } })
    await client.v2ApiClient.create({ data: {
      id: clientId, workspaceId, name: 'Export matrix E2E', allowedEnvironmentsJson: '["production"]', scopeGrantsJson: '["projects:read","projects:write"]', createdBy: clientId,
      createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
    } })
    const audit = createApiAccessAuditContext({ clientId, credentialId: `credential-${suffix}`, workspaceId, environment: 'production', authenticationKind: 'bearer' })
    const definition = createExportMatrixDefinition({ workspaceId, cells: [{
      recipeId: 'recipe-export-matrix-db', projectId: 'project-export-matrix-db', projectVersionId: 'version-export-matrix-db', projectVersionHash: '1'.repeat(64), format: '9:16', locale: 'pt-BR',
    }] })
    const preflight = createExportMatrixPreflight({
      definition,
      evidence: [{ cellId: definition.cells[0].id, ready: true, rightsAllowed: true, durationFrames: 300, fps: 30, width: 1080, height: 1920, sourceFingerprint: '2'.repeat(64) }],
      requestedMaximumCostMinorUnits: 1000, requestedMaximumStorageBytes: 1_000_000_000,
      operatorMaximumCostMinorUnits: 1000, operatorAvailableStorageBytes: 1_000_000_000,
      createdAt, expiresAt: '2026-08-24T18:10:00.000Z',
    })
    const repository = new PrismaExportMatrixRepository(client)
    const stored = await repository.createPreflight({
      id: `preflight-export-matrix-${suffix}`, preflight, authenticationAudit: audit,
      requestFingerprint: '3'.repeat(64), idempotencyKey: `export-matrix-${suffix}`,
    })
    const replay = await repository.createPreflight({
      id: `different-preflight-${suffix}`, preflight, authenticationAudit: audit,
      requestFingerprint: '3'.repeat(64), idempotencyKey: `export-matrix-${suffix}`,
    })
    assert.equal(replay.id, stored.id)

    const matrix = await repository.createMatrix({
      id: `matrix-export-matrix-${suffix}`, preflight: stored, authenticationAudit: audit, createdAt: '2026-08-24T18:01:00.000Z',
    })
    assert.equal(matrix.status, 'queued')
    assert.equal(matrix.cells[0].status, 'awaiting-dispatch')
    await repository.recordCellDispatchFailure({
      workspaceId, matrixId: matrix.id, cellId: matrix.cells[0].id,
      error: { code: 'QUEUE_UNAVAILABLE', message: 'Export matrix cell could not be dispatched', retryable: true },
    })
    const partial = await repository.readMatrix({ workspaceId, matrixId: matrix.id })
    assert.equal(partial.status, 'failed')
    assert.equal(partial.cells[0].error.retryable, true)

    await client.v2ExportMatrixPreflight.update({ where: { id: stored.id }, data: { preflightJson: preflight.preflightHash } })
    await assert.rejects(() => repository.readPreflight({ workspaceId, preflightId: stored.id }), (error) => error?.code === 'PERSISTENCE_CONFLICT')
  } finally {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE').catch(() => undefined)
    await client.$disconnect()
  }
})
