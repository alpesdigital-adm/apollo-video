import { calculateCanonicalHash } from './canonical-hash.ts'
import type { CaptureSession, CaptureTrack } from './capture-session.ts'
import { assertDomain } from './errors.ts'
import { PIECE_BOUNDARY_CAUSES } from './piecewise-clock-map.ts'
import {
  canonicalizeIntervals,
  convertTick,
  createTickInterval,
  createTimebase,
  intervalContains,
  intervalContainsInterval,
  intervalDuration,
  rational,
  serializeRational,
  serializeTickInterval,
  type Rational,
  type TickInterval,
  type Timebase,
} from './session-time.ts'
import { ANCHOR_ORIGINS, type AnchorOrigin } from './sync-diagnostic.ts'
import { DEFAULT_SYNC_EVIDENCE_THRESHOLDS } from './sync-evidence.ts'

/**
 * F4.015 — the react playback map (spec 05 §16, ADR-135, ADR-152).
 *
 * A react recording is not a second camera pointed at the same event. It is a
 * person watching a *reference* video, and the only thing that ties the two
 * timelines together is what the reference was doing at each instant of the
 * reaction: playing, paused, rewound, replayed, seeked, or absent while the
 * reactor talks. This module maps **reaction time → reference time**, piecewise.
 *
 * ## Why this is its own aggregate and not a `PiecewiseClockMap`
 *
 * The temporal kernel is authority and it refuses, by design, exactly the two
 * things a react session is made of:
 *
 * - `createAffineClockMap` refuses a rate of zero or less
 *   (`session-time.ts:263-278`). A pause is a stretch of reaction time during
 *   which the reference produces no time at all. There is no affine law for it.
 * - `createPiecewiseClockMap` refuses overlapping *source* coverage
 *   (`piecewise-clock-map.ts:213-223`). A replay plays the same reference ticks
 *   twice, so a reference → session map cannot express it: two pieces would
 *   claim the same source range and the constructor would (correctly) refuse
 *   the pair.
 *
 * Both refusals are right. Inverting the direction — reaction → reference —
 * makes both expressible without weakening anything: reaction ranges never
 * overlap (the reactor lived through each instant once), while reference ranges
 * may repeat, run backwards, or be absent.
 *
 * What is reused rather than reinvented: `TickInterval`, `Rational` and the
 * single rounding of `convertTick` from `session-time.ts`; the boundary
 * vocabulary of `PIECE_BOUNDARY_CAUSES`; the "no number at all" shape of
 * `PiecewiseResolution`; the `DiagnosticAnchor` shape and `ANCHOR_ORIGINS` from
 * `sync-diagnostic.ts`; the admission thresholds of
 * `DEFAULT_SYNC_EVIDENCE_THRESHOLDS`.
 *
 * ## The rule this file exists to enforce
 *
 * **The duration of the reaction never implies the duration of the reference**
 * (ADR-135). A sixty-minute reaction to a thirty-minute video is the normal
 * case, not an anomaly, and any code that reads one duration off the other is
 * wrong before it runs. Nothing here derives a reference bound from a reaction
 * bound; the reference duration arrives measured, on `referenceMedia`.
 */

export const PLAYBACK_MAP_SCHEMA_VERSION = 'react-playback-map/v1' as const

/**
 * The six things the reference can be doing during a stretch of the reaction
 * (spec 05 §16). ADR-135 names four in prose; the sixth vocabulary is the one
 * the spec's type carries, and `replay` and `commentary-only` are exactly the
 * two cases a four-value vocabulary has to lie about.
 */
export const PLAYBACK_MODES = Object.freeze([
  'playing',
  'paused',
  'rewind',
  'replay',
  'seek',
  'commentary-only',
] as const)
export type PlaybackMode = (typeof PLAYBACK_MODES)[number]

/** Modes during which the reference produces no time at all. */
export const NO_REFERENCE_PLAYBACK_MODES: ReadonlySet<PlaybackMode> = new Set<PlaybackMode>([
  'paused',
  'commentary-only',
])

/**
 * How a piece's reference start relates to the previous piece's reference end.
 *
 * It describes the *boundary*, not the interior: a rewind piece runs forward
 * inside itself, and what makes it a rewind is that it started behind where the
 * previous piece stopped.
 */
export const PLAYBACK_DIRECTIONS = Object.freeze(['forward', 'backward', 'none'] as const)
export type PlaybackDirection = (typeof PLAYBACK_DIRECTIONS)[number]

/**
 * How a piece was observed. Only `audio-fingerprint` measures a rate today;
 * the other three are named because the aggregate must be able to record a
 * piece that came from a person or from the player's own UI without pretending
 * a correlator produced it.
 */
export const PLAYBACK_DETECTION_METHODS = Object.freeze([
  'audio-fingerprint',
  'player-visual',
  'ocr-timestamp',
  'manual-anchor',
] as const)
export type PlaybackDetectionMethod = (typeof PLAYBACK_DETECTION_METHODS)[number]

/**
 * Why a piece begins where it does.
 *
 * The clock-map causes are spread in rather than retyped, so `'seek'`,
 * `'rewind'` and `'pts-regression'` mean here exactly what they mean in
 * `piecewise-clock-map.ts`. The three additions are things that only happen to
 * a *player*: it was paused, the reactor talked over it, or a person placed an
 * anchor where no signal existed.
 */
export const PLAYBACK_DISCONTINUITY_REASONS = Object.freeze([
  ...PIECE_BOUNDARY_CAUSES,
  'pause',
  'commentary',
  'manual-anchor',
] as const)
export type PlaybackDiscontinuityReason = (typeof PLAYBACK_DISCONTINUITY_REASONS)[number]

/**
 * Why a stretch of the reaction carries no piece.
 *
 * `manual-anchor-required` is the ADR-135 case: the player was hidden, the
 * reference moved while nobody could see it, and "played through", "paused then
 * seeked" and "scrubbed" all fit the evidence equally well. Choosing one would
 * be inventing a measurement.
 */
export const PLAYBACK_UNCOVERED_REASONS = Object.freeze([
  'manual-anchor-required',
  'conflicting-evidence',
] as const)
export type PlaybackUncoveredReason = (typeof PLAYBACK_UNCOVERED_REASONS)[number]

export const PLAYBACK_MAP_WARNINGS = Object.freeze([
  'manual-anchor-required',
  'conflicting-evidence',
  'rate-unmeasured',
  'reference-exhausted',
  'no-reference-detected',
] as const)
export type PlaybackMapWarning = (typeof PLAYBACK_MAP_WARNINGS)[number]

export const PLAYBACK_MAP_STATUSES = Object.freeze(['resolved', 'needs-input', 'failed'] as const)
export type PlaybackMapStatus = (typeof PLAYBACK_MAP_STATUSES)[number]

/** The reference recording's identity. Different bytes are a different map. */
export interface PlaybackReferenceMedia {
  readonly assetId: string
  readonly sha256: string
  /** Measured, in `timebase` ticks. Never derived from the reaction. */
  readonly durationTicks: bigint
  readonly timebase: Readonly<Timebase>
}

/**
 * The reaction recording's identity.
 *
 * Reaction ticks are session ticks: the reaction track *is* the session's own
 * timeline in a react protocol, so this duration is counted in the session
 * clock's timebase and needs no second one.
 */
export interface PlaybackReactionMedia {
  readonly assetId: string
  readonly sha256: string
  readonly durationTicks: bigint
}

export interface PlaybackPiece {
  readonly pieceId: string
  /** Position in the sequence, 0-based, contiguous and gap-free. */
  readonly ordinal: number
  readonly mode: PlaybackMode
  /** Half-open, in reaction (session) ticks. Pieces never overlap. */
  readonly reactionRange: Readonly<TickInterval>
  /**
   * Half-open, in reference ticks. Null is mandatory for `paused` and
   * `commentary-only`: the reference produced no time, and an interval saying
   * it produced some would be a claim nobody measured.
   */
  readonly referenceRange: Readonly<TickInterval> | null
  /**
   * Reference ticks per reaction tick, **only when measured**.
   *
   * Null means nobody measured it. It is never `1/1` by assumption: a rate of
   * one is a measurement like any other, and writing it where none was taken is
   * how an unverified map becomes indistinguishable from a verified one.
   */
  readonly rate: Rational | null
  readonly direction: PlaybackDirection
  readonly confidence: number
  readonly evidenceRefs: readonly string[]
  readonly detectionMethod: PlaybackDetectionMethod
  /**
   * Worst disagreement, in reference ticks, between the observations inside this
   * piece and the straight line the piece asserts. Null when there was nothing
   * to disagree with (fewer than three observations, or no rate).
   */
  readonly residualTicks: bigint | null
  readonly discontinuityReason: PlaybackDiscontinuityReason | null
  readonly pieceHash: string
}

/** A stretch of the reaction that no piece describes, and why. */
export interface PlaybackUncoveredRange {
  readonly range: Readonly<TickInterval>
  readonly reason: PlaybackUncoveredReason
}

/**
 * A manual or automatic tie between one reaction instant and one reference
 * instant. Shaped after `DiagnosticAnchor` (`sync-diagnostic.ts:65-79`) with
 * ticks instead of milliseconds, because everything in this aggregate is ticks.
 */
export interface PlaybackAnchor {
  readonly anchorId: string
  readonly origin: AnchorOrigin
  readonly reactionTick: bigint
  /** Null asserts "there was no reference here", which is itself an answer. */
  readonly referenceTick: bigint | null
  readonly mode: PlaybackMode | null
  readonly method: PlaybackDetectionMethod
  readonly confidence: number
  readonly evidenceRef: string
  readonly createdAt: string
}

export interface PlaybackMap {
  readonly schemaVersion: typeof PLAYBACK_MAP_SCHEMA_VERSION
  readonly mapId: string
  readonly workspaceId: string
  readonly sessionId: string
  /** The exact session version and reference epoch this was derived under. */
  readonly sessionVersion: number
  readonly referenceEpoch: number
  readonly reactionTrackId: string
  readonly referenceTrackId: string
  readonly referenceMedia: Readonly<PlaybackReferenceMedia>
  readonly reactionMedia: Readonly<PlaybackReactionMedia>
  /** 1-based. Every anchor produces the next one. */
  readonly version: number
  readonly previousVersionHash: string | null
  /**
   * The map this one replaces because the reference *media* changed. Different
   * reference bytes mean every reference tick means something else, so the old
   * map is not amended: it is superseded, and everything derived from it stale.
   */
  readonly supersedesMapId: string | null
  readonly pieces: readonly Readonly<PlaybackPiece>[]
  readonly uncovered: readonly Readonly<PlaybackUncoveredRange>[]
  readonly anchors: readonly Readonly<PlaybackAnchor>[]
  readonly status: PlaybackMapStatus
  readonly warnings: readonly PlaybackMapWarning[]
  readonly mapHash: string
}

export type PlaybackResolution =
  | Readonly<{
    status: 'resolved'
    referenceTick: bigint
    pieceId: string
    mode: PlaybackMode
    confidence: number
    /** True when the piece carries no measured rate and 1/1 was assumed *here*. */
    rateAssumed: boolean
  }>
  | Readonly<{ status: 'no-reference'; mode: 'paused' | 'commentary-only'; pieceId: string }>
  | Readonly<{
    status: 'uncovered'
    reason: PlaybackUncoveredReason | 'before-first-piece' | 'after-last-piece'
  }>

/** One window of the reaction, as the detector saw it. Never a decision. */
export interface PlaybackObservation {
  readonly reactionTick: bigint
  /** Null when nothing correlated: silence, commentary, or a hidden player. */
  readonly referenceTick: bigint | null
  readonly confidence: number
  readonly method: PlaybackDetectionMethod
  readonly evidenceRef: string
  /** Peak over runner-up. Absent means not measured, never 1. */
  readonly peakRatio?: number
}

/**
 * The calibrated numbers the classifier uses. Named and versioned so a map can
 * say which calibration produced it, the way ADR-111 requires of every
 * confidence-to-action band.
 */
export interface PlaybackPolicy {
  readonly calibrationVersion: string
  /** How much reaction time one observation speaks for. */
  readonly windowTicks: bigint
  /** A no-reference stretch longer than this is commentary, not a pause. */
  readonly maxPauseTicks: bigint
  /** Reference advance beyond the reaction advance by more than this is a seek. */
  readonly seekThresholdTicks: bigint
  /** Reference disagreement below this is measurement noise, not a jump. */
  readonly continuityToleranceTicks: bigint
  readonly minimumPeakRatioForAdmission: number
  readonly minimumConfidenceForAdmission: number
  /** A slope needs at least this many windows. Two points, one line. */
  readonly minimumWindowsForRate: number
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const SHA256 = /^[0-9a-f]{64}$/

function assertId(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is not a canonical identifier`)
  return value
}

function assertUnitInterval(value: number, field: string): number {
  assertDomain(
    Number.isFinite(value) && value >= 0 && value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be a confidence in [0, 1]`,
  )
  return value
}

const UNIT_TIMEBASE = createTimebase(rational(BigInt(1), BigInt(1)))

/**
 * `round(delta * rate)`, half-even, once.
 *
 * Deliberately routed through `convertTick` (`session-time.ts:238-247`) rather
 * than through a second copy of the same arithmetic: a timebase of `rate`
 * seconds per tick converted into a timebase of one second per tick applies
 * exactly `rate` and rounds exactly once, with the project's single rounding
 * policy. A local re-implementation would be a second definition of "the same"
 * rounding, and the two would drift.
 */
function scaleTicks(delta: bigint, rate: Rational): bigint {
  return convertTick({ tick: delta, from: createTimebase(rate), to: UNIT_TIMEBASE })
}

function absTicks(value: bigint): bigint {
  return value < BigInt(0) ? -value : value
}

/**
 * A policy in the reaction's own ticks.
 *
 * The thresholds arrive in milliseconds because that is how spec 05 states them
 * (§16 seek classification at 1200 ms) and are converted once, here, against
 * the session timebase — so nothing downstream ever compares a tick to a
 * millisecond.
 */
export function createPlaybackPolicy(input: {
  calibrationVersion: string
  reactionTimebase: Readonly<Timebase>
  windowMs: number
  maxPauseMs: number
  seekThresholdMs: number
  continuityToleranceMs: number
  minimumPeakRatioForAdmission?: number
  minimumConfidenceForAdmission?: number
  minimumWindowsForRate?: number
}): Readonly<PlaybackPolicy> {
  const millisecond = createTimebase(rational(BigInt(1), BigInt(1000)))
  const toTicks = (value: number, field: string): bigint => {
    assertDomain(
      Number.isSafeInteger(value) && value > 0,
      'INVALID_ARGUMENT',
      `${field} must be a positive whole number of milliseconds`,
    )
    return convertTick({ tick: BigInt(value), from: millisecond, to: input.reactionTimebase })
  }
  assertDomain(
    input.calibrationVersion.trim().length >= 3,
    'INVALID_ARGUMENT',
    'a playback policy must name the calibration that produced its thresholds',
  )
  const windows = input.minimumWindowsForRate ?? DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumAgreeingWindowsForAutoApply
  assertDomain(
    Number.isSafeInteger(windows) && windows >= 2,
    'INVALID_ARGUMENT',
    'a slope needs at least two windows; one window fixes an offset and says nothing about rate',
  )
  return Object.freeze({
    calibrationVersion: input.calibrationVersion,
    windowTicks: toTicks(input.windowMs, 'window'),
    maxPauseTicks: toTicks(input.maxPauseMs, 'maximum pause'),
    seekThresholdTicks: toTicks(input.seekThresholdMs, 'seek threshold'),
    continuityToleranceTicks: toTicks(input.continuityToleranceMs, 'continuity tolerance'),
    // Imported, not retyped: the admission floor is the sync cascade's, and a
    // second number here would let a signal be inadmissible in one subsystem
    // and admissible in the other.
    minimumPeakRatioForAdmission:
      input.minimumPeakRatioForAdmission ?? DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumPeakRatioForAdmission,
    minimumConfidenceForAdmission:
      input.minimumConfidenceForAdmission ?? DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumConfidenceForAdmission,
    minimumWindowsForRate: windows,
  })
}

/** Spec 05 §16 defaults: 1 s windows, 10 s pause ceiling, 1.2 s seek threshold. */
export function defaultPlaybackPolicy(reactionTimebase: Readonly<Timebase>): Readonly<PlaybackPolicy> {
  return createPlaybackPolicy({
    calibrationVersion: 'react-playback/2026-09-04',
    reactionTimebase,
    windowMs: 1_000,
    maxPauseMs: 10_000,
    seekThresholdMs: 1_200,
    continuityToleranceMs: 400,
  })
}

export function calculatePlaybackPieceHash(piece: Omit<PlaybackPiece, 'pieceHash'>): string {
  // Ticks become decimal text and rates become `num/den` before hashing: the
  // canonical hasher refuses `bigint` outright, which is the reason a Wave 19
  // aggregate with coverage holes could not be stored at all until the codec
  // existed.
  return calculateCanonicalHash({
    pieceId: piece.pieceId,
    ordinal: piece.ordinal,
    mode: piece.mode,
    reactionRange: serializeTickInterval(piece.reactionRange),
    referenceRange: piece.referenceRange ? serializeTickInterval(piece.referenceRange) : null,
    rate: piece.rate ? serializeRational(piece.rate) : null,
    direction: piece.direction,
    confidence: piece.confidence,
    evidenceRefs: [...piece.evidenceRefs],
    detectionMethod: piece.detectionMethod,
    residualTicks: piece.residualTicks === null ? null : piece.residualTicks.toString(),
    discontinuityReason: piece.discontinuityReason,
  })
}

export function calculatePlaybackMapHash(map: Omit<PlaybackMap, 'mapHash'>): string {
  return calculateCanonicalHash({
    schemaVersion: map.schemaVersion,
    mapId: map.mapId,
    workspaceId: map.workspaceId,
    sessionId: map.sessionId,
    sessionVersion: map.sessionVersion,
    referenceEpoch: map.referenceEpoch,
    reactionTrackId: map.reactionTrackId,
    referenceTrackId: map.referenceTrackId,
    referenceMedia: {
      assetId: map.referenceMedia.assetId,
      sha256: map.referenceMedia.sha256,
      durationTicks: map.referenceMedia.durationTicks.toString(),
      secondsPerTick: serializeRational(map.referenceMedia.timebase.secondsPerTick),
    },
    reactionMedia: {
      assetId: map.reactionMedia.assetId,
      sha256: map.reactionMedia.sha256,
      durationTicks: map.reactionMedia.durationTicks.toString(),
    },
    version: map.version,
    previousVersionHash: map.previousVersionHash,
    supersedesMapId: map.supersedesMapId,
    pieces: map.pieces.map((piece) => piece.pieceHash),
    uncovered: map.uncovered.map((entry) => ({
      range: serializeTickInterval(entry.range),
      reason: entry.reason,
    })),
    anchors: map.anchors.map((anchor) => ({
      anchorId: anchor.anchorId,
      origin: anchor.origin,
      reactionTick: anchor.reactionTick.toString(),
      referenceTick: anchor.referenceTick === null ? null : anchor.referenceTick.toString(),
      mode: anchor.mode,
      method: anchor.method,
      confidence: anchor.confidence,
      evidenceRef: anchor.evidenceRef,
      createdAt: anchor.createdAt,
    })),
    status: map.status,
    warnings: [...map.warnings],
  })
}

export interface PlaybackPieceInput {
  readonly pieceId: string
  readonly mode: PlaybackMode
  readonly reactionRange: Readonly<TickInterval>
  readonly referenceRange?: Readonly<TickInterval> | null
  readonly rate?: Rational | null
  readonly direction: PlaybackDirection
  readonly confidence: number
  readonly evidenceRefs: readonly string[]
  readonly detectionMethod: PlaybackDetectionMethod
  readonly residualTicks?: bigint | null
  readonly discontinuityReason?: PlaybackDiscontinuityReason | null
}

export interface CreatePlaybackMapInput {
  readonly mapId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly sessionVersion: number
  readonly referenceEpoch: number
  readonly reactionTrackId: string
  readonly referenceTrackId: string
  readonly referenceMedia: Readonly<PlaybackReferenceMedia>
  readonly reactionMedia: Readonly<PlaybackReactionMedia>
  readonly version?: number
  readonly previousVersionHash?: string | null
  readonly supersedesMapId?: string | null
  readonly pieces: readonly PlaybackPieceInput[]
  readonly uncovered?: readonly Readonly<PlaybackUncoveredRange>[]
  readonly anchors?: readonly Readonly<PlaybackAnchor>[]
}

/**
 * Assemble a map, proving every invariant before it can exist.
 *
 * This is the function that refuses the naive map: a single `playing` piece
 * covering a sixty-second reaction with a sixty-second reference range is
 * rejected because the reference is thirty seconds long and says so.
 */
export function createPlaybackMap(input: CreatePlaybackMapInput): Readonly<PlaybackMap> {
  assertId(input.mapId, 'playback map mapId')
  assertId(input.workspaceId, 'playback map workspaceId')
  assertId(input.sessionId, 'playback map sessionId')
  assertId(input.reactionTrackId, 'playback map reactionTrackId')
  assertId(input.referenceTrackId, 'playback map referenceTrackId')
  assertDomain(
    input.reactionTrackId !== input.referenceTrackId,
    'INVALID_ARGUMENT',
    'the reaction and the reference cannot be the same track',
  )
  // Two tracks can still name one file. If they do, `compilePlaybackToShots`
  // emits shots whose `sourceAssetId` and `audioSourceAssetId` are the same
  // bytes for every mode, and the reference/reaction distinction this aggregate
  // exists to keep is erased without anything refusing.
  assertDomain(
    input.referenceMedia.assetId !== input.reactionMedia.assetId &&
      input.referenceMedia.sha256 !== input.reactionMedia.sha256,
    'INVALID_ARGUMENT',
    'the reference and the reaction cannot be the same recording',
    { assetId: input.referenceMedia.assetId },
  )
  assertDomain(
    Number.isSafeInteger(input.sessionVersion) && input.sessionVersion >= 1 &&
      Number.isSafeInteger(input.referenceEpoch) && input.referenceEpoch >= 1,
    'INVALID_ARGUMENT',
    'a playback map must name the session version and reference epoch it was derived under',
  )
  assertDomain(
    SHA256.test(input.referenceMedia.sha256) && SHA256.test(input.reactionMedia.sha256),
    'INVALID_ARGUMENT',
    'reference and reaction media must each be identified by a sha256 digest',
  )
  assertId(input.referenceMedia.assetId, 'reference media assetId')
  assertId(input.reactionMedia.assetId, 'reaction media assetId')
  assertDomain(
    input.referenceMedia.durationTicks > BigInt(0) && input.reactionMedia.durationTicks > BigInt(0),
    'INVALID_ARGUMENT',
    'both recordings must have a measured, positive duration',
  )

  const version = input.version ?? 1
  assertDomain(
    Number.isSafeInteger(version) && version >= 1,
    'INVALID_ARGUMENT',
    'a playback map version is 1-based',
  )
  const previousVersionHash = input.previousVersionHash ?? null
  assertDomain(
    version === 1 ? previousVersionHash === null : typeof previousVersionHash === 'string',
    'INVALID_ARGUMENT',
    'every version after the first names the hash of the version it replaced',
  )
  assertDomain(input.pieces.length > 0, 'INVALID_ARGUMENT', 'a playback map needs at least one piece')

  const reactionBounds = createTickInterval(BigInt(0), input.reactionMedia.durationTicks)
  const referenceBounds = createTickInterval(BigInt(0), input.referenceMedia.durationTicks)

  const ordered = [...input.pieces].sort((left, right) => {
    if (left.reactionRange.start !== right.reactionRange.start) {
      return left.reactionRange.start < right.reactionRange.start ? -1 : 1
    }
    return 0
  })
  assertDomain(
    ordered.every((piece, index) => piece.reactionRange.start === input.pieces[index]!.reactionRange.start),
    'INVALID_ARGUMENT',
    'playback pieces must be given in reaction order',
  )

  const pieces: Readonly<PlaybackPiece>[] = []
  const seenIds = new Set<string>()
  let previousEnd: bigint | null = null

  for (const [index, piece] of ordered.entries()) {
    assertId(piece.pieceId, 'playback piece id')
    assertDomain(!seenIds.has(piece.pieceId), 'INVALID_ARGUMENT', `piece ${piece.pieceId} is declared twice`)
    seenIds.add(piece.pieceId)
    assertDomain(
      PLAYBACK_MODES.includes(piece.mode),
      'INVALID_ARGUMENT',
      `piece ${piece.pieceId} carries an unknown playback mode`,
    )
    assertDomain(
      intervalContainsInterval(reactionBounds, piece.reactionRange),
      'INVALID_ARGUMENT',
      `piece ${piece.pieceId} covers reaction time the recording does not have`,
    )
    if (previousEnd !== null) {
      assertDomain(
        piece.reactionRange.start >= previousEnd,
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} overlaps the piece before it; the reactor lived each instant once`,
      )
    }
    previousEnd = piece.reactionRange.end

    const referenceRange = piece.referenceRange ?? null
    if (NO_REFERENCE_PLAYBACK_MODES.has(piece.mode)) {
      // Mandatory, not conventional. A `paused` piece with a reference range
      // would assert that the reference advanced while it was stopped, which is
      // the exact error ADR-135 names.
      assertDomain(
        referenceRange === null,
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} is ${piece.mode} and cannot claim the reference produced time`,
      )
      assertDomain(
        piece.direction === 'none',
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} is ${piece.mode}; a direction would describe a movement that did not happen`,
      )
      assertDomain(
        (piece.rate ?? null) === null,
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} is ${piece.mode}; there is no rate to measure`,
      )
    } else {
      assertDomain(
        referenceRange !== null,
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} is ${piece.mode} and must name the reference range it played`,
      )
      assertDomain(
        intervalContainsInterval(referenceBounds, referenceRange),
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} plays reference time the reference does not have`,
        {
          pieceId: piece.pieceId,
          referenceDurationTicks: input.referenceMedia.durationTicks.toString(),
          referenceRange: serializeTickInterval(referenceRange),
        },
      )
      assertDomain(
        piece.direction !== 'none',
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} plays the reference and must say how it reached it`,
      )
    }

    const rate = piece.rate ?? null
    if (rate !== null) {
      // Both halves, not just the numerator. `Rational` is a bare `{num, den}`
      // record (session-time.ts:36-39) and nothing forces a rehydrated piece
      // through `rational()`, which is what normalises the sign — so `1/-2` is
      // the same negative rate as `-1/2` spelled another way, and `1/0` is not a
      // number at all. Guarding only `num` let both through construction and
      // integrity, and `resolveReactionTick` then answered with a reference tick
      // outside the piece's own range.
      assertDomain(
        rate.num > BigInt(0) && rate.den > BigInt(0),
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} carries a non-positive rate; a measured playback rate is strictly positive`,
        { rate: `${rate.num}/${rate.den}` },
      )
      assertDomain(
        referenceRange !== null,
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} has no reference range, so there is nothing its rate could be the rate of`,
      )
      // Only a method that actually measures a slope may carry one. A rate on a
      // manual anchor would be a person's guess wearing a measurement's clothes.
      assertDomain(
        piece.detectionMethod === 'audio-fingerprint' || piece.detectionMethod === 'ocr-timestamp',
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} was detected by ${piece.detectionMethod}, which does not measure a rate`,
      )
    }
    if ((piece.mode === 'rewind' || piece.mode === 'replay')) {
      assertDomain(
        piece.direction === 'backward',
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} is a ${piece.mode} and must be reached by going backwards`,
      )
    }
    if (piece.mode === 'seek') {
      assertDomain(
        piece.discontinuityReason === 'seek',
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} is a seek and must record 'seek' as the reason it begins`,
      )
    }
    if (index === 0) {
      // The first piece cannot have been *reached* by a movement: there is
      // nothing before it to move from. It may still begin after an uncovered
      // stretch at the head of the recording, which is a coverage gap.
      assertDomain(
        piece.discontinuityReason !== 'seek' && piece.discontinuityReason !== 'rewind' &&
          piece.discontinuityReason !== 'pts-regression',
        'INVALID_ARGUMENT',
        'the first piece cannot begin because of a movement from a piece that does not exist',
      )
    } else {
      assertDomain(
        (piece.discontinuityReason ?? null) !== null,
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} must say why it begins where it does`,
      )
    }
    assertUnitInterval(piece.confidence, `piece ${piece.pieceId} confidence`)
    assertDomain(
      piece.evidenceRefs.length > 0,
      'INVALID_ARGUMENT',
      `piece ${piece.pieceId} asserts something and must name the evidence for it`,
    )

    const body: Omit<PlaybackPiece, 'pieceHash'> = {
      pieceId: piece.pieceId,
      ordinal: index,
      mode: piece.mode,
      reactionRange: piece.reactionRange,
      referenceRange,
      rate,
      direction: piece.direction,
      confidence: piece.confidence,
      evidenceRefs: Object.freeze([...piece.evidenceRefs]),
      detectionMethod: piece.detectionMethod,
      residualTicks: piece.residualTicks ?? null,
      discontinuityReason: piece.discontinuityReason ?? null,
    }
    pieces.push(Object.freeze({ ...body, pieceHash: calculatePlaybackPieceHash(body) }))
  }

  const uncovered = [...(input.uncovered ?? [])].sort((left, right) =>
    left.range.start < right.range.start ? -1 : left.range.start > right.range.start ? 1 : 0)
  for (const entry of uncovered) {
    assertDomain(
      PLAYBACK_UNCOVERED_REASONS.includes(entry.reason),
      'INVALID_ARGUMENT',
      'an uncovered stretch must say why nothing describes it',
    )
    assertDomain(
      intervalContainsInterval(reactionBounds, entry.range),
      'INVALID_ARGUMENT',
      'an uncovered stretch must lie inside the reaction recording',
    )
  }

  // Pieces and uncovered stretches together tile the reaction exactly. A hole
  // in the tiling would be a third state — neither described nor declared
  // undescribable — and every consumer would have to guess which it was.
  const tiles = [
    ...pieces.map((piece) => piece.reactionRange),
    ...uncovered.map((entry) => entry.range),
  ].sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0))
  let cursor = BigInt(0)
  for (const tile of tiles) {
    assertDomain(
      tile.start === cursor,
      'INVALID_ARGUMENT',
      'pieces and uncovered stretches must tile the reaction without gaps or overlap',
      { expectedStart: cursor.toString(), actualStart: tile.start.toString() },
    )
    cursor = tile.end
  }
  assertDomain(
    cursor === input.reactionMedia.durationTicks,
    'INVALID_ARGUMENT',
    'pieces and uncovered stretches must reach the end of the reaction recording',
    { coveredTo: cursor.toString(), durationTicks: input.reactionMedia.durationTicks.toString() },
  )

  const anchors = [...(input.anchors ?? [])]
  const anchorIds = new Set<string>()
  for (const anchor of anchors) {
    assertId(anchor.anchorId, 'playback anchor id')
    assertDomain(!anchorIds.has(anchor.anchorId), 'INVALID_ARGUMENT', `anchor ${anchor.anchorId} is declared twice`)
    anchorIds.add(anchor.anchorId)
    assertDomain(
      ANCHOR_ORIGINS.includes(anchor.origin),
      'INVALID_ARGUMENT',
      `anchor ${anchor.anchorId} has an unknown origin`,
    )
    assertDomain(
      intervalContains(reactionBounds, anchor.reactionTick),
      'INVALID_ARGUMENT',
      `anchor ${anchor.anchorId} points outside the reaction recording`,
    )
    assertDomain(
      anchor.referenceTick === null || intervalContains(referenceBounds, anchor.referenceTick),
      'INVALID_ARGUMENT',
      `anchor ${anchor.anchorId} points outside the reference recording`,
    )
    assertUnitInterval(anchor.confidence, `anchor ${anchor.anchorId} confidence`)
    assertDomain(
      anchor.evidenceRef.trim().length > 0,
      'INVALID_ARGUMENT',
      `anchor ${anchor.anchorId} must name its evidence`,
    )
  }

  const warnings = new Set<PlaybackMapWarning>()
  for (const entry of uncovered) warnings.add(entry.reason)
  if (pieces.some((piece) => piece.referenceRange !== null && piece.rate === null)) {
    warnings.add('rate-unmeasured')
  }
  const hasReference = pieces.some((piece) => piece.referenceRange !== null)
  if (!hasReference) warnings.add('no-reference-detected')
  if (pieces.some((piece) => piece.referenceRange?.end === input.referenceMedia.durationTicks)) {
    warnings.add('reference-exhausted')
  }

  const status: PlaybackMapStatus = !hasReference
    ? 'failed'
    : uncovered.length > 0
      ? 'needs-input'
      : 'resolved'

  const body: Omit<PlaybackMap, 'mapHash'> = {
    schemaVersion: PLAYBACK_MAP_SCHEMA_VERSION,
    mapId: input.mapId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sessionVersion: input.sessionVersion,
    referenceEpoch: input.referenceEpoch,
    reactionTrackId: input.reactionTrackId,
    referenceTrackId: input.referenceTrackId,
    referenceMedia: Object.freeze({ ...input.referenceMedia }),
    reactionMedia: Object.freeze({ ...input.reactionMedia }),
    version,
    previousVersionHash,
    supersedesMapId: input.supersedesMapId ?? null,
    pieces: Object.freeze(pieces),
    uncovered: Object.freeze(uncovered.map((entry) => Object.freeze({ ...entry }))),
    anchors: Object.freeze(anchors.map((anchor) => Object.freeze({ ...anchor }))),
    status,
    warnings: Object.freeze([...warnings].sort()),
  }
  return Object.freeze({ ...body, mapHash: calculatePlaybackMapHash(body) })
}

export function assertPlaybackMapIntegrity(map: Readonly<PlaybackMap>): Readonly<PlaybackMap> {
  assertDomain(
    map.schemaVersion === PLAYBACK_MAP_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored playback map schema is invalid',
  )
  assertDomain(
    map.pieces.every((piece, index) => piece.ordinal === index),
    'PERSISTENCE_CONFLICT',
    'stored playback map pieces are not a gap-free ordered sequence',
  )
  for (const piece of map.pieces) {
    const { pieceHash, ...body } = piece
    assertDomain(
      calculatePlaybackPieceHash(body) === pieceHash,
      'PERSISTENCE_CONFLICT',
      `stored playback piece ${piece.pieceId} does not match its hash`,
    )
  }
  const { mapHash, ...body } = map
  assertDomain(
    calculatePlaybackMapHash(body) === mapHash,
    'PERSISTENCE_CONFLICT',
    'stored playback map hash does not match its body',
  )
  return map
}

/**
 * Where in the reference was the reactor at this instant of the reaction?
 *
 * Three answers, and they are not interchangeable. `no-reference` says the
 * reference was not playing — that is a measurement. `uncovered` says nobody
 * knows — that is the absence of one. Interpolating across an uncovered stretch
 * would turn the second into the first.
 */
export function resolveReactionTick(map: Readonly<PlaybackMap>, tick: bigint): PlaybackResolution {
  const piece = map.pieces.find((entry) => intervalContains(entry.reactionRange, tick))
  if (!piece) {
    const declared = map.uncovered.find((entry) => intervalContains(entry.range, tick))
    if (declared) return Object.freeze({ status: 'uncovered' as const, reason: declared.reason })
    const first = map.pieces[0]!
    return Object.freeze({
      status: 'uncovered' as const,
      reason: tick < first.reactionRange.start ? ('before-first-piece' as const) : ('after-last-piece' as const),
    })
  }
  if (piece.referenceRange === null) {
    return Object.freeze({
      status: 'no-reference' as const,
      mode: piece.mode as 'paused' | 'commentary-only',
      pieceId: piece.pieceId,
    })
  }
  // 1/1 is assumed only to answer *this* question, and the answer says so. The
  // aggregate keeps `rate: null`, because an assumption made to serve a lookup
  // must never be persisted as a measurement.
  const rateAssumed = piece.rate === null
  const rate = piece.rate ?? rational(BigInt(1), BigInt(1))
  const offset = scaleTicks(tick - piece.reactionRange.start, rate)
  const raw = piece.referenceRange.start + offset
  // Clamped to the piece's own reference range at BOTH edges: the range is the
  // assertion, and neither a rounding at the far edge nor an unnormalised rate
  // may produce a tick the piece never claimed. The upper edge alone left the
  // lower one open, and a lookup could answer with a negative reference tick.
  const referenceTick = raw >= piece.referenceRange.end
    ? piece.referenceRange.end - BigInt(1)
    : raw < piece.referenceRange.start
      ? piece.referenceRange.start
      : raw
  return Object.freeze({
    status: 'resolved' as const,
    referenceTick,
    pieceId: piece.pieceId,
    mode: piece.mode,
    confidence: piece.confidence,
    rateAssumed,
  })
}

// ---------------------------------------------------------------------------
// Building a map from observations
// ---------------------------------------------------------------------------

type WindowVerdict =
  | Readonly<{ kind: 'locked'; tick: bigint; referenceTick: bigint; confidence: number; refs: readonly string[] }>
  | Readonly<{ kind: 'absent'; tick: bigint; confidence: number; refs: readonly string[] }>
  | Readonly<{ kind: 'conflict'; tick: bigint; confidence: number; refs: readonly string[] }>

function judgeWindow(
  tick: bigint,
  observations: readonly Readonly<PlaybackObservation>[],
  policy: Readonly<PlaybackPolicy>,
): WindowVerdict {
  const refs = observations.map((observation) => observation.evidenceRef)
  const claims = observations.filter((observation) => observation.referenceTick !== null)
  if (claims.length === 0) {
    // Absence is a negative claim, so the weakest observer sets the number. The
    // maximum was the wrong reducer here: one producer that is sure of nothing
    // must not be outvoted into confidence by another. This is the confidence
    // that eventually becomes a `paused` piece's, so it has to measure the gap.
    return Object.freeze({
      kind: 'absent' as const,
      tick,
      confidence: Math.min(1, ...observations.map((observation) => observation.confidence)),
      refs: Object.freeze(refs),
    })
  }
  // A claim that did not lock is not absence: the correlator found something and
  // could not tell it from its runner-up. Building a piece on it would be
  // choosing a winner the measurement refused to choose.
  const weak = claims.some((observation) =>
    (observation.peakRatio !== undefined && observation.peakRatio < policy.minimumPeakRatioForAdmission) ||
    observation.confidence < policy.minimumConfidenceForAdmission)
  let spread = BigInt(0)
  for (const left of claims) {
    for (const right of claims) {
      const delta = absTicks(left.referenceTick! - right.referenceTick!)
      if (delta > spread) spread = delta
    }
  }
  if (weak || spread > policy.continuityToleranceTicks) {
    return Object.freeze({
      kind: 'conflict' as const,
      tick,
      confidence: Math.max(...claims.map((observation) => observation.confidence)),
      refs: Object.freeze(refs),
    })
  }
  const best = claims.reduce((left, right) => (right.confidence > left.confidence ? right : left))
  return Object.freeze({
    kind: 'locked' as const,
    tick,
    referenceTick: best.referenceTick!,
    confidence: best.confidence,
    refs: Object.freeze(refs),
  })
}

type Run = Readonly<{ kind: WindowVerdict['kind']; windows: readonly WindowVerdict[] }>

function groupIntoRuns(verdicts: readonly WindowVerdict[], policy: Readonly<PlaybackPolicy>): readonly Run[] {
  const runs: { kind: WindowVerdict['kind']; windows: WindowVerdict[] }[] = []
  for (const verdict of verdicts) {
    const current = runs[runs.length - 1]
    if (!current || current.kind !== verdict.kind) {
      runs.push({ kind: verdict.kind, windows: [verdict] })
      continue
    }
    if (verdict.kind === 'locked') {
      const previous = current.windows[current.windows.length - 1] as Extract<WindowVerdict, { kind: 'locked' }>
      const reactionDelta = verdict.tick - previous.tick
      const referenceDelta = verdict.referenceTick - previous.referenceTick
      const drift = referenceDelta - reactionDelta
      // Backwards is unambiguous: playing forward can never produce it. A
      // forward drift past the seek threshold is the player having jumped.
      if (referenceDelta < -policy.continuityToleranceTicks || absTicks(drift) > policy.seekThresholdTicks) {
        runs.push({ kind: verdict.kind, windows: [verdict] })
        continue
      }
    }
    current.windows.push(verdict)
  }
  return runs.map((run) => Object.freeze({ kind: run.kind, windows: Object.freeze(run.windows) }))
}

function measureRate(
  windows: readonly Extract<WindowVerdict, { kind: 'locked' }>[],
  policy: Readonly<PlaybackPolicy>,
): Rational | null {
  if (windows.length < policy.minimumWindowsForRate) return null
  const first = windows[0]!
  const last = windows[windows.length - 1]!
  const reactionSpan = last.tick - first.tick
  const referenceSpan = last.referenceTick - first.referenceTick
  if (reactionSpan <= BigInt(0) || referenceSpan <= BigInt(0)) return null
  return rational(referenceSpan, reactionSpan)
}

function measureResidual(
  windows: readonly Extract<WindowVerdict, { kind: 'locked' }>[],
  rate: Rational | null,
): bigint | null {
  if (rate === null || windows.length < 3) return null
  const first = windows[0]!
  let worst = BigInt(0)
  for (const window of windows) {
    const modelled = first.referenceTick + scaleTicks(window.tick - first.tick, rate)
    const delta = absTicks(window.referenceTick - modelled)
    if (delta > worst) worst = delta
  }
  return worst
}

export interface BuildPlaybackMapInput {
  readonly mapId: string
  readonly session: Readonly<CaptureSession>
  readonly reactionTrack: Readonly<CaptureTrack>
  readonly referenceTrack: Readonly<CaptureTrack>
  readonly referenceMedia: Readonly<PlaybackReferenceMedia>
  readonly reactionMedia: Readonly<PlaybackReactionMedia>
  readonly observations: readonly Readonly<PlaybackObservation>[]
  readonly anchors?: readonly Readonly<PlaybackAnchor>[]
  readonly policy: Readonly<PlaybackPolicy>
  readonly supersedesMapId?: string | null
}

/**
 * Classify observations into pieces.
 *
 * The rules, and why each one is the honest reading of the evidence:
 *
 * - A stretch with no reference between two locked runs is a **pause** only
 *   when the reference resumes at the tick it left. That is the one hypothesis
 *   the evidence uniquely supports.
 * - The same stretch is **commentary-only** when it is longer than the policy's
 *   pause ceiling, or when there is no locked run on one side of it: nobody
 *   pauses for twenty minutes and resumes on the same frame, and a gap at the
 *   edge of the recording has nothing to resume from.
 * - When the reference resumes *ahead* of where it stopped, the reference moved
 *   while nobody could observe it. "Played through", "paused then seeked" and
 *   "scrubbed" all fit. The stretch becomes **uncovered / manual-anchor-required**
 *   (ADR-135: hidden players require manual anchors) rather than a guess.
 * - A locked run that starts behind the previous one is a **replay** when its
 *   reference range was already played, and a **rewind** when it goes back and
 *   then past. Backwards is unambiguous; forward beyond the threshold is a
 *   **seek**.
 * - A window whose observations disagree, or whose peak never cleared the
 *   admission ratio, becomes **uncovered / conflicting-evidence**. No piece is
 *   invented from evidence that refused to choose.
 */
export function buildPlaybackMap(input: BuildPlaybackMapInput): Readonly<PlaybackMap> {
  assertDomain(
    input.reactionTrack.role === 'reaction',
    'INVALID_ARGUMENT',
    'the reaction track of a playback map must be the session\'s reaction track',
  )
  assertDomain(
    input.referenceTrack.role === 'reference-video',
    'INVALID_ARGUMENT',
    'the reference track of a playback map must be the session\'s reference video',
  )
  assertDomain(
    input.session.tracks.some((track) => track.trackId === input.reactionTrack.trackId) &&
      input.session.tracks.some((track) => track.trackId === input.referenceTrack.trackId),
    'CAPTURE_TRACK_NOT_FOUND',
    'both tracks of a playback map must belong to the session it is derived from',
  )

  const duration = input.reactionMedia.durationTicks
  const grouped = new Map<string, Readonly<PlaybackObservation>[]>()
  for (const observation of input.observations) {
    assertDomain(
      observation.reactionTick >= BigInt(0) && observation.reactionTick < duration,
      'INVALID_ARGUMENT',
      'an observation must fall inside the reaction recording',
    )
    assertUnitInterval(observation.confidence, 'observation confidence')
    // The peak ratio is the admission gate (`minimumPeakRatioForAdmission`), and
    // it was the one number reaching `judgeWindow` unchecked: `Infinity < 1.2`
    // is false, so an infinite ratio was admitted and became a `playing` piece.
    // The FFmpeg detector caps its own ratio, but this aggregate accepts
    // observations from any producer — the phase-3 `SyncSignalSource` included.
    assertDomain(
      observation.peakRatio === undefined ||
        (Number.isFinite(observation.peakRatio) && observation.peakRatio >= 0),
      'INVALID_ARGUMENT',
      'an observation peak ratio must be a finite, non-negative measurement',
      { evidenceRef: observation.evidenceRef, peakRatio: String(observation.peakRatio) },
    )
    const key = observation.reactionTick.toString()
    const bucket = grouped.get(key)
    if (bucket) bucket.push(observation)
    else grouped.set(key, [observation])
  }
  const ticks = [...grouped.keys()].map((key) => BigInt(key)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  assertDomain(ticks.length > 0, 'INVALID_ARGUMENT', 'a playback map cannot be built without observations')

  const verdicts = ticks.map((tick) => judgeWindow(tick, grouped.get(tick.toString())!, input.policy))
  const allRuns = groupIntoRuns(verdicts, input.policy)

  // Boundaries are the first window of each run, with the first run pulled back
  // to zero and the last extended to the end of the recording. The detector's
  // resolution is its hop, and pretending to a finer boundary than the hop would
  // be reporting precision nobody measured.
  const spans = allRuns.map((run, index) => ({
    run,
    start: index === 0 ? BigInt(0) : run.windows[0]!.tick,
    end: index === allRuns.length - 1 ? duration : allRuns[index + 1]!.windows[0]!.tick,
  }))

  // A run of *absent* windows shorter than one window is the detector's own
  // boundary, not a pause. Where one piece ends and the next begins, exactly one
  // window straddles the seam and matches neither side well enough to lock — so
  // the gap is evidence that one window covered two things, not evidence that
  // the reference stopped. A *conflict* run is never absorbed this way: two
  // plausible references is positive evidence of disagreement, and smoothing it
  // away is precisely the invention this aggregate refuses.
  const kept: { run: Run; start: bigint; end: bigint }[] = []
  let carriedStart: bigint | null = null
  for (const span of spans) {
    const artefact = span.run.kind === 'absent' && span.end - span.start < input.policy.windowTicks
    if (artefact) {
      carriedStart = carriedStart ?? span.start
      continue
    }
    kept.push({ run: span.run, start: carriedStart ?? span.start, end: span.end })
    carriedStart = null
  }
  if (kept.length === 0) {
    for (const span of spans) kept.push({ ...span })
  } else if (carriedStart !== null) {
    kept[kept.length - 1] = { ...kept[kept.length - 1]!, end: duration }
  }

  const runs = kept.map((entry) => entry.run)
  const bounds: Readonly<TickInterval>[] = kept.map((entry) => createTickInterval(entry.start, entry.end))

  const lockedRuns = runs
    .map((run, index) => ({ run, index }))
    .filter((entry) => entry.run.kind === 'locked')

  const pieceInputs: PlaybackPieceInput[] = []
  const uncovered: PlaybackUncoveredRange[] = []
  const playedReference: Readonly<TickInterval>[] = []
  let previousLockedIndex = -1
  /** What the run immediately before this one turned into, so a piece can say why it begins. */
  let previousOutcome: 'paused' | 'commentary-only' | 'uncovered' | 'locked' | null = null

  for (const [index, run] of runs.entries()) {
    const range = bounds[index]!
    if (run.kind === 'conflict') {
      uncovered.push(Object.freeze({ range, reason: 'conflicting-evidence' as const }))
      previousOutcome = 'uncovered'
      continue
    }

    if (run.kind === 'absent') {
      const before = lockedRuns.filter((entry) => entry.index < index).pop()
      const after = lockedRuns.find((entry) => entry.index > index)
      if (!before || !after) {
        // Nothing to resume from, or nothing that resumed. The reactor was
        // talking with no reference around, which is what commentary is.
        pieceInputs.push(gapPiece(run, range, 'commentary-only', index, previousOutcome))
        previousOutcome = 'commentary-only'
        continue
      }
      const junction = classifyJunction(before.run, after.run, input.policy)
      if (junction !== 'stalled') {
        // Anything but a reference that resumes where it left is a stretch more
        // than one story fits, and the aggregate names none of them (ADR-135).
        //
        // Forward — played through, paused then seeked, or scrubbed.
        //
        // *Backward* belongs here too, and used to fall through to the pause
        // branch: a reference that resumes behind where it stopped is equally
        // explained by "paused, then rewound" and by "played on unobserved, then
        // rewound further back". Calling that a pause published `status:
        // 'resolved'` with no warning over evidence that supports at least two
        // incompatible edits, and contradicted this module's own rule that a
        // pause is the stretch where the reference resumes at the tick it left.
        uncovered.push(Object.freeze({ range, reason: 'manual-anchor-required' as const }))
        previousOutcome = 'uncovered'
        continue
      }
      const mode: PlaybackMode = intervalDuration(range) > input.policy.maxPauseTicks
        ? 'commentary-only'
        : 'paused'
      pieceInputs.push(gapPiece(run, range, mode, index, previousOutcome))
      previousOutcome = mode
      continue
    }

    const windows = run.windows as readonly Extract<WindowVerdict, { kind: 'locked' }>[]
    const rate = measureRate(windows, input.policy)
    const residual = measureResidual(windows, rate)
    const referenceStart = windows[0]!.referenceTick
    const span = rate === null
      ? windows[windows.length - 1]!.referenceTick + input.policy.windowTicks - referenceStart
      : scaleTicks(intervalDuration(range), rate)
    const cappedEnd = referenceStart + span > input.referenceMedia.durationTicks
      ? input.referenceMedia.durationTicks
      : referenceStart + span
    const referenceRange = createTickInterval(
      referenceStart,
      cappedEnd > referenceStart ? cappedEnd : referenceStart + BigInt(1),
    )

    let mode: PlaybackMode = 'playing'
    let direction: PlaybackDirection = 'forward'
    let reason: PlaybackDiscontinuityReason | null = null
    if (previousLockedIndex >= 0) {
      // Reaction time can pass between two locked runs, and the reference may
      // legitimately have advanced through it. What counts as a jump is measured
      // against that passage, not against the previous end alone.
      const junction = classifyJunction(runs[previousLockedIndex]!, run, input.policy)
      if (junction === 'backward') {
        direction = 'backward'
        reason = 'rewind'
        const { merged } = canonicalizeIntervals(playedReference)
        mode = merged.some((played) => intervalContainsInterval(played, referenceRange))
          ? 'replay'
          : 'rewind'
      } else if (junction === 'jumped') {
        mode = 'seek'
        reason = 'seek'
      }
    }
    if (reason === null && index > 0) {
      reason = previousOutcome === 'paused'
        ? 'pause'
        : previousOutcome === 'commentary-only'
          ? 'commentary'
          : 'coverage-gap'
    }

    pieceInputs.push({
      pieceId: `piece-${String(index).padStart(3, '0')}`,
      mode,
      reactionRange: range,
      referenceRange,
      rate,
      direction,
      confidence: Math.min(...windows.map((window) => window.confidence)),
      evidenceRefs: windows.flatMap((window) => [...window.refs]),
      detectionMethod: 'audio-fingerprint',
      residualTicks: residual,
      discontinuityReason: reason,
    })
    playedReference.push(referenceRange)
    previousLockedIndex = index
    previousOutcome = 'locked'
  }

  return createPlaybackMap({
    mapId: input.mapId,
    workspaceId: input.session.workspaceId,
    sessionId: input.session.sessionId,
    sessionVersion: input.session.version,
    referenceEpoch: input.session.referenceEpoch,
    reactionTrackId: input.reactionTrack.trackId,
    referenceTrackId: input.referenceTrack.trackId,
    referenceMedia: input.referenceMedia,
    reactionMedia: input.reactionMedia,
    pieces: pieceInputs,
    uncovered,
    anchors: input.anchors ?? [],
    supersedesMapId: input.supersedesMapId ?? null,
  })
}

type LockedWindow = Extract<WindowVerdict, { kind: 'locked' }>

function lastLocked(run: Run): LockedWindow {
  const windows = run.windows as readonly LockedWindow[]
  return windows[windows.length - 1]!
}

function firstLocked(run: Run): LockedWindow {
  return (run.windows as readonly LockedWindow[])[0]!
}

/**
 * What happened to the reference between two locked runs.
 *
 * The uncertainty that shapes every threshold here: the last window of a run
 * *starts* where its reference tick says, and covers one window after that. So
 * the instant playback actually stopped is known only to within one window, and
 * every comparison has to carry that window in its tolerance. Pretending to a
 * finer boundary than the detector's own window would be reporting precision
 * nobody measured.
 *
 * - `backward` — the reference went back. No amount of forward playback does
 *   that, so it is the one unambiguous verdict.
 * - `stalled` — the reference did not advance beyond the window's uncertainty:
 *   the player was stopped.
 * - `continuous` — the reference advanced by exactly the reaction time that
 *   passed: it kept playing, and if that happened across a gap then it did so
 *   unobserved.
 * - `jumped` — it advanced by something else entirely.
 */
function classifyJunction(
  before: Run,
  after: Run,
  policy: Readonly<PlaybackPolicy>,
): 'backward' | 'stalled' | 'continuous' | 'jumped' {
  const last = lastLocked(before)
  const next = firstLocked(after)
  if (next.referenceTick < last.referenceTick - policy.continuityToleranceTicks) return 'backward'
  if (next.referenceTick <= last.referenceTick + policy.windowTicks + policy.continuityToleranceTicks) {
    return 'stalled'
  }
  const projected = last.referenceTick + (next.tick - last.tick)
  if (absTicks(next.referenceTick - projected) <= policy.windowTicks + policy.continuityToleranceTicks) {
    return 'continuous'
  }
  return 'jumped'
}

function gapPiece(
  run: Run,
  range: Readonly<TickInterval>,
  mode: 'paused' | 'commentary-only',
  index: number,
  previousOutcome: 'paused' | 'commentary-only' | 'uncovered' | 'locked' | null,
): PlaybackPieceInput {
  const refs = run.windows.flatMap((window) => [...window.refs])
  return {
    pieceId: `piece-${String(index).padStart(3, '0')}`,
    mode,
    reactionRange: range,
    referenceRange: null,
    rate: null,
    direction: 'none',
    confidence: Math.min(...run.windows.map((window) => window.confidence)),
    evidenceRefs: refs.length > 0 ? refs : [`no-correlation:${range.start}`],
    detectionMethod: 'audio-fingerprint',
    residualTicks: null,
    discontinuityReason: index === 0
      ? null
      : previousOutcome === 'uncovered'
        ? 'coverage-gap'
        : mode === 'paused' ? 'pause' : 'commentary',
  }
}

// ---------------------------------------------------------------------------
// Manual anchors
// ---------------------------------------------------------------------------

/**
 * Who placed or moved this anchor, plus whatever note they sent.
 *
 * The actor comes first and is never optional (the Wave 19 rule): a
 * caller-supplied reference *replacing* the actor would erase the only trace of
 * who overrode a measurement.
 */
function anchorEvidenceRef(actorId: string, note: string | undefined): string {
  const trimmed = note?.trim()
  return trimmed && trimmed.length > 0 ? `operator:${actorId} (${trimmed})` : `operator:${actorId}`
}

export interface PlaybackAnchorEdit {
  readonly anchorId: string
  readonly reactionTick: bigint
  readonly referenceTick: bigint | null
  readonly mode?: PlaybackMode
  readonly actorId: string
  readonly note?: string
  readonly createdAt: string
}

/**
 * Resolve one uncovered stretch with a person's answer, producing the next
 * version of the map.
 *
 * The fence is the version **and** the hash together. A version number alone can
 * be reused after a failed write; the hash cannot, so the pair is what proves
 * the operator was looking at this exact document.
 *
 * Automatic anchors are never touched: the anchor list only grows.
 */
export function applyPlaybackAnchor(
  map: Readonly<PlaybackMap>,
  input: Readonly<{ expectedVersion: number; expectedHash: string; anchor: Readonly<PlaybackAnchorEdit> }>,
): Readonly<PlaybackMap> {
  assertDomain(
    map.version === input.expectedVersion && map.mapHash === input.expectedHash,
    'PLAYBACK_MAP_VERSION_STALE',
    `this playback map is at version ${map.version}; the anchor was computed against ${input.expectedVersion}`,
    { currentVersion: map.version, currentHash: map.mapHash },
  )
  const { anchor } = input
  assertId(anchor.anchorId, 'playback anchor id')
  assertId(anchor.actorId, 'playback anchor actorId')
  assertDomain(
    !map.anchors.some((existing) => existing.anchorId === anchor.anchorId),
    'INVALID_ARGUMENT',
    `anchor ${anchor.anchorId} already exists on this map`,
  )
  const target = map.uncovered.find((entry) => intervalContains(entry.range, anchor.reactionTick))
  assertDomain(
    target !== undefined,
    'INVALID_ARGUMENT',
    'a manual anchor resolves an uncovered stretch; this instant already has a piece',
    { reactionTick: anchor.reactionTick.toString() },
  )
  const mode: PlaybackMode = anchor.mode ?? (anchor.referenceTick === null ? 'commentary-only' : 'playing')
  assertDomain(
    (anchor.referenceTick === null) === NO_REFERENCE_PLAYBACK_MODES.has(mode),
    'INVALID_ARGUMENT',
    'an anchor that names a reference instant cannot describe a stretch where the reference produced no time',
  )

  const placed: Readonly<PlaybackAnchor> = Object.freeze({
    anchorId: anchor.anchorId,
    origin: 'manual' as const,
    reactionTick: anchor.reactionTick,
    referenceTick: anchor.referenceTick,
    mode,
    method: 'manual-anchor' as const,
    // A person is confident, not certain. The number is the diagnostic's manual
    // anchor confidence (`sync-diagnostic-anchors.ts:240`), kept identical so an
    // operator's word weighs the same in both aggregates.
    confidence: 0.9,
    evidenceRef: anchorEvidenceRef(anchor.actorId, anchor.note),
    createdAt: anchor.createdAt,
  })

  const span = intervalDuration(target!.range)
  // The operator named an instant, not a range. The reference start of the piece
  // is that instant walked back to the head of the uncovered stretch — anchoring
  // `anchor.referenceTick` at `target.range.start` instead ignored the reaction
  // tick the operator actually pointed at and shifted the whole resolved piece
  // by `anchor.reactionTick - target.range.start` (a second, thirty frames, on
  // this aggregate's own fixture).
  const offsetIntoRange = anchor.reactionTick - target!.range.start
  const referenceStart = anchor.referenceTick === null ? null : anchor.referenceTick - offsetIntoRange
  if (referenceStart !== null) {
    assertDomain(
      referenceStart >= BigInt(0),
      'INVALID_ARGUMENT',
      'this anchor puts the head of the uncovered stretch before the reference begins',
      {
        reactionTick: anchor.reactionTick.toString(),
        referenceTick: anchor.referenceTick!.toString(),
        rangeStart: target!.range.start.toString(),
      },
    )
    // The tail is refused, not clamped. Clamping would hand back a piece whose
    // reference range is shorter than its reaction range, which asserts a rate
    // nobody measured. A reference that ends mid-stretch is two pieces — playing,
    // then commentary — and one anchor cannot say that.
    assertDomain(
      referenceStart + span <= map.referenceMedia.durationTicks,
      'INVALID_ARGUMENT',
      'this anchor runs the uncovered stretch past the end of the reference recording',
      {
        referenceStart: referenceStart.toString(),
        spanTicks: span.toString(),
        referenceDurationTicks: map.referenceMedia.durationTicks.toString(),
      },
    )
  }
  const resolved: PlaybackPieceInput = {
    pieceId: `${map.mapId}:anchor-${anchor.anchorId}`,
    mode,
    reactionRange: target!.range,
    // A manual anchor fixes one point. The range it covers is the operator's
    // assertion that playback ran on from there, which is why the piece carries
    // no rate: nobody measured a slope, and 1/1 written here would be a guess
    // indistinguishable from a measurement.
    referenceRange: referenceStart === null
      ? null
      : createTickInterval(referenceStart, referenceStart + span),
    rate: null,
    direction: anchor.referenceTick === null ? 'none' : 'forward',
    confidence: placed.confidence,
    evidenceRefs: [placed.evidenceRef],
    detectionMethod: 'manual-anchor',
    residualTicks: null,
    discontinuityReason: 'manual-anchor',
  }

  const pieces: PlaybackPieceInput[] = [
    ...map.pieces.map((piece) => ({
      pieceId: piece.pieceId,
      mode: piece.mode,
      reactionRange: piece.reactionRange,
      referenceRange: piece.referenceRange,
      rate: piece.rate,
      direction: piece.direction,
      confidence: piece.confidence,
      evidenceRefs: piece.evidenceRefs,
      detectionMethod: piece.detectionMethod,
      residualTicks: piece.residualTicks,
      discontinuityReason: piece.discontinuityReason,
    })),
    resolved,
  ].sort((left, right) => (left.reactionRange.start < right.reactionRange.start ? -1 : 1))

  return createPlaybackMap({
    mapId: map.mapId,
    workspaceId: map.workspaceId,
    sessionId: map.sessionId,
    sessionVersion: map.sessionVersion,
    referenceEpoch: map.referenceEpoch,
    reactionTrackId: map.reactionTrackId,
    referenceTrackId: map.referenceTrackId,
    referenceMedia: map.referenceMedia,
    reactionMedia: map.reactionMedia,
    version: map.version + 1,
    previousVersionHash: map.mapHash,
    supersedesMapId: map.supersedesMapId,
    pieces,
    uncovered: map.uncovered.filter((entry) => entry !== target),
    anchors: [...map.anchors, placed],
  })
}

// ---------------------------------------------------------------------------
// Compiling to shots
// ---------------------------------------------------------------------------

export interface PlaybackShot {
  readonly pieceId: string
  readonly mode: PlaybackMode
  readonly sourceAssetId: string
  readonly sourceInFrame: number
  readonly sourceOutFrame: number
  readonly timelineInFrame: number
  readonly timelineOutFrame: number
  /** Always 1: this compiler cuts, it never retimes. */
  readonly rate: 1
  /**
   * Always the reaction's audio. A react edit is the reactor's voice over
   * whatever they were watching; taking the reference's audio would replace the
   * only thing the audience came for.
   */
  readonly audioSourceAssetId: string
}

/**
 * Turn a resolved map into contiguous shots on an output timeline.
 *
 * Declared limitation: the renderer has no freeze-frame and no picture-in-
 * picture in the editorial path (`clip-timing.ts:25-42` refuses a rate of zero;
 * report 05 §5, §10.3-4). A `paused` stretch therefore shows the *reactor*, not
 * a held frame of the reference — which is what an editor wants there anyway,
 * and is stated rather than silently chosen.
 */
export function compilePlaybackToShots(
  map: Readonly<PlaybackMap>,
  options: Readonly<{
    planFps: Rational
    referenceTimebase: Readonly<Timebase>
    reactionTimebase: Readonly<Timebase>
  }>,
): Readonly<{ shots: readonly Readonly<PlaybackShot>[] }> {
  assertDomain(
    map.uncovered.length === 0,
    'PLAYBACK_MAP_UNRESOLVED',
    'a playback map with uncovered stretches cannot be compiled; approximating them would invent an edit',
    {
      mapId: map.mapId,
      uncovered: map.uncovered.map((entry) => ({
        range: serializeTickInterval(entry.range),
        reason: entry.reason,
      })),
    },
  )
  assertDomain(
    map.status === 'resolved',
    'PLAYBACK_MAP_UNRESOLVED',
    `a playback map in status ${map.status} cannot be compiled`,
    { mapId: map.mapId, status: map.status },
  )
  assertDomain(
    options.planFps.num > BigInt(0),
    'INVALID_ARGUMENT',
    'a plan frame rate must be positive',
  )
  // The map already names the timebase its reference ticks are counted in.
  // Accepting a second one and not checking it would let a caller compile a map
  // against a clock it was never measured in.
  assertDomain(
    options.referenceTimebase.secondsPerTick.num === map.referenceMedia.timebase.secondsPerTick.num &&
      options.referenceTimebase.secondsPerTick.den === map.referenceMedia.timebase.secondsPerTick.den,
    'INVALID_ARGUMENT',
    'the reference timebase given does not match the one the map was measured in',
  )

  const frameTimebase = createTimebase(rational(options.planFps.den, options.planFps.num))
  const toFrames = (tick: bigint, from: Readonly<Timebase>): number =>
    Number(convertTick({ tick, from, to: frameTimebase }))

  const shots: Readonly<PlaybackShot>[] = []
  let timeline = 0
  for (const piece of map.pieces) {
    const span = toFrames(piece.reactionRange.end, options.reactionTimebase) -
      toFrames(piece.reactionRange.start, options.reactionTimebase)
    assertDomain(
      span > 0,
      'INVALID_ARGUMENT',
      `piece ${piece.pieceId} is shorter than one output frame`,
    )
    const fromReference = piece.referenceRange !== null
    const sourceIn = fromReference
      ? toFrames(piece.referenceRange!.start, options.referenceTimebase)
      : toFrames(piece.reactionRange.start, options.reactionTimebase)
    if (fromReference) {
      const measured = toFrames(piece.referenceRange!.end, options.referenceTimebase) - sourceIn
      // The renderer cuts at rate 1, so the source span and the timeline span
      // have to be the same number of frames. A piece whose measured reference
      // span disagrees by more than the rounding bound is not a straight cut and
      // is refused rather than stretched into one.
      assertDomain(
        Math.abs(measured - span) <= 1,
        'INVALID_ARGUMENT',
        `piece ${piece.pieceId} spans ${measured} reference frames over ${span} timeline frames; a straight cut cannot express that`,
      )
    }
    shots.push(Object.freeze({
      pieceId: piece.pieceId,
      mode: piece.mode,
      sourceAssetId: fromReference ? map.referenceMedia.assetId : map.reactionMedia.assetId,
      sourceInFrame: sourceIn,
      sourceOutFrame: sourceIn + span,
      timelineInFrame: timeline,
      timelineOutFrame: timeline + span,
      rate: 1 as const,
      audioSourceAssetId: map.reactionMedia.assetId,
    }))
    timeline += span
  }

  for (const [index, shot] of shots.entries()) {
    if (index === 0) continue
    assertDomain(
      shot.timelineInFrame === shots[index - 1]!.timelineOutFrame,
      'INVALID_ARGUMENT',
      'compiled shots must be contiguous on the timeline',
    )
  }
  return Object.freeze({ shots: Object.freeze(shots) })
}
