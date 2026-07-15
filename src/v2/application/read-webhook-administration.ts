import type { WebhookAdministrationQueryRepository } from './ports/webhook-administration-query-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function identity(workspaceId: string, resourceId: string) {
  const workspace = workspaceId.trim()
  const resource = resourceId.trim().toLowerCase()
  assertDomain(SAFE_ID_PATTERN.test(workspace) && UUID_V4_PATTERN.test(resource), 'INVALID_ARGUMENT', 'Webhook administration identity is invalid')
  return { workspaceId: workspace, resourceId: resource }
}

export function readWebhookEndpointService(dependencies: { repository: WebhookAdministrationQueryRepository }) {
  return async (request: { workspaceId: string; endpointId: string }) => {
    const value = identity(request.workspaceId, request.endpointId)
    const record = await dependencies.repository.findEndpointById(value.workspaceId, value.resourceId)
    if (!record) throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
    return record
  }
}

export function readWebhookSubscriptionService(dependencies: { repository: WebhookAdministrationQueryRepository }) {
  return async (request: { workspaceId: string; subscriptionId: string }) => {
    const value = identity(request.workspaceId, request.subscriptionId)
    const record = await dependencies.repository.findSubscriptionById(value.workspaceId, value.resourceId)
    if (!record) throw new DomainError('WEBHOOK_SUBSCRIPTION_NOT_FOUND', 'Webhook subscription was not found')
    return record
  }
}

export function readWebhookSigningSecretRotationService(dependencies: { repository: WebhookAdministrationQueryRepository }) {
  return async (request: { workspaceId: string; endpointId: string; rotationId: string }) => {
    const endpoint = identity(request.workspaceId, request.endpointId)
    const rotation = identity(request.workspaceId, request.rotationId)
    const record = await dependencies.repository.findSigningSecretRotationById(
      endpoint.workspaceId,
      endpoint.resourceId,
      rotation.resourceId,
    )
    if (!record) throw new DomainError('WEBHOOK_SIGNING_SECRET_ROTATION_NOT_FOUND', 'Webhook signing secret rotation was not found')
    return record
  }
}
