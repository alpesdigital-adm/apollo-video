import { assertDomain } from './errors.ts'

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const SAFE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface WebhookSigningSecretPayload {
  schemaVersion: 1
  secretId: string
  workspaceId: string
  endpointId: string
  secretVersion: number
  algorithm: 'aes-256-gcm'
  keyId: string
  nonce: string
  ciphertext: string
  authTag: string
  createdAt: string
}

export function createWebhookSigningSecretPayload(
  input: Omit<WebhookSigningSecretPayload, 'schemaVersion' | 'algorithm'>,
): Readonly<WebhookSigningSecretPayload> {
  const createdAt = new Date(input.createdAt)
  assertDomain(!Number.isNaN(createdAt.getTime()), 'INVALID_WEBHOOK', 'Webhook secret payload clock is invalid')
  assertDomain(Number.isSafeInteger(input.secretVersion) && input.secretVersion >= 1, 'INVALID_WEBHOOK', 'Webhook secret payload version is invalid')
  assertDomain(SAFE_TOKEN_PATTERN.test(input.keyId), 'INVALID_WEBHOOK', 'Webhook secret payload key ID is invalid')
  for (const [name, value, maximum] of [
    ['nonce', input.nonce, 64],
    ['ciphertext', input.ciphertext, 1_024],
    ['authTag', input.authTag, 64],
  ] as const) {
    assertDomain(value.length >= 16 && value.length <= maximum && BASE64URL_PATTERN.test(value), 'INVALID_WEBHOOK', `Webhook secret payload ${name} is invalid`)
  }
  return Object.freeze({
    schemaVersion: 1,
    secretId: input.secretId,
    workspaceId: input.workspaceId,
    endpointId: input.endpointId,
    secretVersion: input.secretVersion,
    algorithm: 'aes-256-gcm',
    keyId: input.keyId,
    nonce: input.nonce,
    ciphertext: input.ciphertext,
    authTag: input.authTag,
    createdAt: createdAt.toISOString(),
  })
}
