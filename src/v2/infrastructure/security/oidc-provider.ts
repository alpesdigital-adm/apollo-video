import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'

import type {
  OidcProvider,
  OidcProviderClaims,
  OidcProviderConfiguration,
} from '../../application/ports/oidc-provider.ts'
import { DomainError } from '../../domain/errors.ts'
import { oidcSecretHash } from '../../domain/oidc-authorization.ts'

const MAX_DOCUMENT_BYTES = 1024 * 1024
const AUTHORIZATION_CODE = /^[A-Za-z0-9._~-]{8,2048}$/
const PKCE_VALUE = /^[A-Za-z0-9_-]{43}$/
export const APOLLO_OIDC_BINDING_COOKIE = 'apollo_oidc_binding'

export type HumanAuthenticationMode = 'oidc' | 'bootstrap' | 'unavailable'

export function resolveHumanAuthenticationMode(environment: NodeJS.ProcessEnv = process.env): HumanAuthenticationMode {
  if (environment.APOLLO_AUTH_MODE === 'oidc') return 'oidc'
  if (environment.APOLLO_AUTH_MODE === 'bootstrap' && environment.APOLLO_ALLOW_BOOTSTRAP_AUTH === 'true') return 'bootstrap'
  return 'unavailable'
}

interface OidcDiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  response_types_supported?: unknown
  code_challenge_methods_supported?: unknown
  token_endpoint_auth_methods_supported?: unknown
}

function bool(value: string | undefined): boolean {
  return value === 'true'
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function safeEndpoint(value: string, allowInsecureLoopback: boolean, label: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new DomainError('AUTH_NOT_CONFIGURED', `${label} is invalid`) }
  if (url.username || url.password || url.hash) throw new DomainError('AUTH_NOT_CONFIGURED', `${label} is invalid`)
  if (url.protocol !== 'https:' && !(allowInsecureLoopback && url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new DomainError('AUTH_NOT_CONFIGURED', `${label} must use HTTPS`)
  }
  return url
}

export function resolveOidcProviderConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<OidcProviderConfiguration> {
  const allowInsecureLoopback = bool(environment.APOLLO_OIDC_ALLOW_INSECURE_LOOPBACK)
  const issuer = environment.APOLLO_OIDC_ISSUER
  const clientId = environment.APOLLO_OIDC_CLIENT_ID
  const redirectUri = environment.APOLLO_OIDC_REDIRECT_URI
  const recoveryUrl = environment.APOLLO_OIDC_RECOVERY_URL
  if (!issuer || !clientId || !redirectUri || !recoveryUrl || clientId.length > 256) {
    throw new DomainError('AUTH_NOT_CONFIGURED', 'OIDC provider is not configured')
  }
  const issuerUrl = safeEndpoint(issuer, allowInsecureLoopback, 'OIDC issuer')
  if (issuerUrl.search || issuerUrl.pathname === '/') issuerUrl.pathname = issuerUrl.pathname.replace(/\/$/, '')
  const redirect = safeEndpoint(redirectUri, allowInsecureLoopback, 'OIDC redirect URI')
  const recovery = safeEndpoint(recoveryUrl, allowInsecureLoopback, 'OIDC recovery URL')
  return Object.freeze({
    issuer: issuerUrl.toString().replace(/\/$/, ''),
    clientId,
    ...(environment.APOLLO_OIDC_CLIENT_SECRET ? { clientSecret: environment.APOLLO_OIDC_CLIENT_SECRET } : {}),
    redirectUri: redirect.toString(),
    recoveryUrl: recovery.toString(),
    allowInsecureLoopback,
  })
}

export function oidcIdentitySubjectHash(
  issuer: string,
  subject: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const secret = environment.APOLLO_IDENTITY_HASH_SECRET
  if (!secret || secret.length < 32) throw new DomainError('AUTH_NOT_CONFIGURED', 'OIDC identity hashing is not configured')
  if (issuer.length < 1 || issuer.length > 512 || subject.length < 1 || subject.length > 512) {
    throw new DomainError('AUTH_INVALID', 'OIDC identity is invalid')
  }
  return createHmac('sha256', secret).update(issuer).update('\0').update(subject).digest('hex')
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
  if (!response.ok || contentType !== 'application/json') throw new DomainError('AUTH_INVALID', `${label} request failed`)
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new DomainError('AUTH_INVALID', `${label} response is too large`)
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new DomainError('AUTH_INVALID', `${label} response is invalid`)
  }
}

function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function createOidcProvider(dependencies: {
  configuration: Readonly<OidcProviderConfiguration>
  fetch?: typeof fetch
  now?: () => Date
}): OidcProvider {
  const configuration = dependencies.configuration
  const request = dependencies.fetch ?? fetch

  async function getJson(url: URL, label: string, init?: RequestInit) {
    safeEndpoint(url.toString(), configuration.allowInsecureLoopback, label)
    try {
      const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), ...init })
      return readJson(response, label)
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError('AUTH_INVALID', `${label} is unavailable`)
    }
  }

  async function discovery(): Promise<OidcDiscoveryDocument> {
    const issuer = safeEndpoint(configuration.issuer, configuration.allowInsecureLoopback, 'OIDC issuer')
    const path = `${issuer.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`
    const document = await getJson(new URL(path, issuer), 'OIDC discovery')
    if (
      document.issuer !== configuration.issuer ||
      typeof document.authorization_endpoint !== 'string' ||
      typeof document.token_endpoint !== 'string' ||
      typeof document.jwks_uri !== 'string'
    ) throw new DomainError('AUTH_INVALID', 'OIDC discovery does not match the configured issuer')
    safeEndpoint(document.authorization_endpoint, configuration.allowInsecureLoopback, 'OIDC authorization endpoint')
    safeEndpoint(document.token_endpoint, configuration.allowInsecureLoopback, 'OIDC token endpoint')
    safeEndpoint(document.jwks_uri, configuration.allowInsecureLoopback, 'OIDC JWKS endpoint')
    if (
      Array.isArray(document.response_types_supported) && !document.response_types_supported.includes('code') ||
      Array.isArray(document.code_challenge_methods_supported) && !document.code_challenge_methods_supported.includes('S256')
    ) throw new DomainError('AUTH_INVALID', 'OIDC provider does not support Authorization Code with S256 PKCE')
    return document as unknown as OidcDiscoveryDocument
  }

  return Object.freeze({
    async authorizationUrl(input: Parameters<OidcProvider['authorizationUrl']>[0]) {
      if (![input.state, input.nonce, input.codeChallenge].every((value) => PKCE_VALUE.test(value))) {
        throw new DomainError('INVALID_ARGUMENT', 'OIDC authorization material is invalid')
      }
      const document = await discovery()
      const url = new URL(document.authorization_endpoint)
      url.searchParams.set('client_id', configuration.clientId)
      url.searchParams.set('redirect_uri', configuration.redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', 'openid email')
      url.searchParams.set('state', input.state)
      url.searchParams.set('nonce', input.nonce)
      url.searchParams.set('code_challenge', input.codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    },

    async exchangeAndVerify(input: Parameters<OidcProvider['exchangeAndVerify']>[0]) {
      if (!AUTHORIZATION_CODE.test(input.code) || !PKCE_VALUE.test(input.codeVerifier) || !/^[a-f0-9]{64}$/.test(input.expectedNonceHash)) {
        throw new DomainError('AUTH_INVALID', 'OIDC callback material is invalid')
      }
      const document = await discovery()
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: configuration.clientId,
        redirect_uri: configuration.redirectUri,
        code_verifier: input.codeVerifier,
      })
      const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' })
      if (configuration.clientSecret) {
        headers.set('authorization', `Basic ${Buffer.from(`${configuration.clientId}:${configuration.clientSecret}`).toString('base64')}`)
      }
      const token = await getJson(new URL(document.token_endpoint), 'OIDC token', { method: 'POST', headers, body: form })
      if (typeof token.id_token !== 'string' || token.id_token.length > 16_384) {
        throw new DomainError('AUTH_INVALID', 'OIDC token response does not contain a valid ID token')
      }
      const jwksDocument = await getJson(new URL(document.jwks_uri), 'OIDC JWKS')
      if (!Array.isArray(jwksDocument.keys) || jwksDocument.keys.length < 1 || jwksDocument.keys.length > 20) {
        throw new DomainError('AUTH_INVALID', 'OIDC JWKS is invalid')
      }
      try {
        const result = await jwtVerify(token.id_token, createLocalJWKSet(jwksDocument as unknown as JSONWebKeySet), {
          issuer: configuration.issuer,
          audience: configuration.clientId,
          algorithms: ['RS256', 'PS256', 'ES256'],
          clockTolerance: 5,
          currentDate: dependencies.now?.() ?? new Date(),
          maxTokenAge: '10 minutes',
        })
        const claims = result.payload
        if (
          typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 512 ||
          typeof claims.nonce !== 'string' ||
          !hashesEqual(oidcSecretHash(claims.nonce), input.expectedNonceHash) ||
          typeof claims.iat !== 'number' || typeof claims.exp !== 'number'
        ) throw new DomainError('AUTH_INVALID', 'OIDC ID token claims are invalid')
        return Object.freeze({
          issuer: configuration.issuer,
          subject: claims.sub,
          nonce: claims.nonce,
          issuedAt: claims.iat,
          expiresAt: claims.exp,
          ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
          ...(typeof claims.email_verified === 'boolean' ? { emailVerified: claims.email_verified } : {}),
        } satisfies OidcProviderClaims)
      } catch (error) {
        if (error instanceof DomainError) throw error
        throw new DomainError('AUTH_INVALID', 'OIDC ID token verification failed')
      }
    },
  })
}
