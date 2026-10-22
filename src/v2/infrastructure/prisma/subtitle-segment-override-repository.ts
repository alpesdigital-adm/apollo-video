import { Prisma, type PrismaClient, type V2ProjectVersion } from '../../../../generated/prisma-v2/index.js'
import type {
  SubtitleSegmentOverrideCompiledSegment,
  SubtitleSegmentOverrideRepository,
  SubtitleSegmentOverrideResult,
} from '../../application/ports/subtitle-segment-override-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { parseCommandImpact } from '../../domain/command-impact.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { requireEditCommandType } from '../../domain/edit-command-registry.ts'
import { DomainError } from '../../domain/errors.ts'
import { operationalBundlePlanV3 } from '../../domain/output-version-bundle.ts'
import { renderOutputReferences } from '../../domain/output-variant-references.ts'
import { requireOutputVariant } from '../../domain/output-consumption.ts'
import { childCommandOf } from '../../domain/project-output-state-transition.ts'
import { hydrateProjectVersionRowV3 } from '../../domain/project-version-row.ts'
import {
  createSubtitleSegmentOverride,
  type SubtitleSegmentOverride,
} from '../../domain/subtitle-segment-override.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { carryVariantReframePlans } from './variant-reframe-plan-repository.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState, settleDeferredOutputGuards } from './project-version-commit.ts'
import { reconcileAfterConflict } from './idempotency-record-persistence.ts'

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
  return hydrateProjectVersionRowV3(row)
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
  if (commandRow.commandHash !== command.commandHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle segment override command seal is invalid')
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

type Reader = PrismaClient | Prisma.TransactionClient

/**
 * Every head exception of one variant, rebuilt through its own constructor (a hand-edited row cannot survive). Scoped by workspace,
 * project and variant, so a variant never reads another variant's exceptions. The compiler, the render sources and the editor read
 * the same list.
 */
export async function readSubtitleSegmentOverrideHeads(
  client: Reader,
  input: Readonly<{ workspaceId: string; projectId: string; variantId: string }>,
): Promise<readonly Readonly<SubtitleSegmentOverride>[]> {
  const heads = await client.v2SubtitleSegmentOverrideHead.findMany({
    where: { workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId },
    select: { overrideId: true },
  })
  if (heads.length === 0) return Object.freeze([])
  const rows = await client.v2SubtitleSegmentOverride.findMany({
    where: {
      workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId,
      id: { in: heads.map((head) => head.overrideId) },
    },
    orderBy: [{ startFrame: 'asc' }, { segmentId: 'asc' }],
  })
  if (rows.length !== heads.length) throw new DomainError('PERSISTENCE_CONFLICT', 'A subtitle segment override head names an override that is not stored')
  return Object.freeze(rows.map((row) => overrideOf(row)))
}

/**
 * The head exception of every segment of one variant AS OF a Version: for each segment the newest override whose result Version is at or before
 * `versionSequence`. A render is only ever made for the current Version, and every override write makes a new Version, so the heads a render read
 * are the heads as of its own Version; this is how a reader of a historical render (the sidecar) recovers the exact set the render was drawn
 * with, and it is checked against the set hash the render's review recorded.
 */
export async function readSubtitleSegmentOverrideHeadsAsOf(
  client: Reader,
  input: Readonly<{ workspaceId: string; projectId: string; variantId: string; versionSequence: number }>,
): Promise<readonly Readonly<SubtitleSegmentOverride>[]> {
  const rows = await client.v2SubtitleSegmentOverride.findMany({
    where: {
      workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId,
      resultVersion: { is: { sequence: { lte: input.versionSequence } } },
    },
    include: { resultVersion: { select: { sequence: true } } },
    orderBy: [{ startFrame: 'asc' }, { segmentId: 'asc' }],
  })
  const newest = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const previous = newest.get(row.segmentId)
    if (!previous || row.resultVersion.sequence > previous.resultVersion.sequence) newest.set(row.segmentId, row)
  }
  return Object.freeze([...newest.values()].map((row) => overrideOf(row)))
}

export class PrismaSubtitleSegmentOverrideRepository implements SubtitleSegmentOverrideRepository {
  // An explicit field, not a parameter property: the render source reader imports this module and runs under type stripping.
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

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
    const project = await this.client.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId } })
    if (!project?.currentVersionId) return null
    const parent = await readPersistedOperationalOutputBundleV3(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: project.currentVersionId })
    if (!parent) return null
    const currentVersionId = parent.version.id
    const editPlan = parse(operationalBundlePlanV3(parent).contentJson, 'subtitle segment override EditPlan')
    const durationFrames = Number(editPlan.durationFrames)
    if (!Number.isSafeInteger(durationFrames) || durationFrames < 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle segment override render context is incomplete')
    }
    const [proxy, final, chain] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: {
          workspaceId: input.workspaceId, projectId: input.projectId,
          projectVersionId: currentVersionId,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true, outputVariantId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: {
          workspaceId: input.workspaceId, projectId: input.projectId,
          projectVersionId: currentVersionId,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true, outputVariantId: true, outputAspectRatio: true },
      }),
      this.readHeadChain(input),
    ])
    return Object.freeze({
      parent,
      durationFrames,
      segments: segmentsOf(editPlan, input.variantId),
      // Each render of the head Version attributed to the output it was made for (stable State variant ids).
      outputReferences: renderOutputReferences({ state: parent.state, sourceVersionId: currentVersionId, proxies: proxy, finals: final }),
      currentOverride: chain.currentOverride,
      previousOverride: chain.previousOverride,
    })
  }

  async readSegments(input: { workspaceId: string; projectId: string; variantId: string }) {
    const project = await this.client.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId } })
    if (!project?.currentVersionId) return null
    const parent = await readPersistedOperationalOutputBundleV3(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: project.currentVersionId })
    if (!parent) return null
    // The variant must be an exact member of the sealed State of the head BEFORE anything else about it is read.
    requireOutputVariant(parent.state, input.variantId)
    const editPlan = parse(operationalBundlePlanV3(parent).contentJson, 'subtitle segments EditPlan')
    const durationFrames = Number(editPlan.durationFrames)
    const fps = Number(editPlan.fps)
    if (!Number.isSafeInteger(durationFrames) || durationFrames < 0 || !Number.isFinite(fps) || fps <= 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle segments render context is incomplete')
    }
    return Object.freeze({
      version: Object.freeze({ id: parent.version.id, sequence: parent.version.sequence, baseHash: parent.version.baseHash }),
      variantId: input.variantId, fps, durationFrames,
      segments: segmentsOf(editPlan, input.variantId),
      overrides: await readSubtitleSegmentOverrideHeads(this.client, input),
    })
  }

  async readCurrent(input: { workspaceId: string; projectId: string; variantId: string; segmentId: string }) {
    const chain = await this.readHeadChain(input)
    return chain.currentRow ? hydrate(chain.currentRow, false) : null
  }

  async listCurrentByVariant(input: { workspaceId: string; projectId: string; variantId: string }) {
    return readSubtitleSegmentOverrideHeads(this.client, input)
  }

  async commitOrReplay(
    input: Parameters<SubtitleSegmentOverrideRepository['commitOrReplay']>[0],
    attempt = 1,
  ): Promise<Readonly<SubtitleSegmentOverrideResult>> {
    const sealed = childCommandOf<SubtitleSegmentOverrideResult['command']['payload']>(input.bundle)
    const command = sealed.command, requestFingerprint = sealed.requestFingerprint, bundleVersion = input.bundle.version
    if (
      command.type !== 'apply-subtitle-segment-override' || bundleVersion.commandId !== command.id
      || input.subtitleOverride.commandId !== command.id || input.subtitleOverride.resultVersionId !== bundleVersion.id
      || input.subtitleOverride.baseVersionId !== command.baseVersionId
      || input.subtitleOverride.workspaceId !== command.workspaceId || input.subtitleOverride.projectId !== command.projectId
      || bundleVersion.parentVersionId !== command.baseVersionId
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle segment override does not belong to the Command that produced its Version')
    try {
      return await this.client.$transaction(async (tx) => {
        const project = await tx.v2Project.findFirst({
          where: { id: command.projectId, workspaceId: command.workspaceId },
          include: { currentVersion: true },
        })
        if (
          !project?.currentVersion
          || project.currentVersion.id !== command.baseVersionId
          || project.currentVersion.baseHash !== command.baseHash
          || bundleVersion.sequence !== project.currentVersion.sequence + 1
          || input.bundle.state.document.parentStateHash !== project.currentVersion.outputStateHash
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
        await commitProjectVersionWithOutputState(tx, input.bundle)
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
        // W68. This Command changes no crop: every output keeps the reframe plan it had on the base Version.
        await carryVariantReframePlans(tx, {
          workspaceId: command.workspaceId, projectId: command.projectId, fromVersionId: command.baseVersionId, toVersionId: bundleVersion.id,
          variantIds: input.bundle.state.document.entries.map((entry) => entry.variantId), createdAt: new Date(input.subtitleOverride.createdAt),
        })
        const updated = await tx.v2Project.updateMany({
          where: {
            id: command.projectId, workspaceId: command.workspaceId,
            currentVersionId: command.baseVersionId,
          },
          data: { currentVersionId: bundleVersion.id },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project changed during subtitle segment override commit')
        await settleDeferredOutputGuards(tx)
        return hydrate(
          await tx.v2SubtitleSegmentOverride.findUniqueOrThrow({
            where: { id_workspaceId: { id: input.subtitleOverride.id, workspaceId: input.subtitleOverride.workspaceId } },
            include,
          }),
          false,
        )
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 3) {
        return this.commitOrReplay(input, attempt + 1)
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) {
        const replay = await reconcileAfterConflict(
          error,
          () => this.findIdempotent({
            workspaceId: command.workspaceId, projectId: command.projectId,
            idempotencyKey: command.idempotencyKey,
          }),
        )
        if (replay?.requestFingerprint === requestFingerprint) return replay.result
        if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was reused with another subtitle segment override')
      }
      throw error
    }
  }
}
