import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import {
  captureSessionDerivationRef,
  type CaptureSession,
  type CaptureTrack,
  type CaptureTrackPart,
  type CaptureTrackRole,
} from './capture-session.ts'
import type { SyncCeiling } from './capture-protocol.ts'
import { colorCameraIdsForSession } from './camera-identity.ts'
import {
  assertEvidenceDerivedFrom,
  evidenceBreakpoints,
  observationsOverlapping,
  overlapFraction,
  type MulticamEvidenceSet,
  type MulticamObservation,
} from './multicam-evidence.ts'
import {
  isSessionRangeResolvable,
  resolveSessionTick,
  resolveSourceTick,
  type ClockMapPiece,
  type PiecewiseClockMap,
} from './piecewise-clock-map.ts'
import {
  convertTick,
  createTickInterval,
  createTimebase,
  divideRational,
  intervalContains,
  intervalDuration,
  intervalsOverlap,
  invertAffineClockMap,
  rational,
  rationalEquals,
  serializeRational,
  serializeTickInterval,
  type Rational,
  type TickInterval,
  type Timebase,
} from './session-time.ts'
import { canAutoEdit, DIAGNOSTIC_POLICY, type DiagnosticStatus, type SyncDiagnostic } from './sync-diagnostic.ts'
import {
  assertCoverageDerivedFrom,
  assertCoverageSelectable,
  type CoverageAvailability,
  type TrackCoverage,
} from './track-coverage.ts'

/**
 * F4.012 — evidence-bound multicamera direction (FR-150, spec 05 §20, ADR-131).
 *
 * The output of this module is a list of shots. A shot is one track over one
 * half-open range of session ticks, and the integration phase turns each shot
 * into exactly one `EditorialCutClip` on the single `base-video` track of a
 * `DirectedEditPlan`. An angle *is* a clip; nothing here composes, overlays or
 * retimes, and nothing here is recomputed by the renderer.
 *
 * Everything the direction knows, it derives:
 *
 * **"May I cut to this track at this instant?"** is answered only by
 * `assertCoverageSelectable(coverage, { purpose: 'auto-edit' })` on the
 * source range the piecewise clock map resolves for the window, and only when
 * `isSessionRangeResolvable` says one piece covers the whole window. There is
 * no second threshold and no boolean `coverage` field. A track outside
 * coverage, in a map discontinuity, below the confidence floor, unverified,
 * under a protocol ceiling or below the sync threshold stays in the candidate
 * list with its `rejectionReasons` (ADR-118: rejected alternatives are
 * inspectable) and is never chosen — not by a rule, not by a hold, not by a
 * protected selection.
 *
 * **Scores are sums of named components**, each carrying the evidence refs
 * that produced it, weighted by a policy with named, calibrated numbers. The
 * winning component names the rule that decided the shot, so "why this
 * angle?" is answered by the shot itself.
 *
 * **Confidence is derived from evidence and margin** (spec 01 §20 bands). A
 * tie between two evidence-backed candidates is *ambiguous*, not a coin toss:
 * the direction holds the current angle and asks for review. A window with no
 * evidence at all is not ambiguous — holding the current eligible angle is the
 * conservative fallback spec 01 §20 prescribes for medium confidence.
 *
 * **Nothing is fabricated to make the timeline continuous.** A window in
 * which no track is eligible becomes an `uncovered` range with a warning and
 * `manualReviewRequired`; the compile step refuses to turn such a direction
 * into clips. That is the one honest answer when every camera dropped out.
 */

export const ANGLE_CANDIDATE_SCHEMA_VERSION = 'angle-candidate/v1' as const
export const SHOT_DECISION_SCHEMA_VERSION = 'shot-decision/v1' as const
export const MULTICAM_DIRECTION_SCHEMA_VERSION = 'multicam-direction/v1' as const
export const DIRECTION_POLICY_SCHEMA_VERSION = 'direction-policy/v1' as const
export const MULTICAM_SHOT_COMPILATION_SCHEMA_VERSION = 'multicam-shot-compilation/v1' as const

export const ANGLE_CONTEXTS = Object.freeze(['speaker', 'reaction', 'screen', 'wide', 'reference-video'] as const)
export type AngleContext = (typeof ANGLE_CONTEXTS)[number]

/** Roles that produce pictures. Audio-only roles can never be an angle. */
export const VIDEO_ANGLE_ROLES: readonly CaptureTrackRole[] = Object.freeze([
  'camera-main',
  'camera-alt',
  'screen',
  'phone',
  'reaction',
  'reference-video',
])

export const ANGLE_REJECTIONS = Object.freeze([
  'not-a-video-source',
  'coverage-missing',
  'coverage-gap',
  'coverage-unverified',
  'coverage-corrupt',
  'coverage-out-of-bounds',
  'coverage-below-floor',
  'sync-map-missing',
  'sync-uncovered',
  'sync-missing',
  'sync-below-threshold',
  'protocol-ceiling',
  'quality-below-floor',
  'excluded-from-final-mix',
] as const)
export type AngleRejection = (typeof ANGLE_REJECTIONS)[number]

export const DIRECTION_RULES = Object.freeze([
  'demonstration-prefers-screen',
  'speech-prefers-active-speaker',
  'reaction-cutaway',
  'cutaway-return',
  'redundant-angles-hold',
  'minimum-shot-hold',
  'jump-cut-avoided',
  'protected-selection',
  'conservative-hold',
] as const)
export type DirectionRule = (typeof DIRECTION_RULES)[number]

export const DIRECTION_WARNINGS = Object.freeze([
  'jump-cut-unavoidable',
  'protected-selection-ineligible',
  'protected-selection-unknown-track',
  'no-eligible-candidate',
  'session-not-auto-editable',
  'ambiguous-active-speaker',
  'active-speaker-unmapped',
  'minimum-shot-violated',
  'audio-master-unavailable',
] as const)
export type DirectionWarningCode = (typeof DIRECTION_WARNINGS)[number]

/** Spec 01 §20. Named bands, so a threshold is a policy and not a literal in a branch. */
export const DIRECTION_CONFIDENCE_BANDS = Object.freeze(['high', 'medium', 'low', 'insufficient'] as const)
export type DirectionConfidenceBand = (typeof DIRECTION_CONFIDENCE_BANDS)[number]
export const DIRECTION_CONFIDENCE_BAND_FLOORS = Object.freeze({ high: 0.85, medium: 0.65, low: 0.4 })

export function directionConfidenceBand(value: number): DirectionConfidenceBand {
  assertDomain(Number.isFinite(value) && value >= 0 && value <= 1, 'INVALID_ARGUMENT', 'a confidence is a finite number in [0, 1]')
  if (value >= DIRECTION_CONFIDENCE_BAND_FLOORS.high) return 'high'
  if (value >= DIRECTION_CONFIDENCE_BAND_FLOORS.medium) return 'medium'
  if (value >= DIRECTION_CONFIDENCE_BAND_FLOORS.low) return 'low'
  return 'insufficient'
}

export const SPATIAL_RELATIONS = Object.freeze(['same', 'adjacent', 'opposite', 'unknown'] as const)
export type SpatialRelation = (typeof SPATIAL_RELATIONS)[number]

export const OUTPUT_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:5'] as const)
export type OutputAspectRatio = (typeof OUTPUT_ASPECT_RATIOS)[number]

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface DirectionPolicy {
  readonly schemaVersion: typeof DIRECTION_POLICY_SCHEMA_VERSION
  /** Names the calibration these numbers came from (ADR-111). */
  readonly calibrationVersion: string
  /** No shot shorter than this, except when the angle stops being eligible. */
  readonly minimumShotMs: number
  /** A reaction cutaway returns after this long even if the reaction continues. */
  readonly maxCutawayMs: number
  /** How long an alternative angle covers a same-angle discontinuity before the direction may return. */
  readonly jumpCutSameAngleMs: number
  /** Switching to another angle needs at least this much score gain (rule 4). */
  readonly redundancyThreshold: number
  /** Two evidence-backed candidates closer than this are ambiguous, not ranked. */
  readonly ambiguityMargin: number
  /** After `targetShotMs + varianceMs` on one angle the redundancy threshold is waived (never forces a switch). */
  readonly rhythm: Readonly<{ targetShotMs: number; varianceMs: number }>
  /** Confidence of a hold decided with no evidence against it (spec 01 §20 medium: conservative fallback). */
  readonly conservativeHoldConfidence: number
  /** Confidence of a shot decided by a labelled human selection. */
  readonly protectedSelectionConfidence: number
  /** Measured quality below this is a rejection; unmeasured quality is not. */
  readonly qualityFloorBps: number
  /** Reactions weaker than this do not earn a cutaway. */
  readonly reactionIntensityFloorBps: number
  readonly weights: Readonly<{
    speaker: number
    demonstration: number
    reaction: number
    quality: number
    continuity: number
    protectedBonus: number
    redundancyPenalty: number
  }>
  /** The resting value of each context: where the direction returns when evidence ends. */
  readonly contextBaseline: Readonly<Record<AngleContext, number>>
  /** Multipliers in `[0, 1]` applied to the positive score of a context for an output format. */
  readonly formatContextPenalties: Readonly<Partial<Record<OutputAspectRatio, Readonly<Partial<Record<AngleContext, number>>>>>>
}

export const DEFAULT_DIRECTION_POLICY: Readonly<DirectionPolicy> = Object.freeze({
  schemaVersion: DIRECTION_POLICY_SCHEMA_VERSION,
  calibrationVersion: 'multicam-direction-2026-09-v1',
  minimumShotMs: 1_200,
  maxCutawayMs: 4_000,
  jumpCutSameAngleMs: 2_000,
  redundancyThreshold: 0.15,
  ambiguityMargin: 0.1,
  rhythm: Object.freeze({ targetShotMs: 8_000, varianceMs: 4_000 }),
  conservativeHoldConfidence: 0.65,
  protectedSelectionConfidence: 0.9,
  qualityFloorBps: 3_000,
  reactionIntensityFloorBps: 5_000,
  weights: Object.freeze({
    speaker: 1,
    demonstration: 1.2,
    reaction: 0.9,
    quality: 0.25,
    continuity: 0.1,
    protectedBonus: 2,
    redundancyPenalty: 0.15,
  }),
  contextBaseline: Object.freeze({
    speaker: 0.3,
    wide: 0.25,
    screen: 0,
    reaction: 0,
    'reference-video': 0.3,
  }),
  formatContextPenalties: Object.freeze({
    '9:16': Object.freeze({ wide: 0.5 }),
    '1:1': Object.freeze({ wide: 0.75 }),
  }),
})

const MS_TIMEBASE = createTimebase(rational(BigInt(1), BigInt(1_000)))

/** Milliseconds → session ticks, exactly, rounded once half-to-even. */
export function millisecondsToTicks(ms: number, timebase: Readonly<Timebase>): bigint {
  assertDomain(Number.isSafeInteger(ms) && ms >= 0, 'INVALID_ARGUMENT', 'a policy duration is a non-negative integer of milliseconds')
  return convertTick({ tick: BigInt(ms), from: MS_TIMEBASE, to: timebase })
}

export interface ResolvedDirectionPolicy {
  readonly policy: Readonly<DirectionPolicy>
  readonly minimumShotTicks: bigint
  readonly maxCutawayTicks: bigint
  readonly jumpCutSameAngleTicks: bigint
  readonly rhythmTargetTicks: bigint
  readonly rhythmVarianceTicks: bigint
}

function assertUnit(value: number, field: string): number {
  assertDomain(Number.isFinite(value) && value >= 0 && value <= 1, 'INVALID_ARGUMENT', `${field} must be in [0, 1]`)
  return value
}

function assertWeight(value: number, field: string): number {
  assertDomain(Number.isFinite(value) && value >= 0 && value <= 100, 'INVALID_ARGUMENT', `${field} must be a finite non-negative weight`)
  return value
}

/** Validate a policy and express its durations in the session's ticks. Never a number loose in the algorithm. */
export function resolveDirectionPolicy(policy: Readonly<DirectionPolicy>, timebase: Readonly<Timebase>): Readonly<ResolvedDirectionPolicy> {
  assertDomain(policy.schemaVersion === DIRECTION_POLICY_SCHEMA_VERSION, 'INVALID_ARGUMENT', 'direction policy schema is not recognized')
  assertDomain(
    typeof policy.calibrationVersion === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/.test(policy.calibrationVersion),
    'INVALID_ARGUMENT',
    'direction policy must name its calibration version',
  )
  const minimumShotTicks = millisecondsToTicks(policy.minimumShotMs, timebase)
  const maxCutawayTicks = millisecondsToTicks(policy.maxCutawayMs, timebase)
  const jumpCutSameAngleTicks = millisecondsToTicks(policy.jumpCutSameAngleMs, timebase)
  const rhythmTargetTicks = millisecondsToTicks(policy.rhythm.targetShotMs, timebase)
  const rhythmVarianceTicks = millisecondsToTicks(policy.rhythm.varianceMs, timebase)
  assertDomain(minimumShotTicks > BigInt(0), 'INVALID_ARGUMENT', 'minimumShotMs must be at least one session tick')
  assertDomain(maxCutawayTicks >= minimumShotTicks, 'INVALID_ARGUMENT', 'maxCutawayMs cannot be shorter than minimumShotMs')
  assertDomain(jumpCutSameAngleTicks >= minimumShotTicks, 'INVALID_ARGUMENT', 'jumpCutSameAngleMs cannot be shorter than minimumShotMs')
  assertUnit(policy.redundancyThreshold, 'redundancyThreshold')
  assertUnit(policy.ambiguityMargin, 'ambiguityMargin')
  assertUnit(policy.conservativeHoldConfidence, 'conservativeHoldConfidence')
  assertUnit(policy.protectedSelectionConfidence, 'protectedSelectionConfidence')
  assertDomain(Number.isSafeInteger(policy.qualityFloorBps) && policy.qualityFloorBps >= 0 && policy.qualityFloorBps <= 10_000, 'INVALID_ARGUMENT', 'qualityFloorBps must be basis points')
  assertDomain(Number.isSafeInteger(policy.reactionIntensityFloorBps) && policy.reactionIntensityFloorBps >= 0 && policy.reactionIntensityFloorBps <= 10_000, 'INVALID_ARGUMENT', 'reactionIntensityFloorBps must be basis points')
  for (const [name, value] of Object.entries(policy.weights)) assertWeight(value, `weights.${name}`)
  for (const context of ANGLE_CONTEXTS) assertWeight(policy.contextBaseline[context], `contextBaseline.${context}`)
  for (const [ratio, penalties] of Object.entries(policy.formatContextPenalties)) {
    assertDomain(OUTPUT_ASPECT_RATIOS.includes(ratio as OutputAspectRatio), 'INVALID_ARGUMENT', `${ratio} is not an output aspect ratio`)
    for (const [context, multiplier] of Object.entries(penalties ?? {})) {
      assertDomain(ANGLE_CONTEXTS.includes(context as AngleContext), 'INVALID_ARGUMENT', `${context} is not an angle context`)
      assertUnit(multiplier as number, `formatContextPenalties.${ratio}.${context}`)
    }
  }
  return Object.freeze({ policy, minimumShotTicks, maxCutawayTicks, jumpCutSameAngleTicks, rhythmTargetTicks, rhythmVarianceTicks })
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface ScoreComponent {
  readonly value: number
  readonly evidenceRefs: readonly string[]
}

export interface AngleScoreComponents {
  readonly baseline: Readonly<ScoreComponent>
  readonly speaker: Readonly<ScoreComponent>
  readonly demonstration: Readonly<ScoreComponent>
  readonly reaction: Readonly<ScoreComponent>
  readonly quality: Readonly<ScoreComponent>
  readonly continuity: Readonly<ScoreComponent>
  readonly redundancyPenalty: Readonly<ScoreComponent>
  readonly protectedBonus: Readonly<ScoreComponent>
  readonly formatPenalty: Readonly<ScoreComponent>
  readonly total: number
}

/** A labelled human choice. Carried as an attestation, never as a measurement. */
export interface ProtectedSelection {
  readonly selectionId: string
  readonly trackId: string
  readonly sessionRange: Readonly<TickInterval>
  readonly reason: string
  readonly attestedBy: string
}

export interface AngleCandidate {
  readonly schemaVersion: typeof ANGLE_CANDIDATE_SCHEMA_VERSION
  readonly candidateId: string
  readonly trackId: string
  /** The track's identity asset. The part actually cut lives in `sourcePartId`/`sourcePartAssetId`. */
  readonly sourceAssetId: string
  readonly role: CaptureTrackRole
  readonly context: AngleContext
  readonly sessionRange: Readonly<TickInterval>
  /** Source ticks of the window, in the track's timebase. Null when the map has no law for it. */
  readonly sourceRange: Readonly<TickInterval> | null
  readonly sourcePieceId: string | null
  readonly sourcePartId: string | null
  readonly sourcePartAssetId: string | null
  readonly coverage: Readonly<{ availability: CoverageAvailability | 'out-of-bounds' | 'unmeasured'; confidenceBps: number | null }>
  readonly syncStatus: DiagnosticStatus | 'reference' | null
  readonly syncConfidence: number | null
  readonly activeSpeaker: Readonly<{ score: number; speakerKeys: readonly string[]; evidenceRefs: readonly string[] }> | null
  readonly screenActivity: Readonly<{ score: number; evidenceRefs: readonly string[] }> | null
  readonly reaction: Readonly<{ score: number; evidenceRefs: readonly string[] }> | null
  readonly technicalQuality: Readonly<{ qualityBps: number; evidenceRefs: readonly string[] }> | null
  readonly continuity: Readonly<{ previousTrackId: string | null; sameAngleTicks: bigint; spatialRelation: SpatialRelation }>
  readonly protected: Readonly<{ selectionId: string; reason: string }> | null
  readonly eligible: boolean
  readonly rejectionReasons: readonly AngleRejection[]
  readonly scoreComponents: Readonly<AngleScoreComponents>
  readonly candidateHash: string
}

export interface PreviousShotRef {
  readonly trackId: string
  /** The range held so far: `[shotStart, window.start)`. */
  readonly sessionRange: Readonly<TickInterval>
}

export interface DeriveAngleCandidatesInput {
  session: Readonly<CaptureSession>
  coverages: readonly Readonly<TrackCoverage>[]
  clockMaps: readonly Readonly<PiecewiseClockMap>[]
  diagnostic: Readonly<SyncDiagnostic>
  /** The protocol ceiling, when evaluated separately; null defers to the diagnostic's. */
  protocolCeiling: SyncCeiling | null
  evidence: Readonly<MulticamEvidenceSet>
  window: Readonly<TickInterval>
  previousShot: Readonly<PreviousShotRef> | null
  policy?: Readonly<DirectionPolicy>
  format?: Readonly<{ aspectRatio: OutputAspectRatio }>
  protectedSelections?: readonly Readonly<ProtectedSelection>[]
}

type TrackResolution =
  | Readonly<{ status: 'resolved'; sourceRange: Readonly<TickInterval>; pieceId: string; part: Readonly<CaptureTrackPart> }>
  /** `sourceGap` is the map's own declared gap around the window, when the window sits in one. Never interpolated. */
  | Readonly<{ status: 'uncovered'; reason: string; sourceGap: Readonly<TickInterval> | null }>
  | Readonly<{ status: 'map-missing' }>

/**
 * Everything `resolveTrackWindow` reads, and nothing else.
 *
 * The compile step resolves the same windows without a diagnostic, evidence or
 * a policy — it re-decides nothing. Narrowing the parameter is what lets it say
 * so honestly: an earlier draft passed a `DirectionContext` whose diagnostic and
 * evidence were `{} as unknown as …`, which would have become a silent lie the
 * day the resolver started reading one of them.
 */
interface SourceWindowResolver {
  readonly session: Readonly<CaptureSession>
  readonly mapBySource: ReadonlyMap<string, Readonly<PiecewiseClockMap>>
}

interface DirectionContext extends SourceWindowResolver {
  readonly session: Readonly<CaptureSession>
  readonly resolved: Readonly<ResolvedDirectionPolicy>
  readonly format: Readonly<{ aspectRatio: OutputAspectRatio }>
  readonly coverageByTrack: ReadonlyMap<string, Readonly<TrackCoverage>>
  readonly mapBySource: ReadonlyMap<string, Readonly<PiecewiseClockMap>>
  readonly diagnostic: Readonly<SyncDiagnostic>
  readonly ceiling: SyncCeiling | null
  readonly sessionAutoEdit: Readonly<{ allowed: boolean; blockedBy: readonly string[] }>
  readonly evidence: Readonly<MulticamEvidenceSet>
  /** camera trackId → the audio observations that name it (see `speakerCameraFor`). */
  readonly speakerCameras: ReadonlyMap<string, readonly string[]>
  readonly unmappedSpeakerObservations: readonly string[]
  readonly contextByTrack: ReadonlyMap<string, AngleContext>
  readonly cameraIds: ReadonlyMap<string, string>
  readonly protectedSelections: readonly Readonly<ProtectedSelection>[]
  readonly audioTrackId: string | null
  readonly audioRejected: readonly Readonly<{ trackId: string; reason: AngleRejection }>[]
}

const ROLE_RANK: Readonly<Record<CaptureTrackRole, number>> = Object.freeze({
  'camera-main': 0,
  'camera-alt': 1,
  phone: 2,
  screen: 3,
  reaction: 4,
  'reference-video': 5,
  microphone: 6,
  'master-audio': 7,
  'scratch-audio': 8,
})

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function ticksToString(interval: Readonly<TickInterval>): string {
  return `${interval.start}-${interval.end}`
}

function compareTicks(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function minTick(left: bigint, right: bigint): bigint {
  return left < right ? left : right
}

function maxTick(left: bigint, right: bigint): bigint {
  return left > right ? left : right
}

/**
 * Which camera an audio observation speaks for.
 *
 * Heuristic, documented because it is a heuristic: an `active-speaker`
 * observation is *about* the track that carried the speech. If that track is
 * itself a picture (a camera with its own microphone), the camera is the
 * speaker's camera. If it is an audio-only track (lapel microphone, recorder),
 * the speaker's camera is every picture track sharing the same
 * `device.deviceId` — the body that recorded the mic also framed the person.
 * An audio track bound to no camera (the room recorder) cannot name a camera
 * at all: two participants' voices on one recorder are two clusters, and a
 * cluster does not know which lens it sat in front of (ADR-151, generalized).
 * Those observations are reported as `active-speaker-unmapped`, they still
 * contribute to ambiguity detection, and no rule guesses a camera for them.
 */
function speakerCamerasFor(session: Readonly<CaptureSession>, observationTrackId: string): readonly string[] {
  const track = session.tracks.find((entry) => entry.trackId === observationTrackId)
  if (!track) return []
  if (VIDEO_ANGLE_ROLES.includes(track.role)) return [track.trackId]
  return session.tracks
    .filter((entry) => VIDEO_ANGLE_ROLES.includes(entry.role) && entry.device.deviceId === track.device.deviceId)
    .map((entry) => entry.trackId)
    .sort()
}

function contextForTrack(track: Readonly<CaptureTrack>, speakerCameras: ReadonlyMap<string, readonly string[]>): AngleContext {
  switch (track.role) {
    case 'screen':
      return 'screen'
    case 'reaction':
      return 'reaction'
    case 'reference-video':
      return 'reference-video'
    case 'camera-main':
    case 'camera-alt':
    case 'phone':
      return speakerCameras.has(track.trackId) ? 'speaker' : 'wide'
    default:
      // Audio roles are never candidates; the context is irrelevant but must be total.
      return 'wide'
  }
}

/**
 * The audio bed for every shot: the recorder's master, else a final-mix
 * microphone, else a final-mix picture track (a reactor's camera in a react
 * session), ordered by role rank then id so the choice is deterministic.
 * Tracks the session excluded from the mix are recorded as rejected.
 */
function deriveAudioSource(session: Readonly<CaptureSession>): Readonly<{ trackId: string | null; rejected: readonly Readonly<{ trackId: string; reason: AngleRejection }>[] }> {
  const rejected: Array<Readonly<{ trackId: string; reason: AngleRejection }>> = []
  const ranked = [...session.tracks]
    .filter((track) => track.role !== 'scratch-audio' && track.role !== 'screen' && track.role !== 'reference-video')
    .sort((left, right) => {
      const byRole = ROLE_RANK[left.role] - ROLE_RANK[right.role]
      return byRole !== 0 ? byRole : left.trackId.localeCompare(right.trackId)
    })
  const preferred = [
    ...ranked.filter((track) => track.role === 'master-audio'),
    ...ranked.filter((track) => track.role === 'microphone'),
    ...ranked.filter((track) => track.role !== 'master-audio' && track.role !== 'microphone'),
  ]
  let chosen: string | null = null
  for (const track of preferred) {
    if (!track.includeInFinalMix) {
      rejected.push(Object.freeze({ trackId: track.trackId, reason: 'excluded-from-final-mix' as const }))
      continue
    }
    if (chosen === null) chosen = track.trackId
  }
  return Object.freeze({ trackId: chosen, rejected: Object.freeze(rejected) })
}

function prepareContext(input: Omit<DeriveAngleCandidatesInput, 'window' | 'previousShot'>): DirectionContext {
  const session = input.session
  const ref = captureSessionDerivationRef(session)
  const resolved = resolveDirectionPolicy(input.policy ?? DEFAULT_DIRECTION_POLICY, session.clock.timebase)
  const format = input.format ?? { aspectRatio: '16:9' as const }
  assertDomain(OUTPUT_ASPECT_RATIOS.includes(format.aspectRatio), 'INVALID_ARGUMENT', `${format.aspectRatio} is not an output aspect ratio`)

  // Every derivation must be the one for THIS session version and epoch. A
  // coverage from before the reference changed describes a different clock.
  assertDomain(
    input.diagnostic.sessionId === session.sessionId
      && input.diagnostic.sessionVersion === session.version
      && input.diagnostic.referenceEpoch === session.referenceEpoch,
    'CAPTURE_SESSION_DERIVATION_STALE',
    `sync diagnostic describes session version ${input.diagnostic.sessionVersion} (reference epoch ${input.diagnostic.referenceEpoch}), not version ${session.version} (reference epoch ${session.referenceEpoch})`,
  )
  assertEvidenceDerivedFrom(input.evidence, ref)
  const coverageByTrack = new Map<string, Readonly<TrackCoverage>>()
  for (const coverage of input.coverages) {
    assertCoverageDerivedFrom(coverage, ref)
    assertDomain(!coverageByTrack.has(coverage.trackId), 'INVALID_ARGUMENT', `two coverages describe track ${coverage.trackId}`)
    coverageByTrack.set(coverage.trackId, coverage)
  }
  const mapBySource = new Map<string, Readonly<PiecewiseClockMap>>()
  for (const map of input.clockMaps) {
    assertDomain(
      map.sessionId === session.sessionId
        && map.derivedFrom.sessionVersion === session.version
        && map.derivedFrom.referenceEpoch === session.referenceEpoch,
      'CAPTURE_SESSION_DERIVATION_STALE',
      `clock map for ${map.sourceId} was derived under session version ${map.derivedFrom.sessionVersion} (reference epoch ${map.derivedFrom.referenceEpoch})`,
    )
    assertDomain(!mapBySource.has(map.sourceId), 'INVALID_ARGUMENT', `two clock maps describe source ${map.sourceId}`)
    mapBySource.set(map.sourceId, map)
  }

  const speakerCameras = new Map<string, string[]>()
  const unmapped: string[] = []
  for (const observation of input.evidence.observations) {
    if (observation.kind !== 'active-speaker') continue
    const cameras = speakerCamerasFor(session, observation.trackId)
    if (cameras.length === 0) unmapped.push(observation.observationId)
    for (const camera of cameras) speakerCameras.set(camera, [...(speakerCameras.get(camera) ?? []), observation.observationId])
  }
  const contextByTrack = new Map(session.tracks.map((track) => [track.trackId, contextForTrack(track, speakerCameras)]))

  const protectedSelections = (input.protectedSelections ?? []).map((selection) => {
    assertDomain(ID.test(selection.selectionId), 'INVALID_ARGUMENT', 'protected selection id is not a canonical identifier')
    assertDomain(ID.test(selection.trackId), 'INVALID_ARGUMENT', `protected selection ${selection.selectionId} names an invalid track id`)
    assertDomain(
      typeof selection.reason === 'string' && selection.reason.trim().length > 0 && selection.reason.length <= 512,
      'INVALID_ARGUMENT',
      `protected selection ${selection.selectionId} must say why`,
    )
    assertDomain(
      typeof selection.attestedBy === 'string' && selection.attestedBy.trim().length > 0 && selection.attestedBy.length <= 256,
      'INVALID_ARGUMENT',
      `protected selection ${selection.selectionId} must name who attested it`,
    )
    return Object.freeze({ ...selection, sessionRange: createTickInterval(selection.sessionRange.start, selection.sessionRange.end) })
  })
  for (let left = 0; left < protectedSelections.length; left += 1) {
    for (let right = left + 1; right < protectedSelections.length; right += 1) {
      assertDomain(
        !intervalsOverlap(protectedSelections[left]!.sessionRange, protectedSelections[right]!.sessionRange)
          || protectedSelections[left]!.trackId === protectedSelections[right]!.trackId,
        'INVALID_ARGUMENT',
        `protected selections ${protectedSelections[left]!.selectionId} and ${protectedSelections[right]!.selectionId} claim the same ticks for different tracks`,
      )
    }
  }

  const audio = deriveAudioSource(session)
  return Object.freeze({
    session,
    resolved,
    format,
    coverageByTrack,
    mapBySource,
    diagnostic: input.diagnostic,
    ceiling: input.protocolCeiling ?? input.diagnostic.protocolCeiling,
    sessionAutoEdit: canAutoEdit(input.diagnostic),
    evidence: input.evidence,
    speakerCameras,
    unmappedSpeakerObservations: Object.freeze(unmapped),
    contextByTrack,
    cameraIds: colorCameraIdsForSession(session),
    protectedSelections: Object.freeze(protectedSelections),
    audioTrackId: audio.trackId,
    audioRejected: audio.rejected,
  })
}

function partContaining(track: Readonly<CaptureTrack>, range: Readonly<TickInterval>): Readonly<CaptureTrackPart> | null {
  return track.parts.find((part) => intervalContains(part.coverage, range.start) && range.end <= part.coverage.end) ?? null
}

function clampToPiece(tick: bigint, piece: Readonly<ClockMapPiece>): bigint {
  return maxTick(piece.sourceCoverage.start, minTick(tick, piece.sourceCoverage.end))
}

/**
 * Where a session window lives on one track, piece by piece.
 *
 * The reference track is the clock: without a stored map its ticks convert by
 * timebase alone. Every other track resolves through its piecewise map, and
 * only when one piece covers the whole window — a window that spans a
 * boundary would splice material the recorder never produced.
 */
/**
 * The declared source gap a session window falls into, from the map's own
 * boundaries (`PieceBoundary.sourceGap`) or, for the reference track, from the
 * parts' coverage. Used only to *label* a rejection with the coverage reason;
 * no tick inside the gap is ever resolved.
 */
function declaredSourceGap(
  map: Readonly<PiecewiseClockMap> | null,
  track: Readonly<CaptureTrack>,
  window: Readonly<TickInterval>,
  sessionOfSourceTick: (tick: bigint) => bigint | null,
): Readonly<TickInterval> | null {
  if (map) {
    for (const boundary of map.boundaries) {
      if (!boundary.sourceGap) continue
      const before = map.pieces.find((piece) => piece.pieceId === boundary.beforePieceId)!
      const after = map.pieces.find((piece) => piece.pieceId === boundary.afterPieceId)!
      if (after.sessionCoverage.start <= before.sessionCoverage.end) continue
      const sessionGap = createTickInterval(before.sessionCoverage.end, after.sessionCoverage.start)
      if (intervalsOverlap(sessionGap, window)) return boundary.sourceGap
    }
    return null
  }
  const parts = [...track.parts].sort((left, right) => left.ordinal - right.ordinal)
  for (let index = 1; index < parts.length; index += 1) {
    const previous = parts[index - 1]!
    const next = parts[index]!
    if (next.coverage.start <= previous.coverage.end) continue
    const start = sessionOfSourceTick(previous.coverage.end)
    const end = sessionOfSourceTick(next.coverage.start)
    if (start === null || end === null || end <= start) continue
    if (intervalsOverlap(createTickInterval(start, end), window)) return createTickInterval(previous.coverage.end, next.coverage.start)
  }
  return null
}

function resolveTrackWindow(ctx: SourceWindowResolver, track: Readonly<CaptureTrack>, window: Readonly<TickInterval>): TrackResolution {
  const map = ctx.mapBySource.get(track.sourceAssetId) ?? null
  if (!map) {
    if (track.trackId !== ctx.session.referenceTrackId) return Object.freeze({ status: 'map-missing' as const })
    const same = rationalEquals(track.timebase.secondsPerTick, ctx.session.clock.timebase.secondsPerTick)
    const toSource = (tick: bigint) => (same ? tick : convertTick({ tick, from: ctx.session.clock.timebase, to: track.timebase, rounding: ctx.session.clock.rounding }))
    const toSession = (tick: bigint) => (same ? tick : convertTick({ tick, from: track.timebase, to: ctx.session.clock.timebase, rounding: ctx.session.clock.rounding }))
    const start = toSource(window.start)
    const end = toSource(window.end)
    if (end <= start) return Object.freeze({ status: 'uncovered' as const, reason: 'shorter-than-source-tick', sourceGap: null })
    const sourceRange = createTickInterval(start, end)
    const part = partContaining(track, sourceRange)
    if (!part) {
      return Object.freeze({ status: 'uncovered' as const, reason: 'in-discontinuity', sourceGap: declaredSourceGap(null, track, window, toSession) })
    }
    return Object.freeze({ status: 'resolved' as const, sourceRange, pieceId: 'reference-identity', part })
  }
  if (!isSessionRangeResolvable(map, window)) {
    const probe = resolveSessionTick(map, window.start)
    const reason = probe.status === 'uncovered' ? probe.reason : 'in-discontinuity'
    return Object.freeze({ status: 'uncovered' as const, reason, sourceGap: declaredSourceGap(map, track, window, () => null) })
  }
  const resolution = resolveSessionTick(map, window.start)
  assertDomain(resolution.status === 'resolved', 'INVALID_ARGUMENT', 'a resolvable window must resolve at its start')
  const piece = map.pieces.find((entry) => entry.pieceId === resolution.pieceId)!
  const start = clampToPiece(resolution.tick, piece)
  const end = clampToPiece(invertAffineClockMap(piece.map, window.end), piece)
  if (end <= start) return Object.freeze({ status: 'uncovered' as const, reason: 'shorter-than-source-tick', sourceGap: null })
  const sourceRange = createTickInterval(start, end)
  const part = partContaining(track, sourceRange)
  if (!part) return Object.freeze({ status: 'uncovered' as const, reason: 'in-discontinuity', sourceGap: null })
  return Object.freeze({ status: 'resolved' as const, sourceRange, pieceId: piece.pieceId, part })
}

/** The source range expressed in the coverage's timebase, widened outward so the query is never narrower than the cut. */
function toCoverageTicks(range: Readonly<TickInterval>, from: Readonly<Timebase>, to: Readonly<Timebase>): Readonly<TickInterval> {
  if (rationalEquals(from.secondsPerTick, to.secondsPerTick)) return range
  const start = convertTick({ tick: range.start, from, to, rounding: 'floor' })
  const end = convertTick({ tick: range.end, from, to, rounding: 'ceil' })
  return createTickInterval(start, end > start ? end : start + BigInt(1))
}

function coverageRejection(error: unknown): AngleRejection {
  if (!(error instanceof DomainError)) throw error
  if (error.code === 'CAPTURE_COVERAGE_UNVERIFIED') {
    return error.details.reason === 'unverified' ? 'coverage-unverified' : 'coverage-below-floor'
  }
  if (error.code === 'CAPTURE_COVERAGE_NOT_AVAILABLE') {
    switch (error.details.reason) {
      case 'gap': return 'coverage-gap'
      case 'corrupt': return 'coverage-corrupt'
      default: return 'coverage-out-of-bounds'
    }
  }
  throw error
}

function evidenceRef(observation: Readonly<MulticamObservation>): string {
  return `observation:${observation.observationId}`
}

function weightedEvidence(
  observations: readonly Readonly<MulticamObservation>[],
  window: Readonly<TickInterval>,
  magnitude: (observation: Readonly<MulticamObservation>) => number,
): Readonly<{ score: number; evidenceRefs: readonly string[]; confidence: number | null }> {
  let score = 0
  let weight = 0
  let weightedConfidence = 0
  const refs: string[] = []
  for (const observation of observations) {
    const overlap = overlapFraction(observation.range, window)
    if (overlap <= 0) continue
    const contribution = observation.confidence * overlap * magnitude(observation)
    score += contribution
    weight += overlap
    weightedConfidence += observation.confidence * overlap
    refs.push(evidenceRef(observation))
  }
  return Object.freeze({
    score: Math.min(1, score),
    evidenceRefs: Object.freeze([...new Set(refs)].sort()),
    confidence: weight > 0 ? weightedConfidence / weight : null,
  })
}

function component(value: number, evidenceRefs: readonly string[] = []): Readonly<ScoreComponent> {
  return Object.freeze({ value: Number(value.toFixed(6)), evidenceRefs: Object.freeze([...evidenceRefs]) })
}

function deriveCandidate(
  ctx: DirectionContext,
  track: Readonly<CaptureTrack>,
  window: Readonly<TickInterval>,
  previousShot: Readonly<PreviousShotRef> | null,
): Readonly<AngleCandidate> {
  const rejections = new Set<AngleRejection>()
  const context = ctx.contextByTrack.get(track.trackId) ?? 'wide'
  if (!VIDEO_ANGLE_ROLES.includes(track.role)) rejections.add('not-a-video-source')

  // 1. Where is this window on the track? Nothing else is answerable without it.
  const resolution = resolveTrackWindow(ctx, track, window)
  if (resolution.status === 'map-missing') rejections.add('sync-map-missing')
  if (resolution.status === 'uncovered') rejections.add('sync-uncovered')

  // 2. May I cut to it? Only the coverage gate answers, with its reason.
  let coverage: AngleCandidate['coverage'] = Object.freeze({ availability: 'unmeasured' as const, confidenceBps: null })
  const trackCoverage = ctx.coverageByTrack.get(track.trackId) ?? null
  if (!trackCoverage) {
    rejections.add('coverage-missing')
  } else if (resolution.status === 'uncovered' && resolution.sourceGap) {
    // The map already refused the window; the coverage says what the recorder
    // did there, using the gap the map itself declared. Both reasons are
    // reported: "uncovered" sends an operator to the sync, "gap" to the camera.
    const query = toCoverageTicks(resolution.sourceGap, track.timebase, trackCoverage.timebase)
    const overlapping = (entries: readonly Readonly<{ interval: Readonly<TickInterval> }>[]) =>
      entries.some((entry) => intervalsOverlap(entry.interval, query))
    if (overlapping(trackCoverage.corrupt)) {
      rejections.add('coverage-corrupt')
      coverage = Object.freeze({ availability: 'corrupt' as const, confidenceBps: null })
    } else if (overlapping(trackCoverage.unverified)) {
      rejections.add('coverage-unverified')
      coverage = Object.freeze({ availability: 'unverified' as const, confidenceBps: null })
    } else if (overlapping(trackCoverage.gaps)) {
      rejections.add('coverage-gap')
      coverage = Object.freeze({ availability: 'gap' as const, confidenceBps: null })
    }
  } else if (resolution.status === 'resolved') {
    const query = toCoverageTicks(resolution.sourceRange, track.timebase, trackCoverage.timebase)
    try {
      const covering = assertCoverageSelectable(trackCoverage, { interval: query, purpose: 'auto-edit' })
      coverage = Object.freeze({
        availability: 'available' as const,
        confidenceBps: covering.reduce((least, entry) => Math.min(least, entry.confidenceBps), 10_000),
      })
    } catch (error) {
      const rejection = coverageRejection(error)
      rejections.add(rejection)
      const details = (error as DomainError).details
      coverage = Object.freeze({
        availability: rejection === 'coverage-below-floor'
          ? 'available' as const
          : ((details.reason as CoverageAvailability | 'out-of-bounds') ?? 'out-of-bounds'),
        confidenceBps: rejection === 'coverage-below-floor' ? (details.confidenceBps as number) : null,
      })
    }
  }

  // 3. Is the timeline trustworthy here? Session verdict, or the track's own.
  const isReference = track.trackId === ctx.session.referenceTrackId
  const trackDiagnostic = ctx.diagnostic.tracks.find((entry) => entry.trackId === track.trackId) ?? null
  const syncStatus: AngleCandidate['syncStatus'] = isReference ? 'reference' : (trackDiagnostic?.status ?? null)
  const syncConfidence = trackDiagnostic?.confidence ?? null
  if (ctx.ceiling === 'manual-anchors-required' || ctx.ceiling === 'not-synchronizable') rejections.add('protocol-ceiling')
  if (!isReference) {
    if (!trackDiagnostic) {
      rejections.add('sync-missing')
    } else if (!ctx.sessionAutoEdit.allowed) {
      const trackTrusted = (trackDiagnostic.status === 'synced-high' || trackDiagnostic.status === 'synced-medium')
        && trackDiagnostic.confidence >= DIAGNOSTIC_POLICY.mediumConfidence
        && !trackDiagnostic.warnings.includes('insufficient-evidence')
        && !trackDiagnostic.warnings.includes('anchors-contradictory')
      if (!trackTrusted) rejections.add('sync-below-threshold')
    } else if (trackDiagnostic.status !== 'synced-high' && trackDiagnostic.status !== 'synced-medium') {
      rejections.add('sync-below-threshold')
    }
  }

  // 4. Evidence in the window, weighted by how much of the window it covers.
  const speakerObservationIds = new Set(ctx.speakerCameras.get(track.trackId) ?? [])
  const speaker = weightedEvidence(
    observationsOverlapping(ctx.evidence, window, { kinds: ['active-speaker'] })
      .filter((observation) => speakerObservationIds.has(observation.observationId)),
    window,
    () => 1,
  )
  const speakerKeys = [...new Set(
    observationsOverlapping(ctx.evidence, window, { kinds: ['active-speaker'] })
      .filter((observation) => speakerObservationIds.has(observation.observationId))
      .map((observation) => (observation.value.kind === 'active-speaker' ? observation.value.speakerKey : null))
      .filter((key): key is string => key !== null),
  )].sort()

  const demonstrationObservations = observationsOverlapping(ctx.evidence, window, { kinds: ['demonstration'] })
    .filter((observation) => observation.value.kind === 'demonstration' && (
      context === 'screen'
        ? observation.value.surface !== 'physical'
        : observation.value.surface === 'physical' && observation.trackId === track.trackId
    ))
  const activity = weightedEvidence(
    [
      ...demonstrationObservations,
      ...(context === 'screen' ? observationsOverlapping(ctx.evidence, window, { kinds: ['screen-activity'], trackId: track.trackId }) : []),
    ],
    window,
    (observation) => (observation.value.kind === 'screen-activity' ? observation.value.activityBps / 10_000 : 1),
  )

  const reaction = weightedEvidence(
    observationsOverlapping(ctx.evidence, window, { kinds: ['reaction'], trackId: track.trackId })
      .filter((observation) => observation.value.kind === 'reaction' && observation.value.intensityBps >= ctx.resolved.policy.reactionIntensityFloorBps),
    window,
    (observation) => (observation.value.kind === 'reaction' ? observation.value.intensityBps / 10_000 : 0),
  )

  const qualityObservations = observationsOverlapping(ctx.evidence, window, { kinds: ['technical-quality'], trackId: track.trackId })
  let qualityWeight = 0
  let qualitySum = 0
  for (const observation of qualityObservations) {
    if (observation.value.kind !== 'technical-quality') continue
    const dimensions = [observation.value.sharpnessBps, observation.value.stabilityBps, observation.value.exposureBps]
      .filter((value): value is number => value !== null)
    const overlap = overlapFraction(observation.range, window)
    if (dimensions.length === 0 || overlap <= 0) continue
    qualitySum += overlap * (dimensions.reduce((sum, value) => sum + value, 0) / dimensions.length)
    qualityWeight += overlap
  }
  const technicalQuality = qualityWeight > 0
    ? Object.freeze({
      qualityBps: Math.round(qualitySum / qualityWeight),
      evidenceRefs: Object.freeze(qualityObservations.map(evidenceRef).sort()),
    })
    : null
  if (technicalQuality && technicalQuality.qualityBps < ctx.resolved.policy.qualityFloorBps) rejections.add('quality-below-floor')

  // 5. Continuity and protection.
  const previousTrack = previousShot ? ctx.session.tracks.find((entry) => entry.trackId === previousShot.trackId) ?? null : null
  const continuity = Object.freeze({
    previousTrackId: previousShot?.trackId ?? null,
    sameAngleTicks: previousShot && previousShot.trackId === track.trackId ? intervalDuration(previousShot.sessionRange) : BigInt(0),
    spatialRelation: (previousTrack
      ? previousTrack.device.deviceId === track.device.deviceId ? 'same' : 'unknown'
      : 'unknown') as SpatialRelation,
  })
  const selection = ctx.protectedSelections.find((entry) => entry.trackId === track.trackId && intervalsOverlap(entry.sessionRange, window)) ?? null
  const protectedBy = selection ? Object.freeze({ selectionId: selection.selectionId, reason: selection.reason }) : null

  // 6. Score. Every component is named and carries what produced it.
  const weights = ctx.resolved.policy.weights
  const baseline = ctx.resolved.policy.contextBaseline[context]
  const speakerValue = weights.speaker * speaker.score
  const demonstrationValue = weights.demonstration * activity.score
  const reactionValue = weights.reaction * reaction.score
  const qualityValue = technicalQuality ? weights.quality * ((technicalQuality.qualityBps - 5_000) / 5_000) : 0
  const continuityValue = previousShot && previousShot.trackId === track.trackId ? weights.continuity : 0
  const previousContext = previousTrack ? ctx.contextByTrack.get(previousTrack.trackId) ?? null : null
  const redundancyValue = previousTrack && previousTrack.trackId !== track.trackId && previousContext === context
    ? -weights.redundancyPenalty
    : 0
  const protectedValue = protectedBy ? weights.protectedBonus : 0
  const multiplier = ctx.resolved.policy.formatContextPenalties[ctx.format.aspectRatio]?.[context] ?? 1
  const positive = baseline + speakerValue + demonstrationValue + reactionValue
  const formatValue = -(1 - multiplier) * positive
  const total = positive + qualityValue + continuityValue + redundancyValue + protectedValue + formatValue

  const scoreComponents: AngleScoreComponents = Object.freeze({
    baseline: component(baseline),
    speaker: component(speakerValue, speaker.evidenceRefs),
    demonstration: component(demonstrationValue, activity.evidenceRefs),
    reaction: component(reactionValue, reaction.evidenceRefs),
    quality: component(qualityValue, technicalQuality?.evidenceRefs ?? []),
    continuity: component(continuityValue),
    redundancyPenalty: component(redundancyValue),
    protectedBonus: component(protectedValue, protectedBy ? [`protected-selection:${protectedBy.selectionId}`] : []),
    formatPenalty: component(formatValue),
    total: Number(total.toFixed(6)),
  })

  const body = {
    schemaVersion: ANGLE_CANDIDATE_SCHEMA_VERSION,
    candidateId: `${track.trackId}:${ticksToString(window)}`,
    trackId: track.trackId,
    sourceAssetId: track.sourceAssetId,
    role: track.role,
    context,
    sessionRange: window,
    sourceRange: resolution.status === 'resolved' ? resolution.sourceRange : null,
    sourcePieceId: resolution.status === 'resolved' ? resolution.pieceId : null,
    sourcePartId: resolution.status === 'resolved' ? resolution.part.partId : null,
    sourcePartAssetId: resolution.status === 'resolved' ? resolution.part.sourceAssetId : null,
    coverage,
    syncStatus,
    syncConfidence,
    activeSpeaker: speaker.evidenceRefs.length > 0
      ? Object.freeze({ score: Number(speaker.score.toFixed(6)), speakerKeys: Object.freeze(speakerKeys), evidenceRefs: speaker.evidenceRefs })
      : null,
    screenActivity: activity.evidenceRefs.length > 0 ? Object.freeze({ score: Number(activity.score.toFixed(6)), evidenceRefs: activity.evidenceRefs }) : null,
    reaction: reaction.evidenceRefs.length > 0 ? Object.freeze({ score: Number(reaction.score.toFixed(6)), evidenceRefs: reaction.evidenceRefs }) : null,
    technicalQuality,
    continuity,
    protected: protectedBy,
    eligible: rejections.size === 0,
    rejectionReasons: Object.freeze([...rejections].sort()),
    scoreComponents,
  }
  return Object.freeze({ ...body, candidateHash: calculateAngleCandidateHash(body) })
}

export function calculateAngleCandidateHash(candidate: Omit<AngleCandidate, 'candidateHash'>): string {
  return calculateCanonicalHash({
    ...candidate,
    sessionRange: serializeTickInterval(candidate.sessionRange),
    sourceRange: candidate.sourceRange ? serializeTickInterval(candidate.sourceRange) : null,
    continuity: { ...candidate.continuity, sameAngleTicks: candidate.continuity.sameAngleTicks.toString() },
  })
}

function compareCandidates(ctx: DirectionContext, left: Readonly<AngleCandidate>, right: Readonly<AngleCandidate>): number {
  if (left.scoreComponents.total !== right.scoreComponents.total) return right.scoreComponents.total - left.scoreComponents.total
  const leftReference = left.trackId === ctx.session.referenceTrackId ? 0 : 1
  const rightReference = right.trackId === ctx.session.referenceTrackId ? 0 : 1
  if (leftReference !== rightReference) return leftReference - rightReference
  const byRole = ROLE_RANK[left.role] - ROLE_RANK[right.role]
  if (byRole !== 0) return byRole
  return left.trackId.localeCompare(right.trackId)
}

function deriveCandidatesWith(
  ctx: DirectionContext,
  window: Readonly<TickInterval>,
  previousShot: Readonly<PreviousShotRef> | null,
): readonly Readonly<AngleCandidate>[] {
  return Object.freeze(
    [...ctx.session.tracks]
      .sort((left, right) => left.trackId.localeCompare(right.trackId))
      .map((track) => deriveCandidate(ctx, track, window, previousShot)),
  )
}

/**
 * Every track of the session as a candidate for one window — eligible or not.
 *
 * Nothing comes from the caller but ids, ranges and labelled attestations:
 * coverage, maps, diagnostic and evidence are the stored derivations of the
 * exact session version, and each is refused when it is not.
 */
export function deriveAngleCandidates(input: DeriveAngleCandidatesInput): readonly Readonly<AngleCandidate>[] {
  const window = createTickInterval(input.window.start, input.window.end)
  const ctx = prepareContext(input)
  return deriveCandidatesWith(ctx, window, input.previousShot)
}

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

export interface ShotAlternative {
  readonly candidateId: string
  readonly trackId: string
  readonly scoreTotal: number
  readonly rejectedBecause: string
}

export interface ShotDecision {
  readonly schemaVersion: typeof SHOT_DECISION_SCHEMA_VERSION
  readonly shotId: string
  readonly ordinal: number
  readonly sessionRange: Readonly<TickInterval>
  readonly chosen: Readonly<AngleCandidate>
  /** The audio bed for this shot, or null when the clip must carry its own source audio. */
  readonly audioTrackId: string | null
  readonly alternatives: readonly Readonly<ShotAlternative>[]
  readonly rule: DirectionRule
  readonly reason: string
  readonly evidenceRefs: readonly string[]
  readonly confidence: number
  readonly confidenceBand: DirectionConfidenceBand
  readonly decisionHash: string
}

export interface DirectionWarning {
  readonly code: DirectionWarningCode
  readonly shotId: string | null
  readonly trackId: string | null
  readonly detail: string
}

export interface MulticamDirection {
  readonly schemaVersion: typeof MULTICAM_DIRECTION_SCHEMA_VERSION
  readonly workspaceId: string
  readonly sessionId: string
  readonly sessionVersion: number
  readonly referenceEpoch: number
  readonly diagnosticVersion: number
  readonly diagnosticHash: string
  readonly evidenceHash: string
  readonly range: Readonly<TickInterval>
  readonly format: Readonly<{ aspectRatio: OutputAspectRatio }>
  readonly policy: Readonly<DirectionPolicy>
  readonly audio: Readonly<{ trackId: string | null; rejected: readonly Readonly<{ trackId: string; reason: AngleRejection }>[] }>
  readonly shots: readonly Readonly<ShotDecision>[]
  /** Session ranges in which no track was eligible. Never bridged by a shot. */
  readonly uncovered: readonly Readonly<TickInterval>[]
  readonly warnings: readonly Readonly<DirectionWarning>[]
  readonly manualReviewRequired: boolean
  readonly generatedAt: string
  readonly directionHash: string
}

export interface DirectMulticamInput extends Omit<DeriveAngleCandidatesInput, 'window' | 'previousShot'> {
  /** Defaults to the reference track's session hull. */
  range?: Readonly<TickInterval>
  generatedAt: string
}

interface WindowDecision {
  readonly window: Readonly<TickInterval>
  readonly candidates: readonly Readonly<AngleCandidate>[]
  readonly chosen: Readonly<AngleCandidate> | null
  readonly rule: DirectionRule
  readonly reason: string
  readonly confidence: number
  readonly warnings: readonly Readonly<Omit<DirectionWarning, 'shotId'>>[]
}

interface Run {
  readonly trackId: string
  readonly pieceId: string
  readonly start: bigint
  end: bigint
  readonly rule: DirectionRule
  readonly reason: string
  confidence: number
  readonly decisions: WindowDecision[]
}

function evidenceConfidenceOf(candidate: Readonly<AngleCandidate>): number | null {
  const backed = [candidate.activeSpeaker, candidate.screenActivity, candidate.reaction].filter((entry) => entry !== null)
  if (backed.length === 0) return null
  // The components carry the refs, not the confidences; recover the weighted
  // score as the best available proxy for how sure the evidence was.
  const scores = backed.map((entry) => entry!.score)
  return Math.min(1, scores.reduce((sum, value) => sum + value, 0) / scores.length)
}

/** The evidence-backed part of a score: what the window itself argued, without baseline, continuity or penalties. */
function evidenceScore(candidate: Readonly<AngleCandidate>): number {
  return candidate.scoreComponents.speaker.value
    + candidate.scoreComponents.demonstration.value
    + candidate.scoreComponents.reaction.value
}

function hasEvidence(candidate: Readonly<AngleCandidate>): boolean {
  return evidenceScore(candidate) > 0
}

/**
 * Confidence from evidence and margin (spec 01 §20: cite evidence and method).
 *
 * `evidence × (0.6 + 0.4 × separation)`: a clear winner backed by confident
 * evidence lands in `high`; the same evidence with no margin lands below the
 * `medium` floor, which is what makes a tie reviewable rather than decided.
 * A choice with no evidence behind it takes the policy's conservative value.
 */
function decisionConfidence(policy: Readonly<DirectionPolicy>, winner: Readonly<AngleCandidate>, runnerUp: Readonly<AngleCandidate> | null): number {
  const evidence = evidenceConfidenceOf(winner)
  if (evidence === null) return policy.conservativeHoldConfidence
  const margin = runnerUp ? winner.scoreComponents.total - runnerUp.scoreComponents.total : winner.scoreComponents.total
  const separation = Math.max(0, Math.min(1, margin / Math.max(winner.scoreComponents.total, 1e-9)))
  return Number(Math.max(0, Math.min(1, evidence * (0.6 + 0.4 * separation))).toFixed(6))
}

function dominantRule(candidate: Readonly<AngleCandidate>): DirectionRule {
  const { speaker, demonstration, reaction } = candidate.scoreComponents
  const best = Math.max(speaker.value, demonstration.value, reaction.value)
  if (best <= 0) return 'cutaway-return'
  if (best === demonstration.value) return 'demonstration-prefers-screen'
  if (best === speaker.value) return 'speech-prefers-active-speaker'
  return 'reaction-cutaway'
}

function describe(candidate: Readonly<AngleCandidate>): string {
  return `${candidate.trackId} (${candidate.context}, score ${candidate.scoreComponents.total.toFixed(3)})`
}

function decideWindow(
  ctx: DirectionContext,
  window: Readonly<TickInterval>,
  current: Run | null,
): WindowDecision {
  const previousShot: PreviousShotRef | null = current
    ? { trackId: current.trackId, sessionRange: createTickInterval(current.start, window.start > current.start ? window.start : current.start + BigInt(1)) }
    : null
  const candidates = deriveCandidatesWith(ctx, window, previousShot)
  const warnings: Array<Readonly<Omit<DirectionWarning, 'shotId'>>> = []
  const policy = ctx.resolved.policy
  const eligible = candidates.filter((candidate) => candidate.eligible)
  const currentCandidate = current ? candidates.find((candidate) => candidate.trackId === current.trackId) ?? null : null
  const currentEligible = currentCandidate !== null && currentCandidate.eligible
  const heldTicks = current ? window.start - current.start : BigInt(0)

  const decided = (chosen: Readonly<AngleCandidate> | null, rule: DirectionRule, reason: string, confidence: number): WindowDecision =>
    Object.freeze({ window, candidates, chosen, rule, reason, confidence, warnings: Object.freeze(warnings) })

  // Rule 6: a protected selection is never substituted. Eligible → it wins.
  // Ineligible → the window is directed like any other, loudly.
  const selection = ctx.protectedSelections.find((entry) => intervalsOverlap(entry.sessionRange, window)) ?? null
  if (selection) {
    const protectedCandidate = candidates.find((candidate) => candidate.trackId === selection.trackId) ?? null
    if (!protectedCandidate) {
      warnings.push(Object.freeze({
        code: 'protected-selection-unknown-track' as const,
        trackId: selection.trackId,
        detail: `protected selection ${selection.selectionId} names ${selection.trackId}, which is not in this session`,
      }))
    } else if (protectedCandidate.eligible) {
      return decided(
        protectedCandidate,
        'protected-selection',
        `protected-selection: ${selection.attestedBy} kept ${describe(protectedCandidate)} (${selection.reason})`,
        policy.protectedSelectionConfidence,
      )
    } else {
      warnings.push(Object.freeze({
        code: 'protected-selection-ineligible' as const,
        trackId: selection.trackId,
        detail: `protected selection ${selection.selectionId} on ${selection.trackId} cannot be honoured: ${protectedCandidate.rejectionReasons.join(', ')}`,
      }))
    }
  }

  if (eligible.length === 0) {
    warnings.push(Object.freeze({
      code: 'no-eligible-candidate' as const,
      trackId: null,
      detail: `no track is eligible in ${ticksToString(window)}: ${candidates.map((candidate) => `${candidate.trackId}[${candidate.rejectionReasons.join('|')}]`).join(' ')}`,
    }))
    return decided(null, 'conservative-hold', `conservative-hold: no eligible angle in ${ticksToString(window)}`, 0)
  }

  // Rule 3: a cutaway returns. Past the cap the reaction context is withdrawn
  // from the pool, unless it is all there is.
  let pool = eligible
  if (current && currentCandidate?.context === 'reaction' && heldTicks >= ctx.resolved.maxCutawayTicks) {
    const returning = eligible.filter((candidate) => candidate.context !== 'reaction')
    if (returning.length > 0) pool = returning
  }

  // Rule 8: minimum shot duration. A shot that has not yet lasted the minimum
  // holds while it legitimately can.
  if (current && currentEligible && heldTicks < ctx.resolved.minimumShotTicks && pool.some((candidate) => candidate.trackId === current.trackId)) {
    return decided(currentCandidate, 'minimum-shot-hold', `minimum-shot-hold: ${describe(currentCandidate!)} held until the minimum shot length`, current.confidence)
  }

  const ranked = [...pool].sort((left, right) => compareCandidates(ctx, left, right))
  const best = ranked[0]!
  const second = ranked[1] ?? null

  // Ambiguity: two evidence-backed angles whose *evidence* is within the
  // margin are not ranked, they are reviewed — continuity and penalties would
  // otherwise turn a genuine tie into a confident-looking hold. Measured
  // concurrent speech doubles the margin: the detector itself said the
  // instant is contested. The direction holds rather than alternating.
  const concurrent = observationsOverlapping(ctx.evidence, window, { kinds: ['concurrent-speech'] }).length > 0
  const margin = concurrent ? policy.ambiguityMargin * 2 : policy.ambiguityMargin
  const ambiguous = second !== null
    && hasEvidence(best) && hasEvidence(second)
    && Math.abs(evidenceScore(best) - evidenceScore(second)) <= margin
  if (ambiguous) {
    warnings.push(Object.freeze({
      code: 'ambiguous-active-speaker' as const,
      trackId: best.trackId,
      detail: `${describe(best)} and ${describe(second)} are within ${policy.ambiguityMargin} of each other in ${ticksToString(window)}`,
    }))
    const hold = currentEligible && pool.some((candidate) => candidate.trackId === current!.trackId) ? currentCandidate! : best
    return decided(hold, 'conservative-hold', `conservative-hold: ambiguous evidence, holding ${describe(hold)}`, decisionConfidence(policy, best, second))
  }

  // Rule 4 + rhythm: no switch without gain, unless the shot has outlived the rhythm target.
  if (current && currentEligible && best.trackId !== current.trackId && pool.some((candidate) => candidate.trackId === current.trackId)) {
    const gain = best.scoreComponents.total - currentCandidate!.scoreComponents.total
    const rhythmExceeded = heldTicks >= ctx.resolved.rhythmTargetTicks + ctx.resolved.rhythmVarianceTicks
    const required = rhythmExceeded ? 0 : policy.redundancyThreshold
    if (gain < required || (gain === 0 && required === 0)) {
      return decided(
        currentCandidate,
        'redundant-angles-hold',
        `redundant-angles-hold: ${describe(best)} gains ${gain.toFixed(3)} over ${describe(currentCandidate!)}, below ${required}`,
        hasEvidence(currentCandidate!) ? decisionConfidence(policy, currentCandidate!, best) : policy.conservativeHoldConfidence,
      )
    }
  }

  if (current && currentEligible && best.trackId === current.trackId) {
    const rule = hasEvidence(best) ? dominantRule(best) : 'redundant-angles-hold'
    return decided(best, rule, `${rule}: ${describe(best)} remains the best angle`, decisionConfidence(policy, best, second))
  }

  if (!hasEvidence(best)) {
    // Nothing argues for any angle. Leaving an eligible angle for its resting
    // context is the return after a cutaway; the opening, or the fallback
    // after the current angle stopped being eligible, is a conservative hold.
    const rule: DirectionRule = current && currentEligible ? 'cutaway-return' : 'conservative-hold'
    return decided(best, rule, `${rule}: no evidence in ${ticksToString(window)}; ${describe(best)} is the resting angle`, policy.conservativeHoldConfidence)
  }

  const rule = dominantRule(best)
  return decided(best, rule, `${rule}: ${describe(best)} over ${second ? describe(second) : 'no alternative'}`, decisionConfidence(policy, best, second))
}

function defaultRange(ctx: DirectionContext): Readonly<TickInterval> {
  const reference = ctx.session.tracks.find((track) => track.trackId === ctx.session.referenceTrackId)!
  const map = ctx.mapBySource.get(reference.sourceAssetId) ?? null
  if (map) {
    return createTickInterval(map.pieces[0]!.sessionCoverage.start, map.pieces[map.pieces.length - 1]!.sessionCoverage.end)
  }
  const starts = reference.parts.map((part) => part.coverage.start)
  const ends = reference.parts.map((part) => part.coverage.end)
  const hull = createTickInterval(starts.reduce(minTick), ends.reduce(maxTick))
  const same = rationalEquals(reference.timebase.secondsPerTick, ctx.session.clock.timebase.secondsPerTick)
  if (same) return hull
  return createTickInterval(
    convertTick({ tick: hull.start, from: reference.timebase, to: ctx.session.clock.timebase, rounding: 'ceil' }),
    convertTick({ tick: hull.end, from: reference.timebase, to: ctx.session.clock.timebase, rounding: 'floor' }),
  )
}

/**
 * The elementary decision intervals: session time cut at every instant where
 * something the decision depends on changes — an observation starts or ends,
 * a protected selection begins, a clock-map piece or a coverage interval
 * boundary lands in session time.
 */
function partitionWindows(ctx: DirectionContext, range: Readonly<TickInterval>): readonly Readonly<TickInterval>[] {
  const ticks = new Set<bigint>([range.start, range.end])
  for (const tick of evidenceBreakpoints(ctx.evidence, range)) ticks.add(tick)
  for (const selection of ctx.protectedSelections) {
    for (const tick of [selection.sessionRange.start, selection.sessionRange.end]) if (tick > range.start && tick < range.end) ticks.add(tick)
  }
  for (const track of ctx.session.tracks) {
    const map = ctx.mapBySource.get(track.sourceAssetId) ?? null
    const coverage = ctx.coverageByTrack.get(track.trackId) ?? null
    const sourceBoundaries: bigint[] = []
    if (coverage) {
      for (const entry of [...coverage.available, ...coverage.gaps, ...coverage.corrupt, ...coverage.unverified]) {
        for (const tick of [entry.interval.start, entry.interval.end]) {
          sourceBoundaries.push(rationalEquals(coverage.timebase.secondsPerTick, track.timebase.secondsPerTick)
            ? tick
            : convertTick({ tick, from: coverage.timebase, to: track.timebase }))
        }
      }
    }
    if (map) {
      for (const piece of map.pieces) {
        for (const tick of [piece.sessionCoverage.start, piece.sessionCoverage.end]) if (tick > range.start && tick < range.end) ticks.add(tick)
      }
      for (const tick of sourceBoundaries) {
        const resolution = resolveSourceTick(map, tick)
        if (resolution.status === 'resolved' && resolution.tick > range.start && resolution.tick < range.end) ticks.add(resolution.tick)
      }
    } else if (track.trackId === ctx.session.referenceTrackId) {
      const same = rationalEquals(track.timebase.secondsPerTick, ctx.session.clock.timebase.secondsPerTick)
      for (const tick of [...sourceBoundaries, ...track.parts.flatMap((part) => [part.coverage.start, part.coverage.end])]) {
        const session = same ? tick : convertTick({ tick, from: track.timebase, to: ctx.session.clock.timebase })
        if (session > range.start && session < range.end) ticks.add(session)
      }
    }
  }
  const sorted = [...ticks].sort(compareTicks)
  const windows: Array<Readonly<TickInterval>> = []
  for (let index = 1; index < sorted.length; index += 1) windows.push(createTickInterval(sorted[index - 1]!, sorted[index]!))
  return Object.freeze(windows)
}

function audioForShot(ctx: DirectionContext, range: Readonly<TickInterval>): Readonly<{ trackId: string | null; detail: string | null }> {
  if (ctx.audioTrackId === null) return Object.freeze({ trackId: null, detail: 'the session has no final-mix audio track' })
  const track = ctx.session.tracks.find((entry) => entry.trackId === ctx.audioTrackId)!
  const resolution = resolveTrackWindow(ctx, track, range)
  if (resolution.status !== 'resolved') {
    return Object.freeze({ trackId: null, detail: `${track.trackId} is ${resolution.status === 'uncovered' ? resolution.reason : 'without a clock map'} in ${ticksToString(range)}` })
  }
  const coverage = ctx.coverageByTrack.get(track.trackId) ?? null
  if (!coverage) return Object.freeze({ trackId: null, detail: `${track.trackId} has no measured coverage` })
  try {
    assertCoverageSelectable(coverage, { interval: toCoverageTicks(resolution.sourceRange, track.timebase, coverage.timebase), purpose: 'auto-edit' })
  } catch (error) {
    return Object.freeze({ trackId: null, detail: `${track.trackId}: ${coverageRejection(error)} in ${ticksToString(range)}` })
  }
  return Object.freeze({ trackId: track.trackId, detail: null })
}

/**
 * Why each track that was not chosen was not chosen.
 *
 * An angle that COULD have been cut to and lost on score is a different answer
 * from one that was never admissible, so an eligible appearance always beats an
 * ineligible one — even when the ineligible window scored higher. Ranking by
 * score alone let a candidate that was merely out of coverage in the first
 * window mask the reason it lost in every window after it.
 */
function alternativesOf(decisions: readonly WindowDecision[], chosenTrackId: string): readonly Readonly<ShotAlternative>[] {
  const best = new Map<string, Readonly<ShotAlternative> & { eligible: boolean }>()
  for (const decision of decisions) {
    for (const candidate of decision.candidates) {
      if (candidate.trackId === chosenTrackId) continue
      const rejectedBecause = candidate.eligible
        ? `scored ${candidate.scoreComponents.total.toFixed(3)} under ${decision.rule}`
        : candidate.rejectionReasons.join(', ')
      const known = best.get(candidate.trackId)
      const better = !known
        || (candidate.eligible && !known.eligible)
        || (candidate.eligible === known.eligible && candidate.scoreComponents.total > known.scoreTotal)
      if (better) {
        best.set(candidate.trackId, {
          candidateId: candidate.candidateId,
          trackId: candidate.trackId,
          scoreTotal: candidate.scoreComponents.total,
          rejectedBecause,
          eligible: candidate.eligible,
        })
      }
    }
  }
  return Object.freeze([...best.values()]
    .sort((left, right) => left.trackId.localeCompare(right.trackId))
    .map(({ eligible: _eligible, ...alternative }) => Object.freeze(alternative)))
}

function shotEvidenceRefs(ctx: DirectionContext, chosen: Readonly<AngleCandidate>): readonly string[] {
  const refs = new Set<string>([
    `sync-diagnostic:${ctx.diagnostic.sessionId}:v${ctx.diagnostic.version}`,
    `track-coverage:${chosen.trackId}`,
  ])
  for (const entry of Object.values(chosen.scoreComponents)) {
    if (typeof entry === 'number') continue
    for (const ref of entry.evidenceRefs) refs.add(ref)
  }
  return Object.freeze([...refs].sort().slice(0, 32))
}

function sealShot(ctx: DirectionContext, run: Run, ordinal: number): Readonly<{ shot: Readonly<ShotDecision>; warnings: readonly Readonly<DirectionWarning>[] }> {
  const shotId = `shot-${String(ordinal + 1).padStart(4, '0')}`
  const range = createTickInterval(run.start, run.end)
  const previous = run.decisions[0]!.candidates.find((candidate) => candidate.trackId === run.trackId)!.continuity.previousTrackId
  const previousShot: PreviousShotRef | null = previous && previous !== run.trackId
    ? { trackId: previous, sessionRange: createTickInterval(run.start - BigInt(1), run.start) }
    : null
  // Re-derive the chosen candidate over the whole shot: eligibility is proved
  // on the range that will be cut, not assumed from its windows.
  const chosen = deriveCandidatesWith(ctx, range, previousShot).find((candidate) => candidate.trackId === run.trackId)!
  assertDomain(
    chosen.eligible,
    'INVALID_ARGUMENT',
    `shot ${shotId} on ${run.trackId} is not eligible over ${ticksToString(range)} although every window was: ${chosen.rejectionReasons.join(', ')}`,
  )
  const warnings: Array<Readonly<DirectionWarning>> = []
  const audio = audioForShot(ctx, range)
  if (audio.trackId === null) {
    warnings.push(Object.freeze({ code: 'audio-master-unavailable' as const, shotId, trackId: ctx.audioTrackId, detail: audio.detail ?? 'no audio bed' }))
  }
  if (intervalDuration(range) < ctx.resolved.minimumShotTicks) {
    warnings.push(Object.freeze({
      code: 'minimum-shot-violated' as const,
      shotId,
      trackId: run.trackId,
      detail: `shot ${shotId} lasts ${intervalDuration(range)} ticks, below the minimum ${ctx.resolved.minimumShotTicks}`,
    }))
  }
  for (const decision of run.decisions) {
    for (const warning of decision.warnings) warnings.push(Object.freeze({ ...warning, shotId }))
  }
  const confidence = Number(Math.min(...run.decisions.map((decision) => decision.confidence)).toFixed(6))
  const body = {
    schemaVersion: SHOT_DECISION_SCHEMA_VERSION,
    shotId,
    ordinal,
    sessionRange: range,
    chosen,
    audioTrackId: audio.trackId,
    alternatives: alternativesOf(run.decisions, run.trackId),
    rule: run.rule,
    reason: run.reason,
    evidenceRefs: shotEvidenceRefs(ctx, chosen),
    confidence,
    confidenceBand: directionConfidenceBand(confidence),
  }
  return Object.freeze({ shot: Object.freeze({ ...body, decisionHash: calculateShotDecisionHash(body) }), warnings: Object.freeze(dedupeWarnings(warnings)) })
}

function dedupeWarnings(warnings: readonly Readonly<DirectionWarning>[]): readonly Readonly<DirectionWarning>[] {
  const seen = new Set<string>()
  return warnings.filter((warning) => {
    const key = `${warning.code} ${warning.shotId ?? ''} ${warning.trackId ?? ''} ${warning.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function calculateShotDecisionHash(shot: Omit<ShotDecision, 'decisionHash'>): string {
  return calculateCanonicalHash({
    ...shot,
    sessionRange: serializeTickInterval(shot.sessionRange),
    chosen: { candidateHash: shot.chosen.candidateHash, trackId: shot.chosen.trackId, sourcePieceId: shot.chosen.sourcePieceId },
  })
}

/**
 * Rule 5: a cut from an angle to itself is a jump cut.
 *
 * Two consecutive runs on one track exist only when the map changed piece
 * between them — the recorder restarted, the source is discontinuous. The
 * discontinuity is covered with the best eligible other angle for
 * `jumpCutSameAngleTicks` (or the whole second run when it is short), and when
 * no other angle is eligible the jump stays and is reported. It is never cut
 * silently.
 */
function coverJumpCuts(ctx: DirectionContext, runs: Run[]): Readonly<{ runs: Run[]; warnings: readonly Readonly<Omit<DirectionWarning, 'shotId'> & { runIndex: number }>[] }> {
  const warnings: Array<Readonly<Omit<DirectionWarning, 'shotId'> & { runIndex: number }>> = []
  const output: Run[] = []
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!
    const previous = output[output.length - 1] ?? null
    if (!previous || previous.trackId !== run.trackId) {
      output.push(run)
      continue
    }
    const duration = run.end - run.start
    const coverEnd = duration <= ctx.resolved.jumpCutSameAngleTicks + ctx.resolved.minimumShotTicks
      ? run.end
      : run.start + ctx.resolved.jumpCutSameAngleTicks
    const coverRange = createTickInterval(run.start, coverEnd)
    const nextTrack = runs[index + 1]?.trackId ?? null
    const candidates = deriveCandidatesWith(ctx, coverRange, { trackId: previous.trackId, sessionRange: createTickInterval(previous.start, run.start) })
      .filter((candidate) => candidate.eligible && candidate.trackId !== run.trackId)
      .sort((left, right) => {
        const leftNext = left.trackId === nextTrack ? 1 : 0
        const rightNext = right.trackId === nextTrack ? 1 : 0
        return leftNext !== rightNext ? leftNext - rightNext : compareCandidates(ctx, left, right)
      })
    const cover = candidates[0] ?? null
    if (!cover) {
      warnings.push(Object.freeze({
        code: 'jump-cut-unavoidable' as const,
        trackId: run.trackId,
        detail: `${run.trackId} cuts to itself at ${run.start} (source piece ${previous.pieceId} → ${run.pieceId}) and no other angle is eligible to cover it`,
        runIndex: output.length,
      }))
      output.push(run)
      continue
    }
    const coverDecision: WindowDecision = Object.freeze({
      window: coverRange,
      candidates: deriveCandidatesWith(ctx, coverRange, { trackId: previous.trackId, sessionRange: createTickInterval(previous.start, run.start) }),
      chosen: cover,
      rule: 'jump-cut-avoided' as const,
      reason: `jump-cut-avoided: ${describe(cover)} covers the discontinuity of ${run.trackId} at ${run.start}`,
      confidence: Math.min(run.confidence, ctx.resolved.policy.conservativeHoldConfidence),
      warnings: Object.freeze([]),
    })
    output.push({
      trackId: cover.trackId,
      pieceId: cover.sourcePieceId!,
      start: coverRange.start,
      end: coverRange.end,
      rule: 'jump-cut-avoided',
      reason: coverDecision.reason,
      confidence: coverDecision.confidence,
      decisions: [coverDecision],
    })
    if (coverEnd < run.end) {
      output.push({ ...run, start: coverEnd, decisions: run.decisions.filter((decision) => decision.window.end > coverEnd) })
    }
  }
  return Object.freeze({ runs: output, warnings: Object.freeze(warnings) })
}

/**
 * Direct a session: derive candidates per window, decide, merge into shots.
 *
 * Determinism is total: same session, derivations, evidence, policy and
 * format → same shots and the same `directionHash`. Nothing reads a clock
 * except `generatedAt`, which is provenance and is excluded from no hash.
 */
export function directMulticam(input: DirectMulticamInput): Readonly<MulticamDirection> {
  const ctx = prepareContext(input)
  const range = input.range ? createTickInterval(input.range.start, input.range.end) : defaultRange(ctx)
  const warnings: Array<Readonly<DirectionWarning>> = []
  if (!ctx.sessionAutoEdit.allowed) {
    warnings.push(Object.freeze({
      code: 'session-not-auto-editable' as const,
      shotId: null,
      trackId: null,
      detail: `the session is not auto-editable (${ctx.sessionAutoEdit.blockedBy.join('; ')}); only tracks synchronized on their own were considered`,
    }))
  }
  if (ctx.unmappedSpeakerObservations.length > 0) {
    warnings.push(Object.freeze({
      code: 'active-speaker-unmapped' as const,
      shotId: null,
      trackId: null,
      detail: `${ctx.unmappedSpeakerObservations.length} active-speaker observation(s) sit on audio tracks bound to no camera and could not name an angle: ${ctx.unmappedSpeakerObservations.slice(0, 8).join(', ')}`,
    }))
  }

  const runs: Run[] = []
  const uncovered: Array<{ start: bigint; end: bigint }> = []
  let current: Run | null = null
  const queue = [...partitionWindows(ctx, range)]
  while (queue.length > 0) {
    const window = queue.shift()!
    const decision = decideWindow(ctx, window, current)
    // Rule 3: the cutaway cap is a boundary the evidence did not know about, and
    // it belongs to the run the DECISION starts, not to the run that preceded
    // it. Splitting before deciding capped a cutaway one window too late — a
    // ten-second reaction that began and ended inside a single evidence window
    // ran its full length. Split at the cap and decide the two halves
    // separately; the second half sees a reaction that has already held its
    // maximum and returns.
    if (decision.chosen && ctx.contextByTrack.get(decision.chosen.trackId) === 'reaction') {
      const continues = current !== null
        && current.trackId === decision.chosen.trackId
        && current.pieceId === decision.chosen.sourcePieceId
        && current.end === window.start
      const cap = (continues ? current!.start : window.start) + ctx.resolved.maxCutawayTicks
      if (cap > window.start && cap < window.end) {
        queue.unshift(createTickInterval(cap, window.end))
        queue.unshift(createTickInterval(window.start, cap))
        continue
      }
    }
    if (!decision.chosen) {
      const last = uncovered[uncovered.length - 1]
      if (last && last.end === window.start) last.end = window.end
      else uncovered.push({ start: window.start, end: window.end })
      for (const warning of decision.warnings) warnings.push(Object.freeze({ ...warning, shotId: null }))
      current = null
      continue
    }
    const chosen = decision.chosen
    if (current && current.trackId === chosen.trackId && current.pieceId === chosen.sourcePieceId && current.end === window.start) {
      current.end = window.end
      current.confidence = Math.min(current.confidence, decision.confidence)
      current.decisions.push(decision)
      continue
    }
    current = {
      trackId: chosen.trackId,
      pieceId: chosen.sourcePieceId!,
      start: window.start,
      end: window.end,
      rule: decision.rule,
      reason: decision.reason,
      confidence: decision.confidence,
      decisions: [decision],
    }
    runs.push(current)
  }

  const covered = coverJumpCuts(ctx, runs)
  const shots: Array<Readonly<ShotDecision>> = []
  covered.runs.forEach((run, ordinal) => {
    const sealed = sealShot(ctx, run, ordinal)
    shots.push(sealed.shot)
    warnings.push(...sealed.warnings)
    for (const warning of covered.warnings) {
      if (warning.runIndex === ordinal) {
        const { runIndex: _runIndex, ...rest } = warning
        warnings.push(Object.freeze({ ...rest, shotId: sealed.shot.shotId }))
      }
    }
  })

  const uniqueWarnings = dedupeWarnings(warnings)
  const body = {
    schemaVersion: MULTICAM_DIRECTION_SCHEMA_VERSION,
    workspaceId: ctx.session.workspaceId,
    sessionId: ctx.session.sessionId,
    sessionVersion: ctx.session.version,
    referenceEpoch: ctx.session.referenceEpoch,
    diagnosticVersion: ctx.diagnostic.version,
    diagnosticHash: ctx.diagnostic.diagnosticHash,
    evidenceHash: ctx.evidence.evidenceHash,
    range,
    format: Object.freeze({ aspectRatio: ctx.format.aspectRatio }),
    policy: ctx.resolved.policy,
    audio: Object.freeze({ trackId: ctx.audioTrackId, rejected: ctx.audioRejected }),
    shots: Object.freeze(shots),
    uncovered: Object.freeze(uncovered.map((entry) => createTickInterval(entry.start, entry.end))),
    warnings: Object.freeze(uniqueWarnings),
    manualReviewRequired: uniqueWarnings.length > 0
      || uncovered.length > 0
      || shots.some((shot) => shot.confidenceBand === 'low' || shot.confidenceBand === 'insufficient'),
    generatedAt: input.generatedAt,
  }
  assertDomain(
    Number.isFinite(Date.parse(body.generatedAt)) && new Date(body.generatedAt).toISOString() === body.generatedAt,
    'INVALID_ARGUMENT',
    'direction generatedAt must be a canonical ISO instant',
  )
  return Object.freeze({ ...body, directionHash: calculateMulticamDirectionHash(body) })
}

export function calculateMulticamDirectionHash(direction: Omit<MulticamDirection, 'directionHash'>): string {
  return calculateCanonicalHash({
    ...direction,
    range: serializeTickInterval(direction.range),
    shots: direction.shots.map((shot) => ({
      shotId: shot.shotId,
      ordinal: shot.ordinal,
      sessionRange: serializeTickInterval(shot.sessionRange),
      trackId: shot.chosen.trackId,
      sourcePieceId: shot.chosen.sourcePieceId,
      candidateHash: shot.chosen.candidateHash,
      audioTrackId: shot.audioTrackId,
      rule: shot.rule,
      confidence: shot.confidence,
      decisionHash: shot.decisionHash,
    })),
    uncovered: direction.uncovered.map(serializeTickInterval),
  })
}

/**
 * Fail-closed rehydration and structural check.
 *
 * Recomputes every hash (candidate → shot → direction) and proves the shots
 * are ordered, non-overlapping, inside the range, and that every chosen
 * candidate is marked eligible with no rejection. A stored direction that
 * fails any of these was written by something other than this module.
 */
export function assertMulticamDirectionIntegrity(direction: Readonly<MulticamDirection>): Readonly<MulticamDirection> {
  assertDomain(direction.schemaVersion === MULTICAM_DIRECTION_SCHEMA_VERSION, 'PERSISTENCE_CONFLICT', 'stored multicam direction schema is invalid')
  assertDomain(HASH.test(direction.directionHash), 'PERSISTENCE_CONFLICT', 'multicam direction hash is malformed')
  const { directionHash, ...body } = direction
  assertDomain(calculateMulticamDirectionHash(body) === directionHash, 'PERSISTENCE_CONFLICT', 'stored multicam direction hash does not match its body')
  let cursor: bigint | null = null
  direction.shots.forEach((shot, index) => {
    assertDomain(shot.ordinal === index, 'PERSISTENCE_CONFLICT', `shot ${shot.shotId} is out of order`)
    const { decisionHash, ...shotBody } = shot
    assertDomain(calculateShotDecisionHash(shotBody) === decisionHash, 'PERSISTENCE_CONFLICT', `shot ${shot.shotId} hash does not match its body`)
    const { candidateHash, ...candidateBody } = shot.chosen
    assertDomain(calculateAngleCandidateHash(candidateBody) === candidateHash, 'PERSISTENCE_CONFLICT', `shot ${shot.shotId} candidate hash does not match its body`)
    assertDomain(
      shot.chosen.eligible && shot.chosen.rejectionReasons.length === 0,
      'PERSISTENCE_CONFLICT',
      `shot ${shot.shotId} was cut to an ineligible candidate`,
    )
    assertDomain(
      shot.chosen.sessionRange.start === shot.sessionRange.start && shot.chosen.sessionRange.end === shot.sessionRange.end,
      'PERSISTENCE_CONFLICT',
      `shot ${shot.shotId} and its candidate disagree about the range`,
    )
    assertDomain(
      shot.sessionRange.start >= direction.range.start && shot.sessionRange.end <= direction.range.end,
      'PERSISTENCE_CONFLICT',
      `shot ${shot.shotId} lies outside the directed range`,
    )
    assertDomain(cursor === null || shot.sessionRange.start >= cursor, 'PERSISTENCE_CONFLICT', `shot ${shot.shotId} overlaps the shot before it`)
    cursor = shot.sessionRange.end
  })
  return direction
}

// ---------------------------------------------------------------------------
// Decision bridge and compilation
// ---------------------------------------------------------------------------

/**
 * The shape `DirectorDecisionInput` (`director-run.ts:102`) takes, with the
 * `'angle'` category the integration phase adds to `DirectorDecisionCategory`.
 * Defined here so the mapping is one spread away and never re-derived.
 */
export interface AngleDecision {
  readonly id: string
  readonly category: 'angle'
  readonly choice: string
  readonly reason: string
  readonly evidenceRefs: readonly string[]
  readonly confidence: number
  readonly alternatives: readonly string[]
}

export function toAngleDecision(shot: Readonly<ShotDecision>): Readonly<AngleDecision> {
  return Object.freeze({
    id: `decision-angle-${shot.shotId}`,
    category: 'angle' as const,
    choice: shot.chosen.trackId,
    reason: shot.reason,
    evidenceRefs: shot.evidenceRefs,
    confidence: shot.confidence,
    alternatives: Object.freeze(shot.alternatives.map((alternative) => `${alternative.trackId}: ${alternative.rejectedBecause}`)),
  })
}

export interface CompiledShotClip {
  readonly shotId: string
  readonly trackId: string
  readonly cameraId: string
  readonly partId: string
  /** The part's asset — the file the frames are counted in. */
  readonly sourceAssetId: string
  readonly sourceInFrame: number
  readonly sourceOutFrame: number
  /**
   * The frame rate `sourceInFrame`/`sourceOutFrame` are counted in.
   *
   * The renderer trims the SOURCE stream (`trim=start_frame=…`,
   * `ffmpeg-editorial-proxy-renderer.ts:752`) before resampling to the output
   * fps, so these indexes belong to the source's own cadence, which the plan
   * fps only happens to equal. Carried per clip so the integration can see
   * which rate produced the number instead of assuming the plan's.
   */
  readonly sourceFrameRate: Rational
  readonly timelineInFrame: number
  readonly timelineOutFrame: number
  readonly rate: 1
  readonly audioTrackId: string | null
  readonly audioSourceAssetId?: string
  /** Audio frames are plan-fps frames: the renderer divides them by `input.fps` (`:737-738`). */
  readonly audioSourceInFrame?: number
  readonly audioSourceOutFrame?: number
  readonly sessionRange: Readonly<TickInterval>
}

export interface CompiledShotSource {
  readonly sourceAssetId: string
  readonly trackId: string
  readonly partId: string
  readonly cameraId: string
  readonly kind: 'video' | 'audio'
  readonly frameRate: Rational
  readonly durationFrames: number
}

export interface MulticamShotCompilation {
  readonly schemaVersion: typeof MULTICAM_SHOT_COMPILATION_SCHEMA_VERSION
  readonly sessionId: string
  readonly sessionVersion: number
  readonly referenceEpoch: number
  readonly directionHash: string
  readonly planFps: Rational
  readonly durationFrames: number
  readonly clips: readonly Readonly<CompiledShotClip>[]
  readonly sources: readonly Readonly<CompiledShotSource>[]
  readonly compilationHash: string
}

export interface CompileShotsInput {
  session: Readonly<CaptureSession>
  clockMaps: readonly Readonly<PiecewiseClockMap>[]
  planFps: Rational
  /** When given, every shot is re-gated through `assertCoverageSelectable` before it becomes frames. */
  coverages?: readonly Readonly<TrackCoverage>[]
  /**
   * The probed frame rate of each track's media, as the artifact probe reported
   * it. A `CaptureTrack` carries the media *timebase* (seconds per tick), which
   * is not a frame rate: 1/90000 says nothing about cadence. So the rate arrives
   * from the probe, per track, and a track without one falls back to `planFps` —
   * recorded on every clip as `sourceFrameRate` so the assumption is visible
   * rather than implied.
   */
  sourceFrameRates?: readonly Readonly<{ trackId: string; frameRate: Rational }>[]
}

function unresolvable(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError('DIRECTION_RANGE_UNRESOLVABLE', message, details)
}

/** `1/fps` seconds per frame, exactly. */
function frameTimebase(planFps: Rational): Readonly<Timebase> {
  assertDomain(planFps.num > BigInt(0) && planFps.den > BigInt(0), 'INVALID_ARGUMENT', 'planFps must be a positive rational')
  return createTimebase(divideRational(rational(BigInt(1)), planFps))
}

function toFrames(tick: bigint, from: Readonly<Timebase>, frames: Readonly<Timebase>): number {
  const converted = convertTick({ tick, from, to: frames })
  assertDomain(converted <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_ARGUMENT', 'frame index overflows a safe integer')
  return Number(converted)
}

/**
 * Shots → part-relative source frames and a contiguous timeline.
 *
 * Session ticks become source ticks through the piecewise map (`uncovered` is
 * a refusal, never an approximation), source ticks become frames through
 * `convertTick` with the part's own timebase, rounded half-to-even exactly
 * once, and counted from the part's first tick because `trim=start_frame`
 * counts frames of the file (`ffmpeg-editorial-proxy-renderer.ts:752`).
 * The audio bed is cut in plan-fps frames — the renderer divides audio frames
 * by the plan fps (`:737-738`) — and its span is set equal to the video span
 * because the renderer refuses any other (`:578`). The timeline is the running
 * sum of source spans, so it is contiguous by construction.
 */
export function compileShotsToSourceRanges(direction: Readonly<MulticamDirection>, input: CompileShotsInput): Readonly<MulticamShotCompilation> {
  assertMulticamDirectionIntegrity(direction)
  const session = input.session
  assertDomain(
    direction.sessionId === session.sessionId && direction.sessionVersion === session.version && direction.referenceEpoch === session.referenceEpoch,
    'CAPTURE_SESSION_DERIVATION_STALE',
    `direction describes session version ${direction.sessionVersion} (reference epoch ${direction.referenceEpoch}), not version ${session.version} (reference epoch ${session.referenceEpoch})`,
  )
  if (direction.uncovered.length > 0) {
    throw unresolvable(
      `direction leaves ${direction.uncovered.length} session range(s) with no eligible angle and cannot be compiled`,
      { sessionId: session.sessionId, uncovered: direction.uncovered.map(serializeTickInterval) },
    )
  }
  const ref = captureSessionDerivationRef(session)
  const coverageByTrack = new Map<string, Readonly<TrackCoverage>>()
  for (const coverage of input.coverages ?? []) {
    assertCoverageDerivedFrom(coverage, ref)
    coverageByTrack.set(coverage.trackId, coverage)
  }
  const mapBySource = new Map<string, Readonly<PiecewiseClockMap>>()
  for (const map of input.clockMaps) {
    assertDomain(
      map.sessionId === session.sessionId && map.derivedFrom.sessionVersion === session.version && map.derivedFrom.referenceEpoch === session.referenceEpoch,
      'CAPTURE_SESSION_DERIVATION_STALE',
      `clock map for ${map.sourceId} was derived under session version ${map.derivedFrom.sessionVersion}`,
    )
    mapBySource.set(map.sourceId, map)
  }
  // The compile step never re-decides, so it holds only what resolving a window
  // needs: the session and the maps. The policy is still validated, because a
  // stored direction naming a policy this build cannot express is not compilable.
  resolveDirectionPolicy(direction.policy, session.clock.timebase)
  const resolver: SourceWindowResolver = { session, mapBySource }
  const cameraIds = colorCameraIdsForSession(session)
  const frameRateByTrack = new Map<string, Rational>()
  for (const entry of input.sourceFrameRates ?? []) {
    assertDomain(
      entry.frameRate.num > BigInt(0) && entry.frameRate.den > BigInt(0),
      'INVALID_ARGUMENT',
      `source frame rate for ${entry.trackId} must be a positive rational`,
    )
    assertDomain(!frameRateByTrack.has(entry.trackId), 'INVALID_ARGUMENT', `two source frame rates describe track ${entry.trackId}`)
    frameRateByTrack.set(entry.trackId, entry.frameRate)
  }
  const planFrames = frameTimebase(input.planFps)
  const framesFor = (trackId: string) => {
    const rate = frameRateByTrack.get(trackId) ?? input.planFps
    return { rate, timebase: rationalEquals(rate, input.planFps) ? planFrames : frameTimebase(rate) }
  }
  const clips: Array<Readonly<CompiledShotClip>> = []
  const sources = new Map<string, Readonly<CompiledShotSource>>()
  let timeline = 0

  const resolveOrRefuse = (shot: Readonly<ShotDecision>, trackId: string, role: 'video' | 'audio') => {
    const track = session.tracks.find((entry) => entry.trackId === trackId)
    assertDomain(track !== undefined, 'CAPTURE_TRACK_NOT_FOUND', `shot ${shot.shotId} names ${trackId}, which is not in session ${session.sessionId}`)
    const resolution = resolveTrackWindow(resolver, track!, shot.sessionRange)
    if (resolution.status !== 'resolved') {
      throw unresolvable(
        `shot ${shot.shotId} ${role} track ${trackId} has no source law for ${ticksToString(shot.sessionRange)}: ${resolution.status === 'uncovered' ? resolution.reason : 'no clock map'}`,
        { shotId: shot.shotId, trackId, role, sessionRange: serializeTickInterval(shot.sessionRange), cause: resolution.status === 'uncovered' ? resolution.reason : 'map-missing' },
      )
    }
    const coverage = coverageByTrack.get(trackId) ?? null
    if (coverage) {
      try {
        assertCoverageSelectable(coverage, { interval: toCoverageTicks(resolution.sourceRange, track!.timebase, coverage.timebase), purpose: 'auto-edit' })
      } catch (error) {
        throw unresolvable(
          `shot ${shot.shotId} ${role} track ${trackId} is not selectable over ${ticksToString(shot.sessionRange)}: ${coverageRejection(error)}`,
          { shotId: shot.shotId, trackId, role, sessionRange: serializeTickInterval(shot.sessionRange), cause: coverageRejection(error) },
        )
      }
    }
    return { track: track!, resolution }
  }

  for (const shot of direction.shots) {
    const video = resolveOrRefuse(shot, shot.chosen.trackId, 'video')
    const part = video.resolution.part
    const source = framesFor(video.track.trackId)
    const sourceInFrame = toFrames(video.resolution.sourceRange.start - part.coverage.start, part.timebase, source.timebase)
    const sourceOutFrame = toFrames(video.resolution.sourceRange.end - part.coverage.start, part.timebase, source.timebase)
    if (sourceOutFrame <= sourceInFrame) {
      throw unresolvable(`shot ${shot.shotId} is shorter than one frame at ${serializeRational(source.rate)} fps`, { shotId: shot.shotId, trackId: shot.chosen.trackId, cause: 'shorter-than-frame' })
    }
    // The timeline runs at the plan's fps, so its span is measured there — a
    // 60 fps source contributes half as many timeline frames as source frames,
    // and using the source span would stretch the cut. It is measured on the
    // SOURCE duration rather than the session range because that is the
    // material the renderer will resample; a drifting clock makes the two
    // differ, and the plan must claim the length that will actually exist.
    const timelineSpan = toFrames(intervalDuration(video.resolution.sourceRange), part.timebase, planFrames)
    if (timelineSpan <= 0) {
      throw unresolvable(`shot ${shot.shotId} is shorter than one frame at ${serializeRational(input.planFps)} fps`, { shotId: shot.shotId, trackId: shot.chosen.trackId, cause: 'shorter-than-frame' })
    }
    const cameraId = cameraIds.get(video.track.trackId)!
    sources.set(part.sourceAssetId, Object.freeze({
      sourceAssetId: part.sourceAssetId,
      trackId: video.track.trackId,
      partId: part.partId,
      cameraId,
      kind: 'video' as const,
      frameRate: source.rate,
      durationFrames: toFrames(intervalDuration(part.coverage), part.timebase, source.timebase),
    }))
    let audio: Pick<CompiledShotClip, 'audioSourceAssetId' | 'audioSourceInFrame' | 'audioSourceOutFrame'> = {}
    if (shot.audioTrackId !== null) {
      const bed = resolveOrRefuse(shot, shot.audioTrackId, 'audio')
      const audioPart = bed.resolution.part
      const audioSourceInFrame = toFrames(bed.resolution.sourceRange.start - audioPart.coverage.start, audioPart.timebase, planFrames)
      audio = {
        audioSourceAssetId: audioPart.sourceAssetId,
        audioSourceInFrame,
        audioSourceOutFrame: audioSourceInFrame + timelineSpan,
      }
      if (!sources.has(audioPart.sourceAssetId)) {
        sources.set(audioPart.sourceAssetId, Object.freeze({
          sourceAssetId: audioPart.sourceAssetId,
          trackId: bed.track.trackId,
          partId: audioPart.partId,
          cameraId: cameraIds.get(bed.track.trackId)!,
          kind: 'audio' as const,
          frameRate: input.planFps,
          durationFrames: toFrames(intervalDuration(audioPart.coverage), audioPart.timebase, planFrames),
        }))
      }
    }
    clips.push(Object.freeze({
      shotId: shot.shotId,
      trackId: video.track.trackId,
      cameraId,
      partId: part.partId,
      sourceAssetId: part.sourceAssetId,
      sourceInFrame,
      sourceOutFrame,
      sourceFrameRate: source.rate,
      timelineInFrame: timeline,
      timelineOutFrame: timeline + timelineSpan,
      rate: 1 as const,
      audioTrackId: shot.audioTrackId,
      ...audio,
      sessionRange: shot.sessionRange,
    }))
    timeline += timelineSpan
  }

  const body = {
    schemaVersion: MULTICAM_SHOT_COMPILATION_SCHEMA_VERSION,
    sessionId: session.sessionId,
    sessionVersion: session.version,
    referenceEpoch: session.referenceEpoch,
    directionHash: direction.directionHash,
    planFps: input.planFps,
    durationFrames: timeline,
    clips: Object.freeze(clips),
    sources: Object.freeze([...sources.values()].sort((left, right) => left.sourceAssetId.localeCompare(right.sourceAssetId))),
  }
  return Object.freeze({
    ...body,
    compilationHash: calculateCanonicalHash({
      ...body,
      planFps: serializeRational(body.planFps),
      clips: body.clips.map((clip) => ({
        ...clip,
        sessionRange: serializeTickInterval(clip.sessionRange),
        sourceFrameRate: serializeRational(clip.sourceFrameRate),
      })),
      sources: body.sources.map((source) => ({ ...source, frameRate: serializeRational(source.frameRate) })),
    }),
  })
}
