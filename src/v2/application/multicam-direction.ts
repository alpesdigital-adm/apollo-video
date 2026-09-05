import type { CaptureSession, CaptureTrack, CaptureTrackPart } from '../domain/capture-session.ts'
import {
  validateDirectedEditPlan,
  validateDirectorDecisions,
  type DirectedEditPlan,
  type DirectedTransition,
  type DirectorDecisionInput,
} from '../domain/director-run.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  compileShotsToSourceRanges,
  directMulticam,
  toAngleDecision,
  DEFAULT_DIRECTION_POLICY,
  OUTPUT_ASPECT_RATIOS,
  VIDEO_ANGLE_ROLES,
  type AngleCandidate,
  type DirectionPolicy,
  type DirectionRule,
  type MulticamDirection,
  type MulticamShotCompilation,
  type OutputAspectRatio,
  type ProtectedSelection,
  type ShotDecision,
} from '../domain/multicam-direction.ts'
import {
  createMulticamEvidenceSet,
  type MulticamEvidenceSet,
  type MulticamObservation,
} from '../domain/multicam-evidence.ts'
import { resolveSourceTick, type PiecewiseClockMap } from '../domain/piecewise-clock-map.ts'
import { createEditorialAudioTimelineHash } from '../domain/production-modes.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import {
  convertTick,
  createTickInterval,
  createTimebase,
  rational,
  rationalEquals,
  type Rational,
  type TickInterval,
} from '../domain/session-time.ts'
import type { EditorialCutClip } from './apply-editorial-cut-command.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import { buildDirectMulticamSessionCommand } from './direct-multicam-session.ts'
import type { CaptureProtocolRepository } from './ports/capture-protocol-repository.ts'
import type { CaptureSessionRepository } from './ports/capture-session-repository.ts'
import type {
  MulticamDirectionCommandContext,
  MulticamDirectionCommandRepository,
  MulticamDirectionCommandResult,
} from './ports/multicam-direction-command-repository.ts'
import type { MulticamDirectionRepository } from './ports/multicam-direction-repository.ts'
import type {
  CaptureTrackMediaResolver,
  MulticamDiarizationSource,
  MulticamPerceptionSource,
  MulticamVisualEvidenceProvider,
  MulticamVisualWindow,
} from './ports/multicam-evidence-sources.ts'
import type { SyncDiagnosticRepository } from './ports/sync-diagnostic-repository.ts'
import { calculateVersionHash, stableSerialize } from './version-hash.ts'

/**
 * F4.012 — directing a capture session across its cameras, end to end.
 *
 * Two services. `deriveMulticamEvidenceService` turns what is already stored
 * about a session — diarization runs, the pixels of the recordings, persisted
 * perception — into a `MulticamEvidenceSet`. `directMulticamSessionService`
 * takes ids and a fence from a caller and derives everything else itself: the
 * evidence, the direction, the compiled clips, the `DirectedEditPlan`, the angle
 * decisions, the Command and the new project version.
 *
 * The line the module is built around: **the caller supplies ids, positions and
 * labelled attestations, and nothing else.** No score, no eligibility, no
 * measurement, no approval, no `manualReviewRequired`. A request that carries
 * one is refused by name (`DIRECTION_CALLER_SUPPLIED_DERIVATION`) rather than
 * quietly ignored, because a field that is accepted and dropped teaches the next
 * caller to keep sending it. Even the attestation on a protected selection is
 * only half the caller's: the note is theirs, the identity is the authenticated
 * actor's, and the two are concatenated rather than one replacing the other
 * (CONTRACT §2, "evidenceRef = actor + nota do chamador").
 *
 * **What is not wired yet, stated rather than implied.** Two things this module
 * consumes have no production caller in the repository:
 *
 * - `MulticamPerceptionSource` has no adapter. `repository-factory.ts` builds a
 *   diarization source and a visual provider and nothing for perception, so the
 *   `reaction` observations below and the `reactionIntensityFloorBps` that
 *   filters them are exercised by tests and by nothing else. That is the honest
 *   state — a session nobody ran perception over produces no reaction evidence
 *   at all, which the direction handles by holding the current angle — and it
 *   is a phase-4 integration need, not a gap somebody should paper over with a
 *   stub returning intensity zero.
 * - nothing calls `directMulticamSessionService`. There is no HTTP route and no
 *   worker for `direct-multicam-session`; the factories that build its
 *   repository, its diarization source and its visual provider exist and have
 *   no call site. The slice is proven end to end by the PostgreSQL E2E and the
 *   FFmpeg integration suites, which is not the same as being reachable in
 *   production, and the hand-off says so.
 */

export const MULTICAM_DIRECTION_PLANNER_VERSION = 'multicam-direction-planner/2026-09-v1'

const MS_TIMEBASE = createTimebase(rational(BigInt(1), BigInt(1_000)))
const TICK_STRING = /^[0-9]{1,19}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

/**
 * The only policy numbers a caller may move, and why the list is closed.
 *
 * These are editorial preferences an operator legitimately has an opinion about
 * — how short a shot may be, how long a cutaway runs, how much better an angle
 * must be before the direction switches. Everything else in `DirectionPolicy` is
 * calibration: the weights, the context baselines, the confidence a hold is
 * worth, the name of the calibration itself. Letting a request set those would
 * let it set the score, which is the one thing the server exists to derive.
 *
 * `qualityFloorBps` and `reactionIntensityFloorBps` were on this list and are
 * NOT editorial preferences, which a reviewer proved with the lane's own
 * fixture: `qualityFloorBps` is the exact threshold `deriveCandidate` compares
 * a measured quality against before stamping `quality-below-floor`
 * (`domain/multicam-direction.ts:957`), so a request that set it to 0 flipped
 * camera B from rejected to eligible and changed which angle was on screen —
 * caller-supplied eligibility through the back door, in the module whose whole
 * premise is that a caller cannot supply one. They are thresholds on a
 * measurement, i.e. calibration, and they are refused by name like the rest of
 * it. An operator who genuinely wants a low-quality angle on screen says so
 * with a `protectedSelection`, which names who decided and why; a threshold
 * names nobody.
 */
export const DIRECTION_POLICY_OVERRIDE_KEYS = Object.freeze([
  'minimumShotMs',
  'maxCutawayMs',
  'jumpCutSameAngleMs',
  'redundancyThreshold',
  'ambiguityMargin',
] as const)
export type DirectionPolicyOverrideKey = (typeof DIRECTION_POLICY_OVERRIDE_KEYS)[number]
export type DirectionPolicyOverrides = Readonly<Partial<Record<DirectionPolicyOverrideKey, number>>>

/**
 * Field names a direction request may never carry, at any nesting depth.
 *
 * Each is something the server derives from stored projections: a score, an
 * eligibility, a measurement, a review verdict, or the hash of an artifact this
 * command is about to produce. The request is scanned rather than merely typed
 * because the refusal has to name the field — an operator who sent
 * `confidence: 0.9` needs to be told to remove `confidence`, not that their
 * request was invalid.
 */
export const DIRECTION_FORBIDDEN_REQUEST_FIELDS = Object.freeze([
  'approved',
  // Who attested a protected selection is the authenticated actor, never a
  // request field: a note that could also name its own author would let a
  // caller put somebody else's name on a human override.
  'attestedBy',
  'candidates',
  'chosen',
  'confidence',
  'coverageBps',
  'directionHash',
  'eligible',
  'evaluated',
  'evidence',
  'evidenceHash',
  'evidenceRefs',
  'manualReviewRequired',
  'measurement',
  'measurements',
  'rejectionReasons',
  'score',
  'scoreComponents',
  'shots',
  'syncConfidence',
  'uncovered',
  'warnings',
] as const)

/**
 * The four fields a protected selection may carry, and nothing else.
 *
 * The list is closed for the same reason the request scan exists: a key that is
 * accepted and dropped teaches the next caller to keep sending it. Being on
 * `DIRECTION_FORBIDDEN_REQUEST_FIELDS` covers the derivations by name; this
 * covers everything else, including a typo, so the caller is told which key of
 * theirs went nowhere.
 */
const PROTECTED_SELECTION_KEYS = Object.freeze([
  'selectionId',
  'trackId',
  'sessionStartTicks',
  'sessionEndTicks',
  'note',
] as const)

/** How deep a legitimate direction request nests: `protectedSelections[i].note` is three. */
const MAX_REQUEST_DEPTH = 6

function refuseDerivation(field: string, why: string): never {
  throw new DomainError(
    'DIRECTION_CALLER_SUPPLIED_DERIVATION',
    `direction request field '${field}' ${why}; remove it — the server derives it from the stored session, its coverages, its clock maps, its diagnostic and its evidence`,
    { field },
  )
}

function assertNoCallerDerivations(value: unknown, path: string, depth = 0): void {
  if (value === null || typeof value !== 'object') return
  // Refused rather than skipped. Stopping the walk at the cap would make the
  // deepest nesting the one place a derivation could still be smuggled in, and
  // "the scan gave up here" is not something a caller can be told after the
  // fact — no legitimate request nests past `protectedSelections[i].note`.
  assertDomain(
    depth <= MAX_REQUEST_DEPTH,
    'INVALID_ARGUMENT',
    `direction request field '${path}' is nested deeper than ${MAX_REQUEST_DEPTH} levels, which no direction request is`,
  )
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCallerDerivations(entry, `${path}[${index}]`, depth + 1))
    return
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key
    if ((DIRECTION_FORBIDDEN_REQUEST_FIELDS as readonly string[]).includes(key)) {
      refuseDerivation(here, 'is a derivation, not an input')
    }
    assertNoCallerDerivations(nested, here, depth + 1)
  }
}

function resolvePolicy(overrides: DirectionPolicyOverrides | undefined): Readonly<DirectionPolicy> {
  if (overrides === undefined) return DEFAULT_DIRECTION_POLICY
  assertDomain(
    typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides),
    'INVALID_ARGUMENT',
    'policy must be an object of named overrides',
  )
  const allowed = new Set<string>(DIRECTION_POLICY_OVERRIDE_KEYS)
  for (const [key, value] of Object.entries(overrides)) {
    if (!allowed.has(key)) refuseDerivation(`policy.${key}`, 'is part of the calibration, not an operator preference')
    assertDomain(typeof value === 'number' && Number.isFinite(value), 'INVALID_ARGUMENT', `policy.${key} must be a finite number`)
  }
  // `resolveDirectionPolicy` inside the domain validates each of these against
  // its own bounds; this only decides which of them may be replaced at all.
  return Object.freeze({ ...DEFAULT_DIRECTION_POLICY, ...overrides })
}

function parseTick(value: string, field: string): bigint {
  assertDomain(typeof value === 'string' && TICK_STRING.test(value), 'INVALID_ARGUMENT', `${field} must be a decimal string of session ticks`)
  return BigInt(value)
}

/**
 * The plan's `fps` number back as the exact rational the compile step compares.
 *
 * `EditorialCutEditPlan.fps` is a float, and the NTSC family is not one:
 * 30000/1001 arrives as 29.97002997…, and `rational(29970, 1000)` normalizes to
 * 2997/100, which is a different number. Compared against a probe that reported
 * 30000/1001 the compile step would refuse every clip with
 * `DIRECTION_SOURCE_CADENCE_UNSUPPORTED` — a correct refusal of an incorrect
 * conversion. The four broadcast rates are therefore recognised exactly, and
 * anything else must be expressible as thousandths.
 */
const NTSC_RATES: readonly Rational[] = Object.freeze([
  rational(BigInt(24_000), BigInt(1_001)),
  rational(BigInt(30_000), BigInt(1_001)),
  rational(BigInt(60_000), BigInt(1_001)),
  rational(BigInt(120_000), BigInt(1_001)),
])

export function planFrameRate(fps: number): Rational {
  assertDomain(Number.isFinite(fps) && fps > 0, 'INVALID_RENDER_INPUT', 'the project plan does not declare a positive frame rate')
  for (const rate of NTSC_RATES) {
    if (Math.abs(fps - Number(rate.num) / Number(rate.den)) < 5e-3) return rate
  }
  const thousandths = Math.round(fps * 1_000)
  assertDomain(
    Math.abs(fps * 1_000 - thousandths) < 1e-6,
    'INVALID_RENDER_INPUT',
    `the project plan runs at ${fps} fps, which is neither a broadcast rate nor a whole number of thousandths`,
  )
  return rational(BigInt(thousandths), BigInt(1_000))
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Milliseconds inside one part → the session ticks it occupies, or null when it does not map. */
function sessionRangeForSourceMs(input: {
  session: Readonly<CaptureSession>
  track: Readonly<CaptureTrack>
  part: Readonly<CaptureTrackPart>
  map: Readonly<PiecewiseClockMap> | null
  startMs: number
  endMs: number
}): Readonly<TickInterval> | null {
  if (!Number.isFinite(input.startMs) || !Number.isFinite(input.endMs) || input.endMs <= input.startMs) return null
  const toSourceTick = (ms: number) =>
    input.part.coverage.start + convertTick({ tick: BigInt(Math.round(ms)), from: MS_TIMEBASE, to: input.part.timebase })
  const sourceStart = toSourceTick(input.startMs)
  const sourceEnd = toSourceTick(input.endMs)
  if (sourceEnd <= sourceStart) return null
  if (sourceStart < input.part.coverage.start || sourceEnd > input.part.coverage.end) return null
  if (input.map) {
    const start = resolveSourceTick(input.map, sourceStart)
    const end = resolveSourceTick(input.map, sourceEnd)
    // Half of a mapped range is not a range. A segment that begins inside a
    // piece and ends in the discontinuity after it describes an instant the
    // recorder never produced, and stretching it across the gap is exactly the
    // invention the evidence set exists to prevent.
    if (start.status !== 'resolved' || end.status !== 'resolved' || end.tick <= start.tick) return null
    return createTickInterval(start.tick, end.tick)
  }
  if (input.track.trackId !== input.session.referenceTrackId) return null
  const same = rationalEquals(input.track.timebase.secondsPerTick, input.session.clock.timebase.secondsPerTick)
  const toSession = (tick: bigint) => (same ? tick : convertTick({ tick, from: input.track.timebase, to: input.session.clock.timebase }))
  const start = toSession(sourceStart)
  const end = toSession(sourceEnd)
  if (end <= start) return null
  return createTickInterval(start, end)
}

/**
 * The track AND the part a stored analysis of one file belongs to.
 *
 * Every part, not `track.sourceAssetId` — which is documented as "the asset
 * that gives the track its identity, its FIRST part's source"
 * (`capture-session.ts:178-179`). A recorder that stopped and restarted
 * produces a second file on the same track (`addCaptureSessionTrackPart`), and
 * a lookup by track identity alone would neither ask for that file's
 * diarization nor recognise a run that arrived for it — dropping the run with
 * the reason "no capture track carries this artifact", which is false: a track
 * does carry it, as a later part. The milliseconds of a run are relative to the
 * file it analysed, so the part is what they must be mapped through.
 */
function locateArtifact(
  session: Readonly<CaptureSession>,
  artifactId: string,
): Readonly<{ track: Readonly<CaptureTrack>; part: Readonly<CaptureTrackPart> }> | null {
  for (const track of session.tracks) {
    const part = track.parts.find((entry) => entry.sourceAssetId === artifactId)
    if (part) return Object.freeze({ track, part })
  }
  return null
}

/** Every file of the session, in a stable order: one per part, deduplicated. */
function sessionArtifactIds(session: Readonly<CaptureSession>): readonly string[] {
  return [...new Set(session.tracks.flatMap((track) => track.parts.map((part) => part.sourceAssetId)))].sort()
}

export interface DeriveMulticamEvidenceDependencies {
  sessions: Pick<CaptureSessionRepository, 'readHead' | 'listClockMaps'>
  directions: Pick<MulticamDirectionRepository, 'persistEvidenceSet'>
  diarization: MulticamDiarizationSource
  visual: MulticamVisualEvidenceProvider
  media: CaptureTrackMediaResolver
  perception?: MulticamPerceptionSource
  clock: () => Date
  /** How long one visual measurement window is. Server policy, never a request field. */
  evidenceWindowMs?: number
  /** Ceiling on windows per part, so one long recording cannot spawn an unbounded sweep. */
  maxVisualWindowsPerPart?: number
}

export interface DeriveMulticamEvidenceResult {
  readonly set: Readonly<MulticamEvidenceSet>
  readonly replayed: boolean
  /** What was read and produced no observation, and why. Reported, never silently dropped. */
  readonly skipped: readonly Readonly<{ source: string; reason: string }>[]
}

/**
 * Build and store the evidence set for the session's current version.
 *
 * Content-addressed: the same observations for the same session version hash to
 * the same set, so a second run stores nothing and reports a replay. Absence is
 * preserved at every step — a track with no diarization run contributes no
 * speech, a window whose decode produced no frames contributes nothing, a
 * magnitude that came out at zero contributes nothing — because the direction
 * reads absence as "nobody measured" and would read a zero as "measured, and it
 * was nothing".
 */
export function deriveMulticamEvidenceService(dependencies: DeriveMulticamEvidenceDependencies) {
  const windowMs = dependencies.evidenceWindowMs ?? 30_000
  const maxWindows = dependencies.maxVisualWindowsPerPart ?? 64
  assertDomain(
    Number.isSafeInteger(windowMs) && windowMs >= 1_000 && windowMs <= 600_000,
    'INVALID_ARGUMENT',
    'evidenceWindowMs must be between one second and ten minutes',
  )
  assertDomain(
    Number.isSafeInteger(maxWindows) && maxWindows >= 1 && maxWindows <= 4_096,
    'INVALID_ARGUMENT',
    'maxVisualWindowsPerPart must be a positive bound',
  )

  return async function derive(request: {
    workspaceId: string
    projectId: string
    sessionId: string
    signal?: AbortSignal
  }): Promise<Readonly<DeriveMulticamEvidenceResult>> {
    const session = await dependencies.sessions.readHead({
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
    })
    if (!session) throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${request.sessionId} was not found`)
    const maps = await dependencies.sessions.listClockMaps({
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
    })
    const mapBySource = new Map(maps.map((map) => [map.sourceId, map]))
    const skipped: Array<Readonly<{ source: string; reason: string }>> = []
    const observations: MulticamObservation[] = []
    const producedAt = dependencies.clock().toISOString()
    const note = (source: string, reason: string) => skipped.push(Object.freeze({ source, reason }))

    // (a) Speech, from the diarization already persisted for these files.
    const artifactIds = sessionArtifactIds(session)
    const runs = await dependencies.diarization.listLatestRunsForArtifacts({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      sourceArtifactIds: artifactIds,
    })
    const speech: MulticamObservation[] = []
    for (const run of runs) {
      const located = locateArtifact(session, run.sourceArtifactId)
      if (!located) {
        note(`diarization:${run.runId}`, 'no part of any capture track carries this artifact')
        continue
      }
      const { track, part } = located
      for (const segment of run.segments) {
        const range = sessionRangeForSourceMs({
          session,
          track,
          part,
          map: mapBySource.get(track.sourceAssetId) ?? null,
          startMs: segment.startMs,
          endMs: segment.endMs,
        })
        if (!range) {
          note(`diarization:${run.runId}:${segment.segmentId}`, 'the segment does not map onto one piece of the session clock')
          continue
        }
        speech.push({
          observationId: `speech-${run.runId}-${segment.ordinal}`.slice(0, 127),
          trackId: track.trackId,
          range,
          kind: 'active-speaker',
          // `identityResolved: false` is the diarization aggregate's own label
          // (`speaker-diarization.ts:25`): a cluster separates voices, it does
          // not name people, and no rule downstream may pretend otherwise.
          value: Object.freeze({ kind: 'active-speaker' as const, speakerKey: segment.speakerKey, identityResolved: false as const }),
          confidence: 1,
          provenance: Object.freeze({
            method: `diarization/${run.provider}`.slice(0, 128),
            evaluatorKind: 'measured' as const,
            evidenceRef: `speaker-diarization:${run.runId}:${segment.ordinal}`,
            producedAt: run.producedAt,
          }),
        })
      }
    }
    observations.push(...speech)

    // Two clusters over each other is a measurement of its own: the direction
    // doubles its ambiguity margin on it and holds, rather than alternating
    // between two angles that are both partly right (ADR-151, generalized).
    const ordered = [...speech].sort((left, right) => (left.range.start < right.range.start ? -1 : left.range.start > right.range.start ? 1 : 0))
    for (let index = 0; index < ordered.length; index += 1) {
      for (let other = index + 1; other < ordered.length; other += 1) {
        const left = ordered[index]!
        const right = ordered[other]!
        if (right.range.start >= left.range.end) break
        if (left.trackId === right.trackId) continue
        observations.push({
          observationId: `concurrent-${index}-${other}-${right.range.start}`.slice(0, 127),
          trackId: left.trackId,
          range: createTickInterval(right.range.start, left.range.end < right.range.end ? left.range.end : right.range.end),
          kind: 'concurrent-speech',
          value: Object.freeze({ kind: 'concurrent-speech' as const, speakerCount: 2 }),
          confidence: Math.min(left.confidence, right.confidence),
          provenance: Object.freeze({
            method: 'diarization/overlap',
            evaluatorKind: 'measured' as const,
            evidenceRef: `${left.provenance.evidenceRef}+${right.provenance.evidenceRef}`.slice(0, 512),
            producedAt,
          }),
        })
      }
    }

    // (b) + (c) Screen activity and technical quality, from the pixels.
    for (const track of session.tracks) {
      if (!VIDEO_ANGLE_ROLES.includes(track.role)) continue
      for (const part of track.parts) {
        const durationMs = Number(convertTick({ tick: part.coverage.end - part.coverage.start, from: part.timebase, to: MS_TIMEBASE }))
        if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
          note(`${track.trackId}:${part.partId}`, 'the part covers less than a millisecond')
          continue
        }
        let media: Readonly<{ path: string; release: () => Promise<void> }> | null = null
        try {
          media = await dependencies.media.resolve({ workspaceId: request.workspaceId, part })
          const windows: MulticamVisualWindow[] = []
          // `cursor` outlives the loop on purpose: what the sweep did NOT reach
          // is reported below. A ceiling that silently stopped at 32 minutes of
          // a two-hour recording would leave the direction reading the other 88
          // minutes as "nobody measured", with nothing anywhere saying a policy
          // rather than the footage caused it.
          let cursor = 0
          for (; cursor < durationMs && windows.length < maxWindows; cursor += windowMs) {
            const end = Math.min(durationMs, cursor + windowMs)
            if (end - cursor < 200) {
              note(
                `${track.trackId}:${part.partId}`,
                `the last ${end - cursor} ms of this part are shorter than one measurable window and were not measured`,
              )
              cursor = end
              break
            }
            windows.push({
              trackId: track.trackId,
              partId: part.partId,
              sourceArtifactId: part.sourceAssetId,
              path: media.path,
              sourceStartMs: cursor,
              sourceEndMs: end,
            })
          }
          if (cursor < durationMs) {
            note(
              `${track.trackId}:${part.partId}`,
              `the sweep stopped at its ceiling of ${maxWindows} window(s); ${durationMs - cursor} ms of this part were not measured`,
            )
          }
          const measured = windows.length === 0
            ? []
            : await dependencies.visual.measure({ windows, ...(request.signal ? { signal: request.signal } : {}) })
          for (const measurement of measured) {
            if (measurement.sampledFrameCount === 0) {
              note(measurement.evidenceRef, 'the decode produced no frames')
              continue
            }
            const range = sessionRangeForSourceMs({
              session,
              track,
              part,
              map: mapBySource.get(track.sourceAssetId) ?? null,
              startMs: measurement.sourceStartMs,
              endMs: measurement.sourceEndMs,
            })
            if (!range) {
              note(measurement.evidenceRef, 'the window does not map onto one piece of the session clock')
              continue
            }
            const provenance = Object.freeze({
              method: measurement.method.slice(0, 128),
              evaluatorKind: 'measured' as const,
              evidenceRef: measurement.evidenceRef.slice(0, 512),
              producedAt,
            })
            // Zero activity is not an observation of stillness: it is the
            // absence of activity, and the evidence kind refuses the zero
            // outright (`multicam-evidence.ts:157-166`).
            if (track.role === 'screen' && measurement.activityBps !== null && measurement.activityBps > 0) {
              observations.push({
                observationId: `screen-${track.trackId}-${measurement.sourceStartMs}`.slice(0, 127),
                trackId: track.trackId,
                range,
                kind: 'screen-activity',
                value: Object.freeze({ kind: 'screen-activity' as const, activityBps: measurement.activityBps }),
                confidence: 1,
                provenance,
              })
            }
            const dimensions = {
              sharpnessBps: measurement.sharpnessBps,
              stabilityBps: measurement.stabilityBps,
              exposureBps: measurement.exposureBps,
            }
            if (Object.values(dimensions).some((value) => value !== null)) {
              observations.push({
                observationId: `quality-${track.trackId}-${measurement.sourceStartMs}`.slice(0, 127),
                trackId: track.trackId,
                range,
                kind: 'technical-quality',
                value: Object.freeze({ kind: 'technical-quality' as const, ...dimensions }),
                confidence: 1,
                provenance,
              })
            } else {
              note(measurement.evidenceRef, 'the pass measured no quality dimension')
            }
          }
        } finally {
          // The S3 driver materializes by downloading the whole recording; a
          // sweep that forgets leaks one copy per part. A release that fails is
          // reported, never rethrown: tidy-up must not turn a completed
          // measurement into a failed one.
          if (media) {
            await media.release().catch((error: unknown) => {
              note(`${track.trackId}:${part.partId}`, `materialized media could not be released: ${error instanceof Error ? error.message : String(error)}`)
            })
          }
        }
      }
    }

    // (d) Perception, when the project has any. When it has none there are no
    // reaction observations at all — the truth, and not a zero.
    if (dependencies.perception) {
      const timelines = await dependencies.perception.listReactionIntensities({
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        sourceArtifactIds: artifactIds,
      })
      for (const timeline of timelines) {
        const located = locateArtifact(session, timeline.sourceArtifactId)
        if (!located) {
          note(`perception:${timeline.timelineId}`, 'no part of any capture track carries this artifact')
          continue
        }
        const { track, part } = located
        for (const entry of timeline.entries) {
          const range = sessionRangeForSourceMs({
            session,
            track,
            part,
            map: mapBySource.get(track.sourceAssetId) ?? null,
            startMs: entry.startMs,
            endMs: entry.endMs,
          })
          if (!range) {
            note(`perception:${timeline.timelineId}:${entry.entryId}`, 'the entry does not map onto one piece of the session clock')
            continue
          }
          observations.push({
            observationId: `reaction-${timeline.timelineId}-${entry.entryId}`.slice(0, 127),
            trackId: track.trackId,
            range,
            kind: 'reaction',
            value: Object.freeze({ kind: 'reaction' as const, intensityBps: entry.intensityBps }),
            confidence: entry.confidence,
            provenance: Object.freeze({
              method: timeline.method.slice(0, 128),
              evaluatorKind: 'measured' as const,
              evidenceRef: `perception-timeline:${timeline.timelineId}:${entry.entryId}`.slice(0, 512),
              producedAt: timeline.producedAt,
            }),
          })
        }
      }
    }

    const set = createMulticamEvidenceSet({ session, observations, generatedAt: producedAt })
    const stored = await dependencies.directions.persistEvidenceSet({ set, createdAt: producedAt })
    return Object.freeze({ set: stored.set, replayed: stored.replayed, skipped: Object.freeze(skipped) })
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface DirectMulticamProtectedSelectionInput {
  readonly selectionId: string
  readonly trackId: string
  /** Session ticks as decimal strings, the shape the public boundary carries. */
  readonly sessionStartTicks: string
  readonly sessionEndTicks: string
  /** The operator's own words. The identity comes from the authenticated actor. */
  readonly note: string
}

export interface DirectMulticamSessionRequest {
  readonly workspaceId: string
  readonly projectId: string
  readonly sessionId: string
  readonly baseVersionId: string
  readonly baseHash: string
  readonly format: Readonly<{ aspectRatio: OutputAspectRatio }>
  /**
   * The stretch of session time to direct, as decimal tick strings.
   *
   * A position, which a request may carry, not a measurement, which it may not.
   * Omitting it directs the reference track's own hull — and when the recorder
   * outran the cameras that hull includes instants no camera covered, which the
   * direction reports as `uncovered` and the compile step then refuses. Naming
   * the range is how an operator says "cut the part we actually filmed"; the
   * refusal is how the system says "you did not tell me what to do with the
   * rest".
   */
  readonly range?: Readonly<{ sessionStartTicks: string; sessionEndTicks: string }>
  readonly policy?: DirectionPolicyOverrides
  readonly protectedSelections?: readonly Readonly<DirectMulticamProtectedSelectionInput>[]
  readonly reason?: string
  readonly actor: Readonly<AuthenticatedExternalActor>
  readonly idempotency: Readonly<{ clientId: string; key: string }>
}

export interface DirectMulticamSessionServiceResult extends MulticamDirectionCommandResult {
  /**
   * Null on a replay whose direction the chain has since moved past.
   *
   * A retry must return the first answer, and the Command it returns is still
   * the one that produced the stored version. What is no longer available is
   * "the direction as it stands now", because it is a different cut — handing
   * back the current head under the old Command's name would be the wrong
   * answer dressed as the right one, and refusing the retry would break
   * idempotency over something the caller cannot fix.
   */
  readonly direction: Readonly<MulticamDirection> | null
  readonly directionVersion: number | null
  /**
   * Null on a replay. A retry returns the first answer without doing the work
   * again, and re-running the compile step to fill this in would be new work
   * whose only purpose is to populate a field the caller already has the plan
   * for.
   */
  readonly compilation: Readonly<MulticamShotCompilation> | null
  readonly evidenceReplayed: boolean
}

export interface DirectMulticamSessionDependencies {
  sessions: Pick<CaptureSessionRepository, 'readHead' | 'listCoverage' | 'listClockMaps'>
  diagnostics: Pick<SyncDiagnosticRepository, 'readHead'>
  protocols: Pick<CaptureProtocolRepository, 'listEvaluations'>
  directions: Pick<MulticamDirectionRepository, 'readHead' | 'appendVersion'>
  commands: MulticamDirectionCommandRepository
  deriveEvidence: (input: { workspaceId: string; projectId: string; sessionId: string }) => Promise<Readonly<DeriveMulticamEvidenceResult>>
  clock: () => Date
  createId: (prefix: string) => string
  createEventId: () => string
}

function isDirected(plan: MulticamDirectionCommandContext['currentPlan']): plan is Readonly<DirectedEditPlan> {
  const candidate = plan as Partial<DirectedEditPlan>
  return typeof candidate.directorRunId === 'string'
    && typeof candidate.storyPlanId === 'string'
    && typeof candidate.treatmentPlanId === 'string'
    && typeof candidate.desiredActionRef === 'object'
    && candidate.desiredActionRef !== null
}

/**
 * The compiled shots as the single `base-video` track of a Director EditPlan.
 *
 * One shot is one clip; nothing composes, overlays or retimes. The seams are
 * explicit straight cuts because that is the only transition the plan admits
 * (`director-run.ts:134`), and there is exactly one per seam because
 * `validateDirectedEditPlan` counts them (`:358`).
 *
 * `sources[]` lists the files the picture comes from. The audio bed rides on the
 * clips (`audioSourceArtifactId`) rather than in `sources[]`, because a plan
 * source's `kind` is the closed literal `'video'` (`director-run.ts:37`) and
 * declaring an audio recorder a video source would be a wrong label on a real
 * file. Nothing is lost: `hydrateSource` builds the render sources from the
 * union of every clip's video AND audio artifact ids
 * (`prisma/project-proxy-render-repository.ts:106-110`).
 */
export function buildMulticamEditPlan(input: {
  base: Readonly<DirectedEditPlan>
  planId: string
  projectVersionId: string
  compilation: Readonly<MulticamShotCompilation>
  decisions: readonly Readonly<DirectorDecisionInput>[]
  assumptions: readonly string[]
  createdAt: string
}): Readonly<DirectedEditPlan> {
  const clips: Readonly<EditorialCutClip>[] = input.compilation.clips.map((clip) => Object.freeze({
    id: `clip-${clip.shotId}`,
    sourceArtifactId: clip.sourceAssetId,
    cameraId: clip.cameraId,
    ...(clip.audioSourceAssetId !== undefined
      ? {
        audioSourceArtifactId: clip.audioSourceAssetId,
        audioSourceInFrame: clip.audioSourceInFrame!,
        audioSourceOutFrame: clip.audioSourceOutFrame!,
      }
      : {}),
    sourceInFrame: clip.sourceInFrame,
    sourceOutFrame: clip.sourceOutFrame,
    timelineInFrame: clip.timelineInFrame,
    timelineOutFrame: clip.timelineOutFrame,
    rate: 1,
  }))
  const fps = Number(input.compilation.planFps.num) / Number(input.compilation.planFps.den)
  const durationFrames = input.compilation.durationFrames
  const transitions: Readonly<DirectedTransition>[] = clips.slice(0, -1).map((clip, index) => Object.freeze({
    id: `transition-${String(index + 1).padStart(4, '0')}`,
    fromClipId: clip.id,
    toClipId: clips[index + 1]!.id,
    atFrame: clip.timelineOutFrame,
    type: 'straight-cut' as const,
    audioFadeMs: 24,
    reason: 'Angle change over one continuous audio bed: an invisible straight cut with a bounded edge fade.',
  }))
  const plan: DirectedEditPlan = {
    ...input.base,
    id: input.planId,
    projectVersionId: input.projectVersionId,
    fps,
    durationFrames,
    sources: Object.freeze(input.compilation.sources
      .filter((source) => source.kinds.includes('video'))
      .map((source) => Object.freeze({
        id: source.sourceAssetId,
        artifactId: source.sourceAssetId,
        kind: 'video' as const,
        durationSeconds: (source.durationFrames * Number(source.frameRate.den)) / Number(source.frameRate.num),
      }))),
    videoTracks: Object.freeze([Object.freeze({
      id: 'track-primary-video',
      kind: 'base-video' as const,
      clips: Object.freeze(clips),
    })]),
    overlayTracks: Object.freeze(input.base.overlayTracks.map((overlay) => Object.freeze({
      ...overlay,
      // The CTA keeps its length and is re-anchored to the end of the timeline
      // this direction produced. A frame index from the timeline it replaced
      // would point at a different moment, or past the end.
      startFrame: Math.max(0, durationFrames - Math.max(1, overlay.endFrame - overlay.startFrame)),
      endFrame: durationFrames,
    }))),
    // Dropped rather than carried: the cues were timed against the timeline
    // this direction replaced, and a caption that lands on the wrong angle is
    // worse than no caption. `assumptions` says so out loud, and re-running the
    // Director over the new plan is what puts them back.
    subtitleTracks: Object.freeze([]),
    effectTracks: Object.freeze([]),
    transitions: Object.freeze(transitions),
    // Dropped for the same reason as the cues, and said out loud for the same
    // reason: an editorial-cut marker carries `sourceStartSeconds` /
    // `sourceEndSeconds` of the ONE recording the old timeline was trimmed from
    // (`director-run.ts:56-62`), which describes nothing once the picture is cut
    // from several cameras. Emptied silently it would look like a plan that
    // never had markers.
    markers: Object.freeze([]),
    // The exclusions and retained ranges named source seconds of the single
    // recording the old timeline was trimmed from; after a re-cut across
    // cameras they describe nothing. `commandType` stays whatever produced the
    // base plan because the field is a closed literal of two values and
    // `direct-multicam-session` is not one of them — a divergence reported
    // rather than hidden (director-run.ts:71).
    editorial: Object.freeze({
      commandType: input.base.editorial.commandType,
      exclusions: Object.freeze([]),
      retainedSourceRanges: Object.freeze([]),
    }),
    retimedTranscript: Object.freeze({
      sourceTranscriptId: input.base.retimedTranscript.sourceTranscriptId,
      words: Object.freeze([]),
    }),
    director: Object.freeze({
      plannerVersion: MULTICAM_DIRECTION_PLANNER_VERSION,
      decisions: validateDirectorDecisions(input.decisions),
      assumptions: Object.freeze([...input.assumptions]),
    }),
    movementPolicy: Object.freeze({
      automaticZoom: false as const,
      protectedOpeningFrames: Math.max(input.base.movementPolicy.protectedOpeningFrames, Math.round(fps * 4)),
    }),
    audioTimelineHash: createEditorialAudioTimelineHash({ fps, clips }),
    lineageRefs: Object.freeze([...new Set([
      ...input.base.lineageRefs,
      `multicam-direction:${input.compilation.directionHash}`,
    ])].sort()),
    createdAt: input.createdAt,
  }
  return validateDirectedEditPlan(plan)
}

/**
 * The decisions the direction actually made, as Director decisions.
 *
 * Four kinds, all real: a summary of the angle work, one per shot, the seam
 * policy, and the audio bed. `validateDirectorDecisions` caps the list at 64
 * (`director-run.ts:283`) and a busy direction has more shots than that, so the
 * shots are cited least-confident first — the ones a reviewer opens — and the
 * summary says how many were left out and where the complete record lives.
 * Nothing is lost by the cap: every shot is a row in `multicam_shot_decisions`
 * with its rule, its reason, its alternatives, its evidence refs and now every
 * candidate it evaluated.
 */
export function buildAngleDecisions(direction: Readonly<MulticamDirection>, directionVersion: number): Readonly<{
  decisions: readonly Readonly<DirectorDecisionInput>[]
  assumptions: readonly string[]
  omittedShots: number
}> {
  // `validId` (director-run.ts:268) refuses the `/` a session id may contain
  // (`capture-session.ts:50`), so the id is folded rather than interpolated
  // raw — a decision that cannot be validated cannot be logged.
  //
  // Unreachable today, and left in on purpose: `sync-diagnostic.ts:151` uses a
  // NARROWER id grammar than `capture-session.ts:50` and refuses the same `/`,
  // so a session id containing one can have no diagnostic and therefore cannot
  // be directed at all. That divergence between two authority modules is
  // reported rather than relied on; the day it is reconciled, this keeps
  // working.
  const token = direction.sessionId.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 80)
  const directionRef = `multicam-direction:${direction.sessionId}:v${directionVersion}`
  const diagnosticRef = `sync-diagnostic:${direction.sessionId}:v${direction.diagnosticVersion}`
  const byConfidence = [...direction.shots]
    .sort((left, right) => (left.confidence - right.confidence) || (left.ordinal - right.ordinal))
  const cited = byConfidence.slice(0, 64 - 3).sort((left, right) => left.ordinal - right.ordinal)
  const omittedShots = byConfidence.length - cited.length
  const weakest = byConfidence[0]
  const summary: DirectorDecisionInput = {
    id: `decision-angle-summary-${token}`,
    category: 'angle',
    choice: `${direction.shots.length} shot(s) across ${new Set(direction.shots.map((shot) => shot.chosen.trackId)).size} angle(s)`,
    reason: [
      `Directed ${direction.sessionId} version ${direction.sessionVersion} over ticks ${direction.range.start}-${direction.range.end}`,
      `under calibration ${direction.policy.calibrationVersion} for ${direction.format.aspectRatio}`,
      direction.uncovered.length > 0
        ? `${direction.uncovered.length} stretch(es) had no eligible angle`
        : 'every directed instant had an eligible angle',
      direction.warnings.length > 0 ? `${direction.warnings.length} warning(s) recorded` : 'no warnings',
      omittedShots > 0
        ? `${omittedShots} shot decision(s) are omitted here and stored in full beside the direction`
        : 'every shot decision is cited here',
    ].join('; '),
    evidenceRefs: Object.freeze([directionRef, diagnosticRef, `multicam-evidence:${direction.evidenceHash.slice(0, 32)}`]),
    // The weakest shot is the direction's confidence: a cut is only as
    // trustworthy as its least certain angle choice, and averaging would let
    // fifty confident holds hide one guess.
    confidence: weakest ? weakest.confidence : 0,
    alternatives: Object.freeze(direction.warnings.slice(0, 8).map((warning) => `${warning.code}: ${warning.detail}`.slice(0, 512))),
  }
  const seam: DirectorDecisionInput = {
    id: `decision-angle-seams-${token}`,
    category: 'transition',
    choice: 'straight-cut',
    reason: 'Angle changes over one continuous audio bed: a straight cut with a bounded edge fade is invisible, and any other transition would assert an editorial beat the evidence did not find.',
    evidenceRefs: Object.freeze([directionRef]),
    confidence: 0.9,
    alternatives: Object.freeze(['cross-dissolve: refused — the Director plan admits only straight cuts (director-run.ts:134)']),
  }
  const audio: DirectorDecisionInput = {
    id: `decision-angle-audio-${token}`,
    category: 'insert',
    choice: direction.audio.trackId ?? 'source-audio-per-clip',
    reason: direction.audio.trackId
      ? `${direction.audio.trackId} carries the final mix under every shot; ${direction.audio.rejected.length} other track(s) were rejected by name.`
      : 'No track is both marked for the final mix and carrying final-candidate audio, so every clip keeps the audio of its own camera.',
    evidenceRefs: Object.freeze([directionRef]),
    confidence: direction.audio.trackId ? 0.9 : 0.5,
    alternatives: Object.freeze(direction.audio.rejected.map((entry) => `${entry.trackId}: ${entry.reason}`)),
  }
  return Object.freeze({
    decisions: Object.freeze([summary, seam, audio, ...cited.map(toAngleDecision)]),
    assumptions: Object.freeze([
      'Subtitle cues from the timeline this direction replaced are dropped: their frames named a different cut, and a caption over the wrong angle is worse than none.',
      'The retimed transcript is emptied for the same reason; re-running the Director over this plan restores both.',
      'The editorial exclusions and retained source ranges are cleared: they named seconds of the single recording the old timeline was trimmed from, and this timeline is cut from several.',
      'The editorial-cut markers are dropped with them: each one names source seconds of that same single recording, so keeping them would point a reviewer at an instant this cut no longer contains.',
      ...(omittedShots > 0
        ? [`${omittedShots} shot decision(s) exceed the 64-decision cap and are stored in full in the direction rather than in this log.`]
        : []),
    ]),
    omittedShots,
  })
}

/**
 * Store the direction, or recognise that this exact direction is already stored.
 *
 * A direction is content-addressed by `directionHash`, so a retry that derived
 * the same cut is the same answer arriving twice and must not append a second
 * link to the chain. The head is read for that comparison only; the fence that
 * decides a race is still the version+hash predicate inside `appendVersion`'s
 * own UPDATE.
 */
async function persistDirection(
  directions: DirectMulticamSessionDependencies['directions'],
  direction: Readonly<MulticamDirection>,
  occurredAt: string,
): Promise<Readonly<{ version: number; replayed: boolean }>> {
  const head = await directions.readHead({ workspaceId: direction.workspaceId, sessionId: direction.sessionId })
  if (head && head.direction.directionHash === direction.directionHash) {
    return Object.freeze({ version: head.version, replayed: true })
  }
  const appended = await directions.appendVersion({
    direction,
    base: head ? { version: head.version, directionHash: head.direction.directionHash } : null,
    occurredAt,
  })
  return Object.freeze({ version: appended.stored.version, replayed: appended.replayed })
}

export function directMulticamSessionService(dependencies: DirectMulticamSessionDependencies) {
  return async function execute(request: Readonly<DirectMulticamSessionRequest>): Promise<Readonly<DirectMulticamSessionServiceResult>> {
    // The whole request is scanned except the authenticated actor, which is
    // built by `authenticate-api-client` rather than sent — scanning it would
    // refuse a legitimate credential field that happens to share a name with a
    // derivation.
    const { actor: _actor, ...scannable } = request
    assertNoCallerDerivations(scannable as Record<string, unknown>, '')
    const workspaceId = request.workspaceId.trim()
    const projectId = request.projectId.trim()
    const sessionId = request.sessionId.trim()
    const baseVersionId = request.baseVersionId.trim()
    const idempotencyKey = request.idempotency.key.trim()
    assertDomain(ID.test(workspaceId) && ID.test(projectId) && ID.test(sessionId), 'INVALID_COMMAND', 'Multicam direction scope is invalid')
    assertDomain(baseVersionId.length >= 3 && HASH.test(request.baseHash), 'INVALID_COMMAND', 'Multicam direction base version is invalid')
    assertDomain(idempotencyKey.length > 0 && idempotencyKey.length <= 128, 'INVALID_COMMAND', 'Multicam direction idempotency key is invalid')
    assertDomain(
      OUTPUT_ASPECT_RATIOS.includes(request.format?.aspectRatio),
      'INVALID_COMMAND',
      `${request.format?.aspectRatio} is not an output aspect ratio`,
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(
      authenticationAudit.workspaceId === workspaceId && request.idempotency.clientId === authenticationAudit.clientId,
      'AUTH_INVALID',
      'Multicam direction actor does not match its workspace or idempotency client',
    )
    const policy = resolvePolicy(request.policy)

    // Who moved the shot is recorded, not only what they said about it: the note
    // is the caller's, the identity is the authenticated actor's, and the two
    // are concatenated. A note that replaced the actor would let a request
    // choose whose name sits on a human override.
    const attestedBy = `${authenticationAudit.clientId}${authenticationAudit.delegatedUserId ? `/${authenticationAudit.delegatedUserId}` : ''}`
    const protectedSelections: Readonly<ProtectedSelection>[] = (request.protectedSelections ?? []).map((selection, index) => {
      assertDomain(
        typeof selection === 'object' && selection !== null && !Array.isArray(selection),
        'INVALID_ARGUMENT',
        `protectedSelections[${index}] must be an object`,
      )
      for (const key of Object.keys(selection)) {
        if (!(PROTECTED_SELECTION_KEYS as readonly string[]).includes(key)) {
          refuseDerivation(
            `protectedSelections[${index}].${key}`,
            'is not one of the four things a protected selection says (selectionId, trackId, sessionStartTicks, sessionEndTicks, note)',
          )
        }
      }
      const note = typeof selection.note === 'string' ? selection.note.trim() : ''
      assertDomain(note.length > 0 && note.length <= 400, 'INVALID_ARGUMENT', `protectedSelections[${index}].note must say why`)
      return Object.freeze({
        selectionId: selection.selectionId,
        trackId: selection.trackId,
        sessionRange: createTickInterval(
          parseTick(selection.sessionStartTicks, `protectedSelections[${index}].sessionStartTicks`),
          parseTick(selection.sessionEndTicks, `protectedSelections[${index}].sessionEndTicks`),
        ),
        reason: note,
        attestedBy,
      })
    })

    const requestFingerprint = calculateVersionHash({
      type: 'direct-multicam-session',
      workspaceId,
      projectId,
      sessionId,
      baseVersionId,
      baseHash: request.baseHash,
      aspectRatio: request.format.aspectRatio,
      range: request.range ? [request.range.sessionStartTicks, request.range.sessionEndTicks] : null,
      policy: request.policy ?? null,
      protectedSelections: protectedSelections.map((selection) => ({
        selectionId: selection.selectionId,
        trackId: selection.trackId,
        start: selection.sessionRange.start.toString(),
        end: selection.sessionRange.end.toString(),
        reason: selection.reason,
        attestedBy: selection.attestedBy,
      })),
      reason: request.reason?.trim() || null,
      actorContextHash: authenticationAudit.contextHash,
    })
    const existing = await dependencies.commands.findIdempotentResult({
      workspaceId,
      projectId,
      idempotencyKey,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different multicam direction request')
      }
      const head = await dependencies.directions.readHead({ workspaceId, sessionId })
      const sameDirection = head !== null
        && head.direction.directionHash === existing.result.command.payload.directionHash
      return Object.freeze({
        ...existing.result,
        replayed: true,
        direction: sameDirection ? head.direction : null,
        directionVersion: sameDirection ? head.version : null,
        compilation: null,
        evidenceReplayed: true,
      })
    }

    const context = await dependencies.commands.readContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', `Project ${projectId} was not found`)
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== request.baseHash) {
      throw new DomainError('VERSION_CONFLICT', 'Multicam direction base version is stale', {
        currentVersionId: context.currentVersion.id,
        currentBaseHash: context.currentVersion.baseHash,
      })
    }
    const base = context.currentPlan
    if (!isDirected(base)) {
      // A multicam direction re-cuts a timeline; it does not invent one. The
      // story plan, the treatment and the desired action a Director EditPlan
      // names are decisions this command did not make, and filling them with
      // ids that point at nothing would put dangling references into a plan the
      // renderer reads.
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        `Project ${projectId} has no Director EditPlan to re-cut; run the Director once before directing a capture session across its cameras`,
        { projectVersionId: context.currentVersion.id },
      )
    }

    const session = await dependencies.sessions.readHead({ workspaceId, sessionId })
    if (!session) throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${sessionId} was not found`)
    const diagnostic = await dependencies.diagnostics.readHead({ workspaceId, sessionId })
    if (!diagnostic) {
      throw new DomainError(
        'SYNC_DIAGNOSTIC_NOT_FOUND',
        `Capture session ${sessionId} has no sync diagnostic; nothing can say whether an angle may be cut to`,
      )
    }
    const [coverages, clockMaps, evaluations] = await Promise.all([
      dependencies.sessions.listCoverage({ workspaceId, sessionId }),
      dependencies.sessions.listClockMaps({ workspaceId, sessionId }),
      dependencies.protocols.listEvaluations({ workspaceId, sessionId }),
    ])
    // Only an evaluation of THIS session version says anything about it: a
    // ceiling from version 3 describes a session that no longer exists. With
    // none, the diagnostic's own ceiling stands (`prepareContext` falls back
    // when `protocolCeiling` is null).
    const evaluation = evaluations.find((entry) => entry.sessionVersion === session.version) ?? null

    const evidence = await dependencies.deriveEvidence({ workspaceId, projectId, sessionId })
    const createdAt = dependencies.clock().toISOString()
    const direction = directMulticam({
      session,
      coverages,
      clockMaps,
      diagnostic,
      protocolCeiling: evaluation ? evaluation.ceiling : null,
      evidence: evidence.set,
      policy,
      format: { aspectRatio: request.format.aspectRatio },
      protectedSelections,
      ...(request.range
        ? {
          range: createTickInterval(
            parseTick(request.range.sessionStartTicks, 'range.sessionStartTicks'),
            parseTick(request.range.sessionEndTicks, 'range.sessionEndTicks'),
          ),
        }
        : {}),
      generatedAt: createdAt,
    })

    // Stored BEFORE the plan is compiled. A direction that leaves a stretch with
    // no eligible angle cannot become clips — `compileShotsToSourceRanges`
    // refuses it — and that direction, with its warnings and its uncovered
    // ranges, is exactly the artifact an operator needs to read. Discarding it
    // because the compile failed would answer "no" and delete the evidence for
    // the answer.
    const persisted = await persistDirection(dependencies.directions, direction, createdAt)

    const probedRates = new Map(context.mediaLinks
      .filter((link) => link.frameRate !== null)
      .map((link) => [link.artifactId, link.frameRate!]))
    const compilation = compileShotsToSourceRanges(direction, {
      session,
      clockMaps,
      coverages,
      planFps: planFrameRate(base.fps),
      sourceFrameRates: Object.freeze(session.tracks
        .filter((track) => probedRates.has(track.sourceAssetId))
        .map((track) => Object.freeze({ trackId: track.trackId, frameRate: probedRates.get(track.sourceAssetId)! }))),
    })

    // Every artifact the clips point at has to be a linked, available project
    // asset or `hydrateSource` refuses the whole render
    // (`prisma/project-proxy-render-repository.ts:111-141`). Caught here, where
    // an operator can link the recording, instead of inside a worker.
    const linked = new Map(context.mediaLinks.map((link) => [link.artifactId, link]))
    const missing = [...new Set(compilation.clips.flatMap((clip) => [
      clip.sourceAssetId,
      ...(clip.audioSourceAssetId ? [clip.audioSourceAssetId] : []),
    ]))].filter((artifactId) => {
      const link = linked.get(artifactId)
      return !link || link.status !== 'available' || !['video', 'audio'].includes(link.mediaType)
    }).sort()
    if (missing.length > 0) {
      throw new DomainError(
        'MEDIA_ARTIFACT_SOURCE_NOT_FOUND',
        `The compiled direction cuts ${missing.length} recording(s) the project does not link as available media`,
        { artifactIds: missing, projectId },
      )
    }

    const angles = buildAngleDecisions(direction, persisted.version)
    const commandId = dependencies.createId('edit-command')
    const versionId = dependencies.createId('project-version')
    const snapshotId = dependencies.createId('project-snapshot')
    const editPlan = buildMulticamEditPlan({
      base,
      planId: `edit-plan-${versionId}`,
      projectVersionId: versionId,
      compilation,
      decisions: angles.decisions,
      assumptions: angles.assumptions,
      createdAt,
    })
    const built = buildDirectMulticamSessionCommand({
      commandId,
      workspaceId,
      projectId,
      baseVersionId,
      baseHash: request.baseHash,
      resultVersionId: versionId,
      author: {
        type: 'api-client',
        id: authenticationAudit.clientId,
        ...(authenticationAudit.delegatedUserId ? { delegatedUserId: authenticationAudit.delegatedUserId } : {}),
      },
      direction,
      durationFrames: Math.max(context.currentDurationFrames, editPlan.durationFrames),
      outputReferences: context.outputReferences,
      idempotencyKey,
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      createdAt,
    })
    const editPlanHash = calculateVersionHash(editPlan)
    const snapshot = createProjectSnapshot({
      id: snapshotId,
      workspaceId,
      projectId,
      kind: 'edit-plan',
      contentSchemaVersion: 2,
      contentJson: stableSerialize(editPlan),
      contentHash: editPlanHash,
      createdAt,
    })
    const version = createProjectVersion({
      id: versionId,
      workspaceId,
      projectId,
      sequence: context.currentVersion.sequence + 1,
      parentVersionId: context.currentVersion.id,
      snapshotRefs: {
        brief: context.currentVersion.snapshotRefs.brief,
        editPlan: snapshotId,
        policies: context.currentVersion.snapshotRefs.policies,
      },
      baseHash: calculateVersionHash({
        projectId,
        sequence: context.currentVersion.sequence + 1,
        parentVersionId: context.currentVersion.id,
        previousBaseHash: context.currentVersion.baseHash,
        commandId,
        editPlanHash,
        resultBaseHash: built.resultBaseHash,
      }),
      createdBy: authenticationAudit.clientId,
      commandId,
      createdAt,
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(),
      type: 'project.version.created',
      version: '1.0.0',
      workspaceId,
      occurredAt: createdAt,
      sequence: version.sequence,
      actor: {
        clientId: authenticationAudit.clientId,
        ...(authenticationAudit.delegatedUserId ? { userId: authenticationAudit.delegatedUserId } : {}),
      },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId,
        sequence: version.sequence,
        parentVersionId: version.parentVersionId,
        baseHash: version.baseHash,
        commandId,
        commandType: built.command.type,
        commandImpactHash: built.impact.impactHash,
        invalidatedArtifactCount: built.impact.affectedArtifacts.length,
        snapshotRefs: version.snapshotRefs,
        sessionId,
        directionHash: direction.directionHash,
        manualReviewRequired: direction.manualReviewRequired,
        createdAt,
      },
    })
    const committed = await dependencies.commands.commitOrReplay({
      command: built.command,
      authenticationAudit,
      requestFingerprint,
      snapshot,
      version,
      editPlan,
      event,
      directionEvidence: {
        sessionId,
        sessionVersion: direction.sessionVersion,
        directionVersion: persisted.version,
        directionHash: direction.directionHash,
      },
    })
    return Object.freeze({
      ...committed,
      direction,
      directionVersion: persisted.version,
      compilation,
      evidenceReplayed: evidence.replayed,
    })
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * How one link of the direction chain is named on the wire.
 *
 * The same shape `diagnosticVersionId` uses (`sync-diagnostic-contract.ts:85`),
 * for the same reason: a caller that fences on a derivation names the pair, and
 * a bare number would not say which chain it belongs to.
 */
export function directionVersionRef(sessionId: string, version: number): string {
  return `${sessionId}:direction:v${version}`
}

export interface MulticamDirectionRead {
  readonly direction: Readonly<MulticamDirection>
  readonly version: number
  readonly previousVersionHash: string | null
  readonly versionRef: string
  /** False when an older link was read: what it says is history, not the cut. */
  readonly isHead: boolean
}

export type MulticamDirectionReader = Pick<MulticamDirectionRepository, 'readHead' | 'readVersion'>

export interface MulticamDirectionReadRequest {
  readonly workspaceId: string
  readonly sessionId: string
  /** Omitted reads the head. Naming a version reads exactly that link. */
  readonly version?: number
}

/**
 * The head is read even when an older version was asked for.
 *
 * Two reads rather than one because `isHead` is the difference between "this is
 * the cut" and "this is what the cut used to be", and a reader looking at a
 * superseded direction with no way to tell would quote a rejected angle as the
 * current one. The extra read is a primary-key lookup; the ambiguity it removes
 * is the whole reason the chain is immutable.
 */
async function readDirection(
  directions: MulticamDirectionReader,
  input: Readonly<MulticamDirectionReadRequest>,
): Promise<Readonly<MulticamDirectionRead>> {
  const head = await directions.readHead({ workspaceId: input.workspaceId, sessionId: input.sessionId })
  if (!head) {
    throw new DomainError(
      'MULTICAM_DIRECTION_NOT_FOUND',
      `Capture session ${input.sessionId} has not been directed across its cameras`,
    )
  }
  if (input.version !== undefined) {
    assertDomain(
      Number.isSafeInteger(input.version) && input.version >= 1,
      'INVALID_ARGUMENT',
      'version must be a positive integer link of the direction chain',
    )
  }
  const stored = input.version === undefined || input.version === head.version
    ? head
    : await directions.readVersion({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      version: input.version,
    })
  if (!stored) {
    throw new DomainError(
      'MULTICAM_DIRECTION_NOT_FOUND',
      `Capture session ${input.sessionId} has no direction version ${input.version}`,
      { currentVersion: head.version, currentHash: head.direction.directionHash },
    )
  }
  return Object.freeze({
    direction: stored.direction,
    version: stored.version,
    previousVersionHash: stored.previousVersionHash,
    versionRef: directionVersionRef(input.sessionId, stored.version),
    isHead: stored.version === head.version,
  })
}

export function readMulticamDirectionService(dependencies: { directions: MulticamDirectionReader }) {
  return async function read(
    input: Readonly<MulticamDirectionReadRequest>,
  ): Promise<Readonly<MulticamDirectionRead>> {
    return readDirection(dependencies.directions, input)
  }
}

const DIRECTION_LISTING_MAX = 200

function assertListingWindow(input: Readonly<{ startTicks?: bigint; endTicks?: bigint; limit?: number }>): number {
  const limit = input.limit ?? 25
  assertDomain(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= DIRECTION_LISTING_MAX,
    'INVALID_ARGUMENT',
    `limit must be between 1 and ${DIRECTION_LISTING_MAX}`,
  )
  assertDomain(
    input.startTicks === undefined || input.endTicks === undefined || input.startTicks < input.endTicks,
    'INVALID_ARGUMENT',
    'startTicks must be before endTicks',
  )
  return limit
}

/** Half-open overlap, the comparison every range in this domain is read with. */
function overlapsWindow(
  range: Readonly<TickInterval>,
  window: Readonly<{ startTicks?: bigint; endTicks?: bigint }>,
): boolean {
  return (window.startTicks === undefined || range.end > window.startTicks)
    && (window.endTicks === undefined || range.start < window.endTicks)
}

export interface MulticamAngleCandidateWindow {
  readonly shotId: string
  readonly ordinal: number
  readonly sessionRange: Readonly<TickInterval>
  readonly rule: DirectionRule
  readonly chosenCandidateId: string
  /**
   * Every track evaluated over this shot, chosen and rejected alike, each with
   * its own eligibility and rejection reasons (ADR-118).
   */
  readonly candidates: readonly Readonly<AngleCandidate>[]
}

export interface MulticamAngleCandidateListing extends MulticamDirectionRead {
  readonly windows: readonly Readonly<MulticamAngleCandidateWindow>[]
  /** Shots inside the asked-for range that the limit left out. */
  readonly omittedWindows: number
}

/**
 * One shot's decided window, as the candidate listing publishes it.
 *
 * Exported so the listing, its published example and any future caller derive
 * the window the same way. A second mapping written beside this one is a second
 * answer to "which candidates were offered here".
 */
export function toAngleCandidateWindow(
  shot: Readonly<ShotDecision>,
  trackId?: string,
): Readonly<MulticamAngleCandidateWindow> {
  return Object.freeze({
    shotId: shot.shotId,
    ordinal: shot.ordinal,
    sessionRange: shot.sessionRange,
    rule: shot.rule,
    chosenCandidateId: shot.chosen.candidateId,
    candidates: Object.freeze(trackId === undefined
      ? [...shot.evaluated]
      : shot.evaluated.filter((candidate) => candidate.trackId === trackId)),
  })
}

/**
 * What was on offer at each instant of a range, and why the rest lost.
 *
 * Read out of the stored direction rather than re-derived: re-running the
 * scorer to answer "why was camera B rejected?" would answer about today's
 * evidence, not about the evidence the cut was made from.
 */
export function listMulticamAngleCandidatesService(dependencies: { directions: MulticamDirectionReader }) {
  return async function list(input: Readonly<MulticamDirectionReadRequest & {
    startTicks?: bigint
    endTicks?: bigint
    /** Keep only the candidacies of one track, in every window it was offered. */
    trackId?: string
    limit?: number
  }>): Promise<Readonly<MulticamAngleCandidateListing>> {
    const limit = assertListingWindow(input)
    const read = await readDirection(dependencies.directions, input)
    const matching = read.direction.shots
      .filter((shot) => overlapsWindow(shot.sessionRange, input))
      .map((shot) => toAngleCandidateWindow(shot, input.trackId))
      // A track filter that leaves a window with nothing to say drops the
      // window: an empty candidate list would read as "this track was evaluated
      // here and lost", which is a different fact from "it was never offered".
      .filter((window) => window.candidates.length > 0)
    return Object.freeze({
      ...read,
      windows: Object.freeze(matching.slice(0, limit)),
      omittedWindows: Math.max(0, matching.length - limit),
    })
  }
}

export interface MulticamShotDecisionListing extends MulticamDirectionRead {
  readonly shots: readonly Readonly<ShotDecision>[]
  readonly omittedShots: number
}

/**
 * The decisions themselves: rule, justification, alternatives, evidence.
 *
 * Separate from the candidate listing because they answer different questions
 * and carry very different weight — a shot decision is a sentence and a handful
 * of losers, while the candidacies behind it are every measurement the scorer
 * read.
 */
export function listMulticamShotDecisionsService(dependencies: { directions: MulticamDirectionReader }) {
  return async function list(input: Readonly<MulticamDirectionReadRequest & {
    startTicks?: bigint
    endTicks?: bigint
    limit?: number
  }>): Promise<Readonly<MulticamShotDecisionListing>> {
    const limit = assertListingWindow(input)
    const read = await readDirection(dependencies.directions, input)
    const matching = read.direction.shots.filter((shot) => overlapsWindow(shot.sessionRange, input))
    return Object.freeze({
      ...read,
      shots: Object.freeze(matching.slice(0, limit)),
      omittedShots: Math.max(0, matching.length - limit),
    })
  }
}
