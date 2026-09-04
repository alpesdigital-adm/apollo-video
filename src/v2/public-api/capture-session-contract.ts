import type {
  CaptureSession,
  CaptureSessionClockPolicy,
  CaptureSessionLineage,
  CaptureTrack,
  CaptureTrackPart,
} from '../domain/capture-session.ts'
import { DomainError } from '../domain/errors.ts'
import type { PiecewiseClockMap } from '../domain/piecewise-clock-map.ts'
import {
  createTickInterval,
  createTimebase,
  rational,
  type Rational,
  type RoundingPolicy,
  type TickInterval,
  type Timebase,
} from '../domain/session-time.ts'
import type { SyncEvidenceRecord } from '../domain/sync-evidence.ts'
import type { TrackCoverage } from '../domain/track-coverage.ts'

/**
 * The public boundary for capture sessions (F4.002–F4.007).
 *
 * One rule shapes every function here: **ticks and rates cross as strings.**
 *
 * A JSON number is an IEEE 754 double in every mainstream parser. A double
 * represents every integer only up to 2^53, so a 64-bit tick would reach a
 * JavaScript client already rounded — no error raised, nothing to notice, and
 * two distinct instants comparing equal. Rates have the same problem for a
 * different reason: 30000/1001 has no finite decimal form at all, and a client
 * handed 29.97 could never recover the rate that was sent.
 *
 * So the wire carries `"108000000"` and `"30000/1001"`, and this module is the
 * only place that converts. Parsers reject anything that is not exactly a
 * decimal integer or an exact `num/den` pair, rather than coercing.
 */

const RATIONAL = /^([1-9][0-9]{0,18})\/([1-9][0-9]{0,18})$/
const TICK = /^-?[0-9]{1,19}$/

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown })
  }
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value.trim()
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null
  return text(value, field, maximum)
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new DomainError('INVALID_ARGUMENT', `${field} must be a boolean`)
  return value
}

function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is not one of ${allowed.join(', ')}`)
  }
  return value as T
}

/**
 * A tick, from its decimal string.
 *
 * `Number(value)` would accept `1e20`, `0x10` and `" 12 "`, all of which are
 * numbers and none of which is a tick a client meant to send. The regex first,
 * then `BigInt`, keeps a malformed value an error instead of a surprise.
 */
export function parseTickString(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !TICK.test(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a decimal integer string`)
  }
  return BigInt(value)
}

export function parseRationalString(value: unknown, field: string): Rational {
  if (typeof value !== 'string') {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a "num/den" string`)
  }
  const match = RATIONAL.exec(value)
  if (!match) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a "num/den" string with positive terms`)
  }
  return rational(BigInt(match[1]!), BigInt(match[2]!))
}

export function formatRational(value: Rational): string {
  return `${value.num}/${value.den}`
}

function parseTimebase(value: unknown, field: string): Readonly<Timebase> {
  return createTimebase(parseRationalString(value, field))
}

function parseInterval(value: unknown, field: string): Readonly<TickInterval> {
  const body = record(value, field)
  exactFields(body, ['start', 'end'], field)
  return createTickInterval(
    parseTickString(body.start, `${field}.start`),
    parseTickString(body.end, `${field}.end`),
  )
}

export function presentInterval(interval: Readonly<TickInterval>) {
  return Object.freeze({ start: interval.start.toString(), end: interval.end.toString() })
}

function parseLineage(value: unknown, field: string): Readonly<CaptureSessionLineage> {
  const body = record(value, field)
  exactFields(body, ['commandId', 'actorKind', 'actorId', 'note'], field)
  return Object.freeze({
    commandId: text(body.commandId, `${field}.commandId`, 128),
    // Filled in by the service, which knows which command it is running. A
    // caller-supplied operation could label an add-track as a create-session.
    operation: 'create-session' as CaptureSessionLineage['operation'],
    actorKind: member(body.actorKind, ['human', 'api-client', 'director'] as const, `${field}.actorKind`),
    actorId: text(body.actorId, `${field}.actorId`, 128),
    occurredAt: new Date(0).toISOString(),
    note: optionalText(body.note, `${field}.note`, 1024),
  })
}

function parseTrackPart(value: unknown, field: string): Readonly<CaptureTrackPart> {
  const body = record(value, field)
  exactFields(body, ['partId', 'ordinal', 'sourceAssetId', 'timebase', 'coverage',
    'streamIndex', 'splitReason', 'evidence'], field)
  const evidence = record(body.evidence, `${field}.evidence`)
  exactFields(evidence, ['ingestArtifactId', 'ingestSha256', 'probeHash', 'probeSource', 'observedAt'],
    `${field}.evidence`)
  return Object.freeze({
    partId: text(body.partId, `${field}.partId`, 128),
    ordinal: integer(body.ordinal, `${field}.ordinal`, 0, 100_000),
    sourceAssetId: text(body.sourceAssetId, `${field}.sourceAssetId`, 128),
    timebase: parseTimebase(body.timebase, `${field}.timebase`),
    coverage: parseInterval(body.coverage, `${field}.coverage`),
    streamIndex: integer(body.streamIndex, `${field}.streamIndex`, 0, 1_024),
    splitReason: member(body.splitReason, ['single-file', 'recorder-restart', 'file-size-limit',
      'card-change', 'clip-duration-limit', 'unknown'] as const, `${field}.splitReason`),
    evidence: Object.freeze({
      ingestArtifactId: text(evidence.ingestArtifactId, `${field}.evidence.ingestArtifactId`, 128),
      ingestSha256: text(evidence.ingestSha256, `${field}.evidence.ingestSha256`, 64),
      probeHash: text(evidence.probeHash, `${field}.evidence.probeHash`, 64),
      probeSource: member(evidence.probeSource,
        ['container-index', 'packet-scan', 'decoder-walk',
          'declared-metadata', 'operator-report'] as const,
        `${field}.evidence.probeSource`),
      observedAt: text(evidence.observedAt, `${field}.evidence.observedAt`, 64),
    }),
  })
}

function parseTrack(value: unknown, field: string): Readonly<CaptureTrack> {
  const body = record(value, field)
  exactFields(body, ['trackId', 'role', 'device', 'timebase', 'streamIndex',
    'syncAudioPolicy', 'includeInFinalMix', 'firstPart'], field)
  const device = record(body.device, `${field}.device`)
  exactFields(device, ['deviceId', 'recorderId', 'make', 'model', 'serial'], `${field}.device`)
  const firstPart = parseTrackPart(body.firstPart, `${field}.firstPart`)
  return Object.freeze({
    trackId: text(body.trackId, `${field}.trackId`, 128),
    role: member(body.role, ['camera-main', 'camera-alt', 'screen', 'phone', 'reaction',
      'reference-video', 'microphone', 'master-audio', 'scratch-audio'] as const, `${field}.role`),
    device: Object.freeze({
      deviceId: text(device.deviceId, `${field}.device.deviceId`, 128),
      recorderId: text(device.recorderId, `${field}.device.recorderId`, 128),
      make: optionalText(device.make, `${field}.device.make`, 128),
      model: optionalText(device.model, `${field}.device.model`, 128),
      serial: optionalText(device.serial, `${field}.device.serial`, 128),
    }),
    // The track's identity comes from its first part's source, so a caller
    // cannot name one asset and ship another.
    sourceAssetId: firstPart.sourceAssetId,
    timebase: parseTimebase(body.timebase, `${field}.timebase`),
    streamIndex: integer(body.streamIndex, `${field}.streamIndex`, 0, 1_024),
    syncAudioPolicy: member(body.syncAudioPolicy,
      ['available', 'none', 'sync-only', 'final-candidate'] as const, `${field}.syncAudioPolicy`),
    includeInFinalMix: boolean(body.includeInFinalMix, `${field}.includeInFinalMix`),
    parts: Object.freeze([firstPart]),
  })
}

function parseClockPolicy(value: unknown, field: string): Readonly<CaptureSessionClockPolicy> {
  const body = record(value, field)
  exactFields(body, ['timebase', 'rounding'], field)
  return Object.freeze({
    timebase: parseTimebase(body.timebase, `${field}.timebase`),
    rounding: member(body.rounding,
      ['nearest-half-even', 'floor', 'ceil'] as const, `${field}.rounding`) as RoundingPolicy,
  })
}

/**
 * The base a command was computed against: a version id and that version's
 * hash.
 *
 * Both, not either. A version number alone can be reused after a failed write;
 * a hash alone cannot say which link of the chain it belongs to. Requiring the
 * pair is what makes "this command was computed against a session that has
 * since moved" a refusal rather than an overwrite.
 */
export interface ParsedBaseVersion {
  readonly baseVersionId: string
  readonly baseHash: string
}

function parseBase(body: Record<string, unknown>): ParsedBaseVersion {
  return Object.freeze({
    baseVersionId: text(body.baseVersionId, 'baseVersionId', 160),
    baseHash: text(body.baseHash, 'baseHash', 64),
  })
}

export function parseCreateCaptureSessionBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(body, ['sessionId', 'clock', 'referenceTrack', 'lineage'], 'body')
  return Object.freeze({
    sessionId: text(body.sessionId, 'sessionId', 128),
    clock: parseClockPolicy(body.clock, 'clock'),
    referenceTrack: parseTrack(body.referenceTrack, 'referenceTrack'),
    lineage: parseLineage(body.lineage, 'lineage'),
  })
}

export function parseAddCaptureTrackBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash', 'track', 'lineage'], 'body')
  return Object.freeze({
    ...parseBase(body),
    track: parseTrack(body.track, 'track'),
    lineage: parseLineage(body.lineage, 'lineage'),
  })
}

export function parseAddCaptureTrackPartBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash', 'trackId', 'part', 'lineage'], 'body')
  return Object.freeze({
    ...parseBase(body),
    trackId: text(body.trackId, 'trackId', 128),
    part: parseTrackPart(body.part, 'part'),
    lineage: parseLineage(body.lineage, 'lineage'),
  })
}

export function parseChangeReferenceTrackBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash', 'referenceTrackId', 'lineage'], 'body')
  return Object.freeze({
    ...parseBase(body),
    referenceTrackId: text(body.referenceTrackId, 'referenceTrackId', 128),
    lineage: parseLineage(body.lineage, 'lineage'),
  })
}

export function parseRequestCaptureSyncBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash', 'force'], 'body')
  return Object.freeze({
    ...parseBase(body),
    force: body.force === undefined ? false : boolean(body.force, 'force'),
  })
}

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

function presentPart(part: Readonly<CaptureTrackPart>) {
  return Object.freeze({
    partId: part.partId,
    ordinal: part.ordinal,
    sourceAssetId: part.sourceAssetId,
    timebase: formatRational(part.timebase.secondsPerTick),
    coverage: presentInterval(part.coverage),
    streamIndex: part.streamIndex,
    splitReason: part.splitReason,
    evidence: Object.freeze({ ...part.evidence }),
  })
}

function presentTrack(track: Readonly<CaptureTrack>) {
  return Object.freeze({
    trackId: track.trackId,
    role: track.role,
    device: Object.freeze({ ...track.device }),
    sourceAssetId: track.sourceAssetId,
    timebase: formatRational(track.timebase.secondsPerTick),
    streamIndex: track.streamIndex,
    syncAudioPolicy: track.syncAudioPolicy,
    includeInFinalMix: track.includeInFinalMix,
    parts: Object.freeze(track.parts.map(presentPart)),
  })
}

export function presentCaptureSessionSummary(session: Readonly<CaptureSession>) {
  return Object.freeze({
    sessionId: session.sessionId,
    version: session.version,
    previousVersionHash: session.previousVersionHash,
    status: session.status,
    sessionHash: session.sessionHash,
    referenceTrackId: session.referenceTrackId,
    referenceEpoch: session.referenceEpoch,
    trackCount: session.tracks.length,
    staleDerivations: Object.freeze([...session.staleDerivations]),
  })
}

export function presentCaptureSession(session: Readonly<CaptureSession>) {
  return Object.freeze({
    sessionId: session.sessionId,
    projectId: session.projectId,
    version: session.version,
    previousVersionHash: session.previousVersionHash,
    status: session.status,
    clock: Object.freeze({
      timebase: formatRational(session.clock.timebase.secondsPerTick),
      rounding: session.clock.rounding,
    }),
    referenceTrackId: session.referenceTrackId,
    referenceEpoch: session.referenceEpoch,
    tracks: Object.freeze(session.tracks.map(presentTrack)),
    lineage: Object.freeze({ ...session.lineage }),
    staleDerivations: Object.freeze([...session.staleDerivations]),
    sessionHash: session.sessionHash,
    createdAt: session.createdAt,
  })
}

export function presentCaptureSessionVersion(session: Readonly<CaptureSession>) {
  return Object.freeze({
    version: session.version,
    previousVersionHash: session.previousVersionHash,
    sessionHash: session.sessionHash,
    operation: session.lineage.operation,
    actorKind: session.lineage.actorKind,
    actorId: session.lineage.actorId,
    occurredAt: session.lineage.occurredAt,
    note: session.lineage.note,
    staleDerivations: Object.freeze([...session.staleDerivations]),
  })
}

export function presentClockMap(map: Readonly<PiecewiseClockMap>) {
  return Object.freeze({
    sourceBounds: presentInterval(map.sourceBounds),
    uncovered: Object.freeze(map.uncovered.map(presentInterval)),
    pieces: Object.freeze(map.pieces.map((piece) => Object.freeze({
      pieceId: piece.pieceId,
      ordinal: piece.ordinal,
      sourceCoverage: presentInterval(piece.sourceCoverage),
      sessionCoverage: presentInterval(piece.sessionCoverage),
      rate: formatRational(piece.map.rate),
      offsetTicks: piece.map.offsetTicks.toString(),
      driftPpm: piece.driftPpm,
      confidence: piece.confidence,
      residualBoundTicks: piece.residualBoundTicks.toString(),
      openedBy: piece.openedBy,
      openedByDetail: piece.openedByDetail,
      anchorIds: Object.freeze([...piece.anchorIds]),
      evidenceRefs: Object.freeze([...piece.evidenceRefs]),
    }))),
  })
}

export function presentCoverage(coverage: Readonly<TrackCoverage>) {
  const covered = coverage.available.reduce(
    (total, span) => total + (span.interval.end - span.interval.start), BigInt(0))
  const gaps = coverage.gaps.reduce(
    (total, span) => total + (span.interval.end - span.interval.start), BigInt(0))
  const minConfidenceBps = coverage.available.length === 0
    ? 0
    : Math.min(...coverage.available.map((span) => span.confidenceBps))
  const unresolvedOverlaps = coverage.overlaps.filter(
    (overlap) => overlap.resolution === 'manual-review').length
  return Object.freeze({
    bounds: presentInterval(coverage.bounds),
    coveredTicks: covered.toString(),
    gapTicks: gaps.toString(),
    minConfidenceBps,
    autoEditable: minConfidenceBps >= 7_000 && unresolvedOverlaps === 0,
    unresolvedOverlaps,
  })
}

/**
 * One track's synchronization, as the API reports it.
 *
 * `map` is null exactly when the cascade could not tell. It is never an offset
 * of zero standing in for "we did not measure" — those are different answers,
 * and a client that cannot tell them apart will cut as if the tracks aligned.
 */
export function presentSyncTrack(input: {
  record: Readonly<SyncEvidenceRecord>
  map: Readonly<PiecewiseClockMap> | null
  coverage: Readonly<TrackCoverage> | null
}) {
  return Object.freeze({
    trackId: input.record.trackId,
    outcome: input.record.outcome,
    manualRequired: input.record.manualRequired,
    selectedMethod: input.record.selectedMethod,
    outcomeReasons: Object.freeze([...input.record.outcomeReasons]),
    map: input.map ? presentClockMap(input.map) : null,
    coverage: input.coverage ? presentCoverage(input.coverage) : null,
  })
}
