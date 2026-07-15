import type { WebhookEndpointCommandRepository } from './ports/webhook-endpoint-command-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { WebhookEndpointMutableStatus } from '../domain/webhook.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MUTABLE_STATUSES = ['active', 'suspended', 'revoked'] as const

export function setWebhookEndpointStatusService(dependencies: {
  repository: WebhookEndpointCommandRepository
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function setWebhookEndpointStatus(request: {
    workspaceId: string
    endpointId: string
    status: string
    baseRevision: string
  }) {
    const workspaceId = request.workspaceId.trim()
    const endpointId = request.endpointId.trim().toLowerCase()
    const status = request.status.trim() as WebhookEndpointMutableStatus
    const baseRevision = request.baseRevision.trim().toLowerCase()
    assertDomain(
      SAFE_ID_PATTERN.test(workspaceId) && UUID_V4_PATTERN.test(endpointId),
      'INVALID_ARGUMENT',
      'Webhook endpoint identity is invalid',
    )
    assertDomain(
      MUTABLE_STATUSES.includes(status) && SHA256_PATTERN.test(baseRevision),
      'INVALID_ARGUMENT',
      'Webhook endpoint status or baseRevision is invalid',
    )
    const changedAt = clock()
    assertDomain(!Number.isNaN(changedAt.getTime()), 'INVALID_ARGUMENT', 'Webhook endpoint command clock is invalid')
    const result = await dependencies.repository.setStatus({
      workspaceId,
      endpointId,
      targetStatus: status,
      baseRevision,
      changedAt: changedAt.toISOString(),
    })
    if (!result) throw new DomainError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint was not found')
    return result
  }
}
