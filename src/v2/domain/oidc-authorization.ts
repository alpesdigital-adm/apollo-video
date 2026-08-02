import { createHash, randomBytes } from 'node:crypto'

import { assertDomain } from './errors.ts'

const OPAQUE_VALUE = /^[A-Za-z0-9_-]{43}$/
const HASH = /^[a-f0-9]{64}$/

export interface OidcAuthorizationMaterial {
  state: string
  browserBinding: string
  nonce: string
  codeVerifier: string
  codeChallenge: string
}

export function oidcSecretHash(value: string): string {
  assertDomain(OPAQUE_VALUE.test(value), 'INVALID_ARGUMENT', 'OIDC authorization material is invalid')
  return createHash('sha256').update(value).digest('hex')
}

export function createOidcAuthorizationMaterial(
  random: (size: number) => Buffer = randomBytes,
): Readonly<OidcAuthorizationMaterial> {
  const state = random(32).toString('base64url')
  const browserBinding = random(32).toString('base64url')
  const nonce = random(32).toString('base64url')
  const codeVerifier = random(32).toString('base64url')
  for (const value of [state, browserBinding, nonce, codeVerifier]) {
    assertDomain(OPAQUE_VALUE.test(value), 'INVALID_ARGUMENT', 'OIDC random source must produce 256-bit values')
  }
  return Object.freeze({
    state,
    browserBinding,
    nonce,
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
  })
}

export function assertOidcHash(value: string): void {
  assertDomain(HASH.test(value), 'INVALID_ARGUMENT', 'OIDC authorization hash is invalid')
}

export function safeOidcReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && value.length <= 1024
    ? value
    : '/'
}
