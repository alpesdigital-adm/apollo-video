import assert from 'node:assert/strict'
import test from 'node:test'
import { listGovernanceUsageAuditService } from '../../src/v2/application/list-governance-usage-audit.ts'

test('usage/audit query is paginated and redacts execution internals', async () => {
  const operation = { id: 'operation-1', workspaceId: 'workspace-1', clientId: 'client-1', type: 'artifact-render', status: 'succeeded', target: { type: 'artifact', id: 'artifact-1' }, createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:01:00.000Z', secret: 'never-public' }
  const result = await listGovernanceUsageAuditService({ operations: { async list() { return [{ operation }] } } })({ workspaceId: 'workspace-1', limit: 1 })
  assert.equal(result.entries.length, 1)
  assert.equal(JSON.stringify(result).includes('never-public'), false)
  assert.deepEqual(result.entries[0].usage, { unit: 'operation', quantity: 1 })
})
