import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  MulticamDirectionBase,
  MulticamDirectionDependencyRef,
  MulticamDirectionRepository,
  StoredMulticamDirection,
} from '../../application/ports/multicam-direction-repository.ts'
import { parseWithTicks, stringifyWithTicks } from './bigint-json.ts'
import { childRowId } from './child-row-id.ts'
import { colorCameraIdForTrack } from '../../domain/camera-identity.ts'
import type { CaptureTrackRole } from '../../domain/capture-session.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  ANGLE_CANDIDATE_SCHEMA_VERSION,
  ANGLE_SCORE_COMPONENT_NAMES,
  MULTICAM_DIRECTION_SCHEMA_VERSION,
  SHOT_DECISION_SCHEMA_VERSION,
  assertMulticamDirectionIntegrity,
  type AngleCandidate,
  type AngleContext,
  type AngleRejection,
  type AngleScoreComponentName,
  type AngleScoreComponents,
  type DirectionConfidenceBand,
  type DirectionPolicy,
  type DirectionRule,
  type DirectionWarning,
  type MulticamDirection,
  type OutputAspectRatio,
  type ScoreComponent,
  type ShotAlternative,
  type ShotDecision,
  type SpatialRelation,
} from '../../domain/multicam-direction.ts'
import {
  MULTICAM_EVIDENCE_SCHEMA_VERSION,
  assertMulticamEvidenceSetIntegrity,
  type EvidenceEvaluatorKind,
  type MulticamEvidenceKind,
  type MulticamEvidenceSet,
  type MulticamEvidenceValue,
  type MulticamObservation,
} from '../../domain/multicam-evidence.ts'
import type { DiagnosticStatus } from '../../domain/sync-diagnostic.ts'
import { createTickInterval } from '../../domain/session-time.ts'
import type { CoverageAvailability } from '../../domain/track-coverage.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function parse<T>(json: string, what: string): T {
  try {
    return JSON.parse(json) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${what} is not valid JSON`)
  }
}

/** The same, for payloads whose leaves include ticks. */
function parseTicks<T>(json: string, what: string): T {
  try {
    return parseWithTicks(json) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${what} is not valid JSON`)
  }
}

/** `<sessionId>:md<version>` — one row per link of the chain. */
function directionRowId(sessionId: string, version: number): string {
  return childRowId([sessionId, `md${version}`], 160)
}

function shotRowId(directionId: string, ordinal: number): string {
  return childRowId([directionId, `s${ordinal}`], 160)
}

/**
 * The evidence a candidate was scored on.
 *
 * Four readings with their own scores and observation refs, all inside the
 * candidate hash and none of them anything a constraint reasons about, so they
 * travel as one canonical JSON object rather than as sixteen columns.
 */
interface CandidateEvidence {
  readonly activeSpeaker: AngleCandidate['activeSpeaker']
  readonly screenActivity: AngleCandidate['screenActivity']
  readonly reaction: AngleCandidate['reaction']
  readonly technicalQuality: AngleCandidate['technicalQuality']
}

function candidateEvidenceOf(candidate: Readonly<AngleCandidate>): CandidateEvidence {
  return {
    activeSpeaker: candidate.activeSpeaker,
    screenActivity: candidate.screenActivity,
    reaction: candidate.reaction,
    technicalQuality: candidate.technicalQuality,
  }
}

function hydrateObservation(row: {
  observationId: string
  trackId: string
  rangeStartTicks: bigint
  rangeEndTicks: bigint
  kind: string
  valueJson: string
  confidence: number
  method: string
  evaluatorKind: string
  evidenceRef: string
  producedAt: Date
}): Readonly<MulticamObservation> {
  return Object.freeze({
    observationId: row.observationId,
    trackId: row.trackId,
    range: createTickInterval(row.rangeStartTicks, row.rangeEndTicks),
    kind: row.kind as MulticamEvidenceKind,
    value: Object.freeze(
      parse<MulticamEvidenceValue>(row.valueJson, `observation ${row.observationId} value`),
    ),
    confidence: row.confidence,
    provenance: Object.freeze({
      method: row.method,
      evaluatorKind: row.evaluatorKind as EvidenceEvaluatorKind,
      evidenceRef: row.evidenceRef,
      producedAt: row.producedAt.toISOString(),
    }),
  })
}

function hydrateEvidenceSet(row: {
  workspaceId: string
  sessionId: string
  schemaVersion: string
  sessionVersion: number
  referenceEpoch: number
  generatedAt: Date
  evidenceHash: string
  observations: readonly Parameters<typeof hydrateObservation>[0][]
}): Readonly<MulticamEvidenceSet> {
  if (row.schemaVersion !== MULTICAM_EVIDENCE_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored multicam evidence for ${row.sessionId} carries an unknown schema version`,
    )
  }
  const set: MulticamEvidenceSet = {
    schemaVersion: MULTICAM_EVIDENCE_SCHEMA_VERSION,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sessionVersion: row.sessionVersion,
    referenceEpoch: row.referenceEpoch,
    observations: Object.freeze(row.observations.map(hydrateObservation)),
    generatedAt: row.generatedAt.toISOString(),
    evidenceHash: row.evidenceHash,
  }
  // An observation whose confidence was nudged in the database changes the
  // hash, so the set is refused rather than used to justify a cut.
  return assertMulticamEvidenceSetIntegrity(Object.freeze(set))
}

function hydrateScoreComponents(
  shotId: string,
  candidateId: string,
  scoreTotal: number,
  rows: readonly { name: string; value: number; evidenceRefsJson: string }[],
): Readonly<AngleScoreComponents> {
  const byName = new Map(rows.map((row) => [row.name, row]))
  const parts: Partial<Record<AngleScoreComponentName, Readonly<ScoreComponent>>> = {}
  for (const name of ANGLE_SCORE_COMPONENT_NAMES) {
    const row = byName.get(name)
    if (!row) {
      // A missing part is not a zero: zero is a score that was computed and
      // came out at nothing, and reading it as one would let a truncated write
      // pass for a complete candidate.
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored candidate ${candidateId} of shot ${shotId} is missing its ${name} score component`,
      )
    }
    parts[name] = Object.freeze({
      value: row.value,
      evidenceRefs: Object.freeze(
        parse<string[]>(row.evidenceRefsJson, `candidate ${candidateId} ${name} evidence refs`),
      ),
    })
  }
  return Object.freeze({ ...parts, total: scoreTotal }) as Readonly<AngleScoreComponents>
}

function hydrateCandidate(row: {
  shotId: string
  candidateId: string
  schemaVersion: string
  trackId: string
  sourceAssetId: string
  role: string
  context: string
  sessionStartTicks: bigint
  sessionEndTicks: bigint
  sourceStartTicks: bigint | null
  sourceEndTicks: bigint | null
  sourcePieceId: string | null
  sourcePartId: string | null
  sourcePartAssetId: string | null
  coverageAvailability: string
  coverageConfidenceBps: number | null
  syncStatus: string | null
  syncConfidence: number | null
  previousTrackId: string | null
  sameAngleTicks: bigint
  spatialRelation: string
  protectedSelectionId: string | null
  protectedReason: string | null
  eligible: boolean
  rejectionReasonsJson: string
  evidenceJson: string
  scoreTotal: number
  candidateHash: string
  components: readonly { name: string; value: number; evidenceRefsJson: string }[]
}): Readonly<AngleCandidate> {
  if (row.schemaVersion !== ANGLE_CANDIDATE_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored candidate ${row.candidateId} carries an unknown schema version`,
    )
  }
  const evidence = parse<CandidateEvidence>(row.evidenceJson, `candidate ${row.candidateId} evidence`)
  return Object.freeze({
    schemaVersion: ANGLE_CANDIDATE_SCHEMA_VERSION,
    candidateId: row.candidateId,
    trackId: row.trackId,
    sourceAssetId: row.sourceAssetId,
    role: row.role as CaptureTrackRole,
    context: row.context as AngleContext,
    sessionRange: createTickInterval(row.sessionStartTicks, row.sessionEndTicks),
    sourceRange: row.sourceStartTicks === null || row.sourceEndTicks === null
      ? null
      : createTickInterval(row.sourceStartTicks, row.sourceEndTicks),
    sourcePieceId: row.sourcePieceId,
    sourcePartId: row.sourcePartId,
    sourcePartAssetId: row.sourcePartAssetId,
    coverage: Object.freeze({
      availability: row.coverageAvailability as CoverageAvailability | 'out-of-bounds' | 'unmeasured',
      confidenceBps: row.coverageConfidenceBps,
    }),
    syncStatus: row.syncStatus as DiagnosticStatus | 'reference' | null,
    syncConfidence: row.syncConfidence,
    activeSpeaker: evidence.activeSpeaker === null ? null : Object.freeze(evidence.activeSpeaker),
    screenActivity: evidence.screenActivity === null ? null : Object.freeze(evidence.screenActivity),
    reaction: evidence.reaction === null ? null : Object.freeze(evidence.reaction),
    technicalQuality: evidence.technicalQuality === null ? null : Object.freeze(evidence.technicalQuality),
    continuity: Object.freeze({
      previousTrackId: row.previousTrackId,
      sameAngleTicks: row.sameAngleTicks,
      spatialRelation: row.spatialRelation as SpatialRelation,
    }),
    protected: row.protectedSelectionId === null || row.protectedReason === null
      ? null
      : Object.freeze({ selectionId: row.protectedSelectionId, reason: row.protectedReason }),
    eligible: row.eligible,
    rejectionReasons: Object.freeze(
      parse<AngleRejection[]>(row.rejectionReasonsJson, `candidate ${row.candidateId} rejection reasons`),
    ),
    scoreComponents: hydrateScoreComponents(row.shotId, row.candidateId, row.scoreTotal, row.components),
    candidateHash: row.candidateHash,
  })
}

function hydrateShot(row: {
  shotId: string
  ordinal: number
  schemaVersion: string
  sessionStartTicks: bigint
  sessionEndTicks: bigint
  candidateId: string
  audioTrackId: string | null
  rule: string
  reason: string
  evidenceRefsJson: string
  evidenceRefsTruncated: number
  confidence: number
  confidenceBand: string
  decisionHash: string
  alternatives: readonly {
    candidateId: string
    trackId: string
    ordinal: number
    scoreTotal: number
    rejectedBecause: string
  }[]
  candidates: readonly Parameters<typeof hydrateCandidate>[0][]
}): Readonly<ShotDecision> {
  if (row.schemaVersion !== SHOT_DECISION_SCHEMA_VERSION) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored shot ${row.shotId} carries an unknown schema version`)
  }
  const chosen = row.candidates.find((candidate) => candidate.candidateId === row.candidateId)
  if (!chosen) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored shot ${row.shotId} names candidate ${row.candidateId}, which is not stored beside it`,
    )
  }
  const alternatives: readonly Readonly<ShotAlternative>[] = Object.freeze(
    [...row.alternatives]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((alternative) => Object.freeze({
        candidateId: alternative.candidateId,
        trackId: alternative.trackId,
        scoreTotal: alternative.scoreTotal,
        rejectedBecause: alternative.rejectedBecause,
      })),
  )
  return Object.freeze({
    schemaVersion: SHOT_DECISION_SCHEMA_VERSION,
    shotId: row.shotId,
    ordinal: row.ordinal,
    sessionRange: createTickInterval(row.sessionStartTicks, row.sessionEndTicks),
    chosen: hydrateCandidate(chosen),
    audioTrackId: row.audioTrackId,
    alternatives,
    rule: row.rule as DirectionRule,
    reason: row.reason,
    evidenceRefs: Object.freeze(parse<string[]>(row.evidenceRefsJson, `shot ${row.shotId} evidence refs`)),
    evidenceRefsTruncated: row.evidenceRefsTruncated,
    confidence: row.confidence,
    confidenceBand: row.confidenceBand as DirectionConfidenceBand,
    decisionHash: row.decisionHash,
  })
}

function hydrateDirection(row: {
  workspaceId: string
  sessionId: string
  schemaVersion: string
  version: number
  previousVersionHash: string | null
  sessionVersion: number
  referenceEpoch: number
  diagnosticVersion: number
  diagnosticHash: string
  evidenceHash: string
  rangeStartTicks: bigint
  rangeEndTicks: bigint
  aspectRatio: string
  policyJson: string
  audioTrackId: string | null
  audioRejectedJson: string
  uncoveredJson: string
  warningsJson: string
  manualReviewRequired: boolean
  generatedAt: Date
  directionHash: string
  shots: readonly Parameters<typeof hydrateShot>[0][]
}): Readonly<StoredMulticamDirection> {
  if (row.schemaVersion !== MULTICAM_DIRECTION_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored direction for ${row.sessionId} carries an unknown schema version`,
    )
  }
  const direction: MulticamDirection = {
    schemaVersion: MULTICAM_DIRECTION_SCHEMA_VERSION,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sessionVersion: row.sessionVersion,
    referenceEpoch: row.referenceEpoch,
    diagnosticVersion: row.diagnosticVersion,
    diagnosticHash: row.diagnosticHash,
    evidenceHash: row.evidenceHash,
    range: createTickInterval(row.rangeStartTicks, row.rangeEndTicks),
    format: Object.freeze({ aspectRatio: row.aspectRatio as OutputAspectRatio }),
    policy: Object.freeze(parse<DirectionPolicy>(row.policyJson, `direction ${row.sessionId} policy`)),
    audio: Object.freeze({
      trackId: row.audioTrackId,
      rejected: Object.freeze(
        parse<{ trackId: string; reason: AngleRejection }[]>(
          row.audioRejectedJson,
          `direction ${row.sessionId} rejected audio`,
        ).map((entry) => Object.freeze(entry)),
      ),
    }),
    shots: Object.freeze(
      [...row.shots].sort((left, right) => left.ordinal - right.ordinal).map(hydrateShot),
    ),
    // Uncovered stretches are tick intervals, and a tick is a bigint that
    // JSON.stringify refuses outright — the same codec Wave 18 uses writes
    // them as {"$tick": "…"} so the bytes beside the hash stay identical.
    uncovered: Object.freeze(
      parseTicks<{ start: bigint; end: bigint }[]>(row.uncoveredJson, `direction ${row.sessionId} uncovered ranges`)
        .map((range) => createTickInterval(range.start, range.end)),
    ),
    warnings: Object.freeze(
      parse<DirectionWarning[]>(row.warningsJson, `direction ${row.sessionId} warnings`)
        .map((warning) => Object.freeze(warning)),
    ),
    manualReviewRequired: row.manualReviewRequired,
    generatedAt: row.generatedAt.toISOString(),
    directionHash: row.directionHash,
  }
  // Recomputes candidate → shot → direction. A confidence softened in the
  // database, or a shot quietly re-pointed at an ineligible angle, fails here
  // rather than reaching a renderer as an authored cut.
  assertMulticamDirectionIntegrity(Object.freeze(direction))
  return Object.freeze({
    direction,
    version: row.version,
    previousVersionHash: row.previousVersionHash,
  })
}

const DIRECTION_INCLUDE = {
  shots: {
    include: {
      alternatives: true,
      candidates: { include: { components: true } },
    },
  },
} as const

export class PrismaMulticamDirectionRepository implements MulticamDirectionRepository {
  private readonly client: PrismaClient

  // No parameter property: the strip-only TypeScript that plain `node` runs
  // refuses `constructor(private readonly …)` outright.
  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async persistEvidenceSet(input: {
    set: Readonly<MulticamEvidenceSet>
    createdAt: string
  }): Promise<Readonly<{ set: Readonly<MulticamEvidenceSet>; replayed: boolean }>> {
    const { set } = input
    const id = childRowId([set.sessionId, `ev-${set.evidenceHash.slice(0, 16)}`], 128)
    const at = new Date(input.createdAt)
    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2MulticamEvidenceSet.create({
          data: {
            id,
            workspaceId: set.workspaceId,
            sessionId: set.sessionId,
            schemaVersion: set.schemaVersion,
            sessionVersion: set.sessionVersion,
            referenceEpoch: set.referenceEpoch,
            observationCount: set.observations.length,
            generatedAt: new Date(set.generatedAt),
            evidenceHash: set.evidenceHash,
            createdAt: at,
          },
        })
        if (set.observations.length === 0) return
        await transaction.v2MulticamObservation.createMany({
          data: set.observations.map((observation) => ({
            id: childRowId([id, observation.observationId], 160),
            workspaceId: set.workspaceId,
            evidenceSetId: id,
            observationId: observation.observationId,
            trackId: observation.trackId,
            rangeStartTicks: observation.range.start,
            rangeEndTicks: observation.range.end,
            kind: observation.kind,
            valueJson: JSON.stringify(observation.value),
            confidence: observation.confidence,
            method: observation.provenance.method,
            evaluatorKind: observation.provenance.evaluatorKind,
            evidenceRef: observation.provenance.evidenceRef,
            producedAt: new Date(observation.provenance.producedAt),
          })),
        })
      })
      return Object.freeze({ set, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.readEvidenceSet({
        workspaceId: set.workspaceId,
        evidenceHash: set.evidenceHash,
      })
      // The hash is over the observations, so an equal hash is an equal set:
      // a repeat write is the same answer arriving twice, not a second one.
      if (stored) return Object.freeze({ set: stored, replayed: true })
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Multicam evidence ${id} already exists with different content`,
      )
    }
  }

  async readEvidenceSet(input: { workspaceId: string; evidenceHash: string }) {
    const row = await this.client.v2MulticamEvidenceSet.findFirst({
      where: { workspaceId: input.workspaceId, evidenceHash: input.evidenceHash },
      include: { observations: { orderBy: { observationId: 'asc' } } },
    })
    return row ? hydrateEvidenceSet(row) : null
  }

  async readLatestEvidenceSet(input: { workspaceId: string; sessionId: string }) {
    const row = await this.client.v2MulticamEvidenceSet.findFirst({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
      include: { observations: { orderBy: { observationId: 'asc' } } },
    })
    return row ? hydrateEvidenceSet(row) : null
  }

  async appendVersion(input: {
    direction: Readonly<MulticamDirection>
    base: Readonly<MulticamDirectionBase> | null
    occurredAt: string
  }): Promise<Readonly<{ stored: Readonly<StoredMulticamDirection>; replayed: boolean }>> {
    const { direction, base } = input
    const version = base === null ? 1 : base.version + 1
    const id = directionRowId(direction.sessionId, version)
    const at = new Date(input.occurredAt)
    const lowConfidence = direction.shots.filter(
      (shot) => shot.confidenceBand === 'low' || shot.confidenceBand === 'insufficient',
    ).length

    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2MulticamDirection.create({
          data: {
            id,
            workspaceId: direction.workspaceId,
            sessionId: direction.sessionId,
            schemaVersion: direction.schemaVersion,
            version,
            previousVersionHash: base === null ? null : base.directionHash,
            sessionVersion: direction.sessionVersion,
            referenceEpoch: direction.referenceEpoch,
            diagnosticVersion: direction.diagnosticVersion,
            diagnosticHash: direction.diagnosticHash,
            evidenceHash: direction.evidenceHash,
            rangeStartTicks: direction.range.start,
            rangeEndTicks: direction.range.end,
            aspectRatio: direction.format.aspectRatio,
            policyCalibrationVersion: direction.policy.calibrationVersion,
            policyJson: JSON.stringify(direction.policy),
            audioTrackId: direction.audio.trackId,
            audioRejectedJson: JSON.stringify(direction.audio.rejected),
            shotCount: direction.shots.length,
            lowConfidenceShotCount: lowConfidence,
            uncoveredJson: stringifyWithTicks(direction.uncovered),
            uncoveredCount: direction.uncovered.length,
            warningsJson: JSON.stringify(direction.warnings),
            warningCount: direction.warnings.length,
            manualReviewRequired: direction.manualReviewRequired,
            generatedAt: new Date(direction.generatedAt),
            directionHash: direction.directionHash,
            createdAt: at,
          },
        })

        for (const shot of direction.shots) {
          const shotId = shotRowId(id, shot.ordinal)
          await transaction.v2MulticamShotDecision.create({
            data: {
              id: shotId,
              workspaceId: direction.workspaceId,
              directionId: id,
              sessionId: direction.sessionId,
              shotId: shot.shotId,
              ordinal: shot.ordinal,
              schemaVersion: shot.schemaVersion,
              sessionStartTicks: shot.sessionRange.start,
              sessionEndTicks: shot.sessionRange.end,
              trackId: shot.chosen.trackId,
              // The one camera key every consumer agrees on, folded from the
              // track id rather than declared: a ColorPlan layer, a rendered
              // clip and this shot must name the same camera or a correction
              // lands on the wrong footage (camera-identity.ts).
              cameraId: colorCameraIdForTrack({ trackId: shot.chosen.trackId }),
              candidateId: shot.chosen.candidateId,
              candidateHash: shot.chosen.candidateHash,
              sourcePieceId: shot.chosen.sourcePieceId,
              sourcePartId: shot.chosen.sourcePartId,
              audioTrackId: shot.audioTrackId,
              rule: shot.rule,
              reason: shot.reason,
              evidenceRefsJson: JSON.stringify(shot.evidenceRefs),
              evidenceRefCount: shot.evidenceRefs.length,
              evidenceRefsTruncated: shot.evidenceRefsTruncated,
              confidence: shot.confidence,
              confidenceBand: shot.confidenceBand,
              alternativeCount: shot.alternatives.length,
              decisionHash: shot.decisionHash,
            },
          })

          const candidateRowId = childRowId([shotId, 'c0'], 160)
          await transaction.v2MulticamAngleCandidate.create({
            data: {
              id: candidateRowId,
              workspaceId: direction.workspaceId,
              shotId,
              directionId: id,
              candidateId: shot.chosen.candidateId,
              schemaVersion: shot.chosen.schemaVersion,
              trackId: shot.chosen.trackId,
              sourceAssetId: shot.chosen.sourceAssetId,
              role: shot.chosen.role,
              context: shot.chosen.context,
              sessionStartTicks: shot.chosen.sessionRange.start,
              sessionEndTicks: shot.chosen.sessionRange.end,
              sourceStartTicks: shot.chosen.sourceRange?.start ?? null,
              sourceEndTicks: shot.chosen.sourceRange?.end ?? null,
              sourcePieceId: shot.chosen.sourcePieceId,
              sourcePartId: shot.chosen.sourcePartId,
              sourcePartAssetId: shot.chosen.sourcePartAssetId,
              coverageAvailability: shot.chosen.coverage.availability,
              coverageConfidenceBps: shot.chosen.coverage.confidenceBps,
              syncStatus: shot.chosen.syncStatus,
              syncConfidence: shot.chosen.syncConfidence,
              previousTrackId: shot.chosen.continuity.previousTrackId,
              sameAngleTicks: shot.chosen.continuity.sameAngleTicks,
              spatialRelation: shot.chosen.continuity.spatialRelation,
              protectedSelectionId: shot.chosen.protected?.selectionId ?? null,
              protectedReason: shot.chosen.protected?.reason ?? null,
              eligible: shot.chosen.eligible,
              rejectionReasonsJson: JSON.stringify(shot.chosen.rejectionReasons),
              rejectionCount: shot.chosen.rejectionReasons.length,
              evidenceJson: JSON.stringify(candidateEvidenceOf(shot.chosen)),
              scoreTotal: shot.chosen.scoreComponents.total,
              candidateHash: shot.chosen.candidateHash,
            },
          })

          await transaction.v2MulticamAngleScoreComponent.createMany({
            data: ANGLE_SCORE_COMPONENT_NAMES.map((name) => {
              const component = shot.chosen.scoreComponents[name]
              return {
                id: childRowId([candidateRowId, name], 160),
                workspaceId: direction.workspaceId,
                candidateId: candidateRowId,
                name,
                value: component.value,
                evidenceRefsJson: JSON.stringify(component.evidenceRefs),
                evidenceRefCount: component.evidenceRefs.length,
              }
            }),
          })

          if (shot.alternatives.length > 0) {
            await transaction.v2MulticamShotAlternative.createMany({
              data: shot.alternatives.map((alternative, index) => ({
                id: childRowId([shotId, `a${index}`], 160),
                workspaceId: direction.workspaceId,
                shotId,
                directionId: id,
                candidateId: alternative.candidateId,
                trackId: alternative.trackId,
                ordinal: index,
                scoreTotal: alternative.scoreTotal,
                rejectedBecause: alternative.rejectedBecause,
              })),
            })
          }
        }

        if (base === null) {
          await transaction.v2MulticamDirectionHead.create({
            data: {
              id: direction.sessionId,
              workspaceId: direction.workspaceId,
              sessionId: direction.sessionId,
              version: 1,
              directionHash: direction.directionHash,
              shotCount: direction.shots.length,
              manualReviewRequired: direction.manualReviewRequired,
              createdAt: at,
              updatedAt: at,
            },
          })
          return
        }

        // The fence is the version *and* the hash, in the predicate rather than
        // in a preceding read: a number alone can be reused after a write that
        // failed halfway, so the pair is what proves this writer was looking at
        // the document it edited.
        const advanced = await transaction.v2MulticamDirectionHead.updateMany({
          where: {
            workspaceId: direction.workspaceId,
            sessionId: direction.sessionId,
            version: base.version,
            directionHash: base.directionHash,
          },
          data: {
            version,
            directionHash: direction.directionHash,
            shotCount: direction.shots.length,
            manualReviewRequired: direction.manualReviewRequired,
            updatedAt: at,
          },
        })
        if (advanced.count !== 1) {
          const current = await transaction.v2MulticamDirectionHead.findFirst({
            where: { workspaceId: direction.workspaceId, sessionId: direction.sessionId },
            select: { version: true, directionHash: true },
          })
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            `The direction for ${direction.sessionId} moved on: version ${base.version} is no longer current`,
            {
              currentVersion: current?.version ?? null,
              currentHash: current?.directionHash ?? null,
            },
          )
        }
      })
      const stored = await this.readVersion({
        workspaceId: direction.workspaceId,
        sessionId: direction.sessionId,
        version,
      })
      if (!stored) {
        throw new DomainError('PERSISTENCE_CONFLICT', `Direction ${id} vanished between write and read`)
      }
      return Object.freeze({ stored, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.readVersion({
        workspaceId: direction.workspaceId,
        sessionId: direction.sessionId,
        version,
      })
      if (stored && stored.direction.directionHash === direction.directionHash) {
        return Object.freeze({ stored, replayed: true })
      }
      // Two different cuts claiming one link of the chain. Picking either would
      // discard a decision somebody made.
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `The direction for ${direction.sessionId} already has a different version ${version}`,
      )
    }
  }

  async readHead(input: { workspaceId: string; sessionId: string }) {
    const head = await this.client.v2MulticamDirectionHead.findFirst({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      select: { version: true },
    })
    return head ? this.readVersion({ ...input, version: head.version }) : null
  }

  async readVersion(input: { workspaceId: string; sessionId: string; version: number }) {
    const row = await this.client.v2MulticamDirection.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        version: input.version,
      },
      include: DIRECTION_INCLUDE,
    })
    return row ? hydrateDirection(row) : null
  }

  async listVersions(input: { workspaceId: string; sessionId: string; limit?: number }) {
    const rows = await this.client.v2MulticamDirection.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: { version: 'desc' },
      take: Math.min(Math.max(input.limit ?? 25, 1), 200),
      include: DIRECTION_INCLUDE,
    })
    return Object.freeze(rows.map(hydrateDirection))
  }

  async findDependents(input: {
    workspaceId: string
    sessionId?: string
    diagnosticHash?: string
    evidenceHash?: string
  }): Promise<readonly Readonly<MulticamDirectionDependencyRef>[]> {
    const rows = await this.client.v2MulticamDirection.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.diagnosticHash ? { diagnosticHash: input.diagnosticHash } : {}),
        ...(input.evidenceHash ? { evidenceHash: input.evidenceHash } : {}),
      },
      orderBy: [{ sessionId: 'asc' }, { version: 'desc' }],
      select: {
        sessionId: true,
        version: true,
        directionHash: true,
        diagnosticVersion: true,
        diagnosticHash: true,
        evidenceHash: true,
        manualReviewRequired: true,
      },
    })
    if (rows.length === 0) return Object.freeze([])
    const heads = await this.client.v2MulticamDirectionHead.findMany({
      where: {
        workspaceId: input.workspaceId,
        sessionId: { in: [...new Set(rows.map((row) => row.sessionId))] },
      },
      select: { sessionId: true, directionHash: true },
    })
    const headHashes = new Map(heads.map((head) => [head.sessionId, head.directionHash]))
    return Object.freeze(rows.map((row) => Object.freeze({
      ...row,
      isHead: headHashes.get(row.sessionId) === row.directionHash,
    })))
  }
}
