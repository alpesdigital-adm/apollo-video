import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  createTickInterval,
  rationalEquals,
  ROUNDING_POLICIES,
  serializeRational,
  serializeTickInterval,
  type RoundingPolicy,
  type Timebase,
  type TickInterval,
} from './session-time.ts'
import type { CaptureSessionDerivationRef } from './track-coverage.ts'

/**
 * F4.002 — the recorded event, before anybody has decided what it means.
 *
 * A capture session is the inventory of everything that was pointed at one
 * event: cameras, a screen grab, a phone, a lapel mic, the recorder's separate
 * master. It is deliberately *not* the sync result. Its whole job is to hold the
 * raw facts — which device, which file, which clock, which ticks — so that the
 * strategies in F4.003–F4.008 have something honest to disagree with.
 *
 * Three properties make that work:
 *
 * **Original clocks survive.** Every track keeps the rational timebase the
 * recorder wrote, and every part keeps its own, because a recorder that restarts
 * can come back in a different one. Nothing here normalizes them into a session
 * clock; that is a mapping, and a mapping is evidence-bearing work that belongs
 * downstream. Spec 05 invariant 1 is "preserve PTS/timebase before normalizing",
 * and the only way to guarantee it is to never have a setter for it.
 *
 * **Adding a source after ingest is a new version, never a mutation.** A camera
 * discovered on somebody's phone two hours into the edit changes what the
 * session is. If that were an in-place edit, every plan derived from the older
 * session would silently start describing a different event. Instead each
 * operation returns a new immutable version, chained by hash, carrying the
 * command that caused it.
 *
 * **Changing the reference track is the loudest operation in the file.** The
 * reference is the clock everything else is measured against, so replacing it
 * invalidates every map derived from the old one. It bumps `referenceEpoch`,
 * names the derivations that just went stale and refuses to leave the session
 * claiming `synced`. Spec 05 MS-06 asks for exactly this, and asking politely
 * would not have been enough.
 */

export const CAPTURE_SESSION_SCHEMA_VERSION = 'capture-session/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

/**
 * The roles a source can play. These are editorial functions, not file types:
 * `scratch-audio` and `master-audio` are the same bytes-shaped thing and must
 * never be interchangeable, because one is allowed to reach the final mix and
 * the other exists only to line clocks up (spec 05 invariant 6).
 */
export const CAPTURE_TRACK_ROLES = Object.freeze([
  'camera-main',
  'camera-alt',
  'screen',
  'phone',
  'reaction',
  'reference-video',
  'microphone',
  'master-audio',
  'scratch-audio',
] as const)
export type CaptureTrackRole = (typeof CAPTURE_TRACK_ROLES)[number]

/** Roles whose audio can legitimately end up in the delivered mix. */
const FINAL_MIX_ELIGIBLE_ROLES: readonly CaptureTrackRole[] = Object.freeze([
  'camera-main',
  'camera-alt',
  'phone',
  'reaction',
  'microphone',
  'master-audio',
])

export const CAPTURE_SESSION_STATUSES = Object.freeze([
  'draft',
  'analyzing',
  'needs-input',
  'synced',
  'partial',
  'failed',
] as const)
export type CaptureSessionStatus = (typeof CAPTURE_SESSION_STATUSES)[number]

/** Whether a track's audio can carry sync evidence, final content, or neither. */
export const SYNC_AUDIO_POLICIES = Object.freeze([
  'available',
  'none',
  'sync-only',
  'final-candidate',
] as const)
export type SyncAudioPolicy = (typeof SYNC_AUDIO_POLICIES)[number]

/** Why a track is spread across more than one file. */
export const TRACK_PART_SPLIT_REASONS = Object.freeze([
  'single-file',
  'recorder-restart',
  'file-size-limit',
  'card-change',
  'clip-duration-limit',
  'unknown',
] as const)
export type TrackPartSplitReason = (typeof TRACK_PART_SPLIT_REASONS)[number]

/** How the part's tick interval was established. */
export const TRACK_PART_PROBE_SOURCES = Object.freeze([
  'container-index',
  'packet-scan',
  'decoder-walk',
  'declared-metadata',
  'operator-report',
] as const)
export type TrackPartProbeSource = (typeof TRACK_PART_PROBE_SOURCES)[number]

export const CAPTURE_SESSION_OPERATIONS = Object.freeze([
  'create-session',
  'add-track',
  'add-track-part',
  'change-reference-track',
  'change-status',
] as const)
export type CaptureSessionOperation = (typeof CAPTURE_SESSION_OPERATIONS)[number]

/** Downstream work that a session change can invalidate. */
export const CAPTURE_SESSION_DERIVATIONS = Object.freeze([
  'track-coverage',
  'session-clock-map',
  'sync-diagnostic',
  'edit-plan',
] as const)
export type CaptureSessionDerivation = (typeof CAPTURE_SESSION_DERIVATIONS)[number]

export interface CaptureDeviceIdentity {
  /** The physical camera/recorder. Two tracks from one body share this. */
  readonly deviceId: string
  /** The recording instance inside that device — a second card, a second app. */
  readonly recorderId: string
  readonly make: string | null
  readonly model: string | null
  readonly serial: string | null
}

export interface CaptureTrackPartEvidence {
  /** The ingested bytes, so the interval can be re-derived from the same file. */
  readonly ingestArtifactId: string
  readonly ingestSha256: string
  /** Hash of the probe payload that produced the interval, not the payload. */
  readonly probeHash: string
  readonly probeSource: TrackPartProbeSource
  readonly observedAt: string
}

export interface CaptureTrackPart {
  readonly partId: string
  /** The recorder's own sequence. Splits are read from consecutive ordinals. */
  readonly ordinal: number
  readonly sourceAssetId: string
  /** The part's OWN timebase, exactly as written. Never rewritten. */
  readonly timebase: Readonly<Timebase>
  /** Ticks this file covers, counted in the line above and nothing else. */
  readonly coverage: Readonly<TickInterval>
  readonly streamIndex: number
  readonly splitReason: TrackPartSplitReason
  readonly evidence: Readonly<CaptureTrackPartEvidence>
}

export interface CaptureTrack {
  readonly trackId: string
  readonly role: CaptureTrackRole
  readonly device: Readonly<CaptureDeviceIdentity>
  /** The asset that gives the track its identity — its first part's source. */
  readonly sourceAssetId: string
  /** The original rational timebase, preserved before any normalization. */
  readonly timebase: Readonly<Timebase>
  readonly streamIndex: number
  readonly syncAudioPolicy: SyncAudioPolicy
  readonly includeInFinalMix: boolean
  readonly parts: readonly Readonly<CaptureTrackPart>[]
}

/** Which command produced this version, and who asked for it. */
export interface CaptureSessionLineage {
  readonly commandId: string
  readonly operation: CaptureSessionOperation
  readonly actorKind: 'human' | 'api-client' | 'director'
  readonly actorId: string
  readonly occurredAt: string
  readonly note: string | null
}

/**
 * The canonical clock policy of the session: the unit session ticks are counted
 * in, and the single rounding rule every conversion into it must use. Storing
 * the rounding beside the timebase is what stops two subsystems from converting
 * the same instant to two different ticks and both being "right".
 */
export interface CaptureSessionClockPolicy {
  readonly timebase: Readonly<Timebase>
  readonly rounding: RoundingPolicy
}

export interface CaptureSession {
  readonly schemaVersion: typeof CAPTURE_SESSION_SCHEMA_VERSION
  readonly workspaceId: string
  readonly projectId: string
  readonly sessionId: string
  /** 1-based and immutable. Every operation returns version + 1. */
  readonly version: number
  /** The hash of the version this one replaced. Null only for version 1. */
  readonly previousVersionHash: string | null
  readonly status: CaptureSessionStatus
  readonly clock: Readonly<CaptureSessionClockPolicy>
  readonly referenceTrackId: string
  /** Bumped whenever the reference track changes. Never decreases. */
  readonly referenceEpoch: number
  readonly tracks: readonly Readonly<CaptureTrack>[]
  readonly lineage: Readonly<CaptureSessionLineage>
  /** Derivations this version invalidated. Empty on a purely additive change. */
  readonly staleDerivations: readonly CaptureSessionDerivation[]
  readonly createdAt: string
  readonly sessionHash: string
}

/** The mutable pointer to the immutable chain: which version is current. */
export interface CaptureSessionHead {
  readonly workspaceId: string
  readonly sessionId: string
  readonly version: number
  readonly sessionHash: string
}

function assertId(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is not a canonical identifier`)
  return value
}

function assertHash(value: string, field: string): string {
  assertDomain(HASH.test(value), 'INVALID_ARGUMENT', `${field} must be a sha256 hex digest`)
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

function assertStreamIndex(value: number, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0 && value <= 4_096,
    'INVALID_ARGUMENT',
    `${field} must be a non-negative stream index`,
  )
  return value
}

function assertLineage(lineage: Readonly<CaptureSessionLineage>, operation: CaptureSessionOperation): Readonly<CaptureSessionLineage> {
  assertId(lineage.commandId, 'capture session lineage commandId')
  assertId(lineage.actorId, 'capture session lineage actorId')
  assertDomain(
    lineage.operation === operation,
    'INVALID_ARGUMENT',
    `capture session lineage declares ${lineage.operation} but the version was produced by ${operation}`,
  )
  assertDomain(
    lineage.actorKind === 'human' || lineage.actorKind === 'api-client' || lineage.actorKind === 'director',
    'INVALID_ARGUMENT',
    'capture session lineage actorKind is invalid',
  )
  assertDomain(
    lineage.note === null || (lineage.note.trim().length > 0 && lineage.note.length <= 1_024),
    'INVALID_ARGUMENT',
    'capture session lineage note must be absent or meaningful',
  )
  assertInstant(lineage.occurredAt, 'capture session lineage occurredAt')
  return Object.freeze({ ...lineage })
}

function assertPart(part: Readonly<CaptureTrackPart>, trackId: string): Readonly<CaptureTrackPart> {
  assertId(part.partId, `track ${trackId} partId`)
  assertId(part.sourceAssetId, `track ${trackId} part ${part.partId} sourceAssetId`)
  assertDomain(
    Number.isSafeInteger(part.ordinal) && part.ordinal >= 0,
    'INVALID_ARGUMENT',
    `track ${trackId} part ${part.partId} ordinal must be a non-negative integer`,
  )
  assertStreamIndex(part.streamIndex, `track ${trackId} part ${part.partId} streamIndex`)
  assertDomain(
    TRACK_PART_SPLIT_REASONS.includes(part.splitReason),
    'INVALID_ARGUMENT',
    `track ${trackId} part ${part.partId} splitReason ${part.splitReason} is not a split reason`,
  )
  assertDomain(
    part.timebase.secondsPerTick.num > BigInt(0),
    'INVALID_ARGUMENT',
    `track ${trackId} part ${part.partId} timebase must advance forward`,
  )
  // Re-running the constructor rejects an interval that was assembled by hand
  // and is empty or backwards, which is how a "zero-length part" gets in.
  const coverage = createTickInterval(part.coverage.start, part.coverage.end)
  assertId(part.evidence.ingestArtifactId, `track ${trackId} part ${part.partId} ingestArtifactId`)
  assertHash(part.evidence.ingestSha256, `track ${trackId} part ${part.partId} ingestSha256`)
  assertHash(part.evidence.probeHash, `track ${trackId} part ${part.partId} probeHash`)
  assertDomain(
    TRACK_PART_PROBE_SOURCES.includes(part.evidence.probeSource),
    'INVALID_ARGUMENT',
    `track ${trackId} part ${part.partId} probeSource ${part.evidence.probeSource} is not a probe source`,
  )
  assertInstant(part.evidence.observedAt, `track ${trackId} part ${part.partId} observedAt`)
  return Object.freeze({
    ...part,
    coverage,
    timebase: part.timebase,
    evidence: Object.freeze({ ...part.evidence }),
  })
}

function assertTrack(track: Readonly<CaptureTrack>): Readonly<CaptureTrack> {
  assertId(track.trackId, 'capture track trackId')
  assertDomain(
    CAPTURE_TRACK_ROLES.includes(track.role),
    'INVALID_ARGUMENT',
    `capture track role ${track.role} is not one of the nine capture roles`,
  )
  assertId(track.device.deviceId, `track ${track.trackId} device.deviceId`)
  assertId(track.device.recorderId, `track ${track.trackId} device.recorderId`)
  for (const [field, value] of Object.entries({
    make: track.device.make,
    model: track.device.model,
    serial: track.device.serial,
  })) {
    assertDomain(
      value === null || (value.trim().length > 0 && value.length <= 128),
      'INVALID_ARGUMENT',
      `track ${track.trackId} device.${field} must be absent or a real value`,
    )
  }
  assertId(track.sourceAssetId, `track ${track.trackId} sourceAssetId`)
  assertStreamIndex(track.streamIndex, `track ${track.trackId} streamIndex`)
  assertDomain(
    SYNC_AUDIO_POLICIES.includes(track.syncAudioPolicy),
    'INVALID_ARGUMENT',
    `track ${track.trackId} syncAudioPolicy ${track.syncAudioPolicy} is not a policy`,
  )
  assertDomain(
    track.timebase.secondsPerTick.num > BigInt(0),
    'INVALID_ARGUMENT',
    `track ${track.trackId} timebase must advance forward`,
  )
  // Spec 05 invariant 6. Scratch audio exists to line clocks up; letting it be
  // marked for the mix is how a reference tone reaches a deliverable.
  assertDomain(
    !track.includeInFinalMix || FINAL_MIX_ELIGIBLE_ROLES.includes(track.role),
    'INVALID_ARGUMENT',
    `a ${track.role} track carries no final audio and cannot be marked for the final mix`,
  )
  assertDomain(
    track.syncAudioPolicy !== 'final-candidate' || FINAL_MIX_ELIGIBLE_ROLES.includes(track.role),
    'INVALID_ARGUMENT',
    `a ${track.role} track cannot offer its audio as a final candidate`,
  )

  assertDomain(track.parts.length > 0, 'INVALID_ARGUMENT', `track ${track.trackId} has no parts`)
  const parts = [...track.parts]
    .map((part) => assertPart(part, track.trackId))
    .sort((left, right) => left.ordinal - right.ordinal)
  const seenPartIds = new Set<string>()
  const seenOrdinals = new Set<number>()
  for (const part of parts) {
    assertDomain(!seenPartIds.has(part.partId), 'INVALID_ARGUMENT', `track ${track.trackId} repeats part ${part.partId}`)
    assertDomain(
      !seenOrdinals.has(part.ordinal),
      'INVALID_ARGUMENT',
      `track ${track.trackId} has two parts at ordinal ${part.ordinal}`,
    )
    seenPartIds.add(part.partId)
    seenOrdinals.add(part.ordinal)
  }
  // The track's declared timebase is not a fourth opinion: it is the first
  // part's, because that is the file the track is named after.
  assertDomain(
    rationalEquals(track.timebase.secondsPerTick, parts[0]!.timebase.secondsPerTick),
    'INVALID_ARGUMENT',
    `track ${track.trackId} declares a timebase its first part does not have`,
  )
  assertDomain(
    track.sourceAssetId === parts[0]!.sourceAssetId,
    'INVALID_ARGUMENT',
    `track ${track.trackId} declares a source asset its first part does not have`,
  )
  // One file is not a split. Saying it is would fabricate a recorder event.
  assertDomain(
    parts.length > 1 || parts[0]!.splitReason === 'single-file',
    'INVALID_ARGUMENT',
    `track ${track.trackId} has one part and cannot claim it was split`,
  )
  assertDomain(
    parts.length === 1 || parts.every((part) => part.splitReason !== 'single-file'),
    'INVALID_ARGUMENT',
    `track ${track.trackId} has several parts, so none of them is a single file`,
  )
  return Object.freeze({
    ...track,
    device: Object.freeze({ ...track.device }),
    parts: Object.freeze(parts),
  })
}

function assertTracks(tracks: readonly Readonly<CaptureTrack>[], referenceTrackId: string): readonly Readonly<CaptureTrack>[] {
  assertDomain(tracks.length > 0, 'INVALID_ARGUMENT', 'a capture session needs at least one track')
  const validated = [...tracks].map(assertTrack).sort((left, right) => left.trackId.localeCompare(right.trackId))
  const seenTrackIds = new Set<string>()
  const seenPartIds = new Set<string>()
  const seenAssets = new Map<string, string>()
  for (const track of validated) {
    assertDomain(!seenTrackIds.has(track.trackId), 'INVALID_ARGUMENT', `capture session repeats track ${track.trackId}`)
    seenTrackIds.add(track.trackId)
    for (const part of track.parts) {
      assertDomain(
        !seenPartIds.has(part.partId),
        'INVALID_ARGUMENT',
        `capture session repeats part ${part.partId} across tracks`,
      )
      seenPartIds.add(part.partId)
      // One file, one logical stream. The same asset at the same stream index in
      // two tracks would let the session double-count a single recording.
      const key = `${part.sourceAssetId}#${part.streamIndex}`
      assertDomain(
        !seenAssets.has(key),
        'INVALID_ARGUMENT',
        `stream ${part.streamIndex} of asset ${part.sourceAssetId} is already claimed by track ${seenAssets.get(key)}`,
      )
      seenAssets.set(key, track.trackId)
    }
  }
  assertDomain(
    seenTrackIds.has(referenceTrackId),
    'INVALID_ARGUMENT',
    `reference track ${referenceTrackId} is not one of this session's tracks`,
  )
  return Object.freeze(validated)
}

function assertClock(clock: Readonly<CaptureSessionClockPolicy>): Readonly<CaptureSessionClockPolicy> {
  assertDomain(
    clock.timebase.secondsPerTick.num > BigInt(0),
    'INVALID_ARGUMENT',
    'the session clock must advance forward in time',
  )
  assertDomain(
    ROUNDING_POLICIES.includes(clock.rounding),
    'INVALID_ARGUMENT',
    `${clock.rounding} is not a rounding policy`,
  )
  return Object.freeze({ timebase: clock.timebase, rounding: clock.rounding })
}

/**
 * Integral content address of one version.
 *
 * `previousVersionHash` participates, so the chain itself is addressed: a
 * version cannot be re-parented onto a different history without changing its
 * own identity.
 */
export function calculateCaptureSessionHash(session: Omit<CaptureSession, 'sessionHash'>): string {
  return calculateCanonicalHash({
    schemaVersion: session.schemaVersion,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    sessionId: session.sessionId,
    version: session.version,
    previousVersionHash: session.previousVersionHash,
    status: session.status,
    clock: {
      secondsPerTick: serializeRational(session.clock.timebase.secondsPerTick),
      rounding: session.clock.rounding,
    },
    referenceTrackId: session.referenceTrackId,
    referenceEpoch: session.referenceEpoch,
    tracks: session.tracks.map((track) => ({
      trackId: track.trackId,
      role: track.role,
      device: {
        deviceId: track.device.deviceId,
        recorderId: track.device.recorderId,
        make: track.device.make,
        model: track.device.model,
        serial: track.device.serial,
      },
      sourceAssetId: track.sourceAssetId,
      timebase: serializeRational(track.timebase.secondsPerTick),
      streamIndex: track.streamIndex,
      syncAudioPolicy: track.syncAudioPolicy,
      includeInFinalMix: track.includeInFinalMix,
      parts: track.parts.map((part) => ({
        partId: part.partId,
        ordinal: part.ordinal,
        sourceAssetId: part.sourceAssetId,
        timebase: serializeRational(part.timebase.secondsPerTick),
        coverage: serializeTickInterval(part.coverage),
        streamIndex: part.streamIndex,
        splitReason: part.splitReason,
        evidence: {
          ingestArtifactId: part.evidence.ingestArtifactId,
          ingestSha256: part.evidence.ingestSha256,
          probeHash: part.evidence.probeHash,
          probeSource: part.evidence.probeSource,
          observedAt: part.evidence.observedAt,
        },
      })),
    })),
    lineage: {
      commandId: session.lineage.commandId,
      operation: session.lineage.operation,
      actorKind: session.lineage.actorKind,
      actorId: session.lineage.actorId,
      occurredAt: session.lineage.occurredAt,
      note: session.lineage.note,
    },
    staleDerivations: [...session.staleDerivations],
    createdAt: session.createdAt,
  })
}

function seal(session: Omit<CaptureSession, 'sessionHash'>): Readonly<CaptureSession> {
  return Object.freeze({ ...session, sessionHash: calculateCaptureSessionHash(session) })
}

export interface CreateCaptureSessionInput {
  workspaceId: string
  projectId: string
  sessionId: string
  clock: Readonly<CaptureSessionClockPolicy>
  referenceTrackId: string
  tracks: readonly Readonly<CaptureTrack>[]
  lineage: Readonly<CaptureSessionLineage>
  createdAt: string
  status?: CaptureSessionStatus
}

export function createCaptureSession(input: CreateCaptureSessionInput): Readonly<CaptureSession> {
  assertId(input.workspaceId, 'capture session workspaceId')
  assertId(input.projectId, 'capture session projectId')
  assertId(input.sessionId, 'capture session sessionId')
  assertId(input.referenceTrackId, 'capture session referenceTrackId')
  const status = input.status ?? 'draft'
  assertDomain(
    CAPTURE_SESSION_STATUSES.includes(status),
    'INVALID_ARGUMENT',
    `${status} is not a capture session status`,
  )
  // A session cannot be born synced: nothing has been measured yet, and a
  // status is a claim about evidence.
  assertDomain(
    status === 'draft' || status === 'analyzing',
    'INVALID_ARGUMENT',
    'a new capture session starts as draft or analyzing; every other status is a conclusion',
  )
  return seal({
    schemaVersion: CAPTURE_SESSION_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    version: 1,
    previousVersionHash: null,
    status,
    clock: assertClock(input.clock),
    referenceTrackId: input.referenceTrackId,
    referenceEpoch: 1,
    tracks: assertTracks(input.tracks, input.referenceTrackId),
    lineage: assertLineage(input.lineage, 'create-session'),
    staleDerivations: Object.freeze([]),
    createdAt: assertInstant(input.createdAt, 'capture session createdAt'),
  })
}

/**
 * The one place a new version is minted.
 *
 * Every operation funnels through here so that "immutable" is a property of the
 * type rather than a discipline: the previous version is never handed to the
 * caller in a mutable form, and the new one always carries its parent's hash.
 */
function nextVersion(
  previous: Readonly<CaptureSession>,
  change: Readonly<{
    status?: CaptureSessionStatus
    referenceTrackId?: string
    referenceEpoch?: number
    tracks?: readonly Readonly<CaptureTrack>[]
    staleDerivations?: readonly CaptureSessionDerivation[]
  }>,
  lineage: Readonly<CaptureSessionLineage>,
  operation: CaptureSessionOperation,
): Readonly<CaptureSession> {
  assertCaptureSessionIntegrity(previous)
  const referenceTrackId = change.referenceTrackId ?? previous.referenceTrackId
  const tracks = assertTracks(change.tracks ?? previous.tracks, referenceTrackId)
  const validated = assertLineage(lineage, operation)
  assertDomain(
    Date.parse(validated.occurredAt) >= Date.parse(previous.createdAt),
    'INVALID_ARGUMENT',
    'a capture session version cannot be produced before the version it replaces',
  )
  return seal({
    schemaVersion: CAPTURE_SESSION_SCHEMA_VERSION,
    workspaceId: previous.workspaceId,
    projectId: previous.projectId,
    sessionId: previous.sessionId,
    version: previous.version + 1,
    previousVersionHash: previous.sessionHash,
    status: change.status ?? previous.status,
    clock: previous.clock,
    referenceTrackId,
    referenceEpoch: change.referenceEpoch ?? previous.referenceEpoch,
    tracks,
    lineage: validated,
    staleDerivations: Object.freeze([...(change.staleDerivations ?? [])]),
    createdAt: validated.occurredAt,
  })
}

/**
 * Add a camera, screen, separate audio or reference media after ingest.
 *
 * The session was already being analysed; a new source means every coverage
 * derived from the old version described a smaller event. Saying so is cheaper
 * than discovering it during the edit.
 */
export function addCaptureSessionTrack(
  session: Readonly<CaptureSession>,
  input: Readonly<{ track: Readonly<CaptureTrack>; lineage: Readonly<CaptureSessionLineage> }>,
): Readonly<CaptureSession> {
  assertDomain(
    !session.tracks.some((track) => track.trackId === input.track.trackId),
    'INVALID_ARGUMENT',
    `track ${input.track.trackId} is already in this capture session`,
  )
  return nextVersion(
    session,
    {
      tracks: [...session.tracks, input.track],
      staleDerivations: ['track-coverage', 'session-clock-map', 'sync-diagnostic'],
      status: session.status === 'synced' ? 'partial' : session.status,
    },
    input.lineage,
    'add-track',
  )
}

/**
 * Attach a further file to a track the recorder had already started.
 *
 * The part keeps its own timebase because a recorder that stopped and restarted
 * is entitled to come back in a different one — and a session that quietly
 * reused the first part's timebase would misplace every tick of the second.
 */
export function addCaptureSessionTrackPart(
  session: Readonly<CaptureSession>,
  input: Readonly<{ trackId: string; part: Readonly<CaptureTrackPart>; lineage: Readonly<CaptureSessionLineage> }>,
): Readonly<CaptureSession> {
  const track = session.tracks.find((entry) => entry.trackId === input.trackId)
  assertDomain(track !== undefined, 'CAPTURE_TRACK_NOT_FOUND', `track ${input.trackId} is not in this capture session`)
  assertDomain(
    !track!.parts.some((part) => part.partId === input.part.partId),
    'INVALID_ARGUMENT',
    `part ${input.part.partId} is already on track ${input.trackId}`,
  )
  // A second file is by definition not a single file. Re-stamping the first
  // part is the only way its `single-file` reason can stop being a lie.
  const existing = track!.parts.map((part) =>
    part.splitReason === 'single-file'
      ? Object.freeze({ ...part, splitReason: input.part.splitReason === 'unknown' ? 'unknown' as const : 'recorder-restart' as const })
      : part,
  )
  return nextVersion(
    session,
    {
      tracks: session.tracks.map((entry) =>
        entry.trackId === input.trackId
          ? Object.freeze({ ...entry, parts: [...existing, input.part] })
          : entry,
      ),
      staleDerivations: ['track-coverage', 'session-clock-map', 'sync-diagnostic'],
      status: session.status === 'synced' ? 'partial' : session.status,
    },
    input.lineage,
    'add-track-part',
  )
}

/**
 * Replace the clock everything is measured against.
 *
 * Spec 05 MS-06: every map, coverage projection and downstream plan built on the
 * old reference is now describing a different origin. The epoch bump is what
 * lets `assertCoverageDerivedFrom` refuse the stale ones by construction, and
 * the status downgrade stops the session from advertising a synchronization it
 * no longer has.
 */
export function changeCaptureSessionReferenceTrack(
  session: Readonly<CaptureSession>,
  input: Readonly<{ referenceTrackId: string; lineage: Readonly<CaptureSessionLineage> }>,
): Readonly<CaptureSession> {
  assertDomain(
    session.tracks.some((track) => track.trackId === input.referenceTrackId),
    'CAPTURE_TRACK_NOT_FOUND',
    `track ${input.referenceTrackId} is not in this capture session and cannot become its reference`,
  )
  assertDomain(
    session.referenceTrackId !== input.referenceTrackId,
    'INVALID_ARGUMENT',
    `track ${input.referenceTrackId} is already the reference; a no-op must not mint a version that invalidates work`,
  )
  return nextVersion(
    session,
    {
      referenceTrackId: input.referenceTrackId,
      referenceEpoch: session.referenceEpoch + 1,
      staleDerivations: [...CAPTURE_SESSION_DERIVATIONS],
      status: session.status === 'failed' ? 'failed' : 'analyzing',
    },
    input.lineage,
    'change-reference-track',
  )
}

export function changeCaptureSessionStatus(
  session: Readonly<CaptureSession>,
  input: Readonly<{ status: CaptureSessionStatus; lineage: Readonly<CaptureSessionLineage> }>,
): Readonly<CaptureSession> {
  assertDomain(
    CAPTURE_SESSION_STATUSES.includes(input.status),
    'INVALID_ARGUMENT',
    `${input.status} is not a capture session status`,
  )
  assertDomain(
    input.status !== session.status,
    'INVALID_ARGUMENT',
    `the capture session is already ${session.status}`,
  )
  return nextVersion(
    session,
    {
      status: input.status,
      // Losing synchronization invalidates what depended on it; gaining it does
      // not invalidate anything.
      staleDerivations: session.status === 'synced' && input.status !== 'synced'
        ? ['session-clock-map', 'sync-diagnostic', 'edit-plan']
        : [],
    },
    input.lineage,
    'change-status',
  )
}

/**
 * Fail-closed rehydration. A row whose columns no longer reproduce the stored
 * hash was written by something other than this aggregate.
 */
export function assertCaptureSessionIntegrity(session: Readonly<CaptureSession>): Readonly<CaptureSession> {
  assertDomain(HASH.test(session.sessionHash), 'PERSISTENCE_CONFLICT', 'capture session hash is malformed')
  assertDomain(
    calculateCaptureSessionHash(session) === session.sessionHash,
    'PERSISTENCE_CONFLICT',
    `capture session ${session.sessionId} version ${session.version} does not match its stored hash`,
  )
  assertDomain(
    (session.version === 1) === (session.previousVersionHash === null),
    'PERSISTENCE_CONFLICT',
    'only the first capture session version has no parent',
  )
  return session
}

export function captureSessionHead(session: Readonly<CaptureSession>): Readonly<CaptureSessionHead> {
  return Object.freeze({
    workspaceId: session.workspaceId,
    sessionId: session.sessionId,
    version: session.version,
    sessionHash: session.sessionHash,
  })
}

export function findCaptureTrack(session: Readonly<CaptureSession>, trackId: string): Readonly<CaptureTrack> {
  const track = session.tracks.find((entry) => entry.trackId === trackId)
  assertDomain(track !== undefined, 'CAPTURE_TRACK_NOT_FOUND', `track ${trackId} is not in capture session ${session.sessionId}`)
  return track!
}

/** The handle every derived artefact must carry to prove it is not stale. */
export function captureSessionDerivationRef(session: Readonly<CaptureSession>): Readonly<CaptureSessionDerivationRef> {
  return Object.freeze({
    sessionId: session.sessionId,
    sessionVersion: session.version,
    referenceEpoch: session.referenceEpoch,
  })
}
