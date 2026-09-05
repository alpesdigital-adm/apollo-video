import { calculateCanonicalHash } from './canonical-hash.ts'
import type {
  CommandArtifactInvalidationV1,
  CommandImpactOutputReference,
  CommandImpactRange,
} from './command-impact.ts'
import { assertDomain } from './errors.ts'

/**
 * What directing a multicam session invalidates (F4.012, spec 02 §24.1).
 *
 * Deferred, not full-timeline. A `MulticamDirection` is a list of shots over
 * *session* ticks; it becomes clips only when a DirectorRun compiles them
 * (`compileShotsToSourceRanges`), so no render may be enqueued from this
 * Command itself and the impact declares no `minimalRenders` field at all —
 * the same shape `replace-source-transcript` uses for the same reason.
 *
 * What it does declare is that everything the current timeline shows is now
 * wrong: which angle plays at each instant is exactly what a direction
 * decides, so the invalidated range is the whole compiled timeline and every
 * completed output of the base version is stale. A direction that reviewed
 * nothing would still be a different edit.
 *
 * The direction is named by hash rather than embedded: the aggregate lives in
 * `multicam_directions` with its own chain, and a Command that copied it would
 * be a second answer to the same question.
 */
export interface MulticamDirectionImpactV1 {
  schemaVersion: 'multicam-direction-impact/v1'
  commandId: string
  commandType: 'direct-multicam-session'
  baseVersionId: string
  resultVersionId: string
  sessionId: string
  sessionVersion: number
  directionHash: string
  diagnosticHash: string
  evidenceHash: string
  shotCount: number
  manualReviewRequired: boolean
  changeKinds: readonly ['multicam-direction']
  dependencyTypes: readonly ['content', 'timing', 'visual']
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  requiredRecomputations: readonly ['edit-plan', 'proxy', 'final']
  renderBlockedUntilDirectorRun: true
  impactHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function sha256(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be an object`,
  )
  return value as Record<string, unknown>
}

export function createMulticamDirectionImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  sessionId: string
  sessionVersion: number
  directionHash: string
  diagnosticHash: string
  evidenceHash: string
  shotCount: number
  manualReviewRequired: boolean
  durationFrames: number
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<MulticamDirectionImpactV1> {
  assertDomain(
    Number.isSafeInteger(input.durationFrames) && input.durationFrames > 0,
    'INVALID_ARGUMENT',
    'durationFrames is invalid: a direction is applied to a compiled timeline',
  )
  assertDomain(
    Number.isSafeInteger(input.sessionVersion) && input.sessionVersion >= 1,
    'INVALID_ARGUMENT',
    'sessionVersion is invalid',
  )
  // A direction with no shots directed nothing, and a Command that invalidates
  // a whole timeline on the strength of nothing is the one thing this impact
  // must not be able to say.
  assertDomain(
    Number.isSafeInteger(input.shotCount) && input.shotCount > 0,
    'INVALID_ARGUMENT',
    'a direction with no shots cannot invalidate a timeline',
  )
  const baseVersionId = identifier(input.baseVersionId, 'baseVersionId')
  const seen = new Set<string>()
  const outputs = input.outputReferences.map((item, index) => {
    const artifactId = identifier(item.artifactId, `outputReferences[${index}].artifactId`)
    assertDomain(
      item.kind === 'proxy' || item.kind === 'final',
      'INVALID_ARGUMENT',
      `outputReferences[${index}].kind is invalid`,
    )
    assertDomain(
      identifier(item.sourceVersionId, `outputReferences[${index}].sourceVersionId`) === baseVersionId,
      'INVALID_ARGUMENT',
      `outputReferences[${index}] belongs to another version`,
    )
    assertDomain(!seen.has(artifactId), 'INVALID_ARGUMENT', `outputReferences[${index}].artifactId is duplicated`)
    seen.add(artifactId)
    return Object.freeze({
      artifactId,
      kind: item.kind,
      sourceVersionId: baseVersionId,
      variantId: identifier(item.variantId, `outputReferences[${index}].variantId`),
    })
  }).toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
  const body = Object.freeze({
    schemaVersion: 'multicam-direction-impact/v1' as const,
    commandId: identifier(input.commandId, 'commandId'),
    commandType: 'direct-multicam-session' as const,
    baseVersionId,
    resultVersionId: identifier(input.resultVersionId, 'resultVersionId'),
    sessionId: identifier(input.sessionId, 'sessionId'),
    sessionVersion: input.sessionVersion,
    directionHash: sha256(input.directionHash, 'directionHash'),
    diagnosticHash: sha256(input.diagnosticHash, 'diagnosticHash'),
    evidenceHash: sha256(input.evidenceHash, 'evidenceHash'),
    shotCount: input.shotCount,
    manualReviewRequired: input.manualReviewRequired === true,
    changeKinds: Object.freeze(['multicam-direction'] as const),
    dependencyTypes: Object.freeze(['content', 'timing', 'visual'] as const),
    affectedRanges: Object.freeze([Object.freeze({ startFrame: 0, endFrame: input.durationFrames })]),
    affectedVariantIds: Object.freeze([...new Set(outputs.map((item) => item.variantId))].sort()),
    affectedArtifacts: Object.freeze(outputs),
    requiredRecomputations: Object.freeze(['edit-plan', 'proxy', 'final'] as const),
    renderBlockedUntilDirectorRun: true as const,
  })
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseMulticamDirectionImpact(value: unknown): Readonly<MulticamDirectionImpactV1> {
  const impact = record(value, 'multicam direction impact') as unknown as MulticamDirectionImpactV1
  const expected = [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'sessionId', 'sessionVersion', 'directionHash', 'diagnosticHash', 'evidenceHash',
    'shotCount', 'manualReviewRequired', 'changeKinds', 'dependencyTypes', 'affectedRanges',
    'affectedVariantIds', 'affectedArtifacts', 'requiredRecomputations',
    'renderBlockedUntilDirectorRun', 'impactHash',
  ].toSorted()
  const actual = Object.keys(impact).toSorted()
  assertDomain(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    'PERSISTENCE_CONFLICT',
    'Stored multicam direction impact fields are invalid',
  )
  const range = Array.isArray(impact.affectedRanges) ? impact.affectedRanges[0] : undefined
  assertDomain(
    impact.schemaVersion === 'multicam-direction-impact/v1' &&
      impact.commandType === 'direct-multicam-session' &&
      impact.renderBlockedUntilDirectorRun === true &&
      typeof impact.manualReviewRequired === 'boolean' &&
      JSON.stringify(impact.changeKinds) === JSON.stringify(['multicam-direction']) &&
      JSON.stringify(impact.dependencyTypes) === JSON.stringify(['content', 'timing', 'visual']) &&
      JSON.stringify(impact.requiredRecomputations) === JSON.stringify(['edit-plan', 'proxy', 'final']) &&
      Array.isArray(impact.affectedRanges) && impact.affectedRanges.length === 1 &&
      range?.startFrame === 0 && Number.isSafeInteger(range?.endFrame) && Number(range?.endFrame) > 0 &&
      Array.isArray(impact.affectedVariantIds) && Array.isArray(impact.affectedArtifacts),
    'PERSISTENCE_CONFLICT',
    'Stored multicam direction impact is invalid',
  )
  sha256(impact.impactHash, 'impactHash')
  // Rebuilt rather than re-hashed: a stored document whose hash matches a body
  // this constructor would never produce is still a document nothing in this
  // module wrote.
  const recreated = createMulticamDirectionImpact({
    commandId: impact.commandId,
    baseVersionId: impact.baseVersionId,
    resultVersionId: impact.resultVersionId,
    sessionId: impact.sessionId,
    sessionVersion: impact.sessionVersion,
    directionHash: impact.directionHash,
    diagnosticHash: impact.diagnosticHash,
    evidenceHash: impact.evidenceHash,
    shotCount: impact.shotCount,
    manualReviewRequired: impact.manualReviewRequired,
    durationFrames: Number(range?.endFrame),
    outputReferences: impact.affectedArtifacts,
  })
  assertDomain(
    recreated.impactHash === impact.impactHash,
    'PERSISTENCE_CONFLICT',
    'Stored multicam direction impact is inconsistent',
  )
  return Object.freeze(impact)
}

export function createMulticamDirectionInvalidations(input: {
  impact: Readonly<MulticamDirectionImpactV1>
  createdAt: string
}): readonly Readonly<CommandArtifactInvalidationV1>[] {
  const impact = parseMulticamDirectionImpact(input.impact)
  assertDomain(
    typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_ARGUMENT',
    'createdAt must be an ISO timestamp',
  )
  return Object.freeze(impact.affectedArtifacts.map((artifact) => {
    const body = Object.freeze({
      schemaVersion: 'command-artifact-invalidation/v1' as const,
      status: 'stale' as const,
      commandId: impact.commandId,
      baseVersionId: impact.baseVersionId,
      resultVersionId: impact.resultVersionId,
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      variantId: artifact.variantId,
      dependencyTypes: impact.dependencyTypes,
      affectedRanges: impact.affectedRanges,
      impactHash: impact.impactHash,
      createdAt: input.createdAt,
    })
    return Object.freeze({ ...body, id: calculateCanonicalHash(body) })
  }))
}
