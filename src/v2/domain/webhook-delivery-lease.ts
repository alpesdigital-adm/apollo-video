import { createHash, randomBytes } from 'node:crypto'

import { assertDomain } from './errors.ts'

const LEASE_TOKEN_PATTERN = /^whl_[A-Za-z0-9_-]{43}$/

export function issueWebhookDeliveryLeaseToken(
  random: (size: number) => Buffer = randomBytes,
): Readonly<{ token: string; tokenHash: string }> {
  const bytes = random(32)
  assertDomain(bytes.length === 32, 'INVALID_WEBHOOK', 'Webhook lease entropy is invalid')
  const token = `whl_${bytes.toString('base64url')}`
  return Object.freeze({ token, tokenHash: hashWebhookDeliveryLeaseToken(token) })
}

export function hashWebhookDeliveryLeaseToken(token: string): string {
  assertDomain(
    LEASE_TOKEN_PATTERN.test(token),
    'WEBHOOK_LEASE_REJECTED',
    'Webhook delivery lease token is invalid',
  )
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
