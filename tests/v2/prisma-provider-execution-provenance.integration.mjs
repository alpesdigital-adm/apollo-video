import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createProviderTransportObservation, bindProviderTransportEvidence } from '../../src/v2/application/provider-transport-observation.ts'

const suffix = randomUUID().slice(0, 8)
const workspaceId = `provider-provenance-${suffix}`
const clientId = `provider-provenance-client-${suffix}`
const credentialId = `provider-provenance-credential-${suffix}`
const jobId = `provider-provenance-job-${suffix}`
const at = (second) => new Date(Date.parse('2029-06-01T00:00:00.000Z') + second * 1_000)

test('W24.2 PostgreSQL fences provider transport evidence by job attempt, hash and active lease', {
  skip: process.env.APOLLO_PROVIDER_EXECUTION_PROVENANCE_PG_E2E !== '1' && 'explicit PostgreSQL E2E opt-in is required', timeout: 240_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL is required')
  const databaseUrl = new URL(process.env.V2_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseUrl.hostname), 'PostgreSQL provenance E2E must use loopback')
  assert.match(databaseUrl.pathname, /_e2e$/)
  assert.match(databaseUrl.searchParams.get('application_name') ?? '', /^apollo-video-e2e-/)
  const boundedPositive = (name, maximum) => {
    const raw = databaseUrl.searchParams.get(name)
    const value = raw === null ? Number.NaN : Number(raw)
    assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= maximum, `${name} must be between 1 and ${maximum}`)
  }
  boundedPositive('connection_limit', 5)
  boundedPositive('pool_timeout', 10)
  boundedPositive('connect_timeout', 10)
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } })
  const cleanup = async () => {
    await client.v2ProviderExecutionReceiptResult.deleteMany({ where: { workspaceId } })
    await client.v2ProviderExecutionReceipt.deleteMany({ where: { workspaceId } })
    await client.v2ProviderTransportEvidence.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJobTransportState.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }
  try {
    await cleanup()
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { registerSyntheticPresenterProfileService } = await import('../../src/v2/application/synthetic-production.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { PrismaProviderExecutionProvenanceRepository } = await import('../../src/v2/infrastructure/prisma/provider-execution-provenance-repository.ts')
    const { PrismaProviderResultArtifactRepository } = await import('../../src/v2/infrastructure/prisma/provider-result-artifact-repository.ts')
    const { createProviderExecutionReceipt, providerExecutionReceiptBody } = await import('../../src/v2/application/provider-transport-observation.ts')
    const { PrismaProviderJobRepository } = await import('../../src/v2/infrastructure/prisma/provider-job-repository.ts')
    const { createProviderJob, transitionProviderJob } = await import('../../src/v2/domain/provider-job.ts')

    await new PrismaWorkspaceRepository(client).create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Provider provenance integration', status: 'active', createdAt: at(0).toISOString() }))
    const issued = await createApiClientService({ repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => at(0) })({ id: clientId, credentialId, workspaceId, name: 'Provider provenance client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const audit = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({ ...audit, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext: audit })
    let entity = 0
    let event = 0
    const created = await createProjectService({ repository: new PrismaProjectCreationRepository(client), clock: () => at(0), createId: (kind) => `${kind}-provenance-${++entity}`, createEventId: () => `00000000-0000-4000-8000-${String(900_000 + ++event).padStart(12, '0')}` })({ workspaceId, name: 'Provider provenance', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'provider-provenance-project' } })
    const consentArtifactId = `provider-consent-${suffix}`
    await client.v2MediaArtifact.create({ data: { id: consentArtifactId, workspaceId, artifactKey: `provider/${suffix}-consent.json`, sha256: '7'.repeat(64), byteSize: 64n, mediaType: 'data', container: 'json', status: 'available', createdAt: at(0) } })
    const profile = await registerSyntheticPresenterProfileService({
      repository: new PrismaSyntheticProductionRepository(client),
      artifacts: new PrismaMediaArtifactRepository(client),
      clock: () => at(0),
    })({
      workspaceId, profileId: `provider-profile-${suffix}`, version: 1, actorIdentityId: `provider-identity-${suffix}`,
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: `avatar-${suffix}` },
      voice: { id: `voice-${suffix}`, version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteudo gerado com IA',
      consent: { id: `provider-consent-v1-${suffix}`, evidenceArtifactId: consentArtifactId, granted: true, allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'], allowedOperations: ['tts'], expiresAt: at(300).toISOString() },
      actor, idempotencyKey: `provider-profile-v1-${suffix}`,
    })
    const authorizationBody = { id: `provider-authorization-${suffix}`, profileSnapshotId: profile.profile.profileSnapshotId, profileSnapshotHash: profile.profile.snapshot.snapshotHash, artifactDecisions: [], evaluatedAt: at(0).toISOString(), expiresAt: at(300).toISOString() }
    const authorization = Object.freeze({ ...authorizationBody, authorizationHash: calculateCanonicalHash(authorizationBody) })
    const canonicalJob = createProviderJob({ id: jobId, workspaceId, projectId: created.project.id, originProjectVersionId: created.version.id, operation: 'tts', adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0', providerInput: { text: 'server-owned' }, idempotencyKey: `provider-provenance-${suffix}`, authorization, createdAt: at(1).toISOString() })
    const providerJobs = new PrismaProviderJobRepository(client)
    await providerJobs.create({ job: canonicalJob, requestFingerprint: calculateCanonicalHash({ jobId }), authenticationAudit: materializeActorAuditContext(actor), transitionId: `provider-transition-create-${suffix}` })
    const plannedClaim = await providerJobs.claimNext({ workerId: 'provider-provenance-worker', leaseToken: `provider-plan-lease-${suffix}`, now: at(2), leaseExpiresAt: at(30) })
    assert.ok(plannedClaim)
    await providerJobs.advance({ current: plannedClaim, next: transitionProviderJob(plannedClaim.job, { status: 'estimated', occurredAt: at(2).toISOString(), estimate: { currency: 'USD', costMinorUnits: 1, estimatedLatencyMs: 1 } }), transitionId: `provider-transition-estimate-${suffix}`, occurredAt: at(2) })
    const estimatedClaim = await providerJobs.claimNext({ workerId: 'provider-provenance-worker', leaseToken: 'provider-provenance-lease', now: at(3), leaseExpiresAt: at(30) })
    assert.ok(estimatedClaim)
    const submittingClaim = await providerJobs.beginSubmission({ current: estimatedClaim, next: transitionProviderJob(estimatedClaim.job, { status: 'submitting', occurredAt: at(3).toISOString() }), transitionId: `provider-transition-submit-${suffix}`, occurredAt: at(3) })
    const { inputHash, jobHash } = submittingClaim.job
    const authorizationHash = submittingClaim.job.authorization.authorizationHash
    const observation = createProviderTransportObservation({
      phase: 'submit', runtimeClass: 'controlled', adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0',
      adapterConfigHash: 'a'.repeat(64), endpointClass: 'elevenlabs-tts-with-timestamps', method: 'POST',
      requestHash: 'b'.repeat(64), responseHash: 'c'.repeat(64), responseStatus: 200,
      providerJobRef: 'elevenlabs_request_provenance', observedAt: at(2).toISOString(),
    })
    const evidence = bindProviderTransportEvidence({ observation, workspaceId, projectId: created.project.id, jobId, attempt: 1, inputHash, authorizationHash, jobHash, leaseOwner: 'provider-provenance-worker', leaseToken: 'provider-provenance-lease' })
    const repository = new PrismaProviderExecutionProvenanceRepository(client, () => at(4))
    assert.equal((await repository.recordEvidence({ evidence })).replayed, false)
    assert.equal((await repository.recordEvidence({ evidence })).replayed, true)
    assert.equal((await repository.listEvidenceByJob({ workspaceId, projectId: created.project.id, jobId })).length, 1)
    await client.v2ProviderTransportEvidence.update({ where: { id: evidence.id }, data: { evidenceHash: 'f'.repeat(64) } })
    await assert.rejects(repository.listEvidenceByJob({ workspaceId, projectId: created.project.id, jobId }), (error) => error.code === 'PERSISTENCE_CONFLICT')
    await client.v2ProviderTransportEvidence.update({ where: { id: evidence.id }, data: { evidenceHash: evidence.evidenceHash } })

    const artifactId = `provider-provenance-artifact-${suffix}`
    const artifactSha256 = '8'.repeat(64)
    await client.v2MediaArtifact.create({ data: { id: artifactId, workspaceId, artifactKey: `provider/${suffix}.mp3`, sha256: artifactSha256, byteSize: 123n, mediaType: 'audio', container: 'mp3', createdAt: at(4) } })
    const resultArtifacts = new PrismaProviderResultArtifactRepository(client)
    const resultRecord = (await resultArtifacts.persistOrReplay({ records: [{
      id: `provider-result-${suffix}`, workspaceId, projectId: created.project.id, jobId,
      schemaVersion: 'provider-result-artifact/v1', role: 'primary-audio', providerJobRef: 'elevenlabs_request_provenance',
      artifactId, artifactSha256, byteSize: 123, mediaType: 'audio', container: 'mp3', adapterId: 'elevenlabs-tts',
      adapterVersion: '1.0.0', adapterConfigHash: 'a'.repeat(64), inputHash, authorizationHash,
      completedAt: at(4).toISOString(), createdAt: at(4).toISOString(),
    }] })).records[0]
    assert.ok(resultRecord.recordHash)
    const submitted = transitionProviderJob(submittingClaim.job, { status: 'submitted', occurredAt: at(4).toISOString(), providerJobId: 'elevenlabs_request_provenance', providerStatus: 'completed', resultArtifact: { artifactId, artifactSha256, mediaType: 'audio', byteSize: 123 } })
    await providerJobs.advance({ current: submittingClaim, next: submitted, transitionId: `provider-transition-submitted-${suffix}`, occurredAt: at(4) })
    const submittedClaim = await providerJobs.claimNext({ workerId: 'provider-provenance-worker', leaseToken: `provider-retrieve-step-${suffix}`, now: at(5), leaseExpiresAt: at(30) })
    assert.ok(submittedClaim)
    await providerJobs.advance({ current: submittedClaim, next: transitionProviderJob(submittedClaim.job, { status: 'retrieving', occurredAt: at(5).toISOString() }), transitionId: `provider-transition-retrieving-${suffix}`, occurredAt: at(5) })
    const receiptClaim = await providerJobs.claimNext({ workerId: 'provider-provenance-worker', leaseToken: `provider-receipt-lease-${suffix}`, now: at(6), leaseExpiresAt: at(30) })
    assert.ok(receiptClaim)
    const receipt = createProviderExecutionReceipt({
      schemaVersion: 'provider-execution-receipt/v1', id: `provider-receipt-${suffix}`, workspaceId,
      projectId: created.project.id, jobId, attempt: 1, runtimeClass: 'controlled', adapterId: 'elevenlabs-tts',
      adapterVersion: '1.0.0', adapterConfigHash: 'a'.repeat(64), inputHash, authorizationHash,
      providerJobRef: 'elevenlabs_request_provenance', leaseOwner: receiptClaim.lease.owner, leaseToken: receiptClaim.lease.token,
      submitEvidenceId: evidence.id, submitEvidenceHash: evidence.evidenceHash,
      results: [{ resultRecordId: resultRecord.id, resultRecordHash: resultRecord.recordHash, role: resultRecord.role, artifactId, artifactSha256, byteSize: 123 }],
      createdAt: at(6).toISOString(),
    })
    assert.equal((await repository.createReceipt({ receipt })).replayed, false)
    assert.equal((await repository.createReceipt({ receipt: { ...receipt, createdAt: at(7).toISOString() } })).replayed, true)
    assert.equal((await repository.readReceiptByJob({ workspaceId, projectId: created.project.id, jobId })).receiptHash, receipt.receiptHash)
    await client.v2ProviderExecutionReceipt.update({ where: { id: receipt.id }, data: { receiptJson: JSON.stringify({ tampered: true }) } })
    await assert.rejects(repository.readReceiptByJob({ workspaceId, projectId: created.project.id, jobId }), (error) => error.code === 'PERSISTENCE_CONFLICT')
    await client.v2ProviderExecutionReceipt.update({ where: { id: receipt.id }, data: { receiptJson: JSON.stringify(providerExecutionReceiptBody(receipt)) } })
    await client.v2ProviderExecutionReceipt.update({ where: { id: receipt.id }, data: { receiptHash: 'e'.repeat(64) } })
    await assert.rejects(repository.readReceiptByJob({ workspaceId, projectId: created.project.id, jobId }), (error) => error.code === 'PERSISTENCE_CONFLICT')
    await client.v2ProviderExecutionReceipt.update({ where: { id: receipt.id }, data: { receiptHash: receipt.receiptHash } })

    await client.v2ProviderJob.update({ where: { id: jobId }, data: { leaseToken: 'provider-provenance-stolen', status: 'submitting', jobHash } })
    const secondObservation = createProviderTransportObservation({
      phase: observation.phase, runtimeClass: observation.runtimeClass,
      adapterId: observation.adapterId, adapterVersion: observation.adapterVersion,
      adapterConfigHash: observation.adapterConfigHash, endpointClass: observation.endpointClass,
      method: observation.method, requestHash: observation.requestHash, responseHash: 'd'.repeat(64),
      responseStatus: observation.responseStatus, providerJobRef: observation.providerJobRef,
      observedAt: at(4).toISOString(),
    })
    const staleEvidence = bindProviderTransportEvidence({ observation: secondObservation, workspaceId, projectId: created.project.id, jobId, attempt: 1, inputHash, authorizationHash, jobHash, leaseOwner: 'provider-provenance-worker', leaseToken: 'provider-provenance-lease' })
    await assert.rejects(repository.recordEvidence({ evidence: staleEvidence }), (error) => error.code === 'VERSION_CONFLICT')
    assert.equal(await client.v2ProviderTransportEvidence.count({ where: { workspaceId, jobId } }), 1)
  } finally {
    try { await cleanup() } finally { await client.$disconnect() }
  }
})
