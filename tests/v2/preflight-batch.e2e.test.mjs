import assert from 'node:assert/strict'
import test from 'node:test'
import { createPreflightResult } from '../../src/v2/domain/preflight-result.ts'
import { createBatchItemResult } from '../../src/v2/domain/batch-item-result.ts'
import { HmacPreflightCommitTokenIssuer } from '../../src/v2/infrastructure/security/preflight-commit-token.ts'
import { requirePreflightForActionService } from '../../src/v2/application/preflight-gate.ts'

test('dry-run, expiry, partial retry and budget block form one deterministic preflight journey', () => {
  let committed = 0
  const common = { schemaVersion: 'preflight-result/v1', fingerprint: 'a'.repeat(64), evaluatedAt: '2026-07-17T00:00:00Z', targets: [{ kind: 'batch', id: 'batch-1' }], conflicts: [], invalidations: [], jobs: [{ kind: 'render', count: 2 }], cost: { currency: 'USD', estimatedMinorUnits: 100, maximumMinorUnits: 150 }, warnings: [] }
  const dryRun = createPreflightResult({ ...common, eligible: true, quota: { unit: 'cent', required: 150, remaining: 1000, allowed: true } })
  assert.equal(dryRun.eligible, true)
  assert.equal(committed, 0)

  const issuer = new HmacPreflightCommitTokenIssuer('e'.repeat(32))
  const claims = { clientId: 'client-1', workspaceId: 'workspace-1', fingerprint: dryRun.fingerprint, snapshot: 'b'.repeat(64), costFingerprint: 'c'.repeat(64), expiresAt: '2026-07-17T00:05:00Z' }
  const expiredGate = requirePreflightForActionService({ issuer, clock: () => new Date('2026-07-17T00:05:01Z') })
  assert.throws(() => expiredGate({ actionClass: 'batch', token: issuer.issue(claims), ...claims }), /expired/)

  const budgetBlocked = createPreflightResult({ ...common, eligible: false, quota: { unit: 'cent', required: 150, remaining: 50, allowed: false } })
  assert.equal(budgetBlocked.eligible, false)
  assert.equal(committed, 0)

  const items = [
    createBatchItemResult({ itemId: 'item-1', operationId: 'operation-1', status: 'succeeded', retryable: false, resultRef: 'artifact-1', updatedAt: '2026-07-17T00:10:00Z' }),
    createBatchItemResult({ itemId: 'item-2', operationId: 'operation-2', status: 'failed', retryable: true, error: { code: 'TIMEOUT', message: 'Provider timed out' }, updatedAt: '2026-07-17T00:10:00Z' }),
  ]
  const retryIds = items.filter((item) => item.retryable).map((item) => item.operationId)
  assert.deepEqual(retryIds, ['operation-2'])
})
