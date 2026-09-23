import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const workspaceId = 'transformation-registry-int-workspace'
const clientId = 'transformation-registry-int-client'
const credentialId = 'transformation-registry-int-credential'
const at = (second) => new Date(Date.parse('2029-03-01T00:00:00.000Z') + second * 1_000).toISOString()
const hash = (character) => character.repeat(64)

test('T-FR-110/111/112 persists immutable briefs and auditable provider routing on PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 240_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const cleanup = async () => {
    await client.v2TransformationFallbackDispatchRequest.deleteMany({ where: { workspaceId } })
    await client.v2TransformationFallbackDispatchClaim.deleteMany({ where: { workspaceId } })
    await client.v2TransformationFallbackAttempt.deleteMany({ where: { workspaceId } })
    await client.v2TransformationFallbackLedger.deleteMany({ where: { workspaceId } })
    await client.v2TransformationProviderSelection.deleteMany({ where: { workspaceId } })
    await client.v2TransformationBrief.deleteMany({ where: { workspaceId } })
    await client.v2TransformationProviderHealth.deleteMany({ where: { workspaceId } })
    await client.v2TransformationProviderCapability.deleteMany({ where: { workspaceId } })
    await client.v2TransformationProviderDefinition.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { persistTransformationBriefService, recordTransformationProviderHealthService, registerTransformationProviderService, routeTransformationBriefService } = await import('../../src/v2/application/transformation-provider-registry.ts')
    const { createTransformationBrief } = await import('../../src/v2/domain/transformation-brief.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaTransformationProviderRegistryRepository } = await import('../../src/v2/infrastructure/prisma/transformation-provider-registry-repository.ts')
    const { PrismaTransformationQualityRepository } = await import('../../src/v2/infrastructure/prisma/transformation-quality-repository.ts')

    await new PrismaWorkspaceRepository(client).create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Transformation registry integration', status: 'active', createdAt: at(0) }))
    const issued = await createApiClientService({ repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)) })({ id: clientId, credentialId, workspaceId, name: 'Transformation registry client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({ ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext })
    const durableAudit = materializeActorAuditContext(actor)
    let entity = 0, event = 0
    const created = await createProjectService({ repository: new PrismaProjectCreationRepository(client), clock: () => new Date(at(0)), createId: (kind) => `${kind}-transformation-${++entity}`, createEventId: () => `00000000-0000-4000-8000-${String(800_000 + ++event).padStart(12, '0')}` })({ workspaceId, name: 'Transformation project', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'transformation-project' } })
    const repository = new PrismaTransformationProviderRegistryRepository(client)

    const providerInput = (id, quality, price) => ({
      id, workspaceId, displayName: id, adapterId: `${id}-adapter`, adapterVersion: '1.0.0', transport: 'api', credentialRef: `secrets/${id}`, enabled: true,
      capabilities: [{ id: `${id}-relight`, operation: 'relight', capabilityVersion: '1.0.0', modes: ['relight'], regions: ['br'], maximumDurationFrames: 900, maximumWidth: 2160, maximumHeight: 3840, supportsAudio: true, price: { currency: 'BRL', fixedMinorUnits: price, perSecondMinorUnits: 1 }, qualityScoreBps: quality, dataRetention: 'transient' }],
      createdAt: at(1), updatedAt: at(1),
    })
    const primary = await registerTransformationProviderService({ repository, provider: providerInput('transformation-provider-primary', 9_000, 20) })
    assert.equal(primary.replayed, false)
    assert.equal((await registerTransformationProviderService({ repository, provider: providerInput('transformation-provider-primary', 9_000, 20) })).replayed, true)
    await registerTransformationProviderService({ repository, provider: providerInput('transformation-provider-cheap', 9_800, 0) })

    await recordTransformationProviderHealthService({ repository, health: { providerId: 'transformation-provider-primary', workspaceId, status: 'healthy', circuitState: 'closed', consecutiveFailures: 0, observedLatencyMs: 100, observedAt: at(2) } })
    await recordTransformationProviderHealthService({ repository, health: { providerId: 'transformation-provider-cheap', workspaceId, status: 'unavailable', circuitState: 'open', consecutiveFailures: 3, observedLatencyMs: null, observedAt: at(2), cooldownUntil: at(62) } })

    const brief = createTransformationBrief({ workspaceId, projectId: created.project.id, projectVersionId: created.version.id, storyPlanId: 'transformation-story-plan', storyPlanHash: hash('1'), sourceArtifactId: 'transformation-source-artifact', sourceArtifactHash: hash('2'), sourceRange: { startFrame: 0, endFrame: 150 }, intent: 'dramatic-emphasis', editorialIntent: 'Melhorar a luz sem alterar a pessoa.', mode: 'relight', prompt: 'Luz suave lateral.', negativeConstraints: ['não alterar o rosto'], preserve: ['identity', 'speech', 'wardrobe'], allowedChanges: ['lighting'], target: { lighting: 'soft-side' }, outputSpecIds: ['output-vertical'], intensityBps: 2_000, noveltyBps: 1_000, safety: ['identity-locked'], safeZones: [{ x: .2, y: .05, width: .6, height: .8, purpose: 'subject' }], fallbackLadder: ['source-unchanged'], rightsSnapshotId: 'rights-transformation', rightsSnapshotHash: hash('3'), identitySnapshotId: 'identity-transformation', identitySnapshotHash: hash('4'), createdAt: at(3) })
    assert.equal((await persistTransformationBriefService({ repository, brief })).replayed, false)
    assert.equal((await persistTransformationBriefService({ repository, brief })).replayed, true)

    const routed = await routeTransformationBriefService({ repository, workspaceId, projectId: created.project.id, briefId: brief.id, policy: { region: 'br', maximumCostMinorUnits: 100, minimumQualityScoreBps: 8_000, output: { width: 1080, height: 1920, includeAudio: true, fps: 30 } }, createdAt: at(4) })
    assert.equal(routed.replayed, false)
    assert.equal(routed.selection.selectedProviderId, 'transformation-provider-primary')
    assert.ok(routed.selection.candidates.find((candidate) => candidate.providerId === 'transformation-provider-cheap').reasons.includes('health-unavailable'))
    assert.equal((await routeTransformationBriefService({ repository, workspaceId, projectId: created.project.id, briefId: brief.id, policy: { region: 'br', maximumCostMinorUnits: 100, minimumQualityScoreBps: 8_000, output: { width: 1080, height: 1920, includeAudio: true, fps: 30 } }, createdAt: at(4) })).replayed, true)
    assert.equal(await client.v2TransformationProviderSelection.count({ where: { workspaceId } }), 1)

    // Public keys are aliases for one server-owned ledger/rung claim. Two
    // callers racing with different keys converge before any provider job is
    // created, and each key remains permanently bound to its own fingerprint.
    const fallbackLedgerId = 'transformation-fallback-ledger-1'
    await client.v2TransformationFallbackLedger.create({ data: {
      id: fallbackLedgerId, workspaceId, projectId: created.project.id, projectVersionId: created.version.id,
      schemaVersion: 'transformation-fallback-ledger/v1', briefId: brief.id, briefHash: brief.briefHash,
      ladderJson: '["video-to-video","generated-cutaway","source-unchanged"]', currentRung: 'generated-cutaway',
      incurredCostMinorUnits: 10, costCurrency: 'BRL', reviewDecision: 'awaiting-review',
      sourceArtifactId: brief.sourceArtifactId, sourceArtifactSha256: brief.sourceArtifactHash,
      ledgerHash: hash('8'), createdAt: new Date(at(5)), updatedAt: new Date(at(5)),
    } })
    const quality = new PrismaTransformationQualityRepository(client)
    const claimInput = (key, fingerprint, suffix) => ({
      claimId: 'transformation-fallback-claim-1', requestId: `transformation-fallback-request-${suffix}`,
      workspaceId, projectId: created.project.id, ledgerId: fallbackLedgerId, ledgerHash: hash('8'), briefId: brief.id,
      rung: 'generated-cutaway', idempotencyKey: key, requestFingerprint: fingerprint,
      authenticationAudit: durableAudit, createdAt: at(6),
    })
    const [aliasA, aliasB] = await Promise.all([
      quality.claimFallbackDispatch(claimInput('fallback-public-key-a', hash('a'), 'a')),
      quality.claimFallbackDispatch(claimInput('fallback-public-key-b', hash('a'), 'b')),
    ])
    assert.equal(aliasA.claim.id, aliasB.claim.id)
    assert.equal(await client.v2TransformationFallbackDispatchClaim.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2TransformationFallbackDispatchRequest.count({ where: { workspaceId } }), 2)
    await assert.rejects(
      quality.claimFallbackDispatch(claimInput('fallback-public-key-a', hash('b'), 'mismatch')),
      (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    await client.v2TransformationFallbackAttempt.create({ data: {
      id: 'transformation-fallback-skip-attempt', workspaceId, ledgerId: fallbackLedgerId, sequence: 1,
      rung: 'generated-cutaway', outcome: 'skipped', intentScoreBps: null, violatesProtectedContent: false,
      estimatedCostMinorUnits: 0, observedCostMinorUnits: 0, costCurrency: 'BRL',
      reason: 'capability-unavailable', descendedBecause: 'capability-unavailable',
      dispatchRequestHash: hash('a'), actorClientId: durableAudit.clientId,
      actorCredentialId: durableAudit.credentialId, actorEnvironment: durableAudit.environment,
      actorAuthenticationKind: durableAudit.authenticationKind, actorContextHash: durableAudit.contextHash,
      delegatedUserId: durableAudit.delegatedUserId ?? null, delegatedIdentityId: durableAudit.delegatedIdentityId ?? null,
      workspaceRole: durableAudit.workspaceRole ?? null,
    } })
    const settleInput = {
      workspaceId, projectId: created.project.id, claimId: aliasA.claim.id, expectedLedgerId: fallbackLedgerId,
      outcome: 'skipped', resultLedgerId: fallbackLedgerId, resultLedgerHash: hash('8'),
      reason: 'capability-unavailable', settledAt: at(7),
    }
    const [settledA, settledB] = await Promise.all([
      quality.settleFallbackDispatch(settleInput),
      quality.settleFallbackDispatch(settleInput),
    ])
    assert.equal(settledA.outcome, 'skipped')
    assert.equal(settledB.outcome, 'skipped')
    const replay = await quality.claimFallbackDispatch(claimInput('fallback-public-key-a', hash('a'), 'replay'))
    assert.equal(replay.requestReplayed, true)
    assert.equal(replay.claim.outcome, 'skipped')

    const invisible = await repository.readBrief({ workspaceId: 'another-workspace', projectId: created.project.id, briefId: brief.id })
    assert.equal(invisible, null)
    await client.v2TransformationBrief.update({ where: { id: brief.id }, data: { briefJson: JSON.stringify({ ...brief, prompt: 'tampered' }) } })
    await assert.rejects(repository.readBrief({ workspaceId, projectId: created.project.id, briefId: brief.id }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
