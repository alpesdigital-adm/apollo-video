import type {
  MulticamAngleCandidateListing,
  MulticamAngleCandidateWindow,
  MulticamDirectionRead,
  MulticamShotDecisionListing,
  DirectMulticamProtectedSelectionInput,
  DirectMulticamSessionServiceResult,
} from '../application/multicam-direction.ts'
import { DIRECTION_POLICY_OVERRIDE_KEYS } from '../application/multicam-direction.ts'
import { DomainError } from '../domain/errors.ts'
import {
  ANGLE_SCORE_COMPONENT_NAMES,
  OUTPUT_ASPECT_RATIOS,
  type AngleCandidate,
  type MulticamDirection,
  type ShotDecision,
} from '../domain/multicam-direction.ts'
import {
  boundedNumber,
  exactFields,
  identifier,
  member,
  presentInterval,
  presentOptionalInterval,
  record,
  sha256,
  text,
  tick,
} from './capture-derivation-contract.ts'

/**
 * The public boundary for multicamera direction (F4.012).
 *
 * The domain module already refuses a request that carries a derivation, by
 * name, at any nesting depth (`DIRECTION_FORBIDDEN_REQUEST_FIELDS`). This layer
 * does not repeat that scan — it would be a second list to keep in step with
 * the first — it narrows what can reach it: the parsers below build a request
 * out of exactly the fields a direction takes, so a body carrying `confidence`
 * is refused as an unknown field here and by name there if it ever arrives
 * through another door.
 *
 * What crosses, and in which shape:
 *
 * - **Ticks as decimal strings**, both ways. A shot boundary is a 64-bit tick.
 * - **Every measured number is nullable and stays null.** `syncConfidence`,
 *   `coverage.confidenceBps`, `technicalQuality` and the three evidence scores
 *   are absent when nobody measured them; publishing zero would say the
 *   measurement happened and came out worthless, which is the stronger claim
 *   and the wrong one.
 * - **The policy is published as the calibration's name plus the five numbers
 *   an operator may move.** The weights, the context baselines and the two
 *   floors are calibration, not preference; the service refuses a request that
 *   sets them, and publishing them beside the five would invite one.
 */

/** The five numbers a direction request may carry, and the calibration's name. */
function presentPolicy(direction: Readonly<MulticamDirection>) {
  return Object.freeze({
    schemaVersion: direction.policy.schemaVersion,
    calibrationVersion: direction.policy.calibrationVersion,
    ...Object.fromEntries(DIRECTION_POLICY_OVERRIDE_KEYS.map((key) => [key, direction.policy[key]])),
  }) as Readonly<{
    schemaVersion: string
    calibrationVersion: string
    minimumShotMs: number
    maxCutawayMs: number
    jumpCutSameAngleMs: number
    redundancyThreshold: number
    ambiguityMargin: number
  }>
}

function presentScoreComponents(candidate: Readonly<AngleCandidate>) {
  return Object.freeze({
    total: candidate.scoreComponents.total,
    ...Object.fromEntries(ANGLE_SCORE_COMPONENT_NAMES.map((name) => [
      name,
      Object.freeze({
        value: candidate.scoreComponents[name].value,
        evidenceRefs: candidate.scoreComponents[name].evidenceRefs,
      }),
    ])),
  })
}

export function presentAngleCandidate(candidate: Readonly<AngleCandidate>) {
  return Object.freeze({
    schemaVersion: candidate.schemaVersion,
    candidateId: candidate.candidateId,
    trackId: candidate.trackId,
    sourceAssetId: candidate.sourceAssetId,
    role: candidate.role,
    context: candidate.context,
    sessionRange: presentInterval(candidate.sessionRange),
    // Null when the clock map has no law for this window: the angle exists and
    // there is no source instant to cut from, which is a different answer from
    // "it starts at zero".
    sourceRange: presentOptionalInterval(candidate.sourceRange),
    sourcePieceId: candidate.sourcePieceId,
    sourcePartId: candidate.sourcePartId,
    sourcePartAssetId: candidate.sourcePartAssetId,
    coverage: Object.freeze({
      availability: candidate.coverage.availability,
      confidenceBps: candidate.coverage.confidenceBps,
    }),
    syncStatus: candidate.syncStatus,
    syncConfidence: candidate.syncConfidence,
    activeSpeaker: candidate.activeSpeaker === null ? null : Object.freeze({ ...candidate.activeSpeaker }),
    screenActivity: candidate.screenActivity === null ? null : Object.freeze({ ...candidate.screenActivity }),
    reaction: candidate.reaction === null ? null : Object.freeze({ ...candidate.reaction }),
    technicalQuality: candidate.technicalQuality === null
      ? null
      : Object.freeze({ ...candidate.technicalQuality }),
    continuity: Object.freeze({
      previousTrackId: candidate.continuity.previousTrackId,
      sameAngleTicks: candidate.continuity.sameAngleTicks.toString(),
      spatialRelation: candidate.continuity.spatialRelation,
    }),
    protectedSelection: candidate.protected === null ? null : Object.freeze({ ...candidate.protected }),
    eligible: candidate.eligible,
    rejectionReasons: candidate.rejectionReasons,
    score: presentScoreComponents(candidate),
    candidateHash: candidate.candidateHash,
  })
}

export function presentShotDecision(shot: Readonly<ShotDecision>) {
  return Object.freeze({
    schemaVersion: shot.schemaVersion,
    shotId: shot.shotId,
    ordinal: shot.ordinal,
    sessionRange: presentInterval(shot.sessionRange),
    chosen: presentAngleCandidate(shot.chosen),
    audioTrackId: shot.audioTrackId,
    alternatives: shot.alternatives.map((alternative) => Object.freeze({ ...alternative })),
    rule: shot.rule,
    reason: shot.reason,
    evidenceRefs: shot.evidenceRefs,
    // How many citations the 32-ref cap dropped. Zero means the list above is
    // everything the shot cited; without it a clipped citation reads complete.
    evidenceRefsTruncated: shot.evidenceRefsTruncated,
    confidence: shot.confidence,
    confidenceBand: shot.confidenceBand,
    decisionHash: shot.decisionHash,
  })
}

/**
 * The direction without its shots.
 *
 * The shots and the candidacies behind them are two separate reads for a
 * reason: a busy direction holds hundreds of shots, each carrying every track
 * that was evaluated over it with every part of its score. A caller asking "is
 * this session directed, and does it need review" is handed the answer, not the
 * evidence for every decision inside it.
 */
export function presentMulticamDirection(direction: Readonly<MulticamDirection>) {
  return Object.freeze({
    schemaVersion: direction.schemaVersion,
    sessionId: direction.sessionId,
    sessionVersion: direction.sessionVersion,
    referenceEpoch: direction.referenceEpoch,
    diagnosticVersion: direction.diagnosticVersion,
    diagnosticHash: direction.diagnosticHash,
    evidenceHash: direction.evidenceHash,
    range: presentInterval(direction.range),
    format: Object.freeze({ aspectRatio: direction.format.aspectRatio }),
    policy: presentPolicy(direction),
    audio: Object.freeze({
      trackId: direction.audio.trackId,
      rejected: direction.audio.rejected.map((entry) => Object.freeze({ ...entry })),
    }),
    shotCount: direction.shots.length,
    // Stretches no track was eligible for. Never bridged by a shot, and the
    // reason the compile step can refuse a direction that was still worth
    // storing.
    uncovered: direction.uncovered.map(presentInterval),
    warnings: direction.warnings.map((warning) => Object.freeze({ ...warning })),
    manualReviewRequired: direction.manualReviewRequired,
    generatedAt: direction.generatedAt,
    directionHash: direction.directionHash,
  })
}

export function presentMulticamDirectionRead(read: Readonly<MulticamDirectionRead>) {
  return Object.freeze({
    direction: presentMulticamDirection(read.direction),
    version: read.version,
    previousVersionHash: read.previousVersionHash,
    versionRef: read.versionRef,
    isHead: read.isHead,
  })
}

function presentCandidateWindow(window: Readonly<MulticamAngleCandidateWindow>) {
  return Object.freeze({
    shotId: window.shotId,
    ordinal: window.ordinal,
    sessionRange: presentInterval(window.sessionRange),
    rule: window.rule,
    chosenCandidateId: window.chosenCandidateId,
    candidates: window.candidates.map(presentAngleCandidate),
  })
}

export function presentAngleCandidateListing(listing: Readonly<MulticamAngleCandidateListing>) {
  return Object.freeze({
    ...presentMulticamDirectionRead(listing),
    windows: listing.windows.map(presentCandidateWindow),
    omittedWindows: listing.omittedWindows,
  })
}

export function presentShotDecisionListing(listing: Readonly<MulticamShotDecisionListing>) {
  return Object.freeze({
    ...presentMulticamDirectionRead(listing),
    shots: listing.shots.map(presentShotDecision),
    omittedShots: listing.omittedShots,
  })
}

/**
 * What a run produced, without repeating the plan the renderer will read.
 *
 * `direction` is null on a replay whose chain has moved past it: the Command
 * that comes back is still the one the first call produced, and handing back
 * today's head under it would be the wrong answer dressed as the right one.
 *
 * The compiled `DirectedEditPlan` is deliberately not republished here. It is
 * the project's plan, readable through the project's own capabilities under the
 * version id below, and copying it into this response would be a second copy
 * that nothing keeps in step with the first. What travels is the fence a caller
 * needs for its next command and the impact this one recorded.
 *
 * Typed as the fields it presents rather than the whole service result, so a
 * renamed field on the service is a compile error here and an example can be
 * built from the real command factory without also building a Director plan.
 */
type PresentableDirectedSession = Pick<
  DirectMulticamSessionServiceResult,
  'direction' | 'directionVersion' | 'version' | 'command' | 'impact' | 'evidenceReplayed'
>

export function presentDirectedSession(result: Readonly<PresentableDirectedSession>) {
  return Object.freeze({
    direction: result.direction === null ? null : presentMulticamDirection(result.direction),
    directionVersion: result.directionVersion,
    versionRef: result.direction === null || result.directionVersion === null
      ? null
      : `${result.direction.sessionId}:direction:v${result.directionVersion}`,
    projectVersion: Object.freeze({
      id: result.version.id,
      sequence: result.version.sequence,
      parentVersionId: result.version.parentVersionId,
      baseHash: result.version.baseHash,
      createdAt: result.version.createdAt,
    }),
    command: Object.freeze({
      id: result.command.id,
      type: result.command.type,
      impactHash: result.impact.impactHash,
      shotCount: result.impact.shotCount,
      manualReviewRequired: result.impact.manualReviewRequired,
    }),
    // What this cut made stale. Reported, never deleted: an artifact that is no
    // longer current is still the artifact somebody approved.
    invalidatedArtifacts: result.impact.affectedArtifacts.map((artifact) => Object.freeze({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      variantId: artifact.variantId,
      sourceVersionId: artifact.sourceVersionId,
    })),
    // The frames the impact says have to be recomputed. A range, not a flag:
    // "the whole timeline" and "the last twenty seconds" are different amounts
    // of render.
    affectedRanges: result.impact.affectedRanges.map((range) => Object.freeze({ ...range })),
    // True when the evidence set was already stored: the same observations for
    // the same session version are the same set, not a second opinion.
    evidenceReplayed: result.evidenceReplayed,
  })
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const RANGE_KEYS = Object.freeze(['sessionStartTicks', 'sessionEndTicks'] as const)
const SELECTION_KEYS = Object.freeze([
  'selectionId',
  'trackId',
  'sessionStartTicks',
  'sessionEndTicks',
  'note',
] as const)

export interface ParsedDirectMulticamSessionBody {
  readonly baseVersionId: string
  readonly baseHash: string
  readonly format: Readonly<{ aspectRatio: (typeof OUTPUT_ASPECT_RATIOS)[number] }>
  readonly range?: Readonly<{ sessionStartTicks: string; sessionEndTicks: string }>
  readonly policy?: Readonly<Record<string, number>>
  readonly protectedSelections?: readonly Readonly<DirectMulticamProtectedSelectionInput>[]
  readonly reason?: string
}

function parseRange(raw: unknown): Readonly<{ sessionStartTicks: string; sessionEndTicks: string }> {
  const range = record(raw, 'range')
  exactFields(range, RANGE_KEYS, 'range')
  const start = tick(range.sessionStartTicks, 'range.sessionStartTicks')
  const end = tick(range.sessionEndTicks, 'range.sessionEndTicks')
  if (start >= end) {
    throw new DomainError('INVALID_ARGUMENT', 'range.sessionStartTicks must be before range.sessionEndTicks')
  }
  // Handed on as the strings that arrived: the service parses them itself, and
  // a round trip through BigInt and back is one more place for the two to
  // disagree about what the caller wrote.
  return Object.freeze({
    sessionStartTicks: range.sessionStartTicks as string,
    sessionEndTicks: range.sessionEndTicks as string,
  })
}

function parsePolicy(raw: unknown): Readonly<Record<string, number>> {
  const policy = record(raw, 'policy')
  exactFields(policy, DIRECTION_POLICY_OVERRIDE_KEYS, 'policy')
  const entries = Object.entries(policy).map(([key, value]) => [
    key,
    boundedNumber(value, `policy.${key}`, 0, 3_600_000),
  ] as const)
  if (entries.length === 0) {
    throw new DomainError('INVALID_ARGUMENT', 'policy must carry at least one override')
  }
  return Object.freeze(Object.fromEntries(entries))
}

function parseProtectedSelection(raw: unknown, index: number): Readonly<DirectMulticamProtectedSelectionInput> {
  const selection = record(raw, `protectedSelections[${index}]`)
  exactFields(selection, SELECTION_KEYS, `protectedSelections[${index}]`)
  const start = tick(selection.sessionStartTicks, `protectedSelections[${index}].sessionStartTicks`)
  const end = tick(selection.sessionEndTicks, `protectedSelections[${index}].sessionEndTicks`)
  if (start >= end) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `protectedSelections[${index}].sessionStartTicks must be before its end`,
    )
  }
  return Object.freeze({
    selectionId: identifier(selection.selectionId, `protectedSelections[${index}].selectionId`),
    trackId: identifier(selection.trackId, `protectedSelections[${index}].trackId`),
    sessionStartTicks: selection.sessionStartTicks as string,
    sessionEndTicks: selection.sessionEndTicks as string,
    // The operator's own words. Who attested it is the authenticated actor, and
    // the service concatenates the two rather than letting either replace the
    // other.
    note: text(selection.note, `protectedSelections[${index}].note`, 400),
  })
}

function parseDirectionCore(
  body: Record<string, unknown>,
): Omit<ParsedDirectMulticamSessionBody, 'protectedSelections'> {
  return Object.freeze({
    baseVersionId: identifier(body.baseVersionId, 'baseVersionId'),
    baseHash: sha256(body.baseHash, 'baseHash'),
    format: Object.freeze({
      aspectRatio: member(
        record(body.format, 'format').aspectRatio,
        OUTPUT_ASPECT_RATIOS,
        'format.aspectRatio',
      ),
    }),
    ...(body.range === undefined ? {} : { range: parseRange(body.range) }),
    ...(body.policy === undefined ? {} : { policy: parsePolicy(body.policy) }),
    ...(body.reason === undefined ? {} : { reason: text(body.reason, 'reason', 400) }),
  })
}

export function parseDirectMulticamSessionBody(raw: unknown): ParsedDirectMulticamSessionBody {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash', 'format', 'range', 'policy', 'reason'], 'body')
  return parseDirectionCore(body)
}

/**
 * The same command with at least one protected selection on it.
 *
 * A separate body — and a separate endpoint — because protecting a selection is
 * a person overriding what the scorer measured, and the two differ in what they
 * require of the caller: this one refuses an empty list, so "protect this shot"
 * cannot silently become "re-cut the session". The safety rule on the two tools
 * differs for the same reason.
 */
export function parseProtectMulticamSelectionBody(raw: unknown): ParsedDirectMulticamSessionBody {
  const body = record(raw, 'body')
  exactFields(
    body,
    ['baseVersionId', 'baseHash', 'format', 'range', 'policy', 'protectedSelections', 'reason'],
    'body',
  )
  const selections = body.protectedSelections
  if (!Array.isArray(selections) || selections.length === 0 || selections.length > 32) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'protectedSelections must carry between one and thirty-two selections',
    )
  }
  return Object.freeze({
    ...parseDirectionCore(body),
    protectedSelections: Object.freeze(selections.map(parseProtectedSelection)),
  })
}
