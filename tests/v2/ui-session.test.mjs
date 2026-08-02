import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { authenticateUiSessionService } from '../../src/v2/application/authenticate-ui-session.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  createUiPasswordHash,
  issueUiSession,
  safeUiRedirect,
  uiLoginThrottleKey,
  uiSessionNonceHash,
  uiSessionSubjectHash,
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

test('UI session and throttle identities are one-way and source-wide', () => {
  const sourceKey = uiLoginThrottleKey('203.0.113.8', 'leandro', environment)
  assert.equal(sourceKey, uiLoginThrottleKey('203.0.113.8', 'another-user', environment))
  assert.notEqual(sourceKey, uiLoginThrottleKey('203.0.113.9', 'leandro', environment))
  assert.match(sourceKey, /^[a-f0-9]{64}$/)
  assert.equal(sourceKey.includes('203.0.113.8'), false)
  assert.notEqual(uiSessionSubjectHash('leandro', environment), uiSessionSubjectHash('another-user', environment))
  assert.match(uiSessionNonceHash('fixed-session-nonce'), /^[a-f0-9]{64}$/)
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
  const sessions = {
    async readActiveAndTouch({ nonceHash }) {
      return nonceHash === 'a'.repeat(64)
        ? { nonceHash, workspaceId: 'workspace-1', clientId: 'apollo-ui-client', subjectHash: 'b'.repeat(64), issuedAt: '1970-01-01T00:00:01.000Z', lastSeenAt: '1970-01-01T00:00:01.000Z', idleExpiresAt: '1970-01-01T00:00:02.000Z', expiresAt: '1970-01-01T00:00:02.000Z' }
        : null
    },
  }
  const actor = await authenticateUiSessionService({
    repository,
    sessions,
    environment: 'production',
  })({
    version: 1,
    subject: 'leandro',
    clientId: 'apollo-ui-client',
    issuedAt: 1,
    expiresAt: 2,
    nonce: 'fixed-session-nonce',
  }, 'a'.repeat(64), 'b'.repeat(64))
  assert.equal(actor.workspaceId, 'workspace-1')
  assert.equal(actor.scopes.has('projects:write'), true)
  await assert.rejects(
    () => authenticateUiSessionService({ repository, sessions, environment: 'sandbox' })({
      version: 1,
      subject: 'leandro',
      clientId: 'apollo-ui-client',
      issuedAt: 1,
      expiresAt: 2,
      nonce: 'fixed-session-nonce',
    }, 'a'.repeat(64), 'b'.repeat(64)),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})

test('UI redirect accepts only local application paths', () => {
  assert.equal(safeUiRedirect('/project/123?tab=review'), '/project/123?tab=review')
  assert.equal(safeUiRedirect('https://attacker.example'), '/')
  assert.equal(safeUiRedirect('//attacker.example'), '/')
  assert.equal(safeUiRedirect('/v1/session'), '/')
})

test('V2 pages require the durable server-side session and login never trusts the signed cookie alone', () => {
  const sources = {
    root: readFileSync(new URL('../../src/app/page.tsx', import.meta.url), 'utf8'),
    projects: readFileSync(new URL('../../src/app/projects/layout.tsx', import.meta.url), 'utf8'),
    batches: readFileSync(new URL('../../src/app/batches/layout.tsx', import.meta.url), 'utf8'),
    login: readFileSync(new URL('../../src/app/login/page.tsx', import.meta.url), 'utf8'),
    proxy: readFileSync(new URL('../../src/proxy.ts', import.meta.url), 'utf8'),
  }
  assert.match(sources.root, /requireActiveUiPageSession\('\/'\)/)
  assert.match(sources.projects, /requireActiveUiPageSession\('\/'\)/)
  assert.match(sources.batches, /requireActiveUiPageSession\('\/batches'\)/)
  assert.match(sources.login, /readActiveUiPageSession\(\)/)
  const loginProxyBranch = sources.proxy.match(/if \(pathname === '\/login'\) \{([\s\S]*?)\n  \}/)?.[1] ?? ''
  assert.match(loginProxyBranch, /return NextResponse\.next\(\)/)
  assert.doesNotMatch(loginProxyBranch, /authenticated|NextResponse\.redirect/)
})
