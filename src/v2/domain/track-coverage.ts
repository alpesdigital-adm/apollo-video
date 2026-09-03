import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import {
  canonicalizeIntervals,
  compareIntervals,
  convertTick,
  createTickInterval,
  intervalDuration,
  intervalGaps,
  intervalIntersection,
  intervalsOverlap,
  rationalEquals,
  serializeRational,
  serializeTickInterval,
  type Timebase,
  type TickInterval,
} from './session-time.ts'

/**
 * F4.005 — what a track actually recorded, expressed as intervals that cannot
 * lie.
 *
 * Coverage is the answer to one question the Director asks constantly: *may I
 * cut to this source at this instant?* Every failure mode of a multicam edit is
 * a wrong answer to it — a camera that started late and got stretched to fit, a
 * card swap whose gap was silently bridged, two files claiming the same seconds
 * with nobody deciding which one is true. So this module is written so that the
 * wrong answers are not representable.
 *
 * Four rules shape it, and each one is enforced rather than documented:
 *
 * **A gap is never filled by stretching.** Gaps are derived, not declared:
 * `intervalGaps` over the parts inside their own hull. There is no function here
 * that returns a widened interval, and the hull is the union of what the parts
 * claimed, never a duration someone wanted.
 *
 * **Nothing outside coverage is selectable.** `assertCoverageSelectable` is the
 * only way in, and it refuses with the *reason* the range is unusable — gap,
 * corrupt, unverified or low confidence — because "not available" alone sends an
 * operator hunting through the wrong track.
 *
 * **Unverified is not editable.** A range nobody probed is not a range that
 * happens to be fine. It stays outside `available`, and auto-edit cannot reach
 * it under any argument.
 *
 * **An overlap is a decision, not a merge.** Two parts claiming the same ticks
 * is a fact about the recording. Canonicalization refuses to proceed until a
 * resolution says, on the record and with an author, which part wins — or admits
 * that nobody knows, in which case the region becomes unverified rather than
 * quietly belonging to whichever file sorted first.
 */

export const TRACK_COVERAGE_SCHEMA_VERSION = 'track-coverage/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

/** Basis points, so confidence is an exact integer and never a drifting float. */
export const CONFIDENCE_BPS_MAX = 10_000

/**
 * Below this, a range is evidence of a recording rather than proof of one. The
 * Director may still be pointed at it by a human; it is never chosen for them.
 */
export const AUTO_EDIT_MINIMUM_CONFIDENCE_BPS = 7_000

export const COVERAGE_AVAILABILITIES = Object.freeze([
  'available',
  'gap',
  'corrupt',
  'unverified',
] as const)
export type CoverageAvailability = (typeof COVERAGE_AVAILABILITIES)[number]

/**
 * How the interval came to be believed. `derived-gap` is the only kind this
 * module mints itself, and it is precisely the kind that carries no claim.
 */
export const COVERAGE_EVIDENCE_KINDS = Object.freeze([
  'packet-scan',
  'decoder-walk',
  'container-index',
  'declared-metadata',
  'operator-report',
  'derived-gap',
] as const)
export type CoverageEvidenceKind = (typeof COVERAGE_EVIDENCE_KINDS)[number]

export interface CoverageEvidence {
  readonly kind: CoverageEvidenceKind
  /** Probe hash, artifact id or operator note — whatever can be re-opened later. */
  readonly ref: string
}

/**
 * How two parts that claim the same ticks were separated.
 *
 * `manual-review` is not a way of postponing the decision into the edit: it
 * demotes the disputed region to `unverified`, which auto-edit cannot use. The
 * dispute is preserved, not resolved by default.
 */
export const COVERAGE_OVERLAP_RESOLUTIONS = Object.freeze([
  'prefer-part',
  'trim-later-part',
  'manual-review',
] as const)
export type CoverageOverlapResolution = (typeof COVERAGE_OVERLAP_RESOLUTIONS)[number]

export interface CoverageOverlapDecision {
  readonly leftPartId: string
  readonly rightPartId: string
  readonly interval: Readonly<TickInterval>
  readonly resolution: CoverageOverlapResolution
  /** The part that keeps the region. Null exactly when nobody decided. */
  readonly keepPartId: string | null
  readonly decidedBy: string
  readonly decidedAt: string
  readonly note: string
}

/** What the recorder did between two consecutive files of the same track. */
export const RECORDER_SPLIT_KINDS = Object.freeze(['contiguous', 'gap', 'overlap'] as const)
export type RecorderSplitKind = (typeof RECORDER_SPLIT_KINDS)[number]

export interface RecorderSplit {
  readonly fromPartId: string
  readonly toPartId: string
  readonly kind: RecorderSplitKind
  /** The tick at which the earlier part stopped claiming ticks. */
  readonly boundaryTick: bigint
  /** The measured gap or overlap. Null only when the parts touch exactly. */
  readonly measured: Readonly<TickInterval> | null
}

export interface CoverageInterval {
  readonly interval: Readonly<TickInterval>
  readonly availability: CoverageAvailability
  readonly confidenceBps: number
  /** The part responsible. Null for derived gaps, which belong to no file. */
  readonly partId: string | null
  readonly evidence: Readonly<CoverageEvidence>
}

/** A part's own claim, before any resolution is applied. */
export interface CoverageClaim {
  readonly partId: string
  readonly ordinal: number
  readonly timebase: Readonly<Timebase>
  readonly interval: Readonly<TickInterval>
  readonly confidenceBps: number
  readonly evidence: Readonly<CoverageEvidence>
}

/** A range a probe or an operator positively marked as unusable. */
export interface CoverageDefect {
  readonly availability: Extract<CoverageAvailability, 'corrupt' | 'unverified'>
  readonly interval: Readonly<TickInterval>
  readonly evidence: Readonly<CoverageEvidence>
}

/**
 * The exact session version this coverage was derived from.
 *
 * Coverage is a function of the session's parts, so it is only meaningful next
 * to the version that held them. Changing the reference track mints a new
 * session version, which is what makes a stale pairing impossible to express
 * rather than merely discouraged.
 */
export interface CaptureSessionDerivationRef {
  readonly sessionId: string
  readonly sessionVersion: number
  readonly referenceEpoch: number
}

export interface TrackCoverage {
  readonly schemaVersion: typeof TRACK_COVERAGE_SCHEMA_VERSION
  readonly workspaceId: string
  readonly trackId: string
  readonly derivedFrom: Readonly<CaptureSessionDerivationRef>
  /** The single clock every interval below is counted in. */
  readonly timebase: Readonly<Timebase>
  /** The hull of what the parts claimed. Never a wished-for duration. */
  readonly bounds: Readonly<TickInterval>
  readonly available: readonly Readonly<CoverageInterval>[]
  readonly gaps: readonly Readonly<CoverageInterval>[]
  readonly corrupt: readonly Readonly<CoverageInterval>[]
  readonly unverified: readonly Readonly<CoverageInterval>[]
  readonly overlaps: readonly Readonly<CoverageOverlapDecision>[]
  readonly recorderSplits: readonly Readonly<RecorderSplit>[]
  readonly coverageHash: string
}

function assertId(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is not a canonical identifier`)
  return value
}

function assertInstant(value: string, field: string): string {
  assertDomain(
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

function assertConfidence(value: number, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0 && value <= CONFIDENCE_BPS_MAX,
    'INVALID_ARGUMENT',
    `${field} must be an integer between 0 and ${CONFIDENCE_BPS_MAX} basis points`,
  )
  return value
}

function assertEvidence(evidence: Readonly<CoverageEvidence>, field: string): Readonly<CoverageEvidence> {
  assertDomain(
    COVERAGE_EVIDENCE_KINDS.includes(evidence.kind),
    'INVALID_ARGUMENT',
    `${field}.kind is not a coverage evidence kind`,
  )
  assertDomain(
    evidence.ref.trim().length > 0 && evidence.ref.length <= 256,
    'INVALID_ARGUMENT',
    `${field}.ref is required`,
  )
  return Object.freeze({ kind: evidence.kind, ref: evidence.ref })
}

/**
 * Convert a claim into the coverage clock without ever claiming a tick the
 * source did not cover.
 *
 * The start rounds up and the end rounds down. Rounding the other way would
 * widen the interval by up to a tick on each side, which is stretching — the one
 * thing coverage exists to prevent. A part too short to survive that narrowing
 * is not silently dropped: it is a real fact about the recording, and the caller
 * is told rather than handed a coverage that quietly lost a file.
 */
function convertClaim(
  interval: Readonly<TickInterval>,
  from: Readonly<Timebase>,
  to: Readonly<Timebase>,
  partId: string,
): Readonly<TickInterval> {
  if (rationalEquals(from.secondsPerTick, to.secondsPerTick)) return interval
  const start = convertTick({ tick: interval.start, from, to, rounding: 'ceil' })
  const end = convertTick({ tick: interval.end, from, to, rounding: 'floor' })
  assertDomain(
    end > start,
    'INVALID_ARGUMENT',
    `part ${partId} covers less than one tick of the coverage timebase and cannot be represented without widening it`,
  )
  return createTickInterval(start, end)
}

/** `interval` minus everything in `subtrahends`, using the kernel's gap maths. */
function subtract(
  interval: Readonly<TickInterval>,
  subtrahends: readonly Readonly<TickInterval>[],
): readonly Readonly<TickInterval>[] {
  const clipped = subtrahends
    .map((entry) => intervalIntersection(entry, interval))
    .filter((entry): entry is Readonly<TickInterval> => entry !== null)
  if (clipped.length === 0) return [interval]
  return intervalGaps(clipped, interval)
}

function subtractAll(
  intervals: readonly Readonly<TickInterval>[],
  subtrahends: readonly Readonly<TickInterval>[],
): readonly Readonly<TickInterval>[] {
  return intervals.flatMap((interval) => subtract(interval, subtrahends))
}

function sortIntervals(entries: readonly Readonly<CoverageInterval>[]): readonly Readonly<CoverageInterval>[] {
  return Object.freeze(
    [...entries]
      .sort((left, right) => {
        const byInterval = compareIntervals(left.interval, right.interval)
        if (byInterval !== 0) return byInterval
        return (left.partId ?? '').localeCompare(right.partId ?? '')
      })
      .map((entry) => Object.freeze({ ...entry })),
  )
}

function assertDisjoint(entries: readonly Readonly<CoverageInterval>[], label: string): void {
  for (let index = 1; index < entries.length; index += 1) {
    assertDomain(
      !intervalsOverlap(entries[index - 1]!.interval, entries[index]!.interval),
      'CAPTURE_COVERAGE_OVERLAP_UNRESOLVED',
      `${label} intervals still overlap after every declared resolution was applied`,
    )
  }
}

function assertClaims(claims: readonly Readonly<CoverageClaim>[]): readonly Readonly<CoverageClaim>[] {
  assertDomain(claims.length > 0, 'INVALID_ARGUMENT', 'a track coverage needs at least one part claim')
  const seenPartIds = new Set<string>()
  const seenOrdinals = new Set<number>()
  for (const claim of claims) {
    assertId(claim.partId, 'coverage claim partId')
    assertDomain(!seenPartIds.has(claim.partId), 'INVALID_ARGUMENT', `coverage claim ${claim.partId} is duplicated`)
    assertDomain(
      Number.isSafeInteger(claim.ordinal) && claim.ordinal >= 0,
      'INVALID_ARGUMENT',
      `coverage claim ${claim.partId} has an invalid ordinal`,
    )
    assertDomain(
      !seenOrdinals.has(claim.ordinal),
      'INVALID_ARGUMENT',
      `coverage claim ordinal ${claim.ordinal} is used by more than one part`,
    )
    assertConfidence(claim.confidenceBps, `coverage claim ${claim.partId} confidenceBps`)
    assertDomain(
      claim.evidence.kind !== 'derived-gap',
      'INVALID_ARGUMENT',
      `coverage claim ${claim.partId} cannot present a derived gap as recorded evidence`,
    )
    assertEvidence(claim.evidence, `coverage claim ${claim.partId} evidence`)
    seenPartIds.add(claim.partId)
    seenOrdinals.add(claim.ordinal)
  }
  // Ordinals are the recorder's own sequence: splits are read from them, so a
  // stable order here is what makes the split list deterministic.
  return Object.freeze([...claims].sort((left, right) => left.ordinal - right.ordinal))
}

function overlapKey(left: string, right: string): string {
  return left < right ? `${left} ${right}` : `${right} ${left}`
}

function assertDecision(
  decision: Readonly<CoverageOverlapDecision>,
  byPartId: ReadonlyMap<string, Readonly<CoverageClaim>>,
): Readonly<CoverageOverlapDecision> {
  assertId(decision.leftPartId, 'overlap decision leftPartId')
  assertId(decision.rightPartId, 'overlap decision rightPartId')
  assertDomain(
    decision.leftPartId !== decision.rightPartId,
    'INVALID_ARGUMENT',
    'an overlap decision must name two different parts',
  )
  assertDomain(
    byPartId.has(decision.leftPartId) && byPartId.has(decision.rightPartId),
    'INVALID_ARGUMENT',
    'an overlap decision names a part that is not in this track',
  )
  assertDomain(
    COVERAGE_OVERLAP_RESOLUTIONS.includes(decision.resolution),
    'INVALID_ARGUMENT',
    `overlap resolution ${decision.resolution} is not a resolution`,
  )
  // Auditable means attributable. A resolution with no author and no reason is
  // an unexplained edit to the recording's history.
  assertDomain(
    decision.decidedBy.trim().length > 0 && decision.decidedBy.length <= 256,
    'INVALID_ARGUMENT',
    'an overlap decision must record who decided',
  )
  assertDomain(
    decision.note.trim().length > 0 && decision.note.length <= 1_024,
    'INVALID_ARGUMENT',
    'an overlap decision must record why',
  )
  assertInstant(decision.decidedAt, 'overlap decision decidedAt')

  if (decision.resolution === 'manual-review') {
    assertDomain(
      decision.keepPartId === null,
      'INVALID_ARGUMENT',
      'a manual-review overlap has no winner: it is unresolved on purpose',
    )
  } else {
    assertDomain(
      decision.keepPartId === decision.leftPartId || decision.keepPartId === decision.rightPartId,
      'INVALID_ARGUMENT',
      'a resolved overlap must keep one of the two overlapping parts',
    )
  }
  if (decision.resolution === 'trim-later-part') {
    const left = byPartId.get(decision.leftPartId)!
    const right = byPartId.get(decision.rightPartId)!
    const earlier = left.ordinal < right.ordinal ? left : right
    assertDomain(
      decision.keepPartId === earlier.partId,
      'INVALID_ARGUMENT',
      'trim-later-part keeps the earlier recording; naming the later one contradicts the resolution',
    )
  }
  return Object.freeze({ ...decision, interval: Object.freeze({ ...decision.interval }) })
}

export interface CreateTrackCoverageInput {
  workspaceId: string
  trackId: string
  derivedFrom: Readonly<CaptureSessionDerivationRef>
  timebase: Readonly<Timebase>
  claims: readonly Readonly<CoverageClaim>[]
  /** Ranges positively marked unusable, already in the coverage timebase. */
  defects?: readonly Readonly<CoverageDefect>[]
  overlapDecisions?: readonly Readonly<CoverageOverlapDecision>[]
}

/**
 * Deterministic canonicalization of one track's coverage.
 *
 * Same input, same bytes: everything is sorted by interval and every derived
 * interval comes from `canonicalizeIntervals` / `intervalGaps`, so two runs on
 * two machines produce the same `coverageHash` and a persisted coverage can be
 * re-derived and compared instead of trusted.
 */
export function createTrackCoverage(input: CreateTrackCoverageInput): Readonly<TrackCoverage> {
  assertId(input.workspaceId, 'coverage workspaceId')
  assertId(input.trackId, 'coverage trackId')
  assertId(input.derivedFrom.sessionId, 'coverage derivedFrom.sessionId')
  assertDomain(
    Number.isSafeInteger(input.derivedFrom.sessionVersion) && input.derivedFrom.sessionVersion >= 1,
    'INVALID_ARGUMENT',
    'coverage derivedFrom.sessionVersion must be a positive integer',
  )
  assertDomain(
    Number.isSafeInteger(input.derivedFrom.referenceEpoch) && input.derivedFrom.referenceEpoch >= 1,
    'INVALID_ARGUMENT',
    'coverage derivedFrom.referenceEpoch must be a positive integer',
  )

  const claims = assertClaims(input.claims)
  const byPartId = new Map(claims.map((claim) => [claim.partId, claim]))
  const converted = claims.map((claim) =>
    Object.freeze({ ...claim, interval: convertClaim(claim.interval, claim.timebase, input.timebase, claim.partId) }),
  )

  // The hull is measured, never chosen: it is exactly what the parts claimed,
  // so a gap inside it is a hole in the recording rather than a shortfall
  // against somebody's expected duration.
  const { merged } = canonicalizeIntervals(converted.map((claim) => claim.interval))
  const bounds = createTickInterval(merged[0]!.start, merged[merged.length - 1]!.end)

  const decisions = (input.overlapDecisions ?? []).map((decision) => assertDecision(decision, byPartId))
  const decisionsByPair = new Map<string, Readonly<CoverageOverlapDecision>[]>()
  for (const decision of decisions) {
    const key = overlapKey(decision.leftPartId, decision.rightPartId)
    decisionsByPair.set(key, [...(decisionsByPair.get(key) ?? []), decision])
  }

  // Every pair that actually shares ticks must have a decision covering exactly
  // those ticks, and every decision must correspond to ticks that are actually
  // shared. Both directions matter: the first stops an overlap from being
  // merged away, the second stops a decision from inventing a dispute in order
  // to trim a part that nothing contradicted.
  const claimedResolutions = new Set<Readonly<CoverageOverlapDecision>>()
  const unverifiedFromReview: Readonly<TickInterval>[] = []
  const clippedByPartId = new Map<string, Readonly<TickInterval>[]>(
    converted.map((claim) => [claim.partId, [claim.interval]]),
  )
  for (let left = 0; left < converted.length; left += 1) {
    for (let right = left + 1; right < converted.length; right += 1) {
      const shared = intervalIntersection(converted[left]!.interval, converted[right]!.interval)
      if (!shared) continue
      const pair = decisionsByPair.get(overlapKey(converted[left]!.partId, converted[right]!.partId)) ?? []
      const decision = pair.find(
        (entry) => entry.interval.start === shared.start && entry.interval.end === shared.end,
      )
      assertDomain(
        decision !== undefined,
        'CAPTURE_COVERAGE_OVERLAP_UNRESOLVED',
        `parts ${converted[left]!.partId} and ${converted[right]!.partId} claim the same ticks and no resolution covers exactly that region`,
      )
      claimedResolutions.add(decision!)
      if (decision!.resolution === 'manual-review') {
        // Nobody decided, so nobody edits here. Both parts lose the region and
        // it becomes unverified rather than defaulting to a winner.
        unverifiedFromReview.push(shared)
        clippedByPartId.set(converted[left]!.partId, [
          ...subtractAll(clippedByPartId.get(converted[left]!.partId)!, [shared]),
        ])
        clippedByPartId.set(converted[right]!.partId, [
          ...subtractAll(clippedByPartId.get(converted[right]!.partId)!, [shared]),
        ])
      } else {
        const loser = decision!.keepPartId === converted[left]!.partId
          ? converted[right]!.partId
          : converted[left]!.partId
        clippedByPartId.set(loser, [...subtractAll(clippedByPartId.get(loser)!, [shared])])
      }
    }
  }
  for (const decision of decisions) {
    assertDomain(
      claimedResolutions.has(decision),
      'INVALID_ARGUMENT',
      `an overlap resolution between ${decision.leftPartId} and ${decision.rightPartId} describes ticks the two parts do not both claim`,
    )
  }
  const defects = (input.defects ?? []).map((defect) => {
    assertDomain(
      defect.availability === 'corrupt' || defect.availability === 'unverified',
      'INVALID_ARGUMENT',
      'a defect is either corrupt or unverified',
    )
    assertEvidence(defect.evidence, 'coverage defect evidence')
    return Object.freeze({ ...defect, interval: Object.freeze({ ...defect.interval }) })
  })

  const declaredUnverified = defects.filter((defect) => defect.availability === 'unverified')
  const declaredCorrupt = defects.filter((defect) => defect.availability === 'corrupt')
  // Corruption outranks doubt: bytes known to be broken are not merely
  // unchecked, and a range must land in exactly one bucket.
  const corruptIntervals = declaredCorrupt.map((defect) => defect.interval)
  const unusable = [...corruptIntervals, ...declaredUnverified.map((defect) => defect.interval), ...unverifiedFromReview]

  const available: Readonly<CoverageInterval>[] = []
  for (const claim of converted) {
    for (const fragment of subtractAll(clippedByPartId.get(claim.partId)!, unusable)) {
      available.push(Object.freeze({
        interval: fragment,
        availability: 'available' as const,
        confidenceBps: claim.confidenceBps,
        partId: claim.partId,
        evidence: claim.evidence,
      }))
    }
  }
  const sortedAvailable = sortIntervals(available)
  assertDisjoint(sortedAvailable, 'available')

  const claimedUnion = converted.map((claim) => claim.interval)
  // A defect only means something where something was recorded. Clipping every
  // reported range to the claims keeps a wide operator report from inventing
  // coverage that no file ever held.
  const withinClaims = (interval: Readonly<TickInterval>): readonly Readonly<TickInterval>[] =>
    claimedUnion
      .map((claim) => intervalIntersection(interval, claim))
      .filter((entry): entry is Readonly<TickInterval> => entry !== null)

  const corrupt = sortIntervals(
    declaredCorrupt.flatMap((defect) =>
      withinClaims(defect.interval).map((interval) => Object.freeze({
        interval,
        availability: 'corrupt' as const,
        confidenceBps: 0,
        partId: null,
        evidence: defect.evidence,
      })),
    ),
  )
  const unverified = sortIntervals([
    ...declaredUnverified.flatMap((defect) =>
      subtractAll(withinClaims(defect.interval), corruptIntervals).map((interval) => Object.freeze({
        interval,
        availability: 'unverified' as const,
        confidenceBps: 0,
        partId: null,
        evidence: defect.evidence,
      })),
    ),
    ...subtractAll(unverifiedFromReview, corruptIntervals).map((interval) => Object.freeze({
      interval,
      availability: 'unverified' as const,
      confidenceBps: 0,
      partId: null,
      evidence: Object.freeze({ kind: 'operator-report' as const, ref: 'overlap:manual-review' }),
    })),
  ])

  // Derived, never declared. A gap is the absence of any claim inside the hull;
  // it is not a range someone was allowed to describe, which is exactly why it
  // cannot be argued away.
  const gaps = sortIntervals(
    intervalGaps(claimedUnion, bounds).map((interval) => Object.freeze({
      interval,
      availability: 'gap' as const,
      confidenceBps: 0,
      partId: null,
      evidence: Object.freeze({ kind: 'derived-gap' as const, ref: `track:${input.trackId}` }),
    })),
  )

  const recorderSplits: Readonly<RecorderSplit>[] = []
  for (let index = 1; index < converted.length; index += 1) {
    const previous = converted[index - 1]!
    const next = converted[index]!
    const shared = intervalIntersection(previous.interval, next.interval)
    const kind: RecorderSplitKind = shared
      ? 'overlap'
      : next.interval.start === previous.interval.end
        ? 'contiguous'
        : 'gap'
    const measured = shared ?? (kind === 'gap'
      ? createTickInterval(
        previous.interval.end < next.interval.start ? previous.interval.end : next.interval.end,
        previous.interval.end < next.interval.start ? next.interval.start : previous.interval.start,
      )
      : null)
    // Spec 05 §13: a split is never concatenated on trust. A gap or an overlap
    // that nobody measured cannot be represented here at all.
    assertDomain(
      kind === 'contiguous' || measured !== null,
      'INVALID_ARGUMENT',
      `the split between ${previous.partId} and ${next.partId} is a ${kind} with no measured region`,
    )
    recorderSplits.push(Object.freeze({
      fromPartId: previous.partId,
      toPartId: next.partId,
      kind,
      boundaryTick: previous.interval.end,
      measured,
    }))
  }

  const coverage: Omit<TrackCoverage, 'coverageHash'> = {
    schemaVersion: TRACK_COVERAGE_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    trackId: input.trackId,
    derivedFrom: Object.freeze({ ...input.derivedFrom }),
    timebase: input.timebase,
    bounds,
    available: sortedAvailable,
    gaps,
    corrupt,
    unverified,
    overlaps: Object.freeze(
      [...decisions].sort((left, right) => {
        const byInterval = compareIntervals(left.interval, right.interval)
        return byInterval !== 0 ? byInterval : left.leftPartId.localeCompare(right.leftPartId)
      }),
    ),
    recorderSplits: Object.freeze(recorderSplits),
  }
  return Object.freeze({ ...coverage, coverageHash: calculateTrackCoverageHash(coverage) })
}

/**
 * Content address of the coverage.
 *
 * Ticks are serialized as decimal text because `bigint` has no JSON form and a
 * number would silently lose precision above 2^53 — which is precisely the range
 * a nanosecond timebase reaches inside a single session.
 */
export function calculateTrackCoverageHash(coverage: Omit<TrackCoverage, 'coverageHash'>): string {
  const interval = (entry: Readonly<CoverageInterval>) => ({
    interval: serializeTickInterval(entry.interval),
    availability: entry.availability,
    confidenceBps: entry.confidenceBps,
    partId: entry.partId,
    evidence: { kind: entry.evidence.kind, ref: entry.evidence.ref },
  })
  return calculateCanonicalHash({
    schemaVersion: coverage.schemaVersion,
    workspaceId: coverage.workspaceId,
    trackId: coverage.trackId,
    derivedFrom: {
      sessionId: coverage.derivedFrom.sessionId,
      sessionVersion: coverage.derivedFrom.sessionVersion,
      referenceEpoch: coverage.derivedFrom.referenceEpoch,
    },
    timebase: serializeRational(coverage.timebase.secondsPerTick),
    bounds: serializeTickInterval(coverage.bounds),
    available: coverage.available.map(interval),
    gaps: coverage.gaps.map(interval),
    corrupt: coverage.corrupt.map(interval),
    unverified: coverage.unverified.map(interval),
    overlaps: coverage.overlaps.map((entry) => ({
      leftPartId: entry.leftPartId,
      rightPartId: entry.rightPartId,
      interval: serializeTickInterval(entry.interval),
      resolution: entry.resolution,
      keepPartId: entry.keepPartId,
      decidedBy: entry.decidedBy,
      decidedAt: entry.decidedAt,
      note: entry.note,
    })),
    recorderSplits: coverage.recorderSplits.map((entry) => ({
      fromPartId: entry.fromPartId,
      toPartId: entry.toPartId,
      kind: entry.kind,
      boundaryTick: entry.boundaryTick.toString(),
      measured: entry.measured ? serializeTickInterval(entry.measured) : null,
    })),
  })
}

/**
 * Fail-closed rehydration. A stored coverage whose content no longer hashes to
 * its stored address was edited behind the aggregate and must not be served as
 * an answer to "may I cut here".
 */
export function assertTrackCoverageIntegrity(coverage: Readonly<TrackCoverage>): Readonly<TrackCoverage> {
  assertDomain(HASH.test(coverage.coverageHash), 'PERSISTENCE_CONFLICT', 'track coverage hash is malformed')
  assertDomain(
    calculateTrackCoverageHash(coverage) === coverage.coverageHash,
    'PERSISTENCE_CONFLICT',
    'track coverage hash does not match its stored content',
  )
  return coverage
}

/** What a range is being asked for. Each purpose trusts a different amount. */
export const COVERAGE_SELECTION_PURPOSES = Object.freeze(['auto-edit', 'manual-edit', 'analysis'] as const)
export type CoverageSelectionPurpose = (typeof COVERAGE_SELECTION_PURPOSES)[number]

function classify(coverage: Readonly<TrackCoverage>, uncovered: Readonly<TickInterval>): {
  code: 'CAPTURE_COVERAGE_UNVERIFIED' | 'CAPTURE_COVERAGE_NOT_AVAILABLE'
  reason: CoverageAvailability | 'out-of-bounds'
} {
  if (coverage.unverified.some((entry) => intervalsOverlap(entry.interval, uncovered))) {
    return { code: 'CAPTURE_COVERAGE_UNVERIFIED', reason: 'unverified' }
  }
  if (coverage.corrupt.some((entry) => intervalsOverlap(entry.interval, uncovered))) {
    return { code: 'CAPTURE_COVERAGE_NOT_AVAILABLE', reason: 'corrupt' }
  }
  if (coverage.gaps.some((entry) => intervalsOverlap(entry.interval, uncovered))) {
    return { code: 'CAPTURE_COVERAGE_NOT_AVAILABLE', reason: 'gap' }
  }
  return { code: 'CAPTURE_COVERAGE_NOT_AVAILABLE', reason: 'out-of-bounds' }
}

/**
 * The only sanctioned way to point an edit at this track.
 *
 * It refuses with the reason, not just a verdict: "gap" sends the operator to
 * another camera, "unverified" sends them to a probe, and "out-of-bounds" tells
 * them the session clock and this track disagree about when the recording
 * existed at all.
 */
export function assertCoverageSelectable(
  coverage: Readonly<TrackCoverage>,
  request: Readonly<{
    interval: Readonly<TickInterval>
    purpose: CoverageSelectionPurpose
    minimumConfidenceBps?: number
  }>,
): readonly Readonly<CoverageInterval>[] {
  assertDomain(
    COVERAGE_SELECTION_PURPOSES.includes(request.purpose),
    'INVALID_ARGUMENT',
    `${request.purpose} is not a coverage selection purpose`,
  )
  const usable: readonly Readonly<CoverageInterval>[] = request.purpose === 'analysis'
    ? sortIntervals([...coverage.available, ...coverage.unverified])
    : coverage.available

  const uncovered = intervalGaps(usable.map((entry) => entry.interval), request.interval)
  if (uncovered.length > 0) {
    const { code, reason } = classify(coverage, uncovered[0]!)
    throw new DomainError(
      code,
      `track ${coverage.trackId} has no usable coverage for the requested range: the first uncovered part of it is ${reason}`,
      {
        trackId: coverage.trackId,
        reason,
        purpose: request.purpose,
        requested: serializeTickInterval(request.interval),
        firstUncovered: serializeTickInterval(uncovered[0]!),
      },
    )
  }

  const covering = usable.filter((entry) => intervalsOverlap(entry.interval, request.interval))
  if (request.purpose === 'auto-edit') {
    const floorBps = request.minimumConfidenceBps ?? AUTO_EDIT_MINIMUM_CONFIDENCE_BPS
    assertConfidence(floorBps, 'minimumConfidenceBps')
    for (const entry of covering) {
      assertDomain(
        entry.confidenceBps >= floorBps,
        'CAPTURE_COVERAGE_UNVERIFIED',
        `track ${coverage.trackId} covers the requested range at ${entry.confidenceBps} bps, below the ${floorBps} bps an automatic cut requires`,
        { trackId: coverage.trackId, partId: entry.partId, confidenceBps: entry.confidenceBps },
      )
    }
  }
  return Object.freeze(covering.map((entry) => Object.freeze({ ...entry })))
}

/** True when the range can be cut to without a human confirming anything. */
export function isAutoEditable(
  coverage: Readonly<TrackCoverage>,
  interval: Readonly<TickInterval>,
  minimumConfidenceBps: number = AUTO_EDIT_MINIMUM_CONFIDENCE_BPS,
): boolean {
  try {
    assertCoverageSelectable(coverage, { interval, purpose: 'auto-edit', minimumConfidenceBps })
    return true
  } catch {
    return false
  }
}

/** Total ticks a track actually holds, for diagnostics that must not guess. */
export function coveredDuration(coverage: Readonly<TrackCoverage>): bigint {
  return coverage.available.reduce((total, entry) => total + intervalDuration(entry.interval), 0n)
}

/**
 * Refuse a coverage that was derived from a different session version.
 *
 * Changing the reference track mints a new version, so this is the check that
 * makes MS-06 — "referência muda ⇒ maps antigos invalidados" — a refusal rather
 * than a warning.
 */
export function assertCoverageDerivedFrom(
  coverage: Readonly<TrackCoverage>,
  expected: Readonly<CaptureSessionDerivationRef>,
): Readonly<TrackCoverage> {
  assertDomain(
    coverage.derivedFrom.sessionId === expected.sessionId &&
      coverage.derivedFrom.sessionVersion === expected.sessionVersion &&
      coverage.derivedFrom.referenceEpoch === expected.referenceEpoch,
    'CAPTURE_SESSION_DERIVATION_STALE',
    `track coverage for ${coverage.trackId} was derived from session version ${coverage.derivedFrom.sessionVersion} (reference epoch ${coverage.derivedFrom.referenceEpoch}) and cannot be used with version ${expected.sessionVersion} (reference epoch ${expected.referenceEpoch})`,
  )
  return coverage
}
