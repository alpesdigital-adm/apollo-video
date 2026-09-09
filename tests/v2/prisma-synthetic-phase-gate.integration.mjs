import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const RUN = process.env.APOLLO_SYNTHETIC_PHASE_GATE_PG_E2E === '1'
const SKIP = RUN
  ? false
  : 'set APOLLO_SYNTHETIC_PHASE_GATE_PG_E2E=1 with a migrated local E2E PostgreSQL'

function assertSafeDatabaseUrl() {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must name a disposable local PostgreSQL')
  const url = new URL(process.env.V2_DATABASE_URL)
  assert.ok(
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname),
    'the synthetic phase gate proof is restricted to local PostgreSQL',
  )
  assert.match(
    url.pathname.slice(1),
    /(?:^|_)e2e(?:_|$)/,
    'the database name must explicitly identify an E2E database',
  )
  const applicationName = url.searchParams.get('application_name') ?? ''
  assert.match(
    applicationName,
    /^apollo-video-e2e-synthetic-phase-gate-[a-z0-9-]+$/,
    'application_name must identify one supervised synthetic phase gate run',
  )
  for (const [parameter, maximum] of [
    ['connection_limit', 5],
    ['pool_timeout', 10],
    ['connect_timeout', 10],
  ]) {
    const value = Number(url.searchParams.get(parameter))
    assert.ok(
      Number.isInteger(value) && value >= 1 && value <= maximum,
      `${parameter} must be an integer between 1 and ${maximum}`,
    )
  }
  return applicationName
}

function actorFor(createExternalAuditContext, { workspaceId, clientId, credentialId }) {
  const auditContext = createExternalAuditContext({
    workspaceId,
    clientId,
    credentialId,
    environment: 'production',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

async function seedWorkspace(prisma, { workspaceId, clientId, now }) {
  await prisma.v2Workspace.create({
    data: {
      id: workspaceId,
      slug: workspaceId,
      name: `Synthetic phase gate ${workspaceId}`,
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.v2ApiClient.create({
    data: {
      id: clientId,
      workspaceId,
      name: `Synthetic phase gate ${clientId}`,
      allowedEnvironmentsJson: '["production"]',
      scopeGrantsJson: '["projects:write"]',
      createdBy: 'synthetic-phase-gate-pg-e2e',
      createdAt: now,
      updatedAt: now,
    },
  })
}

async function seedProjectVersion(prisma, {
  workspaceId,
  clientId,
  projectId,
  versionId,
  versionHash,
  now,
}) {
  await prisma.v2Project.create({
    data: {
      id: projectId,
      workspaceId,
      name: 'Synthetic phase gate PostgreSQL proof',
      status: 'reviewing-proxy',
      objective: 'awareness',
      format: '16:9',
      locale: 'pt-BR',
      createdByType: 'api-client',
      createdById: clientId,
      createdAt: now,
      updatedAt: now,
    },
  })
  const snapshots = [
    { kind: 'brief', suffix: 'brief', hash: 'a'.repeat(64), schemaVersion: 1 },
    { kind: 'edit-plan', suffix: 'edit-plan', hash: 'b'.repeat(64), schemaVersion: 2 },
    { kind: 'policies', suffix: 'policies', hash: 'c'.repeat(64), schemaVersion: 1 },
  ]
  await prisma.v2ProjectSnapshot.createMany({
    data: snapshots.map((snapshot) => ({
      id: `${projectId}-snapshot-${snapshot.suffix}`,
      workspaceId,
      projectId,
      kind: snapshot.kind,
      schemaVersion: snapshot.schemaVersion,
      contentJson: JSON.stringify({ kind: snapshot.kind }),
      contentHash: snapshot.hash,
      createdAt: now,
    })),
  })
  await prisma.v2ProjectVersion.create({
    data: {
      id: versionId,
      workspaceId,
      projectId,
      sequence: 1,
      briefSnapshotId: `${projectId}-snapshot-brief`,
      editPlanSnapshotId: `${projectId}-snapshot-edit-plan`,
      policiesSnapshotId: `${projectId}-snapshot-policies`,
      baseHash: versionHash,
      createdBy: clientId,
      createdAt: now,
    },
  })
  await prisma.v2Project.update({
    where: { id: projectId },
    data: { currentVersionId: versionId },
  })
}

async function removeFixtures(prisma, workspaceIds) {
  await prisma.$transaction(async (transaction) => {
    await transaction.v2SyntheticPhaseGate.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2Project.updateMany({
      where: { workspaceId: { in: workspaceIds } },
      data: { currentVersionId: null },
    })
    await transaction.v2ProjectVersion.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2ProjectSnapshot.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2Project.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2ApiClient.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2Workspace.deleteMany({
      where: { id: { in: workspaceIds } },
    })
  })
}

test('T-F3-GATE persists a truthful internal rejection in PostgreSQL and enforces its fences', {
  skip: SKIP,
  timeout: 30_000,
}, async () => {
  const applicationName = assertSafeDatabaseUrl()
  const { createExternalAuditContext } = await import(
    '../../src/v2/application/authenticate-api-client.ts'
  )
  const { runSyntheticPhaseGateService } = await import(
    '../../src/v2/application/run-synthetic-phase-gate.ts'
  )
  const { PrismaSyntheticPhaseGateRepository } = await import(
    '../../src/v2/infrastructure/prisma/synthetic-phase-gate-repository.ts'
  )

  const prisma = new PrismaClient()
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const workspaceId = `synthetic-gate-e2e-${suffix}`
  const otherWorkspaceId = `synthetic-gate-other-e2e-${suffix}`
  const clientId = `synthetic-gate-client-${suffix}`
  const otherClientId = `synthetic-gate-other-client-${suffix}`
  const projectId = `synthetic-gate-project-${suffix}`
  const versionId = `synthetic-gate-version-${suffix}`
  const versionHash = 'd'.repeat(64)
  const now = new Date('2026-09-09T12:00:00.000Z')
  const workspaceIds = [workspaceId, otherWorkspaceId]
  let primaryError

  try {
    const session = await prisma.$queryRawUnsafe(
      "SELECT current_setting('application_name') AS name",
    )
    assert.equal(session[0]?.name, applicationName)

    await seedWorkspace(prisma, { workspaceId, clientId, now })
    await seedWorkspace(prisma, {
      workspaceId: otherWorkspaceId,
      clientId: otherClientId,
      now,
    })
    await seedProjectVersion(prisma, {
      workspaceId,
      clientId,
      projectId,
      versionId,
      versionHash,
      now,
    })

    const actor = actorFor(createExternalAuditContext, {
      workspaceId,
      clientId,
      credentialId: `synthetic-gate-credential-${suffix}`,
    })
    const otherActor = actorFor(createExternalAuditContext, {
      workspaceId: otherWorkspaceId,
      clientId: otherClientId,
      credentialId: `synthetic-gate-other-credential-${suffix}`,
    })
    const repository = new PrismaSyntheticPhaseGateRepository(prisma)
    const run = runSyntheticPhaseGateService({
      repository,
      clock: () => now,
      createId: () => `synthetic-phase-gate-${suffix}`,
    })
    const request = {
      workspaceId,
      projectId,
      projectVersionId: versionId,
      projectVersionHash: versionHash,
      actor,
      idempotencyKey: `synthetic-phase-gate-${suffix}`,
    }

    const created = await run(request)
    assert.equal(created.replayed, false)
    assert.equal(created.gate.report.approved, false)
    assert.equal(created.gate.report.covered, 0)
    assert.equal(created.gate.report.passed, 0)
    assert.equal(created.gate.report.total, 4)
    assert.deepEqual(created.gate.report.evidence, [])
    assert.match(created.gate.reportFingerprint, /^[a-f0-9]{64}$/)
    assert.match(created.gate.recordHash, /^[a-f0-9]{64}$/)

    const stored = await prisma.v2SyntheticPhaseGate.findUnique({
      where: { id: created.gate.id },
      include: { evidence: true },
    })
    assert.ok(stored)
    assert.equal(stored.approved, false)
    assert.equal(stored.covered, 0)
    assert.equal(stored.createdById, clientId)
    assert.equal(stored.actorCredentialId, actor.credentialId)
    assert.deepEqual(stored.evidence, [])

    const replay = await run(request)
    assert.equal(replay.replayed, true)
    assert.equal(replay.gate.id, created.gate.id)
    assert.equal(replay.gate.recordHash, created.gate.recordHash)
    assert.equal(await prisma.v2SyntheticPhaseGate.count({ where: { workspaceId } }), 1)

    await assert.rejects(
      run({ ...request, projectVersionHash: 'f'.repeat(64) }),
      (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    await assert.rejects(
      run({
        ...request,
        projectVersionHash: 'f'.repeat(64),
        idempotencyKey: `synthetic-phase-gate-stale-${suffix}`,
      }),
      (error) => error.code === 'VERSION_CONFLICT',
    )
    await assert.rejects(
      run({
        ...request,
        workspaceId: otherWorkspaceId,
        actor: otherActor,
        idempotencyKey: `synthetic-phase-gate-isolation-${suffix}`,
      }),
      (error) => error.code === 'PROJECT_NOT_FOUND',
    )
    assert.deepEqual(await repository.list({
      workspaceId: otherWorkspaceId,
      projectId,
      limit: 10,
    }), [])
    assert.equal(await prisma.v2SyntheticPhaseGate.count({ where: { workspaceId } }), 1)

    await prisma.v2SyntheticPhaseGate.update({
      where: { id: created.gate.id },
      data: { reportFingerprint: 'f'.repeat(64) },
    })
    await assert.rejects(
      repository.list({ workspaceId, projectId, limit: 10 }),
      (error) => error.code === 'PERSISTENCE_CONFLICT',
    )
    await prisma.v2SyntheticPhaseGate.update({
      where: { id: created.gate.id },
      data: { reportFingerprint: stored.reportFingerprint },
    })

    await prisma.v2SyntheticPhaseGate.update({
      where: { id: created.gate.id },
      data: { recordHash: 'e'.repeat(64) },
    })
    await assert.rejects(
      repository.list({ workspaceId, projectId, limit: 10 }),
      (error) => error.code === 'PERSISTENCE_CONFLICT',
    )
    await prisma.v2SyntheticPhaseGate.update({
      where: { id: created.gate.id },
      data: { recordHash: stored.recordHash },
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const teardownErrors = []
    try {
      await removeFixtures(prisma, workspaceIds)
    } catch (error) {
      teardownErrors.push(error)
    }
    try {
      await prisma.$disconnect()
    } catch (error) {
      teardownErrors.push(error)
    }
    if (teardownErrors.length > 0) {
      throw new AggregateError(
        primaryError ? [primaryError, ...teardownErrors] : teardownErrors,
        primaryError
          ? 'synthetic phase gate proof and teardown both failed'
          : 'synthetic phase gate proof teardown failed',
      )
    }
  }
})
