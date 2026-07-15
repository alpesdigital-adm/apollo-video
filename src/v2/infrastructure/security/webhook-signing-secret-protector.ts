import { createHash, randomBytes } from 'node:crypto'

import type { RecipeParameterCipher } from '../../application/ports/recipe-parameter-cipher.ts'
import type { WebhookSigningSecretProtector } from '../../application/ports/webhook-signing-secret-protector.ts'
import { createWebhookSigningSecretPayload } from '../../domain/webhook-signing-secret-payload.ts'

export function webhookSigningSecretCipherContext(input: {
  secretId: string
  workspaceId: string
  endpointId: string
  version: number
  keyRef: string
}): string {
  return `apollo-webhook-signing-secret/v1:${input.workspaceId}:${input.endpointId}:${input.secretId}:${input.version}:${input.keyRef}`
}

export function createWebhookSigningSecretProtector(
  cipher: RecipeParameterCipher,
  generateSecret: () => Buffer = () => randomBytes(32),
): WebhookSigningSecretProtector {
  return Object.freeze({
    async protect(request: Parameters<WebhookSigningSecretProtector['protect']>[0]) {
      const secret = generateSecret()
      try {
        const fingerprint = createHash('sha256').update(secret).digest('hex')
        const sealed = await cipher.seal(
          secret.toString('base64url'),
          webhookSigningSecretCipherContext(request),
        )
        return Object.freeze({
          fingerprint,
          payload: createWebhookSigningSecretPayload({
            secretId: request.secretId,
            workspaceId: request.workspaceId,
            endpointId: request.endpointId,
            secretVersion: request.version,
            keyId: sealed.keyId,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            authTag: sealed.authTag,
            createdAt: request.createdAt,
          }),
        })
      } finally {
        secret.fill(0)
      }
    },
  })
}
