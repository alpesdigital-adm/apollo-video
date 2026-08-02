import assert from 'node:assert/strict'
import test from 'node:test'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { DomainError } from '../../src/v2/domain/errors.ts'
import { oidcSecretHash } from '../../src/v2/domain/oidc-authorization.ts'
import {
  createOidcProvider,
  oidcIdentitySubjectHash,
  resolveOidcProviderConfiguration,
} from '../../src/v2/infrastructure/security/oidc-provider.ts'

const now = new Date('2026-08-02T20:00:00.000Z')
const issuer = 'https://identity.example.test'
const configuration = {
  issuer,
  clientId: 'apollo-web',
  clientSecret: 'provider-client-secret',
  redirectUri: 'https://apollo.example.test/v1/session/oidc/callback',
  recoveryUrl: 'https://identity.example.test/recovery',
  allowInsecureLoopback: false,
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

async function signedIdToken({ nonce, audience = configuration.clientId, signingKey, kid = 'provider-key-1' }) {
  const issuedAt = Math.floor(now.getTime() / 1000)
  return new SignJWT({ nonce, email: 'operator@example.test', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('external-subject-123')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(signingKey)
}

test('OIDC provider uses discovery, S256 PKCE and verifies signed issuer/audience/nonce claims', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(publicKey), kid: 'provider-key-1', alg: 'RS256', use: 'sig' }
  const nonce = 'n'.repeat(43)
  const idToken = await signedIdToken({ nonce, signingKey: privateKey })
  const requests = []
  const provider = createOidcProvider({
    configuration,
    now: () => now,
    async fetch(url, init = {}) {
      requests.push({ url: url.toString(), init })
      if (url.toString() === `${issuer}/.well-known/openid-configuration`) return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      })
      if (url.toString() === `${issuer}/token`) return json({ id_token: idToken, token_type: 'Bearer' })
      if (url.toString() === `${issuer}/jwks`) return json({ keys: [jwk] })
      throw new Error(`unexpected URL ${url}`)
    },
  })
  const authorizationUrl = new URL(await provider.authorizationUrl({
    state: 's'.repeat(43), nonce, codeChallenge: 'c'.repeat(43),
  }))
  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, `${issuer}/authorize`)
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code')
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorizationUrl.searchParams.get('code_challenge'), 'c'.repeat(43))
  assert.equal(authorizationUrl.searchParams.get('nonce'), nonce)

  const claims = await provider.exchangeAndVerify({
    code: 'authorization-code-123',
    codeVerifier: 'v'.repeat(43),
    expectedNonceHash: oidcSecretHash(nonce),
  })
  assert.equal(claims.subject, 'external-subject-123')
  assert.equal(claims.email, 'operator@example.test')
  const tokenRequest = requests.find((entry) => entry.url === `${issuer}/token`)
  assert.match(tokenRequest.init.headers.get('authorization'), /^Basic /)
  assert.equal(new URLSearchParams(tokenRequest.init.body).get('code_verifier'), 'v'.repeat(43))
  assert.equal(new URLSearchParams(tokenRequest.init.body).has('client_secret'), false)
})

test('OIDC provider rejects nonce, audience and discovery issuer drift', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(publicKey), kid: 'provider-key-1', alg: 'RS256', use: 'sig' }
  const nonce = 'n'.repeat(43)
  const wrongAudienceToken = await signedIdToken({ nonce, audience: 'another-client', signingKey: privateKey })
  const providerFor = (idToken, discoveredIssuer = issuer) => createOidcProvider({
    configuration,
    now: () => now,
    async fetch(url) {
      if (url.toString().endsWith('/.well-known/openid-configuration')) return json({
        issuer: discoveredIssuer,
        authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      })
      if (url.toString().endsWith('/token')) return json({ id_token: idToken })
      return json({ keys: [jwk] })
    },
  })
  await assert.rejects(
    () => providerFor(wrongAudienceToken).exchangeAndVerify({ code: 'authorization-code-123', codeVerifier: 'v'.repeat(43), expectedNonceHash: oidcSecretHash(nonce) }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  await assert.rejects(
    () => providerFor(wrongAudienceToken, 'https://attacker.example.test').authorizationUrl({ state: 's'.repeat(43), nonce, codeChallenge: 'c'.repeat(43) }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
})

test('OIDC configuration rejects HTTP except explicit isolated loopback', () => {
  assert.throws(
    () => resolveOidcProviderConfiguration({
      APOLLO_OIDC_ISSUER: 'http://identity.example.test', APOLLO_OIDC_CLIENT_ID: 'apollo-web',
      APOLLO_OIDC_REDIRECT_URI: 'https://apollo.example.test/callback', APOLLO_OIDC_RECOVERY_URL: 'https://identity.example.test/recovery',
    }),
    (error) => error instanceof DomainError && error.code === 'AUTH_NOT_CONFIGURED',
  )
  const loopback = resolveOidcProviderConfiguration({
    APOLLO_OIDC_ISSUER: 'http://127.0.0.1:4567', APOLLO_OIDC_CLIENT_ID: 'apollo-web',
    APOLLO_OIDC_REDIRECT_URI: 'http://127.0.0.1:3333/callback', APOLLO_OIDC_RECOVERY_URL: 'http://127.0.0.1:4567/recovery',
    APOLLO_OIDC_ALLOW_INSECURE_LOOPBACK: 'true',
  })
  assert.equal(loopback.allowInsecureLoopback, true)
})

test('OIDC identity authority uses an issuer-bound one-way subject identifier', () => {
  const environment = { APOLLO_IDENTITY_HASH_SECRET: 'test-only-identity-hash-secret-at-least-32-bytes' }
  const first = oidcIdentitySubjectHash('https://identity.example.test', 'subject-123', environment)
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.notEqual(first, oidcIdentitySubjectHash('https://other.example.test', 'subject-123', environment))
  assert.equal(first.includes('subject-123'), false)
  assert.throws(
    () => oidcIdentitySubjectHash('https://identity.example.test', 'subject-123', {}),
    (error) => error instanceof DomainError && error.code === 'AUTH_NOT_CONFIGURED',
  )
})
