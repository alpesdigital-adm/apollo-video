import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { projectQuickActionsService } from '../../src/v2/application/project-quick-actions.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createProject } from '../../src/v2/domain/project.ts'
import { createProjectAdministrationState } from '../../src/v2/domain/project-administration-command.ts'

function actor({ workspaceId = 'workspace-1', scopes = ['projects:write'] } = {}) {
  const auditContext = createExternalAuditContext({
    clientId: 'client-1', credentialId: 'credential-1', workspaceId,
    environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(scopes), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function fixture({ status = 'reviewing-proxy', archivedFromStatus } = {}) {
  let current = Object.freeze({
    project: createProject({
      id: 'project-1', workspaceId: 'workspace-1', name: 'Original', status,
      currentVersionId: 'version-1',
      createdBy: { type: 'api-client', id: 'client-1' },
      createdAt: '2026-08-06T12:00:00.000Z',
    }),
    state: createProjectAdministrationState({
      name: 'Original', status, archivedFromStatus, revision: 1,
    }),
  })
  const replays = new Map()
  const committed = []
  const repository = {
    async findReplay(input) {
      const found = replays.get(`${input.workspaceId}:${input.actorContextHash}:${input.idempotencyKey}`)
      if (!found) return null
      if (found.command.requestFingerprint !== input.requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency-Key was already used for another project administration command',
        )
      }
      return Object.freeze({ ...found, replayed: true })
    },
    async read(input) {
      return input.workspaceId === current.project.workspaceId &&
        input.projectId === current.project.id ? current : null
    },
    async apply(input) {
      assert.equal(input.command.before.revision, current.state.revision)
      assert.equal(input.event.sequence, input.command.after.revision)
      current = Object.freeze({ project: input.project, state: input.command.after })
      const result = Object.freeze({
        ...current, command: input.command, replayed: false,
      })
      replays.set(
        `${input.command.workspaceId}:${input.command.audit.contextHash}:${input.command.idempotencyKey}`,
        result,
      )
      committed.push({ ...input })
      return result
    },
  }
  let sequence = 0
  const service = projectQuickActionsService({
    repository,
    clock: () => new Date('2026-08-06T12:30:00.000Z'),
    createCommandId: () => `project-administration-${++sequence}`,
    createEventId: () => `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  })
  return { repository, service, committed, current: () => current }
}

test('F1.003 rename is revision-fenced, actor-bound, idempotent and emits canonical evidence', async () => {
  const setup = fixture()
  const request = {
    actor: actor(), projectId: 'project-1', action: 'rename',
    baseRevision: 1, idempotencyKey: 'rename-key-1', name: '  Nome   canônico ',
  }
  const changed = await setup.service(request)
  assert.equal(changed.project.name, 'Nome canônico')
  assert.equal(changed.state.revision, 2)
  assert.equal(changed.command.action, 'rename')
  assert.equal(changed.command.confirmation, 'not-required')
  assert.match(changed.command.commandHash, /^[a-f0-9]{64}$/)
  assert.equal(setup.committed[0].event.type, 'project.name.changed')
  assert.equal(setup.committed[0].audit.contextHash, changed.command.audit.contextHash)

  const replay = await setup.service(request)
  assert.equal(replay.replayed, true)
  assert.equal(replay.command.id, changed.command.id)
  assert.equal(setup.committed.length, 1)
  await assert.rejects(
    () => setup.service({ ...request, name: 'Payload diferente' }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  await assert.rejects(
    () => setup.service({ ...request, idempotencyKey: 'rename-key-2', baseRevision: 1 }),
    (error) => error.code === 'VERSION_CONFLICT',
  )
})

test('F1.003 archive requires confirmation and restore preserves the exact prior workflow status', async () => {
  const setup = fixture({ status: 'completed' })
  const base = {
    actor: actor(), projectId: 'project-1', action: 'archive',
    baseRevision: 1, idempotencyKey: 'archive-key-1',
  }
  await assert.rejects(
    () => setup.service(base),
    (error) => error.code === 'TOOL_CONFIRMATION_REQUIRED',
  )
  const archived = await setup.service({ ...base, confirmed: true })
  assert.equal(archived.state.status, 'archived')
  assert.equal(archived.state.archivedFromStatus, 'completed')
  assert.equal(archived.command.confirmation, 'explicit')
  assert.equal(setup.committed[0].event.type, 'project.status.changed')

  const restored = await setup.service({
    actor: actor(), projectId: 'project-1', action: 'restore',
    baseRevision: 2, idempotencyKey: 'restore-key-1',
  })
  assert.equal(restored.state.status, 'completed')
  assert.equal(restored.state.archivedFromStatus, undefined)
  assert.equal(restored.state.revision, 3)
  assert.equal(setup.committed.length, 2)
})

test('F1.003 archive rejects active workflow phases instead of racing their workers', async () => {
  const active = fixture({ status: 'rendering-proxy' })
  await assert.rejects(
    () => active.service({
      actor: actor(), projectId: 'project-1', action: 'archive',
      baseRevision: 1, idempotencyKey: 'archive-key-active', confirmed: true,
    }),
    (error) => error.code === 'INVALID_PROJECT',
  )
  assert.equal(active.committed.length, 0)
})

test('F1.003 legacy archived rows fail closed and workspace/scope isolation precede mutation', async () => {
  const legacy = fixture({ status: 'archived' })
  await assert.rejects(
    () => legacy.service({
      actor: actor(), projectId: 'project-1', action: 'restore',
      baseRevision: 1, idempotencyKey: 'restore-key-legacy',
    }),
    (error) => error.code === 'INVALID_PROJECT',
  )
  await assert.rejects(
    () => legacy.service({
      actor: actor({ workspaceId: 'workspace-2' }), projectId: 'project-1',
      action: 'rename', baseRevision: 1, idempotencyKey: 'rename-key-cross',
      name: 'Cross tenant',
    }),
    (error) => error.code === 'PROJECT_NOT_FOUND',
  )
  await assert.rejects(
    () => legacy.service({
      actor: actor({ scopes: ['projects:read'] }), projectId: 'project-1',
      action: 'rename', baseRevision: 1, idempotencyKey: 'rename-key-scope',
      name: 'Forbidden',
    }),
    (error) => error.code === 'AUTH_SCOPE_REQUIRED',
  )
  assert.equal(legacy.committed.length, 0)
})
