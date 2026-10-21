import type { Prisma, PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import {
  walkDirectorInheritance,
  type DirectorInheritanceReader,
  type DirectorInheritanceWalk,
  type DirectorRunInheritance,
} from '../../domain/director-run-inheritance.ts'
import { DomainError } from '../../domain/errors.ts'

type Reader = PrismaClient | Prisma.TransactionClient

function parsePlan(contentJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(contentJson) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored EditPlan is invalid')
  }
}

/** The EditPlan without the fields that only name the Version it belongs to: two Versions with the same plan have the same address. */
function planContentHash(contentJson: string): string {
  const { id: _id, projectVersionId: _projectVersionId, createdAt: _createdAt, ...content } = parsePlan(contentJson)
  return calculateCanonicalHash(content)
}

/** The facts the walk needs, read from the persisted rows of one project (workspace-scoped on every query). */
function prismaDirectorInheritanceReader(client: Reader, scope: Readonly<{ workspaceId: string; projectId: string }>): DirectorInheritanceReader {
  const facts = new Map<string, Awaited<ReturnType<DirectorInheritanceReader['readVersion']>>>()
  return {
    async isDirectorResult(versionId) {
      const run = await client.v2DirectorRun.findFirst({
        where: { workspaceId: scope.workspaceId, projectId: scope.projectId, resultVersionId: versionId, status: 'succeeded' },
        select: { id: true },
      })
      return run !== null
    },
    async readVersion(versionId) {
      if (facts.has(versionId)) return facts.get(versionId) ?? null
      const row = await client.v2ProjectVersion.findFirst({
        where: { id: versionId, workspaceId: scope.workspaceId, projectId: scope.projectId },
        select: {
          id: true, parentVersionId: true, commandId: true,
          command: { select: { id: true, type: true, baseVersionId: true } },
          editPlanSnapshot: { select: { contentJson: true } },
        },
      })
      const read = row
        ? Object.freeze({
            versionId: row.id,
            parentVersionId: row.parentVersionId,
            commandId: row.command?.id ?? null,
            commandType: row.command?.type ?? null,
            commandBaseVersionId: row.command?.baseVersionId ?? null,
            planContentHash: planContentHash(row.editPlanSnapshot.contentJson),
          })
        : null
      facts.set(versionId, read)
      return read
    },
    // Asked only once the walk stopped: the whole line of the project and its directed Versions, read once, answer it without a query per Version.
    async isDirectedAtOrAbove(versionId) {
      const [versions, runs] = await Promise.all([
        client.v2ProjectVersion.findMany({ where: { workspaceId: scope.workspaceId, projectId: scope.projectId }, select: { id: true, parentVersionId: true } }),
        client.v2DirectorRun.findMany({ where: { workspaceId: scope.workspaceId, projectId: scope.projectId, status: 'succeeded' }, select: { resultVersionId: true } }),
      ])
      const directed = new Set(runs.map((run) => run.resultVersionId))
      const parentOf = new Map(versions.map((row) => [row.id, row.parentVersionId]))
      const visited = new Set<string>()
      for (let cursor: string | null = versionId; cursor !== null && parentOf.has(cursor) && !visited.has(cursor); cursor = parentOf.get(cursor) ?? null) {
        visited.add(cursor)
        if (directed.has(cursor)) return true
      }
      return false
    },
  }
}

/** Walks `parentVersionId` back from `versionId` to the Version a succeeded DirectorRun produced, through allowed exception Commands only. */
export function readDirectorInheritanceWalk(
  client: Reader,
  input: Readonly<{ workspaceId: string; projectId: string; versionId: string }>,
): Promise<Readonly<DirectorInheritanceWalk>> {
  return walkDirectorInheritance(prismaDirectorInheritanceReader(client, input), input.versionId)
}

/**
 * The DirectorRun whose quality a Version carries, with its quality and perception snapshots: the Version's own run, or the one an
 * ancestor reached through allowed exception Commands only. `null` when no run is reachable (or the walk was refused). The row is the
 * ancestor's own; nothing is copied.
 */
export async function readEffectiveDirectorRun(
  client: Reader,
  input: Readonly<{ workspaceId: string; projectId: string; versionId: string }>,
) {
  const walk = await readDirectorInheritanceWalk(client, input)
  if (walk.kind !== 'direct' && walk.kind !== 'inherited') return null
  const directorResultVersionId = walk.kind === 'direct' ? walk.directorResultVersionId : walk.inheritance.directorResultVersionId
  const run = await client.v2DirectorRun.findFirst({
    where: { workspaceId: input.workspaceId, projectId: input.projectId, resultVersionId: directorResultVersionId, status: 'succeeded' },
    include: { qualitySnapshot: true, perceptionSnapshot: true },
  })
  if (!run) return null
  return Object.freeze({
    run,
    inheritance: walk.kind === 'inherited' ? walk.inheritance : null as Readonly<DirectorRunInheritance> | null,
  })
}
