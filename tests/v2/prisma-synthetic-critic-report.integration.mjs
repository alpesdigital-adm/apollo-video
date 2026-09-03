import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const workspaceId = 'critic-report-int-workspace'
const foreignWorkspaceId = 'critic-report-int-foreign'
const clientId = 'critic-report-int-client'
const credentialId = 'critic-report-int-credential'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-05-01T00:00:00.000Z') + second * 1_000).toISOString()

test('T-FR-106 synthetic critic reports persist transactionally, stay queryable and fail closed on PostgreSQL', {
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
    const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { registerSyntheticPresenterProfileService } = await import('../../src/v2/application/synthetic-production.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { createSyntheticCriticReport } = await import('../../src/v2/domain/synthetic-critic-report.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { PrismaSyntheticCriticReportRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-critic-report-repository.ts')

    const workspaces = new PrismaWorkspaceRepository(client)
    for (const id of [workspaceId, foreignWorkspaceId]) {
      await workspaces.create(createWorkspace({ id, slug: id, name: `Critic ${id}`, status: 'active', createdAt: at(0) }))
    }

    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: clientId, credentialId, workspaceId, name: 'Critic client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({
      ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
    })

    let entity = 0
    let event = 0
    const project = await createProjectService({
      repository: new PrismaProjectCreationRepository(client), clock: () => new Date(at(0)),
      createId: (kind) => `${kind}-critic-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(800_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Crítica persistida', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'critic-project' } })
    const projectId = project.project.id
    const projectVersionId = project.version.id

    // The bytes the reports point at, plus the consent evidence the presenter
    // snapshot needs.
    const artifacts = {
      'critic-video': ['video', 'mp4', hash('a')],
      'critic-video-b': ['video', 'mp4', hash('b')],
      'critic-audio': ['audio', 'wav', hash('c')],
      'critic-alignment': ['data', 'json', hash('d')],
      'critic-consent': ['data', 'json', hash('e')],
    }
    for (const [id, [mediaType, container, sha256]] of Object.entries(artifacts)) {
      await client.v2MediaArtifact.create({
        data: {
          id, workspaceId, artifactKey: `critic/${id}.${container}`, sha256,
          byteSize: 4_096n, mediaType, container, status: 'available', createdAt: new Date(at(0)),
        },
      })
    }

    const profile = await registerSyntheticPresenterProfileService({
      repository: new PrismaSyntheticProductionRepository(client),
      artifacts: new PrismaMediaArtifactRepository(client),
      clock: () => new Date(at(0)),
    })({
      workspaceId, profileId: 'critic-presenter', version: 1, actorIdentityId: 'critic-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.1.0', identityRef: 'avatar_critic' },
      voice: { id: 'voice_critic', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: 'critic-consent-v1', evidenceArtifactId: 'critic-consent', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      },
      actor, idempotencyKey: 'critic-profile-v1',
    })
    const profileSnapshotId = profile.profile.profileSnapshotId

    // The approved block the verdict is about.
    await client.v2SyntheticScriptPlan.create({
      data: {
        id: 'critic-plan', workspaceId, projectId, schemaVersion: 'synthetic-script-plan/v1',
        requestFingerprint: hash('1'), idempotencyKey: 'critic-plan-key', createdByClientId: clientId,
        actorContextHash: auditContext.contextHash, createdAt: new Date(at(0)), updatedAt: new Date(at(0)),
      },
    })
    await client.v2SyntheticScriptPlanVersion.create({
      data: {
        id: 'critic-plan-v1', planId: 'critic-plan', workspaceId, projectId, sequence: 1,
        projectVersionId, profileSnapshotId, schemaVersion: 'synthetic-script-plan-version/v1',
        locale: 'pt-BR', segmentationVersion: 'synthetic-script-segmentation/v1',
        scriptHash: hash('2'), commandType: 'create-plan', blockSequenceJson: '["critic-block","critic-block-2"]',
        impactJson: '{}', commandImpactHash: hash('3'), planVersionHash: hash('4'),
        requestFingerprint: hash('1'), idempotencyKey: 'critic-plan-version-key',
        createdByClientId: clientId, actorContextHash: auditContext.contextHash, createdAt: new Date(at(0)),
      },
    })
    for (const [blockId, occurrence] of [['critic-block', 1], ['critic-block-2', 2]]) {
      await client.v2SyntheticScriptBlock.create({
        data: {
          id: blockId, workspaceId, projectId, planId: 'critic-plan', schemaVersion: 'synthetic-script-block/v1',
          exactText: `Bloco ${occurrence} do roteiro aprovado.`, normalizedTextHash: hash('5'), locale: 'pt-BR',
          occurrence, createdInVersionId: 'critic-plan-v1', originKind: 'initial-segmentation',
          blockHash: hash('6'), createdAt: new Date(at(0)),
        },
      })
    }

    const evaluators = [
      { id: 'ffprobe-media-integrity', version: '1.0.0', kind: 'measured', scope: 'timeline and signal read from the artifact' },
      { id: 'alignment-pronunciation', version: '1.0.0', kind: 'measured', scope: 'spoken words compared to the approved script' },
      { id: 'controlled-deterministic-probe', version: '1.0.0', kind: 'controlled', scope: 'deterministic stand-in, not production visual validation' },
    ]
    const measured = (dimension, evaluatorId, value, unit, threshold) => ({
      dimension, status: 'measured', evaluatorId, value, unit, threshold,
      confidence: 1, evidenceRefs: [`artifact://critic-video`], range: null, note: null,
    })
    const unavailable = (dimension, note) => ({
      dimension, status: 'unavailable', evaluatorId: null, value: null, unit: null,
      threshold: null, confidence: null, evidenceRefs: [], range: null, note,
    })
    const measurements = [
      measured('temporal-integrity', 'ffprobe-media-integrity', 0, 'ms-drift', 34),
      measured('audiovisual-integrity', 'ffprobe-media-integrity', 1, 'live-signal', 1),
      measured('pronunciation', 'alignment-pronunciation', 0, 'word-deviations', 0),
      measured('lip-sync', 'controlled-deterministic-probe', 0, 'ms-av-offset', 34),
      measured('identity', 'controlled-deterministic-probe', 1, 'identity-ref-match', 1),
      unavailable('continuity', 'this is the first approved block of the take'),
      unavailable('visual-artifacts', 'no visual artifact detector is deployed'),
      unavailable('framing', 'no framing model is deployed'),
      unavailable('eyes', 'no eye model is deployed'),
      unavailable('teeth', 'no teeth model is deployed'),
      unavailable('hands', 'no hand model is deployed'),
    ]
    const report = (overrides = {}) => createSyntheticCriticReport({
      id: 'critic-report-1', workspaceId, projectId, blockId: 'critic-block',
      capability: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.1.0',
      artifactId: 'critic-video', artifactSha256: artifacts['critic-video'][2],
      audioArtifactId: 'critic-audio', alignmentArtifactId: 'critic-alignment',
      scriptHash: hash('7'), profileSnapshotId, expectedIdentityRef: 'avatar_critic',
      evaluators, measurements, issues: [],
      decision: 'approved', recommendedAction: 'none',
      thresholdsVersion: 'synthetic-critic-thresholds/audio-avatar/heygen-v3/v1',
      decidedAt: at(10),
      ...overrides,
    })

    const repository = new PrismaSyntheticCriticReportRepository(client)

    // 1. The verdict and its whole projection commit together.
    const recorded = await repository.record({ report: report() })
    assert.equal(recorded.replayed, false)
    assert.equal(await client.v2SyntheticCriticMeasurement.count({ where: { reportId: 'critic-report-1' } }), 11)
    assert.equal(await client.v2SyntheticCriticEvaluator.count({ where: { reportId: 'critic-report-1' } }), 3)
    assert.equal(await client.v2SyntheticCriticIssue.count({ where: { reportId: 'critic-report-1' } }), 0)

    // 2. Recording the same verdict again is idempotent by content address.
    const replay = await repository.record({ report: report() })
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.value, recorded.value)
    assert.equal(await client.v2SyntheticCriticReport.count({ where: { workspaceId } }), 1)

    // 3. Reads by block, by artifact, by project and by content address.
    assert.deepEqual((await repository.read({ workspaceId, reportId: 'critic-report-1' })), recorded.value)
    assert.deepEqual(
      await repository.readByHash({ workspaceId, reportHash: recorded.value.reportHash }),
      recorded.value,
    )
    assert.equal((await repository.readByBlock({ workspaceId, blockId: 'critic-block' })).length, 1)
    assert.equal((await repository.readByArtifact({ workspaceId, artifactId: 'critic-video' })).length, 1)
    assert.equal((await repository.listByProject({ workspaceId, projectId, limit: 10 })).length, 1)
    assert.equal(
      (await repository.listByProject({ workspaceId, projectId, decision: 'rejected', limit: 10 })).length,
      0,
    )

    // 4. A rejection on a different take of the same block is a second verdict,
    //    localized on the block and carrying its own cause and action.
    const rejection = await repository.record({
      report: report({
        id: 'critic-report-2',
        artifactId: 'critic-video-b',
        artifactSha256: artifacts['critic-video-b'][2],
        blockId: 'critic-block-2',
        measurements: measurements.map((entry) =>
          entry.dimension === 'pronunciation' ? { ...entry, value: 1 } : entry),
        issues: [{
          blockId: 'critic-block-2', dimension: 'pronunciation', severity: 'blocking',
          range: { startMs: 1_100, endMs: 1_300 },
          evidence: 'word-omitted: the approved word "do" at position 2 is not in the alignment',
          action: 'retry',
        }],
        decision: 'rejected', recommendedAction: 'retry', decidedAt: at(20),
      }),
    })
    assert.equal(rejection.replayed, false)
    const issueRows = await client.v2SyntheticCriticIssue.findMany({ where: { workspaceId, blockId: 'critic-block-2' } })
    assert.equal(issueRows.length, 1)
    assert.equal(issueRows[0].action, 'retry')
    assert.equal(issueRows[0].startMs, 1_100)

    // The projection answers by dimension and by block without touching the blob.
    const pronunciationRows = await client.v2SyntheticCriticMeasurement.findMany({
      where: { workspaceId, dimension: 'pronunciation', status: 'measured' },
      orderBy: { reportId: 'asc' },
    })
    assert.deepEqual(pronunciationRows.map((row) => [row.blockId, row.value]), [
      ['critic-block', 0], ['critic-block-2', 1],
    ])
    assert.equal(
      (await client.v2SyntheticCriticMeasurement.count({
        where: { workspaceId, blockId: 'critic-block-2', status: 'unavailable' },
      })),
      6,
    )
    assert.equal(
      (await client.v2SyntheticCriticEvaluator.count({ where: { workspaceId, kind: 'controlled' } })),
      2,
    )
    assert.equal((await repository.listByProject({ workspaceId, projectId, decision: 'rejected', limit: 10 })).length, 1)

    // 5. Cross-workspace invisibility.
    assert.equal(await repository.read({ workspaceId: foreignWorkspaceId, reportId: 'critic-report-1' }), null)
    assert.equal((await repository.readByBlock({ workspaceId: foreignWorkspaceId, blockId: 'critic-block' })).length, 0)
    assert.equal((await repository.readByArtifact({ workspaceId: foreignWorkspaceId, artifactId: 'critic-video' })).length, 0)

    // 6. The database refuses a dishonest row on its own, without the
    //    application being in the loop.
    await assert.rejects(
      client.v2SyntheticCriticMeasurement.update({
        where: { reportId_dimension: { reportId: 'critic-report-1', dimension: 'eyes' } },
        data: { value: 0.99, confidence: 0.99 },
      }),
      /synthetic_critic_measurements_unmeasured_check/,
    )
    await assert.rejects(
      client.v2SyntheticCriticIssue.update({
        where: { reportId_ordinal: { reportId: 'critic-report-2', ordinal: 0 } },
        data: { action: 'none' },
      }),
      /synthetic_critic_issues_action_check/,
    )
    await assert.rejects(
      client.v2SyntheticCriticReport.update({
        where: { id: 'critic-report-1' },
        data: { recommendedAction: 'retry' },
      }),
      /synthetic_critic_reports_decision_action_check/,
    )
    await assert.rejects(
      client.v2SyntheticCriticMeasurement.update({
        where: { reportId_dimension: { reportId: 'critic-report-1', dimension: 'lip-sync' } },
        data: { evidenceRefsJson: '[]' },
      }),
      /synthetic_critic_measurements_measured_check/,
    )

    // Flipping the decision alone is not even reachable: the constraint pair
    // refuses an approval that recommends work and a rejection that recommends
    // none, so the row cannot be nudged one field at a time.
    await assert.rejects(
      client.v2SyntheticCriticReport.update({ where: { id: 'critic-report-1' }, data: { decision: 'rejected' } }),
      /synthetic_critic_reports_decision_action_check/,
    )

    // 7. Hydration fails closed when a row is edited behind the application.
    await client.v2SyntheticCriticReport.update({
      where: { id: 'critic-report-1' },
      data: { expectedIdentityRef: 'avatar_de_outra_pessoa' },
    })
    await assert.rejects(
      repository.read({ workspaceId, reportId: 'critic-report-1' }),
      /failed integrity validation/,
    )
    await client.v2SyntheticCriticReport.update({
      where: { id: 'critic-report-1' },
      data: { expectedIdentityRef: 'avatar_critic' },
    })
    assert.ok(await repository.read({ workspaceId, reportId: 'critic-report-1' }))

    await client.v2SyntheticCriticMeasurement.update({
      where: { reportId_dimension: { reportId: 'critic-report-1', dimension: 'temporal-integrity' } },
      data: { value: 900 },
    })
    await assert.rejects(
      repository.read({ workspaceId, reportId: 'critic-report-1' }),
      /temporal-integrity measurement was altered/,
    )
    await client.v2SyntheticCriticMeasurement.update({
      where: { reportId_dimension: { reportId: 'critic-report-1', dimension: 'temporal-integrity' } },
      data: { value: 0 },
    })

    await client.v2SyntheticCriticEvaluator.update({
      where: { reportId_evaluatorId: { reportId: 'critic-report-1', evaluatorId: 'controlled-deterministic-probe' } },
      data: { kind: 'measured' },
    })
    await assert.rejects(
      repository.read({ workspaceId, reportId: 'critic-report-1' }),
      /evaluator controlled-deterministic-probe was altered/,
    )
    await client.v2SyntheticCriticEvaluator.update({
      where: { reportId_evaluatorId: { reportId: 'critic-report-1', evaluatorId: 'controlled-deterministic-probe' } },
      data: { kind: 'controlled' },
    })

    await client.v2SyntheticCriticIssue.deleteMany({ where: { reportId: 'critic-report-2' } })
    await assert.rejects(
      repository.read({ workspaceId, reportId: 'critic-report-2' }),
      /issue rows do not match the report/,
    )

    await client.v2SyntheticCriticReport.update({ where: { id: 'critic-report-1' }, data: { reportJson: '{not json' } })
    await assert.rejects(repository.read({ workspaceId, reportId: 'critic-report-1' }), /JSON is invalid/)
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
