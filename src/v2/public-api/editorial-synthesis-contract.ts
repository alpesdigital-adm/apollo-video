import type {
  EditorialSynthesis,
  SynthesisContinuityDimension,
  SynthesisJoinKind,
  SynthesisRange,
} from '../domain/editorial-synthesis.ts'
import { splicedJoins, synthesisCompressionBps } from '../domain/editorial-synthesis.ts'
import { DomainError } from '../domain/errors.ts'
import type { Rational } from '../domain/session-time.ts'
import { formatRational, parseRationalString } from './capture-session-contract.ts'

/**
 * The public boundary for multi-range editorial synthesis (F4.001 / FR-135).
 *
 * The parser deliberately does not decide anything the domain decides. It does
 * not infer whether a join is a splice, does not sort the ranges, and does not
 * fill in a missing justification — all three are assertions about what the
 * speaker said, and the domain refuses them for reasons a boundary parser has
 * no way to evaluate. What this module does is reject malformed input early
 * and turn the aggregate back into JSON afterwards.
 */

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown })
  }
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value.trim()
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value
}

function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is not one of ${allowed.join(', ')}`)
  }
  return value as T
}

function identifiers(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an array`)
  return Object.freeze(value.map((entry, index) => text(entry, `${field}[${index}]`, 128)))
}

function parseRange(value: unknown, field: string): Readonly<SynthesisRange> {
  const body = record(value, field)
  exactFields(body, ['rangeId', 'startMs', 'endMs', 'lineage', 'rightsSnapshotId',
    'rightsStatus', 'consentStatus', 'claimIds', 'qualifierIds', 'proofContextIds'], field)
  const lineage = record(body.lineage, `${field}.lineage`)
  exactFields(lineage, ['sourceArtifactId', 'sourceArtifactSha256', 'sourceManifestId',
    'sourceManifestHash', 'indexRunId', 'momentId', 'momentHash', 'evaluationId',
    'evaluationHash'], `${field}.lineage`)
  return Object.freeze({
    rangeId: text(body.rangeId, `${field}.rangeId`, 128),
    startMs: integer(body.startMs, `${field}.startMs`, 0, 86_400_000),
    endMs: integer(body.endMs, `${field}.endMs`, 1, 86_400_000),
    lineage: Object.freeze({
      sourceArtifactId: text(lineage.sourceArtifactId, `${field}.lineage.sourceArtifactId`, 128),
      sourceArtifactSha256: text(lineage.sourceArtifactSha256, `${field}.lineage.sourceArtifactSha256`, 64),
      sourceManifestId: text(lineage.sourceManifestId, `${field}.lineage.sourceManifestId`, 128),
      sourceManifestHash: text(lineage.sourceManifestHash, `${field}.lineage.sourceManifestHash`, 64),
      indexRunId: text(lineage.indexRunId, `${field}.lineage.indexRunId`, 128),
      momentId: text(lineage.momentId, `${field}.lineage.momentId`, 128),
      momentHash: text(lineage.momentHash, `${field}.lineage.momentHash`, 64),
      evaluationId: text(lineage.evaluationId, `${field}.lineage.evaluationId`, 128),
      evaluationHash: text(lineage.evaluationHash, `${field}.lineage.evaluationHash`, 64),
    }),
    rightsSnapshotId: text(body.rightsSnapshotId, `${field}.rightsSnapshotId`, 128),
    // `blocked` is accepted by the parser and refused by the domain, on
    // purpose: a caller that honestly reports a revoked right deserves the
    // domain's message about which range it was, not a shape error here.
    rightsStatus: member(body.rightsStatus, ['approved', 'blocked'] as const, `${field}.rightsStatus`),
    consentStatus: member(body.consentStatus,
      ['approved', 'not-required', 'blocked'] as const, `${field}.consentStatus`),
    claimIds: identifiers(body.claimIds, `${field}.claimIds`),
    qualifierIds: identifiers(body.qualifierIds, `${field}.qualifierIds`),
    proofContextIds: identifiers(body.proofContextIds, `${field}.proofContextIds`),
  })
}

function parseJoin(value: unknown, field: string) {
  const body = record(value, field)
  exactFields(body, ['beforeRangeId', 'afterRangeId', 'kind', 'justification', 'continuityRisks'], field)
  const risks = body.continuityRisks === undefined
    ? []
    : Array.isArray(body.continuityRisks)
      ? body.continuityRisks.map((entry, index) => member(entry,
        ['argument', 'audio', 'eye-line', 'position', 'color'] as const,
        `${field}.continuityRisks[${index}]`))
      : (() => { throw new DomainError('INVALID_ARGUMENT', `${field}.continuityRisks must be an array`) })()
  return Object.freeze({
    beforeRangeId: text(body.beforeRangeId, `${field}.beforeRangeId`, 128),
    afterRangeId: text(body.afterRangeId, `${field}.afterRangeId`, 128),
    kind: member(body.kind, ['contiguous', 'spliced'] as const, `${field}.kind`) as SynthesisJoinKind,
    // Empty is legal here: a contiguous join needs none, and the domain is what
    // decides whether this one is contiguous.
    justification: typeof body.justification === 'string' ? body.justification : '',
    continuityRisks: Object.freeze(risks) as readonly SynthesisContinuityDimension[],
  })
}

export function parseCreateEditorialSynthesisBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(body, ['synthesisId', 'objective', 'targetDurationMs', 'toleranceMs',
    'sourceDurationMs', 'frameRate', 'storyPlanId', 'editPlanId', 'allowReorder',
    'ranges', 'joins'], 'body')
  if (!Array.isArray(body.ranges) || body.ranges.length === 0 || body.ranges.length > 256) {
    throw new DomainError('INVALID_ARGUMENT', 'ranges must hold between 1 and 256 entries')
  }
  if (!Array.isArray(body.joins) || body.joins.length > 255) {
    throw new DomainError('INVALID_ARGUMENT', 'joins must hold at most 255 entries')
  }
  const allowReorder = body.allowReorder === undefined
    ? undefined
    : (() => {
      const entry = record(body.allowReorder, 'allowReorder')
      exactFields(entry, ['reason'], 'allowReorder')
      return Object.freeze({ reason: text(entry.reason, 'allowReorder.reason', 512) })
    })()
  return Object.freeze({
    synthesisId: text(body.synthesisId, 'synthesisId', 128),
    objective: text(body.objective, 'objective', 512),
    targetDurationMs: integer(body.targetDurationMs, 'targetDurationMs', 1_000, 3_600_000),
    toleranceMs: integer(body.toleranceMs, 'toleranceMs', 0, 60_000),
    sourceDurationMs: integer(body.sourceDurationMs, 'sourceDurationMs', 1, 86_400_000),
    frameRate: parseRationalString(body.frameRate, 'frameRate') as Rational,
    storyPlanId: text(body.storyPlanId, 'storyPlanId', 128),
    editPlanId: text(body.editPlanId, 'editPlanId', 128),
    allowReorder,
    ranges: Object.freeze(body.ranges.map((entry, index) => parseRange(entry, `ranges[${index}]`))),
    joins: Object.freeze(body.joins.map((entry, index) => parseJoin(entry, `joins[${index}]`))),
  })
}

export function presentEditorialSynthesisSummary(synthesis: Readonly<EditorialSynthesis>) {
  return Object.freeze({
    synthesisId: synthesis.id,
    objective: synthesis.objective,
    synthesizedDurationMs: synthesis.synthesizedDurationMs,
    sourceDurationMs: synthesis.sourceDurationMs,
    droppedMs: synthesis.droppedMs,
    compressionBps: synthesisCompressionBps(synthesis),
    rangeCount: synthesis.ranges.length,
    // Splices, not joins: a contiguous join asserts nothing the source did not
    // already assert, so counting them together would hide how much of the cut
    // is the system's claim rather than the speaker's.
    spliceCount: splicedJoins(synthesis).length,
    chronologyPreserved: synthesis.chronologyPreserved,
    reorderReason: synthesis.reorderReason,
    durationFrames: synthesis.editPlan.durationFrames,
    editPlanSelectionHash: synthesis.editPlan.selectionHash,
    synthesisHash: synthesis.synthesisHash,
  })
}

export function presentEditorialSynthesis(
  synthesis: Readonly<EditorialSynthesis>,
  createdAt: string,
) {
  return Object.freeze({
    synthesisId: synthesis.id,
    projectId: synthesis.projectId,
    objective: synthesis.objective,
    targetDurationMs: synthesis.targetDurationMs,
    toleranceMs: synthesis.toleranceMs,
    synthesizedDurationMs: synthesis.synthesizedDurationMs,
    sourceDurationMs: synthesis.sourceDurationMs,
    droppedMs: synthesis.droppedMs,
    chronologyPreserved: synthesis.chronologyPreserved,
    reorderReason: synthesis.reorderReason,
    storyPlanId: synthesis.storyPlan.id,
    editPlanId: synthesis.editPlan.id,
    frameRate: formatRational(synthesis.editPlan.frameRate),
    durationFrames: synthesis.editPlan.durationFrames,
    ranges: Object.freeze(synthesis.ranges.map((range) => Object.freeze({
      rangeId: range.rangeId,
      startMs: range.startMs,
      endMs: range.endMs,
      lineage: Object.freeze({ ...range.lineage }),
      rightsSnapshotId: range.rightsSnapshotId,
      rightsStatus: range.rightsStatus,
      consentStatus: range.consentStatus,
      claimIds: Object.freeze([...range.claimIds]),
      qualifierIds: Object.freeze([...range.qualifierIds]),
      proofContextIds: Object.freeze([...range.proofContextIds]),
    }))),
    joins: Object.freeze(synthesis.joins.map((join) => Object.freeze({
      beforeRangeId: join.beforeRangeId,
      afterRangeId: join.afterRangeId,
      kind: join.kind,
      droppedMs: join.droppedMs,
      timelineMs: join.timelineMs,
      justification: join.justification,
      continuityRisks: Object.freeze([...join.continuityRisks]),
    }))),
    contextProof: Object.freeze({
      claimsIncluded: Object.freeze([...synthesis.contextProof.claimsIncluded]),
      qualifiersIncluded: Object.freeze([...synthesis.contextProof.qualifiersIncluded]),
      proofContextsIncluded: Object.freeze([...synthesis.contextProof.proofContextsIncluded]),
      claimsRequiringQualifiers: synthesis.contextProof.claimsRequiringQualifiers,
      claimsRequiringProof: synthesis.contextProof.claimsRequiringProof,
    }),
    lineageRefs: Object.freeze([...synthesis.editPlan.lineageRefs]),
    synthesisHash: synthesis.synthesisHash,
    createdAt,
  })
}
