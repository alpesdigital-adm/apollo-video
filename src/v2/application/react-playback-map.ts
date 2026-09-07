import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import type {
  CaptureSession,
  CaptureTrack,
  CaptureTrackPart,
} from '../domain/capture-session.ts'
import type { DirectedEditPlan, DirectorDecisionInput } from '../domain/director-run.ts'
import type { DesiredActionInput } from '../domain/desired-action.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  applyPlaybackAnchor,
  buildPlaybackMap,
  compilePlaybackToShots,
  createPlaybackMap,
  defaultPlaybackPolicy,
  type PlaybackAnchor,
  type PlaybackMap,
  type PlaybackMode,
  type PlaybackObservation,
  type PlaybackPiece,
  type PlaybackReactionMedia,
  type PlaybackReferenceMedia,
  type PlaybackShot,
} from '../domain/playback-map.ts'
import {
  intervalDuration,
  serializeRational,
  serializeTickInterval,
  type Rational,
  type Timebase,
} from '../domain/session-time.ts'
import type { StrategicObjectiveId } from '../domain/strategic-objective.ts'
import type { EditorialCutClip } from './apply-editorial-cut-command.ts'
import type { CaptureSessionRepository } from './ports/capture-session-repository.ts'
import type { PlaybackMapRepository } from './ports/playback-map-repository.ts'
import type {
  RenderSourceRepository,
  ResolvedRenderSource,
} from './ports/render-source-repository.ts'
import type {
  RenderablePlanSnapshotRepository,
  StoredRenderablePlanSnapshot,
} from './ports/renderable-plan-snapshot-repository.ts'
import {
  assembleDirectedEditPlan,
  renderablePlanSnapshotOf,
  type RenderablePlanMarker,
  type RenderablePlanSeam,
} from './renderable-edit-plan.ts'
import type { SyncActor } from './sync-diagnostic.ts'

/**
 * The react playback map at runtime (F4.015 / FR-153).
 *
 * `domain/playback-map.ts` knows how to read a sequence of observations and how
 * to refuse a dishonest one. What it has never had is anything that *gets* the
 * observations: no service resolved the two recordings, ran a detector over
 * them, folded in what a person had already answered, and stored the result. A
 * map that can only be built in a test is not a feature.
 *
 * The three rules this file exists to keep:
 *
 * - **The caller supplies ids, never evidence.** A request names the session,
 *   the version it was read at and — for an anchor — one instant. The
 *   observations come from the detector, the pieces from the domain, the status
 *   from the pieces. There is no field a client can set to say "resolved".
 * - **Absence of evidence is refused by name.** A reaction the detector never
 *   locked onto produces a map with no reference piece at all, and such a map
 *   has no uncovered stretch either — so no anchor could ever repair it.
 *   Storing it would create a head that nothing can advance. It is refused with
 *   `PLAYBACK_EVIDENCE_INSUFFICIENT` instead, which is the ADR-135 answer:
 *   a hidden player needs a person, not a guess.
 * - **A person's answer is never re-applied to a range they did not see.** A
 *   rebuild carries manual anchors forward as record, and leaves the stretches
 *   they answered uncovered again. Re-running the anchor against a range that
 *   re-detection moved would put a measurement where nobody looked.
 */

/** The file behind one part of a track, and the way to give it back. */
export interface PlaybackMediaPort {
  /**
   * `release` is not optional politeness: the S3 driver downloads the whole
   * recording per call, so a react pass that forgets leaks two files.
   */
  resolve(input: {
    workspaceId: string
    part: Readonly<CaptureTrackPart>
  }): Promise<Readonly<{ path: string; release: () => Promise<void> }>>
}

/**
 * Where the reference is found inside the reaction.
 *
 * Named after `FfmpegPlaybackFingerprinter.detectPlaybackObservations` so the
 * adapter satisfies the port without a wrapper. The detector decides no mode:
 * it says where each window matched, or that it did not.
 */
export interface PlaybackObservationSource {
  detectPlaybackObservations(input: {
    referencePath: string
    reactionPath: string
    reactionTimebase: Readonly<Timebase>
    referenceTimebase: Readonly<Timebase>
  }): Promise<readonly Readonly<PlaybackObservation>[]>
}

/**
 * A compiled plan that no longer describes the head of the map it came from.
 *
 * Reported rather than deleted: the plan that was rendered stays readable, and
 * what changed is that it stopped describing the current cut. `compiledFromHash`
 * is the map hash it was compiled at, so a reader can see *which* version it
 * still describes instead of only that it is stale.
 */
export interface StrandedRenderablePlan {
  readonly planId: string
  readonly planHash: string
  readonly compiledFromHash: string
}

export interface BuildReactPlaybackMapResult {
  readonly map: Readonly<PlaybackMap>
  readonly replayed: boolean
  /** Uncovered stretches remain: a person has to answer them. */
  readonly manualReviewRequired: boolean
  /** The map this one replaces because the reference recording changed. */
  readonly supersededMapId: string | null
  /** Manual anchors carried onto the new version as record. */
  readonly carriedAnchors: number
  /**
   * Manual anchors that could not be carried because the recording they point
   * into is no longer the same bytes. Their reference instants mean something
   * else now.
   */
  readonly droppedAnchors: number
  /**
   * The compiled plan this rebuild stranded, if one had been compiled.
   *
   * This is where "a rebuild invalidates its dependents" is actually observable.
   * A rebuild is the only operation that can strand a plan: the map has to be
   * resolved before it compiles, and an anchor only ever resolves an uncovered
   * stretch, so nothing else moves a head out from under a stored plan.
   */
  readonly invalidated: Readonly<StrandedRenderablePlan> | null
}

/**
 * One recording the plan will declare, after the server measured it.
 *
 * The narrowed counterpart of `ResolvedRenderSource`: the port allows a null
 * duration because an artifact may carry no probe, and this compiler refuses
 * that case by name, so everything past the refusal holds a real number.
 */
export interface MeasuredRenderSource {
  readonly artifactId: string
  readonly sha256: string
  readonly durationSeconds: number
}

export interface ReactPlaybackPlanResult {
  readonly plan: Readonly<DirectedEditPlan>
  readonly planHash: string
  readonly replayed: boolean
  /** The map version the plan was compiled from. */
  readonly mapVersion: number
  /**
   * The stored row, as the repository read it back.
   *
   * Carried out of the service rather than reassembled by a caller so that the
   * published surface presents what PostgreSQL holds — origin, source hash,
   * source version, `createdAt` — instead of a projection a route composed and
   * that could drift from the row a later reader opens.
   */
  readonly snapshot: Readonly<StoredRenderablePlanSnapshot>
}

function versionRef(sessionId: string, reactionTrackId: string, version: number): string {
  return `${sessionId}:playback:${reactionTrackId}:v${version}`
}

/**
 * A map id built from the ids above it, guaranteed to fit the domain's own
 * identifier bound.
 *
 * `createPlaybackMap` refuses an id longer than 128 characters, and a session
 * id may be 128 on its own. `<session>:<track>:playback-<n>` is then refused as
 * "not a canonical identifier" — a build that works for every id anyone tested
 * with and fails for a long one in production, with a message about syntax
 * rather than about length. Truncating alone would be worse: two long sessions
 * sharing a prefix would silently become one map, so an over-long id keeps its
 * readable head and ends in a digest of the whole thing.
 *
 * Same shape as `childRowId` (infrastructure/prisma), deliberately not imported
 * from it: that one exists to fit a column and may change with the column.
 */
function playbackMapId(sessionId: string, reactionTrackId: string, ordinal: number): string {
  const id = `${sessionId}:${reactionTrackId}:playback-${ordinal}`
  if (id.length <= 128) return id
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 16)
  return `${id.slice(0, 128 - digest.length - 1)}-${digest}`
}

/**
 * The session version a derivation is allowed to be computed against.
 *
 * The pair, not the number: a version number alone can be reused after a failed
 * write, so a caller naming only "version 3" could mean a different version 3.
 * The refusal carries the current pair so a UI can offer a reload.
 */
function assertSessionUnmoved(
  session: Readonly<CaptureSession>,
  base: Readonly<{ baseVersionId: string; baseHash: string }>,
): void {
  const expectedId = `${session.sessionId}:v${session.version}`
  if (base.baseVersionId !== expectedId || base.baseHash !== session.sessionHash) {
    throw new DomainError(
      'CAPTURE_SESSION_VERSION_STALE',
      `Capture session ${session.sessionId} has moved to version ${session.version}; re-read it and retry`,
      {
        currentVersionId: expectedId,
        currentVersion: session.version,
        currentHash: session.sessionHash,
      },
    )
  }
}

/**
 * The two tracks a react session is made of.
 *
 * Refused rather than guessed at every step: a session with two reaction tracks
 * is two edits, and picking the first would silently produce a map for one of
 * them. `reactionTrackId` disambiguates when a session legitimately has more
 * than one reactor.
 */
function resolveReactTracks(
  session: Readonly<CaptureSession>,
  reactionTrackId?: string,
): Readonly<{ reaction: Readonly<CaptureTrack>; reference: Readonly<CaptureTrack> }> {
  const reference = session.tracks.find((track) => track.trackId === session.referenceTrackId)
  if (!reference || reference.role !== 'reference-video') {
    throw new DomainError(
      'PLAYBACK_SESSION_NOT_REACT',
      `Capture session ${session.sessionId} has no reference-video track; a playback map maps a reaction onto one`,
      { referenceTrackId: session.referenceTrackId, role: reference?.role ?? null },
    )
  }
  const reactions = session.tracks.filter((track) => track.role === 'reaction')
  if (reactions.length === 0) {
    throw new DomainError(
      'PLAYBACK_SESSION_NOT_REACT',
      `Capture session ${session.sessionId} has no reaction track`,
    )
  }
  if (reactionTrackId === undefined) {
    if (reactions.length > 1) {
      throw new DomainError(
        'PLAYBACK_REACTION_TRACK_AMBIGUOUS',
        `Capture session ${session.sessionId} has ${reactions.length} reaction tracks; name the one to map`,
        { reactionTrackIds: reactions.map((track) => track.trackId) },
      )
    }
    return Object.freeze({ reaction: reactions[0]!, reference })
  }
  const reaction = reactions.find((track) => track.trackId === reactionTrackId)
  if (!reaction) {
    throw new DomainError(
      'CAPTURE_TRACK_NOT_FOUND',
      `Capture session ${session.sessionId} has no reaction track ${reactionTrackId}`,
    )
  }
  return Object.freeze({ reaction, reference })
}

/**
 * The one file a track's ticks are counted in.
 *
 * A track split across two files is a real recording and an unsolved one here:
 * `PlaybackReferenceMedia` names a single asset, and the fingerprinter counts
 * reference ticks from the first sample of the file it was given. Choosing the
 * first part would silently map the reaction onto a fragment. Coverage that
 * does not begin at zero is refused for the same reason — its ticks are counted
 * from somewhere the detector does not count from.
 */
function soleMeasuredPart(track: Readonly<CaptureTrack>): Readonly<CaptureTrackPart> {
  if (track.parts.length !== 1) {
    throw new DomainError(
      'PLAYBACK_TRACK_NOT_SINGLE_PART',
      `Track ${track.trackId} was recorded in ${track.parts.length} files; a playback map is measured against one`,
      { trackId: track.trackId, partCount: track.parts.length },
    )
  }
  const part = track.parts[0]!
  if (part.coverage.start !== BigInt(0)) {
    throw new DomainError(
      'PLAYBACK_TRACK_NOT_SINGLE_PART',
      `Track ${track.trackId} covers from tick ${part.coverage.start}; playback ticks are counted from the first sample of the file`,
      { trackId: track.trackId, coverage: serializeTickInterval(part.coverage) },
    )
  }
  return part
}

/**
 * What a map asserts, without where it sits in its own chain.
 *
 * Re-running detection over an unchanged session must not grow the chain by a
 * version that says exactly what the one before it said. Version and
 * `previousVersionHash` are excluded precisely because they are the only things
 * that would differ.
 */
function derivationFingerprint(map: Readonly<PlaybackMap>): string {
  return calculateCanonicalHash({
    sessionVersion: map.sessionVersion,
    referenceEpoch: map.referenceEpoch,
    reactionTrackId: map.reactionTrackId,
    referenceTrackId: map.referenceTrackId,
    referenceSha256: map.referenceMedia.sha256,
    referenceDurationTicks: map.referenceMedia.durationTicks.toString(),
    reactionSha256: map.reactionMedia.sha256,
    reactionDurationTicks: map.reactionMedia.durationTicks.toString(),
    pieces: map.pieces.map((piece) => piece.pieceHash),
    uncovered: map.uncovered.map((entry) => ({
      range: serializeTickInterval(entry.range),
      reason: entry.reason,
    })),
    anchors: map.anchors.map((anchor) => anchor.anchorId).sort(),
    status: map.status,
    warnings: [...map.warnings],
  })
}

export function buildReactPlaybackMapService(dependencies: {
  repository: PlaybackMapRepository
  sessions: CaptureSessionRepository
  media: PlaybackMediaPort
  observations: PlaybackObservationSource
  /** Read-only here: a rebuild reports the plan it stranded, it deletes none. */
  snapshots: RenderablePlanSnapshotRepository
  clock: () => Date
}) {
  return async (input: {
    actor: SyncActor
    sessionId: string
    baseVersionId: string
    baseHash: string
    reactionTrackId?: string
  }): Promise<Readonly<BuildReactPlaybackMapResult>> => {
    const session = await dependencies.sessions.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!session) {
      throw new DomainError(
        'CAPTURE_SESSION_NOT_FOUND',
        `Capture session ${input.sessionId} does not exist`,
      )
    }
    assertSessionUnmoved(session, input)

    const { reaction, reference } = resolveReactTracks(session, input.reactionTrackId)
    const reactionPart = soleMeasuredPart(reaction)
    const referencePart = soleMeasuredPart(reference)

    const referenceMedia: Readonly<PlaybackReferenceMedia> = Object.freeze({
      assetId: referencePart.sourceAssetId,
      sha256: referencePart.evidence.ingestSha256,
      // Measured at ingest, in the part's own timebase. Never derived from the
      // reaction: a sixty-minute reaction to a thirty-minute video is normal.
      durationTicks: intervalDuration(referencePart.coverage),
      timebase: referencePart.timebase,
    })
    const reactionMedia: Readonly<PlaybackReactionMedia> = Object.freeze({
      assetId: reactionPart.sourceAssetId,
      sha256: reactionPart.evidence.ingestSha256,
      durationTicks: intervalDuration(reactionPart.coverage),
    })

    const previous = await dependencies.repository.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      reactionTrackId: reaction.trackId,
    })
    // Different reference bytes mean every reference tick means something else.
    // The old map is not amended, it is superseded — and the manual anchors on
    // it point into a recording that no longer exists.
    const referenceChanged = previous !== null &&
      (previous.referenceMedia.sha256 !== referenceMedia.sha256 ||
        previous.reactionMedia.sha256 !== reactionMedia.sha256)
    const manualAnchors = (previous?.anchors ?? []).filter((anchor) => anchor.origin === 'manual')
    const carried: readonly Readonly<PlaybackAnchor>[] = referenceChanged ? [] : manualAnchors

    const opened: { release: () => Promise<void> }[] = []
    let observations: readonly Readonly<PlaybackObservation>[]
    try {
      const referenceFile = await dependencies.media.resolve({
        workspaceId: input.actor.workspaceId,
        part: referencePart,
      })
      opened.push(referenceFile)
      const reactionFile = await dependencies.media.resolve({
        workspaceId: input.actor.workspaceId,
        part: reactionPart,
      })
      opened.push(reactionFile)
      observations = await dependencies.observations.detectPlaybackObservations({
        referencePath: referenceFile.path,
        reactionPath: reactionFile.path,
        reactionTimebase: session.clock.timebase,
        referenceTimebase: referencePart.timebase,
      })
    } finally {
      for (const handle of opened) {
        await handle.release().catch((error: unknown) => {
          // Reported, never rethrown: a cleanup failure must not replace the
          // measurement — or the refusal — the caller asked for.
          process.emitWarning(
            `playback media for session ${input.sessionId} could not be released: ${String(error)}`,
          )
        })
      }
    }

    if (observations.length === 0) {
      throw new DomainError(
        'PLAYBACK_EVIDENCE_INSUFFICIENT',
        `No window of ${reaction.trackId} could be compared with the reference; a person must place the first anchor`,
        { sessionId: input.sessionId, reactionTrackId: reaction.trackId, observations: 0 },
      )
    }

    const candidate = buildPlaybackMap({
      // The map keeps its identity across versions; a changed reference starts a
      // new one, because the ticks it maps onto are a different recording.
      mapId: referenceChanged || previous === null
        ? playbackMapId(input.sessionId, reaction.trackId, (previous?.version ?? 0) + 1)
        : previous.mapId,
      session,
      reactionTrack: reaction,
      referenceTrack: reference,
      referenceMedia,
      reactionMedia,
      observations,
      anchors: carried,
      policy: defaultPlaybackPolicy(session.clock.timebase),
      ...(referenceChanged && previous ? { supersedesMapId: previous.mapId } : {}),
    })

    if (candidate.status === 'failed') {
      // No piece names a reference range, so there is nothing to anchor: a
      // failed map carries no uncovered stretch, and `applyPlaybackAnchor`
      // resolves uncovered stretches. Persisting it would create a head that
      // nothing could ever advance.
      throw new DomainError(
        'PLAYBACK_EVIDENCE_INSUFFICIENT',
        `The reference was never detected inside ${reaction.trackId}; the player may have been muted or hidden, and a person must anchor it`,
        {
          sessionId: input.sessionId,
          reactionTrackId: reaction.trackId,
          observations: observations.length,
          locked: observations.filter((entry) => entry.referenceTick !== null).length,
          warnings: [...candidate.warnings],
        },
      )
    }

    // Read before the write, and against the map this build advances or
    // supersedes: a changed reference starts a new map id, so asking about the
    // new head would ask about a derivation nothing has ever compiled.
    const compiled = previous === null
      ? null
      : await dependencies.snapshots.readLatestForSource({
        workspaceId: input.actor.workspaceId,
        origin: 'react-playback',
        sourceId: previous.mapId,
      })

    const result = (map: Readonly<PlaybackMap>, replayed: boolean): Readonly<BuildReactPlaybackMapResult> =>
      Object.freeze({
        map,
        replayed,
        manualReviewRequired: map.uncovered.length > 0,
        supersededMapId: map.supersedesMapId,
        carriedAnchors: carried.length,
        droppedAnchors: referenceChanged ? manualAnchors.length : 0,
        invalidated: compiled && compiled.sourceHash !== map.mapHash
          ? Object.freeze({
            planId: compiled.planId,
            planHash: compiled.planHash,
            compiledFromHash: compiled.sourceHash,
          })
          : null,
      })

    if (previous && derivationFingerprint(previous) === derivationFingerprint(candidate)) {
      // Same session version, same bytes, same pieces: re-running the detector
      // changed nothing, so the chain does not grow a version that repeats the
      // one before it — and a plan compiled from that head is still current.
      return result(previous, true)
    }

    const occurredAt = dependencies.clock().toISOString()
    const versioned = previous === null
      ? candidate
      : atChainPosition(candidate, previous.version + 1, previous.mapHash)
    const stored = await dependencies.repository.appendVersion({
      map: versioned,
      ...(previous ? { expectedVersion: previous.version, expectedHash: previous.mapHash } : {}),
      occurredAt,
    })
    return result(stored.map, stored.replayed)
  }
}

/**
 * The same map, one step further along its chain.
 *
 * `buildPlaybackMap` always produces version 1: it reads observations and has
 * no opinion about history. A rebuild over an existing head has to name the
 * version it replaces and that version's hash, and the honest way there is to
 * hand the pieces back to `createPlaybackMap`, which re-proves every invariant
 * and recomputes every hash from the body it is given. Editing `version` onto
 * the frozen object would leave a map whose hash covers the old number — a
 * document that could be written and never read again.
 */
function atChainPosition(
  map: Readonly<PlaybackMap>,
  version: number,
  previousVersionHash: string,
): Readonly<PlaybackMap> {
  return createPlaybackMap({
    mapId: map.mapId,
    workspaceId: map.workspaceId,
    sessionId: map.sessionId,
    sessionVersion: map.sessionVersion,
    referenceEpoch: map.referenceEpoch,
    reactionTrackId: map.reactionTrackId,
    referenceTrackId: map.referenceTrackId,
    referenceMedia: map.referenceMedia,
    reactionMedia: map.reactionMedia,
    version,
    previousVersionHash,
    supersedesMapId: map.supersedesMapId,
    pieces: map.pieces.map((piece) => ({
      pieceId: piece.pieceId,
      mode: piece.mode,
      reactionRange: piece.reactionRange,
      referenceRange: piece.referenceRange,
      rate: piece.rate,
      direction: piece.direction,
      confidence: piece.confidence,
      evidenceRefs: piece.evidenceRefs,
      detectionMethod: piece.detectionMethod,
      residualTicks: piece.residualTicks,
      discontinuityReason: piece.discontinuityReason,
    })),
    uncovered: map.uncovered,
    anchors: map.anchors,
  })
}

export function editReactPlaybackAnchorService(dependencies: {
  repository: PlaybackMapRepository
  snapshots: RenderablePlanSnapshotRepository
  clock: () => Date
}) {
  return async (input: {
    actor: SyncActor
    sessionId: string
    reactionTrackId: string
    baseVersionId: string
    baseHash: string
    anchor: Readonly<{
      anchorId: string
      reactionTick: bigint
      referenceTick: bigint | null
      mode?: PlaybackMode
      note?: string
    }>
  }): Promise<Readonly<{
    map: Readonly<PlaybackMap>
    replayed: boolean
    manualReviewRequired: boolean
    /** The compiled plan this edit left describing an older head, if any. */
    invalidated: Readonly<StrandedRenderablePlan> | null
  }>> => {
    const current = await dependencies.repository.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      reactionTrackId: input.reactionTrackId,
    })
    if (!current) {
      throw new DomainError(
        'PLAYBACK_MAP_NOT_FOUND',
        `Capture session ${input.sessionId} has no playback map for ${input.reactionTrackId}`,
      )
    }
    const expectedId = versionRef(input.sessionId, input.reactionTrackId, current.version)
    if (input.baseVersionId !== expectedId || input.baseHash !== current.mapHash) {
      throw new DomainError(
        'PLAYBACK_MAP_VERSION_STALE',
        `The playback map for ${input.sessionId}/${input.reactionTrackId} has moved to version ${current.version}; re-read it and retry`,
        {
          currentVersionId: expectedId,
          currentVersion: current.version,
          currentHash: current.mapHash,
        },
      )
    }
    // The evidence is the actor plus whatever the operator wrote, never the note
    // alone: `applyPlaybackAnchor` builds `operator:<actorId> (<note>)` so the
    // trail records who overrode a measurement even when they said nothing.
    const next = applyPlaybackAnchor(current, {
      expectedVersion: current.version,
      expectedHash: current.mapHash,
      anchor: {
        anchorId: input.anchor.anchorId,
        reactionTick: input.anchor.reactionTick,
        referenceTick: input.anchor.referenceTick,
        ...(input.anchor.mode ? { mode: input.anchor.mode } : {}),
        actorId: input.actor.id,
        ...(input.anchor.note ? { note: input.anchor.note } : {}),
        createdAt: dependencies.clock().toISOString(),
      },
    })
    const stale = await dependencies.snapshots.readLatestForSource({
      workspaceId: input.actor.workspaceId,
      origin: 'react-playback',
      sourceId: current.mapId,
    })
    const stored = await dependencies.repository.appendVersion({
      map: next,
      expectedVersion: current.version,
      expectedHash: current.mapHash,
      occurredAt: dependencies.clock().toISOString(),
    })
    return Object.freeze({
      map: stored.map,
      replayed: stored.replayed,
      manualReviewRequired: stored.map.uncovered.length > 0,
      // Compared against the head this anchor just produced, never against the
      // one it was computed from. The earlier form asked whether a plan had been
      // compiled from *this exact version* — which no sequence of operations can
      // produce, because compiling refuses a map with an uncovered stretch and
      // anchoring refuses an instant that is not inside one. It was therefore
      // always null, and the invalidation this service is supposed to report was
      // declared and not implemented. The reachable case is a plan compiled from
      // an earlier version of the same map, which a rebuild left answerable
      // again: that plan still describes a cut, and it is no longer this one.
      invalidated: stale && stale.sourceHash !== stored.map.mapHash
        ? Object.freeze({
          planId: stale.planId,
          planHash: stale.planHash,
          compiledFromHash: stale.sourceHash,
        })
        : null,
    })
  }
}

export function readReactPlaybackMapService(dependencies: { repository: PlaybackMapRepository }) {
  return async (input: {
    workspaceId: string
    sessionId: string
    reactionTrackId: string
    version?: number
  }): Promise<Readonly<{
    map: Readonly<PlaybackMap>
    versionRef: string
    manualReviewRequired: boolean
  }>> => {
    const map = input.version === undefined
      ? await dependencies.repository.readHead(input)
      : await dependencies.repository.readVersion({ ...input, version: input.version })
    if (!map) {
      throw new DomainError(
        'PLAYBACK_MAP_NOT_FOUND',
        `Capture session ${input.sessionId} has no playback map for ${input.reactionTrackId}`,
      )
    }
    return Object.freeze({
      map,
      versionRef: versionRef(input.sessionId, input.reactionTrackId, map.version),
      manualReviewRequired: map.uncovered.length > 0,
    })
  }
}

export function listReactPlaybackMapVersionsService(dependencies: { repository: PlaybackMapRepository }) {
  return async (input: {
    workspaceId: string
    sessionId: string
    reactionTrackId: string
    limit?: number
  }) => dependencies.repository.listVersions(input)
}

/**
 * Which maps a reference recording is holding up.
 *
 * The question asked before replacing a reference video: every map built on
 * those exact bytes is about to stop meaning what it says.
 */
export function listReferenceDependentsService(dependencies: { repository: PlaybackMapRepository }) {
  return async (input: {
    workspaceId: string
    referenceAssetId: string
    referenceSha256: string
  }) => dependencies.repository.findDependentsOfReference(input)
}

const SECONDS_PER_TICK = (timebase: Readonly<Timebase>): number =>
  Number(timebase.secondsPerTick.num) / Number(timebase.secondsPerTick.den)

/**
 * Why one shot gives way to the next, in the map's own words.
 *
 * Derived from the piece, never written by a caller: the reason a react edit
 * cuts is the thing the player did, and the map already measured it.
 */
function shotSeamReason(piece: Readonly<PlaybackPiece>): string {
  const cause = piece.discontinuityReason ?? 'coverage-gap'
  switch (piece.mode) {
    case 'paused':
      return `The reactor paused the reference (${cause}); the shot holds on the reaction, because this path has no freeze frame.`
    case 'commentary-only':
      return `The reactor talked with the reference stopped (${cause}); the shot is the reaction alone.`
    case 'rewind':
      return `The reactor went back in the reference (${cause}) and played on from there.`
    case 'replay':
      return `The reactor replayed reference material already shown (${cause}).`
    case 'seek':
      return `The reactor jumped forward in the reference (${cause}).`
    default:
      return `The reference resumed after ${cause}.`
  }
}

function shotMarker(
  piece: Readonly<PlaybackPiece>,
  shot: Readonly<PlaybackShot>,
  referenceTimebase: Readonly<Timebase>,
  reactionTimebase: Readonly<Timebase>,
): RenderablePlanMarker {
  const perTick = piece.referenceRange === null
    ? SECONDS_PER_TICK(reactionTimebase)
    : SECONDS_PER_TICK(referenceTimebase)
  const range = piece.referenceRange ?? piece.reactionRange
  return {
    kind: 'editorial-cut' as const,
    atFrame: shot.timelineInFrame,
    sourceStartSeconds: Number(range.start) * perTick,
    sourceEndSeconds: Number(range.end) * perTick,
    ruleIds: Object.freeze([
      `playback:${piece.mode}`,
      ...(piece.discontinuityReason ? [`playback:${piece.discontinuityReason}`] : []),
      ...(piece.rate === null ? ['playback:rate-unmeasured'] : [`playback:rate=${serializeRational(piece.rate)}`]),
    ]),
  }
}

/**
 * The decision log of a react cut: why the viewer sees what they see, piece by
 * piece.
 *
 * F4.012 already publishes one of these for a multicam cut
 * (`multicam-direction.ts` `buildAngleDecisions`), and it is the only record a
 * reviewer can open to ask "why this, here?" without re-running the compiler.
 * A react cut answers the same question -- every piece decides between the
 * reference recording and the reactor's own -- and until this existed it
 * answered it nowhere: the compiled plan carried an empty `director.decisions`
 * while the direction carried a full one.
 *
 * Nothing here is new evidence. Every field is read off the piece the map
 * already resolved: its mode, its measured rate, the boundary cause it
 * recorded, the detection method that produced it and its own confidence. The
 * compiler decides only which of the two recordings the piece implies, which is
 * `referenceRange !== null` and nothing else.
 *
 * Two shapes of the boundary constrain the output and are honoured here rather
 * than discovered at runtime:
 *
 * - `validateDirectorDecisions` (`director-run.ts:296`) bounds the log at 4-64
 *   entries. Three summary decisions plus one per piece clears the floor for
 *   the smallest possible map, and a busier one is cited least-confident first
 *   -- the pieces a reviewer opens -- with the summary saying how many were
 *   left out and that the map itself still holds every one.
 * - `createDecisionConfidence` (`decision-confidence.ts:33`) demands evidence
 *   refs matching a narrower grammar than the aggregate does. A piece's own
 *   `evidenceRefs` cannot be passed through: an anchor's ref is built from a
 *   human note (`playback-map.ts:1481`) and the aggregate only requires it to
 *   be non-empty, so a note with a space in it would make an otherwise valid
 *   map uncompilable. The refs below are built from identities the aggregate
 *   does validate, and the piece's own evidence is cited by count and through
 *   the piece hash that covers it.
 *
 * The ids are keyed by the map hash and the piece ORDINAL rather than by the
 * map and piece ids, because `validId` caps a decision id at 128 characters
 * while `playback-map.ts:316` lets a map id run to 128 on its own -- and a
 * session id at the domain limit is a case the suite already holds
 * (`playback-map-service.test.mjs` "a session id at the domain limit still
 * yields a map id the domain accepts"). The ids stay unique because ordinals
 * are contiguous and unique within a map, and the piece id itself is named in
 * the reason, where nothing truncates it.
 */
export function buildPlaybackDecisions(map: Readonly<PlaybackMap>): Readonly<{
  decisions: readonly Readonly<DirectorDecisionInput>[]
  assumptions: readonly string[]
  omittedPieces: number
}> {
  // `validId` (`director-run.ts:268`) refuses both the `/` a map id may contain
  // (`playback-map.ts:316`) and any id past 128 characters. The map hash is
  // hexadecimal, fixed width and already the map's identity, so it is the token
  // -- a decision that cannot be validated cannot be logged.
  const token = map.mapHash.slice(0, 12)
  const mapRef = `playback-map:${map.mapId}:v${map.version}`
  const sessionRef = `capture-session:${map.sessionId}:v${map.sessionVersion}`
  const byConfidence = [...map.pieces]
    .sort((left, right) => (left.confidence - right.confidence) || (left.ordinal - right.ordinal))
  const cited = byConfidence.slice(0, 64 - 3).sort((left, right) => left.ordinal - right.ordinal)
  const omittedPieces = byConfidence.length - cited.length
  const weakest = byConfidence[0]
  const modes = [...new Set(map.pieces.map((piece) => piece.mode))]
  const methods = [...new Set(map.pieces.map((piece) => piece.detectionMethod))]

  const summary: DirectorDecisionInput = {
    id: `decision-playback-summary-${token}`,
    category: 'angle',
    choice: `${map.pieces.length} piece(s) in modes ${modes.join(', ')}`,
    reason: [
      `Mapped reaction ${map.sessionId} version ${map.sessionVersion} at reference epoch ${map.referenceEpoch}`,
      `against reference ${map.referenceMedia.assetId} by ${methods.join(' and ')}`,
      `${map.anchors.length} anchor(s) placed`,
      omittedPieces > 0
        ? `${omittedPieces} piece decision(s) are omitted here and stored in full in the map`
        : 'every piece decision is cited here',
    ].join('; '),
    evidenceRefs: Object.freeze([mapRef, sessionRef, `playback-evidence:${map.mapHash.slice(0, 32)}`]),
    // The weakest piece is the cut's confidence: a react edit is only as
    // trustworthy as its least certain piece, and averaging would let fifty
    // locked seconds hide one guess. The direction's summary reduces the same
    // way, for the same reason.
    confidence: weakest ? weakest.confidence : 0,
    alternatives: Object.freeze([]),
  }
  const seam: DirectorDecisionInput = {
    id: `decision-playback-seams-${token}`,
    category: 'transition',
    choice: 'straight-cut',
    reason: 'Every seam is a thing the player did, over one continuous reaction audio bed: a straight cut with a bounded edge fade is invisible, and any other transition would assert an editorial beat the map did not measure.',
    evidenceRefs: Object.freeze([mapRef]),
    confidence: 0.9,
    alternatives: Object.freeze([
      'cross-dissolve: refused -- the Director plan admits only straight cuts (director-run.ts:134)',
    ]),
  }
  const audio: DirectorDecisionInput = {
    id: `decision-playback-audio-${token}`,
    category: 'insert',
    choice: map.reactionMedia.assetId,
    reason: `Every shot takes its sound from the reaction ${map.reactionMedia.assetId}; the reference's own audio is never mixed in, because the map measured where the reference played and never at what level it was heard.`,
    evidenceRefs: Object.freeze([mapRef, `playback-reaction-track:${map.reactionTrackId}`]),
    confidence: 0.9,
    alternatives: Object.freeze([
      `${map.referenceMedia.assetId}: refused -- mixing the reference under the reaction is a level decision nothing in this aggregate measured`,
    ]),
  }
  const pieces = cited.map((piece): DirectorDecisionInput => {
    const fromReference = piece.referenceRange !== null
    const referenceSpan = piece.referenceRange === null
      ? null
      : serializeTickInterval(piece.referenceRange)
    return {
      id: `decision-playback-${token}-p${String(piece.ordinal).padStart(3, '0')}`,
      category: 'angle',
      choice: fromReference ? map.referenceMedia.assetId : map.reactionMedia.assetId,
      reason: [
        `Piece ${piece.pieceId} (ordinal ${piece.ordinal}) is ${piece.mode} running ${piece.direction}`,
        referenceSpan === null
          ? 'so the shot is the reactor, because the reference produced no time here'
          : `so the shot is the reference over ticks ${referenceSpan.start}-${referenceSpan.end}`,
        piece.rate === null ? 'rate not measured' : `rate ${serializeRational(piece.rate)}`,
        piece.discontinuityReason === null
          ? 'it opens the map'
          : `it begins on ${piece.discontinuityReason}`,
        `detected by ${piece.detectionMethod} over ${piece.evidenceRefs.length} observation ref(s)`,
        piece.residualTicks === null
          ? 'no residual to report'
          : `worst residual ${piece.residualTicks} reference tick(s)`,
      ].join('; '),
      // Keyed by map hash rather than map id for the same width reason as the
      // decision id: `REF` stops at 256 characters and a map id and a piece id
      // can each be 128 on their own.
      evidenceRefs: Object.freeze([
        mapRef,
        `playback-piece:${token}:${piece.pieceId}`,
        `playback-piece-evidence:${piece.pieceHash}`,
      ]),
      confidence: piece.confidence,
      alternatives: Object.freeze([
        fromReference
          ? `${map.reactionMedia.assetId}: refused -- the reference played here, and showing the reactor instead would drop the material the reaction is about`
          : `${map.referenceMedia.assetId}: refused -- the reference produced no time over this stretch, so there is nothing of it to show`,
      ]),
    }
  })

  return Object.freeze({
    decisions: Object.freeze([summary, seam, audio, ...pieces]),
    assumptions: Object.freeze(
      omittedPieces > 0
        ? [`${omittedPieces} piece decision(s) exceed the 64-decision cap and are stored in full in playback map ${map.mapId} rather than in this log.`]
        : [],
    ),
    omittedPieces,
  })
}

/**
 * Compile a resolved playback map into a plan the renderer accepts.
 *
 * The output timeline is the *reaction's*, piece by piece. That is the whole
 * point of ADR-135: a sixty-minute reaction to a thirty-minute video runs
 * sixty minutes, and the assertion below states it rather than leaving it to be
 * noticed. A compiler that took its duration from the reference would produce a
 * plan that renders and is wrong.
 *
 * Declared limitation, inherited from `compilePlaybackToShots`: materialization
 * is cut-only. A paused stretch shows the reactor, not a held frame of the
 * reference, because the editorial path has no freeze and no
 * picture-in-picture (`clip-timing.ts:25-42` refuses a rate of zero).
 */
/**
 * Turn a resolved playback map into a plan the renderer accepts, given
 * recordings the server has already measured.
 *
 * Pure on purpose, and exported for two callers: the service below, which
 * resolves the recordings through the repositories, and the published example
 * in `schema-examples.ts`, which holds the same map and the same measurements
 * and must not re-implement this to show what a compile answers. An example
 * built by a copy of the compiler documents the copy.
 */
export function compilePlaybackMapToDirectedPlan(
  map: Readonly<PlaybackMap>,
  options: Readonly<{
    session: Readonly<CaptureSession>
    /** Measured recordings by capture asset id, reaction first. */
    measured: ReadonlyMap<string, Readonly<MeasuredRenderSource>>
    /** Capture asset id to the media artifact the renderer will open. */
    artifactByAssetId: ReadonlyMap<string, string>
    projectVersionId: string
    objective: StrategicObjectiveId
    desiredAction?: Readonly<DesiredActionInput>
    planFps: Rational
    createdAt: string
  }>,
): Readonly<DirectedEditPlan> {
  const { shots } = compilePlaybackToShots(map, {
    planFps: options.planFps,
    referenceTimebase: map.referenceMedia.timebase,
    reactionTimebase: options.session.clock.timebase,
  })
  const byPieceId = new Map(map.pieces.map((piece) => [piece.pieceId, piece]))

  const artifactFor = (assetId: string): string => {
    const artifactId = options.artifactByAssetId.get(assetId)
    assertDomain(
      artifactId !== undefined,
      'INVALID_RENDER_INPUT',
      `the compiled shots cut from ${assetId}, which is neither the reaction nor the reference of ${map.sessionId}`,
      { assetId },
    )
    return artifactId as string
  }

  const clips: EditorialCutClip[] = shots.map((shot) => ({
    id: `clip-${shot.pieceId}`,
    sourceArtifactId: artifactFor(shot.sourceAssetId),
    audioSourceArtifactId: artifactFor(shot.audioSourceAssetId),
    audioSourceInFrame: shot.audioSourceInFrame,
    audioSourceOutFrame: shot.audioSourceOutFrame,
    sourceInFrame: shot.sourceInFrame,
    sourceOutFrame: shot.sourceOutFrame,
    timelineInFrame: shot.timelineInFrame,
    timelineOutFrame: shot.timelineOutFrame,
    rate: shot.rate,
  }))
  const seams: RenderablePlanSeam[] = shots.slice(1).map((shot) => ({
    reason: shotSeamReason(byPieceId.get(shot.pieceId)!),
  }))
  const markers: RenderablePlanMarker[] = shots.slice(1).map((shot) =>
    shotMarker(
      byPieceId.get(shot.pieceId)!,
      shot,
      map.referenceMedia.timebase,
      options.session.clock.timebase,
    ))

  const fps = Number(options.planFps.num) / Number(options.planFps.den)
  // Two different measurements of two different things, and they are not
  // interchangeable. The reaction's tick count is the *timeline*: the map
  // tiles the reaction second by second, so this is how long the output runs.
  // The seconds a source declares are what the server measured on the file,
  // which is why the reference's number comes from the artifact and never from
  // the reaction — "the two recordings are the same length" is precisely the
  // assumption ADR-135 exists to refuse.
  const reactionSeconds = Number(map.reactionMedia.durationTicks) *
    SECONDS_PER_TICK(options.session.clock.timebase)
  const referenceSeconds = options.measured.get(map.referenceMedia.assetId)!.durationSeconds

  // A clip that reads past the end of its file renders black or fails in
  // FFmpeg, and the plan would have declared the file long enough to allow it.
  const measuredByArtifactId = new Map(
    [...options.measured.values()].map((source) => [source.artifactId, source] as const),
  )
  for (const clip of clips) {
    for (const [artifactId, outFrame] of [
      [clip.sourceArtifactId, clip.sourceOutFrame] as const,
      [
        clip.audioSourceArtifactId ?? clip.sourceArtifactId,
        clip.audioSourceOutFrame ?? clip.sourceOutFrame,
      ] as const,
    ]) {
      const source = measuredByArtifactId.get(artifactId)
      assertDomain(
        source !== undefined,
        'INVALID_RENDER_INPUT',
        `clip ${clip.id} reads from ${artifactId}, which this compile never resolved`,
        { clipId: clip.id, artifactId },
      )
      const available = Math.round(source.durationSeconds * fps)
      assertDomain(
        outFrame <= available + 1,
        'INVALID_RENDER_INPUT',
        `clip ${clip.id} reads to frame ${outFrame} of ${artifactId}, which measures ${available} frames`,
        { clipId: clip.id, artifactId, outFrame, available },
      )
    }
  }

  const justification = buildPlaybackDecisions(map)
  const plan = assembleDirectedEditPlan({
    planId: `${map.mapId}:v${map.version}:directed`,
    projectVersionId: options.projectVersionId,
    derivedFrom: {
      origin: 'react-playback',
      id: map.mapId,
      hash: map.mapHash,
      version: map.version,
    },
    objective: options.objective,
    ...(options.desiredAction ? { desiredAction: options.desiredAction } : {}),
    fps,
    // Insertion order is the reaction then the reference, which is the order
    // the caller measured them in; the plan declares both because a clip takes
    // its picture from one and its sound from the other.
    sources: [...options.measured.values()].map((source) => ({
      id: `source-${source.artifactId}`,
      artifactId: source.artifactId,
      kind: 'video' as const,
      durationSeconds: source.durationSeconds,
    })),
    clips,
    seams,
    markers,
    // What survives of the reference, in the reference's own seconds. The
    // reaction is not listed here: it is not a retained *source* range, it is
    // the timeline.
    retainedSourceRanges: map.pieces
      .filter((piece) => piece.referenceRange !== null)
      .map((piece) => ({
        sourceStartSeconds: Number(piece.referenceRange!.start) *
          SECONDS_PER_TICK(map.referenceMedia.timebase),
        sourceEndSeconds: Number(piece.referenceRange!.end) *
          SECONDS_PER_TICK(map.referenceMedia.timebase),
      })),
    lineageRefs: [
      `capture-session:${map.sessionId}:v${map.sessionVersion}`,
      `playback-map:${map.mapId}:v${map.version}`,
      ...map.anchors.map((anchor) => `playback-anchor:${anchor.anchorId}`),
    ],
    // The per-piece log, built from the pieces the map already resolved. It is
    // the compiler's own reasoning and never a critic's: `assembleDirectedEditPlan`
    // still fills the three Director reference fields with this derivation
    // rather than with a run id, so no reader can take this for an approval.
    decisions: justification.decisions,
    assumptions: [
      `The output runs the reaction's ${reactionSeconds.toFixed(3)} s, not the reference's ${referenceSeconds.toFixed(3)} s (ADR-135).`,
      'Materialization is cut-only: a paused stretch shows the reactor, because the editorial path has no freeze frame and no picture-in-picture.',
      'Every shot carries the reaction\'s audio; the reference\'s own sound is not mixed in by this compiler.',
      ...justification.assumptions,
    ],
    createdAt: options.createdAt,
  })

  // Stated, not implied. The timeline is the reaction tiled piece by piece, so
  // this holds by construction — and it is the one equality a compiler that
  // read the duration off the reference would break.
  const reactionFrames = Math.round(reactionSeconds * fps)
  assertDomain(
    Math.abs(plan.durationFrames - reactionFrames) <= 1,
    'INVALID_RENDER_INPUT',
    `the compiled plan runs ${plan.durationFrames} frames over a reaction of ${reactionFrames}`,
    { durationFrames: plan.durationFrames, reactionFrames },
  )
  return plan
}

export function compileReactPlaybackPlanService(dependencies: {
  repository: PlaybackMapRepository
  sessions: CaptureSessionRepository
  /**
   * Where the two recordings become things a renderer can open. The caller
   * names no artifact, no digest and no duration: all three are read here.
   */
  sources: RenderSourceRepository
  snapshots: RenderablePlanSnapshotRepository
  clock: () => Date
}) {
  return async (input: {
    actor: SyncActor
    sessionId: string
    reactionTrackId: string
    /** The map version the caller read, as `<sessionId>:playback:<trackId>:v<n>`. */
    baseVersionId: string
    baseHash: string
    projectVersionId: string
    objective: StrategicObjectiveId
    desiredAction?: Readonly<DesiredActionInput>
    planFps: Rational
  }): Promise<Readonly<ReactPlaybackPlanResult>> => {
    const map = await dependencies.repository.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      reactionTrackId: input.reactionTrackId,
    })
    if (!map) {
      throw new DomainError(
        'PLAYBACK_MAP_NOT_FOUND',
        `Capture session ${input.sessionId} has no playback map for ${input.reactionTrackId}`,
      )
    }
    // The map version the caller decided against, not merely whatever is head
    // now. Without this the compile was the only playback command with no
    // fence, and the session check below does not stand in for it: a rebuild
    // against a *newer* session produces a new map version whose
    // `sessionVersion` matches the session perfectly, so an operator who read
    // v2 and pressed compile would silently be handed a plan for a v3 cut they
    // never saw. Same shape as the anchor fence, so a UI following
    // `PLAYBACK_MAP_VERSION_STALE` reloads the map and retries.
    const expectedMapVersionId = versionRef(input.sessionId, input.reactionTrackId, map.version)
    if (input.baseVersionId !== expectedMapVersionId || input.baseHash !== map.mapHash) {
      throw new DomainError(
        'PLAYBACK_MAP_VERSION_STALE',
        `The playback map for ${input.sessionId}/${input.reactionTrackId} has moved to version ${map.version}; re-read it and retry`,
        {
          currentVersionId: expectedMapVersionId,
          currentVersion: map.version,
          currentHash: map.mapHash,
        },
      )
    }
    const session = await dependencies.sessions.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!session) {
      throw new DomainError(
        'CAPTURE_SESSION_NOT_FOUND',
        `Capture session ${input.sessionId} does not exist`,
      )
    }
    // The map names the session version it was derived under. Compiling it
    // against a later one would render a cut derived from tracks that have
    // since changed, and nothing downstream would say so.
    //
    // The code is the *session*'s, not the map's: it is the session that moved,
    // and a UI following `PLAYBACK_MAP_VERSION_STALE` would reload the map —
    // which is exactly where it already is. `CAPTURE_SESSION_VERSION_STALE`
    // carries the same details shape as the sibling fence in
    // `assertSessionUnmoved`, plus what the map was derived under.
    if (session.version !== map.sessionVersion || session.referenceEpoch !== map.referenceEpoch) {
      throw new DomainError(
        'CAPTURE_SESSION_VERSION_STALE',
        `The playback map for ${input.sessionId} was derived from session version ${map.sessionVersion} at reference epoch ${map.referenceEpoch}; the session is at version ${session.version} and epoch ${session.referenceEpoch}`,
        {
          currentVersionId: `${session.sessionId}:v${session.version}`,
          currentVersion: session.version,
          currentHash: session.sessionHash,
          currentReferenceEpoch: session.referenceEpoch,
          mapSessionVersion: map.sessionVersion,
          mapReferenceEpoch: map.referenceEpoch,
        },
      )
    }

    // The two recordings, resolved the way the renderer will resolve them.
    //
    // The map names its recordings by the *capture asset* the recorder wrote
    // (`CaptureTrackPart.sourceAssetId`), which is not what a plan's sources are
    // keyed by: `PrismaProjectProxyRenderRepository` looks every
    // `clip.sourceArtifactId` up in the project's media-asset links, whose ids
    // are `v2MediaArtifact` rows — the same ids `CaptureMediaResolver` uses to
    // fetch the bytes (`part.evidence.ingestArtifactId`). Writing the asset id
    // into the plan produced a document that persisted cleanly and could not be
    // rendered: the resolver would refuse every source it declared. So the
    // translation happens here, once, against the session the map was derived
    // from, and every id the plan declares is proved to resolve before the plan
    // is assembled.
    const { reaction, reference } = resolveReactTracks(session, input.reactionTrackId)
    const recordings = [
      Object.freeze({ role: 'reaction' as const, part: soleMeasuredPart(reaction), identity: map.reactionMedia }),
      Object.freeze({ role: 'reference' as const, part: soleMeasuredPart(reference), identity: map.referenceMedia }),
    ]
    for (const recording of recordings) {
      // The map was built from these parts; if the session now names other
      // bytes under the same version, one of the two is lying about what it
      // measured, and cutting from either would be a guess.
      if (
        recording.part.sourceAssetId !== recording.identity.assetId ||
        recording.part.evidence.ingestSha256 !== recording.identity.sha256
      ) {
        throw new DomainError(
          'MEDIA_ARTIFACT_IDENTITY_MISMATCH',
          `The ${recording.role} track of ${input.sessionId} no longer holds the recording the playback map measured`,
          {
            role: recording.role,
            mapAssetId: recording.identity.assetId,
            trackAssetId: recording.part.sourceAssetId,
          },
        )
      }
    }
    const artifactByAssetId = new Map(
      recordings.map((recording) =>
        [recording.identity.assetId, recording.part.evidence.ingestArtifactId] as const),
    )
    const resolvedSources = await dependencies.sources.resolveForProject({
      workspaceId: input.actor.workspaceId,
      projectId: session.projectId,
      artifactIds: [...artifactByAssetId.values()],
    })
    const byArtifactId = new Map(resolvedSources.map((source) => [source.artifactId, source] as const))
    const measured = new Map<string, Readonly<MeasuredRenderSource>>()
    for (const recording of recordings) {
      const artifactId = recording.part.evidence.ingestArtifactId
      const resolved = byArtifactId.get(artifactId)
      if (!resolved) {
        throw new DomainError(
          'MEDIA_ARTIFACT_NOT_FOUND',
          `The ${recording.role} recording of ${input.sessionId} is artifact ${artifactId}, which project ${session.projectId} cannot render from`,
          { role: recording.role, artifactId, projectId: session.projectId },
        )
      }
      if (resolved.sha256 !== recording.identity.sha256) {
        throw new DomainError(
          'MEDIA_ARTIFACT_IDENTITY_MISMATCH',
          `Artifact ${artifactId} no longer holds the bytes the playback map was measured against`,
          { role: recording.role, artifactId, mapSha256: recording.identity.sha256 },
        )
      }
      // Measured on the file by whoever ingested it, never derived from the
      // timeline that is about to use it.
      assertDomain(
        resolved.durationSeconds !== null,
        'INVALID_RENDER_INPUT',
        `artifact ${artifactId} carries no measured duration; a plan cannot declare a source nobody probed`,
        { role: recording.role, artifactId },
      )
      measured.set(recording.identity.assetId, Object.freeze({
        artifactId: resolved.artifactId,
        sha256: resolved.sha256,
        durationSeconds: resolved.durationSeconds as number,
      }))
    }

    const createdAt = dependencies.clock().toISOString()
    const plan = compilePlaybackMapToDirectedPlan(map, {
      session,
      measured,
      artifactByAssetId,
      projectVersionId: input.projectVersionId,
      objective: input.objective,
      ...(input.desiredAction ? { desiredAction: input.desiredAction } : {}),
      planFps: input.planFps,
      createdAt,
    })

    const persisted = await dependencies.snapshots.persist({
      snapshot: renderablePlanSnapshotOf({
        workspaceId: map.workspaceId,
        projectId: session.projectId,
        origin: 'react-playback',
        sourceId: map.mapId,
        sourceHash: map.mapHash,
        sourceVersion: map.version,
        plan,
      }),
      createdAt,
    })
    return Object.freeze({
      plan: persisted.snapshot.plan,
      planHash: persisted.snapshot.planHash,
      replayed: persisted.replayed,
      mapVersion: map.version,
      snapshot: persisted.snapshot,
    })
  }
}

const PLAYBACK_PIECE_LISTING_MAX = 500

export interface ReactPlaybackPieceListing {
  readonly map: Readonly<PlaybackMap>
  readonly versionRef: string
  readonly manualReviewRequired: boolean
  readonly pieces: readonly Readonly<PlaybackPiece>[]
  /** Pieces the mode filter removed, so a narrowed list never reads as the map. */
  readonly filteredOut: number
  /** Pieces beyond the limit, so a truncated list never reads as complete. */
  readonly omittedPieces: number
}

/**
 * The pieces of one map, optionally narrowed to one playback mode.
 *
 * A separate read from the map itself because the two are asked for different
 * reasons: the map answers "is this resolved?", the pieces answer "what did the
 * player do, where, with what evidence, and how far off was the line we fitted".
 * The uncovered stretches stay on the map rather than being folded in here — a
 * stretch nobody could measure is not a piece with missing fields, and giving it
 * one would be the zero-instead-of-null mistake in another shape.
 */
export function listReactPlaybackPiecesService(dependencies: { repository: PlaybackMapRepository }) {
  const read = readReactPlaybackMapService(dependencies)
  return async (input: {
    workspaceId: string
    sessionId: string
    reactionTrackId: string
    version?: number
    mode?: PlaybackMode
    limit?: number
  }): Promise<Readonly<ReactPlaybackPieceListing>> => {
    const limit = input.limit ?? 100
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= PLAYBACK_PIECE_LISTING_MAX,
      'INVALID_ARGUMENT',
      `limit must be between 1 and ${PLAYBACK_PIECE_LISTING_MAX}`,
    )
    const current = await read(input)
    const matching = input.mode === undefined
      ? current.map.pieces
      : current.map.pieces.filter((piece) => piece.mode === input.mode)
    return Object.freeze({
      map: current.map,
      versionRef: current.versionRef,
      manualReviewRequired: current.manualReviewRequired,
      pieces: Object.freeze(matching.slice(0, limit)),
      filteredOut: current.map.pieces.length - matching.length,
      omittedPieces: Math.max(0, matching.length - limit),
    })
  }
}
