import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import type { ProjectQueryRepository } from '../../application/ports/project-query-repository.ts'
import {
  createProjectDashboardRecord,
  type ProjectDashboardRecord,
} from '../../domain/project-dashboard.ts'
import { createProject, type ProjectStatus } from '../../domain/project.ts'
import type {
  PublicOperationPhase,
  PublicOperationStatus,
  PublicOperationType,
} from '../../domain/public-operation.ts'
import type { OutputAspectRatio } from '../../domain/output-spec.ts'
import type { CommandActorType } from '../../domain/edit-command.ts'

type ListByWorkspaceInput = Parameters<ProjectQueryRepository['listByWorkspace']>[0]

export class PrismaProjectQueryRepository implements ProjectQueryRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  /**
   * apollo.projects.list 6.1.0: the page of project ids for a query that carries the `format` facet.
   *
   * A project born under 6.0.0 has no `projects.format`; its outputs are the explicit variants in the State of its head Version
   * (`projects.currentVersionId`). A project matches the facet when
   * - any output of that head State has the requested aspect ratio, read from the sealed spec revision the State entry points at
   *   (so a revised output counts with its current ratio and no older Version ever counts), or
   * - the project still stores that format itself (rows from before 6.0.0, and forks, which inherit the source's format).
   *
   * Why SQL and not a Prisma relation filter: the ratio exists only inside the sealed JSON text of the spec revision, which a
   * Prisma filter can only search as text, and Prisma renders a to-many relation filter as an uncorrelated `IN (sub-select)`
   * that, under this OR, reads every entry of every Version of every workspace before the first row is returned. Here the
   * sub-select is an `EXISTS` that starts at the project's own row, follows its head (`currentVersionId`) and carries the
   * workspace as a constant, so every table it touches is fenced by the requesting workspace and only head Versions are walked
   * (head Version by the (id, projectId, workspaceId) key, its State's entries by the scope key, the revision by its seal key).
   * The ratio is read with a jsonb path, an exact read of the sealed JSON.
   *
   * Measured plan (25 projects, after ANALYZE; at scale the planner chooses): the outer scan stays on
   * `projects (workspaceId, createdAt)` in the page order and stops at LIMIT, and the EXISTS runs as a hashed sub-plan once per
   * request, driven from this workspace's spec revisions (the workspace test precedes the JSON read) joined to `projects h`, then
   * the head Version and the entries by key. So the JSON is parsed only for the requesting workspace's revisions (a few per
   * project); what remains is a cheap workspace filter over `output_spec_revisions`, which has no workspace-leading index. No
   * column or index is added; `output_spec_revisions (workspaceId)` is the index to add if that table ever dominates.
   *
   * The other facets, the keyset cursor and the order are those of the Prisma query below (same predicates, the same ILIKE with the
   * text wrapped in %, the same timestamptz bounds); the page itself is then read by id with the same includes.
   */
  private async formatPageIds(input: ListByWorkspaceInput & { filters: { format: string } }): Promise<readonly string[]> {
    const { workspaceId, filters, after } = input
    const instant = (value: string) => Prisma.sql`${new Date(value).toISOString()}::timestamptz`
    const conditions: Prisma.Sql[] = [Prisma.sql`p."workspaceId" = ${workspaceId}`]
    if (filters.text) conditions.push(Prisma.sql`p."name" ILIKE ${`%${filters.text}%`}`)
    if (filters.status) conditions.push(Prisma.sql`p."status" = ${filters.status}`)
    if (filters.objective) conditions.push(Prisma.sql`p."objective" = ${filters.objective}`)
    if (filters.locale) conditions.push(Prisma.sql`p."locale" = ${filters.locale}`)
    if (filters.ownerId) conditions.push(Prisma.sql`p."ownerId" = ${filters.ownerId}`)
    if (filters.createdFrom) conditions.push(Prisma.sql`p."createdAt" >= ${instant(filters.createdFrom)}`)
    if (filters.createdTo) conditions.push(Prisma.sql`p."createdAt" <= ${instant(filters.createdTo)}`)
    if (after) {
      conditions.push(Prisma.sql`(p."createdAt" < ${instant(after.createdAt)} OR (p."createdAt" = ${instant(after.createdAt)} AND p."id" < ${after.id}))`)
    }
    // The sub-select starts at the project's own row (h) and follows its head: whether PostgreSQL runs it once per candidate or
    // hashes it once per request, it only ever walks the workspace's head Versions, never a project's older ones.
    conditions.push(Prisma.sql`(p."format" = ${filters.format} OR EXISTS (
      SELECT 1 FROM "projects" AS h
      JOIN "project_versions" AS v
        ON v."id" = h."currentVersionId" AND v."projectId" = h."id" AND v."workspaceId" = h."workspaceId"
      JOIN "project_output_state_entries" AS e
        ON e."stateId" = v."outputStateId" AND e."projectId" = v."projectId" AND e."workspaceId" = v."workspaceId"
      JOIN "output_spec_revisions" AS r
        ON r."id" = e."outputSpecRevisionId" AND r."variantId" = e."variantId" AND r."projectId" = e."projectId" AND r."workspaceId" = e."workspaceId"
      WHERE h."id" = p."id" AND h."workspaceId" = ${workspaceId}
        AND (r."specJson"::jsonb #>> '{output,aspectRatio}') = ${filters.format}))`)
    const rows = await this.client.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT p."id" FROM "projects" AS p WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY p."createdAt" DESC, p."id" DESC LIMIT ${input.limit}`)
    return rows.map((row) => row.id)
  }

  async listByWorkspace(input: ListByWorkspaceInput): Promise<readonly ProjectDashboardRecord[]> {
    const filters = input.filters
    // The `format` facet picks the page first (see formatPageIds); every other query is the Prisma one below.
    const pageIds = filters?.format ? await this.formatPageIds({ ...input, filters: { ...filters, format: filters.format } }) : null
    if (pageIds && pageIds.length === 0) return []
    const rows = await this.client.v2Project.findMany({
      where: pageIds ? { workspaceId: input.workspaceId, id: { in: [...pageIds] } } : {
        workspaceId: input.workspaceId,
        ...(filters?.text
          ? { name: { contains: filters.text, mode: 'insensitive' as const } }
          : {}),
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.objective ? { objective: filters.objective } : {}),
        ...(filters?.locale ? { locale: filters.locale } : {}),
        ...(filters?.ownerId ? { ownerId: filters.ownerId } : {}),
        ...(filters?.createdFrom || filters?.createdTo ? { createdAt: {
          ...(filters.createdFrom ? { gte: new Date(filters.createdFrom) } : {}),
          ...(filters.createdTo ? { lte: new Date(filters.createdTo) } : {}),
        } } : {}),
        ...(input.after
          ? {
              OR: [
                { createdAt: { lt: new Date(input.after.createdAt) } },
                { createdAt: new Date(input.after.createdAt), id: { lt: input.after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      include: {
        currentVersion: {
          select: {
            id: true,
            sequence: true,
            createdAt: true,
            _count: {
              select: {
                reviewAnnotations: { where: { status: 'open' } },
              },
            },
            finalExportOperations: {
              where: { operation: { status: 'succeeded' } },
              select: {
                outputArtifactId: true,
                outputAspectRatio: true,
              },
              orderBy: [{ createdAt: 'asc' }, { operationId: 'asc' }],
              take: 1000,
            },
          },
        },
        publicOperations: {
          // Admission order is stable; an older task's heartbeat or retry does
          // not make it the dashboard's latest operation again.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            id: true,
            type: true,
            status: true,
            phase: true,
            progressCompleted: true,
            progressTotal: true,
            progressUnit: true,
            errorCode: true,
            errorRetryable: true,
            updatedAt: true,
          },
        },
      },
    })

    return rows.map((row) => {
      const project = createProject({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        status: row.status as ProjectStatus,
        objective: row.objective ?? undefined,
        format: row.format ?? undefined,
        locale: row.locale ?? undefined,
        ownerId: row.ownerId ?? undefined,
        currentVersionId: row.currentVersionId ?? undefined,
        createdBy: {
          type: row.createdByType as CommandActorType,
          id: row.createdById,
        },
        createdAt: row.createdAt.toISOString(),
      })
      const operation = row.publicOperations[0]
      const operationProgress = operation?.progressCompleted === null ||
        operation?.progressCompleted === undefined
        ? undefined
        : {
            completed: operation.progressCompleted,
            ...(operation.progressTotal !== null
              ? { total: operation.progressTotal }
              : {}),
            ...(operation.progressUnit !== null
              ? { unit: operation.progressUnit }
              : {}),
          }
      const operationError = operation?.status === 'failed'
        ? {
            code: operation.errorCode ?? '',
            retryable: operation.errorRetryable ?? false,
          }
        : undefined
      const operationUpdatedAt = operation?.updatedAt.getTime() ?? 0
      const lastActivityAt = new Date(Math.max(
        row.updatedAt.getTime(),
        operationUpdatedAt,
      )).toISOString()
      return createProjectDashboardRecord({
        project,
        currentVersion: row.currentVersion
          ? {
              id: row.currentVersion.id,
              sequence: row.currentVersion.sequence,
              createdAt: row.currentVersion.createdAt.toISOString(),
            }
          : null,
        latestOperation: operation
          ? {
              id: operation.id,
              type: operation.type as Exclude<
                PublicOperationType,
                'production-batch-item'
              >,
              status: operation.status as PublicOperationStatus,
              phase: operation.phase as Exclude<
                PublicOperationPhase,
                'planning' | 'reviewing'
              >,
              ...(operationProgress ? { progress: operationProgress } : {}),
              ...(operationError ? { error: operationError } : {}),
              updatedAt: operation.updatedAt.toISOString(),
            }
          : null,
        openReviewIssueCount:
          row.currentVersion?._count.reviewAnnotations ?? 0,
        outputs: row.currentVersion?.finalExportOperations.map((output) => ({
          artifactId: output.outputArtifactId,
          aspectRatio: output.outputAspectRatio as OutputAspectRatio,
        })) ?? [],
        lastActivityAt,
        administrationRevision: row.administrationRevision,
        archivedFromStatus: row.archivedFromStatus as Exclude<
          ProjectStatus,
          'archived'
        > | null,
      })
    })
  }
}
