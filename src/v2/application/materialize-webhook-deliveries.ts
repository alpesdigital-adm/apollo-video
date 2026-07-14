import { assertDomain } from '../domain/errors.ts'
import type { WebhookFanoutRepository } from './ports/webhook-fanout-repository.ts'

export function materializeNextWebhookEventService(dependencies: {
  repository: WebhookFanoutRepository
  clock: () => Date
}) {
  return async function execute(request: { workspaceId: string; maxAttempts?: number }) {
    const workspaceId = request.workspaceId.trim()
    assertDomain(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(workspaceId),
      'INVALID_WEBHOOK',
      'Webhook fan-out workspaceId is invalid',
    )
    const maxAttempts = request.maxAttempts ?? 8
    assertDomain(
      Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 20,
      'INVALID_WEBHOOK',
      'Webhook delivery maxAttempts must be between 1 and 20',
    )
    const publishedAt = dependencies.clock()
    assertDomain(
      !Number.isNaN(publishedAt.getTime()),
      'INVALID_WEBHOOK',
      'Webhook fan-out clock is invalid',
    )
    return dependencies.repository.materializeNext({
      workspaceId,
      maxAttempts,
      publishedAt: publishedAt.toISOString(),
    })
  }
}
