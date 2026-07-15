import { createHash } from 'node:crypto'

import type { PublicCapability } from './capability-registry.ts'
import type { ApiClient } from '../domain/api-client.ts'
import type { ApiCredential } from '../domain/api-credential.ts'
import type { MediaArtifactRecord } from '../application/ports/media-artifact-query-repository.ts'
import type { PublicOperation } from '../domain/public-operation.ts'
import type {
  WebhookDeliveryDiagnosticRecord,
  WebhookDeliverySummaryRecord,
} from '../application/ports/webhook-delivery-query-repository.ts'
import type { WebhookEventReplayItem } from '../application/ports/webhook-event-replay-repository.ts'
import type {
  WebhookEndpointDetailRecord,
  WebhookEndpointSummaryRecord,
  WebhookSigningSecretMetadata,
} from '../application/ports/webhook-administration-query-repository.ts'
import {
  webhookSubscriptionRevision,
  type WebhookSubscription,
} from '../domain/webhook.ts'

export const PUBLIC_API_VERSION = 'v1' as const

export interface PublicSuccess<T> {
  data: T
  meta: {
    apiVersion: typeof PUBLIC_API_VERSION
  }
}
export function presentSuccess<T>(data: T): PublicSuccess<T> {
  return {
    data,
    meta: { apiVersion: PUBLIC_API_VERSION },
  }
}

export function presentCapability(capability: PublicCapability) {
  return {
    id: capability.id,
    version: capability.version,
    title: capability.title,
    description: capability.description,
    operationKind: capability.operationKind,
    authMode: capability.authMode,
    requiredScopes: [...capability.requiredScopes],
    inputSchemaRef: capability.inputSchemaRef,
    outputSchemaRef: capability.outputSchemaRef,
    endpoint: capability.endpoint,
    toolName: capability.toolName,
    supportsDryRun: capability.supportsDryRun,
    costClass: capability.costClass,
    confirmation: capability.confirmation,
    successStatuses: [...capability.successStatuses],
    idempotency: capability.idempotency,
    queryParameters: capability.queryParameters?.map((parameter) => ({
      ...parameter,
      schema: { ...parameter.schema },
    })),
    requestBodyRequired: capability.inputSchemaRef
      ? capability.requestBodyRequired ?? true
      : undefined,
    responseMediaType: capability.responseMediaType ?? 'application/json',
  }
}

export function presentApiClient(client: ApiClient) {
  return {
    id: client.id,
    workspaceId: client.workspaceId,
    name: client.name,
    status: client.status,
    environment: client.environment,
    scopes: [...client.scopes],
    createdAt: client.createdAt,
    lastUsedAt: client.lastUsedAt,
  }
}

export function presentApiCredential(credential: ApiCredential) {
  return {
    id: credential.id,
    clientId: credential.clientId,
    status: credential.status,
    createdAt: credential.createdAt,
    expiresAt: credential.expiresAt,
    lastUsedAt: credential.lastUsedAt,
    revokedAt: credential.revokedAt,
  }
}

export function presentMediaArtifact(artifact: MediaArtifactRecord) {
  return {
    artifact: {
      id: artifact.id,
      workspaceId: artifact.workspaceId,
      artifactKey: artifact.artifactKey,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize.toString(),
      mediaType: artifact.mediaType,
      container: artifact.container,
      status: artifact.status,
      createdAt: artifact.createdAt,
    },
    manifests: artifact.manifests.map((manifest) => ({
      id: manifest.id,
      schemaVersion: manifest.schemaVersion,
      manifestHash: manifest.manifestHash,
      recipe: {
        id: manifest.recipe.id,
        version: manifest.recipe.version,
        parametersHash: manifest.recipe.parametersHash,
      },
      ...(manifest.probe ? { probe: { ...manifest.probe } } : {}),
      sources: manifest.sources.map((source) => ({
        artifactId: source.artifactId,
        artifactKey: source.artifactKey,
        sha256: source.sha256,
        role: source.role,
        ordinal: source.ordinal,
      })),
      createdAt: manifest.createdAt,
    })),
  }
}

export function presentPublicOperation(operation: PublicOperation) {
  return {
    schemaVersion: operation.schemaVersion,
    id: operation.id,
    type: operation.type,
    status: operation.status,
    phase: operation.phase,
    ...(operation.progress ? { progress: { ...operation.progress } } : {}),
    cancelable: operation.cancelable,
    retryable: operation.retryable,
    target: { ...operation.target },
    ...(operation.result
      ? { result: { resource: { ...operation.result.resource } } }
      : {}),
    ...(operation.error ? { error: { ...operation.error } } : {}),
    attempt: operation.attempt,
    maxAttempts: operation.maxAttempts,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
    ...(operation.completedAt ? { completedAt: operation.completedAt } : {}),
  }
}

export function presentWebhookDeliverySummary(record: WebhookDeliverySummaryRecord) {
  const delivery = record.delivery
  return {
    schemaVersion: 'webhook-delivery/v1' as const,
    id: delivery.id,
    endpointId: record.endpointId,
    subscriptionId: delivery.subscriptionId,
    eventId: delivery.eventId,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    maxAttempts: delivery.maxAttempts,
    nextAttemptAt: delivery.nextAttemptAt,
    createdAt: delivery.createdAt,
    ...(delivery.completedAt ? { completedAt: delivery.completedAt } : {}),
    ...(delivery.deadLetteredAt ? { deadLetteredAt: delivery.deadLetteredAt } : {}),
  }
}

export function presentWebhookDeliveryDiagnostic(record: WebhookDeliveryDiagnosticRecord) {
  return {
    ...presentWebhookDeliverySummary(record),
    attempts: record.attempts.map((attempt) => ({
      schemaVersion: 'webhook-delivery-attempt/v1' as const,
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      scheduledAt: attempt.scheduledAt,
      createdAt: attempt.createdAt,
      ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
      ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
      ...(attempt.responseStatus !== undefined
        ? { responseStatus: attempt.responseStatus }
        : {}),
      ...(attempt.responseBodyHash ? { responseBodyHash: attempt.responseBodyHash } : {}),
      ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
    })),
  }
}

export function presentWebhookEventReplayItem(item: Readonly<WebhookEventReplayItem>) {
  return {
    status: item.status,
    delivery: presentWebhookDeliverySummary(item.delivery),
  }
}

function presentWebhookSecretMetadata(secret: Readonly<WebhookSigningSecretMetadata>) {
  return {
    version: secret.version,
    fingerprint: secret.fingerprint,
    status: secret.status,
    createdAt: secret.createdAt,
    ...(secret.retiredAt ? { retiredAt: secret.retiredAt } : {}),
    ...(secret.revokedAt ? { revokedAt: secret.revokedAt } : {}),
  }
}

export function presentWebhookEndpointSummary(record: Readonly<WebhookEndpointSummaryRecord>) {
  const endpoint = record.endpoint
  return {
    schemaVersion: 'webhook-endpoint/v1' as const,
    id: endpoint.id,
    status: endpoint.status,
    destinationOrigin: new URL(endpoint.url).origin,
    urlFingerprint: createHash('sha256').update(endpoint.url).digest('hex'),
    createdByClientId: endpoint.createdByClientId,
    createdAt: endpoint.createdAt,
    ...(endpoint.verifiedAt ? { verifiedAt: endpoint.verifiedAt } : {}),
    ...(endpoint.suspendedAt ? { suspendedAt: endpoint.suspendedAt } : {}),
    ...(endpoint.revokedAt ? { revokedAt: endpoint.revokedAt } : {}),
    ...(record.currentSecret
      ? { currentSigningSecret: presentWebhookSecretMetadata(record.currentSecret) }
      : {}),
  }
}

export function presentWebhookEndpointDetail(record: Readonly<WebhookEndpointDetailRecord>) {
  return {
    ...presentWebhookEndpointSummary(record),
    signingSecrets: record.signingSecrets.map(presentWebhookSecretMetadata),
  }
}

export function presentWebhookSubscription(subscription: Readonly<WebhookSubscription>) {
  return {
    schemaVersion: 'webhook-subscription/v1' as const,
    id: subscription.id,
    endpointId: subscription.endpointId,
    status: subscription.status,
    revision: webhookSubscriptionRevision(subscription),
    eventTypes: [...subscription.filter.eventTypes],
    ...(subscription.filter.resourceIds ? { resourceIds: [...subscription.filter.resourceIds] } : {}),
    createdByClientId: subscription.createdByClientId,
    createdAt: subscription.createdAt,
    ...(subscription.pausedAt ? { pausedAt: subscription.pausedAt } : {}),
    ...(subscription.revokedAt ? { revokedAt: subscription.revokedAt } : {}),
  }
}
