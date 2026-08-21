import { Prisma, type PrismaClient, type V2ProjectVersion } from '../../../../generated/prisma-v2/index.js'
import type {
  SubtitleSegmentOverrideCompiledSegment,
  SubtitleSegmentOverrideRepository,
  SubtitleSegmentOverrideResult,
} from '../../application/ports/subtitle-segment-override-repository.ts'
import { type ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { parseCommandImpact } from '../../domain/command-impact.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { requireEditCommandType } from '../../domain/edit-command-registry.ts'
import { DomainError } from '../../domain/errors.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import {
  createSubtitleSegmentOverride,
  type SubtitleSegmentOverride,
} from '../../domain/subtitle-segment-override.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

const include = Prisma.validator<Prisma.V2SubtitleSegmentOverrideInclude>()({ command: true, resultVersion: true })
type Stored = Prisma.V2SubtitleSegmentOverrideGetPayload<{ include: typeof include }>

function parse(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || stableSerialize(parsed) !== value) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function version(row: V2ProjectVersion) {
  return createProjectVersion({
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, sequence: row.sequence,
    ...(row.parentVersionId ? { parentVersionId: row.parentVersionId } : {}),
    snapshotRefs: {
      brief: row.briefSnapshotId,
      ...(row.treatmentSnapshotId ? { treatment: row.treatmentSnapshotId } : {}),
      ...(row.storySnapshotId ? { story: row.storySnapshotId } : {}),
      editPlan: row.editPlanSnapshotId,
      policies: row.policiesSnapshotId,
    },
    baseHash: row.baseHash, createdBy: row.createdBy,
    ...(row.commandId ? { commandId: row.commandId } : {}),
    createdAt: row.createdAt.toISOString(),
  })
}

function commandAuditData(audit: Readonly<ApiAccessAuditContext> | undefined) {
  return audit
    ? {
        actorCredentialId: audit.credentialId, actorEnvironment: audit.environment,
        actorAuthenticationKind: audit.authenticationKind, actorContextHash: audit.contextHash,
        actorDelegatedIdentityId: audit.delegatedIdentityId, actorWorkspaceRole: audit.workspaceRole,
      }
    : {}
}

type OverrideRow = Pick<
  Stored,
  'overrideJson' | 'overrideHash' | 'workspaceId' | 'projectId' | 'variantId' | 'segmentId'
  | 'startFrame' | 'endFrame' | 'action' | 'dimensionKinds' | 'isProtected' | 'previousOverrideId'
>

/** Rebuilds the stored override through its own constructor: a hand-edited row cannot survive. */
function overrideOf(row: OverrideRow): Readonly<SubtitleSegmentOverride> {
  const raw = parse(row.overrideJson, 'subtitle segment override') as unknown as SubtitleSegmentOverride
  const subtitleOverride = createSubtitleSegmentOverride({
    id: raw.id, workspaceId: raw.workspaceId, projectId: raw.projectId,
    baseVersionId: raw.baseVersionId, resultVersionId: raw.resultVersionId, commandId: raw.commandId,
    variantId: raw.variantId, segmentId: raw.segmentId, range: raw.range, action: raw.action,
    dimensions: raw.dimensions, protected: raw.protected,
    previousOverrideId: raw.previousOverrideId, createdAt: raw.createdAt,
  })
  if (
    subtitleOverride.overrideHash !== row.overrideHash
    || stableSerialize(subtitleOverride) !== row.overrideJson
    || subtitleOverride.workspaceId !== row.workspaceId
    || subtitleOverride.projectId !== row.projectId
    || subtitleOverride.variantId !== row.variantId
    || subtitleOverride.segmentId !== row.segmentId
    || subtitleOverride.range.startFrame !== row.startFrame
    || subtitleOverride.range.endFrame !== row.endFrame
    || subtitleOverride.action !== row.action
    || subtitleOverride.protected !== row.isProtected
    || subtitleOverride.previousOverrideId !== row.previousOverrideId
    || dimensionKindsOf(subtitleOverride) !== row.dimensionKinds
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle segment override lineage is invalid')
  return subtitleOverride
}

/** The denormalized column the PostgreSQL constraints check, derived from the document. */
function dimensionKindsOf(subtitleOverride: Readonly<SubtitleSegmentOverride>): string {
  return subtitleOverride.dimensions.map((dimension) => dimension.kind).join(',')
}

function hydrate(row: Stored, replayed: boolean): Readonly<SubtitleSegmentOverrideResult> {
  const subtitleOverride = overrideOf(row)
  const impact = parseCommandImpact(parse(row.impactJson, 'subtitle segment override impact'))
  const commandRow = row.command
  const payload = parse(commandRow.payloadJson, 'subtitle segment override command payload') as unknown as SubtitleSegmentOverrideResult['command']['payload']
  const command = createEditCommand({
    id: commandRow.id, workspaceId: commandRow.workspaceId, projectId: commandRow.projectId,
    baseVersionId: commandRow.baseVersionId, baseHash: commandRow.baseHash,
    author: {
      type: commandRow.actorType as 'api-client', id: commandRow.actorId,
      ...(commandRow.delegatedUserId ? { delegatedUserId: commandRow.delegatedUserId } : {}),
    },
    type: requireEditCommandType(commandRow.type),
    scope: parse(commandRow.scopeJson, 'subtitle segment override command scope') as EditScope,
    payload,
    ...(commandRow.reason ? { reason: commandRow.reason } : {}),
    idempotencyKey: commandRow.idempotencyKey, createdAt: commandRow.createdAt.toISOString(),
  })
  const resultVersion = version(row.resultVersion)
  if (
    impact.impactHash !== row.impactHash
    || stableSerialize(impact) !== row.impactJson
    || impact.commandType !== 'apply-subtitle-segment-override'
    || command.type !== 'apply-subtitle-segment-override'
    || payload.impact.impactHash !== impact.impactHash
    || payload.action !== subtitleOverride.action
    || payload.variantId !== subtitleOverride.variantId
    || payload.segmentId !== subtitleOverride.segmentId
    || resultVersion.id !== subtitleOverride.resultVersionId
    || command.id !== subtitleOverride.commandId
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle segment override lineage is invalid')
  return Object.freeze({ command, version: resultVersion, subtitleOverride, impact, replayed })
}

/**
 * Compiled segments of one variant taken from the immutable EditPlan snapshot.
 *
 * A subtitle track without a `variantId` is shared by every variant; a track that
 * names one belongs to that variant alone. Reading the segments this way is what
 * lets the write path refuse an exception aimed at a segment the target variant
 * does not actually compile.
 */
function segmentsOf(editPlan: Record<string, unknown>, variantId: string): readonly Readonly<SubtitleSegmentOverrideCompiledSegment>[] {
  const tracks = editPlan.subtitleTracks
  if (!Array.isArray(tracks)) return Object.freeze([])
  const segments: SubtitleSegmentOverrideCompiledSegment[] = []
  for (const trackValue of tracks) {
    if (!trackValue || typeof trackValue !== 'object' || Array.isArray(trackValue)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored EditPlan subtitle track is invalid')
    }
    const track = trackValue as Record<string, unknown>
    if (typeof track.variantId === 'string' && track.variantId !== variantId) continue
    if (!Array.isArray(track.cues)) continue
    for (const cueValue of track.cues) {
      if (!cueValue || typeof cueValue !== 'object' || Array.isArray(cueValue)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored EditPlan subtitle cue is invalid')
      }
      const cue = cueValue as Record<string, unknown>
      const startFrame = Number(cue.startFrame)
      const endFrame = Number(cue.endFrame)
      if (
        typeof cue.id !== 'string' || typeof cue.text !== 'string'
        || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)
        || startFrame < 0 || endFrame <= startFrame
      ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored EditPlan subtitle cue is invalid')
      segments.push(Object.freeze({ id: cue.id, startFrame, endFrame, text: cue.text }))
    }
  }
  return Object.freeze(segments)
}

export class PrismaSubtitleSegmentOverrideRepository implements SubtitleSegmentOverrideRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const command = await this.client.v2EditCommand.findUnique({
      where: { workspaceId_projectId_idempotencyKey: input },
      select: { id: true, requestFingerprint: true },
    })
    if (!command) return null
    const row = await this.client.v2SubtitleSegmentOverride.findUnique({
      where: { commandId_workspaceId: { commandId: command.id, workspaceId: input.workspaceId } },
      include,
    })
    if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent subtitle segment override disappeared')
    return Object.freeze({ requestFingerprint: command.requestFingerprint, result: hydrate(row, true) })
  }

  /** Head override of one segment plus the override it replaced. Both queries carry workspaceId. */
  private async readHeadChain(input: { workspaceId: string; projectId: string; variantId: string; segmentId: string }) {
    const head = await this.client.v2SubtitleSegmentOverrideHead.findUnique({
      where: { projectId_workspaceId_variantId_segmentId: input },
    })
    if (!head) return { currentOverride: null, previousOverride: null, currentRow: null }
    const currentRow = await this.client.v2SubtitleSegmentOverride.findUnique({
      where: { id_workspaceId: { id: head.overrideId, workspaceId: input.workspaceId } },
      include,
    })
    if (
      !currentRow || currentRow.projectId !== input.projectId
      || currentRow.variantId !== input.variantId || currentRow.segmentId !== input.segmentId
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle segment override head is invalid')
    const currentOverride = overrideOf(currentRow)
    if (!currentOverride.previousOverrideId) return { currentOverride, previousOverride: null, currentRow }
    const previousRow = await this.client.v2SubtitleSegmentOverride.findUnique({
      where: { id_workspaceId: { id: currentOverride.previousOverrideId, workspaceId: input.workspaceId } },
    })
    if (
      !previousRow || previousRow.projectId !== input.projectId
      || previousRow.variantId !== input.variantId || previousRow.segmentId !== input.segmentId
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle segment override lineage is broken')
    return { currentOverride, previousOverride: overrideOf(previousRow), currentRow }
  }

  async readContext(input: { workspaceId: string; projectId: string; variantId: string; segmentId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: { include: { editPlanSnapshot: true } } },
    })
    if (!project?.currentVersion) return null
    const editPlan = parse(project.currentVersion.editPlanSnapshot.contentJson, 'subtitle segment override EditPlan')
    const durationFrames = Number(editPlan.durationFrames)
    if (!Number.isSafeInteger(durationFrames) || durationFrames < 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle segment override render context is incomplete')
    }
    const [proxy, final, chain] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: {
          workspaceId: input.workspaceId, projectId: input.projectId,
          projectVersionId: project.currentVersion.id,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: {
          workspaceId: input.workspaceId, projectId: input.projectId,
          projectVersionId: project.currentVersion.id,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
      this.readHeadChain(input),
    ])
    const proxyVariantId = project.format ?? input.variantId
    const declared = Array.isArray(editPlan.outputVariantIds)
      ? editPlan.outputVariantIds.filter((value): value is string => typeof value === 'string')
      : []
    const variantIds = Object.freeze(
      [...new Set([...declared, proxyVariantId, ...final.map((item) => item.outputAspectRatio)])].toSorted(),
    )
    return Object.freeze({
      currentVersion: version(project.currentVersion),
      durationFrames,
      segments: segmentsOf(editPlan, input.variantId),
      variantIds,
      outputReferences: Object.freeze([
        ...proxy.map((item) => Object.freeze({
          artifactId: item.outputArtifactId, kind: 'proxy' as const,
          sourceVersionId: project.currentVersion!.id, variantId: proxyVariantId,
        })),
        ...final.map((item) => Object.freeze({
          artifactId: item.outputArtifactId, kind: 'final' as const,
          sourceVersionId: project.currentVersion!.id, variantId: item.outputAspectRatio,
        })),
      ]),
      currentOverride: chain.currentOverride,
      previousOverride: chain.previousOverride,
    })
  }

  async readCurrent(input: { workspaceId: string; projectId: string; variantId: string; segmentId: string }) {
    const chain = await this.readHeadChain(input)
    return chain.currentRow ? hydrate(chain.currentRow, false) : null
  }

  async listCurrentByVariant(input: { workspaceId: string; projectId: string; variantId: string }) {
    const heads = await this.client.v2SubtitleSegmentOverrideHead.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId },
      select: { overrideId: true },
    })
    if (heads.length === 0) return Object.freeze([])
    const rows = await this.client.v2SubtitleSegmentOverride.findMany({
      where: {
        workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId,
        id: { in: heads.map((head) => head.overrideId) },
      },
      orderBy: [{ startFrame: 'asc' }, { segmentId: 'asc' }],
    })
    return Object.freeze(rows.map((row) => overrideOf(row)))
  }

  async commitOrReplay(
    input: Parameters<SubtitleSegmentOverrideRepository['commitOrReplay']>[0],
    attempt = 1,
  ): Promise<Readonly<SubtitleSegmentOverrideResult>> {
    try {
      return await this.client.$transaction(async (tx) => {
        const project = await tx.v2Project.findFirst({
          where: { id: input.command.projectId, workspaceId: input.command.workspaceId },
          include: { currentVersion: true },
        })
        if (
          !project?.currentVersion
          || project.currentVersion.id !== input.command.baseVersionId
          || project.currentVersion.baseHash !== input.command.baseHash
          || input.version.sequence !== project.currentVersion.sequence + 1
        ) throw new DomainError('VERSION_CONFLICT', 'Project changed before subtitle segment override commit')
        const headKey = {
          projectId: input.subtitleOverride.projectId, workspaceId: input.subtitleOverride.workspaceId,
          variantId: input.subtitleOverride.variantId, segmentId: input.subtitleOverride.segmentId,
        }
        const head = await tx.v2SubtitleSegmentOverrideHead.findUnique({
          where: { projectId_workspaceId_variantId_segmentId: headKey },
        })
        if ((head?.overrideId ?? null) !== input.subtitleOverride.previousOverrideId) {
          throw new DomainError('VERSION_CONFLICT', 'Subtitle segment override head changed before commit')
        }
        await tx.v2EditCommand.create({
          data: {
            id: input.command.id, workspaceId: input.command.workspaceId, projectId: input.command.projectId,
            baseVersionId: input.command.baseVersionId, baseHash: input.command.baseHash, type: input.command.type,
            scopeJson: stableSerialize(input.command.scope), payloadJson: stableSerialize(input.command.payload),
            reason: input.command.reason, actorType: input.command.author.type, actorId: input.command.author.id,
            delegatedUserId: input.command.author.delegatedUserId, ...commandAuditData(input.authenticationAudit),
            idempotencyKey: input.command.idempotencyKey, requestFingerprint: input.requestFingerprint,
            createdAt: new Date(input.command.createdAt),
          },
        })
        await tx.v2ProjectVersion.create({
          data: {
            id: input.version.id, workspaceId: input.version.workspaceId, projectId: input.version.projectId,
            sequence: input.version.sequence, parentVersionId: input.version.parentVersionId,
            briefSnapshotId: input.version.snapshotRefs.brief!, treatmentSnapshotId: input.version.snapshotRefs.treatment,
            storySnapshotId: input.version.snapshotRefs.story, editPlanSnapshotId: input.version.snapshotRefs.editPlan,
            policiesSnapshotId: input.version.snapshotRefs.policies, baseHash: input.version.baseHash,
            createdBy: input.version.createdBy, commandId: input.command.id, createdAt: new Date(input.version.createdAt),
          },
        })
        await tx.v2SubtitleSegmentOverride.create({
          data: {
            id: input.subtitleOverride.id, workspaceId: input.subtitleOverride.workspaceId,
            projectId: input.subtitleOverride.projectId, commandId: input.subtitleOverride.commandId,
            baseVersionId: input.subtitleOverride.baseVersionId, resultVersionId: input.subtitleOverride.resultVersionId,
            variantId: input.subtitleOverride.variantId, segmentId: input.subtitleOverride.segmentId,
            startFrame: input.subtitleOverride.range.startFrame, endFrame: input.subtitleOverride.range.endFrame,
            action: input.subtitleOverride.action, dimensionKinds: dimensionKindsOf(input.subtitleOverride),
            isProtected: input.subtitleOverride.protected, previousOverrideId: input.subtitleOverride.previousOverrideId,
            overrideJson: stableSerialize(input.subtitleOverride), overrideHash: input.subtitleOverride.overrideHash,
            impactJson: stableSerialize(input.impact), impactHash: input.impact.impactHash,
            createdAt: new Date(input.subtitleOverride.createdAt),
          },
        })
        await tx.v2SubtitleSegmentOverrideHead.upsert({
          where: { projectId_workspaceId_variantId_segmentId: headKey },
          create: { ...headKey, overrideId: input.subtitleOverride.id, updatedAt: new Date(input.subtitleOverride.createdAt) },
          update: { overrideId: input.subtitleOverride.id, updatedAt: new Date(input.subtitleOverride.createdAt) },
        })
        const updated = await tx.v2Project.updateMany({
          where: {
            id: input.command.projectId, workspaceId: input.command.workspaceId,
            currentVersionId: input.command.baseVersionId,
          },
          data: { currentVersionId: input.version.id },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project changed during subtitle segment override commit')
        return hydrate(
          await tx.v2SubtitleSegmentOverride.findUniqueOrThrow({
            where: { id_workspaceId: { id: input.subtitleOverride.id, workspaceId: input.subtitleOverride.workspaceId } },
            include,
          }),
          false,
        )
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findIdempotent({
          workspaceId: input.command.workspaceId, projectId: input.command.projectId,
          idempotencyKey: input.command.idempotencyKey,
        })
        if (replay?.requestFingerprint === input.requestFingerprint) return replay.result
        if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was reused with another subtitle segment override')
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 3) {
        return this.commitOrReplay(input, attempt + 1)
      }
      throw error
    }
  }
}
