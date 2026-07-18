import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const UI_SESSION_COOKIE = 'apollo_ui_session'
export const UI_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60

interface SessionPayload {
  version: 1
  subject: string
  issuedAt: number
  expiresAt: number
  nonce: string
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function sessionSecret(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.APOLLO_UI_SESSION_SECRET?.trim()
  if (value && value.length >= 32) return value
  if (environment.NODE_ENV !== 'production') return 'apollo-local-session-secret-change-before-production'
  throw new Error('APOLLO_UI_SESSION_SECRET must contain at least 32 characters')
}

export function configuredUiUsername(environment: NodeJS.ProcessEnv = process.env): string {
  const username = environment.APOLLO_UI_USERNAME?.trim()
  if (username && username.length >= 3 && username.length <= 80) return username
  if (environment.NODE_ENV !== 'production') return 'leandro'
  throw new Error('APOLLO_UI_USERNAME is not configured')
}

export function createUiPasswordHash(password: string, salt = randomBytes(16).toString('base64url')): string {
  if (password.length < 12 || password.length > 256) {
    throw new Error('UI password must contain 12-256 characters')
  }
  const digest = scryptSync(password, salt, 32).toString('hex')
  return `scrypt$${salt}$${digest}`
}

export function verifyUiPassword(
  username: string,
  password: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const expectedUsername = configuredUiUsername(environment)
  const encoded = environment.APOLLO_UI_PASSWORD_HASH?.trim()
  if (!encoded) return false
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

function sign(encodedPayload: string, environment: NodeJS.ProcessEnv = process.env): string {
  return createHmac('sha256', sessionSecret(environment)).update(encodedPayload).digest('base64url')
}

export function issueUiSession(
  subject: string,
  options: {
    now?: Date
    maxAgeSeconds?: number
    environment?: NodeJS.ProcessEnv
    nonce?: string
  } = {},
): string {
  const now = options.now ?? new Date()
  const maxAgeSeconds = options.maxAgeSeconds ?? UI_SESSION_MAX_AGE_SECONDS
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 60 || maxAgeSeconds > 24 * 60 * 60) {
    throw new Error('UI session duration is invalid')
  }
  const issuedAt = Math.floor(now.getTime() / 1000)
  const payload: SessionPayload = {
    version: 1,
    subject,
    issuedAt,
    expiresAt: issuedAt + maxAgeSeconds,
    nonce: options.nonce ?? randomBytes(16).toString('base64url'),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded, options.environment)}`
}

export function verifyUiSession(
  token: string | undefined,
  options: { now?: Date; environment?: NodeJS.ProcessEnv } = {},
): Readonly<SessionPayload> | null {
  if (!token || token.length > 2048) return null
  const [encoded, signature, ...extra] = token.split('.')
  if (!encoded || !signature || extra.length > 0) return null
  try {
    if (!safeEqual(sign(encoded, options.environment), signature)) return null
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SessionPayload>
    const now = Math.floor((options.now ?? new Date()).getTime() / 1000)
    if (
      payload.version !== 1 ||
      payload.subject !== configuredUiUsername(options.environment) ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      typeof payload.nonce !== 'string' ||
      payload.nonce.length < 16 ||
      payload.issuedAt! > now + 60 ||
      payload.expiresAt! <= now ||
      payload.expiresAt! - payload.issuedAt! > 24 * 60 * 60
    ) return null
    return Object.freeze(payload as SessionPayload)
  } catch {
    return null
  }
}

export function safeUiRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  if (value === '/login' || value.startsWith('/api/auth/')) return '/'
  return value.slice(0, 1024)
}
