import { createHash, randomBytes } from 'node:crypto'

import type { RecipeParameterCipher } from '../../application/ports/recipe-parameter-cipher.ts'
import type { WebhookSigningSecretProtector } from '../../application/ports/webhook-signing-secret-protector.ts'
import { DomainError } from '../../domain/errors.ts'
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
  async function protect(
    request: Parameters<WebhookSigningSecretProtector['protect']>[0],
    disclose: boolean,
  ) {
    const secret = generateSecret()
    try {
      if (secret.length !== 32) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Generated webhook signing secret has an invalid size',
        )
      }
      const secretBase64url = secret.toString('base64url')
      const fingerprint = createHash('sha256').update(secret).digest('hex')
      const sealed = await cipher.seal(
        secretBase64url,
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
        ...(disclose ? { secretBase64url } : {}),
      })
    } finally {
      secret.fill(0)
    }
  }

  return Object.freeze({
    async protect(request: Parameters<WebhookSigningSecretProtector['protect']>[0]) {
      return protect(request, false)
    },
    async protectForOneTimeDisclosure(
      request: Parameters<WebhookSigningSecretProtector['protectForOneTimeDisclosure']>[0],
    ) {
      const material = await protect(request, true)
      return Object.freeze({
        fingerprint: material.fingerprint,
        payload: material.payload,
        secretBase64url: material.secretBase64url!,
      })
    },
  })
}
