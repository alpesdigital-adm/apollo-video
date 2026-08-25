import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import {
  createSyntheticProductionRunService,
  registerSyntheticPresenterProfileService,
} from '../../src/v2/application/synthetic-production.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'

const hash = (character) => character.repeat(64)
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
      entry.profile.snapshot.id === snapshotId)?.profile ?? null
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
  return { repository, artifacts, rights, artifactRepository, rightsRepository }
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

function runRequest(profileSnapshotId) {
  return {
    workspaceId,
    projectId,
    projectVersionId,
    profileSnapshotId,
    audio: {
      artifactId: 'audio-master',
      durationMs: 2_000,
      locale: 'pt-BR',
      scriptHash: hash('e'),
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
        critic: { id: 'critic-service-one', resultHash: hash('1'), status: 'approved' },
      },
      {
        id: 'block-service-two',
        text: 'mundo',
        rangeMs: [1_000, 2_000],
        cacheKey: hash('2'),
        providerJobId: 'provider-job-service-two',
        audioSha256: hash('b'),
        artifactId: 'avatar-block-two',
        critic: { id: 'critic-service-two', resultHash: hash('3'), status: 'approved' },
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
          project: { id: projectId, workspaceId, currentVersionId: projectVersionId },
          version: { id: projectVersionId, sequence: 1, baseHash: hash('4'), createdAt: now },
          commands: [], directorRuns: [], media: [], transcripts: [], operationIds: [],
        }
      },
    },
    artifacts: dependencies.artifactRepository,
    rights: dependencies.rightsRepository,
    clock: () => new Date(now),
    createRunId: () => 'synthetic-run-service',
    createSnapshotId: () => 'snapshot-synthetic-service',
  })
  const created = await execute(runRequest(registered.profile.snapshot.id))
  assert.equal(created.run.plan.hasRealPerson, false)
  assert.equal(created.run.plan.blocks.length, 2)
  assert.equal(created.run.plan.authorization.decisions.length, 3)
  assert.equal(created.run.plan.authorization.outcome, 'allowed')
  assert.equal(dependencies.repository.runs.length, 1)
  const replay = await execute(runRequest(registered.profile.snapshot.id))
  assert.equal(replay.replayed, true)
  assert.equal(dependencies.repository.runs.length, 1)
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
          project: { id: projectId, workspaceId, currentVersionId: projectVersionId },
          version: { id: projectVersionId, sequence: 1, baseHash: hash('4'), createdAt: now },
          commands: [], directorRuns: [], media: [], transcripts: [], operationIds: [],
        }
      },
    },
    artifacts: dependencies.artifactRepository,
    rights: dependencies.rightsRepository,
    clock: () => new Date(now),
    createRunId: () => 'synthetic-run-blocked',
    createSnapshotId: () => 'snapshot-synthetic-blocked',
  })
  await assert.rejects(
    execute(runRequest(registered.profile.snapshot.id)),
    /without current compatible rights or consent/,
  )
  assert.equal(dependencies.repository.runs.length, 0)
})
