import {
  addCaptureSessionTrack,
  addCaptureSessionTrackPart,
  changeCaptureSessionReferenceTrack,
  createCaptureSession,
  type CaptureSession,
  type CaptureSessionLineage,
  type CaptureTrack,
  type CaptureTrackPart,
} from '../domain/capture-session.ts'
import { DomainError } from '../domain/errors.ts'
import type { CaptureSessionClockPolicy } from '../domain/capture-session.ts'
import type { CaptureSessionRepository } from './ports/capture-session-repository.ts'
import type { CaptureSyncRun, CaptureSyncRunRepository } from './ports/capture-sync-run-repository.ts'

/**
 * Commands and queries over a capture session (F4.002–F4.007).
 *
 * Every command that changes an existing session goes through `loadBase`,
 * which refuses unless the caller named the exact version *and* hash it was
 * working from. The two together are what make a stale command a refusal
 * rather than a silent overwrite: a version number can be reused after a failed
 * write, and a hash alone does not say which link of the chain it is.
 */

export interface CaptureCommandActor {
  readonly workspaceId: string
  readonly clientId: string
}

function versionIdOf(sessionId: string, version: number): string {
  return `${sessionId}:v${version}`
}

/**
 * The version a command was computed against, or a refusal naming what moved.
 *
 * The error deliberately reports the current version rather than just saying
 * "conflict": an operator whose add-track lost a race needs to know what it
 * lost to, and a UI needs it to offer a reload.
 */
async function loadBase(
  repository: CaptureSessionRepository,
  input: { workspaceId: string; sessionId: string; baseVersionId: string; baseHash: string },
): Promise<Readonly<CaptureSession>> {
  const head = await repository.readHead({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  })
  if (!head) {
    throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${input.sessionId} does not exist`)
  }
  const expectedId = versionIdOf(head.sessionId, head.version)
  if (input.baseVersionId !== expectedId || input.baseHash !== head.sessionHash) {
    throw new DomainError(
      'CAPTURE_SESSION_VERSION_STALE',
      `Capture session ${input.sessionId} has moved to version ${head.version}; re-read it and retry`,
      { currentVersionId: expectedId, currentVersion: head.version, currentHash: head.sessionHash },
    )
  }
  return head
}

function lineageFor(
  lineage: Readonly<CaptureSessionLineage>,
  operation: CaptureSessionLineage['operation'],
  occurredAt: string,
): Readonly<CaptureSessionLineage> {
  // The operation and the instant come from the service, not the caller: a
  // client-supplied operation could label an add-track as a create-session, and
  // a client-supplied clock could file a command before the version it edits.
  return Object.freeze({ ...lineage, operation, occurredAt })
}

export function createCaptureSessionService(dependencies: {
  repository: CaptureSessionRepository
  clock: () => Date
}) {
  return async (input: {
    actor: CaptureCommandActor
    projectId: string
    sessionId: string
    clock: Readonly<CaptureSessionClockPolicy>
    referenceTrack: Readonly<CaptureTrack>
    lineage: Readonly<CaptureSessionLineage>
  }): Promise<Readonly<{ session: Readonly<CaptureSession>; replayed: boolean }>> => {
    const now = dependencies.clock().toISOString()
    const session = createCaptureSession({
      workspaceId: input.actor.workspaceId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      clock: input.clock,
      referenceTrackId: input.referenceTrack.trackId,
      tracks: [input.referenceTrack],
      lineage: lineageFor(input.lineage, 'create-session', now),
      createdAt: now,
    })
    const result = await dependencies.repository.appendVersion({ session, occurredAt: now })
    return Object.freeze({ session, replayed: result.replayed })
  }
}

export function addCaptureTrackService(dependencies: {
  repository: CaptureSessionRepository
  clock: () => Date
}) {
  return async (input: {
    actor: CaptureCommandActor
    sessionId: string
    baseVersionId: string
    baseHash: string
    track: Readonly<CaptureTrack>
    lineage: Readonly<CaptureSessionLineage>
  }): Promise<Readonly<{ session: Readonly<CaptureSession>; replayed: boolean }>> => {
    const now = dependencies.clock().toISOString()
    const base = await loadBase(dependencies.repository, {
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      baseVersionId: input.baseVersionId,
      baseHash: input.baseHash,
    })
    const session = addCaptureSessionTrack(base, {
      track: input.track,
      lineage: lineageFor(input.lineage, 'add-track', now),
    })
    const result = await dependencies.repository.appendVersion({
      session,
      expectedVersion: base.version,
      occurredAt: now,
    })
    return Object.freeze({ session, replayed: result.replayed })
  }
}

export function addCaptureTrackPartService(dependencies: {
  repository: CaptureSessionRepository
  clock: () => Date
}) {
  return async (input: {
    actor: CaptureCommandActor
    sessionId: string
    baseVersionId: string
    baseHash: string
    trackId: string
    part: Readonly<CaptureTrackPart>
    lineage: Readonly<CaptureSessionLineage>
  }): Promise<Readonly<{ session: Readonly<CaptureSession>; replayed: boolean }>> => {
    const now = dependencies.clock().toISOString()
    const base = await loadBase(dependencies.repository, {
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      baseVersionId: input.baseVersionId,
      baseHash: input.baseHash,
    })
    const session = addCaptureSessionTrackPart(base, {
      trackId: input.trackId,
      part: input.part,
      lineage: lineageFor(input.lineage, 'add-track-part', now),
    })
    const result = await dependencies.repository.appendVersion({
      session,
      expectedVersion: base.version,
      occurredAt: now,
    })
    return Object.freeze({ session, replayed: result.replayed })
  }
}

export function changeCaptureReferenceTrackService(dependencies: {
  repository: CaptureSessionRepository
  clock: () => Date
}) {
  return async (input: {
    actor: CaptureCommandActor
    sessionId: string
    baseVersionId: string
    baseHash: string
    referenceTrackId: string
    lineage: Readonly<CaptureSessionLineage>
  }): Promise<Readonly<{ session: Readonly<CaptureSession>; replayed: boolean }>> => {
    const now = dependencies.clock().toISOString()
    const base = await loadBase(dependencies.repository, {
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      baseVersionId: input.baseVersionId,
      baseHash: input.baseHash,
    })
    const session = changeCaptureSessionReferenceTrack(base, {
      referenceTrackId: input.referenceTrackId,
      lineage: lineageFor(input.lineage, 'change-reference-track', now),
    })
    const result = await dependencies.repository.appendVersion({
      session,
      expectedVersion: base.version,
      occurredAt: now,
    })
    return Object.freeze({ session, replayed: result.replayed })
  }
}

export function requestCaptureSyncService(dependencies: {
  repository: CaptureSessionRepository
  runs: CaptureSyncRunRepository
  createId: () => string
  clock: () => Date
}) {
  return async (input: {
    actor: CaptureCommandActor
    projectId: string
    sessionId: string
    baseVersionId: string
    baseHash: string
    idempotencyKey: string
  }): Promise<Readonly<{ run: Readonly<CaptureSyncRun>; replayed: boolean }>> => {
    const now = dependencies.clock().toISOString()
    const base = await loadBase(dependencies.repository, {
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      baseVersionId: input.baseVersionId,
      baseHash: input.baseHash,
    })
    // A session of one track has nothing to synchronize: the reference track is
    // the clock, and measuring it against itself is true by construction.
    if (base.tracks.length < 2) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'A capture session needs a second track before there is anything to synchronize',
      )
    }
    return dependencies.runs.request({
      id: dependencies.createId(),
      workspaceId: input.actor.workspaceId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      baseVersionId: input.baseVersionId,
      baseSessionHash: input.baseHash,
      baseVersion: base.version,
      // Everything except the reference track, which is the clock itself.
      trackCount: base.tracks.length - 1,
      idempotencyKey: input.idempotencyKey,
      createdByClientId: input.actor.clientId,
      requestedAt: now,
    })
  }
}

export function readCaptureSessionService(dependencies: { repository: CaptureSessionRepository }) {
  return async (input: {
    workspaceId: string
    sessionId: string
    version?: number
  }): Promise<Readonly<CaptureSession>> => {
    const session = input.version === undefined
      ? await dependencies.repository.readHead(input)
      : await dependencies.repository.readVersion({ ...input, version: input.version })
    if (!session) {
      throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${input.sessionId} does not exist`)
    }
    return session
  }
}

export function listCaptureSessionsService(dependencies: { repository: CaptureSessionRepository }) {
  return async (input: { workspaceId: string; projectId: string; limit?: number }) => {
    const heads = await dependencies.repository.listHeads(input)
    // The list shows the current version of each session, so it reads the head
    // and then the version it points at rather than reconstructing a summary
    // from the pointer alone — the pointer does not carry the track count.
    const sessions = await Promise.all(heads.map((head) =>
      dependencies.repository.readVersion({
        workspaceId: input.workspaceId,
        sessionId: head.sessionId,
        version: head.version,
      })))
    return Object.freeze(sessions.filter((session): session is Readonly<CaptureSession> => session !== null))
  }
}

export function listCaptureSessionVersionsService(dependencies: {
  repository: CaptureSessionRepository
}) {
  return async (input: { workspaceId: string; sessionId: string; limit?: number }) => {
    const versions = await dependencies.repository.listVersions(input)
    if (versions.length === 0) {
      throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${input.sessionId} does not exist`)
    }
    return versions
  }
}

/**
 * Everything the cascade decided for a session, assembled per track.
 *
 * Derivations are filtered against the session version they were computed for.
 * A map measured against version 3 is not a slightly-old answer for version 4:
 * the tracks it measured may not be the tracks in the session any more, so it
 * is omitted rather than shown with a caveat nobody reads.
 */
export function readCaptureSyncService(dependencies: { repository: CaptureSessionRepository }) {
  return async (input: { workspaceId: string; sessionId: string }) => {
    const session = await dependencies.repository.readHead(input)
    if (!session) {
      throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${input.sessionId} does not exist`)
    }
    const [records, maps, coverages] = await Promise.all([
      dependencies.repository.listSyncEvidence(input),
      dependencies.repository.listClockMaps(input),
      dependencies.repository.listCoverage(input),
    ])
    const currentMaps = new Map(maps
      .filter((map) => map.derivedFrom.sessionVersion === session.version
        && map.derivedFrom.referenceEpoch === session.referenceEpoch)
      .map((map) => [map.sourceId, map]))
    const currentCoverage = new Map(coverages
      .filter((coverage) => coverage.derivedFrom.sessionVersion === session.version
        && coverage.derivedFrom.referenceEpoch === session.referenceEpoch)
      .map((coverage) => [coverage.trackId, coverage]))

    const tracks = session.tracks
      .filter((track) => track.trackId !== session.referenceTrackId)
      .map((track) => {
        const record = records.find((entry) => entry.trackId === track.trackId)
        return record
          ? {
            record,
            map: currentMaps.get(track.sourceAssetId) ?? null,
            coverage: currentCoverage.get(track.trackId) ?? null,
          }
          : null
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

    return Object.freeze({ session, tracks: Object.freeze(tracks) })
  }
}
