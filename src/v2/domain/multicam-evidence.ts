import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { captureSessionDerivationRef, type CaptureSession } from './capture-session.ts'
import {
  compareIntervals,
  createTickInterval,
  intervalDuration,
  intervalIntersection,
  intervalsOverlap,
  serializeTickInterval,
  type TickInterval,
} from './session-time.ts'
import type { CaptureSessionDerivationRef } from './track-coverage.ts'

/**
 * F4.012 — what the sync/perception stage tells the Director (spec 05 §20).
 *
 * Spec 05 §20 draws the line: the sync engine *provides* sources available per
 * frame, confidence, active-speaker candidates, screen activity, technical
 * quality and gaps; the Director *chooses* the angle in another stage. This
 * module is the hand-over document. It carries observations, never decisions,
 * and every observation says where it came from.
 *
 * Three rules, each enforced:
 *
 * **Nothing is invented.** There is no observation kind that means "no
 * reaction", "no activity" or "quality zero". An instant without evidence has
 * no observation, and every consumer must treat absence as absence. A zero
 * would say "measured and found nothing", which is a different claim needing
 * different evidence (AGENTS.md L79; CONTRACT §2 "não medido é null, nunca 0").
 *
 * **Provenance is mandatory and labelled.** `evaluatorKind` says whether the
 * value was measured from pixels/samples, produced under a controlled fixture,
 * or declared by a person. A diarization `speakerKey` is carried with
 * `identityResolved: false`, the same label the diarization aggregate uses
 * (`speaker-diarization.ts:60`): it separates clusters, it does not name
 * people, and no rule downstream may pretend otherwise.
 *
 * **Time is session time in `bigint` ticks.** Observations arrive already
 * mapped onto the session clock, half-open, so two observations from two
 * tracks can be compared without a conversion the consumer would have to get
 * right on its own. The set names the session version and reference epoch it
 * was produced under, so a re-referenced session cannot be directed against
 * evidence measured on the old clock.
 */

export const MULTICAM_EVIDENCE_SCHEMA_VERSION = 'multicam-evidence/v1' as const

export const MULTICAM_EVIDENCE_KINDS = Object.freeze([
  'active-speaker',
  'concurrent-speech',
  'silence',
  'reaction',
  'demonstration',
  'screen-activity',
  'technical-quality',
  'attention',
] as const)
export type MulticamEvidenceKind = (typeof MULTICAM_EVIDENCE_KINDS)[number]

/**
 * How a value came to be believed. `measured` and `controlled` mirror the
 * critic evaluator kinds (`synthetic-critic-report.ts:43`); `declared` is a
 * human statement — carried, labelled, never promoted to a measurement.
 */
export const EVIDENCE_EVALUATOR_KINDS = Object.freeze(['measured', 'controlled', 'declared'] as const)
export type EvidenceEvaluatorKind = (typeof EVIDENCE_EVALUATOR_KINDS)[number]

export const DEMONSTRATION_SURFACES = Object.freeze(['screen', 'physical', 'unknown'] as const)
export type DemonstrationSurface = (typeof DEMONSTRATION_SURFACES)[number]

export interface EvidenceProvenance {
  /** The detector or procedure, e.g. `diarization/pyannote-3.1`, `signalstats`, `operator`. */
  readonly method: string
  readonly evaluatorKind: EvidenceEvaluatorKind
  /** Something that can be re-opened: a run id, an artifact id, an operator action. */
  readonly evidenceRef: string
  readonly producedAt: string
}

/** Basis points in `(0, 10000]`. Zero is not a value here; it is the absence of an observation. */
export type PositiveBps = number

export type MulticamEvidenceValue =
  | Readonly<{
      kind: 'active-speaker'
      /** A diarization cluster key, or null when the detector found speech without clustering it. */
      speakerKey: string | null
      /** Always false: a cluster is not a person. Same label as `speaker-diarization.ts:25`. */
      identityResolved: false
    }>
  | Readonly<{ kind: 'concurrent-speech'; speakerCount: number | null }>
  | Readonly<{ kind: 'silence'; levelDbfs: number | null }>
  | Readonly<{ kind: 'reaction'; intensityBps: PositiveBps }>
  | Readonly<{ kind: 'demonstration'; surface: DemonstrationSurface }>
  | Readonly<{ kind: 'screen-activity'; activityBps: PositiveBps }>
  | Readonly<{
      kind: 'technical-quality'
      /** Each is null when that dimension was not measured. At least one must be. */
      sharpnessBps: number | null
      stabilityBps: number | null
      exposureBps: number | null
    }>
  | Readonly<{ kind: 'attention'; gazeOnCameraBps: PositiveBps }>

export interface MulticamObservation {
  readonly observationId: string
  /** The track the observation is *about*: the audio track that carried the speech, the screen that showed activity. */
  readonly trackId: string
  /** Half-open, in session ticks. */
  readonly range: Readonly<TickInterval>
  readonly kind: MulticamEvidenceKind
  readonly value: MulticamEvidenceValue
  /** In `[0, 1]`, finite. How sure the producer is of this observation. */
  readonly confidence: number
  readonly provenance: Readonly<EvidenceProvenance>
}

export interface MulticamEvidenceSet {
  readonly schemaVersion: typeof MULTICAM_EVIDENCE_SCHEMA_VERSION
  readonly workspaceId: string
  readonly sessionId: string
  readonly sessionVersion: number
  readonly referenceEpoch: number
  readonly observations: readonly Readonly<MulticamObservation>[]
  readonly generatedAt: string
  readonly evidenceHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const BPS_MAX = 10_000

function assertId(value: string, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is not a canonical identifier`)
  return value
}

function assertInstant(value: string, field: string): string {
  assertDomain(
    typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

function assertText(value: string, field: string, max: number): string {
  assertDomain(
    typeof value === 'string' && value.trim().length > 0 && value.length <= max,
    'INVALID_ARGUMENT',
    `${field} is required`,
  )
  return value
}

function assertPositiveBps(value: number, field: string): number {
  // Zero is refused on purpose: "no reaction" is the absence of a reaction
  // observation, not a reaction of strength zero.
  assertDomain(
    Number.isSafeInteger(value) && value > 0 && value <= BPS_MAX,
    'INVALID_ARGUMENT',
    `${field} must be an integer in (0, ${BPS_MAX}] basis points; an absent measurement is an absent observation`,
  )
  return value
}

function assertNullableBps(value: number | null, field: string): number | null {
  if (value === null) return null
  assertDomain(
    Number.isSafeInteger(value) && value >= 0 && value <= BPS_MAX,
    'INVALID_ARGUMENT',
    `${field} must be null or an integer in [0, ${BPS_MAX}] basis points`,
  )
  return value
}

function assertValue(value: MulticamEvidenceValue, kind: MulticamEvidenceKind, id: string): MulticamEvidenceValue {
  assertDomain(
    typeof value === 'object' && value !== null && value.kind === kind,
    'INVALID_ARGUMENT',
    `observation ${id} declares kind ${kind} but its value says ${(value as { kind?: unknown })?.kind}`,
  )
  const field = (name: string) => `observation ${id} value.${name}`
  switch (value.kind) {
    case 'active-speaker':
      assertDomain(
        value.speakerKey === null || (typeof value.speakerKey === 'string' && value.speakerKey.trim().length > 0 && value.speakerKey.length <= 128),
        'INVALID_ARGUMENT',
        `${field('speakerKey')} must be null or a cluster key`,
      )
      // The label is the contract, not a default. A producer that omits it is
      // claiming an identity it cannot have resolved.
      assertDomain(value.identityResolved === false, 'INVALID_ARGUMENT', `${field('identityResolved')} must be false: a diarization cluster is not a person`)
      return Object.freeze({ kind: 'active-speaker', speakerKey: value.speakerKey, identityResolved: false })
    case 'concurrent-speech':
      assertDomain(
        value.speakerCount === null || (Number.isSafeInteger(value.speakerCount) && value.speakerCount >= 2),
        'INVALID_ARGUMENT',
        `${field('speakerCount')} must be null or at least two`,
      )
      return Object.freeze({ kind: 'concurrent-speech', speakerCount: value.speakerCount })
    case 'silence':
      assertDomain(
        value.levelDbfs === null || (Number.isFinite(value.levelDbfs) && value.levelDbfs <= 0),
        'INVALID_ARGUMENT',
        `${field('levelDbfs')} must be null or a non-positive dBFS level`,
      )
      return Object.freeze({ kind: 'silence', levelDbfs: value.levelDbfs })
    case 'reaction':
      return Object.freeze({ kind: 'reaction', intensityBps: assertPositiveBps(value.intensityBps, field('intensityBps')) })
    case 'demonstration':
      assertDomain(
        DEMONSTRATION_SURFACES.includes(value.surface),
        'INVALID_ARGUMENT',
        `${field('surface')} is not a demonstration surface`,
      )
      return Object.freeze({ kind: 'demonstration', surface: value.surface })
    case 'screen-activity':
      return Object.freeze({ kind: 'screen-activity', activityBps: assertPositiveBps(value.activityBps, field('activityBps')) })
    case 'technical-quality': {
      const quality = Object.freeze({
        kind: 'technical-quality' as const,
        sharpnessBps: assertNullableBps(value.sharpnessBps, field('sharpnessBps')),
        stabilityBps: assertNullableBps(value.stabilityBps, field('stabilityBps')),
        exposureBps: assertNullableBps(value.exposureBps, field('exposureBps')),
      })
      assertDomain(
        quality.sharpnessBps !== null || quality.stabilityBps !== null || quality.exposureBps !== null,
        'INVALID_ARGUMENT',
        `observation ${id} measures no quality dimension; an observation that measures nothing is not an observation`,
      )
      return quality
    }
    case 'attention':
      return Object.freeze({ kind: 'attention', gazeOnCameraBps: assertPositiveBps(value.gazeOnCameraBps, field('gazeOnCameraBps')) })
    default: {
      const never: never = value
      throw new Error(`unreachable evidence value ${JSON.stringify(never)}`)
    }
  }
}

function assertProvenance(provenance: Readonly<EvidenceProvenance>, id: string): Readonly<EvidenceProvenance> {
  assertDomain(typeof provenance === 'object' && provenance !== null, 'INVALID_ARGUMENT', `observation ${id} has no provenance`)
  assertDomain(
    EVIDENCE_EVALUATOR_KINDS.includes(provenance.evaluatorKind),
    'INVALID_ARGUMENT',
    `observation ${id} provenance.evaluatorKind ${provenance.evaluatorKind} is not an evaluator kind`,
  )
  return Object.freeze({
    method: assertText(provenance.method, `observation ${id} provenance.method`, 128),
    evaluatorKind: provenance.evaluatorKind,
    evidenceRef: assertText(provenance.evidenceRef, `observation ${id} provenance.evidenceRef`, 512),
    producedAt: assertInstant(provenance.producedAt, `observation ${id} provenance.producedAt`),
  })
}

function compareObservations(left: Readonly<MulticamObservation>, right: Readonly<MulticamObservation>): number {
  const byTrack = left.trackId.localeCompare(right.trackId)
  if (byTrack !== 0) return byTrack
  const byRange = compareIntervals(left.range, right.range)
  if (byRange !== 0) return byRange
  const byKind = left.kind.localeCompare(right.kind)
  if (byKind !== 0) return byKind
  return left.observationId.localeCompare(right.observationId)
}

export interface CreateMulticamEvidenceSetInput {
  /** The exact session the observations were mapped onto. Version and epoch are taken from it, never typed. */
  session: Readonly<CaptureSession>
  observations: readonly Readonly<MulticamObservation>[]
  generatedAt: string
}

/**
 * Validate and canonicalize a set of observations for one session version.
 *
 * Deterministic: observations are sorted by track, range, kind and id so two
 * producers that saw the same things hash to the same bytes. An empty set is
 * legal — it is the honest description of a session nobody has analysed — and
 * directing against it yields conservative holds, not invented cuts.
 */
export function createMulticamEvidenceSet(input: CreateMulticamEvidenceSetInput): Readonly<MulticamEvidenceSet> {
  const ref = captureSessionDerivationRef(input.session)
  const trackIds = new Set(input.session.tracks.map((track) => track.trackId))
  const seen = new Set<string>()
  const observations = input.observations.map((observation) => {
    assertId(observation.observationId, 'observationId')
    assertDomain(!seen.has(observation.observationId), 'INVALID_ARGUMENT', `observation ${observation.observationId} is duplicated`)
    seen.add(observation.observationId)
    assertId(observation.trackId, `observation ${observation.observationId} trackId`)
    assertDomain(
      trackIds.has(observation.trackId),
      'CAPTURE_TRACK_NOT_FOUND',
      `observation ${observation.observationId} is about track ${observation.trackId}, which is not in session ${ref.sessionId} version ${ref.sessionVersion}`,
    )
    assertDomain(
      MULTICAM_EVIDENCE_KINDS.includes(observation.kind),
      'INVALID_ARGUMENT',
      `observation ${observation.observationId} kind ${observation.kind} is not an evidence kind`,
    )
    assertDomain(
      typeof observation.range?.start === 'bigint' && typeof observation.range?.end === 'bigint',
      'INVALID_ARGUMENT',
      `observation ${observation.observationId} range must be counted in bigint session ticks`,
    )
    assertDomain(
      typeof observation.confidence === 'number' && Number.isFinite(observation.confidence)
        && observation.confidence >= 0 && observation.confidence <= 1,
      'INVALID_ARGUMENT',
      `observation ${observation.observationId} confidence must be a finite number in [0, 1]`,
    )
    return Object.freeze({
      observationId: observation.observationId,
      trackId: observation.trackId,
      // Re-running the constructor refuses an empty or backwards range that
      // was assembled by hand.
      range: createTickInterval(observation.range.start, observation.range.end),
      kind: observation.kind,
      value: assertValue(observation.value, observation.kind, observation.observationId),
      confidence: observation.confidence,
      provenance: assertProvenance(observation.provenance, observation.observationId),
    })
  }).sort(compareObservations)

  const body = {
    schemaVersion: MULTICAM_EVIDENCE_SCHEMA_VERSION,
    workspaceId: input.session.workspaceId,
    sessionId: ref.sessionId,
    sessionVersion: ref.sessionVersion,
    referenceEpoch: ref.referenceEpoch,
    observations: Object.freeze(observations),
    generatedAt: assertInstant(input.generatedAt, 'evidence set generatedAt'),
  }
  return Object.freeze({ ...body, evidenceHash: calculateMulticamEvidenceHash(body) })
}

/** Ticks become decimal text before hashing: the canonical hasher refuses `bigint`. */
export function calculateMulticamEvidenceHash(set: Omit<MulticamEvidenceSet, 'evidenceHash'>): string {
  return calculateCanonicalHash({
    schemaVersion: set.schemaVersion,
    workspaceId: set.workspaceId,
    sessionId: set.sessionId,
    sessionVersion: set.sessionVersion,
    referenceEpoch: set.referenceEpoch,
    observations: set.observations.map((observation) => ({
      observationId: observation.observationId,
      trackId: observation.trackId,
      range: serializeTickInterval(observation.range),
      kind: observation.kind,
      value: { ...observation.value },
      confidence: observation.confidence,
      provenance: { ...observation.provenance },
    })),
    generatedAt: set.generatedAt,
  })
}

export function assertMulticamEvidenceSetIntegrity(set: Readonly<MulticamEvidenceSet>): Readonly<MulticamEvidenceSet> {
  assertDomain(
    set.schemaVersion === MULTICAM_EVIDENCE_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored multicam evidence schema is invalid',
  )
  assertDomain(HASH.test(set.evidenceHash), 'PERSISTENCE_CONFLICT', 'multicam evidence hash is malformed')
  const { evidenceHash, ...body } = set
  assertDomain(
    calculateMulticamEvidenceHash(body) === evidenceHash,
    'PERSISTENCE_CONFLICT',
    'stored multicam evidence hash does not match its body',
  )
  return set
}

/** Refuse evidence measured against a different session version or reference epoch. */
export function assertEvidenceDerivedFrom(
  set: Readonly<MulticamEvidenceSet>,
  expected: Readonly<CaptureSessionDerivationRef>,
): Readonly<MulticamEvidenceSet> {
  assertDomain(
    set.sessionId === expected.sessionId
      && set.sessionVersion === expected.sessionVersion
      && set.referenceEpoch === expected.referenceEpoch,
    'CAPTURE_SESSION_DERIVATION_STALE',
    `multicam evidence was produced for session version ${set.sessionVersion} (reference epoch ${set.referenceEpoch}) and cannot direct version ${expected.sessionVersion} (reference epoch ${expected.referenceEpoch})`,
  )
  return set
}

/** Observations of the given kinds (any kind when omitted) that share at least one tick with `range`. */
export function observationsOverlapping(
  set: Readonly<MulticamEvidenceSet>,
  range: Readonly<TickInterval>,
  filter: Readonly<{ kinds?: readonly MulticamEvidenceKind[]; trackId?: string }> = {},
): readonly Readonly<MulticamObservation>[] {
  return Object.freeze(set.observations.filter((observation) =>
    (filter.kinds === undefined || filter.kinds.includes(observation.kind))
    && (filter.trackId === undefined || observation.trackId === filter.trackId)
    && intervalsOverlap(observation.range, range)))
}

/**
 * The fraction of `range` an observation covers, in `[0, 1]`, as a number.
 *
 * A number is acceptable here — it is a weight, not a time — and it is derived
 * from exact tick arithmetic before the single division.
 */
export function overlapFraction(observation: Readonly<TickInterval>, range: Readonly<TickInterval>): number {
  const shared = intervalIntersection(observation, range)
  if (!shared) return 0
  const scaled = (intervalDuration(shared) * BigInt(1_000_000)) / intervalDuration(range)
  return Number(scaled) / 1_000_000
}

/** Every tick at which some observation starts or ends inside `range`, sorted and unique. */
export function evidenceBreakpoints(set: Readonly<MulticamEvidenceSet>, range: Readonly<TickInterval>): readonly bigint[] {
  const ticks = new Set<bigint>()
  for (const observation of set.observations) {
    for (const tick of [observation.range.start, observation.range.end]) {
      if (tick > range.start && tick < range.end) ticks.add(tick)
    }
  }
  return Object.freeze([...ticks].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
}
