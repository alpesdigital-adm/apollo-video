import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { multiplyRational, rational, type Rational } from './session-time.ts'
import { validateStoryPlan, type StoryPlan } from './story-plan.ts'

/**
 * F4.001 — multi-range editorial synthesis (FR-135).
 *
 * `contiguous-extraction.ts` selects one self-contained window and defends
 * itself by declaring `synthesizedRanges: false`: whatever the speaker said
 * inside that window, they said in that order, uninterrupted. Nothing was
 * assembled, so nothing could be misassembled.
 *
 * Multi-range synthesis gives that defence up. It takes several ranges from a
 * two-hour master and joins them into two minutes, and every join is an
 * assertion the source never made — that these words belong next to those. The
 * point of this module is that the assertion has to be earned.
 *
 * Three failures are possible here that are impossible with a single range, and
 * each one has an invariant rather than a warning:
 *
 * **A claim can be severed from its qualifier.** Range A carries "our clients
 * grew forty percent"; the words "in their best quarter" lived in material
 * nobody selected. The cut is clean, the audio is continuous, the result is a
 * sentence the speaker never said. `assertClaimContextPreserved` refuses it:
 * every qualifier of an included claim must itself be included.
 *
 * **Chronology can be reversed.** "We tried X, then Y failed" and "Y failed,
 * then we tried X" are the same material and opposite claims about cause.
 * Source order is preserved unless reordering is explicitly declared, with a
 * reason that is recorded in the result.
 *
 * **Ranges can overlap.** The same sentence twice is not an edit, it is a
 * stutter, and once compiled to frames it is very hard to see in a plan.
 * Overlap is refused at construction.
 *
 * Everything else — scoring, window discovery, rendering — belongs to the
 * modules that already do it. This one assembles and proves.
 */

export const EDITORIAL_SYNTHESIS_SCHEMA_VERSION = 'editorial-synthesis/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const JUSTIFICATION_MIN = 12

/** How two consecutive ranges meet on the output timeline. */
export const SYNTHESIS_JOIN_KINDS = Object.freeze(['contiguous', 'spliced'] as const)
export type SynthesisJoinKind = (typeof SYNTHESIS_JOIN_KINDS)[number]

/**
 * What a splice can disturb. Mirrors the continuity dimensions the editorial
 * grammar already reasons about, so a synthesis and a grammar evaluation are
 * talking about the same thing.
 */
export const SYNTHESIS_CONTINUITY_DIMENSIONS = Object.freeze([
  'argument',
  'audio',
  'eye-line',
  'position',
  'color',
] as const)
export type SynthesisContinuityDimension = (typeof SYNTHESIS_CONTINUITY_DIMENSIONS)[number]

export interface SynthesisLineage {
  readonly sourceArtifactId: string
  readonly sourceArtifactSha256: string
  readonly sourceManifestId: string
  readonly sourceManifestHash: string
  readonly indexRunId: string
  readonly momentId: string
  readonly momentHash: string
  readonly evaluationId: string
  readonly evaluationHash: string
}

/**
 * One selected span of a master, with everything needed to prove it was allowed
 * to be used and to know what it says.
 */
export interface SynthesisRange {
  readonly rangeId: string
  /** Half-open on the source timeline, integer milliseconds. */
  readonly startMs: number
  readonly endMs: number
  readonly lineage: Readonly<SynthesisLineage>
  readonly rightsSnapshotId: string
  readonly rightsStatus: 'approved' | 'blocked'
  readonly consentStatus: 'approved' | 'not-required' | 'blocked'
  /** Claims spoken inside this range. */
  readonly claimIds: readonly string[]
  /** Qualifiers spoken inside this range. */
  readonly qualifierIds: readonly string[]
  /** Proof contexts established inside this range. */
  readonly proofContextIds: readonly string[]
}

export interface SynthesisJoin {
  readonly beforeRangeId: string
  readonly afterRangeId: string
  readonly kind: SynthesisJoinKind
  /** Source milliseconds dropped between the two ranges. Zero when contiguous. */
  readonly droppedMs: number
  /** Where the join lands on the output timeline, in integer milliseconds. */
  readonly timelineMs: number
  /** Why these two ranges may sit next to each other. Required for a splice. */
  readonly justification: string
  readonly continuityRisks: readonly SynthesisContinuityDimension[]
}

export interface SynthesisClip {
  readonly clipId: string
  readonly rangeId: string
  readonly sourceArtifactId: string
  readonly sourceInFrame: number
  readonly sourceOutFrame: number
  readonly timelineInFrame: number
  readonly timelineOutFrame: number
}

export interface EditorialSynthesisEditPlan {
  readonly schemaVersion: 2
  readonly state: 'compiled'
  readonly mode: 'multi-range'
  readonly id: string
  readonly storyPlanId: string
  /** Exact frame rate. 30000/1001 has no decimal form; a float here rounds badly. */
  readonly frameRate: Rational
  readonly durationFrames: number
  readonly sources: readonly Readonly<{
    id: string
    artifactId: string
    artifactSha256: string
    manifestId: string
    manifestHash: string
    kind: 'video'
  }>[]
  readonly videoTracks: readonly Readonly<{
    id: string
    kind: 'base-video'
    clips: readonly Readonly<SynthesisClip>[]
  }>[]
  /** The honest counterpart of the contiguous plan's `false`. */
  readonly synthesizedRanges: true
  readonly lineageRefs: readonly string[]
  readonly selectionHash: string
}

export interface EditorialSynthesis {
  readonly schemaVersion: typeof EDITORIAL_SYNTHESIS_SCHEMA_VERSION
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly objective: string
  readonly targetDurationMs: number
  readonly toleranceMs: number
  readonly synthesizedDurationMs: number
  readonly sourceDurationMs: number
  readonly ranges: readonly Readonly<SynthesisRange>[]
  readonly joins: readonly Readonly<SynthesisJoin>[]
  /** How much of the master was left on the floor. The compression this achieved. */
  readonly droppedMs: number
  readonly chronologyPreserved: boolean
  readonly reorderReason: string | null
  readonly contextProof: Readonly<ContextProof>
  readonly storyPlan: Readonly<StoryPlan> & Readonly<{ id: string; mode: 'multi-range' }>
  readonly editPlan: Readonly<EditorialSynthesisEditPlan>
  readonly synthesisHash: string
}

/**
 * The record of what was checked, kept whether or not it found anything.
 *
 * A proof that only exists when it fails is not a proof — nobody can tell
 * afterwards whether the check ran or the code path was never reached.
 */
export interface ContextProof {
  readonly claimsIncluded: readonly string[]
  readonly qualifiersIncluded: readonly string[]
  readonly proofContextsIncluded: readonly string[]
  readonly claimsRequiringQualifiers: number
  readonly claimsRequiringProof: number
}

function assertId(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is not a valid identifier`)
  return value
}

function assertHash(value: string, field: string): string {
  assertDomain(SHA256.test(value), 'INVALID_ARGUMENT', `${field} must be a sha256 digest`)
  return value
}

function assertMs(value: number, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0,
    'INVALID_ARGUMENT',
    `${field} must be a non-negative integer number of milliseconds`,
  )
  return value
}

/**
 * Milliseconds to frames, exactly.
 *
 * `Math.round(ms * 30000 / 1001 / 1000)` drifts: the intermediate is a float
 * and the error accumulates across a hundred clips. Doing it as one integer
 * division of exact rationals keeps every clip boundary reproducible, which is
 * what makes the plan hash stable across machines.
 */
export function msToFrames(ms: number, frameRate: Rational): number {
  assertDomain(Number.isSafeInteger(ms) && ms >= 0, 'INVALID_ARGUMENT', 'milliseconds must be a non-negative integer')
  // ms * fps / 1000, as one exact rational reduced to an integer at the end.
  const exact = multiplyRational(rational(BigInt(ms)), frameRate)
  // Floor, not round: a clip must never claim a frame the source range does not
  // contain. Half a frame of material is not a frame.
  return Number(exact.num / (exact.den * BigInt(1_000)))
}

export interface CreateEditorialSynthesisInput {
  id: string
  workspaceId: string
  projectId: string
  objective: string
  targetDurationMs: number
  toleranceMs: number
  sourceDurationMs: number
  frameRate: Rational
  ranges: readonly Readonly<SynthesisRange>[]
  joins: readonly Readonly<Omit<SynthesisJoin, 'droppedMs' | 'timelineMs'>>[]
  storyPlan: Readonly<StoryPlan> & Readonly<{ id: string; mode: 'multi-range' }>
  editPlanId: string
  /** Declared only when the output deliberately departs from source order. */
  allowReorder?: Readonly<{ reason: string }>
}

/**
 * Assemble N ranges into one synthesis, refusing every assembly that would
 * assert something the source does not support.
 */
export function createEditorialSynthesis(
  input: CreateEditorialSynthesisInput,
): Readonly<EditorialSynthesis> {
  assertId(input.id, 'synthesis id')
  assertId(input.workspaceId, 'synthesis workspaceId')
  assertId(input.projectId, 'synthesis projectId')
  assertId(input.editPlanId, 'edit plan id')
  assertDomain(input.objective.trim().length > 0, 'INVALID_ARGUMENT', 'a synthesis must state its objective')
  assertMs(input.targetDurationMs, 'targetDurationMs')
  assertMs(input.toleranceMs, 'toleranceMs')
  assertMs(input.sourceDurationMs, 'sourceDurationMs')
  assertDomain(input.targetDurationMs > 0, 'INVALID_ARGUMENT', 'targetDurationMs must be positive')
  assertDomain(
    input.frameRate.num > BigInt(0) && input.frameRate.den > BigInt(0),
    'INVALID_ARGUMENT',
    'frameRate must be a positive rational',
  )
  assertDomain(input.ranges.length > 0, 'INVALID_ARGUMENT', 'a synthesis needs at least one range')

  const seenRangeIds = new Set<string>()
  for (const range of input.ranges) {
    assertId(range.rangeId, 'range id')
    assertDomain(!seenRangeIds.has(range.rangeId), 'INVALID_ARGUMENT', `range ${range.rangeId} appears twice`)
    seenRangeIds.add(range.rangeId)
    assertMs(range.startMs, `range ${range.rangeId} startMs`)
    assertMs(range.endMs, `range ${range.rangeId} endMs`)
    assertDomain(
      range.endMs > range.startMs,
      'INVALID_ARGUMENT',
      `range ${range.rangeId} is empty or inverted`,
    )
    assertDomain(
      range.endMs <= input.sourceDurationMs,
      'INVALID_ARGUMENT',
      `range ${range.rangeId} runs past the end of the source`,
    )
    // Rights and consent are checked here rather than trusted from selection:
    // a range can be chosen while approved and synthesized after a revocation.
    assertDomain(
      range.rightsStatus === 'approved',
      'ASSET_RIGHTS_BLOCKED',
      `range ${range.rangeId} carries no approved rights snapshot`,
    )
    assertDomain(
      range.consentStatus !== 'blocked',
      'ASSET_RIGHTS_BLOCKED',
      `range ${range.rangeId} carries blocked consent`,
    )
    assertId(range.rightsSnapshotId, `range ${range.rangeId} rightsSnapshotId`)
    assertHash(range.lineage.sourceArtifactSha256, `range ${range.rangeId} sourceArtifactSha256`)
    assertHash(range.lineage.sourceManifestHash, `range ${range.rangeId} sourceManifestHash`)
    assertHash(range.lineage.momentHash, `range ${range.rangeId} momentHash`)
    assertHash(range.lineage.evaluationHash, `range ${range.rangeId} evaluationHash`)
  }

  // Source order, and whether the caller declared a departure from it.
  const inSourceOrder = [...input.ranges].sort((left, right) => left.startMs - right.startMs)
  const chronologyPreserved = input.ranges.every((range, index) => range.rangeId === inSourceOrder[index]!.rangeId)
  if (!chronologyPreserved) {
    // Reordering is legitimate — a hook pulled from the end is standard — but it
    // changes what the material asserts about cause, so it is declared, not
    // inferred from the array happening to be out of order.
    assertDomain(
      input.allowReorder !== undefined,
      'INVALID_ARGUMENT',
      'the ranges depart from source order; reordering changes what the material asserts about cause and must be declared',
    )
    assertDomain(
      input.allowReorder.reason.trim().length >= JUSTIFICATION_MIN,
      'INVALID_ARGUMENT',
      'a reordering must carry a reason an editor can defend',
    )
  }

  // Overlap is checked in source order regardless of output order: two ranges
  // sharing source milliseconds repeat the same words wherever they are placed.
  for (let index = 1; index < inSourceOrder.length; index += 1) {
    const previous = inSourceOrder[index - 1]!
    const current = inSourceOrder[index]!
    assertDomain(
      current.startMs >= previous.endMs,
      'INVALID_ARGUMENT',
      `ranges ${previous.rangeId} and ${current.rangeId} overlap in the source; the same words cannot be spoken twice`,
    )
  }

  const contextProof = assertClaimContextPreserved(input.ranges, input.storyPlan)

  // Joins: one per consecutive pair, in output order.
  assertDomain(
    input.joins.length === input.ranges.length - 1,
    'INVALID_ARGUMENT',
    `a synthesis of ${input.ranges.length} ranges needs exactly ${input.ranges.length - 1} joins`,
  )

  const joins: SynthesisJoin[] = []
  let timelineMs = 0
  input.ranges.forEach((range, index) => {
    timelineMs += range.endMs - range.startMs
    if (index === input.ranges.length - 1) return
    const next = input.ranges[index + 1]!
    const declared = input.joins[index]!
    assertDomain(
      declared.beforeRangeId === range.rangeId && declared.afterRangeId === next.rangeId,
      'INVALID_ARGUMENT',
      `join ${index} must describe the pair ${range.rangeId} → ${next.rangeId}`,
    )
    // Contiguity is measured, not declared. Two ranges are contiguous only when
    // the second begins exactly where the first ended, in the source.
    const droppedMs = next.startMs - range.endMs
    const measuredKind: SynthesisJoinKind = droppedMs === 0 ? 'contiguous' : 'spliced'
    assertDomain(
      declared.kind === measuredKind,
      'INVALID_ARGUMENT',
      `join ${range.rangeId} → ${next.rangeId} is declared ${declared.kind} but the source says ${measuredKind}`,
    )
    if (measuredKind === 'spliced') {
      assertDomain(
        declared.justification.trim().length >= JUSTIFICATION_MIN,
        'INVALID_ARGUMENT',
        `the splice ${range.rangeId} → ${next.rangeId} joins words the speaker never said consecutively and must justify it`,
      )
    }
    for (const dimension of declared.continuityRisks) {
      assertDomain(
        SYNTHESIS_CONTINUITY_DIMENSIONS.includes(dimension),
        'INVALID_ARGUMENT',
        `${dimension} is not a recognized continuity dimension`,
      )
    }
    joins.push(Object.freeze({
      beforeRangeId: range.rangeId,
      afterRangeId: next.rangeId,
      kind: measuredKind,
      droppedMs: droppedMs < 0 ? 0 : droppedMs,
      timelineMs,
      justification: declared.justification.trim(),
      continuityRisks: Object.freeze([...declared.continuityRisks]),
    }))
  })

  const synthesizedDurationMs = input.ranges.reduce((total, range) => total + (range.endMs - range.startMs), 0)
  const delta = Math.abs(synthesizedDurationMs - input.targetDurationMs)
  assertDomain(
    delta <= input.toleranceMs,
    'INVALID_ARGUMENT',
    `the synthesis runs ${synthesizedDurationMs} ms against a target of ${input.targetDurationMs} ms, outside the ${input.toleranceMs} ms tolerance`,
  )

  // The story plan is validated by its own owner rather than re-checked here.
  validateStoryPlan(input.storyPlan)

  const editPlan = compileSynthesisEditPlan({
    editPlanId: input.editPlanId,
    storyPlanId: input.storyPlan.id,
    frameRate: input.frameRate,
    ranges: input.ranges,
  })

  const body = {
    schemaVersion: EDITORIAL_SYNTHESIS_SCHEMA_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    objective: input.objective.trim(),
    targetDurationMs: input.targetDurationMs,
    toleranceMs: input.toleranceMs,
    synthesizedDurationMs,
    sourceDurationMs: input.sourceDurationMs,
    ranges: Object.freeze(input.ranges.map((range) => Object.freeze({ ...range }))),
    joins: Object.freeze(joins),
    droppedMs: input.sourceDurationMs - synthesizedDurationMs,
    chronologyPreserved,
    reorderReason: chronologyPreserved ? null : input.allowReorder!.reason.trim(),
    contextProof,
    storyPlan: input.storyPlan,
    editPlan,
  }
  return Object.freeze({ ...body, synthesisHash: calculateEditorialSynthesisHash(body) })
}

/**
 * Prove that no included claim lost the words that qualify it.
 *
 * This is the invariant multi-range exists to violate. A claim and its
 * qualifier are often seconds apart in a two-hour master, and a selection made
 * on topical relevance has no reason to keep them together — the qualifier is
 * usually the *less* quotable half. Dropping it produces a cut that is clean,
 * fluent, and a fabrication.
 */
export function assertClaimContextPreserved(
  ranges: readonly Readonly<SynthesisRange>[],
  plan: Readonly<StoryPlan>,
): Readonly<ContextProof> {
  const includedClaims = new Set(ranges.flatMap((range) => range.claimIds))
  const includedQualifiers = new Set(ranges.flatMap((range) => range.qualifierIds))
  const includedProofContexts = new Set(ranges.flatMap((range) => range.proofContextIds))

  let claimsRequiringQualifiers = 0
  let claimsRequiringProof = 0

  for (const claim of plan.claims ?? []) {
    if (!includedClaims.has(claim.id)) continue
    if (claim.qualifierIds.length > 0) claimsRequiringQualifiers += 1
    for (const qualifierId of claim.qualifierIds) {
      assertDomain(
        includedQualifiers.has(qualifierId),
        'INVALID_ARGUMENT',
        `claim ${claim.id} is included without its qualifier ${qualifierId}; the cut would state something the speaker did not say`,
      )
    }
    if (claim.proofContextIds.length > 0) claimsRequiringProof += 1
    for (const proofId of claim.proofContextIds) {
      assertDomain(
        includedProofContexts.has(proofId),
        'INVALID_ARGUMENT',
        `claim ${claim.id} is included without its proof context ${proofId}; the cut would present an unsupported assertion as proven`,
      )
    }
  }

  return Object.freeze({
    claimsIncluded: Object.freeze([...includedClaims].sort()),
    qualifiersIncluded: Object.freeze([...includedQualifiers].sort()),
    proofContextsIncluded: Object.freeze([...includedProofContexts].sort()),
    claimsRequiringQualifiers,
    claimsRequiringProof,
  })
}

function compileSynthesisEditPlan(input: {
  editPlanId: string
  storyPlanId: string
  frameRate: Rational
  ranges: readonly Readonly<SynthesisRange>[]
}): Readonly<EditorialSynthesisEditPlan> {
  const sources = new Map<string, Readonly<{
    id: string
    artifactId: string
    artifactSha256: string
    manifestId: string
    manifestHash: string
    kind: 'video'
  }>>()
  const clips: SynthesisClip[] = []
  let timelineFrame = 0

  for (const range of input.ranges) {
    const { lineage } = range
    if (!sources.has(lineage.sourceArtifactId)) {
      sources.set(lineage.sourceArtifactId, Object.freeze({
        id: `source-${lineage.sourceArtifactId}`,
        artifactId: lineage.sourceArtifactId,
        artifactSha256: lineage.sourceArtifactSha256,
        manifestId: lineage.sourceManifestId,
        manifestHash: lineage.sourceManifestHash,
        kind: 'video' as const,
      }))
    }
    const sourceInFrame = msToFrames(range.startMs, input.frameRate)
    const sourceOutFrame = msToFrames(range.endMs, input.frameRate)
    const lengthFrames = sourceOutFrame - sourceInFrame
    // A range shorter than a frame would compile to a zero-length clip: present
    // in the plan, absent from the render, and invisible in both.
    assertDomain(
      lengthFrames > 0,
      'INVALID_ARGUMENT',
      `range ${range.rangeId} is shorter than one frame and would compile to a clip that renders nothing`,
    )
    clips.push(Object.freeze({
      clipId: `clip-${range.rangeId}`,
      rangeId: range.rangeId,
      sourceArtifactId: lineage.sourceArtifactId,
      sourceInFrame,
      sourceOutFrame,
      timelineInFrame: timelineFrame,
      timelineOutFrame: timelineFrame + lengthFrames,
    }))
    timelineFrame += lengthFrames
  }

  const lineageRefs = Object.freeze([...new Set(input.ranges.flatMap((range) => [
    `moment:${range.lineage.momentId}`,
    `evaluation:${range.lineage.evaluationId}`,
    `index-run:${range.lineage.indexRunId}`,
    `manifest:${range.lineage.sourceManifestId}`,
    `rights:${range.rightsSnapshotId}`,
  ]))].sort())

  const plan = {
    schemaVersion: 2 as const,
    state: 'compiled' as const,
    mode: 'multi-range' as const,
    id: input.editPlanId,
    storyPlanId: input.storyPlanId,
    frameRate: input.frameRate,
    durationFrames: timelineFrame,
    sources: Object.freeze([...sources.values()]),
    videoTracks: Object.freeze([Object.freeze({
      id: 'track-base-video',
      kind: 'base-video' as const,
      clips: Object.freeze(clips),
    })]),
    synthesizedRanges: true as const,
    lineageRefs,
  }
  return Object.freeze({ ...plan, selectionHash: calculateCanonicalHash(serializeEditPlan(plan)) })
}

function serializeEditPlan(plan: Omit<EditorialSynthesisEditPlan, 'selectionHash'>): unknown {
  return {
    ...plan,
    frameRate: `${plan.frameRate.num}/${plan.frameRate.den}`,
    sources: plan.sources.map((source) => ({ ...source })),
    videoTracks: plan.videoTracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip })) })),
    lineageRefs: [...plan.lineageRefs],
  }
}

export function calculateEditorialSynthesisHash(
  synthesis: Omit<EditorialSynthesis, 'synthesisHash'>,
): string {
  return calculateCanonicalHash({
    schemaVersion: synthesis.schemaVersion,
    id: synthesis.id,
    workspaceId: synthesis.workspaceId,
    projectId: synthesis.projectId,
    objective: synthesis.objective,
    targetDurationMs: synthesis.targetDurationMs,
    toleranceMs: synthesis.toleranceMs,
    synthesizedDurationMs: synthesis.synthesizedDurationMs,
    sourceDurationMs: synthesis.sourceDurationMs,
    ranges: synthesis.ranges.map((range) => ({
      rangeId: range.rangeId,
      startMs: range.startMs,
      endMs: range.endMs,
      lineage: { ...range.lineage },
      rightsSnapshotId: range.rightsSnapshotId,
      rightsStatus: range.rightsStatus,
      consentStatus: range.consentStatus,
      claimIds: [...range.claimIds],
      qualifierIds: [...range.qualifierIds],
      proofContextIds: [...range.proofContextIds],
    })),
    joins: synthesis.joins.map((join) => ({ ...join, continuityRisks: [...join.continuityRisks] })),
    droppedMs: synthesis.droppedMs,
    chronologyPreserved: synthesis.chronologyPreserved,
    reorderReason: synthesis.reorderReason,
    contextProof: {
      ...synthesis.contextProof,
      claimsIncluded: [...synthesis.contextProof.claimsIncluded],
      qualifiersIncluded: [...synthesis.contextProof.qualifiersIncluded],
      proofContextsIncluded: [...synthesis.contextProof.proofContextsIncluded],
    },
    editPlanSelectionHash: synthesis.editPlan.selectionHash,
    storyPlanId: synthesis.storyPlan.id,
  })
}

export function assertEditorialSynthesisIntegrity(
  synthesis: Readonly<EditorialSynthesis>,
): Readonly<EditorialSynthesis> {
  assertDomain(
    synthesis.schemaVersion === EDITORIAL_SYNTHESIS_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored editorial synthesis schema is invalid',
  )
  const { synthesisHash, ...body } = synthesis
  assertDomain(
    calculateEditorialSynthesisHash(body) === synthesisHash,
    'PERSISTENCE_CONFLICT',
    'stored editorial synthesis hash does not match its body',
  )
  return synthesis
}

/** How much of the master survived, in basis points. The compression achieved. */
export function synthesisCompressionBps(synthesis: Readonly<EditorialSynthesis>): number {
  if (synthesis.sourceDurationMs === 0) return 0
  return Math.round((synthesis.synthesizedDurationMs * 10_000) / synthesis.sourceDurationMs)
}

/** Every splice in the result, for an operator who wants to review the asserted joins. */
export function splicedJoins(synthesis: Readonly<EditorialSynthesis>): readonly Readonly<SynthesisJoin>[] {
  return Object.freeze(synthesis.joins.filter((join) => join.kind === 'spliced'))
}
