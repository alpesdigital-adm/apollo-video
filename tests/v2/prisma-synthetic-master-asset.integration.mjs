import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const workspaceId = 'master-asset-int-workspace'
const foreignWorkspaceId = 'master-asset-int-foreign'
const clientId = 'master-asset-int-client'
const credentialId = 'master-asset-int-credential'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-04-01T00:00:00.000Z') + second * 1_000).toISOString()

test('T-FR-104 synthetic masters persist transactionally, content-addressed and fail closed on PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 300_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })

  const cleanupWorkspace = async (id) => {
    await client.v2SyntheticCriticIssue.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCriticMeasurement.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCriticEvaluator.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCriticReport.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId: id }, data: { currentVersionId: null } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticSpeechSegment.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticMasterArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticMasterAsset.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId: id } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId: id } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId: id } })
    await client.v2Project.deleteMany({ where: { workspaceId: id } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId: id } })
    await client.v2Workspace.deleteMany({ where: { id } })
  }
  const cleanup = async () => {
    await cleanupWorkspace(workspaceId)
    await cleanupWorkspace(foreignWorkspaceId)
  }

  try {
    await cleanup()
    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { registerSyntheticPresenterProfileService } = await import('../../src/v2/application/synthetic-production.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { createSyntheticMasterAsset } = await import('../../src/v2/domain/synthetic-master-asset.ts')
    const { createSyntheticCriticReport } = await import('../../src/v2/domain/synthetic-critic-report.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { PrismaSyntheticMasterAssetRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-master-asset-repository.ts')
    const { PrismaSyntheticCriticReportRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-critic-report-repository.ts')
    const { PrismaSyntheticSpeechSegmentRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-speech-segment-repository.ts')
    const { catalogSyntheticSpeechSegmentsService } = await import('../../src/v2/application/synthetic-speech-segments.ts')

    const workspaces = new PrismaWorkspaceRepository(client)
    await workspaces.create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Master asset integration', status: 'active', createdAt: at(0) }))
    await workspaces.create(createWorkspace({ id: foreignWorkspaceId, slug: foreignWorkspaceId, name: 'Foreign workspace', status: 'active', createdAt: at(0) }))

    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: clientId, credentialId, workspaceId, name: 'Master asset client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const externalAudit = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({
      ...externalAudit, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext: externalAudit,
    })
    // Durable rows are stamped with the canonical credential-bound audit the
    // application services derive from the authenticated actor.
    const auditContext = materializeActorAuditContext(actor)

    let entity = 0
    let event = 0
    const project = await createProjectService({
      repository: new PrismaProjectCreationRepository(client), clock: () => new Date(at(0)),
      createId: (kind) => `${kind}-master-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(700_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Master persistido', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'master-project' } })
    const projectId = project.project.id
    const projectVersionId = project.version.id

    // Media artifacts the master points at, plus the consent evidence.
    const artifactIds = {
      'provider-original': 'master-original',
      'normalized-video': 'master-normalized',
      'final-audio': 'master-audio',
      alignment: 'master-alignment',
    }
    const artifactShas = { 'provider-original': hash('a'), 'normalized-video': hash('b'), 'final-audio': hash('c'), alignment: hash('d') }
    const artifactMedia = { 'provider-original': ['video', 'mp4'], 'normalized-video': ['video', 'mp4'], 'final-audio': ['audio', 'wav'], alignment: ['data', 'json'] }
    for (const [role, id] of Object.entries(artifactIds)) {
      await client.v2MediaArtifact.create({
        data: {
          id, workspaceId, artifactKey: `master/${id}.${artifactMedia[role][1]}`, sha256: artifactShas[role],
          byteSize: 4_096n, mediaType: artifactMedia[role][0], container: artifactMedia[role][1], status: 'available', createdAt: new Date(at(0)),
        },
      })
    }
    await client.v2MediaArtifact.create({
      data: {
        id: 'master-consent-evidence', workspaceId, artifactKey: 'master/consent.json', sha256: hash('e'),
        byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })

    const profile = await registerSyntheticPresenterProfileService({
      repository: new PrismaSyntheticProductionRepository(client),
      artifacts: new PrismaMediaArtifactRepository(client),
      clock: () => new Date(at(0)),
    })({
      workspaceId, profileId: 'master-presenter', version: 1, actorIdentityId: 'master-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_master' },
      voice: { id: 'voice_master', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: 'master-consent-v1', evidenceArtifactId: 'master-consent-evidence', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      },
      actor, idempotencyKey: 'master-profile-v1',
    })
    const profileSnapshotId = profile.profile.profileSnapshotId
    const profileSnapshotHash = profile.profile.profileHash

    // An approved provider job, sealed by its critic result hash: the fixture
    // the repository must keep verifying at commit time.
    const criticResultHash = hash('f')
    const providerJobId = 'master-provider-job'
    await client.v2ProviderJob.create({
      data: {
        id: providerJobId, workspaceId, projectId, originProjectVersionId: projectVersionId,
        schemaVersion: 'provider-job/v1', operation: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.0.0',
        providerJobId: 'heygen_job_master', inputJson: '{}', inputHash: hash('1'),
        authorizationJson: '{}', authorizationHash: hash('2'), status: 'approved',
        resultArtifactId: artifactIds['provider-original'], resultArtifactSha256: artifactShas['provider-original'],
        criticResultHash, jobJson: '{}', jobHash: hash('3'), requestFingerprint: hash('4'),
        idempotencyKey: 'master-job-key', createdByClientId: clientId, actorContextHash: auditContext.contextHash,
        createdAt: new Date(at(1)), updatedAt: new Date(at(2)), completedAt: new Date(at(2)),
      },
    })

    // The critic's own verdict on the bytes this master seals. It is recorded
    // through the real repository — transactional, hash-verified on read — so
    // the master's `critic` ref points at a report that exists and can be
    // opened, instead of at an id derived from the provider job.
    await client.v2SyntheticScriptPlan.create({
      data: {
        id: 'master-plan', workspaceId, projectId, schemaVersion: 'synthetic-script-plan/v1',
        requestFingerprint: hash('1'), idempotencyKey: 'master-plan-key', createdByClientId: clientId,
        actorContextHash: auditContext.contextHash, createdAt: new Date(at(0)), updatedAt: new Date(at(0)),
      },
    })
    await client.v2SyntheticScriptPlanVersion.create({
      data: {
        id: 'master-plan-v1', planId: 'master-plan', workspaceId, projectId, sequence: 1,
        projectVersionId, profileSnapshotId, schemaVersion: 'synthetic-script-plan-version/v1',
        locale: 'pt-BR', segmentationVersion: 'synthetic-script-segmentation/v1',
        scriptHash: hash('2'), commandType: 'create-plan', blockSequenceJson: '["master-block"]',
        impactJson: '{}', commandImpactHash: hash('3'), planVersionHash: hash('4'),
        requestFingerprint: hash('1'), idempotencyKey: 'master-plan-version-key',
        createdByClientId: clientId, actorContextHash: auditContext.contextHash, createdAt: new Date(at(0)),
      },
    })
    await client.v2SyntheticScriptBlock.create({
      data: {
        id: 'master-block', workspaceId, projectId, planId: 'master-plan',
        schemaVersion: 'synthetic-script-block/v1', exactText: 'Primeira ideia do roteiro.',
        normalizedTextHash: hash('5'), locale: 'pt-BR', occurrence: 1,
        createdInVersionId: 'master-plan-v1', originKind: 'initial-segmentation',
        blockHash: hash('6'), createdAt: new Date(at(0)),
      },
    })
    const criticMeasured = (dimension, evaluatorId, value, unit, threshold) => ({
      dimension, status: 'measured', evaluatorId, value, unit, threshold,
      confidence: 1, evidenceRefs: ['artifact://master-original'], range: null, note: null,
    })
    const criticUnavailable = (dimension, note) => ({
      dimension, status: 'unavailable', evaluatorId: null, value: null, unit: null,
      threshold: null, confidence: null, evidenceRefs: [], range: null, note,
    })
    const criticReport = createSyntheticCriticReport({
      id: 'master-critic-report-1', workspaceId, projectId, blockId: 'master-block',
      capability: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.0.0',
      artifactId: artifactIds['provider-original'], artifactSha256: artifactShas['provider-original'],
      audioArtifactId: artifactIds['final-audio'], alignmentArtifactId: artifactIds.alignment,
      scriptHash: hash('7'), profileSnapshotId, expectedIdentityRef: 'avatar_master',
      evaluators: [
        { id: 'ffprobe-media-integrity', version: '1.0.0', kind: 'measured', scope: 'timeline and signal read from the artifact' },
        { id: 'alignment-pronunciation', version: '1.0.0', kind: 'measured', scope: 'spoken words compared to the approved script' },
        { id: 'controlled-deterministic-probe', version: '1.0.0', kind: 'controlled', scope: 'deterministic stand-in, not production visual validation' },
      ],
      measurements: [
        criticMeasured('lip-sync', 'controlled-deterministic-probe', 0, 'ms-av-offset', 34),
        criticMeasured('identity', 'controlled-deterministic-probe', 1, 'identity-ref-match', 1),
        criticMeasured('pronunciation', 'alignment-pronunciation', 0, 'word-deviations', 0),
        criticUnavailable('visual-artifacts', 'no visual artifact detector is deployed'),
        criticUnavailable('framing', 'no framing model is deployed'),
        criticUnavailable('continuity', 'this is the first approved block of the take'),
        criticUnavailable('eyes', 'no eye model is deployed'),
        criticUnavailable('teeth', 'no teeth model is deployed'),
        criticUnavailable('hands', 'no hand model is deployed'),
        criticMeasured('temporal-integrity', 'ffprobe-media-integrity', 0, 'ms-drift', 34),
        criticMeasured('audiovisual-integrity', 'ffprobe-media-integrity', 1, 'live-signal', 1),
      ],
      issues: [],
      decision: 'approved', recommendedAction: 'none',
      thresholdsVersion: 'synthetic-critic-thresholds/audio-avatar/heygen-v3/v1',
      decidedAt: at(3),
    })
    const recordedVerdict = await new PrismaSyntheticCriticReportRepository(client)
      .record({ report: criticReport })
    assert.equal(recordedVerdict.replayed, false)
    assert.equal(recordedVerdict.value.decision, 'approved')

    const repository = new PrismaSyntheticMasterAssetRepository(client)
    const masterInput = (overrides = {}) => createSyntheticMasterAsset({
      id: 'master-1', workspaceId, projectId, projectVersionId,
      profileId: 'master-presenter', profileSnapshotId, profileVersion: 1,
      consentSnapshotHash: hash('5'), authorizationHash: hash('2'), rightsSnapshotId: null,
      artifacts: Object.entries(artifactIds).map(([role, id]) => ({
        role, artifactId: id, sha256: artifactShas[role], byteSize: 4_096,
        mediaType: artifactMedia[role][0], container: artifactMedia[role][1],
      })),
      scriptText: 'Primeira ideia do roteiro. Segunda ideia bem forte.',
      alignmentHash: hash('6'), locale: 'pt-BR',
      durationMs: 4_000, audioDurationMs: 4_000, videoDurationMs: 4_000,
      provenance: {
        adapterId: 'heygen-v3', adapterVersion: '3.0.0', capability: 'audio-avatar', modelRef: 'avatar-model-1',
        adapterConfigHash: hash('7'), providerJobId, providerJobRef: 'heygen_job_master',
      },
      cost: { currency: 'USD', minorUnits: 150, latencyMs: 8_400 },
      critic: {
        reportId: recordedVerdict.value.id,
        reportHash: recordedVerdict.value.reportHash,
        decision: recordedVerdict.value.decision,
      },
      lineage: ['generation-1', 'generation-2'],
      createdAt: at(10),
      ...overrides,
    })

    // 1. Transactional seal: master row and its four artifact rows commit together.
    const created = await repository.create({
      master: masterInput(), profileSnapshotHash, criticResultHash,
      requestFingerprint: hash('9'), idempotencyKey: 'master-seal-1', authenticationAudit: auditContext,
    })
    assert.equal(created.replayed, false)
    assert.equal(created.value.master.masterHash.length, 64)
    assert.equal(await client.v2SyntheticMasterArtifact.count({ where: { workspaceId, masterId: 'master-1' } }), 4)

    // 2. Replay is idempotent and byte-equivalent, without a second row.
    const replay = await repository.create({
      master: masterInput(), profileSnapshotHash, criticResultHash,
      requestFingerprint: hash('9'), idempotencyKey: 'master-seal-1', authenticationAudit: auditContext,
    })
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.value.master, created.value.master)
    assert.equal(await client.v2SyntheticMasterAsset.count({ where: { workspaceId } }), 1)

    // 3. Reads are content-addressed and job-addressed.
    const read = await repository.read({ workspaceId, masterId: 'master-1' })
    assert.deepEqual(read.master, created.value.master)
    assert.deepEqual((await repository.findByProviderJob({ workspaceId, providerJobId })).master, created.value.master)
    assert.deepEqual((await repository.findByMasterHash({ workspaceId, masterHash: created.value.master.masterHash })).master, created.value.master)
    assert.equal((await repository.list({ workspaceId, projectId, limit: 10 })).length, 1)
    assert.equal((await repository.list({ workspaceId, scriptHash: hash('a'), limit: 10 })).length, 0)

    // 4. The same performance is never sealed twice, even under a new idempotency key.
    const duplicate = await repository.create({
      master: masterInput(), profileSnapshotHash, criticResultHash,
      requestFingerprint: hash('0'), idempotencyKey: 'master-seal-2', authenticationAudit: auditContext,
    })
    assert.equal(duplicate.replayed, true)
    assert.equal(duplicate.value.master.masterHash, created.value.master.masterHash)
    assert.equal(await client.v2SyntheticMasterAsset.count({ where: { workspaceId } }), 1)

    // 5. A stale presenter snapshot or a job that lost its critic approval
    //    fails closed before anything is written.
    await assert.rejects(
      repository.create({
        master: masterInput({ id: 'master-2', scriptText: 'Outro roteiro completamente diferente.' }),
        profileSnapshotHash: hash('c'), criticResultHash,
        requestFingerprint: hash('9'), idempotencyKey: 'master-seal-3', authenticationAudit: auditContext,
      }),
      /snapshot changed before the master was sealed/,
    )
    await assert.rejects(
      repository.create({
        master: masterInput({ id: 'master-3', scriptText: 'Mais um roteiro diferente ainda.' }),
        profileSnapshotHash, criticResultHash: hash('b'),
        requestFingerprint: hash('9'), idempotencyKey: 'master-seal-4', authenticationAudit: auditContext,
      }),
      /no longer approved with the critic result/,
    )
    assert.equal(await client.v2SyntheticMasterAsset.count({ where: { workspaceId } }), 1)

    // 6. Cross-workspace invisibility.
    assert.equal(await repository.read({ workspaceId: foreignWorkspaceId, masterId: 'master-1' }), null)
    assert.equal(await repository.findByProviderJob({ workspaceId: foreignWorkspaceId, providerJobId }), null)
    assert.equal((await repository.list({ workspaceId: foreignWorkspaceId, limit: 10 })).length, 0)

    // 7. Hydration fails closed when a row is edited behind the application.
    await client.v2SyntheticMasterAsset.update({ where: { id: 'master-1' }, data: { costMinorUnits: 1 } })
    await assert.rejects(repository.read({ workspaceId, masterId: 'master-1' }), /failed integrity validation/)
    await client.v2SyntheticMasterAsset.update({ where: { id: 'master-1' }, data: { costMinorUnits: 150 } })
    assert.ok(await repository.read({ workspaceId, masterId: 'master-1' }))

    await client.v2SyntheticMasterArtifact.update({
      where: { masterId_role: { masterId: 'master-1', role: 'final-audio' } },
      data: { sha256: hash('9') },
    })
    await assert.rejects(repository.read({ workspaceId, masterId: 'master-1' }), /final-audio artifact was altered/)
    await client.v2SyntheticMasterArtifact.update({
      where: { masterId_role: { masterId: 'master-1', role: 'final-audio' } },
      data: { sha256: artifactShas['final-audio'] },
    })

    // 8. Catalogued segments are deterministic, reuse the master's own
    //    artifacts and are searchable through the workspace catalog.
    const segmentRepository = new PrismaSyntheticSpeechSegmentRepository(client)
    const catalogSegments = catalogSyntheticSpeechSegmentsService({
      masters: repository,
      segments: segmentRepository,
      profiles: new PrismaSyntheticProductionRepository(client),
      alignment: {
        readWords: async () => [
          { word: 'Primeira', startMs: 0, endMs: 700 },
          { word: 'ideia', startMs: 700, endMs: 1_100 },
          { word: 'do', startMs: 1_100, endMs: 1_300 },
          { word: 'roteiro.', startMs: 1_300, endMs: 1_900 },
          { word: 'Segunda', startMs: 2_300, endMs: 2_900 },
          { word: 'ideia', startMs: 2_900, endMs: 3_300 },
          { word: 'bem', startMs: 3_300, endMs: 3_500 },
          { word: 'forte.', startMs: 3_500, endMs: 3_900 },
        ],
      },
      createId: ({ blockId, occurrence }) => `segment-${blockId}-${occurrence}`,
    })
    const blocks = [
      { blockId: 'block-1', exactText: 'Primeira ideia do roteiro.', occurrence: 1 },
      { blockId: 'block-2', exactText: 'Segunda ideia bem forte.', occurrence: 1 },
    ]
    const catalogued = await catalogSegments({ workspaceId, masterId: 'master-1', blocks, actor })
    assert.equal(catalogued.replayed, false)
    assert.equal(catalogued.segments.length, 2)
    assert.deepEqual(catalogued.segments.map((segment) => [segment.startMs, segment.endMs]), [[0, 1_900], [2_300, 3_900]])
    assert.equal(catalogued.segments[0].audioArtifactId, 'master-audio')
    assert.equal(catalogued.segments[0].videoArtifactId, 'master-normalized')
    assert.equal(catalogued.segments[0].identity.profileVersion, 1)
    assert.equal(catalogued.segments[0].masterHash, created.value.master.masterHash)

    // Re-cataloguing the same master returns the stored rows, never duplicates.
    const recatalogued = await catalogSegments({ workspaceId, masterId: 'master-1', blocks, actor })
    assert.equal(recatalogued.replayed, true)
    assert.deepEqual(recatalogued.segments, catalogued.segments)
    assert.equal(await client.v2SyntheticSpeechSegment.count({ where: { workspaceId } }), 2)

    assert.equal((await segmentRepository.search({ workspaceId, text: 'segunda ideia', limit: 10 })).length, 1)
    assert.equal((await segmentRepository.search({ workspaceId, locale: 'pt-BR', limit: 10 })).length, 2)
    assert.equal((await segmentRepository.search({ workspaceId: foreignWorkspaceId, limit: 10 })).length, 0)

    // A segment row edited behind the application fails closed.
    await client.v2SyntheticSpeechSegment.update({ where: { id: 'segment-block-1-1' }, data: { endMs: 2_100 } })
    await assert.rejects(segmentRepository.read({ workspaceId, segmentId: 'segment-block-1-1' }), /hash does not match/)

    await client.v2SyntheticMasterAsset.update({ where: { id: 'master-1' }, data: { masterJson: '{not json' } })
    await assert.rejects(repository.read({ workspaceId, masterId: 'master-1' }), /JSON is invalid/)
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
