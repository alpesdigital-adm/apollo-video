import { randomUUID } from 'node:crypto'

import {
  Prisma,
  type PrismaClient,
  type V2IdempotencyRecord,
  type V2MediaArtifactLifecycleTransition,
} from '../../../../generated/prisma-v2/index.js'

import type {
  MediaArtifactLifecycleRepository,
  MediaArtifactLifecycleTransitionBundle,
  MediaArtifactLifecycleTransitionRecord,
  MediaArtifactLifecycleTransitionResult,
} from '../../application/ports/media-artifact-lifecycle-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertMediaArtifactLifecycleTransition,
  MEDIA_ARTIFACT_LIFECYCLE_STATUSES,
  type MediaArtifactLifecycleStatus,
} from '../../domain/media-artifact.ts'
import { createPublicEvent } from '../../domain/public-event.ts'
import { persistPublicEvents } from './public-event-outbox.ts'
import { createApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ApiEnvironment } from '../../domain/api-client.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'

interface StoredResponse {
  transitionId: string
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function parseStoredResponse(record: V2IdempotencyRecord): StoredResponse {
  if (record.status !== 'completed' || !record.responseJson) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Artifact lifecycle idempotency record is incomplete',
      { idempotencyRecordId: record.id, status: record.status },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(record.responseJson)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Artifact lifecycle idempotency response is invalid')
  }
  if (
    typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 || typeof (parsed as StoredResponse).transitionId !== 'string'
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Artifact lifecycle idempotency response is invalid')
  }
  return { transitionId: (parsed as StoredResponse).transitionId }
}

function hydrateTransition(
  row: V2MediaArtifactLifecycleTransition,
): Readonly<MediaArtifactLifecycleTransitionRecord> {
  const fromStatus = row.fromStatus as MediaArtifactLifecycleStatus
  const targetStatus = row.targetStatus as MediaArtifactLifecycleStatus
  if (
    !MEDIA_ARTIFACT_LIFECYCLE_STATUSES.includes(fromStatus) ||
    !MEDIA_ARTIFACT_LIFECYCLE_STATUSES.includes(targetStatus) ||
    !Number.isSafeInteger(row.baseRevision) || row.baseRevision < 1 ||
    !Number.isSafeInteger(row.resultRevision) ||
    row.resultRevision !== row.baseRevision + (row.changed ? 1 : 0) ||
    row.changed !== (fromStatus !== targetStatus)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored media artifact lifecycle transition is invalid',
      { transitionId: row.id },
    )
  }
  try {
    assertMediaArtifactLifecycleTransition(fromStatus, targetStatus)
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored media artifact lifecycle transition is forbidden',
      { transitionId: row.id },
    )
  }
  let audit
  try {
    audit = createApiAccessAuditContext({
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
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored media artifact lifecycle audit identity is invalid',
      { transitionId: row.id },
    )
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    baseRevision: row.baseRevision,
    resultRevision: row.resultRevision,
    fromStatus,
    targetStatus,
    changed: row.changed,
    reason: row.reason,
    actorClientId: row.actorClientId,
    audit,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    createdAt: row.createdAt.toISOString(),
  })
}

export class PrismaMediaArtifactLifecycleRepository
implements MediaArtifactLifecycleRepository {
  private readonly client: PrismaClient
  private readonly createEventId: () => string

  constructor(client: PrismaClient, createEventId: () => string = randomUUID) {
    this.client = client
    this.createEventId = createEventId
  }

  async transitionOrReplay(
    bundle: MediaArtifactLifecycleTransitionBundle,
    serializationAttempt = 1,
  ): Promise<MediaArtifactLifecycleTransitionResult> {
    try {
      let canonicalAudit
      try {
        canonicalAudit = createApiAccessAuditContext({
          clientId: bundle.audit.clientId,
          credentialId: bundle.audit.credentialId,
          workspaceId: bundle.audit.workspaceId,
          environment: bundle.audit.environment,
          authenticationKind: bundle.audit.authenticationKind,
          ...(bundle.audit.delegatedUserId ? { delegatedUserId: bundle.audit.delegatedUserId } : {}),
          ...(bundle.audit.delegatedIdentityId ? { delegatedIdentityId: bundle.audit.delegatedIdentityId } : {}),
          ...(bundle.audit.workspaceRole ? { workspaceRole: bundle.audit.workspaceRole } : {}),
        })
      } catch {
        throw new DomainError('AUTH_INVALID', 'Artifact lifecycle audit identity is invalid')
      }
      if (
        bundle.audit.workspaceId !== bundle.workspaceId ||
        canonicalAudit.contextHash !== bundle.audit.contextHash
      ) {
        throw new DomainError('AUTH_INVALID', 'Artifact lifecycle audit identity is mismatched')
      }
      return await this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
        const idempotencyWhere = {
          workspaceId_clientId_key: {
            workspaceId: bundle.workspaceId,
            clientId: bundle.audit.clientId,
            key: bundle.idempotencyKey,
          },
        }
        const existing = await transaction.v2IdempotencyRecord.findUnique({
          where: idempotencyWhere,
        })
        // The application clock owns command time. Using the host wall clock here
        // makes replay semantics nondeterministic in tests and during clock skew.
        if (existing && existing.expiresAt > new Date(bundle.createdAt)) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was already used with a different artifact lifecycle request',
            )
          }
          const stored = parseStoredResponse(existing)
          const transition = await transaction.v2MediaArtifactLifecycleTransition.findUnique({
            where: { id: stored.transitionId },
          })
          if (
            !transition || transition.workspaceId !== bundle.workspaceId ||
            transition.actorClientId !== bundle.audit.clientId ||
            transition.actorContextHash !== bundle.audit.contextHash ||
            transition.idempotencyKey !== bundle.idempotencyKey ||
            transition.requestFingerprint !== bundle.requestFingerprint
          ) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Artifact lifecycle idempotency result is missing or mismatched',
            )
          }
          return { transition: hydrateTransition(transition), replayed: true }
        }
        if (existing) {
          await transaction.v2IdempotencyRecord.delete({ where: { id: existing.id } })
        }

        const workspace = await transaction.v2Workspace.findUnique({
          where: { id: bundle.workspaceId },
          select: { id: true, status: true },
        })
        if (!workspace || workspace.status !== 'active') {
          throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
        }
        const artifact = await transaction.v2MediaArtifact.findFirst({
          where: { id: bundle.artifactId, workspaceId: bundle.workspaceId },
          select: { id: true, status: true, lifecycleRevision: true },
        })
        if (!artifact) {
          throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact was not found')
        }
        const fromStatus = artifact.status as MediaArtifactLifecycleStatus
        if (!MEDIA_ARTIFACT_LIFECYCLE_STATUSES.includes(fromStatus)) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Stored media artifact status is invalid')
        }
        if (artifact.lifecycleRevision !== bundle.baseRevision) {
          throw new DomainError(
            'MEDIA_ARTIFACT_LIFECYCLE_REVISION_MISMATCH',
            'Media artifact lifecycle revision changed',
            { expectedRevision: bundle.baseRevision, currentRevision: artifact.lifecycleRevision },
          )
        }
        assertMediaArtifactLifecycleTransition(fromStatus, bundle.targetStatus)
        const changed = fromStatus !== bundle.targetStatus
        const resultRevision = bundle.baseRevision + (changed ? 1 : 0)

        await transaction.v2IdempotencyRecord.create({
          data: {
            id: bundle.idempotencyRecordId,
            workspaceId: bundle.workspaceId,
            clientId: bundle.audit.clientId,
            key: bundle.idempotencyKey,
            requestFingerprint: bundle.requestFingerprint,
            status: 'processing',
            expiresAt: new Date(bundle.idempotencyExpiresAt),
            createdAt: new Date(bundle.createdAt),
          },
        })

        if (changed) {
          const updated = await transaction.v2MediaArtifact.updateMany({
            where: {
              id: bundle.artifactId,
              workspaceId: bundle.workspaceId,
              status: fromStatus,
              lifecycleRevision: bundle.baseRevision,
            },
            data: { status: bundle.targetStatus, lifecycleRevision: { increment: 1 } },
          })
          if (updated.count !== 1) {
            throw new DomainError(
              'MEDIA_ARTIFACT_LIFECYCLE_REVISION_MISMATCH',
              'Media artifact lifecycle changed during transition',
            )
          }
        }

        const transition = await transaction.v2MediaArtifactLifecycleTransition.create({
          data: {
            id: bundle.transitionId,
            workspaceId: bundle.workspaceId,
            artifactId: bundle.artifactId,
            baseRevision: bundle.baseRevision,
            resultRevision,
            fromStatus,
            targetStatus: bundle.targetStatus,
            changed,
            reason: bundle.reason,
            actorClientId: bundle.audit.clientId,
            actorCredentialId: bundle.audit.credentialId,
            actorEnvironment: bundle.audit.environment,
            actorAuthenticationKind: bundle.audit.authenticationKind,
            actorContextHash: bundle.audit.contextHash,
            delegatedUserId: bundle.audit.delegatedUserId,
            delegatedIdentityId: bundle.audit.delegatedIdentityId,
            workspaceRole: bundle.audit.workspaceRole,
            idempotencyKey: bundle.idempotencyKey,
            requestFingerprint: bundle.requestFingerprint,
            createdAt: new Date(bundle.createdAt),
          },
        })

        if (changed && (bundle.targetStatus === 'available' || bundle.targetStatus === 'quarantined')) {
          await persistPublicEvents(transaction, [createPublicEvent({
            id: this.createEventId(),
            type: bundle.targetStatus === 'available' ? 'artifact.ready' : 'artifact.rejected',
            version: '1.0.0',
            workspaceId: bundle.workspaceId,
            occurredAt: bundle.createdAt,
            sequence: resultRevision,
            actor: {
              clientId: bundle.audit.clientId,
              ...(bundle.audit.delegatedUserId
                ? { delegatedUserId: bundle.audit.delegatedUserId }
                : {}),
            },
            resource: { type: 'media-artifact', id: bundle.artifactId },
            data: {
              fromStatus,
              status: bundle.targetStatus,
              lifecycleRevision: resultRevision,
              transitionId: transition.id,
            },
          })])
        }

        await transaction.v2IdempotencyRecord.update({
          where: { id: bundle.idempotencyRecordId },
          data: {
            status: 'completed',
            responseStatus: 201,
            responseJson: JSON.stringify({ transitionId: transition.id }),
          },
        })
        return { transition: hydrateTransition(transition), replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isSerializationConflict(error) && serializationAttempt < 3) {
        return this.transitionOrReplay(bundle, serializationAttempt + 1)
      }
      if (isSerializationConflict(error)) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Media artifact lifecycle transition conflicted with another transaction',
        )
      }
      if (isUniqueConstraintError(error)) {
        const existing = await this.client.v2IdempotencyRecord.findUnique({
          where: {
            workspaceId_clientId_key: {
              workspaceId: bundle.workspaceId,
              clientId: bundle.audit.clientId,
              key: bundle.idempotencyKey,
            },
          },
        })
        if (existing) return this.transitionOrReplay(bundle, serializationAttempt)
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Media artifact lifecycle transition identity collided',
        )
      }
      throw error
    }
  }
}
