import assert from 'node:assert/strict'
import test from 'node:test'
import { HmacPreflightCommitTokenIssuer } from '../../src/v2/infrastructure/security/preflight-commit-token.ts'
import { PREFLIGHT_REQUIRED_ACTION_CLASSES, requirePreflightForActionService } from '../../src/v2/application/preflight-gate.ts'

test('batch, final matrix, variable generation and destructive actions require trusted preflight', () => {
  assert.deepEqual(PREFLIGHT_REQUIRED_ACTION_CLASSES, ['batch', 'final-matrix', 'variable-generation', 'destructive'])
  const issuer = new HmacPreflightCommitTokenIssuer('g'.repeat(32))
  const claims = { clientId: 'client-1', workspaceId: 'workspace-1', fingerprint: 'a'.repeat(64), snapshot: 'b'.repeat(64), costFingerprint: 'c'.repeat(64), expiresAt: '2026-07-17T01:00:00.000Z' }
  const gate = requirePreflightForActionService({ issuer, clock: () => new Date('2026-07-17T00:30:00.000Z') })
  for (const actionClass of PREFLIGHT_REQUIRED_ACTION_CLASSES) {
    assert.throws(() => gate({ actionClass, ...claims }), /required/)
    assert.equal(gate({ actionClass, ...claims, token: issuer.issue(claims) }).valid, true)
  }
  assert.deepEqual(gate({ actionClass: 'bounded', ...claims }), { required: false })
})
