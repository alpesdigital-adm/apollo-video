import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { authenticateUiSessionService } from '../../src/v2/application/authenticate-ui-session.ts'
import { provisionBootstrapWorkspaceMemberService, provisionOidcWorkspaceMemberService } from '../../src/v2/application/workspace-members.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  createUiPasswordHash,
  deriveUiSessionRotationToken,
  issueUiSession,
  isTrustedUiMutationOrigin,
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

test('UI password and opaque session authenticate without storing plaintext', () => {
  assert.equal(verifyUiPassword('leandro', 'a-valid-test-password', environment), true)
  assert.equal(verifyUiPassword('leandro', 'wrong-password', environment), false)
  assert.equal(environment.APOLLO_UI_PASSWORD_HASH.includes('a-valid-test-password'), false)
  const token = issueUiSession({ token: 'a'.repeat(43) })
  assert.equal(verifyUiSession(token), token)
  assert.equal(token.includes('leandro'), false)
  assert.equal(token.includes('apollo-ui-client'), false)
  assert.equal(verifyUiSession(`${token}x`), null)
})

test('UI session and throttle identities are one-way and source-wide', () => {
  const sourceKey = uiLoginThrottleKey('203.0.113.8', 'leandro', environment)
  assert.equal(sourceKey, uiLoginThrottleKey('203.0.113.8', 'another-user', environment))
  assert.notEqual(sourceKey, uiLoginThrottleKey('203.0.113.9', 'leandro', environment))
  assert.match(sourceKey, /^[a-f0-9]{64}$/)
  assert.equal(sourceKey.includes('203.0.113.8'), false)
  assert.notEqual(uiSessionSubjectHash('leandro', environment), uiSessionSubjectHash('another-user', environment))
  assert.match(uiSessionNonceHash('fixed-session-nonce'), /^[a-f0-9]{64}$/)
  const current = 'a'.repeat(43)
  const successor = deriveUiSessionRotationToken(current, environment)
  assert.match(successor, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(successor, current)
  assert.equal(deriveUiSessionRotationToken(current, environment), successor)
  assert.notEqual(deriveUiSessionRotationToken('b'.repeat(43), environment), successor)
})

test('UI session resolves the active Postgres API actor and its scopes', async () => {
  const repository = {
    async findActiveClientById(id) {
      return id === 'apollo-ui-client'
        ? {
            id,
            workspaceId: 'workspace-1',
            allowedEnvironments: ['production'],
            scopeGrants: ['projects:read', 'projects:write'],
          }
        : null
    },
  }
  const sessions = {
    async readActiveAndTouch({ nonceHash }) {
      return nonceHash === 'a'.repeat(64)
        ? { nonceHash, workspaceId: 'workspace-1', clientId: 'apollo-ui-client', memberId: 'member-1', identityId: 'identity-1', memberRole: 'director', subjectHash: 'b'.repeat(64), issuedAt: '1970-01-01T00:00:01.000Z', lastSeenAt: '1970-01-01T00:00:01.000Z', idleExpiresAt: '1970-01-01T00:00:02.000Z', expiresAt: '1970-01-01T00:00:02.000Z' }
        : null
    },
  }
  const actor = await authenticateUiSessionService({
    repository,
    sessions,
    environment: 'production',
  })('a'.repeat(43), 'a'.repeat(64))
  assert.equal(actor.workspaceId, 'workspace-1')
  assert.equal(actor.delegatedUserId, 'member-1')
  assert.equal(actor.delegatedIdentityId, 'identity-1')
  assert.equal(actor.workspaceRole, 'director')
  assert.equal(actor.scopes.has('projects:write'), true)
  await assert.rejects(
    () => authenticateUiSessionService({ repository, sessions, environment: 'sandbox' })('a'.repeat(43), 'a'.repeat(64)),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})

test('UI session refresh requests bounded deterministic identifier rotation', async () => {
  const calls = []
  const durable = {
    nonceHash: 'b'.repeat(64), workspaceId: 'workspace-1', clientId: 'apollo-ui-client',
    memberId: 'member-1', identityId: 'identity-1', memberRole: 'director', subjectHash: 'c'.repeat(64),
    issuedAt: '2026-08-02T20:10:00.000Z', lastSeenAt: '2026-08-02T20:10:00.000Z',
    idleExpiresAt: '2026-08-02T20:40:00.000Z', expiresAt: '2026-08-03T08:00:00.000Z',
  }
  const actor = await authenticateUiSessionService({
    repository: { async findActiveClientById() {
      return { id: 'apollo-ui-client', workspaceId: 'workspace-1', allowedEnvironments: ['production'], scopeGrants: [] }
    } },
    sessions: { async refreshActiveSession(input) {
      calls.push(input)
      return { session: durable, rotated: true }
    } },
    environment: 'production',
    now: () => new Date('2026-08-02T20:10:00.000Z'),
  })('a'.repeat(43), 'a'.repeat(64), { successorNonceHash: 'b'.repeat(64) })
  assert.equal(actor.sessionTokenRotated, true)
  assert.deepEqual(calls, [{
    currentNonceHash: 'a'.repeat(64), successorNonceHash: 'b'.repeat(64),
    now: '2026-08-02T20:10:00.000Z', idleTtlSeconds: 1800,
    rotateAfterSeconds: 600, identifierMaxAgeSeconds: 900, recoverySeconds: 60,
  }])
})

test('UI redirect accepts only local application paths', () => {
  assert.equal(safeUiRedirect('/project/123?tab=review'), '/project/123?tab=review')
  assert.equal(safeUiRedirect('https://attacker.example'), '/')
  assert.equal(safeUiRedirect('//attacker.example'), '/')
  assert.equal(safeUiRedirect('/v1/session'), '/')
})

test('UI state mutations accept only the effective same origin', () => {
  assert.equal(isTrustedUiMutationOrigin({ origin: 'http://127.0.0.1:3100', host: '127.0.0.1:3100', protocol: 'http', fetchSite: 'same-origin' }), true)
  assert.equal(isTrustedUiMutationOrigin({ origin: 'https://apollo.example', host: 'apollo.example', protocol: 'https', fetchSite: 'same-origin' }), true)
  assert.equal(isTrustedUiMutationOrigin({ origin: 'https://attacker.example', host: 'apollo.example', protocol: 'https', fetchSite: 'cross-site' }), false)
  assert.equal(isTrustedUiMutationOrigin({ origin: 'https://attacker.example', host: 'apollo.example', protocol: 'https', fetchSite: null }), false)
  assert.equal(isTrustedUiMutationOrigin({ origin: null, host: 'apollo.example', protocol: 'https', fetchSite: 'same-origin' }), false)
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

test('authenticated bootstrap identity provisions one active workspace role without role escalation on replay', async () => {
  const persisted = new Map()
  const members = {
    async provisionMembership(input) {
      const key = `${input.issuer}:${input.subjectHash}:${input.workspaceId}`
      if (persisted.has(key)) return persisted.get(key)
      const member = { id: input.memberId, workspaceId: input.workspaceId, identityId: input.identityId, role: input.role, status: 'active', createdAt: input.now }
      persisted.set(key, member)
      return member
    },
  }
  let sequence = 0
  const provision = provisionBootstrapWorkspaceMemberService({
    members, id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    clock: () => new Date('2026-08-02T00:00:00.000Z'),
  })
  const first = await provision({ issuer: 'urn:apollo:bootstrap', subjectHash: 'a'.repeat(64), workspaceId: 'workspace-1', role: 'reviewer' })
  const replay = await provision({ issuer: 'urn:apollo:bootstrap', subjectHash: 'a'.repeat(64), workspaceId: 'workspace-1', role: 'administrator' })
  assert.equal(replay.id, first.id)
  assert.equal(replay.role, 'reviewer')
  await assert.rejects(
    () => provision({ issuer: 'https://untrusted.example', subjectHash: 'a'.repeat(64), workspaceId: 'workspace-1', role: 'reviewer' }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})

test('OIDC membership provisioning is explicit, issuer-bound and cannot use the bootstrap issuer', async () => {
  const writes = []
  const provision = provisionOidcWorkspaceMemberService({
    members: { async provisionMembership(input) {
      writes.push(input)
      return { id: input.memberId, workspaceId: input.workspaceId, identityId: input.identityId, role: input.role, status: 'active', createdAt: input.now }
    } },
    id: () => '00000000-0000-4000-8000-000000000991',
    clock: () => new Date('2026-08-02T00:00:00.000Z'),
  })
  const member = await provision({
    issuer: 'https://identity.example.test', subjectHash: 'c'.repeat(64), workspaceId: 'workspace-1', role: 'administrator',
  })
  assert.equal(member.role, 'administrator')
  assert.equal(writes[0].subjectHash, 'c'.repeat(64))
  await assert.rejects(
    () => provision({ issuer: 'urn:apollo:bootstrap', subjectHash: 'c'.repeat(64), workspaceId: 'workspace-1', role: 'administrator' }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})
