import type {
  BuildReactPlaybackMapResult,
  ReactPlaybackPieceListing,
  StrandedRenderablePlan,
} from '../application/react-playback-map.ts'
import { DomainError } from '../domain/errors.ts'
import {
  PLAYBACK_MODES,
  type PlaybackAnchor,
  type PlaybackMap,
  type PlaybackMode,
  type PlaybackPiece,
} from '../domain/playback-map.ts'
import type { Rational, Timebase } from '../domain/session-time.ts'
import {
  exactFields,
  identifier,
  member,
  presentInterval,
  presentOptionalInterval,
  record,
  sha256,
  text,
  tick,
  versionRef,
} from './capture-derivation-contract.ts'

/**
 * The public boundary for react playback maps (F4.015).
 *
 * Three shapes decided here rather than left to a reader.
 *
 * **A rate crosses as `"num/den"`, or as null.** Only the audio fingerprinter
 * measures a rate; a piece placed by a person carries none. Null is never
 * rendered as `1/1` — a rate of one is a measurement like any other, and
 * writing it where none was taken makes an unverified map indistinguishable
 * from a verified one.
 *
 * **An uncovered stretch is not a piece with holes.** It travels in its own
 * list with the reason nobody could answer it, because "the player was hidden
 * and played through, paused, or scrubbed — all three fit" is an answer, and a
 * piece with null fields would read as a measurement that went wrong.
 *
 * **An anchor is added, never moved or removed.** `applyPlaybackAnchor` refuses
 * an `anchorId` the map already carries and never touches an automatic anchor:
 * the list only grows. A schema offering `move` and `remove` would advertise
 * two operations the aggregate refuses, so the command here is an add and the
 * capability says so.
 */

function presentRational(value: Readonly<Rational>): string {
  return `${value.num}/${value.den}`
}

function presentTimebase(timebase: Readonly<Timebase>) {
  return Object.freeze({ secondsPerTick: presentRational(timebase.secondsPerTick) })
}

export function presentPlaybackPiece(piece: Readonly<PlaybackPiece>) {
  return Object.freeze({
    pieceId: piece.pieceId,
    ordinal: piece.ordinal,
    mode: piece.mode,
    reactionRange: presentInterval(piece.reactionRange),
    // Mandatory null for `paused` and `commentary-only`: the reference produced
    // no time, and an interval saying it produced some would be a claim nobody
    // measured.
    referenceRange: presentOptionalInterval(piece.referenceRange),
    rate: piece.rate === null ? null : presentRational(piece.rate),
    direction: piece.direction,
    confidence: piece.confidence,
    evidenceRefs: piece.evidenceRefs,
    detectionMethod: piece.detectionMethod,
    // Worst disagreement between the observations inside this piece and the
    // straight line it asserts, in reference ticks. Null when there was nothing
    // to disagree with — fewer than three observations, or no rate.
    residualTicks: piece.residualTicks === null ? null : piece.residualTicks.toString(),
    discontinuityReason: piece.discontinuityReason,
    pieceHash: piece.pieceHash,
  })
}

export function presentPlaybackAnchor(anchor: Readonly<PlaybackAnchor>) {
  return Object.freeze({
    anchorId: anchor.anchorId,
    origin: anchor.origin,
    reactionTick: anchor.reactionTick.toString(),
    // Null asserts "there was no reference here", which is itself an answer.
    referenceTick: anchor.referenceTick === null ? null : anchor.referenceTick.toString(),
    mode: anchor.mode,
    method: anchor.method,
    confidence: anchor.confidence,
    // `operator:<actorId> (<note>)`. Who overrode a measurement is recorded even
    // when they said nothing about why.
    evidenceRef: anchor.evidenceRef,
    createdAt: anchor.createdAt,
  })
}

/**
 * The map without its pieces.
 *
 * The pieces are their own read for the same reason the direction's shots are:
 * a caller asking "is this resolved, and what is still unanswered" is handed
 * the answer, while the piece-by-piece account of what the player did is a
 * second, larger question.
 */
export function presentPlaybackMap(map: Readonly<PlaybackMap>) {
  return Object.freeze({
    schemaVersion: map.schemaVersion,
    mapId: map.mapId,
    sessionId: map.sessionId,
    sessionVersion: map.sessionVersion,
    referenceEpoch: map.referenceEpoch,
    reactionTrackId: map.reactionTrackId,
    referenceTrackId: map.referenceTrackId,
    referenceMedia: Object.freeze({
      assetId: map.referenceMedia.assetId,
      sha256: map.referenceMedia.sha256,
      durationTicks: map.referenceMedia.durationTicks.toString(),
      timebase: presentTimebase(map.referenceMedia.timebase),
    }),
    reactionMedia: Object.freeze({
      assetId: map.reactionMedia.assetId,
      sha256: map.reactionMedia.sha256,
      durationTicks: map.reactionMedia.durationTicks.toString(),
    }),
    version: map.version,
    previousVersionHash: map.previousVersionHash,
    // Set when the reference recording changed: the old map is superseded
    // rather than amended, because every reference tick now means something
    // else.
    supersedesMapId: map.supersedesMapId,
    pieceCount: map.pieces.length,
    uncovered: map.uncovered.map((entry) => Object.freeze({
      range: presentInterval(entry.range),
      reason: entry.reason,
    })),
    anchors: map.anchors.map(presentPlaybackAnchor),
    status: map.status,
    warnings: map.warnings,
    mapHash: map.mapHash,
  })
}

export function presentPlaybackMapRead(read: Readonly<{
  map: Readonly<PlaybackMap>
  versionRef: string
  manualReviewRequired: boolean
}>) {
  return Object.freeze({
    map: presentPlaybackMap(read.map),
    versionRef: read.versionRef,
    manualReviewRequired: read.manualReviewRequired,
  })
}

function presentStrandedPlan(plan: Readonly<StrandedRenderablePlan> | null) {
  return plan === null ? null : Object.freeze({
    planId: plan.planId,
    planHash: plan.planHash,
    compiledFromHash: plan.compiledFromHash,
  })
}

export function presentBuiltPlaybackMap(result: Readonly<BuildReactPlaybackMapResult>) {
  return Object.freeze({
    map: presentPlaybackMap(result.map),
    versionRef: `${result.map.sessionId}:playback:${result.map.reactionTrackId}:v${result.map.version}`,
    manualReviewRequired: result.manualReviewRequired,
    replayed: result.replayed,
    supersededMapId: result.supersededMapId,
    carriedAnchors: result.carriedAnchors,
    // Anchors that could not be carried because the recording they point into
    // is no longer the same bytes. Their reference instants mean something else
    // now, so they are dropped and counted rather than re-pointed.
    droppedAnchors: result.droppedAnchors,
    // The compiled plan this rebuild left describing an older head. Reported,
    // never deleted: the plan that was rendered stays readable.
    invalidated: presentStrandedPlan(result.invalidated),
  })
}

export function presentAnchoredPlaybackMap(result: Readonly<{
  map: Readonly<PlaybackMap>
  replayed: boolean
  manualReviewRequired: boolean
  invalidated: Readonly<StrandedRenderablePlan> | null
}>) {
  return Object.freeze({
    map: presentPlaybackMap(result.map),
    versionRef: `${result.map.sessionId}:playback:${result.map.reactionTrackId}:v${result.map.version}`,
    manualReviewRequired: result.manualReviewRequired,
    replayed: result.replayed,
    invalidated: presentStrandedPlan(result.invalidated),
  })
}

export function presentPlaybackPieceListing(listing: Readonly<ReactPlaybackPieceListing>) {
  return Object.freeze({
    ...presentPlaybackMapRead(listing),
    pieces: listing.pieces.map(presentPlaybackPiece),
    filteredOut: listing.filteredOut,
    omittedPieces: listing.omittedPieces,
  })
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface ParsedBuildPlaybackMapBody {
  readonly baseVersionId: string
  readonly baseHash: string
  readonly reactionTrackId?: string
}

/**
 * The session fence, and which reactor when there is more than one.
 *
 * Nothing else: the pieces, the modes, the rates and the residuals are read off
 * the recordings by the fingerprinter, and a request that could contribute one
 * could say the player never paused.
 */
export function parseBuildPlaybackMapBody(raw: unknown): ParsedBuildPlaybackMapBody {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash', 'reactionTrackId'], 'body')
  return Object.freeze({
    baseVersionId: versionRef(body.baseVersionId, 'baseVersionId'),
    baseHash: sha256(body.baseHash, 'baseHash'),
    ...(body.reactionTrackId === undefined
      ? {}
      : { reactionTrackId: identifier(body.reactionTrackId, 'reactionTrackId') }),
  })
}

export interface ParsedPlaybackAnchorBody {
  readonly baseVersionId: string
  readonly baseHash: string
  readonly reactionTrackId: string
  readonly anchor: Readonly<{
    anchorId: string
    reactionTick: bigint
    referenceTick: bigint | null
    mode?: PlaybackMode
    note?: string
  }>
}

const ANCHOR_KEYS = Object.freeze(['anchorId', 'reactionTick', 'referenceTick', 'mode', 'note'] as const)

export function parsePlaybackAnchorBody(raw: unknown): ParsedPlaybackAnchorBody {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash', 'reactionTrackId', 'anchor'], 'body')
  const anchor = record(body.anchor, 'anchor')
  exactFields(anchor, ANCHOR_KEYS, 'anchor')
  if (anchor.referenceTick === undefined) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'anchor.referenceTick must be a tick or null; omitting it would leave "there was no reference here" and "nobody said" indistinguishable',
    )
  }
  return Object.freeze({
    baseVersionId: versionRef(body.baseVersionId, 'baseVersionId'),
    baseHash: sha256(body.baseHash, 'baseHash'),
    reactionTrackId: identifier(body.reactionTrackId, 'reactionTrackId'),
    anchor: Object.freeze({
      anchorId: identifier(anchor.anchorId, 'anchor.anchorId'),
      reactionTick: tick(anchor.reactionTick, 'anchor.reactionTick'),
      referenceTick: anchor.referenceTick === null
        ? null
        : tick(anchor.referenceTick, 'anchor.referenceTick'),
      ...(anchor.mode === undefined ? {} : { mode: member(anchor.mode, PLAYBACK_MODES, 'anchor.mode') }),
      ...(anchor.note === undefined ? {} : { note: text(anchor.note, 'anchor.note', 1_000) }),
    }),
  })
}

export function parsePlaybackMode(value: string | null) {
  return value === null ? undefined : member(value, PLAYBACK_MODES, 'mode')
}
