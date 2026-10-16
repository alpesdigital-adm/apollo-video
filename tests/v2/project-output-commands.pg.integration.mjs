import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createProjectService, createProjectOutputVariantService } from '../../src/v2/application/create-project.ts'
import { PrismaCreationOutputBundleRepositoryV2, PrismaOperationalOutputBundleRepositoryV3 } from '../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { readPersistedOutputConsumptionV3 } from '../../src/v2/infrastructure/prisma/output-state-consumption.ts'

// Real PG/application owners, no HTTP server, media, normalization, critic or
// render claim. The supervisor owns migrations, run exclusivity and postflight.
const enabled = process.env.APOLLO_RUN_W66_PUBLIC_OUTPUT_COMMANDS_PG === '1'
test('W66 public application creation and variant Commands commit once across concurrent HTTP intents',
  { skip: !enabled, timeout: 60000 }, async () => {
    const url = new URL(process.env.DATABASE_URL ?? '')
    assert.match(url.searchParams.get('application_name') ?? '', /^apollo-video-e2e-/)
    const supervisorObserver = process.env.APOLLO_LIBRARY_OBSERVER_APPLICATION_NAME ?? null
    if (supervisorObserver !== null) {
      assert.match(supervisorObserver, /^apollo-video-e2e-observer-[a-f0-9]{8}$/)
      assert.notEqual(supervisorObserver, url.searchParams.get('application_name'))
    }
    for (const [parameter, maximum] of [['connection_limit', 5], ['pool_timeout', 10], ['connect_timeout', 10]])
      assert.ok(Number(url.searchParams.get(parameter)) > 0 && Number(url.searchParams.get(parameter)) <= maximum)
    assert.ok(Number(url.searchParams.get('connection_limit')) >= 2, 'Concurrency proof needs two bounded connections')
    const run = randomUUID().replaceAll('-', ''), workspaceId = 'w66http-' + run, clientId = workspaceId + '-client'
    const auditContext = createExternalAuditContext({ workspaceId, clientId, credentialId: workspaceId + '-credential', environment: 'sandbox' })
    const actor = { ...auditContext, auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
    const allocations = { clock: () => new Date(), createId: kind => `${kind}-${randomUUID()}`, createEventId: randomUUID }
    const db = new PrismaClient()
    try {
      const unknown = await db.$queryRawUnsafe('SELECT application_name FROM pg_stat_activity WHERE datname=current_database() AND backend_type=$1 AND application_name LIKE $2 AND application_name<>$3 AND ($4::text IS NULL OR application_name<>$4)',
        'client backend', 'apollo-video-e2e-%', url.searchParams.get('application_name'), supervisorObserver)
      assert.equal(unknown.length, 0, 'Another E2E owner blocks this prepared proof')
      await db.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Controlled public output Commands', createdAt: new Date(), updatedAt: new Date() } })
      await db.v2ApiClient.create({ data: { id: clientId, workspaceId, name: 'Controlled public Command actor',
        allowedEnvironmentsJson: '["sandbox"]', scopeGrantsJson: '["projects:write"]', createdBy: clientId, createdAt: new Date(), updatedAt: new Date() } })
      const creationRepository = new PrismaCreationOutputBundleRepositoryV2(db), operationalRepository = new PrismaOperationalOutputBundleRepositoryV3(db)
      const create = createProjectService({ ...allocations, repository: creationRepository }), variant = createProjectOutputVariantService({ ...allocations, repository: operationalRepository })
      const rootRequest = { workspaceId, actor, name: 'Empty public output root', objective: 'discovery', locale: 'pt-BR', idempotencyKey: 'root-public-output' }
      const root = await create(rootRequest), projectId = root.projectAtCreation.id
      assert.equal(root.projectAtCreation.currentVersionId, undefined); assert.equal(root.projectAtCreation.format, undefined)
      assert.equal((await db.v2Project.findUnique({ where: { id: projectId } })).format, null)
      const rootBytes = serializeOutputCanonicalJson(root.bundle)
      const intent = structuredClone(publicSchemaExamples(getPublicSchema('apollo://schemas/create-project-output-variant-request/v1'))[0])
      const request = { ...intent, workspaceId, projectId, actor, baseVersionId: root.creationVersion.id,
        baseHash: root.creationVersion.baseHash, idempotencyKey: 'same-http-variant' }
      const [first, retry] = await Promise.all([variant(request), variant(request)])
      assert.equal(first.bundle.version.id, retry.bundle.version.id)
      assert.notEqual(first.replayed, retry.replayed)
      assert.equal(await db.v2OutputVariant.count({ where: { workspaceId, projectId } }), 1)
      assert.equal(await db.v2ProjectVersion.count({ where: { workspaceId, projectId } }), 2)
      const firstId = first.bundle.origin.result.command.payload.variantId
      for (const purpose of ['render', 'critic', 'final']) {
        const read = await readPersistedOutputConsumptionV3(db, { workspaceId, projectId, versionId: first.bundle.version.id, variantId: firstId, purpose })
        assert.equal(read.status, 'blocked'); assert.deepEqual(read.reasons, ['empty-project'])
      }
      const sibling = { ...request, baseVersionId: first.bundle.version.id, baseHash: first.bundle.version.baseHash, idempotencyKey: 'different-http-intents' }
      const race = await Promise.allSettled([variant({ ...sibling, reason: 'Intent A' }), variant({ ...sibling, reason: 'Intent B' })])
      assert.equal(race.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(race.find(r => r.status === 'rejected').reason.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
      const winner = race.find(r => r.status === 'fulfilled').value.bundle
      assert.equal(winner.state.document.entries.length, 2)
      assert.equal(new Set(winner.state.document.entries.map(e => e.variantId)).size, 2)
      assert.ok(winner.state.document.entries.every(e => e.spec.output.aspectRatio === intent.output.aspectRatio))
      assert.equal(await db.v2ProjectVersion.count({ where: { workspaceId, projectId } }), 3)
      const before = { versions: await db.v2ProjectVersion.count({ where: { workspaceId, projectId } }),
        commands: await db.v2EditCommand.count({ where: { workspaceId, projectId } }),
        events: await db.v2PublicEventOutbox.count({ where: { workspaceId } }), head: winner.version.id }
      const replay = await create(rootRequest)
      assert.equal(replay.replayed, true); assert.equal(replay.creationVersion.id, root.creationVersion.id)
      assert.equal(replay.projectAtCreation.currentVersionId, undefined)
      assert.equal(serializeOutputCanonicalJson(replay.bundle), rootBytes)
      assert.deepEqual({ versions: await db.v2ProjectVersion.count({ where: { workspaceId, projectId } }),
        commands: await db.v2EditCommand.count({ where: { workspaceId, projectId } }), events: await db.v2PublicEventOutbox.count({ where: { workspaceId } }),
        head: (await db.v2Project.findUnique({ where: { id: projectId } })).currentVersionId }, before)
      await assert.rejects(() => variant({ ...request, actor: { ...actor, scopes: new Set(['projects:read']) } }), e => e.code === 'AUTH_SCOPE_REQUIRED')
      const otherAudit = createExternalAuditContext({ workspaceId, clientId, credentialId: workspaceId + '-foreign', environment: 'sandbox' })
      await assert.rejects(() => variant({ ...request, actor: { ...actor, ...otherAudit, auditContext: otherAudit } }), e => e.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
      await assert.rejects(() => variant({ ...request, idempotencyKey: 'stale-new-key' }), e => e.code === 'VERSION_CONFLICT')
      assert.equal(await db.v2OutputVariant.count({ where: { workspaceId, projectId } }), 2)
      assert.equal(await creationRepository.read({ workspaceId: workspaceId + '-foreign', projectId, versionId: root.creationVersion.id }), null)
    } finally { await db.$disconnect() }
  })
