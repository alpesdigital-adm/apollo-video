import {
  captureSessionDerivationRef,
  type CaptureSession,
  type CaptureTrack,
  type CaptureTrackPart,
  type TrackPartProbeSource,
} from '../domain/capture-session.ts'
import { assertDomain } from '../domain/errors.ts'
import { convertTick, createTickInterval, type TickInterval } from '../domain/session-time.ts'
import {
  AUTO_EDIT_MINIMUM_CONFIDENCE_BPS,
  createTrackCoverage,
  type CoverageClaim,
  type CoverageDefect,
  type CoverageEvidenceKind,
  type TrackCoverage,
} from '../domain/track-coverage.ts'

/**
 * F4.005 at runtime — turning a session's parts into the coverage the Director
 * consults before it is allowed to cut (map §19.2).
 *
 * `createTrackCoverage` has existed since Wave 18 and nothing in production ever
 * called it, so `coverageBps` was `null` on every diagnostic and
 * `coverage-below-floor` could not fire. This module is the missing producer,
 * and the interesting decision in it is not the conversion — it is what a part
 * is worth as evidence.
 *
 * A recorder's own container index is a strong claim: something read the file.
 * A duration copied from a sidecar, or typed in by whoever carried the card, is
 * a *report* about a file nobody opened. Both arrive here as intervals of
 * exactly the same shape, and treating them alike is how an unverified range
 * ends up in an automatic cut. So the probe source decides two things at once:
 * how much confidence the claim carries, and whether the range is admitted as
 * `available` at all.
 */

/**
 * What each probe source is worth, and whether it counts as having opened the
 * file. Named because the numbers are policy: they are argued about, tuned and
 * cited, and a literal buried in a mapping cannot be any of those.
 */
export const COVERAGE_CONFIDENCE_POLICY = Object.freeze({
  /**
   * Every frame was decoded. Nothing short of re-encoding knows more about
   * where the media actually is.
   */
  'decoder-walk': Object.freeze({
    evidenceKind: 'decoder-walk' as CoverageEvidenceKind,
    confidenceBps: 10_000,
    verified: true,
  }),
  /** Every packet was read but not decoded: timestamps trusted, pictures not. */
  'packet-scan': Object.freeze({
    evidenceKind: 'packet-scan' as CoverageEvidenceKind,
    confidenceBps: 9_500,
    verified: true,
  }),
  /**
   * The container's own index was read. It is written by the recorder and is
   * usually right, and it is exactly what a truncated file lies about.
   */
  'container-index': Object.freeze({
    evidenceKind: 'container-index' as CoverageEvidenceKind,
    confidenceBps: 8_000,
    verified: true,
  }),
  /** A duration someone declared. Nobody opened the media. */
  'declared-metadata': Object.freeze({
    evidenceKind: 'declared-metadata' as CoverageEvidenceKind,
    confidenceBps: 3_000,
    verified: false,
  }),
  /** An operator's note. Auditable, human, and not a measurement. */
  'operator-report': Object.freeze({
    evidenceKind: 'operator-report' as CoverageEvidenceKind,
    confidenceBps: 2_000,
    verified: false,
  }),
} satisfies Record<TrackPartProbeSource, Readonly<{
  evidenceKind: CoverageEvidenceKind
  confidenceBps: number
  verified: boolean
}>>)

/**
 * The policy's own invariant, checked when the module loads rather than trusted.
 *
 * "A part nobody probed cannot be auto-edited" is only true while the numbers
 * above stay below the floor F4.005 publishes. Someone raising
 * `declared-metadata` to 8 000 in a hurry would silently re-open automatic
 * cutting over unopened files, and no test of *this* module would notice —
 * the failure would surface three modules downstream as a bad edit.
 */
for (const [source, entry] of Object.entries(COVERAGE_CONFIDENCE_POLICY)) {
  assertDomain(
    entry.verified
      ? entry.confidenceBps >= AUTO_EDIT_MINIMUM_CONFIDENCE_BPS
      : entry.confidenceBps < AUTO_EDIT_MINIMUM_CONFIDENCE_BPS,
    'INVALID_ARGUMENT',
    `coverage confidence policy for ${source} contradicts the ${AUTO_EDIT_MINIMUM_CONFIDENCE_BPS} bps auto-edit floor`,
  )
}

/**
 * Widen a part's interval into the coverage clock.
 *
 * The opposite rounding to `createTrackCoverage`'s claim conversion, and
 * deliberately so. A claim narrows so it can never assert a tick the file did
 * not hold; a defect widens so it can never leave a sliver of an unprobed part
 * looking available. The domain clips defects back to the claims, so widening
 * cannot invent coverage — it can only fail to leave a hole uncovered.
 */
function widenIntoCoverageTimebase(
  part: Readonly<CaptureTrackPart>,
  track: Readonly<CaptureTrack>,
): Readonly<TickInterval> {
  return createTickInterval(
    convertTick({ tick: part.coverage.start, from: part.timebase, to: track.timebase, rounding: 'floor' }),
    convertTick({ tick: part.coverage.end, from: part.timebase, to: track.timebase, rounding: 'ceil' }),
  )
}

export interface DeriveTrackCoverageInput {
  readonly session: Readonly<CaptureSession>
  readonly track: Readonly<CaptureTrack>
}

/**
 * One track's coverage, derived from the session that holds it.
 *
 * Everything here comes from the parts: the hull, the gaps between files and
 * the ranges nobody probed. Nothing is declared by a caller, which is the point
 * — a coverage a caller could supply is a coverage a caller could widen.
 *
 * Gaps are not passed in either. `createTrackCoverage` derives them from the
 * claims, so a card change that lost eleven seconds appears as an eleven-second
 * gap whether or not anybody noticed it at ingest.
 */
export function deriveTrackCoverage(input: DeriveTrackCoverageInput): Readonly<TrackCoverage> {
  const { session, track } = input
  const ordered = [...track.parts].sort((left, right) => left.ordinal - right.ordinal)

  const claims: Readonly<CoverageClaim>[] = ordered.map((part) => {
    const policy = COVERAGE_CONFIDENCE_POLICY[part.evidence.probeSource]
    return Object.freeze({
      partId: part.partId,
      ordinal: part.ordinal,
      timebase: part.timebase,
      interval: part.coverage,
      confidenceBps: policy.confidenceBps,
      // The probe hash, not the probe payload: it is what lets the interval be
      // re-derived from the same file and compared against this claim.
      evidence: Object.freeze({ kind: policy.evidenceKind, ref: part.evidence.probeHash }),
    })
  })

  // A part whose interval was declared rather than measured is `unverified`,
  // not `available` with a low number. The distinction is the one F4.005 is
  // built on: an unprobed range is not a range that happens to be fine, and
  // `assertCoverageSelectable(..., 'auto-edit')` must refuse it by shape rather
  // than by comparison.
  const defects: Readonly<CoverageDefect>[] = ordered
    .filter((part) => !COVERAGE_CONFIDENCE_POLICY[part.evidence.probeSource].verified)
    .map((part) => Object.freeze({
      availability: 'unverified' as const,
      interval: widenIntoCoverageTimebase(part, track),
      evidence: Object.freeze({
        kind: COVERAGE_CONFIDENCE_POLICY[part.evidence.probeSource].evidenceKind,
        ref: part.evidence.probeHash,
      }),
    }))

  return createTrackCoverage({
    workspaceId: session.workspaceId,
    trackId: track.trackId,
    derivedFrom: captureSessionDerivationRef(session),
    timebase: track.timebase,
    claims,
    defects,
  })
}
