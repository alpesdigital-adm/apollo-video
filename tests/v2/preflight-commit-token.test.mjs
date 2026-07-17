import assert from 'node:assert/strict'
import test from 'node:test'

import { HmacPreflightCommitTokenIssuer } from '../../src/v2/infrastructure/security/preflight-commit-token.ts'

test('commit token binds client, workspace, fingerprint, snapshot, cost and expiry', () => {
  const issuer = new HmacPreflightCommitTokenIssuer('p'.repeat(32))
  const claims = { clientId: 'client-1', workspaceId: 'workspace-1', fingerprint: 'a'.repeat(64), snapshot: 'b'.repeat(64), costFingerprint: 'c'.repeat(64), expiresAt: '2026-07-17T00:00:00.000Z' }
  const token = issuer.issue(claims)
  assert.deepEqual(issuer.verify(token), claims)
  assert.equal(token.includes('client-1'), false)
  assert.equal(token.includes('workspace-1'), false)
})

test('commit token rejects tampering and incomplete claims', () => {
  const issuer = new HmacPreflightCommitTokenIssuer('p'.repeat(32))
  const claims = { clientId: 'client-1', workspaceId: 'workspace-1', fingerprint: 'a'.repeat(64), snapshot: 'b'.repeat(64), costFingerprint: 'c'.repeat(64), expiresAt: '2026-07-17T00:00:00.000Z' }
  const token = issuer.issue(claims)
  assert.throws(() => issuer.verify(`${token.slice(0, -1)}x`), /invalid/)
  assert.throws(() => issuer.issue({ ...claims, snapshot: 'bad' }), /claims/)
})
