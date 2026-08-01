import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedVersionCompareDecision,
  VersionCompareDecisionCommit,
  VersionCompareDecisionResult,
  VersionCompareRepository,
} from '../../application/ports/version-compare-repository.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { parseCompareActionImpact } from '../../domain/compare-action-impact.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type StoredCompareCommand = Prisma.V2EditCommandGetPayload<{
  include: { baseVersion: true }
}>

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function hydrateDecision(
  row: StoredCompareCommand,
  replayed: boolean,
): VersionCompareDecisionResult {
  if (row.type !== 'compare-action') {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored version comparison command is inconsistent')
  }
  const scope = parseRecord(row.scopeJson, 'version comparison scope') as EditScope
  const payload = parseRecord(
    row.payloadJson,
    'version comparison payload',
  ) as unknown as PersistedVersionCompareDecision
  // Fail-closed on schemaVersion: a payload without an explicit impact document
  // (the pre-impact schemaVersion 1) is never hydrated as if it had none.
  if (
    payload.schemaVersion !== 2 ||
    !['accept', 'reopen'].includes(payload.action) ||
    !['toggle', 'split', 'overlay'].includes(payload.mode) ||
    !Number.isInteger(payload.expectedRevision) ||
    typeof payload.comparison !== 'object' ||
    payload.comparison === null
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored version comparison payload is invalid')
  }
  const impact = parseCompareActionImpact(payload.impact)
  if (
    impact.commandId !== row.id ||
    impact.baseVersionId !== row.baseVersionId ||
    impact.resultVersionId !== row.baseVersionId ||
    impact.action !== payload.action
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored version comparison impact belongs to another decision')
  }
  const command = createEditCommand<PersistedVersionCompareDecision>({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    baseVersionId: row.baseVersionId,
    baseHash: row.baseHash,
    author: {
      type: row.actorType as 'user' | 'director' | 'system' | 'api-client',
      id: row.actorId,
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
    },
    type: row.type,
    scope,
    payload,
    ...(row.reason ? { reason: row.reason } : {}),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  })
  return Object.freeze({
    command,
    projectStatus: payload.action === 'accept' ? 'reviewing-proxy' : 'revising',
    comparison: payload.comparison,
    impact,
    replayed,
  })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaVersionCompareRepository implements VersionCompareRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async findIdempotentDecision(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2EditCommand.findUnique({
      where: { workspaceId_projectId_idempotencyKey: input },
      include: { baseVersion: true },
    })
    if (!row) return null
    if (row.type !== 'compare-action') {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key belongs to another command type',
      )
    }
    return Object.freeze({
      requestFingerprint: row.requestFingerprint,
      result: hydrateDecision(row, true),
    })
  }

  async commitDecision(
    bundle: VersionCompareDecisionCommit,
    serializationAttempt = 1,
  ): Promise<VersionCompareDecisionResult> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const key = {
          workspaceId_projectId_idempotencyKey: {
            workspaceId: bundle.command.workspaceId,
            projectId: bundle.command.projectId,
            idempotencyKey: bundle.command.idempotencyKey,
          },
        }
        const existing = await transaction.v2EditCommand.findUnique({
          where: key,
          include: { baseVersion: true },
        })
        if (existing) {
          if (
            existing.type !== 'compare-action' ||
            existing.requestFingerprint !== bundle.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different version comparison decision',
            )
          }
          return hydrateDecision(existing, true)
        }
        const project = await transaction.v2Project.findFirst({
          where: {
            id: bundle.command.projectId,
            workspaceId: bundle.command.workspaceId,
          },
          include: { currentVersion: true },
        })
        if (
          !project?.currentVersion ||
          project.currentVersion.id !== bundle.command.baseVersionId ||
          project.currentVersion.baseHash !== bundle.command.baseHash ||
          project.currentVersion.sequence !== bundle.command.payload.expectedRevision ||
          bundle.command.payload.afterVersionId !== project.currentVersion.id
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Project version changed before compare decision commit',
            project?.currentVersion
              ? {
                  currentVersionId: project.currentVersion.id,
                  currentBaseHash: project.currentVersion.baseHash,
                  currentRevision: project.currentVersion.sequence,
                }
              : undefined,
          )
        }
        await transaction.v2EditCommand.create({
          data: {
            id: bundle.command.id,
            workspaceId: bundle.command.workspaceId,
            projectId: bundle.command.projectId,
            baseVersionId: bundle.command.baseVersionId,
            baseHash: bundle.command.baseHash,
            type: bundle.command.type,
            scopeJson: stableSerialize(bundle.command.scope),
            payloadJson: stableSerialize(bundle.command.payload),
            reason: bundle.command.reason,
            actorType: bundle.command.author.type,
            actorId: bundle.command.author.id,
            delegatedUserId: bundle.command.author.delegatedUserId,
            idempotencyKey: bundle.command.idempotencyKey,
            requestFingerprint: bundle.requestFingerprint,
            createdAt: new Date(bundle.command.createdAt),
          },
        })
        const updated = await transaction.v2Project.updateMany({
          where: {
            id: bundle.command.projectId,
            workspaceId: bundle.command.workspaceId,
            currentVersionId: bundle.command.baseVersionId,
          },
          data: { status: bundle.projectStatus },
        })
        if (updated.count !== 1) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Project current version changed during compare decision commit',
          )
        }
        await transaction.v2PublicEventOutbox.create({
          data: {
            id: bundle.event.id,
            workspaceId: bundle.event.workspaceId,
            type: bundle.event.type,
            version: bundle.event.version,
            occurredAt: new Date(bundle.event.occurredAt),
            sequence: bundle.event.sequence,
            actorClientId: bundle.event.actor?.clientId,
            actorUserId: bundle.event.actor?.userId,
            resourceType: bundle.event.resource.type,
            resourceId: bundle.event.resource.id,
            dataJson: stableSerialize(bundle.event.data),
          },
        })
        const stored = await transaction.v2EditCommand.findUniqueOrThrow({
          where: { id: bundle.command.id },
          include: { baseVersion: true },
        })
        return hydrateDecision(stored, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) {
        return this.commitDecision(bundle, serializationAttempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const existing = await this.findIdempotentDecision({
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          idempotencyKey: bundle.command.idempotencyKey,
        })
        if (existing) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different version comparison decision',
            )
          }
          return Object.freeze({ ...existing.result, replayed: true })
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Version comparison decision collided with persisted state',
        )
      }
      throw error
    }
  }
}
