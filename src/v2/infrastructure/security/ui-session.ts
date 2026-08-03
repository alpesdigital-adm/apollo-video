import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

import { DomainError } from '../../domain/errors.ts'
import { assertWorkspaceMemberRole, type WorkspaceMemberRole } from '../../domain/workspace-member.ts'

export const APOLLO_SESSION_COOKIE = 'apollo_session'
export const APOLLO_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function requiredEnvironmentValue(
  name: string,
  environment: NodeJS.ProcessEnv,
  minimumLength: number,
): string {
  const value = environment[name]?.trim()
  if (!value || value.length < minimumLength) {
    throw new DomainError('AUTH_NOT_CONFIGURED', `${name} is not configured`)
  }
  return value
}

export function configuredUiUsername(environment: NodeJS.ProcessEnv = process.env): string {
  const value = requiredEnvironmentValue('APOLLO_UI_USERNAME', environment, 3)
  if (value.length > 80) throw new DomainError('AUTH_NOT_CONFIGURED', 'APOLLO_UI_USERNAME is invalid')
  return value
}

export function configuredUiApiClientId(environment: NodeJS.ProcessEnv = process.env): string {
  const value = requiredEnvironmentValue('APOLLO_UI_API_CLIENT_ID', environment, 3)
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(value)) {
    throw new DomainError('AUTH_NOT_CONFIGURED', 'APOLLO_UI_API_CLIENT_ID is invalid')
  }
  return value
}

export function configuredUiBootstrapRole(environment: NodeJS.ProcessEnv = process.env): WorkspaceMemberRole {
  const value = requiredEnvironmentValue('APOLLO_UI_BOOTSTRAP_ROLE', environment, 3)
  try {
    assertWorkspaceMemberRole(value)
    return value
  } catch {
    throw new DomainError('AUTH_NOT_CONFIGURED', 'APOLLO_UI_BOOTSTRAP_ROLE is invalid')
  }
}

function sessionSecret(environment: NodeJS.ProcessEnv): string {
  return requiredEnvironmentValue('APOLLO_UI_SESSION_SECRET', environment, 32)
}

export function uiSessionNonceHash(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex')
}

export function deriveUiSessionRotationToken(
  currentToken: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!verifyUiSession(currentToken)) throw new DomainError('INVALID_ARGUMENT', 'UI session token is invalid')
  return createHmac('sha256', sessionSecret(environment))
    .update(`session-rotation:${currentToken}`)
    .digest('base64url')
}

export function uiSessionSubjectHash(subject: string, environment: NodeJS.ProcessEnv = process.env): string {
  return createHmac('sha256', sessionSecret(environment)).update(`subject:${subject}`).digest('hex')
}

export function uiLoginThrottleKey(
  clientIdentifier: string,
  username: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const source = clientIdentifier.trim().slice(0, 256) || 'unknown'
  void username
  return createHmac('sha256', sessionSecret(environment)).update(`login-source:${source}`).digest('hex')
}

export function createUiPasswordHash(
  password: string,
  salt = randomBytes(16).toString('base64url'),
): string {
  if (password.length < 12 || password.length > 256) {
    throw new DomainError('INVALID_ARGUMENT', 'UI password must contain 12-256 characters')
  }
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString('hex')}`
}

export function verifyUiPassword(
  username: string,
  password: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const expectedUsername = configuredUiUsername(environment)
  const encoded = requiredEnvironmentValue('APOLLO_UI_PASSWORD_HASH', environment, 10)
  const [algorithm, salt, expectedHash, ...extra] = encoded.split('$')
  if (
    algorithm !== 'scrypt' ||
    !salt ||
    !/^[a-f0-9]{64}$/.test(expectedHash ?? '') ||
    extra.length > 0 ||
    password.length > 256
  ) return false
  const actualHash = scryptSync(password, salt, 32).toString('hex')
  return safeEqual(username, expectedUsername) && safeEqual(actualHash, expectedHash)
}

export function issueUiSession(
  options: { token?: string } = {},
): string {
  const token = options.token ?? randomBytes(32).toString('base64url')
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError('INVALID_ARGUMENT', 'UI session token is invalid')
  return token
}

export function verifyUiSession(
  token: string | undefined,
): string | null {
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}

export function safeUiRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  if (value === '/login' || value.startsWith('/v1/session')) return '/'
  return value.slice(0, 1024)
}

export function isTrustedUiMutationOrigin(input: Readonly<{
  origin: string | null
  host: string | null
  protocol: string | null
  fetchSite: string | null
}>): boolean {
  if (!input.origin || !input.host || (input.fetchSite && input.fetchSite !== 'same-origin')) return false
  if (input.protocol !== 'http' && input.protocol !== 'https') return false
  try {
    return new URL(input.origin).origin === `${input.protocol}://${input.host}`
  } catch {
    return false
  }
}
