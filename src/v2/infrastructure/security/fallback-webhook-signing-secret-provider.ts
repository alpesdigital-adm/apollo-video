import type { WebhookSigningSecretProvider } from '../../application/ports/webhook-delivery-dispatch.ts'
import { DomainError } from '../../domain/errors.ts'

export function createFallbackWebhookSigningSecretProvider(
  primary: WebhookSigningSecretProvider,
  fallback: WebhookSigningSecretProvider,
): WebhookSigningSecretProvider {
  return Object.freeze({
    async open(request: Parameters<WebhookSigningSecretProvider['open']>[0]) {
      try {
        return await primary.open(request)
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'WEBHOOK_SECRET_UNAVAILABLE') {
          throw error
        }
        return fallback.open(request)
      }
    },
  })
}
