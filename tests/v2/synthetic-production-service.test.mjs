import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import {
  createSyntheticProductionRunService,
  registerSyntheticPresenterProfileService,
} from '../../src/v2/application/synthetic-production.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import {
  createSyntheticCriticReport,
  SYNTHETIC_CRITIC_DIMENSIONS,
} from '../../src/v2/domain/synthetic-critic-report.ts'
import {
  AVATAR_AUDIO_COMPARISON_POLICY_VERSION,
  createAvatarOutputSpeechEvidence,
} from '../../src/v2/domain/avatar-output-speech-evidence.ts'

const hash = (character) => character.repeat(64)
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const workspaceId = 'workspace-synthetic-service'
const projectId = 'project-synthetic-service'
const projectVersionId = 'version-synthetic-service'
const now = '2029-01-01T00:00:00.000Z'

function actor() {
  const clientId = 'client-synthetic-service'
  const credentialId = 'credential-synthetic-service'
  return Object.freeze({
    clientId,
    credentialId,
    workspaceId,
    environment: 'production',
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext: createExternalAuditContext({
      clientId,
      credentialId,
      workspaceId,
      environment: 'production',
    }),
  })
}

function artifact(id, mediaType, digest) {
  return Object.freeze({
    id,
    workspaceId,
    artifactKey: `synthetic/${id}.${mediaType === 'audio' ? 'wav' : mediaType === 'video' ? 'mp4' : 'json'}`,
    sha256: hash(digest),
    byteSize: 4_096n,
    mediaType,
    container: mediaType === 'audio' ? 'wav' : mediaType === 'video' ? 'mp4' : 'json',
    status: 'available',
    lifecycleRevision: 1,
    manifests: [],
    createdAt: now,
  })
}

function approvedRights(artifactId, sequence) {
  return createAssetRightsSnapshot({
    id: `rights-${artifactId}`,
    workspaceId,
    artifactId,
    sequence,
    draft: {
      status: 'approved',
      allowedUses: ['ads'],
      prohibitedUses: [],
      allowedMarkets: ['BRA'],
      allowedLocales: ['pt-BR'],
      allowedSyntheticOperations: ['tts', 'audio-avatar'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      consent: {
        status: 'not-required',
        allowedUses: [],
      },
    },
    createdBy: { type: 'api-client', id: 'client-synthetic-service' },
    createdAt: now,
  })
}

class MemoryRepository {
  profiles = []
  runs = []
  async findProfileReplay(input) {
    return this.profiles.find((entry) =>
      entry.workspaceId === input.workspaceId &&
      entry.actorClientId === input.actorClientId &&
      entry.actorContextHash === input.actorContextHash &&
      entry.profile.idempotencyKey === input.idempotencyKey)?.profile ?? null
  }
  async createProfile(input) {
    const profile = Object.freeze({
      snapshot: input.snapshot,
      profileSnapshotId: `${input.snapshot.id}:v${input.snapshot.version}`,
      requestFingerprint: input.requestFingerprint,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt,
    })
    this.profiles.push({
      workspaceId: input.workspaceId,
      actorClientId: input.authenticationAudit.clientId,
      actorContextHash: input.authenticationAudit.contextHash,
      profile,
    })
    return Object.freeze({ profile, replayed: false })
  }
  async readProfile({ workspaceId: requestedWorkspaceId, snapshotId }) {
    return this.profiles.find((entry) =>
      entry.workspaceId === requestedWorkspaceId &&
      (entry.profile.profileSnapshotId === snapshotId || entry.profile.snapshot.id === snapshotId))?.profile ?? null
  }
  async findRunReplay(input) {
    return this.runs.find((entry) =>
      entry.workspaceId === input.workspaceId &&
      entry.projectId === input.projectId &&
      entry.actorClientId === input.actorClientId &&
      entry.actorContextHash === input.actorContextHash &&
      entry.run.idempotencyKey === input.idempotencyKey)?.run ?? null
  }
  async createRun(input) {
    const run = Object.freeze({
      plan: input.plan,
      editPlanSnapshotId: input.editPlanSnapshot.id,
      audioMaster: input.audioMaster,
      status: 'compiled',
      requestFingerprint: input.requestFingerprint,
      idempotencyKey: input.idempotencyKey,
    })
    this.runs.push({
      workspaceId: input.plan.workspaceId,
      projectId: input.plan.projectId,
      actorClientId: input.authenticationAudit.clientId,
      actorContextHash: input.authenticationAudit.contextHash,
      run,
    })
    return Object.freeze({ run, replayed: false })
  }
  async readRun({ workspaceId: requestedWorkspaceId, projectId: requestedProjectId, runId }) {
    return this.runs.find((entry) =>
      entry.workspaceId === requestedWorkspaceId &&
      entry.projectId === requestedProjectId &&
      entry.run.plan.id === runId)?.run ?? null
  }
}

function fixture() {
  const repository = new MemoryRepository()
  const artifacts = new Map([
    ['consent-evidence', artifact('consent-evidence', 'data', 'a')],
    ['audio-master', artifact('audio-master', 'audio', 'b')],
    ['avatar-block-one', artifact('avatar-block-one', 'video', 'c')],
    ['avatar-block-two', artifact('avatar-block-two', 'video', 'd')],
  ])
  const rights = new Map([...artifacts.keys()]
    .filter((id) => id !== 'consent-evidence')
    .map((id, index) => [id, approvedRights(id, index + 1)]))
  const artifactRepository = {
    async findById(requestedWorkspaceId, artifactId) {
      return requestedWorkspaceId === workspaceId ? artifacts.get(artifactId) ?? null : null
    },
  }
  const rightsRepository = {
    async findCurrentForArtifacts(requestedWorkspaceId, artifactIds) {
      return new Map(artifactIds.map((id) => [
        id,
        requestedWorkspaceId === workspaceId ? rights.get(id) ?? null : null,
      ]))
    },
  }
  const measured = new Set(['temporal-integrity', 'audiovisual-integrity'])
  const makeReport = ({ suffix, blockId, artifactId, artifactSha256, jobId, text }) => {
    const scriptHash = sha256(text)
    const outputSpeechEvidence = createAvatarOutputSpeechEvidence({
      jobId,
      videoArtifactId: artifactId,
      videoArtifactSha256: artifactSha256,
      sourceAudioArtifactId: 'audio-master',
      sourceAudioRangeHash: sha256(`range:${suffix}`),
      policyVersion: AVATAR_AUDIO_COMPARISON_POLICY_VERSION,
      sourcePcmSha256: hash('4'), outputPcmSha256: hash('5'), sampleRateHz: 16_000,
      sourceDurationMs: 1_000, outputDurationMs: 1_000, alignedLagSamples: 0,
      comparedSampleCount: 16_000, sourceCoverageBps: 10_000, outputCoverageBps: 10_000,
      correlationBps: 10_000, normalizedErrorBps: 0,
      worstWindowCorrelationBps: 10_000, worstWindowNormalizedErrorBps: 0,
      failedWindowCount: 0, comparedWindowCount: 4, sourceRmsBps: 1_000, outputRmsBps: 1_000,
      passed: true,
      speechEvidence: {
        kind: 'controlled', evaluatorId: 'controlled-speech', evaluatorVersion: '1.0.0',
        outputTranscriptHash: scriptHash, observedIdentityRef: 'identity-ref-service',
      },
    })
    return createSyntheticCriticReport({
      id: `critic-service-${suffix}`, workspaceId, projectId, providerJobId: jobId, blockId,
      capability: 'audio-avatar', adapterId: 'controlled-avatar', adapterVersion: 'version-1',
      artifactId, artifactSha256, audioArtifactId: null, alignmentArtifactId: null,
      scriptHash, profileSnapshotId: 'presenter-service:v1', expectedIdentityRef: 'identity-ref-service',
      expectationHash: hash('9'), evaluationContextHash: sha256(`synthetic-production-service-context:${suffix}`),
      outputSpeechEvidence, outputSpeechEvidenceArtifactId: `speech-evidence-${suffix}`,
      evaluators: [{ id: 'controlled-service', version: '1.0.0', kind: 'controlled', scope: 'controlled unit fixture' }],
      measurements: SYNTHETIC_CRITIC_DIMENSIONS.map((dimension) => measured.has(dimension)
        ? { dimension, status: 'measured', evaluatorId: 'controlled-service', value: 0, unit: 'fixture-score', threshold: 0, confidence: 1, evidenceRefs: [`artifact://${artifactId}`], range: null, note: null }
        : { dimension, status: 'not-applicable', evaluatorId: null, value: null, unit: null, threshold: null, confidence: null, evidenceRefs: [], range: null, note: 'controlled fixture does not claim visual measurement' }),
      issues: [], decision: 'approved', recommendedAction: 'none',
      thresholdsVersion: 'synthetic-critic-thresholds/audio-avatar/v1', decidedAt: now,
    })
  }
  const reportValues = [
    makeReport({ suffix: 'one', blockId: 'block-service-one', artifactId: 'avatar-block-one', artifactSha256: hash('c'), jobId: 'provider-job-service-one', text: 'Olá' }),
    makeReport({ suffix: 'two', blockId: 'block-service-two', artifactId: 'avatar-block-two', artifactSha256: hash('d'), jobId: 'provider-job-service-two', text: 'mundo' }),
  ]
  const reports = new Map(reportValues.map((report) => [report.reportHash, report]))
  const criticReports = {
    async readByHash({ workspaceId: requestedWorkspaceId, reportHash }) {
      const report = reports.get(reportHash)
      return requestedWorkspaceId === workspaceId && report
        ? report
        : null
    },
  }
  const providerJobs = {
    async readById({ workspaceId: requestedWorkspaceId, jobId }) {
      const one = jobId === 'provider-job-service-one'
      const two = jobId === 'provider-job-service-two'
      if (requestedWorkspaceId !== workspaceId || (!one && !two)) return null
      const text = one ? 'Olá' : 'mundo'
      const blockId = one ? 'block-service-one' : 'block-service-two'
      const artifactId = one ? 'avatar-block-one' : 'avatar-block-two'
      const artifactSha256 = one ? hash('c') : hash('d')
      const reportHash = one ? reportValues[0].reportHash : reportValues[1].reportHash
      const range = one ? [0, 1_000] : [1_000, 2_000]
      const profileSnapshotId = repository.profiles[0]?.profile.profileSnapshotId ?? ''
      return { job: {
        id: jobId, workspaceId, projectId, originProjectVersionId: projectVersionId,
        status: 'approved', operation: 'audio-avatar',
        criticResultHash: reportHash,
        resultArtifact: { artifactId, artifactSha256 },
        authorization: { profileSnapshotId },
        input: {
          audioMasterId: 'synthetic-audio-master-service',
          audioArtifactId: 'audio-master',
          audioRange: { startMs: range[0], endMs: range[1] },
          criticBinding: { blockId, scriptText: text, scriptHash: sha256(text), profileSnapshotId },
        },
      } }
    },
  }
  const audioMasters = {
    async read({ workspaceId: requestedWorkspaceId, projectId: requestedProjectId, audioMasterId }) {
      if (requestedWorkspaceId !== workspaceId || requestedProjectId !== projectId || audioMasterId !== 'synthetic-audio-master-service') return null
      return { master: {
        id: audioMasterId,
        workspaceId,
        projectId,
        projectVersionId,
        profileSnapshotId: repository.profiles[0]?.profile.profileSnapshotId ?? '',
        source: { kind: 'tts', text: 'Olá mundo' },
        audio: { artifactId: 'audio-master', artifactSha256: hash('b'), durationMs: 2_000, locale: 'pt-BR' },
        words: [
          { word: 'Olá', startMs: 0, endMs: 1_000 },
          { word: 'mundo', startMs: 1_000, endMs: 2_000 },
        ],
        masterHash: hash('8'),
      } }
    },
  }
  return { repository, artifacts, rights, artifactRepository, rightsRepository, criticReports, providerJobs, audioMasters, reportValues }
}

async function registerProfile(dependencies) {
  return registerSyntheticPresenterProfileService({
    repository: dependencies.repository,
    artifacts: dependencies.artifactRepository,
    clock: () => new Date(now),
  })({
    workspaceId,
    profileId: 'presenter-service',
    version: 1,
    actorIdentityId: 'identity-service',
    avatar: {
      adapterId: 'controlled-avatar',
      adapterVersion: 'version-1',
      identityRef: 'identity-ref-service',
    },
    voice: {
      id: 'voice-service',
      version: 1,
      adapterId: 'controlled-tts',
      adapterVersion: 'version-1',
    },
    defaultLocale: 'pt-BR',
    status: 'active',
    disclosure: 'Conteúdo gerado com IA',
    consent: {
      id: 'consent-service',
      evidenceArtifactId: 'consent-evidence',
      granted: true,
      allowedUses: ['ads'],
      allowedMarkets: ['BRA'],
      allowedLocales: ['pt-BR'],
      allowedOperations: ['tts', 'audio-avatar'],
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    actor: actor(),
    idempotencyKey: 'profile-service-key',
  })
}

function runRequest(profileSnapshotId, reportValues) {
  return {
    workspaceId,
    projectId,
    projectVersionId,
    profileSnapshotId,
    audio: {
      artifactId: 'audio-master',
      durationMs: 2_000,
      locale: 'pt-BR',
      scriptHash: sha256('Olá mundo'),
      alignment: [
        { text: 'Olá', startMs: 0, endMs: 1_000 },
        { text: 'mundo', startMs: 1_000, endMs: 2_000 },
      ],
    },
    blocks: [
      {
        id: 'block-service-one',
        text: 'Olá',
        rangeMs: [0, 1_000],
        cacheKey: hash('f'),
        providerJobId: 'provider-job-service-one',
        audioSha256: hash('b'),
        artifactId: 'avatar-block-one',
        critic: { id: 'critic-service-one', resultHash: reportValues[0].reportHash, status: 'approved' },
      },
      {
        id: 'block-service-two',
        text: 'mundo',
        rangeMs: [1_000, 2_000],
        cacheKey: hash('2'),
        providerJobId: 'provider-job-service-two',
        audioSha256: hash('b'),
        artifactId: 'avatar-block-two',
        critic: { id: 'critic-service-two', resultHash: reportValues[1].reportHash, status: 'approved' },
      },
    ],
    captions: true,
    use: 'ads',
    market: 'BRA',
    actor: actor(),
    idempotencyKey: 'synthetic-run-service-key',
  }
}

test('T-FR-092 persists authoritative profile and complete synthetic EditPlan', async () => {
  const dependencies = fixture()
  const registered = await registerProfile(dependencies)
  assert.equal(registered.profile.snapshot.consent.evidenceSha256, hash('a'))
  const execute = createSyntheticProductionRunService({
    repository: dependencies.repository,
    projects: {
      async read() {
        return {
          project: { id: projectId, workspaceId, currentVersionId: projectVersionId, createdAt: now },
          version: { id: projectVersionId, sequence: 1, baseHash: hash('4'), createdAt: now },
          commands: [], directorRuns: [], media: [], transcripts: [], operationIds: [],
        }
      },
    },
    artifacts: dependencies.artifactRepository,
    rights: dependencies.rightsRepository,
    criticReports: dependencies.criticReports,
    providerJobs: dependencies.providerJobs,
    audioMasters: dependencies.audioMasters,
    scriptPlans: { async readVersion() { return null } },
    prepareCanonicalReuse: async () => null,
    clock: () => new Date(now),
    createRunId: () => 'synthetic-run-service',
    createSnapshotId: () => 'snapshot-synthetic-service',
  })
  const created = await execute(runRequest(registered.profile.profileSnapshotId, dependencies.reportValues))
  assert.equal(created.run.plan.hasRealPerson, false)
  assert.equal(created.run.plan.blocks.length, 2)
  assert.equal(created.run.plan.authorization.decisions.length, 3)
  assert.equal(created.run.plan.authorization.outcome, 'allowed')
  assert.equal(dependencies.repository.runs.length, 1)
  const replay = await execute(runRequest(registered.profile.profileSnapshotId, dependencies.reportValues))
  assert.equal(replay.replayed, true)
  assert.equal(dependencies.repository.runs.length, 1)
})

test('W24.1 refuses synthetic block text and provider-job lineage swaps', async () => {
  const dependencies = fixture()
  const registered = await registerProfile(dependencies)
  const execute = createSyntheticProductionRunService({
    repository: dependencies.repository,
    projects: { async read() { return {
      project: { id: projectId, workspaceId, currentVersionId: projectVersionId, createdAt: now },
      version: { id: projectVersionId, sequence: 1, baseHash: hash('4'), createdAt: now },
      commands: [], directorRuns: [], media: [], transcripts: [], operationIds: [],
    } } },
    artifacts: dependencies.artifactRepository,
    rights: dependencies.rightsRepository,
    criticReports: dependencies.criticReports,
    providerJobs: dependencies.providerJobs,
    audioMasters: dependencies.audioMasters,
    scriptPlans: { async readVersion() { return null } },
    prepareCanonicalReuse: async () => null,
    clock: () => new Date(now),
    createRunId: () => 'synthetic-run-lineage-negative',
    createSnapshotId: () => 'snapshot-synthetic-lineage-negative',
  })
  const base = runRequest(registered.profile.profileSnapshotId, dependencies.reportValues)
  await assert.rejects(
    execute({ ...base, blocks: [{ ...base.blocks[0], text: 'texto trocado' }, base.blocks[1]], idempotencyKey: 'synthetic-run-text-swapped' }),
    /exact lineage/,
  )
  await assert.rejects(
    execute({ ...base, blocks: [{ ...base.blocks[0], providerJobId: base.blocks[1].providerJobId }, base.blocks[1]], idempotencyKey: 'synthetic-run-job-swapped' }),
    /exact lineage/,
  )
  assert.equal(dependencies.repository.runs.length, 0)
})

test('T-FR-092 blocks before persistence when one generated artifact loses rights', async () => {
  const dependencies = fixture()
  const registered = await registerProfile(dependencies)
  dependencies.rights.delete('avatar-block-two')
  const execute = createSyntheticProductionRunService({
    repository: dependencies.repository,
    projects: {
      async read() {
        return {
          project: { id: projectId, workspaceId, currentVersionId: projectVersionId, createdAt: now },
          version: { id: projectVersionId, sequence: 1, baseHash: hash('4'), createdAt: now },
          commands: [], directorRuns: [], media: [], transcripts: [], operationIds: [],
        }
      },
    },
    artifacts: dependencies.artifactRepository,
    rights: dependencies.rightsRepository,
    criticReports: dependencies.criticReports,
    providerJobs: dependencies.providerJobs,
    audioMasters: dependencies.audioMasters,
    scriptPlans: { async readVersion() { return null } },
    prepareCanonicalReuse: async () => null,
    clock: () => new Date(now),
    createRunId: () => 'synthetic-run-blocked',
    createSnapshotId: () => 'snapshot-synthetic-blocked',
  })
  await assert.rejects(
    execute(runRequest(registered.profile.profileSnapshotId, dependencies.reportValues)),
    /without current compatible rights or consent/,
  )
  assert.equal(dependencies.repository.runs.length, 0)
})
