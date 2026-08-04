import {
  assertApiAccessAuditBinding,
  type ApiAccessAuditContext,
} from './api-access-control.ts'
import { assertDomain } from './errors.ts'

export const WEBHOOK_ADMINISTRATION_ACTIONS = [
  'webhook-endpoint.create',
  'webhook-endpoint.status.set',
  'webhook-endpoint.challenge',
  'webhook-subscription.create',
  'webhook-subscription.status.set',
  'webhook-signing-secret.provision',
  'webhook-signing-secret-rotation.stage',
  'webhook-signing-secret-rotation.activate',
  'webhook-signing-secret-rotation.cancel',
  'webhook-delivery.replay',
  'webhook-event.replay',
] as const

export const WEBHOOK_ADMINISTRATION_TARGET_TYPES = [
  'webhook-endpoint',
  'webhook-subscription',
  'webhook-signing-secret',
  'webhook-signing-secret-rotation',
  'webhook-delivery',
  'webhook-event',
] as const

export type WebhookAdministrationAction =
  (typeof WEBHOOK_ADMINISTRATION_ACTIONS)[number]
export type WebhookAdministrationTargetType =
  (typeof WEBHOOK_ADMINISTRATION_TARGET_TYPES)[number]

export interface WebhookAdministrationCommand {
  readonly schemaVersion: 1
  readonly id: string
  readonly workspaceId: string
  readonly action: WebhookAdministrationAction
  readonly targetType: WebhookAdministrationTargetType
  readonly targetId: string
  readonly endpointId?: string
  readonly targetStatus?: string
  readonly audit: Readonly<ApiAccessAuditContext>
  readonly idempotencyKey?: string
  readonly baseRevision?: string
  readonly requestFingerprint: string
  readonly occurredAt: string
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const VISIBLE_ASCII = /^[\x21-\x7e]+$/

function actionTargetType(
  action: WebhookAdministrationAction,
): WebhookAdministrationTargetType {
  return action.startsWith('webhook-endpoint.')
    ? 'webhook-endpoint'
    : action.startsWith('webhook-subscription.')
      ? 'webhook-subscription'
      : action.startsWith('webhook-signing-secret-rotation.')
        ? 'webhook-signing-secret-rotation'
        : action.startsWith('webhook-signing-secret.')
          ? 'webhook-signing-secret'
          : action.startsWith('webhook-delivery.')
            ? 'webhook-delivery'
            : 'webhook-event'
}

export function createWebhookAdministrationCommand(
  input: Omit<WebhookAdministrationCommand, 'schemaVersion'>,
): Readonly<WebhookAdministrationCommand> {
  assertDomain(
    UUID_V4_PATTERN.test(input.id) && UUID_V4_PATTERN.test(input.targetId) &&
      SAFE_ID_PATTERN.test(input.workspaceId),
    'INVALID_ARGUMENT',
    'Webhook administration command identity is invalid',
  )
  assertDomain(
    WEBHOOK_ADMINISTRATION_ACTIONS.includes(input.action) &&
      WEBHOOK_ADMINISTRATION_TARGET_TYPES.includes(input.targetType) &&
      actionTargetType(input.action) === input.targetType,
    'INVALID_ARGUMENT',
    'Webhook administration action and target do not match',
  )
  assertApiAccessAuditBinding({
    workspaceId: input.workspaceId,
    actorClientId: input.audit.clientId,
    delegatedUserId: input.audit.delegatedUserId,
  }, input.audit)

  const isSigningAction = input.action.startsWith('webhook-signing-secret')
  assertDomain(
    isSigningAction
      ? input.endpointId !== undefined && UUID_V4_PATTERN.test(input.endpointId)
      : input.endpointId === undefined,
    'INVALID_ARGUMENT',
    'Webhook administration endpoint binding is invalid',
  )

  const isCreation = input.action.endsWith('.create')
  const isReplay = input.action.endsWith('.replay')
  const isChallenge = input.action === 'webhook-endpoint.challenge'
  const isIdempotent = isCreation || isReplay || input.action.endsWith('.provision') || input.action.endsWith('.stage')
  const requiresBaseRevision = !isCreation && !isReplay && !isChallenge
  assertDomain(
    (isIdempotent ? Boolean(input.idempotencyKey) : input.idempotencyKey === undefined) &&
      (requiresBaseRevision ? Boolean(input.baseRevision) : input.baseRevision === undefined),
    'INVALID_ARGUMENT',
    'Webhook administration replay semantics are invalid',
  )
  const allowedTargetStatuses = isChallenge
    ? ['active']
    : input.action === 'webhook-endpoint.status.set'
    ? ['active', 'suspended', 'revoked']
    : input.action === 'webhook-subscription.status.set'
      ? ['active', 'paused', 'revoked']
      : []
  assertDomain(
    isCreation || isSigningAction || isReplay
      ? input.targetStatus === undefined
      : typeof input.targetStatus === 'string' && allowedTargetStatuses.includes(input.targetStatus),
    'INVALID_ARGUMENT',
    'Webhook administration target status is invalid',
  )
  if (input.idempotencyKey !== undefined) {
    assertDomain(
      input.idempotencyKey.length <= 128 && VISIBLE_ASCII.test(input.idempotencyKey),
      'INVALID_ARGUMENT',
      'Webhook administration idempotency key is invalid',
    )
  }
  assertDomain(
    HASH_PATTERN.test(input.requestFingerprint) &&
      (input.baseRevision === undefined || HASH_PATTERN.test(input.baseRevision)),
    'INVALID_ARGUMENT',
    'Webhook administration command hash is invalid',
  )
  const occurredAt = new Date(input.occurredAt)
  assertDomain(
    !Number.isNaN(occurredAt.getTime()) && occurredAt.toISOString() === input.occurredAt,
    'INVALID_ARGUMENT',
    'Webhook administration command time is invalid',
  )

  return Object.freeze({ ...input, schemaVersion: 1 as const })
}
