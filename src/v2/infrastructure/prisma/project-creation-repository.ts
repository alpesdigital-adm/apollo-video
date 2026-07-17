import {
  Prisma,
  type PrismaClient,
  type V2IdempotencyRecord,
  type V2Project,
  type V2ProjectVersion,
} from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import { DomainError } from '../../domain/errors.ts'
import { createProject, type ProjectStatus } from '../../domain/project.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import { assertUniquePublicEventIds } from '../../domain/public-event.ts'
import type {
  ProjectCreationBundle,
  ProjectCreationRepository,
  ProjectCreationResult,
} from '../../application/ports/project-creation-repository.ts'
import type { CommandActorType } from '../../domain/edit-command.ts'

interface StoredProjectCreationResponse {
  projectId: string
  versionId: string
}

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  )
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}

function parseStoredResponse(record: V2IdempotencyRecord): StoredProjectCreationResponse {
  if (record.status !== 'completed' || !record.responseJson) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Idempotent project creation is still processing or incomplete',
      { idempotencyRecordId: record.id, status: record.status },
    )
  }

  const response = JSON.parse(record.responseJson) as Partial<StoredProjectCreationResponse>
  if (!response.projectId || !response.versionId) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored idempotency response is invalid', {
      idempotencyRecordId: record.id,
    })
  }

  return { projectId: response.projectId, versionId: response.versionId }
}

function hydrateResult(
  projectRow: V2Project,
  versionRow: V2ProjectVersion,
  replayed: boolean,
): ProjectCreationResult {
  const project = createProject({
    id: projectRow.id,
    workspaceId: projectRow.workspaceId,
    name: projectRow.name,
    status: projectRow.status as ProjectStatus,
    objective: projectRow.objective ?? undefined,
    format: projectRow.format ?? undefined,
    locale: projectRow.locale ?? undefined,
    ownerId: projectRow.ownerId ?? undefined,
    currentVersionId: projectRow.currentVersionId ?? undefined,
    createdBy: {
      type: projectRow.createdByType as CommandActorType,
      id: projectRow.createdById,
    },
    createdAt: projectRow.createdAt.toISOString(),
  })
  const version = createProjectVersion({
    id: versionRow.id,
    workspaceId: versionRow.workspaceId,
    projectId: versionRow.projectId,
    sequence: versionRow.sequence,
    parentVersionId: versionRow.parentVersionId ?? undefined,
    snapshotRefs: {
      editPlan: versionRow.editPlanSnapshotId,
      policies: versionRow.policiesSnapshotId,
    },
    baseHash: versionRow.baseHash,
    createdBy: versionRow.createdBy,
    createdAt: versionRow.createdAt.toISOString(),
    commandId: versionRow.commandId ?? undefined,
  })

  return { project, version, replayed }
}

export class PrismaProjectCreationRepository implements ProjectCreationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async createOrReplay(
    bundle: ProjectCreationBundle,
    serializationAttempt = 1,
  ): Promise<ProjectCreationResult> {
    assertUniquePublicEventIds(bundle.events)
    for (const event of bundle.events) {
      if (event.workspaceId !== bundle.project.workspaceId) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Project event belongs to a different workspace',
          { eventId: event.id },
        )
      }
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const key = {
          workspaceId_clientId_key: {
            workspaceId: bundle.idempotency.workspaceId,
            clientId: bundle.idempotency.clientId,
            key: bundle.idempotency.key,
          },
        }
        const existing = await transaction.v2IdempotencyRecord.findUnique({ where: key })

        if (existing && existing.expiresAt > new Date()) {
          if (existing.requestFingerprint !== bundle.idempotency.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was already used with a different request',
              { idempotencyRecordId: existing.id },
            )
          }
          const stored = parseStoredResponse(existing)
          const [projectRow, versionRow] = await Promise.all([
            transaction.v2Project.findUnique({ where: { id: stored.projectId } }),
            transaction.v2ProjectVersion.findUnique({ where: { id: stored.versionId } }),
          ])
          if (!projectRow || !versionRow) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotency result is missing', {
              idempotencyRecordId: existing.id,
            })
          }
          return hydrateResult(projectRow, versionRow, true)
        }

        if (existing) {
          await transaction.v2IdempotencyRecord.delete({ where: { id: existing.id } })
        }

        const workspace = await transaction.v2Workspace.findUnique({
          where: { id: bundle.project.workspaceId },
          select: { id: true, status: true },
        })
        if (!workspace || workspace.status !== 'active') {
          throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found', {
            workspaceId: bundle.project.workspaceId,
          })
        }

        await transaction.v2IdempotencyRecord.create({
          data: {
            id: bundle.idempotency.id,
            workspaceId: bundle.idempotency.workspaceId,
            clientId: bundle.idempotency.clientId,
            key: bundle.idempotency.key,
            requestFingerprint: bundle.idempotency.requestFingerprint,
            status: 'processing',
            expiresAt: new Date(bundle.idempotency.expiresAt),
          },
        })
        const projectRow = await transaction.v2Project.create({
          data: {
            id: bundle.project.id,
            workspaceId: bundle.project.workspaceId,
            name: bundle.project.name,
            status: bundle.project.status,
            ownerId: bundle.project.ownerId,
            createdByType: bundle.project.createdBy.type,
            createdById: bundle.project.createdBy.id,
            createdAt: new Date(bundle.project.createdAt),
          },
        })
        await transaction.v2ProjectSnapshot.createMany({
          data: bundle.snapshots.map((snapshot) => ({
            id: snapshot.id,
            workspaceId: snapshot.workspaceId,
            projectId: snapshot.projectId,
            kind: snapshot.kind,
            schemaVersion: snapshot.contentSchemaVersion,
            contentJson: snapshot.contentJson,
            contentHash: snapshot.contentHash,
            createdAt: new Date(snapshot.createdAt),
          })),
        })
        const versionRow = await transaction.v2ProjectVersion.create({
          data: {
            id: bundle.version.id,
            workspaceId: bundle.version.workspaceId,
            projectId: bundle.version.projectId,
            sequence: bundle.version.sequence,
            parentVersionId: bundle.version.parentVersionId,
            editPlanSnapshotId: bundle.version.snapshotRefs.editPlan,
            policiesSnapshotId: bundle.version.snapshotRefs.policies,
            baseHash: bundle.version.baseHash,
            createdBy: bundle.version.createdBy,
            commandId: bundle.version.commandId,
            createdAt: new Date(bundle.version.createdAt),
          },
        })
        const updatedProject = await transaction.v2Project.update({
          where: { id: projectRow.id },
          data: { currentVersionId: versionRow.id },
        })
        await transaction.v2PublicEventOutbox.createMany({
          data: bundle.events.map((event) => ({
            id: event.id,
            workspaceId: event.workspaceId,
            type: event.type,
            version: event.version,
            occurredAt: new Date(event.occurredAt),
            sequence: event.sequence,
            actorClientId: event.actor?.clientId,
            actorUserId: event.actor?.userId,
            resourceType: event.resource.type,
            resourceId: event.resource.id,
            dataJson: JSON.stringify(event.data),
          })),
        })
        const response: StoredProjectCreationResponse = {
          projectId: updatedProject.id,
          versionId: versionRow.id,
        }
        await transaction.v2IdempotencyRecord.update({
          where: { id: bundle.idempotency.id },
          data: {
            status: 'completed',
            responseStatus: 201,
            responseJson: JSON.stringify(response),
          },
        })

        return hydrateResult(updatedProject, versionRow, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (serializationAttempt < 3) {
          return this.createOrReplay(bundle, serializationAttempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Project creation conflicted with another transaction',
        )
      }
      if (isUniqueConstraintError(error)) {
        const existing = await this.client.v2IdempotencyRecord.findUnique({
          where: {
            workspaceId_clientId_key: {
              workspaceId: bundle.idempotency.workspaceId,
              clientId: bundle.idempotency.clientId,
              key: bundle.idempotency.key,
            },
          },
        })
        if (existing) {
          if (existing.requestFingerprint !== bundle.idempotency.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was already used with a different request',
            )
          }
          const stored = parseStoredResponse(existing)
          const [projectRow, versionRow] = await Promise.all([
            this.client.v2Project.findUnique({ where: { id: stored.projectId } }),
            this.client.v2ProjectVersion.findUnique({ where: { id: stored.versionId } }),
          ])
          if (projectRow && versionRow) return hydrateResult(projectRow, versionRow, true)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Project creation could not reserve unique persistence identities',
        )
      }
      throw error
    }
  }
}
