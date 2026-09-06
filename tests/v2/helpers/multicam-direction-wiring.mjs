import { randomUUID } from 'node:crypto'

import { createExternalAuditContext } from '../../../src/v2/application/authenticate-api-client.ts'
import { createDesiredAction, createDesiredActionReference } from '../../../src/v2/domain/desired-action.ts'
import { createEditorialAudioTimelineHash } from '../../../src/v2/domain/production-modes.ts'
import {
  deriveMulticamEvidenceService,
  directMulticamSessionService,
} from '../../../src/v2/application/multicam-direction.ts'
import { buildDirectableMulticamWorld, fixtureSeconds as sec } from '../wave20-fixtures.mjs'

/**
 * The direction COMMAND, wired to in-memory doubles.
 *
 * Extracted from `multicam-direction-service.test.mjs`, which is still its
 * principal reader, because the falsification suite has to drive the same
 * command through the same seam: a refusal is only worth asserting next to the
 * request that is identical except for the field being refused, and rebuilding
 * a second wiring would have proved something about the second wiring.
 *
 * The doubles enforce what the database enforces — the fence in the write
 * predicate, replay by content hash, a read that verifies — and count their own
 * calls, so "the retry did no new work" is measured rather than asserted.
 */

export const WORKSPACE = 'workspace-multicam'
export const PROJECT = 'project-multicam'
export const SESSION = 'session-multicam'
export const CLIENT = 'client-director'

export function actor(overrides = {}) {
  const identity = {
    clientId: CLIENT,
    credentialId: 'credential-director',
    workspaceId: WORKSPACE,
    environment: 'sandbox',
    delegatedUserId: 'member-director',
    delegatedIdentityId: 'identity-director',
    workspaceRole: 'administrator',
    ...overrides,
  }
  return {
    ...identity,
    scopes: new Set(['projects:write']),
    authenticationKind: 'ui-session',
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    auditContext: createExternalAuditContext(identity),
  }
}

/** A Director plan for the project, so the direction has a timeline to re-cut. */
export function baseDirectedPlan({ versionId }) {
  const desiredActionRef = createDesiredActionReference(createDesiredAction({ objective: 'warming' }))
  const clips = [Object.freeze({
    id: 'clip-base-0001',
    sourceArtifactId: 'asset-cam-a',
    sourceInFrame: 0,
    sourceOutFrame: 900,
    timelineInFrame: 0,
    timelineOutFrame: 900,
    rate: 1,
  })]
  return Object.freeze({
    schemaVersion: 2,
    state: 'compiled',
    id: `edit-plan-${versionId}`,
    projectVersionId: versionId,
    storyPlanId: 'story-base',
    treatmentPlanId: 'treatment-base',
    directorRunId: 'director-run-base',
    fps: 30,
    durationFrames: 900,
    sources: Object.freeze([Object.freeze({ id: 'asset-cam-a', artifactId: 'asset-cam-a', kind: 'video', durationSeconds: 300 })]),
    videoTracks: Object.freeze([Object.freeze({ id: 'track-primary-video', kind: 'base-video', clips: Object.freeze(clips) })]),
    overlayTracks: Object.freeze([Object.freeze({
      id: `overlay-${desiredActionRef.id}`,
      kind: 'cta',
      desiredActionRef,
      startFrame: 810,
      endFrame: 900,
      text: 'Fale com a gente',
    })]),
    subtitleTracks: Object.freeze([Object.freeze({
      id: 'track-captions-pt-br',
      kind: 'captions',
      presetId: 'clean-color',
      anchor: 'bottom',
      faceProtection: true,
      maxLines: 2,
      maxCharactersPerBlock: 42,
      desiredActionRef,
      cues: Object.freeze([Object.freeze({ id: 'cue-1', startFrame: 0, endFrame: 60, text: 'oi', anchor: 'bottom' })]),
    })]),
    audioTracks: Object.freeze([]),
    effectTracks: Object.freeze([]),
    transitions: Object.freeze([]),
    markers: Object.freeze([]),
    protectedElements: Object.freeze([]),
    localeVariantRefs: Object.freeze([]),
    formatVariantRefs: Object.freeze([]),
    lineageRefs: Object.freeze(['asset-cam-a']),
    editorial: Object.freeze({ commandType: 'source-ingest', exclusions: Object.freeze([]), retainedSourceRanges: Object.freeze([]) }),
    retimedTranscript: Object.freeze({ sourceTranscriptId: 'transcript-base', words: Object.freeze([]) }),
    movementPolicy: Object.freeze({ automaticZoom: false, protectedOpeningFrames: 120 }),
    subtitlePolicy: Object.freeze({ faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 }),
    composition: Object.freeze({
      layout: 'landscape-inset',
      background: 'blurred-source',
      foregroundScale: 1,
      verticalPosition: 0.5,
      faceSafeFallback: Object.freeze([0.14, 0.08, 0.72, 0.56]),
      subtitleSafeRegion: Object.freeze([0.08, 0.7, 0.84, 0.24]),
    }),
    director: Object.freeze({ plannerVersion: 'base-planner/v1', decisions: Object.freeze([]), assumptions: Object.freeze([]) }),
    desiredActionRef,
    audioTimelineHash: createEditorialAudioTimelineHash({ fps: 30, clips }),
    createdAt: '2029-04-01T09:00:00.000Z',
  })
}

export function memoryDirections() {
  const evidence = new Map()
  const chains = new Map()
  const calls = { persistEvidenceSet: 0, appendVersion: 0 }
  return {
    calls,
    async persistEvidenceSet({ set }) {
      calls.persistEvidenceSet += 1
      const key = `${set.workspaceId}:${set.evidenceHash}`
      if (evidence.has(key)) return { set: evidence.get(key), replayed: true }
      evidence.set(key, set)
      return { set, replayed: false }
    },
    async readEvidenceSet({ workspaceId, evidenceHash }) {
      return evidence.get(`${workspaceId}:${evidenceHash}`) ?? null
    },
    async readLatestEvidenceSet() {
      return [...evidence.values()].at(-1) ?? null
    },
    async appendVersion({ direction, base }) {
      calls.appendVersion += 1
      const key = `${direction.workspaceId}:${direction.sessionId}`
      const chain = chains.get(key) ?? []
      const head = chain.at(-1) ?? null
      // The fence lives where the database puts it: the write refuses unless the
      // head is still the one the caller computed against.
      const expected = head ? { version: head.version, directionHash: head.direction.directionHash } : null
      if (JSON.stringify(base) !== JSON.stringify(expected)) {
        const error = new Error('direction head moved')
        error.code = 'PERSISTENCE_CONFLICT'
        throw error
      }
      const stored = { direction, version: (head?.version ?? 0) + 1, previousVersionHash: head?.direction.directionHash ?? null }
      chains.set(key, [...chain, stored])
      return { stored, replayed: false }
    },
    async readHead({ workspaceId, sessionId }) {
      return chains.get(`${workspaceId}:${sessionId}`)?.at(-1) ?? null
    },
    async readVersion({ workspaceId, sessionId, version }) {
      return chains.get(`${workspaceId}:${sessionId}`)?.find((entry) => entry.version === version) ?? null
    },
    async listVersions({ workspaceId, sessionId }) {
      return [...(chains.get(`${workspaceId}:${sessionId}`) ?? [])].reverse()
    },
    async findDependents() {
      return []
    },
  }
}

export function memoryCommands({ world, versionId = 'project-version-1', baseHash = 'a'.repeat(64), mediaLinks }) {
  const commands = new Map()
  const calls = { readContext: 0, commitOrReplay: 0 }
  const currentVersion = Object.freeze({
    schemaVersion: 1,
    id: versionId,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    sequence: 4,
    parentVersionId: 'project-version-0',
    snapshotRefs: Object.freeze({ brief: 'snapshot-brief', editPlan: 'snapshot-plan', policies: 'snapshot-policies' }),
    baseHash,
    createdBy: CLIENT,
    createdAt: '2029-04-01T09:00:00.000Z',
  })
  const links = mediaLinks ?? world.session.tracks.map((track) => ({
    artifactId: track.sourceAssetId,
    role: track.trackId === 'track-camera-a' ? 'source-master' : 'selected-insert',
    status: 'available',
    mediaType: track.role === 'microphone' || track.role === 'master-audio' ? 'audio' : 'video',
    frameRate: null,
  }))
  return {
    calls,
    currentVersion,
    async findIdempotentResult({ workspaceId, projectId, idempotencyKey, actorContextHash }) {
      return commands.get([workspaceId, projectId, idempotencyKey, actorContextHash].join('|')) ?? null
    },
    async readContext({ workspaceId, projectId }) {
      calls.readContext += 1
      if (workspaceId !== WORKSPACE || projectId !== PROJECT) return null
      return {
        workspaceId,
        projectId,
        objective: 'warming',
        currentVersion,
        currentPlan: baseDirectedPlan({ versionId }),
        currentDurationFrames: 900,
        proxyVariantId: '9:16',
        outputReferences: Object.freeze([]),
        mediaLinks: Object.freeze(links),
      }
    },
    async commitOrReplay(bundle) {
      calls.commitOrReplay += 1
      const result = Object.freeze({
        command: bundle.command,
        version: bundle.version,
        editPlan: bundle.editPlan,
        impact: bundle.command.payload.impact,
        invalidations: Object.freeze([]),
        replayed: false,
      })
      commands.set(
        [bundle.command.workspaceId, bundle.command.projectId, bundle.command.idempotencyKey, bundle.authenticationAudit.contextHash].join('|'),
        { requestFingerprint: bundle.requestFingerprint, result },
      )
      return result
    },
  }
}

// The default `activityBps` is the number the production FFmpeg pass actually
// measured over a moving test pattern (`multicam-visual-evidence.integration.mjs`
// prints the table: 103 bps of full scale). It used to be 4200 — a value no
// camera produces — which is how the screen-activity limb came to be exercised
// at forty times its real magnitude here and to be inert in production.
export function fakeVisual({ activityBps = 103, stabilityBps = 9_100, exposureBps = 8_800, frames = 30 } = {}) {
  const seen = []
  return {
    seen,
    async measure({ windows }) {
      seen.push(...windows)
      return windows.map((window) => ({
        trackId: window.trackId,
        partId: window.partId,
        sourceArtifactId: window.sourceArtifactId,
        sourceStartMs: window.sourceStartMs,
        sourceEndMs: window.sourceEndMs,
        sampledFrameCount: window.trackId === 'track-camera-b' ? 0 : frames,
        // Camera B's window produced no frames at all: nulls, not zeros, and the
        // producer must drop it rather than record "measured, and nothing".
        activityBps: window.trackId === 'track-screen' ? activityBps : null,
        sharpnessBps: null,
        stabilityBps: window.trackId === 'track-camera-b' ? null : stabilityBps,
        exposureBps: window.trackId === 'track-camera-b' ? null : exposureBps,
        method: 'fixture/signalstats',
        evidenceRef: `media-artifact:${window.sourceArtifactId}:${window.sourceStartMs}-${window.sourceEndMs}`,
      }))
    },
  }
}

export function fakeMedia() {
  const released = []
  return {
    released,
    async resolve({ part }) {
      return {
        path: `C:/materialized/${part.sourceAssetId}.mp4`,
        release: async () => { released.push(part.sourceAssetId) },
      }
    },
  }
}

export function fakeDiarization({ segments } = {}) {
  const runs = segments ?? [
    {
      runId: 'diarization-mic-a',
      sourceArtifactId: 'asset-mic-a',
      provider: 'fixture',
      producedAt: '2029-04-01T09:02:00.000Z',
      segments: [
        { segmentId: 'seg-a-1', ordinal: 0, speakerKey: 'cluster-1', startMs: 1_000, endMs: 100_000 },
        { segmentId: 'seg-a-2', ordinal: 1, speakerKey: 'cluster-1', startMs: 200_000, endMs: 260_000 },
      ],
    },
    {
      runId: 'diarization-mic-b',
      sourceArtifactId: 'asset-mic-b',
      provider: 'fixture',
      producedAt: '2029-04-01T09:02:00.000Z',
      segments: [
        { segmentId: 'seg-b-1', ordinal: 0, speakerKey: 'cluster-2', startMs: 100_000, endMs: 200_000 },
      ],
    },
  ]
  return {
    async listLatestRunsForArtifacts({ sourceArtifactIds }) {
      return runs.filter((run) => sourceArtifactIds.includes(run.sourceArtifactId))
    },
  }
}

export function wire(options = {}) {
  const world = options.world ?? buildDirectableMulticamWorld({ workspaceId: WORKSPACE, sessionId: SESSION, projectId: PROJECT })
  const directions = memoryDirections()
  const commands = memoryCommands({ world, ...(options.commands ?? {}) })
  const visual = options.visual ?? fakeVisual()
  const media = fakeMedia()
  let issued = 0
  const sessions = {
    async readHead({ workspaceId, sessionId }) {
      if (workspaceId !== WORKSPACE || sessionId !== world.session.sessionId) return null
      // The port is scoped to the workspace and nothing else. `sessionProjectId`
      // is how a test produces the case the port cannot refuse: a session this
      // workspace really does own, belonging to a different project than the one
      // in the path.
      return options.sessionProjectId
        ? { ...world.session, projectId: options.sessionProjectId }
        : world.session
    },
    async listCoverage() { return world.coverages },
    async listClockMaps() { return world.clockMaps },
  }
  const deriveEvidence = deriveMulticamEvidenceService({
    sessions,
    directions,
    diarization: options.diarization ?? fakeDiarization(),
    visual,
    media,
    ...(options.perception ? { perception: options.perception } : {}),
    clock: () => new Date('2029-04-01T09:05:00.000Z'),
    evidenceWindowMs: options.evidenceWindowMs ?? 60_000,
    ...(options.maxVisualWindowsPerPart ? { maxVisualWindowsPerPart: options.maxVisualWindowsPerPart } : {}),
  })
  const execute = directMulticamSessionService({
    sessions,
    diagnostics: {
      async readHead({ sessionId }) {
        return options.noDiagnostic ? null : (sessionId === world.session.sessionId ? (options.diagnostic ?? world.diagnostic) : null)
      },
    },
    protocols: { async listEvaluations() { return options.evaluations ?? [] } },
    directions,
    commands,
    deriveEvidence,
    clock: () => new Date('2029-04-01T09:06:00.000Z'),
    createId: (prefix) => `${prefix}-${(issued += 1)}`,
    createEventId: () => randomUUID(),
  })
  return { world, directions, commands, visual, media, deriveEvidence, execute }
}

export function request(overrides = {}) {
  return {
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    sessionId: SESSION,
    baseVersionId: 'project-version-1',
    baseHash: 'a'.repeat(64),
    format: { aspectRatio: '16:9' },
    range: { sessionStartTicks: sec(1).toString(), sessionEndTicks: sec(280).toString() },
    actor: actor(),
    idempotency: { clientId: CLIENT, key: 'idem-direction-1' },
    ...overrides,
  }
}

