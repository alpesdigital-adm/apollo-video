import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

/**
 * F4.010 — the Apollo Sync Marker (FR-148, spec 05 §15).
 *
 * One event that two unrelated recorders can both witness: a flash the camera
 * sees, a chirp the microphone hears, and a visual code carrying the payload
 * so that *which* marker was seen is decidable rather than assumed.
 *
 * The payload is what makes this more than a clapperboard. A clap gives you an
 * instant; it does not tell you whose session it belongs to, whether it was
 * the first or the third, or whether the file has been tampered with. Every
 * detection here can be checked against a session code, a sequence number and
 * a checksum, so a marker from yesterday's shoot cannot align today's.
 *
 * Two rules the module refuses to bend:
 *
 * **The audio and visual channels never inform each other.** A detector that
 * knew what the other found would confirm it, and two detectors that agree
 * because one was told the answer are one detector wearing a disguise. They
 * are correlated only after both have independently produced a payload, a
 * time and an error bound.
 *
 * **Frame accuracy is never promised for the spoken-code fallback.** A person
 * reading a number has human latency between intent and sound, and no amount
 * of processing recovers it. The fallback reports a coarser bound and says so.
 */

export const SYNC_MARKER_SCHEMA_VERSION = 'sync-marker/v1' as const

/** Where in the session a marker was emitted. Each answers a different question. */
export const MARKER_POSITIONS = Object.freeze(['start', 'end', 'after-restart'] as const)
export type MarkerPosition = (typeof MARKER_POSITIONS)[number]

/**
 * How the marker was produced.
 *
 * `audiovisual` is the real thing. `spoken-code` is the fallback for a shoot
 * with no way to play a chirp, and it is deliberately a different kind rather
 * than the same kind with a lower score — the difference is not confidence,
 * it is what the measurement can mean.
 */
export const MARKER_KINDS = Object.freeze(['audiovisual', 'spoken-code'] as const)
export type MarkerKind = (typeof MARKER_KINDS)[number]

/**
 * The visual pattern, in frames.
 *
 * Alternating full-black and full-white frames rather than a single flash: one
 * bright frame is indistinguishable from a light being switched on, a camera
 * flash across the room, or a cut in the screen recording. A specific
 * alternation is something a room does not produce by accident.
 */
/**
 * The visual half of a marker.
 *
 * A stated limit: the code is read by cropping a `codeSizePx` square from the
 * centre of the frame at exactly that pixel size, so the marker has to reach
 * the recorder at its native scale — played full-frame on a screen, or
 * composited. Filmed smaller or larger, the flash is still unmistakable but
 * the code is not readable, and the detector reports that rather than guessing.
 * A recording in that state can still be timed; it cannot prove *which* marker
 * it saw, and the fusion refuses to confirm on that basis.
 */
export interface MarkerVisualSpec {
  readonly patternFrames: readonly ('black' | 'white')[]
  readonly frameRateNum: number
  readonly frameRateDen: number
  /** Side of the square visual code, in pixels. */
  readonly codeSizePx: number
}

/**
 * The chirp, in hertz.
 *
 * A linear sweep, not a tone. A tone at 1 kHz collides with speech, music and
 * mains hum; a sweep across a known band correlates sharply against itself and
 * poorly against everything else, which is exactly what a detector needs.
 */
export interface MarkerAudioSpec {
  readonly startHz: number
  readonly endHz: number
  readonly durationMs: number
  readonly sampleRate: number
}

export interface SyncMarker {
  readonly schemaVersion: typeof SYNC_MARKER_SCHEMA_VERSION
  readonly markerId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly kind: MarkerKind
  readonly position: MarkerPosition
  /** 1-based, monotonic within a session. Distinguishes repeated markers. */
  readonly sequence: number
  /** Short code shown on screen and, in the fallback, read aloud. */
  readonly sessionCode: string
  /** The instant the emitting device believed it was. Never authoritative. */
  readonly emittedAt: string
  readonly visual: Readonly<MarkerVisualSpec>
  readonly audio: Readonly<MarkerAudioSpec>
  /** The exact string encoded in the visual code and checked on detection. */
  readonly payload: string
  /** Covers the payload. A tampered payload fails before it aligns anything. */
  readonly checksum: string
  readonly markerHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
/** Unambiguous when read aloud or OCR'd: no O/0, I/1, S/5 confusion. */
const SESSION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789'
const SESSION_CODE = /^[ABCDEFGHJKLMNPQRTUVWXY2346789]{6}$/

/** The canonical audiovisual specification. Changing it is a schema change. */
export const DEFAULT_MARKER_VISUAL: Readonly<MarkerVisualSpec> = Object.freeze({
  patternFrames: Object.freeze(['white', 'black', 'white', 'black', 'white'] as const),
  frameRateNum: 30,
  frameRateDen: 1,
  codeSizePx: 240,
})

export const DEFAULT_MARKER_AUDIO: Readonly<MarkerAudioSpec> = Object.freeze({
  startHz: 1_000,
  endHz: 4_000,
  durationMs: 200,
  sampleRate: 48_000,
})

/**
 * Derive a session code from the session id.
 *
 * Deterministic so the same session always shows the same code — an operator
 * comparing the code on screen against the one in the app must not see it
 * change between takes — and short enough to be read aloud in the fallback.
 */
export function deriveSessionCode(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest()
  let code = ''
  for (let index = 0; index < 6; index += 1) {
    code += SESSION_CODE_ALPHABET[digest[index]! % SESSION_CODE_ALPHABET.length]
  }
  return code
}

/**
 * The string carried by the visual code.
 *
 * Field-separated and fixed-order so a detector that recovers a partial read
 * can still tell which field it lost, and so the checksum covers exactly what
 * was displayed.
 */
export function markerPayload(input: {
  sessionCode: string
  sequence: number
  position: MarkerPosition
  emittedAt: string
}): string {
  return [
    'APOLLO1',
    input.sessionCode,
    String(input.sequence).padStart(3, '0'),
    input.position,
    input.emittedAt,
  ].join('|')
}

export function markerChecksum(payload: string): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

export function createSyncMarker(input: {
  markerId: string
  workspaceId: string
  sessionId: string
  kind: MarkerKind
  position: MarkerPosition
  sequence: number
  emittedAt: string
  visual?: Readonly<MarkerVisualSpec>
  audio?: Readonly<MarkerAudioSpec>
}): Readonly<SyncMarker> {
  assertDomain(ID.test(input.markerId), 'INVALID_ARGUMENT', 'markerId is not a canonical identifier')
  assertDomain(ID.test(input.workspaceId), 'INVALID_ARGUMENT', 'workspaceId is not a canonical identifier')
  assertDomain(ID.test(input.sessionId), 'INVALID_ARGUMENT', 'sessionId is not a canonical identifier')
  assertDomain(MARKER_KINDS.includes(input.kind), 'INVALID_ARGUMENT', `${input.kind} is not a marker kind`)
  assertDomain(
    MARKER_POSITIONS.includes(input.position),
    'INVALID_ARGUMENT',
    `${input.position} is not a marker position`,
  )
  assertDomain(
    Number.isSafeInteger(input.sequence) && input.sequence >= 1 && input.sequence <= 999,
    'INVALID_ARGUMENT',
    'a marker sequence is between 1 and 999',
  )
  assertDomain(
    Number.isFinite(Date.parse(input.emittedAt)) && new Date(input.emittedAt).toISOString() === input.emittedAt,
    'INVALID_ARGUMENT',
    'emittedAt must be a canonical ISO instant',
  )

  const visual = input.visual ?? DEFAULT_MARKER_VISUAL
  const audio = input.audio ?? DEFAULT_MARKER_AUDIO
  // A single frame is not a pattern. Two alternations are the minimum that a
  // room light or a scene cut cannot imitate by accident.
  assertDomain(
    visual.patternFrames.length >= 3,
    'INVALID_ARGUMENT',
    'a visual marker pattern needs at least three frames to be distinguishable from a light switching on',
  )
  assertDomain(
    visual.frameRateNum > 0 && visual.frameRateDen > 0 && visual.codeSizePx >= 64,
    'INVALID_ARGUMENT',
    'the visual specification is not usable',
  )
  // A sweep, not a tone: a constant frequency collides with speech and mains
  // hum, and correlates against them almost as well as against itself.
  assertDomain(
    audio.endHz > audio.startHz,
    'INVALID_ARGUMENT',
    'the chirp must sweep upward; a constant tone correlates against speech nearly as well as against itself',
  )
  assertDomain(
    audio.startHz >= 200 && audio.endHz <= audio.sampleRate / 2,
    'INVALID_ARGUMENT',
    'the chirp must stay above rumble and below the Nyquist limit of its sample rate',
  )
  assertDomain(
    audio.durationMs >= 50 && audio.durationMs <= 2_000,
    'INVALID_ARGUMENT',
    'the chirp duration is outside the usable range',
  )

  const sessionCode = deriveSessionCode(input.sessionId)
  const payload = markerPayload({
    sessionCode,
    sequence: input.sequence,
    position: input.position,
    emittedAt: input.emittedAt,
  })
  const body = {
    schemaVersion: SYNC_MARKER_SCHEMA_VERSION,
    markerId: input.markerId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    kind: input.kind,
    position: input.position,
    sequence: input.sequence,
    sessionCode,
    emittedAt: input.emittedAt,
    visual: Object.freeze({ ...visual, patternFrames: Object.freeze([...visual.patternFrames]) }),
    audio: Object.freeze({ ...audio }),
    payload,
    checksum: markerChecksum(payload),
  }
  return Object.freeze({ ...body, markerHash: calculateCanonicalHash(body) })
}

export function assertSyncMarkerIntegrity(marker: Readonly<SyncMarker>): Readonly<SyncMarker> {
  assertDomain(
    marker.schemaVersion === SYNC_MARKER_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored sync marker schema is invalid',
  )
  // The checksum is re-derived rather than trusted: a payload edited in place
  // with its checksum updated to match would still fail the outer hash, but
  // checking both says *which* was tampered with.
  assertDomain(
    markerChecksum(marker.payload) === marker.checksum,
    'SYNC_MARKER_CHECKSUM_INVALID',
    'stored sync marker payload does not match its checksum',
  )
  assertDomain(
    SESSION_CODE.test(marker.sessionCode),
    'PERSISTENCE_CONFLICT',
    'stored sync marker session code is malformed',
  )
  const { markerHash, ...body } = marker
  assertDomain(
    calculateCanonicalHash(body) === markerHash,
    'PERSISTENCE_CONFLICT',
    'stored sync marker hash does not match its body',
  )
  return marker
}

/**
 * Whether a decoded payload belongs to this marker.
 *
 * Checks the session, the sequence and the checksum separately so a rejection
 * can say which one failed — "a marker from another session" and "a corrupted
 * read of the right marker" call for completely different actions from an
 * operator.
 */
export function classifyDecodedPayload(
  marker: Readonly<SyncMarker>,
  decoded: string,
): Readonly<
  | { match: true }
  | { match: false; reason: 'malformed' | 'foreign-session' | 'wrong-sequence' | 'checksum-mismatch' }
> {
  const parts = decoded.split('|')
  if (parts.length !== 5 || parts[0] !== 'APOLLO1') {
    return Object.freeze({ match: false as const, reason: 'malformed' as const })
  }
  if (parts[1] !== marker.sessionCode) {
    return Object.freeze({ match: false as const, reason: 'foreign-session' as const })
  }
  if (parts[2] !== String(marker.sequence).padStart(3, '0')) {
    return Object.freeze({ match: false as const, reason: 'wrong-sequence' as const })
  }
  if (markerChecksum(decoded) !== marker.checksum) {
    return Object.freeze({ match: false as const, reason: 'checksum-mismatch' as const })
  }
  return Object.freeze({ match: true as const })
}

/** Total duration of the visual pattern, in milliseconds. */
export function visualPatternDurationMs(visual: Readonly<MarkerVisualSpec>): number {
  return Math.round((visual.patternFrames.length * 1_000 * visual.frameRateDen) / visual.frameRateNum)
}
