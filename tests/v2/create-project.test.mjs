import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createProjectService } from '../../src/v2/application/create-project.ts'
import { duplicateProjectService } from '../../src/v2/application/duplicate-project.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createProjectCreationCommand } from '../../src/v2/domain/project-creation-command.ts'
import { createWorkspace } from '../../src/v2/domain/workspace.ts'
import { PrismaProjectCreationRepository } from '../../src/v2/infrastructure/prisma/project-creation-repository.ts'

class InMemoryProjectCreationRepository {
  constructor(workspaces) {
    this.workspaces = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
    this.records = new Map()
    this.events = new Map()
    this.lastBundle = undefined
  }

  async createOrReplay(bundle) {
    const workspace = this.workspaces.get(bundle.project.workspaceId)
    if (!workspace || workspace.status !== 'active') {
      throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
    }

    const identity = [
      bundle.idempotency.workspaceId,
      bundle.idempotency.clientId,
      bundle.idempotency.key,
    ].join(':')
    const existing = this.records.get(identity)

    if (existing) {
      if (existing.fingerprint !== bundle.idempotency.requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was already used with a different request',
        )
      }
      return { ...existing.result, replayed: true }
    }

    this.lastBundle = bundle
    for (const event of bundle.events) {
      if (this.events.has(event.id)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Duplicate public event')
      }
      this.events.set(event.id, event)
    }
    const result = {
      project: bundle.project,
      version: bundle.version,
      replayed: false,
    }
    this.records.set(identity, {
      fingerprint: bundle.idempotency.requestFingerprint,
      result,
    })
    return result
  }
}

class InMemoryProjectDuplicationRepository {
  constructor(source) {
    this.source = source
    this.record = undefined
    this.lastBundle = undefined
    this.sourceReads = 0
  }

  async findIdempotent(input) {
    if (!this.record || this.record.key !== input.key) return null
    if (this.record.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was already used with a different duplication request',
      )
    }
    return { ...this.record.result, replayed: true }
  }

  async readSource(input) {
    this.sourceReads += 1
    return input.workspaceId === this.source.project.workspaceId &&
      input.projectId === this.source.project.id
      ? this.source
      : null
  }

  async duplicateOrReplay(bundle) {
    this.lastBundle = bundle
    const result = {
      project: bundle.project,
      version: bundle.version,
      sharedArtifactIds: [...new Set(bundle.media.map((item) => item.artifactId))],
      copiedBytes: 0,
      replayed: false,
    }
    this.record = {
      key: bundle.idempotency.key,
      requestFingerprint: bundle.idempotency.requestFingerprint,
      result,
    }
    return result
  }
}

function createFixture() {
  const workspace = createWorkspace({
    id: 'workspace-1',
    slug: 'alpes-digital',
    name: '  Alpes   Digital ',
    status: 'active',
    createdAt: '2026-07-12T13:00:00.000Z',
  })
  const repository = new InMemoryProjectCreationRepository([workspace])
  const counters = new Map()
  let eventCounter = 0
  const service = createProjectService({
    repository,
    clock: () => new Date('2026-07-12T13:01:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
    createEventId: () => {
      eventCounter += 1
      return `00000000-0000-4000-8000-${String(eventCounter).padStart(12, '0')}`
    },
  })

  return { workspace, repository, service }
}

function actor({
  clientId = 'client-1',
  credentialId = 'credential-1',
  workspaceId = 'workspace-1',
  scopes = ['projects:write'],
} = {}) {
  const auditContext = createExternalAuditContext({
    clientId,
    credentialId,
    workspaceId,
    environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(scopes),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

async function createDuplicationFixture() {
  const creation = createFixture()
  const source = await creation.service(request())
  const repository = new InMemoryProjectDuplicationRepository({
    project: source.project,
    version: source.version,
    media: [{
      artifactId: 'artifact-source-1',
      role: 'source-master',
      originalFileName: 'master.mp4',
    }],
  })
  const counters = new Map()
  const service = duplicateProjectService({
    repository,
    clock: () => new Date('2026-07-12T13:03:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-duplicate-${next}`
    },
  })
  const duplicateRequest = (overrides = {}) => ({
    workspaceId: 'workspace-1',
    projectId: source.project.id,
    expectedVersionId: source.version.id,
    expectedVersionHash: source.version.baseHash,
    actor: actor(),
    idempotency: { clientId: 'client-1', key: 'duplicate-project-1' },
    ...overrides,
  })
  return { repository, service, source, duplicateRequest }
}

function request(overrides = {}) {
  return {
    workspaceId: 'workspace-1',
    name: '  Campanha   Julho  ',
    objective: 'discovery',
    format: '9:16',
    briefing: 'Público: gestores. Oferta: conteúdo. Tom: direto e natural.',
    actor: actor(),
    idempotency: { clientId: 'client-1', key: 'create-project-1' },
    ...overrides,
  }
}

test('workspace aggregate normalizes stable public fields', () => {
  const { workspace } = createFixture()

  assert.equal(workspace.slug, 'alpes-digital')
  assert.equal(workspace.name, 'Alpes Digital')
  assert.ok(Object.isFrozen(workspace))
})

test('create project persists an initial version and immutable snapshots', async () => {
  const { repository, service } = createFixture()
  const result = await service(request())

  assert.equal(result.replayed, false)
  assert.equal(result.project.name, 'Campanha Julho')
  assert.equal(result.project.status, 'draft')
  assert.equal(result.project.objective, 'discovery')
  assert.equal(result.project.format, '9:16')
  assert.equal(result.project.locale, 'pt-BR')
  assert.equal(result.project.currentVersionId, result.version.id)
  assert.equal(result.version.sequence, 1)
  assert.equal(repository.lastBundle.snapshots.length, 3)
  assert.deepEqual(
    repository.lastBundle.snapshots.map((snapshot) => snapshot.kind),
    ['brief', 'edit-plan', 'policies'],
  )
  assert.ok(repository.lastBundle.snapshots.every((snapshot) => snapshot.contentHash.length === 64))
  assert.equal(result.version.snapshotRefs.brief, repository.lastBundle.snapshots[0].id)
  assert.equal(result.version.snapshotRefs.editPlan, repository.lastBundle.snapshots[1].id)
  const brief = JSON.parse(repository.lastBundle.snapshots[0].contentJson)
  assert.equal(brief.productionBrief.ownerInput.trust, 'owner-authorized')
  assert.equal(brief.outputSpec.aspectRatio, '9:16')
  assert.equal(brief.objective, 'discovery')
  assert.deepEqual(
    repository.lastBundle.events.map((event) => event.type),
    ['project.created', 'project.version.created'],
  )
  assert.deepEqual(repository.lastBundle.events[0].actor, {
    clientId: 'client-1',
  })
  assert.deepEqual(repository.lastBundle.events[0].resource, {
    type: 'project',
    id: result.project.id,
  })
  assert.equal(repository.lastBundle.events[1].sequence, 1)
  assert.equal(repository.lastBundle.events[1].data.projectId, result.project.id)
  assert.equal(repository.events.size, 2)
  assert.equal(repository.lastBundle.auditCommand.action, 'create')
  assert.equal(repository.lastBundle.auditCommand.audit.clientId, 'client-1')
  assert.equal(repository.lastBundle.auditCommand.audit.credentialId, 'credential-1')
  assert.equal(repository.lastBundle.auditCommand.projectId, result.project.id)
  assert.equal(repository.lastBundle.auditCommand.versionId, result.version.id)
  assert.equal(repository.lastBundle.auditCommand.requestFingerprint.length, 64)
  assert.equal(repository.lastBundle.auditCommand.commandHash.length, 64)
})

test('same idempotency key and payload replays the original result', async () => {
  const { repository, service } = createFixture()
  const first = await service(request())
  const replay = await service(request())

  assert.equal(replay.replayed, true)
  assert.equal(replay.project.id, first.project.id)
  assert.equal(replay.version.id, first.version.id)
  assert.equal(repository.events.size, 2)
})

test('same idempotency key with a different payload is rejected', async () => {
  const { service } = createFixture()
  await service(request())

  await assert.rejects(
    () => service(request({ name: 'Outra campanha' })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('same client and idempotency key cannot replay through a different credential', async () => {
  const { service } = createFixture()
  await service(request())

  await assert.rejects(
    () => service(request({ actor: actor({ credentialId: 'credential-2' }) })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('project creation command hashes create and duplicate lineage without accepting partial sources', async () => {
  const { repository, service } = createFixture()
  await service(request())
  const audit = repository.lastBundle.auditCommand.audit
  const duplicate = createProjectCreationCommand({
    id: 'project-creation-command-duplicate-1',
    workspaceId: 'workspace-1',
    action: 'duplicate',
    projectId: 'project-duplicate-1',
    versionId: 'project-version-duplicate-1',
    sourceProjectId: repository.lastBundle.project.id,
    sourceVersionId: repository.lastBundle.version.id,
    audit,
    requestFingerprint: 'a'.repeat(64),
    createdAt: '2026-07-12T13:02:00.000Z',
  })
  const changedSource = createProjectCreationCommand({
    ...duplicate,
    sourceVersionId: 'project-version-source-changed',
  })

  assert.ok(Object.isFrozen(duplicate))
  assert.equal(duplicate.action, 'duplicate')
  assert.notEqual(duplicate.commandHash, changedSource.commandHash)
  assert.throws(
    () => createProjectCreationCommand({
      ...duplicate,
      sourceVersionId: undefined,
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => createProjectCreationCommand({
      ...repository.lastBundle.auditCommand,
      workspaceId: 'workspace-other',
    }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})

test('project duplication persists actor-bound copy-on-write lineage without copying bytes', async () => {
  const { repository, service, source, duplicateRequest } = await createDuplicationFixture()
  const result = await service(duplicateRequest({ name: 'Cópia segura' }))

  assert.equal(result.replayed, false)
  assert.equal(result.project.name, 'Cópia segura')
  assert.equal(result.project.duplicatedFromProjectId, source.project.id)
  assert.equal(result.version.forkedFromProjectId, source.project.id)
  assert.equal(result.version.forkedFromVersionId, source.version.id)
  assert.deepEqual(result.version.snapshotRefs, source.version.snapshotRefs)
  assert.deepEqual(result.sharedArtifactIds, ['artifact-source-1'])
  assert.equal(result.copiedBytes, 0)
  assert.equal(repository.lastBundle.auditCommand.action, 'duplicate')
  assert.equal(repository.lastBundle.auditCommand.sourceProjectId, source.project.id)
  assert.equal(repository.lastBundle.auditCommand.sourceVersionId, source.version.id)
  assert.equal(repository.lastBundle.auditCommand.audit.credentialId, 'credential-1')
})

test('project duplication replays before source reads and rejects another credential', async () => {
  const { repository, service, duplicateRequest } = await createDuplicationFixture()
  const first = await service(duplicateRequest())
  const replay = await service(duplicateRequest())

  assert.equal(replay.replayed, true)
  assert.equal(replay.project.id, first.project.id)
  assert.equal(repository.sourceReads, 1)
  await assert.rejects(
    () => service(duplicateRequest({ actor: actor({ credentialId: 'credential-2' }) })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('project creation retries serialization conflicts before returning an explicit conflict', async () => {
  const { repository, service } = createFixture()
  await service(request())
  let attempts = 0
  const prismaRepository = new PrismaProjectCreationRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => prismaRepository.createOrReplay(repository.lastBundle),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('unknown workspace is rejected before a project is persisted', async () => {
  const { service } = createFixture()

  await assert.rejects(
    () => service(request({
      workspaceId: 'workspace-missing',
      actor: actor({ workspaceId: 'workspace-missing' }),
    })),
    (error) => error instanceof DomainError && error.code === 'WORKSPACE_NOT_FOUND',
  )
})
