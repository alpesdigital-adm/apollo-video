import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

import { DomainError } from '../../domain/errors.ts'
import type { ApolloUiSession } from '../../domain/ui-session.ts'

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

function sessionSecret(environment: NodeJS.ProcessEnv): string {
  return requiredEnvironmentValue('APOLLO_UI_SESSION_SECRET', environment, 32)
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

function sign(payload: string, environment: NodeJS.ProcessEnv): string {
  return createHmac('sha256', sessionSecret(environment)).update(payload).digest('base64url')
}

export function issueUiSession(
  subject: string,
  clientId: string,
  options: {
    now?: Date
    maxAgeSeconds?: number
    environment?: NodeJS.ProcessEnv
    nonce?: string
  } = {},
): string {
  const environment = options.environment ?? process.env
  const now = options.now ?? new Date()
  const maxAgeSeconds = options.maxAgeSeconds ?? APOLLO_SESSION_MAX_AGE_SECONDS
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 60 || maxAgeSeconds > 24 * 60 * 60) {
    throw new DomainError('INVALID_ARGUMENT', 'UI session duration is invalid')
  }
  const issuedAt = Math.floor(now.getTime() / 1000)
  const payload: ApolloUiSession = {
    version: 1,
    subject,
    clientId,
    issuedAt,
    expiresAt: issuedAt + maxAgeSeconds,
    nonce: options.nonce ?? randomBytes(16).toString('base64url'),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded, environment)}`
}

export function verifyUiSession(
  token: string | undefined,
  options: { now?: Date; environment?: NodeJS.ProcessEnv } = {},
): Readonly<ApolloUiSession> | null {
  if (!token || token.length > 2048) return null
  const environment = options.environment ?? process.env
  const [encoded, signature, ...extra] = token.split('.')
  if (!encoded || !signature || extra.length > 0) return null
  try {
    if (!safeEqual(sign(encoded, environment), signature)) return null
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<ApolloUiSession>
    const now = Math.floor((options.now ?? new Date()).getTime() / 1000)
    if (
      payload.version !== 1 ||
      payload.subject !== configuredUiUsername(environment) ||
      payload.clientId !== configuredUiApiClientId(environment) ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      typeof payload.nonce !== 'string' ||
      payload.nonce.length < 16 ||
      payload.issuedAt! > now + 60 ||
      payload.expiresAt! <= now ||
      payload.expiresAt! - payload.issuedAt! > 24 * 60 * 60
    ) return null
    return Object.freeze(payload as ApolloUiSession)
  } catch {
    return null
  }
}

export function safeUiRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  if (value === '/login' || value.startsWith('/v1/session')) return '/'
  return value.slice(0, 1024)
}
