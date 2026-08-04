import { createApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ApiEnvironment } from '../../domain/api-client.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createWebhookAdministrationCommand,
  type WebhookAdministrationCommand,
} from '../../domain/webhook-administration-command.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'

export interface StoredWebhookAdministrationCommand {
  id: string
  workspaceId: string
  action: string
  targetType: string
  targetId: string
  endpointId: string | null
  targetStatus: string | null
  actorClientId: string
  actorCredentialId: string
  actorEnvironment: string
  actorAuthenticationKind: string
  actorContextHash: string
  delegatedUserId: string | null
  delegatedIdentityId: string | null
  workspaceRole: string | null
  idempotencyKey: string | null
  baseRevision: string | null
  requestFingerprint: string
  occurredAt: Date
}

export function hydrateWebhookAdministrationCommand(
  row: StoredWebhookAdministrationCommand,
): Readonly<WebhookAdministrationCommand> {
  try {
    const audit = createApiAccessAuditContext({
      clientId: row.actorClientId,
      credentialId: row.actorCredentialId,
      workspaceId: row.workspaceId,
      environment: row.actorEnvironment as ApiEnvironment,
      authenticationKind: row.actorAuthenticationKind as 'bearer' | 'ui-session',
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
      ...(row.delegatedIdentityId ? { delegatedIdentityId: row.delegatedIdentityId } : {}),
      ...(row.workspaceRole ? { workspaceRole: row.workspaceRole as WorkspaceMemberRole } : {}),
    })
    if (audit.contextHash !== row.actorContextHash) throw new Error('context hash mismatch')
    return createWebhookAdministrationCommand({
      id: row.id,
      workspaceId: row.workspaceId,
      action: row.action as WebhookAdministrationCommand['action'],
      targetType: row.targetType as WebhookAdministrationCommand['targetType'],
      targetId: row.targetId,
      ...(row.endpointId ? { endpointId: row.endpointId } : {}),
      ...(row.targetStatus ? { targetStatus: row.targetStatus } : {}),
      audit,
      ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
      ...(row.baseRevision ? { baseRevision: row.baseRevision } : {}),
      requestFingerprint: row.requestFingerprint,
      occurredAt: row.occurredAt.toISOString(),
    })
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored webhook administration audit command is invalid',
      { commandId: row.id },
    )
  }
}

export function webhookAdministrationCommandData(
  command: WebhookAdministrationCommand,
) {
  return {
    id: command.id,
    workspaceId: command.workspaceId,
    action: command.action,
    targetType: command.targetType,
    targetId: command.targetId,
    endpointId: command.endpointId,
    targetStatus: command.targetStatus,
    actorClientId: command.audit.clientId,
    actorCredentialId: command.audit.credentialId,
    actorEnvironment: command.audit.environment,
    actorAuthenticationKind: command.audit.authenticationKind,
    actorContextHash: command.audit.contextHash,
    delegatedUserId: command.audit.delegatedUserId,
    delegatedIdentityId: command.audit.delegatedIdentityId,
    workspaceRole: command.audit.workspaceRole,
    idempotencyKey: command.idempotencyKey,
    baseRevision: command.baseRevision,
    requestFingerprint: command.requestFingerprint,
    occurredAt: new Date(command.occurredAt),
  }
}

export function assertWebhookAdministrationCommandTarget(
  command: WebhookAdministrationCommand,
  expected: Readonly<{
    action: WebhookAdministrationCommand['action']
    targetType: WebhookAdministrationCommand['targetType']
    targetId: string
    endpointId?: string
    targetStatus?: string
    workspaceId: string
    requestFingerprint: string
    idempotencyKey?: string
    baseRevision?: string
  }>,
): void {
  if (
    command.action !== expected.action || command.targetType !== expected.targetType ||
    command.targetId !== expected.targetId || command.workspaceId !== expected.workspaceId ||
    command.endpointId !== expected.endpointId ||
    command.targetStatus !== expected.targetStatus ||
    command.requestFingerprint !== expected.requestFingerprint ||
    command.idempotencyKey !== expected.idempotencyKey ||
    command.baseRevision !== expected.baseRevision
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Webhook administration command does not match its mutation',
    )
  }
}

export function assertWebhookAdministrationReplay(
  row: StoredWebhookAdministrationCommand | null,
  requested: WebhookAdministrationCommand,
): void {
  if (!row) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Webhook administration replay is missing its audit command',
    )
  }
  const stored = hydrateWebhookAdministrationCommand(row)
  if (
    stored.action !== requested.action || stored.targetType !== requested.targetType ||
    (stored.idempotencyKey === undefined && stored.targetId !== requested.targetId) ||
    stored.endpointId !== requested.endpointId ||
    stored.targetStatus !== requested.targetStatus ||
    stored.audit.contextHash !== requested.audit.contextHash ||
    stored.idempotencyKey !== requested.idempotencyKey ||
    stored.baseRevision !== requested.baseRevision ||
    stored.requestFingerprint !== requested.requestFingerprint
  ) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Webhook administration replay belongs to a different actor or request',
    )
  }
}
