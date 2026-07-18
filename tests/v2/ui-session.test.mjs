import assert from 'node:assert/strict'
import test from 'node:test'

import { authenticateUiSessionService } from '../../src/v2/application/authenticate-ui-session.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  createUiPasswordHash,
  issueUiSession,
  safeUiRedirect,
  verifyUiPassword,
  verifyUiSession,
} from '../../src/v2/infrastructure/security/ui-session.ts'

const environment = {
  NODE_ENV: 'production',
  APOLLO_UI_USERNAME: 'leandro',
  APOLLO_UI_API_CLIENT_ID: 'apollo-ui-client',
  APOLLO_UI_SESSION_SECRET: 'a-secure-session-secret-with-more-than-32-characters',
  APOLLO_UI_PASSWORD_HASH: createUiPasswordHash('a-valid-test-password', 'fixed-test-salt'),
}

test('UI password and signed session authenticate without storing plaintext', () => {
  assert.equal(verifyUiPassword('leandro', 'a-valid-test-password', environment), true)
  assert.equal(verifyUiPassword('leandro', 'wrong-password', environment), false)
  assert.equal(environment.APOLLO_UI_PASSWORD_HASH.includes('a-valid-test-password'), false)
  const token = issueUiSession('leandro', 'apollo-ui-client', {
    environment,
    now: new Date('2026-07-18T12:00:00Z'),
    nonce: 'fixed-session-nonce',
  })
  const session = verifyUiSession(token, {
    environment,
    now: new Date('2026-07-18T13:00:00Z'),
  })
  assert.equal(session?.subject, 'leandro')
  assert.equal(session?.clientId, 'apollo-ui-client')
  assert.equal(verifyUiSession(`${token}x`, { environment, now: new Date('2026-07-18T13:00:00Z') }), null)
  assert.equal(verifyUiSession(token, { environment, now: new Date('2026-07-19T02:00:00Z') }), null)
})

test('UI session resolves the active Postgres API actor and its scopes', async () => {
  const repository = {
    async findActiveClientById(id) {
      return id === 'apollo-ui-client'
        ? {
            id,
            workspaceId: 'workspace-1',
            environment: 'production',
            scopes: ['projects:read', 'projects:write'],
          }
        : null
    },
  }
  const actor = await authenticateUiSessionService({
    repository,
    environment: 'production',
  })({
    version: 1,
    subject: 'leandro',
    clientId: 'apollo-ui-client',
    issuedAt: 1,
    expiresAt: 2,
    nonce: 'fixed-session-nonce',
  })
  assert.equal(actor.workspaceId, 'workspace-1')
  assert.equal(actor.scopes.has('projects:write'), true)
  await assert.rejects(
    () => authenticateUiSessionService({ repository, environment: 'sandbox' })({
      version: 1,
      subject: 'leandro',
      clientId: 'apollo-ui-client',
      issuedAt: 1,
      expiresAt: 2,
      nonce: 'fixed-session-nonce',
    }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})

test('UI redirect accepts only local application paths', () => {
  assert.equal(safeUiRedirect('/project/123?tab=review'), '/project/123?tab=review')
  assert.equal(safeUiRedirect('https://attacker.example'), '/')
  assert.equal(safeUiRedirect('//attacker.example'), '/')
  assert.equal(safeUiRedirect('/v1/session'), '/')
})
