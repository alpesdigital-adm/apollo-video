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
    scopes: new Set(['projects:read', 'projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

async function seedWorkspace(prisma, { workspaceId, clientId, credentialId, now }) {
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
      scopeGrantsJson: '["projects:read","projects:write"]',
      createdBy: 'synthetic-phase-gate-pg-e2e',
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.v2ApiCredential.create({ data: {
    id: credentialId,
    workspaceId,
    clientId,
    secretSalt: 'a'.repeat(22),
    secretHash: 'b'.repeat(64),
    createdAt: now,
  } })
}

test('T-F3-GATE persists a truthful internal rejection in PostgreSQL and enforces its fences', {
  skip: SKIP,
  timeout: 120_000,
}, async () => {
  const applicationName = assertSafeDatabaseUrl()
  const { createExternalAuditContext } = await import(
    '../../src/v2/application/authenticate-api-client.ts'
  )
  const { listSyntheticPhaseGatesService, runSyntheticPhaseGateService } = await import(
    '../../src/v2/application/run-synthetic-phase-gate.ts'
  )
  const { PrismaSyntheticPhaseGateRepository } = await import(
    '../../src/v2/infrastructure/prisma/synthetic-phase-gate-repository.ts'
  )
  const { seedSealedProject } = await import('./helpers/pg-output-world.mjs')

  const prisma = new PrismaClient()
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const workspaceId = `synthetic-gate-e2e-${suffix}`
  const otherWorkspaceId = `synthetic-gate-other-e2e-${suffix}`
  const clientId = `synthetic-gate-client-${suffix}`
  const otherClientId = `synthetic-gate-other-client-${suffix}`
  const credentialId = `synthetic-gate-credential-${suffix}`
  const otherCredentialId = `synthetic-gate-other-credential-${suffix}`
  const projectId = `synthetic-gate-project-${suffix}`
  const now = new Date('2026-09-09T12:00:00.000Z')

  try {
    const session = await prisma.$queryRawUnsafe(
      "SELECT current_setting('application_name') AS name",
    )
    assert.equal(session[0]?.name, applicationName)

    await seedWorkspace(prisma, { workspaceId, clientId, credentialId, now })
    await seedWorkspace(prisma, {
      workspaceId: otherWorkspaceId,
      clientId: otherClientId,
      credentialId: otherCredentialId,
      now,
    })

    const actor = actorFor(createExternalAuditContext, {
      workspaceId,
      clientId,
      credentialId,
    })
    // The project is born the way the product makes one: creation Version, then one explicit output variant whose
    // Version is the head the gate is run against. Every identity is unique to this invocation (sealed rows are append-only).
    const sealed = await seedSealedProject(prisma, {
      workspaceId,
      actor,
      prefix: 'synthetic-gate',
      ids: { project: projectId },
      name: 'Synthetic phase gate PostgreSQL proof',
    })
    const versionId = sealed.head.version.id
    const versionHash = sealed.head.version.baseHash
    const otherActor = actorFor(createExternalAuditContext, {
      workspaceId: otherWorkspaceId,
      clientId: otherClientId,
      credentialId: otherCredentialId,
    })
    const repository = new PrismaSyntheticPhaseGateRepository(prisma)
    const run = runSyntheticPhaseGateService({
      repository,
      clock: () => now,
      createId: () => `synthetic-phase-gate-${suffix}`,
    })
    const list = listSyntheticPhaseGatesService({ repository })
    const request = {
      workspaceId,
      projectId,
      projectVersionId: versionId,
      projectVersionHash: versionHash,
      actor,
      idempotencyKey: `synthetic-phase-gate-${suffix}`,
    }

    const attempts = await Promise.all([run(request), run(request)])
    assert.deepEqual(
      attempts.map((result) => result.replayed).sort(),
      [false, true],
    )
    const created = attempts.find((result) => !result.replayed)
    assert.ok(created)
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

    const listed = await list({ workspaceId, projectId, actor, limit: 10 })
    assert.deepEqual(listed.map((gate) => gate.id), [created.gate.id])
    await assert.rejects(
      list({
        workspaceId,
        projectId,
        actor: { ...actor, scopes: new Set(['projects:write']) },
      }),
      (error) => error.code === 'AUTH_SCOPE_REQUIRED',
    )
    await assert.rejects(
      list({ workspaceId: otherWorkspaceId, projectId, actor }),
      (error) => error.code === 'AUTH_INVALID',
    )
    assert.deepEqual(await list({
      workspaceId: otherWorkspaceId,
      projectId,
      actor: otherActor,
      limit: 10,
    }), [])

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
  } finally {
    // No fixture removal: the project, its Versions and its sealed State are append-only, and every identity of this
    // invocation carries its own suffix.
    await prisma.$disconnect()
  }
})
