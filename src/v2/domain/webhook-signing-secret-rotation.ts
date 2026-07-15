import { assertDomain } from './errors.ts'

export const WEBHOOK_SIGNING_SECRET_ROTATION_STATUSES = [
  'staged',
  'activated',
  'cancelled',
  'expired',
] as const

export type WebhookSigningSecretRotationStatus =
  (typeof WEBHOOK_SIGNING_SECRET_ROTATION_STATUSES)[number]

export interface WebhookSigningSecretRotation {
  schemaVersion: 1
  id: string
  workspaceId: string
  endpointId: string
  requestedByClientId: string
  previousSecretId: string
  candidateSecretId: string
  candidateVersion: number
  algorithm: 'hmac-sha256'
  keyRef: string
  fingerprint: string
  status: WebhookSigningSecretRotationStatus
  overlapSeconds: number
  baseRevision: string
  createdAt: string
  expiresAt: string
  activatedAt?: string
  overlapUntil?: string
  cancelledAt?: string
}

function canonicalUtc(value: string, field: string): string {
  const parsed = new Date(value)
  assertDomain(!Number.isNaN(parsed.getTime()), 'INVALID_ARGUMENT', `${field} must be an ISO timestamp`)
  return parsed.toISOString()
}

export function createWebhookSigningSecretRotation(
  input: Omit<WebhookSigningSecretRotation, 'schemaVersion' | 'algorithm'>,
): Readonly<WebhookSigningSecretRotation> {
  const createdAt = canonicalUtc(input.createdAt, 'createdAt')
  const expiresAt = canonicalUtc(input.expiresAt, 'expiresAt')
  const activatedAt = input.activatedAt ? canonicalUtc(input.activatedAt, 'activatedAt') : undefined
  const overlapUntil = input.overlapUntil ? canonicalUtc(input.overlapUntil, 'overlapUntil') : undefined
  const cancelledAt = input.cancelledAt ? canonicalUtc(input.cancelledAt, 'cancelledAt') : undefined
  assertDomain(
    WEBHOOK_SIGNING_SECRET_ROTATION_STATUSES.includes(input.status),
    'INVALID_ARGUMENT',
    'Webhook signing secret rotation status is invalid',
  )
  assertDomain(
    Number.isInteger(input.candidateVersion) && input.candidateVersion > 0,
    'INVALID_ARGUMENT',
    'Webhook signing secret rotation version is invalid',
  )
  assertDomain(
    Number.isInteger(input.overlapSeconds) && input.overlapSeconds >= 60 && input.overlapSeconds <= 86_400,
    'INVALID_ARGUMENT',
    'Webhook signing secret rotation overlap must be between 60 and 86400 seconds',
  )
  assertDomain(expiresAt > createdAt, 'INVALID_ARGUMENT', 'Webhook signing secret rotation expiry is invalid')
  assertDomain(/^[a-f0-9]{64}$/.test(input.fingerprint), 'INVALID_ARGUMENT', 'Webhook signing secret fingerprint is invalid')
  assertDomain(/^[a-f0-9]{64}$/.test(input.baseRevision), 'INVALID_ARGUMENT', 'Webhook endpoint base revision is invalid')
  assertDomain(
    (input.status === 'staged' && !activatedAt && !overlapUntil && !cancelledAt) ||
      (input.status === 'activated' && Boolean(activatedAt) && Boolean(overlapUntil) && overlapUntil! > activatedAt! && !cancelledAt) ||
      ((input.status === 'cancelled' || input.status === 'expired') && !activatedAt && !overlapUntil && Boolean(cancelledAt)),
    'INVALID_ARGUMENT',
    'Webhook signing secret rotation lifecycle is invalid',
  )
  return Object.freeze({
    schemaVersion: 1,
    ...input,
    algorithm: 'hmac-sha256',
    createdAt,
    expiresAt,
    ...(activatedAt ? { activatedAt } : {}),
    ...(overlapUntil ? { overlapUntil } : {}),
    ...(cancelledAt ? { cancelledAt } : {}),
  })
}
