import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { assertIsolatedDatabase } from './helpers/capture-journey.mjs'
import { createLocalizationPgFixture } from './helpers/localization-pg.mjs'
const { preflightLocalizationRunService, requestLocalizationRunService, runNextLocalizationTranslationService } = await import('../../src/v2/application/localization-translation-worker.ts')
const { PrismaLocalizationRunRepository } = await import('../../src/v2/infrastructure/prisma/localization-run-repository.ts')
const { HmacPreflightCommitTokenIssuer } = await import('../../src/v2/infrastructure/security/preflight-commit-token.ts')
const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')

const enabled = process.env.APOLLO_RUN_LOCALIZATION_PREFLIGHT_PG_E2E === '1'
test('T-FR-translation-preflight PostgreSQL atomically consumes one bound cost confirmation and converges retries', { skip: !enabled, timeout: 60_000 }, async () => {
  assertIsolatedDatabase()
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  let fixture, poisonFixture, testFailure
  const issuer = new HmacPreflightCommitTokenIssuer('postgres-localization-preflight-secret-at-least-32-bytes')
  const provider = { providerId: 'controlled-no-dispatch', adapterVersion: '1', model: 'translation-v1', configHash: 'f'.repeat(64) }
  try {
    fixture = await createLocalizationPgFixture(prisma)
    const runs = new PrismaLocalizationRunRepository(prisma)
    const preflightInput = { workspaceId: fixture.workspaceId, projectId: fixture.projectId, variantId: fixture.variant.id, expectedRevision: fixture.variant.revision, expectedHash: fixture.variant.variantHash, actorClientId: fixture.clientId, idempotencyKey: `preflight-${fixture.suffix}`, authenticationAudit: fixture.audit }
    const preflightService = preflightLocalizationRunService({ localization: fixture.repository, runs, tokenIssuer: issuer, provider: { ...provider, maxCompletionTokens: 256 }, pricing: { currency: 'USD', microsPerThousandInputCharacters: 1000, microsPerThousandOutputTokens: 2000, maximumCostMicros: 100_000, confirmationTtlMs: 60_000 }, clock: () => fixture.now, createId: () => fixture.suffix })
    const first = await preflightService(preflightInput), replay = await preflightService(preflightInput)
    assert.equal(replay.replayed, true); assert.equal(replay.preflight.preflightHash, first.preflight.preflightHash)
    const requestInput = { ...preflightInput, idempotencyKey: `run-${fixture.suffix}`, preflightId: first.preflight.id, expectedPreflightHash: first.preflight.preflightHash, commitToken: first.commitToken }
    const request = requestLocalizationRunService({ localization: fixture.repository, runs, tokenIssuer: issuer, clock: () => fixture.now, createId: () => fixture.suffix })
    const queued = await request(requestInput), queuedReplay = await request(requestInput)
    assert.equal(queued.replayed, false); assert.equal(queuedReplay.replayed, true); assert.equal(queuedReplay.run.id, queued.run.id)
    const stored = await prisma.v2LocalizationTranslationPreflight.findUniqueOrThrow({ where: { id: first.preflight.id } })
    assert.equal(stored.consumedByRunId, queued.run.id); assert.ok(stored.consumedAt)
    await assert.rejects(request({ ...requestInput, idempotencyKey: `second-run-${fixture.suffix}` }), /already consumed|expired, consumed/)
    assert.equal(await prisma.v2LocalizationRun.count({ where: { workspaceId: fixture.workspaceId, variantId: fixture.variant.id, variantRevision: fixture.variant.revision } }), 1)
    const revokedAt = new Date(fixture.now.getTime() + 1_000), rightsRepository = new PrismaAssetRightsRepository(prisma)
    const currentRights = await rightsRepository.findCurrent(fixture.workspaceId, fixture.artifactId)
    await setAssetRightsService({ repository: rightsRepository, clock: () => revokedAt, createId: () => `revoked-${fixture.suffix}` })({ workspaceId: fixture.workspaceId, artifactId: fixture.artifactId, baseRevision: currentRights.revision, actor: { type: 'api-client', id: fixture.clientId }, draft: { status: 'restricted', allowedUses: [], prohibitedUses: ['localization'], consent: { status: 'not-required', allowedUses: [] } } })
    let providerCalls = 0
    const boundedProvider = { ...provider, maxCompletionTokens: 256, async translate() { providerCalls += 1; assert.fail('revoked source must never reach provider') } }
    const worker = runNextLocalizationTranslationService({ runs, provider: boundedProvider, authorizeClaim: async (claim) => runs.authorizeCurrentSource({ run: claim.run, preflight: claim.preflight, at: revokedAt.toISOString() }), workerId: `worker-${fixture.suffix}`, clock: () => revokedAt, createLeaseToken: () => `lease-${fixture.suffix}` })
    await assert.rejects(worker(), /authorization changed|blocked|not allow/i)
    assert.equal(providerCalls, 0)
    const terminal = await prisma.v2LocalizationRun.findUniqueOrThrow({ where: { id: queued.run.id } })
    assert.equal(terminal.status, 'failed')

    poisonFixture = await createLocalizationPgFixture(prisma)
    const poisonInput = { workspaceId: poisonFixture.workspaceId, projectId: poisonFixture.projectId, variantId: poisonFixture.variant.id, expectedRevision: poisonFixture.variant.revision, expectedHash: poisonFixture.variant.variantHash, actorClientId: poisonFixture.clientId, idempotencyKey: `preflight-${poisonFixture.suffix}`, authenticationAudit: poisonFixture.audit }
    const poisonPreflight = await preflightLocalizationRunService({ localization: poisonFixture.repository, runs, tokenIssuer: issuer, provider: boundedProvider, pricing: { currency: 'USD', microsPerThousandInputCharacters: 1000, microsPerThousandOutputTokens: 2000, maximumCostMicros: 100_000, confirmationTtlMs: 60_000 }, clock: () => poisonFixture.now, createId: () => poisonFixture.suffix })(poisonInput)
    const poisonQueued = await requestLocalizationRunService({ localization: poisonFixture.repository, runs, tokenIssuer: issuer, clock: () => poisonFixture.now, createId: () => poisonFixture.suffix })({ ...poisonInput, idempotencyKey: `run-${poisonFixture.suffix}`, preflightId: poisonPreflight.preflight.id, expectedPreflightHash: poisonPreflight.preflight.preflightHash, commitToken: poisonPreflight.commitToken })
    await prisma.v2LocalizationVariantHead.update({ where: { id: poisonFixture.variant.id }, data: { currentVariantHash: '0'.repeat(64) } })
    const poisonedClaim = await runs.claim({ workerId: `poison-${poisonFixture.suffix}`, leaseTokenHash: '1'.repeat(64), now: poisonFixture.now.toISOString(), leaseExpiresAt: new Date(poisonFixture.now.getTime() + 60_000).toISOString() })
    assert.equal(poisonedClaim, null)
    assert.equal((await prisma.v2LocalizationRun.findUniqueOrThrow({ where: { id: poisonQueued.run.id } })).status, 'failed')
    assert.equal(await prisma.v2LocalizationRun.count({ where: { workspaceId: poisonFixture.workspaceId, status: 'requested' } }), 0)
  } catch (error) { testFailure = error; throw error }
  finally { try { for (const owned of [poisonFixture, fixture]) if (owned) { await prisma.v2LocalizationRunRevision.deleteMany({ where: { workspaceId: owned.workspaceId } }); await prisma.v2LocalizationRun.deleteMany({ where: { workspaceId: owned.workspaceId } }); await prisma.v2LocalizationTranslationPreflight.deleteMany({ where: { workspaceId: owned.workspaceId } }); await owned.cleanup() } } catch (cleanupError) { if (testFailure) throw new AggregateError([testFailure, cleanupError], 'Localization preflight proof and cleanup both failed'); throw cleanupError } finally { await prisma.$disconnect() } }
})
