import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  applyAffineClockMap,
  compareIntervals,
  createTickInterval,
  intervalContains,
  intervalDuration,
  intervalGaps,
  intervalIntersection,
  invertAffineClockMap,
  serializeRational,
  serializeTickInterval,
  type AffineClockMap,
  type TickInterval,
} from './session-time.ts'
import type { ClockConfidence, SessionClock, SourceToSessionMapping } from './session-clock.ts'

/**
 * F4.007 — piecewise source → session maps.
 *
 * A single affine map assumes one thing: that the two clocks ran continuously,
 * together, for the whole span. Recorders violate that constantly. A card fills
 * and the camera restarts; an operator seeks; a react player rewinds; a phone
 * drops frames and the PTS jumps. After any of those, the offset that was true
 * a second ago is simply wrong, and a map that keeps applying it is not
 * approximately right — it is confidently wrong for the entire remainder.
 *
 * So the map is a sequence of *pieces*, each with its own affine law and its
 * own coverage, and the boundaries between them are recorded facts with named
 * causes rather than artefacts of a fitting algorithm.
 *
 * Two rules make this honest rather than merely piecewise:
 *
 * **Nothing is resolved between pieces.** The gap between a recorder stopping
 * and restarting is not a short piece with an interpolated rate; it is time
 * during which this source has nothing to say. Asking for a tick there returns
 * `uncovered`, not a number. Interpolating across a discontinuity is precisely
 * how a two-hour edit ends up a frame out for its second half.
 *
 * **Pieces never overlap.** Two laws claiming the same source tick would make
 * conversion depend on which one was consulted, and both answers would be
 * defensible. The constructor refuses the pair instead of ordering them.
 */

export const PIECEWISE_CLOCK_MAP_SCHEMA_VERSION = 'piecewise-clock-map/v1' as const

/**
 * Why a new piece begins. Every one of these is something that happened to the
 * recording, not a property of the fit — except `residual-exceeded`, which is
 * the fit admitting a single line cannot describe what it was given.
 */
export const PIECE_BOUNDARY_CAUSES = Object.freeze([
  'recorder-restart',
  'pts-regression',
  'seek',
  'rewind',
  'file-split',
  'coverage-gap',
  'residual-exceeded',
  'manual-anchor-conflict',
] as const)
export type PieceBoundaryCause = (typeof PIECE_BOUNDARY_CAUSES)[number]

/** Causes that mean the source itself stopped producing time for a while. */
const DISCONTINUOUS_CAUSES: ReadonlySet<PieceBoundaryCause> = new Set([
  'recorder-restart',
  'coverage-gap',
  'file-split',
])

export interface ClockMapPiece {
  readonly pieceId: string
  /** Position in the sequence, 0-based, contiguous and gap-free. */
  readonly ordinal: number
  /** Half-open, in source ticks. The only range this piece's law describes. */
  readonly sourceCoverage: Readonly<TickInterval>
  /** Half-open, in session ticks: the projection of `sourceCoverage`. */
  readonly sessionCoverage: Readonly<TickInterval>
  readonly map: Readonly<AffineClockMap>
  readonly driftPpm: number
  readonly confidence: ClockConfidence
  /** Upper bound of this piece's mapping error, in session ticks. */
  readonly residualBoundTicks: bigint
  /** Why this piece begins where it does. Null only for the first piece. */
  readonly openedBy: PieceBoundaryCause | null
  readonly openedByDetail: string | null
  readonly anchorIds: readonly string[]
  readonly evidenceRefs: readonly string[]
}

export interface PieceBoundary {
  readonly beforePieceId: string
  readonly afterPieceId: string
  readonly cause: PieceBoundaryCause
  readonly detail: string
  /** Source ticks with no law at all. Null when the pieces meet exactly. */
  readonly sourceGap: Readonly<TickInterval> | null
  /**
   * How far the two laws disagree at the boundary, in session ticks.
   *
   * A large jump is not an error to smooth away: it is the measured size of the
   * discontinuity, and it is what tells an operator whether the recorder lost a
   * second or a minute.
   */
  readonly sessionJumpTicks: bigint
}

export interface PiecewiseClockMap {
  readonly schemaVersion: typeof PIECEWISE_CLOCK_MAP_SCHEMA_VERSION
  readonly workspaceId: string
  readonly sessionId: string
  readonly sourceId: string
  /** The exact session version and reference epoch this map was derived under. */
  readonly derivedFrom: Readonly<{ sessionVersion: number; referenceEpoch: number }>
  readonly pieces: readonly Readonly<ClockMapPiece>[]
  readonly boundaries: readonly Readonly<PieceBoundary>[]
  /** The hull of the pieces. Not a claim that everything inside is covered. */
  readonly sourceBounds: Readonly<TickInterval>
  /** Source ranges inside the hull that no piece describes. */
  readonly uncovered: readonly Readonly<TickInterval>[]
  readonly mapHash: string
}

export type PiecewiseResolution =
  | Readonly<{ status: 'resolved'; pieceId: string; tick: bigint; confidence: ClockConfidence; residualBoundTicks: bigint }>
  | Readonly<{ status: 'uncovered'; reason: 'before-first-piece' | 'after-last-piece' | 'in-discontinuity' }>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

function assertId(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is not a canonical identifier`)
  return value
}

export interface PiecewiseClockMapPieceInput {
  readonly pieceId: string
  readonly mapping: Readonly<SourceToSessionMapping>
  readonly openedBy?: PieceBoundaryCause
  readonly openedByDetail?: string
}

/**
 * Assemble a piecewise map from per-piece mappings.
 *
 * The mappings arrive already measured — each one is a `SourceToSessionMapping`
 * that carries its own evidence, so this function never invents a law. What it
 * does is order them, prove they do not overlap, and name the boundary between
 * each consecutive pair.
 */
export function createPiecewiseClockMap(input: {
  workspaceId: string
  sessionId: string
  sourceId: string
  clock: Readonly<SessionClock>
  derivedFrom: Readonly<{ sessionVersion: number; referenceEpoch: number }>
  pieces: readonly PiecewiseClockMapPieceInput[]
}): Readonly<PiecewiseClockMap> {
  assertId(input.workspaceId, 'piecewise map workspaceId')
  assertId(input.sessionId, 'piecewise map sessionId')
  assertId(input.sourceId, 'piecewise map sourceId')
  assertDomain(input.pieces.length > 0, 'INVALID_ARGUMENT', 'a piecewise map needs at least one piece')
  assertDomain(
    Number.isSafeInteger(input.derivedFrom.sessionVersion) && input.derivedFrom.sessionVersion >= 1 &&
      Number.isSafeInteger(input.derivedFrom.referenceEpoch) && input.derivedFrom.referenceEpoch >= 1,
    'INVALID_ARGUMENT',
    'a piecewise map must name the session version and reference epoch it was derived under',
  )
  // The clock is what the session ticks mean. Assembling pieces measured under
  // one clock into a map labelled with another would leave every session tick
  // in the result denominated in a timebase nobody declared.
  assertDomain(
    input.clock.sessionId === input.sessionId,
    'INVALID_ARGUMENT',
    'a piecewise map must be assembled under the clock of its own session',
  )

  for (const piece of input.pieces) {
    assertId(piece.pieceId, 'piece id')
    assertDomain(
      piece.mapping.sessionId === input.sessionId,
      'INVALID_ARGUMENT',
      `piece ${piece.pieceId} was measured against a different session`,
    )
    // Every piece must describe the same source. A map that silently mixed two
    // sources would answer "where is this instant" with the wrong recording.
    assertDomain(
      piece.mapping.sourceId === input.sourceId,
      'INVALID_ARGUMENT',
      `piece ${piece.pieceId} maps ${piece.mapping.sourceId}, not ${input.sourceId}`,
    )
  }

  const ordered = [...input.pieces].sort((left, right) =>
    compareIntervals(left.mapping.sourceCoverage, right.mapping.sourceCoverage))

  assertDomain(
    new Set(ordered.map((piece) => piece.pieceId)).size === ordered.length,
    'INVALID_ARGUMENT',
    'piece ids must be unique within a map',
  )
  assertDomain(
    ordered[0]!.openedBy === undefined,
    'INVALID_ARGUMENT',
    'the first piece opens the map and has no boundary before it',
  )

  const pieces: ClockMapPiece[] = []
  const boundaries: PieceBoundary[] = []

  ordered.forEach((entry, index) => {
    const previous = index === 0 ? null : ordered[index - 1]!
    if (previous) {
      const before = previous.mapping.sourceCoverage
      const after = entry.mapping.sourceCoverage
      // Overlap is refused rather than ordered away: two laws over the same
      // tick make conversion depend on which was consulted, and both answers
      // would be defensible.
      assertDomain(
        after.start >= before.end,
        'INVALID_ARGUMENT',
        `pieces ${previous.pieceId} and ${entry.pieceId} both claim source ticks; a tick cannot obey two laws`,
      )
      assertDomain(
        entry.openedBy !== undefined,
        'INVALID_ARGUMENT',
        `piece ${entry.pieceId} follows another and must say what opened it`,
      )
      assertDomain(
        PIECE_BOUNDARY_CAUSES.includes(entry.openedBy),
        'INVALID_ARGUMENT',
        `${entry.openedBy} is not a recognized piece boundary cause`,
      )
      const detail = (entry.openedByDetail ?? '').trim()
      assertDomain(
        detail.length >= 10,
        'INVALID_ARGUMENT',
        `piece ${entry.pieceId} must explain its boundary in words an operator can act on`,
      )
      const sourceGap = after.start > before.end ? createTickInterval(before.end, after.start) : null
      // A cause that means "the source stopped producing time" must actually
      // show a gap, and a continuous cause must not. Otherwise the recorded
      // cause and the measured evidence would be free to disagree.
      if (DISCONTINUOUS_CAUSES.has(entry.openedBy)) {
        assertDomain(
          sourceGap !== null,
          'INVALID_ARGUMENT',
          `piece ${entry.pieceId} claims ${entry.openedBy} but its source ticks continue without a gap`,
        )
      }
      // How far the earlier law would have been wrong at the moment the later
      // one takes over. This is the size of the discontinuity, measured.
      const continuation = applyAffineClockMap(previous.mapping.map, after.start)
      const actual = applyAffineClockMap(entry.mapping.map, after.start)
      boundaries.push(Object.freeze({
        beforePieceId: previous.pieceId,
        afterPieceId: entry.pieceId,
        cause: entry.openedBy,
        detail,
        sourceGap,
        sessionJumpTicks: actual - continuation,
      }))
    }

    pieces.push(Object.freeze({
      pieceId: entry.pieceId,
      ordinal: index,
      sourceCoverage: entry.mapping.sourceCoverage,
      sessionCoverage: entry.mapping.sessionCoverage,
      map: entry.mapping.map,
      driftPpm: entry.mapping.driftPpm,
      confidence: entry.mapping.confidence,
      residualBoundTicks: entry.mapping.precision.boundTicks,
      openedBy: entry.openedBy ?? null,
      openedByDetail: index === 0 ? null : (entry.openedByDetail ?? '').trim(),
      anchorIds: entry.mapping.anchorIds,
      evidenceRefs: entry.mapping.evidenceRefs,
    }))
  })

  const sourceBounds = createTickInterval(
    pieces[0]!.sourceCoverage.start,
    pieces[pieces.length - 1]!.sourceCoverage.end,
  )
  const uncovered = intervalGaps(pieces.map((piece) => piece.sourceCoverage), sourceBounds)

  const body = {
    schemaVersion: PIECEWISE_CLOCK_MAP_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sourceId: input.sourceId,
    derivedFrom: Object.freeze({ ...input.derivedFrom }),
    pieces: Object.freeze(pieces),
    boundaries: Object.freeze(boundaries),
    sourceBounds,
    uncovered,
  }
  return Object.freeze({ ...body, mapHash: calculatePiecewiseClockMapHash(body) })
}

/**
 * Canonical hash.
 *
 * `bigint` and `Rational` have no JSON form, so every tick becomes decimal text
 * and every rate becomes `num/den` before hashing. Two runs on two machines
 * therefore produce the same bytes, which is what lets a stored map be
 * re-derived and compared rather than trusted.
 */
export function calculatePiecewiseClockMapHash(map: Omit<PiecewiseClockMap, 'mapHash'>): string {
  return calculateCanonicalHash({
    schemaVersion: map.schemaVersion,
    workspaceId: map.workspaceId,
    sessionId: map.sessionId,
    sourceId: map.sourceId,
    derivedFrom: map.derivedFrom,
    pieces: map.pieces.map((piece) => ({
      pieceId: piece.pieceId,
      ordinal: piece.ordinal,
      sourceCoverage: serializeTickInterval(piece.sourceCoverage),
      sessionCoverage: serializeTickInterval(piece.sessionCoverage),
      rate: serializeRational(piece.map.rate),
      offsetTicks: piece.map.offsetTicks.toString(),
      rounding: piece.map.rounding,
      driftPpm: piece.driftPpm,
      confidence: piece.confidence,
      residualBoundTicks: piece.residualBoundTicks.toString(),
      openedBy: piece.openedBy,
      openedByDetail: piece.openedByDetail,
      anchorIds: [...piece.anchorIds],
      evidenceRefs: [...piece.evidenceRefs],
    })),
    boundaries: map.boundaries.map((boundary) => ({
      beforePieceId: boundary.beforePieceId,
      afterPieceId: boundary.afterPieceId,
      cause: boundary.cause,
      detail: boundary.detail,
      sourceGap: boundary.sourceGap ? serializeTickInterval(boundary.sourceGap) : null,
      sessionJumpTicks: boundary.sessionJumpTicks.toString(),
    })),
    sourceBounds: serializeTickInterval(map.sourceBounds),
    uncovered: map.uncovered.map(serializeTickInterval),
  })
}

export function assertPiecewiseClockMapIntegrity(map: Readonly<PiecewiseClockMap>): Readonly<PiecewiseClockMap> {
  assertDomain(
    map.schemaVersion === PIECEWISE_CLOCK_MAP_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored piecewise map schema is invalid',
  )
  assertDomain(
    map.pieces.every((piece, index) => piece.ordinal === index),
    'PERSISTENCE_CONFLICT',
    'stored piecewise map pieces are not a gap-free ordered sequence',
  )
  const { mapHash, ...body } = map
  assertDomain(
    calculatePiecewiseClockMapHash(body) === mapHash,
    'PERSISTENCE_CONFLICT',
    'stored piecewise map hash does not match its body',
  )
  return map
}

function findPiece(
  map: Readonly<PiecewiseClockMap>,
  tick: bigint,
  select: (piece: Readonly<ClockMapPiece>) => Readonly<TickInterval>,
): Readonly<ClockMapPiece> | null {
  return map.pieces.find((piece) => intervalContains(select(piece), tick)) ?? null
}

/**
 * source → session, inside one piece only.
 *
 * A tick in the gap between two pieces gets `uncovered`, never an interpolated
 * number. The recorder was not producing time there, and inventing a value for
 * it is how the second half of a long edit ends up a frame out.
 */
export function resolveSourceTick(map: Readonly<PiecewiseClockMap>, sourceTick: bigint): PiecewiseResolution {
  const piece = findPiece(map, sourceTick, (entry) => entry.sourceCoverage)
  if (piece) {
    return Object.freeze({
      status: 'resolved' as const,
      pieceId: piece.pieceId,
      tick: applyAffineClockMap(piece.map, sourceTick),
      confidence: piece.confidence,
      residualBoundTicks: piece.residualBoundTicks,
    })
  }
  return Object.freeze({ status: 'uncovered' as const, reason: uncoveredReason(map, sourceTick, 'source') })
}

/** session → source, inside one piece only. Same refusal outside them. */
export function resolveSessionTick(map: Readonly<PiecewiseClockMap>, sessionTick: bigint): PiecewiseResolution {
  const piece = findPiece(map, sessionTick, (entry) => entry.sessionCoverage)
  if (piece) {
    return Object.freeze({
      status: 'resolved' as const,
      pieceId: piece.pieceId,
      tick: invertAffineClockMap(piece.map, sessionTick),
      confidence: piece.confidence,
      residualBoundTicks: piece.residualBoundTicks,
    })
  }
  return Object.freeze({ status: 'uncovered' as const, reason: uncoveredReason(map, sessionTick, 'session') })
}

function uncoveredReason(
  map: Readonly<PiecewiseClockMap>,
  tick: bigint,
  space: 'source' | 'session',
): 'before-first-piece' | 'after-last-piece' | 'in-discontinuity' {
  const first = map.pieces[0]!
  const last = map.pieces[map.pieces.length - 1]!
  const start = space === 'source' ? first.sourceCoverage.start : first.sessionCoverage.start
  const end = space === 'source' ? last.sourceCoverage.end : last.sessionCoverage.end
  if (tick < start) return 'before-first-piece'
  if (tick >= end) return 'after-last-piece'
  return 'in-discontinuity'
}

/**
 * The session ranges this map can actually answer for.
 *
 * A caller planning an edit needs the covered ranges, not the hull: the hull
 * includes the discontinuities, and selecting across one would silently span a
 * region the source never recorded.
 */
export function resolvableSessionRanges(map: Readonly<PiecewiseClockMap>): readonly Readonly<TickInterval>[] {
  return Object.freeze(map.pieces.map((piece) => piece.sessionCoverage))
}

/** Total source ticks actually described by some piece. Never the hull. */
export function describedSourceTicks(map: Readonly<PiecewiseClockMap>): bigint {
  return map.pieces.reduce((total, piece) => total + intervalDuration(piece.sourceCoverage), BigInt(0))
}

/**
 * Whether a whole session range can be selected from this source.
 *
 * True only when one piece covers it end to end. A range spanning a boundary is
 * refused even when both sides are covered, because the material between them
 * does not exist and a selection that crossed it would be a cut nobody chose.
 */
export function isSessionRangeResolvable(
  map: Readonly<PiecewiseClockMap>,
  range: Readonly<TickInterval>,
): boolean {
  return map.pieces.some((piece) => {
    const overlap = intervalIntersection(piece.sessionCoverage, range)
    return overlap !== null && overlap.start === range.start && overlap.end === range.end
  })
}

/**
 * Drift reported per piece.
 *
 * A single figure for the whole map would be a fiction: after a recorder
 * restart the oscillator is not the one that was drifting before, and averaging
 * the two rates describes neither. Each piece reports its own.
 */
export function driftByPiece(map: Readonly<PiecewiseClockMap>): readonly Readonly<{ pieceId: string; driftPpm: number }>[] {
  return Object.freeze(map.pieces.map((piece) => Object.freeze({
    pieceId: piece.pieceId,
    driftPpm: piece.driftPpm,
  })))
}
