import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createUiPasswordHash,
  issueUiSession,
  safeUiRedirect,
  verifyUiPassword,
  verifyUiSession
} from '../src/lib/ui-auth.ts'

const environment = {
  NODE_ENV: 'production',
  APOLLO_UI_USERNAME: 'leandro',
  APOLLO_UI_SESSION_SECRET: 'a-secure-session-secret-with-more-than-32-characters',
  APOLLO_UI_PASSWORD_HASH: createUiPasswordHash('a-valid-test-password', 'fixed-test-salt')
}

test('UI password and signed session authenticate without storing plaintext', () => {
  assert.equal(verifyUiPassword('leandro', 'a-valid-test-password', environment), true)
  assert.equal(verifyUiPassword('leandro', 'wrong-password', environment), false)
  assert.equal(environment.APOLLO_UI_PASSWORD_HASH.includes('a-valid-test-password'), false)
  const token = issueUiSession('leandro', { environment, now: new Date('2026-07-18T12:00:00Z'), nonce: 'fixed-session-nonce' })
  assert.equal(verifyUiSession(token, { environment, now: new Date('2026-07-18T13:00:00Z') })?.subject, 'leandro')
  assert.equal(verifyUiSession(`${token}x`, { environment, now: new Date('2026-07-18T13:00:00Z') }), null)
  assert.equal(verifyUiSession(token, { environment, now: new Date('2026-07-19T02:00:00Z') }), null)
})

test('UI redirect accepts only local application paths', () => {
  assert.equal(safeUiRedirect('/project/123?tab=review'), '/project/123?tab=review')
  assert.equal(safeUiRedirect('https://attacker.example'), '/')
  assert.equal(safeUiRedirect('//attacker.example'), '/')
  assert.equal(safeUiRedirect('/api/auth/logout'), '/')
})
