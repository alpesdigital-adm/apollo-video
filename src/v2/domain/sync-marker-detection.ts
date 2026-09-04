import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  classifyDecodedPayload,
  visualPatternDurationMs,
  type MarkerPosition,
  type SyncMarker,
} from './sync-marker.ts'

/**
 * F4.010 — independent detection and fusion (FR-148).
 *
 * The rule this module exists to enforce: **the two channels never inform each
 * other.** Each detector produces its own payload read, its own instant and its
 * own error bound, from its own signal. Only then are they correlated.
 *
 * That is not fussiness. Two detectors that agree because one was told the
 * other's answer are one detector wearing a disguise, and the agreement — the
 * thing the whole marker exists to produce — becomes worthless. The type
 * system carries the rule: neither observation can reference the other, and
 * `fuseMarkerDetections` is the only function that sees both.
 *
 * The fusion refuses more than it accepts, on purpose. A marker that resolves
 * a session's whole timeline from one flash has to be certain it saw the right
 * flash, in the right session, at the right sequence, with both senses
 * agreeing about when.
 */

export const MARKER_DETECTION_SCHEMA_VERSION = 'sync-marker-detection/v1' as const

/** Why a single-channel observation was not usable. */
export const OBSERVATION_REJECTIONS = Object.freeze([
  'payload-unreadable',
  'foreign-session',
  'wrong-sequence',
  'checksum-mismatch',
  'below-confidence-floor',
  'pattern-mismatch',
] as const)
export type ObservationRejection = (typeof OBSERVATION_REJECTIONS)[number]

/**
 * What the visual detector found, alone.
 *
 * `decodedPayload` is null when the pattern was seen but the code could not be
 * read — a real and common case with a degraded or motion-blurred frame, and
 * one the fusion must be able to reason about rather than treat as absence.
 */
export interface VisualMarkerObservation {
  readonly channel: 'visual'
  readonly observationId: string
  readonly trackId: string
  /** Milliseconds into this track's own timeline. Never session time. */
  readonly atMs: number
  /** How far the instant could be off, from frame quantisation and search. */
  readonly errorMs: number
  readonly decodedPayload: string | null
  /** How well the observed frames matched the expected alternation, 0..1. */
  readonly patternScore: number
  readonly confidence: number
  readonly evidenceRef: string
}

/** What the audio detector found, alone. Same instant, unrelated measurement. */
export interface AudioMarkerObservation {
  readonly channel: 'audio'
  readonly observationId: string
  readonly trackId: string
  readonly atMs: number
  readonly errorMs: number
  /** Peak of the chirp correlation, and the runner-up that could have won. */
  readonly correlationPeak: number
  readonly secondPeak: number
  readonly confidence: number
  readonly evidenceRef: string
}

export const FUSION_MODES = Object.freeze(['both-channels', 'either-channel'] as const)
export type FusionMode = (typeof FUSION_MODES)[number]

export const FUSION_OUTCOMES = Object.freeze([
  'confirmed',
  'single-channel-only',
  'rejected',
] as const)
export type FusionOutcome = (typeof FUSION_OUTCOMES)[number]

export const FUSION_REJECTIONS = Object.freeze([
  'no-usable-observation',
  'visual-rejected',
  'audio-rejected',
  'channels-disagree-on-time',
  'ambiguous-audio-peak',
  'single-channel-not-permitted',
  // A marker was filmed here and nothing said which one.
  'identity-unverified',
  'foreign-session',
] as const)
export type FusionRejection = (typeof FUSION_REJECTIONS)[number]

export interface MarkerDetection {
  readonly schemaVersion: typeof MARKER_DETECTION_SCHEMA_VERSION
  readonly markerId: string
  readonly sessionId: string
  readonly trackId: string
  readonly position: MarkerPosition
  readonly mode: FusionMode
  readonly outcome: FusionOutcome
  /** Null unless the outcome is a rejection. */
  readonly rejection: FusionRejection | null
  /**
   * The marker instant on this track, in its own milliseconds. Null whenever
   * the outcome is a rejection — never a zero standing in for "unknown".
   */
  readonly atMs: number | null
  /**
   * The bound on that instant. For a confirmed audiovisual marker this is
   * sub-frame; for a spoken code it is deliberately coarse.
   */
  readonly errorMs: number | null
  readonly visualObservationId: string | null
  readonly audioObservationId: string | null
  readonly confidence: number
  /** Every reason the fusion reached this answer, in the order it found them. */
  readonly reasons: readonly string[]
  readonly detectionHash: string
}

/** Below this a single channel is noise dressed as a reading. */
const CONFIDENCE_FLOOR = 0.6
/** A peak that barely beats its runner-up could have picked either. */
const MINIMUM_PEAK_RATIO = 3
/**
 * How far apart the two channels may be and still be the same event.
 *
 * Sound travels roughly a foot per millisecond, so a camera ten metres from
 * the speaker legitimately hears the chirp about 30 ms after seeing the flash.
 * Anything past this is not acoustic delay, it is two different events.
 */
const MAX_CHANNEL_DISAGREEMENT_MS = 60

/**
 * The floor a spoken code can ever reach.
 *
 * A person reading a number has variable latency between deciding to speak and
 * making sound. Nothing downstream recovers it, so the fallback reports a
 * coarse bound rather than a precise one it cannot justify — spec 05 §15 is
 * explicit that frame accuracy must not be promised here.
 */
export const SPOKEN_CODE_MINIMUM_ERROR_MS = 120

function assertObservationShape(
  observation: Readonly<VisualMarkerObservation | AudioMarkerObservation>,
): void {
  assertDomain(
    Number.isFinite(observation.atMs) && observation.atMs >= 0,
    'INVALID_ARGUMENT',
    `${observation.channel} observation has an invalid instant`,
  )
  assertDomain(
    Number.isFinite(observation.errorMs) && observation.errorMs >= 0,
    'INVALID_ARGUMENT',
    `${observation.channel} observation has an invalid error bound`,
  )
  assertDomain(
    observation.confidence >= 0 && observation.confidence <= 1,
    'INVALID_ARGUMENT',
    `${observation.channel} observation confidence must be in [0,1]`,
  )
  assertDomain(
    observation.evidenceRef.trim().length > 0,
    'INVALID_ARGUMENT',
    `${observation.channel} observation must name evidence that can be re-opened`,
  )
}

/** Judge the visual channel on its own terms. */
export function judgeVisualObservation(
  marker: Readonly<SyncMarker>,
  observation: Readonly<VisualMarkerObservation>,
): Readonly<{ usable: boolean; rejection: ObservationRejection | null; reason: string }> {
  assertObservationShape(observation)
  if (observation.patternScore < 0.7) {
    return Object.freeze({
      usable: false,
      rejection: 'pattern-mismatch' as const,
      reason: `visual pattern matched only ${observation.patternScore.toFixed(2)} of the expected alternation`,
    })
  }
  if (observation.confidence < CONFIDENCE_FLOOR) {
    return Object.freeze({
      usable: false,
      rejection: 'below-confidence-floor' as const,
      reason: `visual confidence ${observation.confidence.toFixed(2)} is below the floor`,
    })
  }
  if (observation.decodedPayload === null) {
    // The pattern is there but the code is unreadable. Usable as a *time*, not
    // as an identity — which is why single-channel confirmation cannot rest on
    // it alone.
    return Object.freeze({
      usable: true,
      rejection: null,
      reason: 'visual pattern found; the code could not be read from these frames',
    })
  }
  const classified = classifyDecodedPayload(marker, observation.decodedPayload)
  if (classified.match) {
    return Object.freeze({ usable: true, rejection: null, reason: 'visual code decoded and matched the marker' })
  }
  const rejection: ObservationRejection = classified.reason === 'malformed'
    ? 'payload-unreadable'
    : classified.reason === 'foreign-session'
      ? 'foreign-session'
      : classified.reason === 'wrong-sequence'
        ? 'wrong-sequence'
        : 'checksum-mismatch'
  return Object.freeze({
    usable: false,
    rejection,
    reason: `visual code was rejected: ${classified.reason}`,
  })
}

/** Judge the audio channel on its own terms, knowing nothing of the visual. */
export function judgeAudioObservation(
  observation: Readonly<AudioMarkerObservation>,
): Readonly<{ usable: boolean; rejection: ObservationRejection | null; reason: string }> {
  assertObservationShape(observation)
  assertDomain(
    observation.correlationPeak >= 0 && observation.secondPeak >= 0,
    'INVALID_ARGUMENT',
    'audio correlation peaks cannot be negative',
  )
  if (observation.confidence < CONFIDENCE_FLOOR) {
    return Object.freeze({
      usable: false,
      rejection: 'below-confidence-floor' as const,
      reason: `audio confidence ${observation.confidence.toFixed(2)} is below the floor`,
    })
  }
  // A second peak of zero would make the ratio infinite, which is not a
  // measurement. Treat it as cleanly separated without inventing a number.
  const ratio = observation.secondPeak === 0
    ? Number.POSITIVE_INFINITY
    : observation.correlationPeak / observation.secondPeak
  if (ratio < MINIMUM_PEAK_RATIO) {
    return Object.freeze({
      usable: false,
      rejection: 'below-confidence-floor' as const,
      reason: `audio peak is only ${ratio.toFixed(1)}x the runner-up; the search could have picked either`,
    })
  }
  return Object.freeze({ usable: true, rejection: null, reason: 'chirp correlated cleanly above the ambiguity floor' })
}

/**
 * Correlate the two channels.
 *
 * The only function that sees both observations, and it sees them only after
 * each has already been judged alone.
 */
export function fuseMarkerDetections(input: {
  marker: Readonly<SyncMarker>
  trackId: string
  mode: FusionMode
  visual?: Readonly<VisualMarkerObservation>
  audio?: Readonly<AudioMarkerObservation>
}): Readonly<MarkerDetection> {
  assertDomain(
    input.visual !== undefined || input.audio !== undefined,
    'INVALID_ARGUMENT',
    'fusion needs at least one channel observation',
  )
  for (const observation of [input.visual, input.audio]) {
    if (observation) {
      assertDomain(
        observation.trackId === input.trackId,
        'INVALID_ARGUMENT',
        `${observation.channel} observation belongs to a different track`,
      )
    }
  }

  const reasons: string[] = []
  const visualVerdict = input.visual ? judgeVisualObservation(input.marker, input.visual) : null
  const audioVerdict = input.audio ? judgeAudioObservation(input.audio) : null
  if (visualVerdict) reasons.push(visualVerdict.reason)
  if (audioVerdict) reasons.push(audioVerdict.reason)

  const reject = (rejection: FusionRejection): Readonly<MarkerDetection> => finish({
    outcome: 'rejected',
    rejection,
    atMs: null,
    errorMs: null,
    confidence: 0,
  })

  function finish(result: {
    outcome: FusionOutcome
    rejection: FusionRejection | null
    atMs: number | null
    errorMs: number | null
    confidence: number
  }): Readonly<MarkerDetection> {
    const body = {
      schemaVersion: MARKER_DETECTION_SCHEMA_VERSION,
      markerId: input.marker.markerId,
      sessionId: input.marker.sessionId,
      trackId: input.trackId,
      position: input.marker.position,
      mode: input.mode,
      outcome: result.outcome,
      rejection: result.rejection,
      atMs: result.atMs,
      errorMs: result.errorMs,
      visualObservationId: result.outcome === 'rejected' ? null : (input.visual?.observationId ?? null),
      audioObservationId: result.outcome === 'rejected' ? null : (input.audio?.observationId ?? null),
      confidence: result.confidence,
      reasons: Object.freeze([...reasons]),
    }
    return Object.freeze({ ...body, detectionHash: calculateCanonicalHash(body) })
  }

  // A marker addressed to another session is the one rejection worth naming
  // separately: it means someone reused a card, and no amount of agreement
  // between channels makes it this session's marker.
  if (visualVerdict?.rejection === 'foreign-session') {
    reasons.push('the decoded code belongs to a different capture session')
    return reject('foreign-session')
  }

  const visualUsable = visualVerdict?.usable === true
  const audioUsable = audioVerdict?.usable === true

  if (!visualUsable && !audioUsable) return reject('no-usable-observation')

  if (input.mode === 'both-channels') {
    if (!visualUsable) return reject('visual-rejected')
    if (!audioUsable) return reject('audio-rejected')
    // Two channels corroborate the *instant*. Only one of them carries the
    // marker's *identity*: every marker of a session alternates the same way
    // and sweeps the same chirp, so without a decoded code "both channels
    // agree" says a marker was filmed here, not which one. A session with a
    // start marker and an after-restart marker would otherwise find either in
    // either file, confidently and wrongly.
    if (input.visual!.decodedPayload === null) {
      reasons.push('the code was unreadable, so nothing established which marker this is')
      return reject('identity-unverified')
    }
    const disagreement = Math.abs(input.visual!.atMs - input.audio!.atMs)
    if (disagreement > MAX_CHANNEL_DISAGREEMENT_MS) {
      reasons.push(`channels disagree by ${disagreement.toFixed(0)} ms, past what acoustic delay explains`)
      return reject('channels-disagree-on-time')
    }
    // The flash is the event; the chirp arrives later by the time sound takes
    // to cross the room. Taking the visual instant rather than the mean avoids
    // baking half the room's depth into every session's offset.
    const atMs = input.visual!.atMs
    const errorMs = Math.max(input.visual!.errorMs, disagreement)
    reasons.push(`both channels agree within ${disagreement.toFixed(0)} ms`)
    return finish({
      outcome: 'confirmed',
      rejection: null,
      atMs,
      errorMs: input.marker.kind === 'spoken-code'
        ? Math.max(errorMs, SPOKEN_CODE_MINIMUM_ERROR_MS)
        : errorMs,
      confidence: Math.min(input.visual!.confidence, input.audio!.confidence),
    })
  }

  // either-channel: usable for a session that could only ever produce one.
  if (visualUsable && input.visual!.decodedPayload === null && !audioUsable) {
    // A pattern with no readable code, alone, cannot say *which* marker it is.
    reasons.push('an unreadable code cannot identify the marker on its own')
    return reject('single-channel-not-permitted')
  }
  const chosen = visualUsable ? input.visual! : input.audio!
  const baseError = visualUsable ? input.visual!.errorMs : input.audio!.errorMs
  return finish({
    outcome: 'single-channel-only',
    rejection: null,
    atMs: chosen.atMs,
    errorMs: input.marker.kind === 'spoken-code'
      ? Math.max(baseError, SPOKEN_CODE_MINIMUM_ERROR_MS)
      : baseError,
    // One channel is one opinion. It is usable and it is not confirmation, so
    // the confidence is capped below anything the fusion calls confirmed.
    confidence: Math.min(chosen.confidence, 0.75),
  })
}

export function assertMarkerDetectionIntegrity(detection: Readonly<MarkerDetection>): Readonly<MarkerDetection> {
  assertDomain(
    detection.schemaVersion === MARKER_DETECTION_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored marker detection schema is invalid',
  )
  const { detectionHash, ...body } = detection
  assertDomain(
    calculateCanonicalHash(body) === detectionHash,
    'PERSISTENCE_CONFLICT',
    'stored marker detection hash does not match its body',
  )
  return detection
}

/**
 * The offset a confirmed marker implies between a track and the reference.
 *
 * Both instants are in their own track's milliseconds; the difference is what
 * aligns them. Refused unless both detections actually resolved — subtracting
 * a null would produce a number, and that number would be a lie.
 */
export function offsetBetweenDetections(input: {
  reference: Readonly<MarkerDetection>
  target: Readonly<MarkerDetection>
}): Readonly<{ offsetMs: number; errorMs: number }> {
  assertDomain(
    input.reference.atMs !== null && input.target.atMs !== null,
    'INVALID_ARGUMENT',
    'an offset needs two resolved detections; a rejected detection has no instant to subtract',
  )
  assertDomain(
    input.reference.markerId === input.target.markerId,
    'INVALID_ARGUMENT',
    'an offset must be measured from the same marker on both tracks',
  )
  return Object.freeze({
    offsetMs: input.reference.atMs! - input.target.atMs!,
    // Errors add: the uncertainty of a difference is the sum of the
    // uncertainties, never the larger of the two.
    errorMs: (input.reference.errorMs ?? 0) + (input.target.errorMs ?? 0),
  })
}

/** The expected duration of a marker's visual pattern, for a detector's window. */
export function expectedVisualWindowMs(marker: Readonly<SyncMarker>): number {
  return visualPatternDurationMs(marker.visual)
}
