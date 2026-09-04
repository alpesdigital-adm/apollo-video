import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { EditorialSynthesisRepository } from '../../application/ports/editorial-synthesis-repository.ts'
import {
  assertEditorialSynthesisIntegrity,
  EDITORIAL_SYNTHESIS_SCHEMA_VERSION,
  type EditorialSynthesis,
  type EditorialSynthesisEditPlan,
  type SynthesisContinuityDimension,
  type SynthesisJoin,
  type SynthesisJoinKind,
  type SynthesisRange,
} from '../../domain/editorial-synthesis.ts'
import { DomainError } from '../../domain/errors.ts'
import { rational } from '../../domain/session-time.ts'
import type { StoryPlan } from '../../domain/story-plan.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { parseWithTicks, stringifyWithTicks } from './bigint-json.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/**
 * The rows for one synthesis, derived once so the write and the replay check
 * cannot drift apart.
 *
 * Ordinals come from the aggregate's own order rather than being recomputed on
 * read: the order is the cut, and re-deriving it from timestamps would let a
 * stored synthesis come back as a different film.
 */
function toRows(synthesis: Readonly<EditorialSynthesis>, createdAt: string) {
  return {
    head: {
      id: synthesis.id,
      workspaceId: synthesis.workspaceId,
      projectId: synthesis.projectId,
      schemaVersion: synthesis.schemaVersion,
      objective: synthesis.objective,
      targetDurationMs: synthesis.targetDurationMs,
      toleranceMs: synthesis.toleranceMs,
      synthesizedDurationMs: synthesis.synthesizedDurationMs,
      sourceDurationMs: synthesis.sourceDurationMs,
      droppedMs: synthesis.droppedMs,
      chronologyPreserved: synthesis.chronologyPreserved,
      reorderReason: synthesis.reorderReason,
      contextProofJson: stringifyWithTicks(synthesis.contextProof),
      storyPlanId: synthesis.storyPlan.id,
      editPlanId: synthesis.editPlan.id,
      editPlanJson: stringifyWithTicks(synthesis.editPlan),
      editPlanSelectionHash: synthesis.editPlan.selectionHash,
      frameRateNum: synthesis.editPlan.frameRate.num,
      frameRateDen: synthesis.editPlan.frameRate.den,
      synthesisHash: synthesis.synthesisHash,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    },
    ranges: synthesis.ranges.map((range, ordinal) => ({
      id: `${synthesis.id}:${range.rangeId}`,
      workspaceId: synthesis.workspaceId,
      synthesisId: synthesis.id,
      rangeId: range.rangeId,
      ordinal,
      startMs: range.startMs,
      endMs: range.endMs,
      sourceArtifactId: range.lineage.sourceArtifactId,
      sourceArtifactSha256: range.lineage.sourceArtifactSha256,
      sourceManifestId: range.lineage.sourceManifestId,
      sourceManifestHash: range.lineage.sourceManifestHash,
      indexRunId: range.lineage.indexRunId,
      momentId: range.lineage.momentId,
      momentHash: range.lineage.momentHash,
      evaluationId: range.lineage.evaluationId,
      evaluationHash: range.lineage.evaluationHash,
      rightsSnapshotId: range.rightsSnapshotId,
      rightsStatus: range.rightsStatus,
      consentStatus: range.consentStatus,
      claimIdsJson: JSON.stringify([...range.claimIds]),
      qualifierIdsJson: JSON.stringify([...range.qualifierIds]),
      proofContextIdsJson: JSON.stringify([...range.proofContextIds]),
    })),
    joins: synthesis.joins.map((join, ordinal) => ({
      id: `${synthesis.id}:join:${ordinal}`,
      workspaceId: synthesis.workspaceId,
      synthesisId: synthesis.id,
      ordinal,
      beforeRangeId: join.beforeRangeId,
      afterRangeId: join.afterRangeId,
      kind: join.kind,
      droppedMs: join.droppedMs,
      timelineMs: join.timelineMs,
      justification: join.justification,
      continuityRisksJson: JSON.stringify([...join.continuityRisks]),
    })),
  }
}

/**
 * What the database hands back, not what we wrote.
 *
 * Deriving these from the write shape would narrow `rightsStatus` to the domain
 * union before anything checked it, so a row carrying a value no enum allows
 * would typecheck on the way in and fail somewhere less obvious. Postgres
 * returns `string`; the CHECK constraint is what keeps it honest, and the cast
 * happens once, explicitly, in the hydrator.
 */
type RangeRow = Readonly<{
  rangeId: string
  ordinal: number
  startMs: number
  endMs: number
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  indexRunId: string
  momentId: string
  momentHash: string
  evaluationId: string
  evaluationHash: string
  rightsSnapshotId: string
  rightsStatus: string
  consentStatus: string
  claimIdsJson: string
  qualifierIdsJson: string
  proofContextIdsJson: string
}>

type JoinRow = Readonly<{
  ordinal: number
  beforeRangeId: string
  afterRangeId: string
  kind: string
  droppedMs: number
  timelineMs: number
  justification: string
  continuityRisksJson: string
}>

function parseIds(json: string, field: string): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored synthesis ${field} is not valid JSON`)
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored synthesis ${field} is not a list of identifiers`)
  }
  return Object.freeze(parsed as string[])
}

function hydrateRange(row: RangeRow): Readonly<SynthesisRange> {
  return Object.freeze({
    rangeId: row.rangeId,
    startMs: row.startMs,
    endMs: row.endMs,
    lineage: Object.freeze({
      sourceArtifactId: row.sourceArtifactId,
      sourceArtifactSha256: row.sourceArtifactSha256,
      sourceManifestId: row.sourceManifestId,
      sourceManifestHash: row.sourceManifestHash,
      indexRunId: row.indexRunId,
      momentId: row.momentId,
      momentHash: row.momentHash,
      evaluationId: row.evaluationId,
      evaluationHash: row.evaluationHash,
    }),
    rightsSnapshotId: row.rightsSnapshotId,
    rightsStatus: row.rightsStatus as SynthesisRange['rightsStatus'],
    consentStatus: row.consentStatus as SynthesisRange['consentStatus'],
    claimIds: parseIds(row.claimIdsJson, 'claimIds'),
    qualifierIds: parseIds(row.qualifierIdsJson, 'qualifierIds'),
    proofContextIds: parseIds(row.proofContextIdsJson, 'proofContextIds'),
  })
}

function hydrateJoin(row: JoinRow): Readonly<SynthesisJoin> {
  return Object.freeze({
    beforeRangeId: row.beforeRangeId,
    afterRangeId: row.afterRangeId,
    kind: row.kind as SynthesisJoinKind,
    droppedMs: row.droppedMs,
    timelineMs: row.timelineMs,
    justification: row.justification,
    continuityRisks: parseIds(row.continuityRisksJson, 'continuityRisks') as readonly SynthesisContinuityDimension[],
  })
}

export class PrismaEditorialSynthesisRepository implements EditorialSynthesisRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async persist(input: {
    synthesis: Readonly<EditorialSynthesis>
    createdAt: string
  }): Promise<Readonly<{ synthesis: Readonly<EditorialSynthesis>; replayed: boolean }>> {
    const rows = toRows(input.synthesis, input.createdAt)
    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2EditorialSynthesis.create({ data: rows.head })
        // Ranges and joins go in with the head or not at all. A synthesis whose
        // joins failed to write would read back as a cut with no recorded
        // justifications — which is precisely the state the domain refuses to
        // construct.
        if (rows.ranges.length > 0) {
          await transaction.v2EditorialSynthesisRange.createMany({ data: rows.ranges })
        }
        if (rows.joins.length > 0) {
          await transaction.v2EditorialSynthesisJoin.createMany({ data: rows.joins })
        }
      })
      return Object.freeze({ synthesis: input.synthesis, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      // Same id already present. The same bytes are a replay; different bytes
      // are a conflict, because the stored justifications are the audit trail
      // for cuts somebody may already have reviewed.
      const existing = await this.read({
        workspaceId: input.synthesis.workspaceId,
        synthesisId: input.synthesis.id,
      })
      if (existing && existing.synthesisHash === input.synthesis.synthesisHash) {
        return Object.freeze({ synthesis: existing, replayed: true })
      }
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Editorial synthesis ${input.synthesis.id} already exists with different content`,
      )
    }
  }

  async read(input: {
    workspaceId: string
    synthesisId: string
  }): Promise<Readonly<EditorialSynthesis> | null> {
    const row = await this.client.v2EditorialSynthesis.findFirst({
      where: { id: input.synthesisId, workspaceId: input.workspaceId },
      include: {
        ranges: { orderBy: { ordinal: 'asc' } },
        joins: { orderBy: { ordinal: 'asc' } },
      },
    })
    return row ? this.hydrate(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    limit?: number
  }): Promise<readonly Readonly<EditorialSynthesis>[]> {
    const rows = await this.client.v2EditorialSynthesis.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(input.limit ?? 25, 1), 100),
      include: {
        ranges: { orderBy: { ordinal: 'asc' } },
        joins: { orderBy: { ordinal: 'asc' } },
      },
    })
    return Object.freeze(rows.map((row) => this.hydrate(row)))
  }

  async listByMoment(input: {
    workspaceId: string
    momentId: string
    limit?: number
  }): Promise<readonly Readonly<{ synthesisId: string; rangeId: string; startMs: number; endMs: number }>[]> {
    const rows = await this.client.v2EditorialSynthesisRange.findMany({
      where: { workspaceId: input.workspaceId, momentId: input.momentId },
      orderBy: [{ synthesisId: 'asc' }, { ordinal: 'asc' }],
      take: Math.min(Math.max(input.limit ?? 50, 1), 200),
      select: { synthesisId: true, rangeId: true, startMs: true, endMs: true },
    })
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })))
  }

  /**
   * Rebuild the aggregate from its columns and prove it still hashes to what
   * was stored.
   *
   * The hash covers the ranges, the joins and every justification, so a column
   * edited behind the aggregate's back — a justification softened, a range
   * widened — fails here rather than rendering.
   */
  private hydrate(row: {
    id: string
    workspaceId: string
    projectId: string
    schemaVersion: string
    objective: string
    targetDurationMs: number
    toleranceMs: number
    synthesizedDurationMs: number
    sourceDurationMs: number
    droppedMs: number
    chronologyPreserved: boolean
    reorderReason: string | null
    contextProofJson: string
    storyPlanId: string
    editPlanJson: string
    synthesisHash: string
    ranges: RangeRow[]
    joins: JoinRow[]
  }): Readonly<EditorialSynthesis> {
    if (row.schemaVersion !== EDITORIAL_SYNTHESIS_SCHEMA_VERSION) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored editorial synthesis ${row.id} carries an unknown schema version`,
      )
    }
    let editPlan: EditorialSynthesisEditPlan
    let contextProof: EditorialSynthesis['contextProof']
    try {
      editPlan = parseWithTicks(row.editPlanJson) as EditorialSynthesisEditPlan
      contextProof = parseWithTicks(row.contextProofJson) as EditorialSynthesis['contextProof']
    } catch {
      throw new DomainError('PERSISTENCE_CONFLICT', `Stored editorial synthesis ${row.id} has invalid JSON`)
    }
    // The rational frame rate goes through `rational` on the way back so a
    // stored 60000/1000 and a stored 60/1 are the same rate again — the hash
    // was computed over the reduced form.
    const restoredPlan: EditorialSynthesisEditPlan = {
      ...editPlan,
      frameRate: rational(BigInt(editPlan.frameRate.num), BigInt(editPlan.frameRate.den)),
    }
    const synthesis = {
      schemaVersion: EDITORIAL_SYNTHESIS_SCHEMA_VERSION,
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      objective: row.objective,
      targetDurationMs: row.targetDurationMs,
      toleranceMs: row.toleranceMs,
      synthesizedDurationMs: row.synthesizedDurationMs,
      sourceDurationMs: row.sourceDurationMs,
      ranges: Object.freeze(row.ranges.map(hydrateRange)),
      joins: Object.freeze(row.joins.map(hydrateJoin)),
      droppedMs: row.droppedMs,
      chronologyPreserved: row.chronologyPreserved,
      reorderReason: row.reorderReason,
      contextProof,
      // Only the identity of the story plan is stored here; the plan itself
      // belongs to its own aggregate and is not duplicated. The hash was
      // computed over the identity alone, so this round-trips.
      storyPlan: Object.freeze({ id: row.storyPlanId, mode: 'multi-range' as const }) as
        Readonly<StoryPlan> & Readonly<{ id: string; mode: 'multi-range' }>,
      editPlan: Object.freeze(restoredPlan),
      synthesisHash: row.synthesisHash,
    } as EditorialSynthesis
    return assertEditorialSynthesisIntegrity(Object.freeze(synthesis))
  }
}
