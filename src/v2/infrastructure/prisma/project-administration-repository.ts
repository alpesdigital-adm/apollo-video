import {
  Prisma,
  type PrismaClient,
  type V2Project,
  type V2ProjectAdministrationCommand,
} from '../../../../generated/prisma-v2/index.js'

import type {
  AdministrableProject,
  ProjectAdministrationRepository,
  ProjectAdministrationResult,
} from '../../application/ports/project-administration-repository.ts'
import {
  createApiAccessAuditContext,
  type ApiAccessAuditContext,
} from '../../domain/api-access-control.ts'
import { DomainError } from '../../domain/errors.ts'
import type { CommandActorType } from '../../domain/edit-command.ts'
import { createProject, type ProjectStatus } from '../../domain/project.ts'
import {
  createProjectAdministrationCommand,
  createProjectAdministrationState,
  type ProjectAdministrationCommand,
} from '../../domain/project-administration-command.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import { persistPublicEvents } from './public-event-outbox.ts'

type CommandWithProject = V2ProjectAdministrationCommand & {
  project: V2Project
}

function projectFromRow(
  row: V2Project,
  override?: Readonly<{ name: string; status: ProjectStatus }>,
) {
  return createProject({
    id: row.id,
    workspaceId: row.workspaceId,
    name: override?.name ?? row.name,
    status: override?.status ?? row.status as ProjectStatus,
    ...(row.objective ? { objective: row.objective } : {}),
    ...(row.format ? { format: row.format } : {}),
    ...(row.locale ? { locale: row.locale } : {}),
    ...(row.ownerId ? { ownerId: row.ownerId } : {}),
    ...(row.currentVersionId ? { currentVersionId: row.currentVersionId } : {}),
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

function stateFromRow(row: V2Project) {
  return createProjectAdministrationState({
    name: row.name,
    status: row.status as ProjectStatus,
    ...(row.archivedFromStatus
      ? { archivedFromStatus: row.archivedFromStatus as Exclude<ProjectStatus, 'archived'> }
      : {}),
    revision: row.administrationRevision,
  })
}

function auditFromRow(row: V2ProjectAdministrationCommand) {
  const audit = createApiAccessAuditContext({
    clientId: row.actorClientId,
    credentialId: row.actorCredentialId,
    workspaceId: row.workspaceId,
    environment: row.actorEnvironment as 'sandbox' | 'production',
    authenticationKind: row.actorAuthenticationKind as 'bearer' | 'ui-session',
    ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
    ...(row.delegatedIdentityId
      ? { delegatedIdentityId: row.delegatedIdentityId }
      : {}),
    ...(row.workspaceRole
      ? { workspaceRole: row.workspaceRole as ApiAccessAuditContext['workspaceRole'] }
      : {}),
  })
  if (audit.contextHash !== row.actorContextHash) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored project administration actor hash is invalid',
    )
  }
  return audit
}

function commandFromRow(row: V2ProjectAdministrationCommand) {
  try {
    const audit = auditFromRow(row)
    return createProjectAdministrationCommand({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      action: row.action as ProjectAdministrationCommand['action'],
      before: {
        name: row.beforeName,
        status: row.beforeStatus as ProjectStatus,
        ...(row.beforeArchivedFromStatus
          ? { archivedFromStatus: row.beforeArchivedFromStatus as Exclude<ProjectStatus, 'archived'> }
          : {}),
        revision: row.baseRevision,
      },
      after: {
        name: row.afterName,
        status: row.afterStatus as ProjectStatus,
        ...(row.afterArchivedFromStatus
          ? { archivedFromStatus: row.afterArchivedFromStatus as Exclude<ProjectStatus, 'archived'> }
          : {}),
        revision: row.resultRevision,
      },
      confirmation: row.confirmation as ProjectAdministrationCommand['confirmation'],
      audit,
      idempotencyKey: row.idempotencyKey,
      requestFingerprint: row.requestFingerprint,
      resultHash: row.resultHash,
      occurredAt: row.occurredAt.toISOString(),
      commandHash: row.commandHash,
    })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') {
      throw error
    }
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored project administration command is invalid',
    )
  }
}

function resultFromRow(
  row: CommandWithProject,
  replayed: boolean,
): Readonly<ProjectAdministrationResult> {
  const command = commandFromRow(row)
  return Object.freeze({
    project: projectFromRow(row.project, command.after),
    state: command.after,
    command,
    replayed,
  })
}

function commandData(
  command: Readonly<ProjectAdministrationCommand>,
  eventId: string,
) {
  return {
    id: command.id,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    action: command.action,
    beforeName: command.before.name,
    afterName: command.after.name,
    beforeStatus: command.before.status,
    afterStatus: command.after.status,
    beforeArchivedFromStatus: command.before.archivedFromStatus,
    afterArchivedFromStatus: command.after.archivedFromStatus,
    baseRevision: command.before.revision,
    resultRevision: command.after.revision,
    confirmation: command.confirmation,
    actorClientId: command.audit.clientId,
    actorCredentialId: command.audit.credentialId,
    actorEnvironment: command.audit.environment,
    actorAuthenticationKind: command.audit.authenticationKind,
    actorContextHash: command.audit.contextHash,
    delegatedUserId: command.audit.delegatedUserId,
    delegatedIdentityId: command.audit.delegatedIdentityId,
    workspaceRole: command.audit.workspaceRole,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint: command.requestFingerprint,
    resultHash: command.resultHash,
    commandHash: command.commandHash,
    eventId,
    occurredAt: new Date(command.occurredAt),
  }
}

function retryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'P2002' || error.code === 'P2034')
}

export class PrismaProjectAdministrationRepository
implements ProjectAdministrationRepository {
  constructor(private readonly client: PrismaClient) {}

  async findReplay(input: {
    workspaceId: string
    actorContextHash: string
    idempotencyKey: string
    requestFingerprint: string
  }) {
    const row = await this.client.v2ProjectAdministrationCommand.findUnique({
      where: {
        workspaceId_actorContextHash_idempotencyKey: {
          workspaceId: input.workspaceId,
          actorContextHash: input.actorContextHash,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { project: true },
    })
    if (!row) return null
    if (row.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency-Key was already used for another project administration command',
      )
    }
    return resultFromRow(row, true)
  }

  async read(input: { workspaceId: string; projectId: string }) {
    const row = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
    })
    if (!row) return null
    return Object.freeze({
      project: projectFromRow(row),
      state: stateFromRow(row),
    }) satisfies Readonly<AdministrableProject>
  }

  async apply(input: {
    project: Readonly<ReturnType<typeof createProject>>
    command: Readonly<ProjectAdministrationCommand>
    audit: Readonly<ApiAccessAuditContext>
    event: Readonly<PublicEvent>
  }, attempt = 1): Promise<Readonly<ProjectAdministrationResult>> {
    const { command, audit, event } = input
    if (
      audit.contextHash !== command.audit.contextHash ||
      input.project.id !== command.projectId ||
      input.project.workspaceId !== command.workspaceId ||
      input.project.name !== command.after.name ||
      input.project.status !== command.after.status ||
      event.workspaceId !== command.workspaceId ||
      event.resource.id !== command.projectId ||
      event.sequence !== command.after.revision ||
      (command.action === 'rename'
        ? event.type !== 'project.name.changed'
        : event.type !== 'project.status.changed')
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Project administration persistence input is inconsistent',
      )
    }
    try {
      const row = await this.client.$transaction(async (transaction) => {
        const replay = await transaction.v2ProjectAdministrationCommand.findUnique({
          where: {
            workspaceId_actorContextHash_idempotencyKey: {
              workspaceId: command.workspaceId,
              actorContextHash: command.audit.contextHash,
              idempotencyKey: command.idempotencyKey,
            },
          },
          include: { project: true },
        })
        if (replay) {
          if (replay.requestFingerprint !== command.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency-Key was already used for another project administration command',
            )
          }
          return { row: replay, replayed: true }
        }
        const updated = await transaction.v2Project.updateMany({
          where: {
            id: command.projectId,
            workspaceId: command.workspaceId,
            name: command.before.name,
            status: command.before.status,
            archivedFromStatus: command.before.archivedFromStatus ?? null,
            administrationRevision: command.before.revision,
          },
          data: {
            name: command.after.name,
            status: command.after.status,
            archivedFromStatus: command.after.archivedFromStatus ?? null,
            administrationRevision: command.after.revision,
          },
        })
        if (updated.count !== 1) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Project administration state changed during commit',
          )
        }
        await persistPublicEvents(transaction, [event])
        const created = await transaction.v2ProjectAdministrationCommand.create({
          data: commandData(command, event.id),
          include: { project: true },
        })
        return { row: created, replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return resultFromRow(row.row, row.replayed)
    } catch (error) {
      if (error instanceof DomainError) throw error
      if (retryable(error) && attempt < 3) {
        const replay = await this.findReplay({
          workspaceId: command.workspaceId,
          actorContextHash: command.audit.contextHash,
          idempotencyKey: command.idempotencyKey,
          requestFingerprint: command.requestFingerprint,
        })
        if (replay) return replay
        return this.apply(input, attempt + 1)
      }
      throw error
    }
  }
}
