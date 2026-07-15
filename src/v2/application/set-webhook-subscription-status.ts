import type { WebhookSubscriptionCommandRepository } from './ports/webhook-subscription-command-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { WebhookSubscriptionMutableStatus } from '../domain/webhook.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MUTABLE_STATUSES = ['active', 'paused', 'revoked'] as const

export function setWebhookSubscriptionStatusService(dependencies: {
  repository: WebhookSubscriptionCommandRepository
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function setWebhookSubscriptionStatus(request: {
    workspaceId: string
    subscriptionId: string
    status: string
    baseRevision: string
  }) {
    const workspaceId = request.workspaceId.trim()
    const subscriptionId = request.subscriptionId.trim().toLowerCase()
    const status = request.status.trim() as WebhookSubscriptionMutableStatus
    const baseRevision = request.baseRevision.trim().toLowerCase()
    assertDomain(
      SAFE_ID_PATTERN.test(workspaceId) && UUID_V4_PATTERN.test(subscriptionId),
      'INVALID_ARGUMENT',
      'Webhook subscription identity is invalid',
    )
    assertDomain(
      MUTABLE_STATUSES.includes(status) && SHA256_PATTERN.test(baseRevision),
      'INVALID_ARGUMENT',
      'Webhook subscription status or baseRevision is invalid',
    )
    const changedAt = clock()
    assertDomain(
      !Number.isNaN(changedAt.getTime()),
      'INVALID_ARGUMENT',
      'Webhook subscription command clock is invalid',
    )
    const result = await dependencies.repository.setStatus({
      workspaceId,
      subscriptionId,
      targetStatus: status,
      baseRevision,
      changedAt: changedAt.toISOString(),
    })
    if (!result) {
      throw new DomainError(
        'WEBHOOK_SUBSCRIPTION_NOT_FOUND',
        'Webhook subscription was not found',
      )
    }
    return result
  }
}
