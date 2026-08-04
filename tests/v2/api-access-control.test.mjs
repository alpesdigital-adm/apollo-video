import assert from 'node:assert/strict'
import test from 'node:test'

import {
  changeApiAccessControlService,
  readApiAccessControlService,
} from '../../src/v2/application/administer-api-access.ts'
import {
  createApiAccessControl,
  transitionApiAccessControl,
} from '../../src/v2/domain/api-access-control.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaApiAccessControlRepository } from '../../src/v2/infrastructure/prisma/api-access-control-repository.ts'
import { assertKillSwitchRecoveryAccess } from '../../src/v2/public-api/kill-switch-access.ts'

const ZERO_REVISION = '0'.repeat(64)

function access(overrides = {}) {
  return createApiAccessControl({
    workspaceId: 'workspace-1', targetType: 'client', targetId: 'client-target',
    status: 'active', killSwitchEngaged: false, revision: ZERO_REVISION,
    ...overrides,
  })
}

function actor(overrides = {}) {
  return {
    clientId: 'client-admin', credentialId: 'credential-admin', workspaceId: 'workspace-1',
    environment: 'sandbox', scopes: new Set(['clients:admin']), delegatedUserId: 'member-admin',
    authenticationKind: 'ui-session', clientAccessStatus: 'active', workspaceAccessStatus: 'active',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    ...overrides,
  }
}

class InMemoryAccessRepository {
  constructor(initial = access()) {
    this.current = initial
    this.replays = new Map()
    this.canceledOperationCount = 3
  }

  async find(input) {
    return input.workspaceId === this.current.workspaceId &&
      input.targetType === this.current.targetType && input.targetId === this.current.targetId
      ? this.current : null
  }

  async findReplay(input) {
    const stored = this.replays.get(`${input.workspaceId}:${input.actorClientId}:${input.idempotencyKey}`)
    if (!stored) return null
    if (stored.command.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'mismatch')
    }
    return { ...stored, replayed: true }
  }

  async apply(command) {
    const key = `${command.workspaceId}:${command.actorClientId}:${command.idempotencyKey}`
    const existing = this.replays.get(key)
    if (existing) return { ...existing, replayed: true }
    assert.equal(command.baseRevision, this.current.revision)
    this.current = access({
      workspaceId: command.workspaceId, targetType: command.targetType, targetId: command.targetId,
      status: command.resultStatus, killSwitchEngaged: command.resultKillSwitchEngaged,
      revision: command.resultRevision,
    })
    const result = {
      access: this.current, command,
      canceledOperationCount: this.canceledOperationCount, replayed: false,
    }
    this.replays.set(key, result)
    return result
  }
}

test('T-FR-242 API access transitions are strict and revocation is terminal', () => {
  assert.deepEqual(transitionApiAccessControl(access(), 'suspend'), {
    previousStatus: 'active', resultStatus: 'suspended',
    previousKillSwitchEngaged: false, resultKillSwitchEngaged: false,
  })
  assert.deepEqual(transitionApiAccessControl(access(), 'engage-kill-switch'), {
    previousStatus: 'active', resultStatus: 'active',
    previousKillSwitchEngaged: false, resultKillSwitchEngaged: true,
  })
  assert.deepEqual(transitionApiAccessControl(access({ killSwitchEngaged: true }), 'release-kill-switch'), {
    previousStatus: 'active', resultStatus: 'active',
    previousKillSwitchEngaged: true, resultKillSwitchEngaged: false,
  })
  assert.throws(
    () => transitionApiAccessControl(access({ status: 'revoked' }), 'activate'),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => transitionApiAccessControl(access(), 'activate'),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('T-FR-242 kill switch command binds actor, delegated user, CAS, audit and cancellation evidence', async () => {
  const repository = new InMemoryAccessRepository()
  const execute = changeApiAccessControlService({
    repository,
    clock: () => new Date('2026-08-03T22:00:00.000Z'),
    createId: () => 'api-access-command-1',
  })
  const request = {
    actor: actor(), workspaceId: 'workspace-1', targetType: 'client', targetId: 'client-target',
    action: 'engage-kill-switch', baseRevision: ZERO_REVISION,
    reason: ' Emergency containment requested ', idempotencyKey: 'kill-client-1', confirmed: true,
  }
  const first = await execute(request)
  const replay = await execute(request)

  assert.equal(first.replayed, false)
  assert.equal(first.access.killSwitchEngaged, true)
  assert.equal(first.command.actorClientId, 'client-admin')
  assert.equal(first.command.delegatedUserId, 'member-admin')
  assert.equal(first.command.reason, 'Emergency containment requested')
  assert.equal(first.canceledOperationCount, 3)
  assert.match(first.command.requestFingerprint, /^[a-f0-9]{64}$/)
  assert.match(first.command.resultRevision, /^[a-f0-9]{64}$/)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.command, first.command)
  assert.deepEqual(replay.access, first.access)
})

test('T-FR-244 client suspension atomically outboxes containment and the redacted client event', async () => {
  const events = []
  const transaction = {
    v2ApiAccessCommand: {
      async findUnique() { return null },
      async create({ data }) { return { ...data, delegatedUserId: data.delegatedUserId ?? null } },
    },
    v2ApiClient: {
      async findFirst() {
        return {
          id: 'client-target', workspaceId: 'workspace-1', status: 'active',
          apiKillSwitchEngaged: false, apiAccessRevision: ZERO_REVISION,
        }
      },
      async updateMany() { return { count: 1 } },
    },
    v2PublicOperation: {
      async findMany() {
        return [{
          id: 'operation-client-target-1', workspaceId: 'workspace-1', projectId: null,
          clientId: 'client-target', type: 'artifact-render', status: 'queued', attempt: 0,
        }]
      },
      async updateMany() { return { count: 1 } },
    },
    v2PublicEventOutbox: {
      async createMany({ data }) {
        events.push(...data)
        return { count: data.length }
      },
    },
  }
  const eventIds = [
    '123e4567-e89b-42d3-a456-426614174001',
    '123e4567-e89b-42d3-a456-426614174002',
  ]
  const repository = new PrismaApiAccessControlRepository({
    ...transaction,
    async $transaction(callback) { return callback(transaction) },
  }, () => eventIds.shift())
  const execute = changeApiAccessControlService({
    repository,
    clock: () => new Date('2026-08-03T22:05:00.000Z'),
    createId: () => 'api-access-command-suspend-1',
  })

  const result = await execute({
    actor: actor(), workspaceId: 'workspace-1', targetType: 'client', targetId: 'client-target',
    action: 'suspend', baseRevision: ZERO_REVISION, reason: 'Contain compromised automation',
    idempotencyKey: 'suspend-client-outbox-1', confirmed: true,
  })

  assert.equal(result.canceledOperationCount, 1)
  assert.deepEqual(events.map((event) => event.type), [
    'operation.status.changed',
    'client.suspended',
  ])
  assert.deepEqual(JSON.parse(events[1].dataJson), {
    canceledOperationCount: 1,
    commandId: 'api-access-command-suspend-1',
    previousStatus: 'active',
    status: 'suspended',
  })
  assert.equal(events[1].actorClientId, 'client-admin')
  assert.equal(events[1].actorUserId, 'member-admin')
  assert.equal(events[1].dataJson.includes('Contain compromised automation'), false)
})

test('T-FR-242 API access administration rejects missing authority, confirmation and stale revisions', async () => {
  const repository = new InMemoryAccessRepository()
  const execute = changeApiAccessControlService({ repository })
  const base = {
    actor: actor(), workspaceId: 'workspace-1', targetType: 'client', targetId: 'client-target',
    action: 'suspend', baseRevision: ZERO_REVISION, reason: 'Security review',
    idempotencyKey: 'suspend-client-1', confirmed: true,
  }
  for (const mutation of [
    { actor: actor({ workspaceId: 'workspace-other' }) },
    { actor: actor({ scopes: new Set() }) },
    { confirmed: false },
    { baseRevision: 'f'.repeat(64) },
  ]) {
    await assert.rejects(() => execute({ ...base, ...mutation }), DomainError)
  }
})

test('T-FR-242 API access reads are workspace and administrator scoped', async () => {
  const repository = new InMemoryAccessRepository()
  const read = readApiAccessControlService({ repository })
  assert.deepEqual(await read({
    actor: actor(), workspaceId: 'workspace-1', targetType: 'client', targetId: 'client-target',
  }), access())
  await assert.rejects(() => read({
    actor: actor({ workspaceId: 'workspace-other' }), workspaceId: 'workspace-1',
    targetType: 'client', targetId: 'client-target',
  }), (error) => error instanceof DomainError && error.code === 'WORKSPACE_NOT_FOUND')
})

test('T-FR-242 kill switch permits only delegated recovery capabilities', () => {
  const bearer = actor({
    authenticationKind: 'bearer', clientKillSwitchEngaged: true, workspaceKillSwitchEngaged: false,
  })
  assert.throws(
    () => assertKillSwitchRecoveryAccess(bearer, 'apollo.api-access.clients.change'),
    (error) => error instanceof DomainError && error.code === 'OPERATIONAL_KILL_SWITCH_ACTIVE',
  )
  const delegated = actor({
    authenticationKind: 'ui-session', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: true,
  })
  assert.doesNotThrow(() => assertKillSwitchRecoveryAccess(delegated, 'apollo.api-access.workspace.change'))
  assert.throws(
    () => assertKillSwitchRecoveryAccess(delegated, 'apollo.projects.list'),
    (error) => error instanceof DomainError && error.code === 'OPERATIONAL_KILL_SWITCH_ACTIVE',
  )
})
