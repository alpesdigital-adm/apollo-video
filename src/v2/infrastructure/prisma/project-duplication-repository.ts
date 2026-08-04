import {
  Prisma,
  type PrismaClient,
  type V2IdempotencyRecord,
  type V2Project,
  type V2ProjectVersion,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ProjectDuplicationBundle,
  ProjectDuplicationRepository,
  ProjectDuplicationResult,
} from '../../application/ports/project-duplication-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import type { CommandActorType } from '../../domain/edit-command.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import { DomainError } from '../../domain/errors.ts'
import { createProject, type ProjectStatus } from '../../domain/project.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  assertProjectCreationCommand,
  projectCreationCommandData,
} from './project-creation-command-persistence.ts'
import { readCompletedIdempotencyResponse } from './idempotency-record-persistence.ts'

interface StoredDuplicationResponse {
  projectId: string
  versionId: string
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function parseStoredResponse(
  record: V2IdempotencyRecord,
  requestFingerprint: string,
): StoredDuplicationResponse {
  const value = readCompletedIdempotencyResponse(
    record,
    requestFingerprint,
  )
  if (
    typeof value !== 'object' ||
    value === null ||
    !('projectId' in value) ||
    !('versionId' in value) ||
    typeof value.projectId !== 'string' ||
    typeof value.versionId !== 'string'
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored project duplication response is invalid',
    )
  }
  return { projectId: value.projectId, versionId: value.versionId }
}

function hydrateProject(row: V2Project) {
  return createProject({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status as ProjectStatus,
    ...(row.objective ? { objective: row.objective } : {}),
    ...(row.format ? { format: row.format } : {}),
    ...(row.locale ? { locale: row.locale } : {}),
    ...(row.ownerId ? { ownerId: row.ownerId } : {}),
    ...(row.currentVersionId
      ? { currentVersionId: row.currentVersionId }
      : {}),
    ...(row.duplicatedFromProjectId
      ? { duplicatedFromProjectId: row.duplicatedFromProjectId }
      : {}),
    createdBy: {
      type: row.createdByType as CommandActorType,
      id: row.createdById,
    },
    createdAt: row.createdAt.toISOString(),
  })
}

function hydrateVersion(row: V2ProjectVersion) {
  return createProjectVersion({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sequence: row.sequence,
    ...(row.parentVersionId
      ? { parentVersionId: row.parentVersionId }
      : {}),
    ...(row.forkedFromProjectId
      ? { forkedFromProjectId: row.forkedFromProjectId }
      : {}),
    ...(row.forkedFromVersionId
      ? { forkedFromVersionId: row.forkedFromVersionId }
      : {}),
    snapshotRefs: {
      brief: row.briefSnapshotId,
      ...(row.treatmentSnapshotId
        ? { treatment: row.treatmentSnapshotId }
        : {}),
      ...(row.storySnapshotId ? { story: row.storySnapshotId } : {}),
      editPlan: row.editPlanSnapshotId,
      policies: row.policiesSnapshotId,
    },
    baseHash: row.baseHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    ...(row.commandId ? { commandId: row.commandId } : {}),
  })
}

async function hydrateResult(
  client: Prisma.TransactionClient | PrismaClient,
  ids: StoredDuplicationResponse,
  replayed: boolean,
  audit: Readonly<ApiAccessAuditContext>,
  requestFingerprint: string,
): Promise<Readonly<ProjectDuplicationResult>> {
  const [project, version, media, command] = await Promise.all([
    client.v2Project.findUnique({ where: { id: ids.projectId } }),
    client.v2ProjectVersion.findUnique({ where: { id: ids.versionId } }),
    client.v2ProjectMediaAsset.findMany({
      where: { projectId: ids.projectId },
      orderBy: [{ role: 'asc' }, { artifactId: 'asc' }],
      select: { artifactId: true },
    }),
    client.v2ProjectCreationCommand.findUnique({
      where: { projectId_workspaceId: {
        projectId: ids.projectId,
        workspaceId: audit.workspaceId,
      } },
    }),
  ])
  if (
    !project ||
    !version ||
    project.currentVersionId !== version.id ||
    project.duplicatedFromProjectId === null ||
    version.forkedFromProjectId !== project.duplicatedFromProjectId ||
    version.forkedFromVersionId === null
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored project duplication result is inconsistent',
    )
  }
  assertProjectCreationCommand(command, {
    workspaceId: project.workspaceId,
    action: 'duplicate',
    projectId: project.id,
    versionId: version.id,
    sourceProjectId: project.duplicatedFromProjectId,
    sourceVersionId: version.forkedFromVersionId,
    audit,
    requestFingerprint,
  })
  return Object.freeze({
    project: hydrateProject(project),
    version: hydrateVersion(version),
    sharedArtifactIds: Object.freeze(
      [...new Set(media.map((item) => item.artifactId))],
    ),
    copiedBytes: 0 as const,
    replayed,
  })
}

export class PrismaProjectDuplicationRepository
implements ProjectDuplicationRepository {
  constructor(
    private readonly client: PrismaClient = getV2PostgresClient(),
  ) {}

  async findIdempotent(input: {
    workspaceId: string
    clientId: string
    key: string
    requestFingerprint: string
    audit: Readonly<ApiAccessAuditContext>
  }) {
    const record = await this.client.v2IdempotencyRecord.findUnique({
      where: {
        workspaceId_clientId_key: {
          workspaceId: input.workspaceId,
          clientId: input.clientId,
          key: input.key,
        },
      },
    })
    if (!record || record.expiresAt <= new Date()) return null
    return hydrateResult(
      this.client,
      parseStoredResponse(record, input.requestFingerprint),
      true,
      input.audit,
      input.requestFingerprint,
    )
  }

  async readSource(input: {
    workspaceId: string
    projectId: string
  }) {
    const project = await this.client.v2Project.findFirst({
      where: {
        id: input.projectId,
        workspaceId: input.workspaceId,
      },
      include: {
        currentVersion: true,
        mediaAssets: {
          orderBy: [{ role: 'asc' }, { artifactId: 'asc' }],
          select: {
            artifactId: true,
            role: true,
            originalFileName: true,
          },
        },
      },
    })
    if (!project?.currentVersion) return null
    return Object.freeze({
      project: hydrateProject(project),
      version: hydrateVersion(project.currentVersion),
      media: Object.freeze(project.mediaAssets.map((item) =>
        Object.freeze({ ...item }))),
    })
  }

  async duplicateOrReplay(
    bundle: Readonly<ProjectDuplicationBundle>,
    attempt = 1,
  ): Promise<Readonly<ProjectDuplicationResult>> {
    if (
      bundle.auditCommand.action !== 'duplicate' ||
      bundle.auditCommand.workspaceId !== bundle.project.workspaceId ||
      bundle.auditCommand.projectId !== bundle.project.id ||
      bundle.auditCommand.versionId !== bundle.version.id ||
      bundle.auditCommand.sourceProjectId !== bundle.sourceProjectId ||
      bundle.auditCommand.sourceVersionId !== bundle.sourceVersionId ||
      bundle.auditCommand.requestFingerprint !== bundle.idempotency.requestFingerprint ||
      bundle.auditCommand.audit.clientId !== bundle.idempotency.clientId
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Project duplication audit command is invalid')
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
        const existing = await transaction.v2IdempotencyRecord.findUnique({
          where: key,
        })
        if (existing && existing.expiresAt > new Date()) {
          return hydrateResult(
            transaction,
            parseStoredResponse(
              existing,
              bundle.idempotency.requestFingerprint,
            ),
            true,
            bundle.auditCommand.audit,
            bundle.idempotency.requestFingerprint,
          )
        }
        if (existing) {
          await transaction.v2IdempotencyRecord.delete({
            where: { id: existing.id },
          })
        }
        const [sourceProject, sourceVersion, client, sourceMedia] =
          await Promise.all([
            transaction.v2Project.findUnique({
              where: { id: bundle.sourceProjectId },
            }),
            transaction.v2ProjectVersion.findUnique({
              where: { id: bundle.sourceVersionId },
            }),
            transaction.v2ApiClient.findUnique({
              where: { id: bundle.idempotency.clientId },
            }),
            transaction.v2ProjectMediaAsset.findMany({
              where: {
                workspaceId: bundle.project.workspaceId,
                projectId: bundle.sourceProjectId,
              },
              orderBy: [{ role: 'asc' }, { artifactId: 'asc' }],
              select: {
                artifactId: true,
                role: true,
                originalFileName: true,
              },
            }),
          ])
        if (
          !sourceProject ||
          sourceProject.workspaceId !== bundle.project.workspaceId ||
          sourceProject.currentVersionId !== bundle.sourceVersionId ||
          !sourceVersion ||
          sourceVersion.workspaceId !== bundle.project.workspaceId ||
          sourceVersion.projectId !== sourceProject.id ||
          sourceVersion.baseHash !== bundle.sourceVersionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Source project changed during duplication',
          )
        }
        if (
          !client ||
          client.workspaceId !== bundle.project.workspaceId ||
          client.status !== 'active'
        ) {
          throw new DomainError(
            'AUTH_INVALID',
            'Active project duplication client was not found',
          )
        }
        if (
          bundle.project.duplicatedFromProjectId !== sourceProject.id ||
          bundle.version.forkedFromProjectId !== sourceProject.id ||
          bundle.version.forkedFromVersionId !== sourceVersion.id ||
          bundle.version.projectId !== bundle.project.id ||
          bundle.project.currentVersionId !== bundle.version.id
        ) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Project duplication lineage is invalid',
          )
        }
        const sourceSnapshotRefs = {
          brief: sourceVersion.briefSnapshotId,
          ...(sourceVersion.treatmentSnapshotId
            ? { treatment: sourceVersion.treatmentSnapshotId }
            : {}),
          ...(sourceVersion.storySnapshotId
            ? { story: sourceVersion.storySnapshotId }
            : {}),
          editPlan: sourceVersion.editPlanSnapshotId,
          policies: sourceVersion.policiesSnapshotId,
        }
        if (
          stableSerialize(bundle.version.snapshotRefs) !==
          stableSerialize(sourceSnapshotRefs)
        ) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Project duplication must share the exact immutable snapshots',
          )
        }
        const requestedMedia = bundle.media
          .map(({ artifactId, role, originalFileName }) => ({
            artifactId,
            role,
            originalFileName,
          }))
          .sort((left, right) =>
            `${left.role}:${left.artifactId}`.localeCompare(
              `${right.role}:${right.artifactId}`,
            ))
        if (
          stableSerialize(requestedMedia) !== stableSerialize(sourceMedia)
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Source project media changed during duplication',
          )
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
        await transaction.v2Project.create({
          data: {
            id: bundle.project.id,
            workspaceId: bundle.project.workspaceId,
            name: bundle.project.name,
            status: bundle.project.status,
            objective: bundle.project.objective,
            format: bundle.project.format,
            locale: bundle.project.locale,
            ownerId: bundle.project.ownerId,
            currentVersionId: null,
            duplicatedFromProjectId: sourceProject.id,
            createdByType: bundle.project.createdBy.type,
            createdById: bundle.project.createdBy.id,
            createdAt: new Date(bundle.project.createdAt),
          },
        })
        await transaction.v2ProjectVersion.create({
          data: {
            id: bundle.version.id,
            workspaceId: bundle.version.workspaceId,
            projectId: bundle.version.projectId,
            sequence: 1,
            forkedFromProjectId: sourceProject.id,
            forkedFromVersionId: sourceVersion.id,
            briefSnapshotId: sourceVersion.briefSnapshotId,
            treatmentSnapshotId: sourceVersion.treatmentSnapshotId,
            storySnapshotId: sourceVersion.storySnapshotId,
            editPlanSnapshotId: sourceVersion.editPlanSnapshotId,
            policiesSnapshotId: sourceVersion.policiesSnapshotId,
            baseHash: bundle.version.baseHash,
            createdBy: bundle.version.createdBy,
            createdAt: new Date(bundle.version.createdAt),
          },
        })
        if (bundle.media.length > 0) {
          await transaction.v2ProjectMediaAsset.createMany({
            data: bundle.media.map((item) => ({
              id: item.id,
              workspaceId: bundle.project.workspaceId,
              projectId: bundle.project.id,
              artifactId: item.artifactId,
              role: item.role,
              originalFileName: item.originalFileName,
              createdAt: new Date(item.createdAt),
            })),
          })
        }
        await transaction.v2Project.update({
          where: { id: bundle.project.id },
          data: { currentVersionId: bundle.version.id },
        })
        await transaction.v2ProjectCreationCommand.create({
          data: projectCreationCommandData(bundle.auditCommand),
        })
        const response = {
          projectId: bundle.project.id,
          versionId: bundle.version.id,
        }
        await transaction.v2IdempotencyRecord.update({
          where: { id: bundle.idempotency.id },
          data: {
            status: 'completed',
            responseStatus: 201,
            responseJson: JSON.stringify(response),
          },
        })
        return hydrateResult(
          transaction,
          response,
          false,
          bundle.auditCommand.audit,
          bundle.idempotency.requestFingerprint,
        )
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.duplicateOrReplay(bundle, attempt + 1)
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Project duplication conflicted with another transaction',
        )
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: bundle.idempotency.workspaceId,
          clientId: bundle.idempotency.clientId,
          key: bundle.idempotency.key,
          requestFingerprint: bundle.idempotency.requestFingerprint,
          audit: bundle.auditCommand.audit,
        })
        if (replay) return replay
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Project duplication could not reserve unique identities',
        )
      }
      throw error
    }
  }
}
