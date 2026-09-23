import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateSyntheticMasterReuseProductionAlignmentHash,
  prepareCanonicalSyntheticMasterReuseService,
} from '../../src/v2/application/prepare-synthetic-master-reuse.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { calculateSyntheticCacheKey } from '../../src/v2/domain/synthetic-cache-identity.ts'
import { assertSyntheticMasterConsumptionIntegrity } from '../../src/v2/domain/synthetic-master-consumption.ts'

const hash = (character) => character.repeat(64)
const openedAt = '2029-06-01T00:00:00.000Z'
const committedAt = '2029-06-01T00:00:01.000Z'

function fixture() {
  const alignment = Object.freeze([
    Object.freeze({ text: 'Mensagem completa.', startMs: 0, endMs: 4_000 }),
  ])
  const cacheSubject = Object.freeze({
    operation: 'audio-avatar',
    locale: 'pt-BR',
    avatar: Object.freeze({
      adapterId: 'heygen-v3',
      adapterVersion: '3.0.0',
      avatarIdentityRef: 'avatar-full-master',
      presenterVersion: 1,
      modelRef: 'avatar-model-1',
      outputFormat: 'mp4',
      audioChecksum: hash('a'),
      renderConfigHash: hash('b'),
      direction: null,
      background: null,
    }),
  })
  const providerOriginal = Object.freeze({
    role: 'provider-original', artifactId: 'artifact-master-video', sha256: hash('c'),
    byteSize: 1_024, mediaType: 'video', container: 'mp4',
  })
  const finalAudio = Object.freeze({
    role: 'final-audio', artifactId: 'artifact-master-audio', sha256: hash('a'),
    byteSize: 512, mediaType: 'audio', container: 'wav',
  })
  const alignmentArtifact = Object.freeze({
    role: 'alignment', artifactId: 'artifact-master-alignment', sha256: hash('d'),
    byteSize: 256, mediaType: 'data', container: 'json',
  })
  const profile = Object.freeze({
    id: 'presenter-full-master', version: 1, snapshotHash: hash('e'),
    actorIdentityId: 'actor-full-master',
    avatar: Object.freeze({ adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar-full-master' }),
    voice: Object.freeze({ id: 'voice-full-master', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' }),
    defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
    consent: Object.freeze({
      id: 'consent-full-master', evidenceArtifactId: 'artifact-consent', evidenceSha256: hash('f'),
      snapshotHash: hash('1'), granted: true, allowedUses: Object.freeze(['ads']),
      allowedMarkets: Object.freeze(['BRA']), allowedLocales: Object.freeze(['pt-BR']),
      allowedOperations: Object.freeze(['audio-avatar']), expiresAt: '2030-01-01T00:00:00.000Z',
    }),
  })
  const sourceJob = Object.freeze({
    id: 'provider-job-full-master', workspaceId: 'workspace-master-reuse', projectId: 'project-source-a',
    originProjectVersionId: 'project-version-source-a', operation: 'audio-avatar',
    adapterId: 'heygen-v3', adapterVersion: '3.0.0', input: Object.freeze({ aspectRatio: '9:16' }),
    inputHash: hash('2'), authorization: Object.freeze({
      id: 'authorization-full-master', profileSnapshotId: 'presenter-full-master:v1',
      profileSnapshotHash: profile.snapshotHash, artifactDecisions: Object.freeze([]),
      evaluatedAt: openedAt, expiresAt: '2030-01-01T00:00:00.000Z', authorizationHash: hash('3'),
    }),
    idempotencyKey: 'provider-job-full-master-key', attempt: 1, status: 'approved',
    providerJobId: 'provider-reference-full-master', resultArtifact: Object.freeze({
      artifactId: providerOriginal.artifactId, artifactSha256: providerOriginal.sha256,
      mediaType: 'video', byteSize: providerOriginal.byteSize,
    }),
    criticResultHash: hash('4'), createdAt: openedAt, updatedAt: committedAt, jobHash: hash('5'),
  })
  const master = Object.freeze({
    schemaVersion: 'synthetic-master-asset/v1', id: 'synthetic-master-source-a',
    workspaceId: 'workspace-master-reuse', projectId: 'project-source-a',
    projectVersionId: 'project-version-source-a', profileId: profile.id,
    profileSnapshotId: sourceJob.authorization.profileSnapshotId, profileVersion: profile.version,
    consentSnapshotHash: profile.consent.snapshotHash, authorizationHash: sourceJob.authorization.authorizationHash,
    rightsSnapshotId: 'rights-full-master', artifacts: Object.freeze([providerOriginal, finalAudio, alignmentArtifact]),
    scriptText: 'Mensagem completa.', scriptHash: hash('6'), alignmentHash: hash('7'), locale: 'pt-BR',
    durationMs: 4_000, audioDurationMs: 4_000, videoDurationMs: 4_000,
    provenance: Object.freeze({
      adapterId: 'heygen-v3', adapterVersion: '3.0.0', capability: 'audio-avatar',
      modelRef: 'avatar-model-1', adapterConfigHash: hash('8'), providerJobId: sourceJob.id,
      providerJobRef: sourceJob.providerJobId,
    }),
    cost: Object.freeze({ currency: 'USD', minorUnits: 150, latencyMs: 4_000 }),
    critic: Object.freeze({ reportId: 'critic-report-full-master', reportHash: sourceJob.criticResultHash, decision: 'approved' }),
    lineage: Object.freeze(['generation-full-master']), createdAt: openedAt, masterHash: hash('9'),
  })
  const plan = Object.freeze({
    schemaVersion: 'synthetic-edit-plan/v1', policyVersion: 'synthetic-presenter-policy/v1',
    id: 'production-run-consumer-b', workspaceId: master.workspaceId, projectId: 'project-consumer-b',
    projectVersionId: 'project-version-consumer-b', mode: 'synthetic-presenter', hasRealPerson: false,
    durationMs: master.durationMs, use: 'ads', market: 'BRA', locale: master.locale, profile,
    audio: Object.freeze({
      id: 'asset-audio', artifactId: finalAudio.artifactId, artifactKey: 'masters/audio.wav',
      kind: 'audio', sha256: finalAudio.sha256, byteSize: finalAudio.byteSize,
      durationMs: master.durationMs, locale: master.locale, scriptHash: master.scriptHash, alignment,
    }),
    blocks: Object.freeze([Object.freeze({
      id: 'block-full-master', text: master.scriptText, rangeMs: Object.freeze([0, master.durationMs]),
      cacheKey: calculateSyntheticCacheKey(cacheSubject), providerJobId: sourceJob.id,
      audioSha256: finalAudio.sha256,
      artifact: Object.freeze({
        id: 'asset-video', artifactId: providerOriginal.artifactId, artifactKey: 'masters/video.mp4',
        kind: 'video', sha256: providerOriginal.sha256, byteSize: providerOriginal.byteSize,
      }),
      critic: Object.freeze({ id: master.critic.reportId, resultHash: master.critic.reportHash, status: 'approved' }),
    })]),
    bRoll: Object.freeze([]), overlays: Object.freeze([]), captions: Object.freeze([]),
    disclosure: profile.disclosure,
    authorization: Object.freeze({
      id: 'authorization-consumer-b', authorizationHash: hash('a'), outcome: 'allowed',
      use: 'ads', market: 'BRA', locale: 'pt-BR', syntheticOperations: Object.freeze(['audio-avatar']),
      artifactIds: Object.freeze([finalAudio.artifactId, providerOriginal.artifactId]),
      decisions: Object.freeze([]), evaluatedAt: openedAt, expiresAt: '2030-01-01T00:00:00.000Z',
    }),
    planHash: hash('b'), createdAt: committedAt,
  })
  return { alignment, cacheSubject, providerOriginal, finalAudio, alignmentArtifact, sourceJob, master, plan }
}

test('canonical full-master reuse derives the hit and seals the cross-project consumption', async () => {
  const value = fixture()
  const calls = []
  const repository = {
    async resolveCanonicalSource(input) {
      calls.push(input)
      return Object.freeze({
        master: value.master,
        sourceJob: value.sourceJob,
        providerOriginal: value.providerOriginal,
        finalAudio: value.finalAudio,
        alignment: value.alignmentArtifact,
        cacheSubject: value.cacheSubject,
        productionAlignmentHash: calculateSyntheticMasterReuseProductionAlignmentHash(value.alignment),
        currentAuthorityValid: true,
      })
    },
  }
  const prepare = prepareCanonicalSyntheticMasterReuseService({
    repository,
    clock: () => new Date(committedAt),
    createDecisionId: () => 'cache-decision-consumer-b',
    createConsumptionId: () => 'master-consumption-consumer-b',
  })
  const result = await prepare({
    workspaceId: value.plan.workspaceId,
    consumerProjectId: value.plan.projectId,
    consumerProjectVersionId: value.plan.projectVersionId,
    plan: value.plan,
    observationOpenedAt: openedAt,
  })
  assert.ok(result)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sourceProviderJobId, value.sourceJob.id)
  assert.equal(calls[0].sourceArtifactId, value.providerOriginal.artifactId)
  assert.equal(result.decision.projectId, value.plan.projectId)
  assert.equal(result.decision.outcome, 'hit')
  assert.equal(result.decision.candidateMasterId, value.master.id)
  assert.equal(result.decision.candidateGenerationId, null)
  assert.equal(result.decision.avoidedCostMinorUnits, value.master.cost.minorUnits)
  assert.equal(result.consumption.productionRunId, value.plan.id)
  assert.equal(result.consumption.sourceMasterId, value.master.id)
  assert.equal(result.consumption.cacheDecisionHash, result.decision.decisionHash)
  assert.equal(assertSyntheticMasterConsumptionIntegrity(result.consumption), result.consumption)

  const zeroCost = await prepareCanonicalSyntheticMasterReuseService({
    repository: {
      async resolveCanonicalSource() {
        return Object.freeze({
          master: Object.freeze({ ...value.master, cost: Object.freeze({ ...value.master.cost, minorUnits: 0 }) }),
          sourceJob: value.sourceJob,
          providerOriginal: value.providerOriginal,
          finalAudio: value.finalAudio,
          alignment: value.alignmentArtifact,
          cacheSubject: value.cacheSubject,
          productionAlignmentHash: calculateSyntheticMasterReuseProductionAlignmentHash(value.alignment),
          currentAuthorityValid: true,
        })
      },
    },
    clock: () => new Date(committedAt),
    createDecisionId: () => 'cache-decision-controlled-source',
    createConsumptionId: () => 'master-consumption-controlled-source',
  })({
    workspaceId: value.plan.workspaceId,
    consumerProjectId: value.plan.projectId,
    consumerProjectVersionId: value.plan.projectVersionId,
    plan: value.plan,
    observationOpenedAt: openedAt,
  })
  assert.equal(zeroCost?.decision.avoidedCostMinorUnits, 0, 'controlled or free source cost must not block proven reuse')

  assert.throws(
    () => assertSyntheticMasterConsumptionIntegrity({ ...result.consumption, productionPlanHash: hash('c') }),
    (error) => error?.code === 'PERSISTENCE_CONFLICT',
  )
  for (const corruptedBody of [
    { ...result.consumption, sourceProjectId: result.consumption.consumerProjectId },
    { ...result.consumption, observationOpenedAt: 'not-an-instant' },
    { ...result.consumption, schemaVersion: 'synthetic-master-consumption/v0' },
  ]) {
    const { consumptionHash: _oldHash, ...body } = corruptedBody
    assert.throws(
      () => assertSyntheticMasterConsumptionIntegrity({
        ...corruptedBody,
        consumptionHash: calculateCanonicalHash(body),
      }),
      (error) => error?.code === 'PERSISTENCE_CONFLICT',
    )
  }
  assert.throws(
    () => assertSyntheticMasterConsumptionIntegrity({ ...result.consumption, invented: 'field' }),
    (error) => error?.code === 'PERSISTENCE_CONFLICT',
  )
})

test('reuse stays absent for a partial plan and fails closed when the canonical cache identity diverges', async () => {
  const value = fixture()
  const repository = {
    async resolveCanonicalSource() {
      return Object.freeze({
        master: value.master, sourceJob: value.sourceJob,
        providerOriginal: value.providerOriginal, finalAudio: value.finalAudio,
        alignment: value.alignmentArtifact, cacheSubject: value.cacheSubject,
        productionAlignmentHash: calculateSyntheticMasterReuseProductionAlignmentHash(value.alignment),
        currentAuthorityValid: true,
      })
    },
  }
  const prepare = prepareCanonicalSyntheticMasterReuseService({
    repository, clock: () => new Date(committedAt),
    createDecisionId: () => 'cache-decision-consumer-b',
    createConsumptionId: () => 'master-consumption-consumer-b',
  })
  assert.equal(await prepare({
    workspaceId: value.plan.workspaceId, consumerProjectId: value.plan.projectId,
    consumerProjectVersionId: value.plan.projectVersionId,
    plan: { ...value.plan, blocks: [{ ...value.plan.blocks[0], rangeMs: [0, 2_000] }] },
    observationOpenedAt: openedAt,
  }), null)
  await assert.rejects(
    prepare({
      workspaceId: value.plan.workspaceId, consumerProjectId: value.plan.projectId,
      consumerProjectVersionId: value.plan.projectVersionId,
      plan: { ...value.plan, blocks: [{ ...value.plan.blocks[0], cacheKey: hash('f') }] },
      observationOpenedAt: openedAt,
    }),
    (error) => error?.code === 'PRECONDITION_REQUIRED',
  )
})

test('a project using its own promoted master stays on the normal production path', async () => {
  const value = fixture()
  const ownPlan = Object.freeze({
    ...value.plan,
    projectId: value.master.projectId,
    projectVersionId: value.master.projectVersionId,
  })
  const prepare = prepareCanonicalSyntheticMasterReuseService({
    repository: {
      async resolveCanonicalSource() {
        return Object.freeze({
          master: value.master,
          sourceJob: value.sourceJob,
          providerOriginal: value.providerOriginal,
          finalAudio: value.finalAudio,
          alignment: value.alignmentArtifact,
          cacheSubject: value.cacheSubject,
          productionAlignmentHash: calculateSyntheticMasterReuseProductionAlignmentHash(value.alignment),
          currentAuthorityValid: true,
        })
      },
    },
    clock: () => new Date(committedAt),
    createDecisionId: () => 'cache-decision-own-project',
    createConsumptionId: () => 'master-consumption-own-project',
  })
  assert.equal(await prepare({
    workspaceId: ownPlan.workspaceId,
    consumerProjectId: ownPlan.projectId,
    consumerProjectVersionId: ownPlan.projectVersionId,
    plan: ownPlan,
    observationOpenedAt: openedAt,
  }), null)
})
