import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createExternalAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import {
  listGovernanceUsageAuditService,
} from '../../src/v2/application/list-governance-usage-audit.ts'
import {
  createGovernanceAdmission,
} from '../../src/v2/domain/governance-admission.ts'

function actor(workspaceId = 'workspace-1', scopes = ['clients:admin']) {
  const auditContext = createExternalAuditContext({
    clientId: 'admin-client',
    credentialId: 'admin-credential',
    workspaceId,
    environment: 'production',
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

function admission(id, createdAt, allowed = true) {
  return createGovernanceAdmission({
    id,
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    capabilityId: 'apollo.projects.list',
    environment: 'production',
    operationKind: 'query',
    costClass: 'free',
    allowed,
    reasons: allowed ? [] : ['RATE_LIMIT'],
    scopes: Object.freeze(Object.fromEntries(['workspace', 'client'].map(
      (scope) => [scope, {
        reasons: allowed ? [] : ['RATE_LIMIT'],
        limits: {
          requestsPerMinute: 2,
          maxConcurrency: 4,
          quotaUnits: 100,
          spendBudgetMinorUnits: 100,
        },
        usage: {
          requestsInWindow: allowed ? 0 : 2,
          activeConcurrency: 0,
          quotaUnitsUsed: 0,
          spendMinorUnits: 0,
        },
        remaining: {
          requests: allowed ? 1 : 0,
          concurrency: 4,
          quotaUnits: 100,
          spendMinorUnits: 100,
        },
      }],
    ))),
    requested: {
      requests: 1,
      concurrency: 0,
      quotaUnits: 0,
      spendMinorUnits: 0,
    },
    createdAt,
  })
}

test('usage/audit query is actor-scoped, paginated and exposes only redacted admissions', async () => {
  const rows = [
    admission('governance-admission-2', '2026-08-05T01:00:02.000Z', false),
    admission('governance-admission-1', '2026-08-05T01:00:01.000Z'),
  ]
  const repository = {
    async list(input) {
      const start = input.after
        ? rows.findIndex((item) => item.id === input.after.id) + 1
        : 0
      return rows.slice(start, start + input.limit)
    },
  }
  const list = listGovernanceUsageAuditService({ repository })
  const first = await list({
    actor: actor(),
    workspaceId: 'workspace-1',
    limit: 1,
  })
  assert.equal(first.entries.length, 1)
  assert.equal(first.entries[0].decision, 'blocked')
  assert.deepEqual(first.entries[0].reasonCodes, ['RATE_LIMIT'])
  assert.deepEqual(first.entries[0].scopes.workspace.reasons, ['RATE_LIMIT'])
  assert.deepEqual(first.entries[0].scopes.client.reasons, ['RATE_LIMIT'])
  assert.equal('admissionHash' in first.entries[0], false)
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/)

  const second = await list({
    actor: actor(),
    workspaceId: 'workspace-1',
    limit: 1,
    after: first.nextCursor,
  })
  assert.equal(second.entries[0].decision, 'allowed')
  assert.equal('nextCursor' in second, false)
  await assert.rejects(
    list({
      actor: actor('workspace-other'),
      workspaceId: 'workspace-1',
    }),
    /Workspace was not found/,
  )
  await assert.rejects(
    list({
      actor: actor('workspace-1', ['projects:read']),
      workspaceId: 'workspace-1',
    }),
    /required scope/,
  )
})
