import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import { oidcSecretHash } from '../../src/v2/domain/oidc-authorization.ts'
import {
  beginOidcAuthorizationService,
  consumeOidcAuthorizationService,
} from '../../src/v2/application/manage-oidc-authorization.ts'
import { nodeOidcTransactionProtector } from '../../src/v2/infrastructure/security/oidc-transaction-protector.ts'
import { signInWithOidcService } from '../../src/v2/application/sign-in-with-oidc.ts'

function memoryAuthorizations() {
  const records = new Map()
  return {
    records,
    async create(input) { records.set(input.stateHash, Object.freeze({ ...input })) },
    async consume({ stateHash, browserBindingHash, consumedAt }) {
      const current = records.get(stateHash)
      if (!current || current.browserBindingHash !== browserBindingHash || current.consumedAt || current.expiresAt <= consumedAt) return null
      const consumed = Object.freeze({ ...current, consumedAt })
      records.set(stateHash, consumed)
      return consumed
    },
    async deleteExpired() { return 0 },
  }
}

test('OIDC authorization stores only hashes and an authenticated PKCE verifier envelope', async () => {
  const authorizations = memoryAuthorizations()
  const protector = nodeOidcTransactionProtector({ APOLLO_OIDC_TRANSACTION_SECRET: 'test-only-oidc-transaction-secret-with-32-bytes' })
  const begin = beginOidcAuthorizationService({ authorizations, protector, now: () => new Date('2026-08-02T20:00:00.000Z') })
  const started = await begin({
    issuer: 'https://identity.example.test',
    clientId: 'apollo-web',
    redirectUri: 'https://apollo.example.test/v1/session/oidc/callback',
    returnTo: '/projects?view=active',
  })
  const stored = authorizations.records.get(oidcSecretHash(started.state))
  assert.equal(stored.browserBindingHash, oidcSecretHash(started.browserBinding))
  assert.equal(stored.nonceHash, oidcSecretHash(started.nonce))
  assert.equal(stored.returnTo, '/projects?view=active')
  assert.equal(stored.expiresAt, '2026-08-02T20:10:00.000Z')
  const serialized = JSON.stringify(stored)
  for (const secret of [started.state, started.browserBinding, started.nonce, started.codeVerifier]) {
    assert.equal(serialized.includes(secret), false)
  }
  assert.equal(await protector.open(stored.protectedCodeVerifier, stored.stateHash), started.codeVerifier)
})

test('OIDC authorization is browser-bound, expires and is consumed exactly once', async () => {
  const authorizations = memoryAuthorizations()
  const protector = nodeOidcTransactionProtector({ APOLLO_OIDC_TRANSACTION_SECRET: 'test-only-oidc-transaction-secret-with-32-bytes' })
  let now = new Date('2026-08-02T20:00:00.000Z')
  const begin = beginOidcAuthorizationService({ authorizations, protector, now: () => now })
  const consume = consumeOidcAuthorizationService({ authorizations, protector, now: () => now })
  const started = await begin({ issuer: 'https://identity.example.test', clientId: 'apollo-web', redirectUri: 'https://apollo.example.test/callback' })
  await assert.rejects(
    () => consume({ state: started.state, browserBinding: 'x'.repeat(43) }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  const consumed = await consume({ state: started.state, browserBinding: started.browserBinding })
  assert.equal(consumed.codeVerifier, started.codeVerifier)
  await assert.rejects(
    () => consume({ state: started.state, browserBinding: started.browserBinding }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )

  const expiring = await begin({ issuer: 'https://identity.example.test', clientId: 'apollo-web', redirectUri: 'https://apollo.example.test/callback' })
  now = new Date('2026-08-02T20:10:00.000Z')
  await assert.rejects(
    () => consume({ state: expiring.state, browserBinding: expiring.browserBinding }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})

test('OIDC PKCE envelope is bound to its state and fails closed after tampering', async () => {
  const protector = nodeOidcTransactionProtector({ APOLLO_OIDC_TRANSACTION_SECRET: 'test-only-oidc-transaction-secret-with-32-bytes' })
  const verifier = 'v'.repeat(43)
  const protectedVerifier = await protector.protect(verifier, 'a'.repeat(64))
  await assert.rejects(
    () => protector.open(protectedVerifier, 'b'.repeat(64)),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  await assert.rejects(
    () => protector.open(`${protectedVerifier.slice(0, -1)}x`, 'a'.repeat(64)),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})

test('OIDC sign-in resolves only a pre-authorized membership and creates an opaque durable session', async () => {
  const authorizations = memoryAuthorizations()
  const protector = nodeOidcTransactionProtector({ APOLLO_OIDC_TRANSACTION_SECRET: 'test-only-oidc-transaction-secret-with-32-bytes' })
  const configuration = {
    issuer: 'https://identity.example.test', clientId: 'apollo-web',
    redirectUri: 'https://apollo.example.test/login/oidc/callback', recoveryUrl: 'https://identity.example.test/recovery',
    allowInsecureLoopback: false,
  }
  const started = await beginOidcAuthorizationService({ authorizations, protector, now: () => new Date('2026-08-02T20:00:00.000Z') })({
    issuer: configuration.issuer, clientId: configuration.clientId, redirectUri: configuration.redirectUri, returnTo: '/projects',
  })
  const created = []
  const result = await signInWithOidcService({
    authorizations, protector, configuration,
    provider: { async authorizationUrl() { throw new Error('unused') }, async exchangeAndVerify(input) {
      assert.equal(input.codeVerifier, started.codeVerifier)
      assert.equal(input.expectedNonceHash, oidcSecretHash(started.nonce))
      return { issuer: configuration.issuer, subject: 'external-subject', nonce: started.nonce, issuedAt: 1, expiresAt: 2 }
    } },
    members: { async resolveActiveOidcMembership(input) {
      assert.deepEqual(input, { issuer: configuration.issuer, subjectHash: 'a'.repeat(64) })
      return { memberId: '00000000-0000-4000-8000-000000000901', workspaceId: 'workspace-1', workspaceSlug: 'workspace', workspaceName: 'Workspace', role: 'administrator', uiClientId: 'apollo-ui-client' }
    } },
    sessions: { async createSession(input) { created.push(input); return input } },
    issueSessionToken: () => 't'.repeat(43),
    hashIdentitySubject: () => 'a'.repeat(64),
    hashSessionToken: () => 'b'.repeat(64),
    now: () => new Date('2026-08-02T20:01:00.000Z'),
  })({ state: started.state, browserBinding: started.browserBinding, code: 'authorization-code-123' })
  assert.equal(result.token, 't'.repeat(43))
  assert.equal(result.redirectTo, '/projects')
  assert.equal(result.expiresAt, '2026-08-03T08:01:00.000Z')
  assert.equal(created[0].nonceHash, 'b'.repeat(64))
  assert.equal(created[0].grant.clientId, 'apollo-ui-client')
  assert.equal(created[0].subjectHash, 'a'.repeat(64))
})
