import type { WebhookDeliveryQueryRepository } from './ports/webhook-delivery-query-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function readWebhookDeliveryService(dependencies: {
  deliveries: WebhookDeliveryQueryRepository
}) {
  return async function readWebhookDelivery(request: {
    workspaceId: string
    deliveryId: string
  }) {
    const workspaceId = request.workspaceId.trim()
    const deliveryId = request.deliveryId.trim().toLowerCase()
    assertDomain(
      SAFE_ID_PATTERN.test(workspaceId) && UUID_V4_PATTERN.test(deliveryId),
      'INVALID_ARGUMENT',
      'Webhook delivery identity is invalid',
    )
    const diagnostic = await dependencies.deliveries.findDiagnosticById(workspaceId, deliveryId)
    if (!diagnostic) {
      throw new DomainError('WEBHOOK_DELIVERY_NOT_FOUND', 'Webhook delivery was not found')
    }
    return diagnostic
  }
}
