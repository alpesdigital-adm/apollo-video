import assert from 'node:assert/strict'
import test from 'node:test'

import { HmacPreflightCommitTokenIssuer } from '../../src/v2/infrastructure/security/preflight-commit-token.ts'
import { validatePreflightCommitTokenService } from '../../src/v2/application/validate-preflight-commit-token.ts'

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

test('commit validation invalidates expiry and any material input, snapshot or cost change', () => {
  const issuer = new HmacPreflightCommitTokenIssuer('p'.repeat(32))
  const expected = { clientId: 'client-1', workspaceId: 'workspace-1', fingerprint: 'a'.repeat(64), snapshot: 'b'.repeat(64), costFingerprint: 'c'.repeat(64) }
  const token = issuer.issue({ ...expected, expiresAt: '2026-07-17T00:10:00.000Z' })
  const valid = validatePreflightCommitTokenService({ issuer, clock: () => new Date('2026-07-17T00:05:00.000Z') })
  assert.equal(valid({ token, ...expected }).valid, true)
  for (const field of ['fingerprint', 'snapshot', 'costFingerprint']) {
    assert.throws(() => valid({ token, ...expected, [field]: 'd'.repeat(64) }), /no longer matches/)
  }
  assert.throws(() => valid({ token, ...expected, clientId: 'client-2' }), /no longer matches/)
  const expired = validatePreflightCommitTokenService({ issuer, clock: () => new Date('2026-07-17T00:10:00.001Z') })
  assert.throws(() => expired({ token, ...expected }), /expired/)
})
