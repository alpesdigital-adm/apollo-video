import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createDesiredAction, createDesiredActionReference } from '../../src/v2/domain/desired-action.ts'
import { createEditorialAudioTimelineHash } from '../../src/v2/domain/production-modes.ts'
import {
  deriveMulticamEvidenceService,
  directMulticamSessionService,
  planFrameRate,
} from '../../src/v2/application/multicam-direction.ts'
import { buildDirectableMulticamWorld, fixtureSeconds as sec } from './wave20-fixtures.mjs'

/**
 * T-F4.012 — the direction COMMAND, against services rather than the domain.
 *
 * The domain suite (`multicam-direction.test.mjs`) proves what a direction
 * decides. Nothing here re-proves that. What is under test is the seam: that a
 * caller hands over ids, a fence and labelled attestations and gets back a
 * persisted direction, a compiled multi-source `DirectedEditPlan` and a project
 * version — and that everything else it might try to hand over is refused.
 *
 * The fakes follow `sync-diagnostic-journey.e2e.mjs`: in-memory doubles that
 * enforce the same rules the database enforces (fence in the predicate, replay
 * by content hash, hash-verified read) and count their own calls, so "the retry
 * did no new work" is measured rather than asserted.
 */

const WORKSPACE = 'workspace-multicam'
const PROJECT = 'project-multicam'
const SESSION = 'session-multicam'
const CLIENT = 'client-director'

/**
 * The evidence hash the default world produces, pinned on purpose.
 *
 * The set is content-addressed, so this is the one assertion that catches a
 * change to WHAT was read rather than to how it was reported. It moves only
 * when a fixture or a derivation rule deliberately moves, and then it moves in
 * the same commit as the reason.
 */
const PINNED_EVIDENCE_HASH = '1cb6ca9bc6da3ac801f2c61976ff66f6f992a0cd5ccbf1f8d999461d4b3299f4'

function actor(overrides = {}) {
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
function baseDirectedPlan({ versionId }) {
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

function memoryDirections() {
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

function memoryCommands({ world, versionId = 'project-version-1', baseHash = 'a'.repeat(64), mediaLinks }) {
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
function fakeVisual({ activityBps = 103, stabilityBps = 9_100, exposureBps = 8_800, frames = 30 } = {}) {
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

function fakeMedia() {
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

function fakeDiarization({ segments } = {}) {
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

function wire(options = {}) {
  const world = options.world ?? buildDirectableMulticamWorld({ workspaceId: WORKSPACE, sessionId: SESSION, projectId: PROJECT })
  const directions = memoryDirections()
  const commands = memoryCommands({ world, ...(options.commands ?? {}) })
  const visual = options.visual ?? fakeVisual()
  const media = fakeMedia()
  let issued = 0
  const sessions = {
    async readHead({ workspaceId, sessionId }) {
      return workspaceId === WORKSPACE && sessionId === world.session.sessionId ? world.session : null
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
    evidenceWindowMs: 60_000,
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

function request(overrides = {}) {
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

test('T-F4.012 the command derives evidence, direction, plan and version from ids and a fence alone', async () => {
  const wired = wire()
  const result = await wired.execute(request())

  // Nothing in the request said which angle, how confident, or what was
  // measured. All of it came back derived.
  assert.equal(result.replayed, false)
  assert.equal(result.direction.sessionId, SESSION)
  assert.equal(result.directionVersion, 1)
  assert.ok(result.direction.shots.length >= 2, 'the session was cut into more than one shot')
  assert.equal(result.direction.uncovered.length, 0, 'every directed instant had an eligible angle')

  const clips = result.editPlan.videoTracks[0].clips
  assert.equal(result.editPlan.videoTracks.length, 1)
  assert.equal(result.editPlan.videoTracks[0].kind, 'base-video')
  assert.equal(clips.length, result.direction.shots.length, 'one shot became exactly one clip')
  assert.equal(result.editPlan.transitions.length, clips.length - 1)
  assert.ok(result.editPlan.transitions.every((transition) => transition.type === 'straight-cut'))
  assert.equal(clips[0].timelineInFrame, 0)
  assert.equal(clips.at(-1).timelineOutFrame, result.editPlan.durationFrames)

  // The plan is genuinely multi-source: more than one camera file, and every
  // clip carries the camera key a ColorPlan override will target.
  const cameras = new Set(clips.map((clip) => clip.sourceArtifactId))
  assert.ok(cameras.size >= 2, `the plan cuts ${cameras.size} camera files`)
  assert.ok(clips.every((clip) => typeof clip.cameraId === 'string' && clip.cameraId.length > 0))
  assert.ok(clips.every((clip) => clip.audioSourceArtifactId === 'asset-master'), 'every shot lies on the master audio bed')
  assert.deepEqual(
    [...new Set(result.editPlan.sources.map((source) => source.artifactId))].sort(),
    [...cameras].sort(),
    'sources[] is the superset of the picture files the clips name',
  )

  const summary = result.editPlan.director.decisions.find((decision) => decision.category === 'angle')
  assert.ok(summary, 'the run records an angle decision')
  assert.equal(summary.decisionType, 'cut')
  assert.ok(summary.evidenceRefs.some((ref) => ref.startsWith('multicam-direction:')))
  assert.ok(result.editPlan.director.decisions.some((decision) => decision.id.startsWith('decision-angle-shot-')))
  assert.equal(result.editPlan.director.plannerVersion, 'multicam-direction-planner/2026-09-v1')

  assert.equal(result.command.type, 'direct-multicam-session')
  assert.equal(result.command.payload.directionHash, result.direction.directionHash)
  assert.equal(result.command.payload.manualReviewRequired, result.direction.manualReviewRequired)
  assert.equal(result.version.sequence, 5)
  console.log(`direct shots=${result.direction.shots.length} clips=${clips.length} sources=${result.editPlan.sources.length} frames=${result.editPlan.durationFrames}`)
})

test('T-F4.012 a stale base version is refused before anything is derived', async () => {
  const wired = wire()
  await assert.rejects(
    () => wired.execute(request({ baseHash: 'b'.repeat(64) })),
    (error) => error.code === 'VERSION_CONFLICT'
      && error.details.currentVersionId === 'project-version-1'
      && error.details.currentBaseHash === 'a'.repeat(64),
  )
  assert.equal(wired.directions.calls.appendVersion, 0, 'a stale fence writes no direction')
  assert.equal(wired.commands.calls.commitOrReplay, 0)
})

test('T-F4.012 a replay returns the first plan and does no new work', async () => {
  const wired = wire()
  const first = await wired.execute(request())
  const appendsAfterFirst = wired.directions.calls.appendVersion
  const commitsAfterFirst = wired.commands.calls.commitOrReplay

  const second = await wired.execute(request())
  assert.equal(second.replayed, true)
  assert.equal(second.command.id, first.command.id)
  assert.equal(second.version.id, first.version.id)
  assert.equal(second.editPlan.audioTimelineHash, first.editPlan.audioTimelineHash)
  assert.equal(second.direction.directionHash, first.direction.directionHash)
  assert.equal(second.compilation, null, 'a replay recompiles nothing')
  assert.equal(wired.directions.calls.appendVersion, appendsAfterFirst, 'the retry appended no second direction')
  assert.equal(wired.commands.calls.commitOrReplay, commitsAfterFirst, 'the retry committed nothing')

  await assert.rejects(
    () => wired.execute(request({ format: { aspectRatio: '9:16' } })),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('T-F4.012 the caller may not declare a score, an eligibility, a measurement or an approval', async () => {
  const wired = wire()
  const cases = [
    [{ confidence: 0.99 }, 'confidence'],
    [{ shots: [] }, 'shots'],
    [{ manualReviewRequired: false }, 'manualReviewRequired'],
    [{ directionHash: 'c'.repeat(64) }, 'directionHash'],
    [{ protectedSelections: [{ selectionId: 'sel-1', trackId: 'track-camera-a', sessionStartTicks: '0', sessionEndTicks: '90000', note: 'keep', score: 1 }] }, 'protectedSelections[0].score'],
  ]
  for (const [extra, field] of cases) {
    await assert.rejects(
      () => wired.execute(request(extra)),
      (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION' && error.details.field === field,
      `${field} must be refused by name`,
    )
  }
  // The calibration is not an operator preference either.
  await assert.rejects(
    () => wired.execute(request({ policy: { weights: { speaker: 9 } } })),
    (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION' && error.details.field === 'policy.weights',
  )
  // An accepted key still goes through the domain's own bounds: a minimum shot
  // longer than the jump-cut cover is refused there, not here.
  await assert.rejects(
    () => wired.execute(request({ policy: { minimumShotMs: 2_400 } })),
    (error) => error.code === 'INVALID_ARGUMENT' && /jumpCutSameAngleMs/.test(error.message),
  )
  // …while a coherent editorial preference is accepted and changes the cut.
  const longer = await wired.execute(request({ policy: { minimumShotMs: 1_800 }, idempotency: { clientId: CLIENT, key: 'idem-policy' } }))
  assert.ok(longer.editPlan.director.decisions.length >= 4)
  assert.equal(wired.directions.calls.appendVersion, 1)
})

test('T-F4.012 a protected selection is attested by the actor, with the caller only supplying the note', async () => {
  const wired = wire()
  const result = await wired.execute(request({
    protectedSelections: [{
      selectionId: 'selection-1',
      trackId: 'track-camera-b',
      sessionStartTicks: sec(30).toString(),
      sessionEndTicks: sec(60).toString(),
      note: 'the guest holds up the prototype here',
    }],
  }))
  const held = result.direction.shots.find((shot) => shot.rule === 'protected-selection')
  assert.ok(held, 'the protected range was honoured as its own shot')
  assert.equal(held.chosen.trackId, 'track-camera-b')
  assert.ok(held.reason.includes(`${CLIENT}/member-director`), 'the shot records who attested it, not only what they said')
  assert.ok(held.reason.includes('the guest holds up the prototype here'), 'and the note they gave')
})

test('T-F4.012 a session with no sync diagnostic cannot be auto-directed', async () => {
  const wired = wire({ noDiagnostic: true })
  await assert.rejects(
    () => wired.execute(request()),
    (error) => error.code === 'SYNC_DIAGNOSTIC_NOT_FOUND',
  )
  assert.equal(wired.directions.calls.appendVersion, 0)
})

test('T-F4.012 an unmeasured dimension produces no observation, and a decode with no frames produces nothing at all', async () => {
  const wired = wire()
  const evidence = await wired.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })

  const kinds = new Set(evidence.set.observations.map((observation) => observation.kind))
  assert.ok(kinds.has('active-speaker'), 'the diarization runs became speech observations')
  assert.ok(kinds.has('screen-activity'), 'the screen measured activity')
  assert.ok(kinds.has('technical-quality'))

  // Camera B's decode produced no frames: no quality observation, and the
  // reason is reported rather than swallowed.
  assert.equal(
    evidence.set.observations.some((observation) => observation.trackId === 'track-camera-b' && observation.kind === 'technical-quality'),
    false,
    'a decode with no frames is not a quality of zero',
  )
  assert.ok(
    evidence.skipped.some((entry) => entry.reason === 'the decode produced no frames'),
    'and it says so',
  )
  // Sharpness was never measured by this pass, so it is null on every quality
  // observation rather than a number nobody produced.
  const quality = evidence.set.observations.filter((observation) => observation.kind === 'technical-quality')
  assert.ok(quality.length > 0)
  assert.ok(quality.every((observation) => observation.value.sharpnessBps === null))
  assert.ok(quality.every((observation) => observation.value.stabilityBps !== null))

  // Only the screen carries activity; the cameras reported null and produced no
  // screen-activity observation each.
  const activity = evidence.set.observations.filter((observation) => observation.kind === 'screen-activity')
  assert.ok(activity.length > 0)
  assert.ok(activity.every((observation) => observation.trackId === 'track-screen'))

  // Every observation says where it came from, and every materialized file was
  // handed back.
  assert.ok(evidence.set.observations.every((observation) => observation.provenance.evidenceRef.length > 0))
  assert.deepEqual([...wired.media.released].sort(), ['asset-cam-a', 'asset-cam-b', 'asset-screen'])

  const replay = await wired.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  assert.equal(replay.replayed, true, 'the same observations for the same session version are one set')
  assert.equal(replay.set.evidenceHash, evidence.set.evidenceHash)
  console.log(`evidence observations=${evidence.set.observations.length} skipped=${evidence.skipped.length} hash=${evidence.set.evidenceHash.slice(0, 12)}`)
})

test('T-F4.012 a compiled clip whose recording the project does not link is refused before it reaches a renderer', async () => {
  const wired = wire({
    commands: {
      mediaLinks: [
        { artifactId: 'asset-cam-a', role: 'source-master', status: 'available', mediaType: 'video', frameRate: null },
        { artifactId: 'asset-master', role: 'selected-insert', status: 'quarantined', mediaType: 'audio', frameRate: null },
      ],
    },
  })
  await assert.rejects(
    () => wired.execute(request()),
    (error) => error.code === 'MEDIA_ARTIFACT_SOURCE_NOT_FOUND' && error.details.artifactIds.includes('asset-master'),
  )
  // The direction itself is stored: the refusal is about the project's media
  // links, and deleting the evidence would answer "no" without saying why.
  assert.equal(wired.directions.calls.appendVersion, 1)
})

test('T-F4.012 an NTSC plan rate survives the trip through the plan float', () => {
  assert.deepEqual(planFrameRate(30000 / 1001), { num: 30000n, den: 1001n })
  assert.deepEqual(planFrameRate(24000 / 1001), { num: 24000n, den: 1001n })
  assert.deepEqual(planFrameRate(30), { num: 30n, den: 1n })
  assert.deepEqual(planFrameRate(29.97), { num: 30000n, den: 1001n })
  assert.throws(() => planFrameRate(0), (error) => error.code === 'INVALID_RENDER_INPUT')
})

test('T-F4.012 the range a caller names is a position the direction is cut to', async () => {
  const wired = wire()
  const named = await wired.execute(request({
    range: { sessionStartTicks: sec(10).toString(), sessionEndTicks: sec(120).toString() },
  }))
  assert.equal(named.direction.range.start, sec(10))
  assert.equal(named.direction.range.end, sec(120))
  // Every shot lies inside it, which is the thing a caller is actually buying
  // by naming one. (The third assertion here used to restate the two above it
  // in different words, and the title promised an omitted-range case that the
  // body never ran; that case is now its own test.)
  assert.ok(named.direction.shots.length > 0)
  assert.ok(named.direction.shots.every((shot) => shot.sessionRange.start >= sec(10) && shot.sessionRange.end <= sec(120)))
  assert.equal(named.direction.shots[0].sessionRange.start, sec(10), 'and the first one starts exactly where the caller said')
})

test('T-F4.012 the plan drops what described the timeline it replaced, and says so', async () => {
  const wired = wire()
  const result = await wired.execute(request())
  // Exclusions and retained ranges named source seconds of the single recording
  // the old timeline was trimmed from; this one is cut from several cameras, so
  // carrying them would be a description of a timeline that no longer exists.
  assert.deepEqual([...result.editPlan.editorial.retainedSourceRanges], [])
  assert.deepEqual([...result.editPlan.editorial.exclusions], [])
  assert.deepEqual([...result.editPlan.subtitleTracks], [])
  assert.deepEqual([...result.editPlan.retimedTranscript.words], [])
  assert.equal(result.editPlan.retimedTranscript.sourceTranscriptId, 'transcript-base', 'the transcript it came from is still named')
  for (const fragment of ['Subtitle cues', 'retimed transcript', 'editorial exclusions']) {
    assert.ok(
      result.editPlan.director.assumptions.some((assumption) => assumption.includes(fragment)),
      `the plan states out loud that it dropped ${fragment}`,
    )
  }
  // Every Director decision id satisfies the validator's grammar, which is
  // narrower than the session-id grammar it is derived from.
  assert.ok(result.editPlan.director.decisions.every((decision) => /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(decision.id)))
})

test('T-F4.012 a threshold that decides eligibility is calibration, not an editorial preference', async () => {
  const wired = wire()
  // `qualityFloorBps` is the exact number `deriveCandidate` compares a measured
  // quality against before stamping `quality-below-floor`, so a request that
  // moved it moved which cameras were ELIGIBLE — caller-supplied eligibility
  // through a field that merely looked like a preference. Measured before the
  // fix, on this fixture: at the default 3000 camera B had 1 candidate and 0
  // eligible; at 0 it had 2 candidates, 2 eligible, and one more shot was cut
  // to it. The refusal names the field so an operator can remove it.
  for (const field of ['qualityFloorBps', 'reactionIntensityFloorBps']) {
    await assert.rejects(
      () => wired.execute(request({ policy: { [field]: 0 }, idempotency: { clientId: CLIENT, key: `idem-${field}` } })),
      (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION' && error.details.field === `policy.${field}`,
      `policy.${field} must be refused by name`,
    )
  }
  assert.equal(wired.directions.calls.appendVersion, 0, 'nothing was derived, so nothing was stored')
  assert.equal(wired.commands.calls.readContext, 0, 'and the project was never even read')
})

test('T-F4.012 an unknown key on a protected selection is refused rather than accepted and dropped', async () => {
  const wired = wire()
  const selection = {
    selectionId: 'selection-1',
    trackId: 'track-camera-b',
    sessionStartTicks: sec(30).toString(),
    sessionEndTicks: sec(60).toString(),
    note: 'the guest holds up the prototype here',
  }
  // `attestedBy` is the one a caller reaches for, and it is the identity of the
  // authenticated actor: accepting and dropping it would teach the next caller
  // that they get to say whose name sits on a human override.
  await assert.rejects(
    () => wired.execute(request({ protectedSelections: [{ ...selection, attestedBy: 'somebody-else' }] })),
    (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION' && error.details.field === 'protectedSelections[0].attestedBy',
  )
  await assert.rejects(
    () => wired.execute(request({ protectedSelections: [{ ...selection, sessionStartTick: '0' }] })),
    (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION'
      && error.details.field === 'protectedSelections[0].sessionStartTick',
    'even a typo is named, instead of silently going nowhere',
  )
  assert.equal(wired.directions.calls.appendVersion, 0)
})

test('T-F4.012 the command is refused when the actor lacks the scope, the workspace or the client', async () => {
  const wired = wire()
  // No scope at all: this command appends a project version, writes an
  // EditCommand and emits a public event, and this is the only authorization on
  // that path.
  const unscoped = actor()
  await assert.rejects(
    () => wired.execute(request({ actor: { ...unscoped, scopes: new Set(['projects:read']) } })),
    (error) => error.code === 'AUTH_SCOPE_REQUIRED' && error.details.requiredScope === 'projects:write',
  )
  // A credential authenticated against another workspace cannot direct this
  // one, however well formed the ids in the body are.
  await assert.rejects(
    () => wired.execute(request({ actor: actor({ workspaceId: 'workspace-somebody-else' }) })),
    (error) => error.code === 'AUTH_INVALID' && /workspace or idempotency client/.test(error.message),
  )
  // And the idempotency client has to be the authenticated one, or a retry
  // would be keyed to somebody who never made the request.
  await assert.rejects(
    () => wired.execute(request({ idempotency: { clientId: 'client-someone-else', key: 'idem-direction-1' } })),
    (error) => error.code === 'AUTH_INVALID',
  )
  assert.equal(wired.directions.calls.appendVersion, 0, 'an unauthorized request derives nothing')
  assert.equal(wired.commands.calls.commitOrReplay, 0)
  assert.equal(wired.commands.calls.readContext, 0, 'and never reaches the project')
})

test('T-F4.012 every transition sits on the seam it names, and the call to action moves to the new end', async () => {
  const wired = wire()
  const result = await wired.execute(request())
  const clips = result.editPlan.videoTracks[0].clips
  const byId = new Map(clips.map((clip) => [clip.id, clip]))
  assert.ok(result.editPlan.transitions.length > 0)
  for (const transition of result.editPlan.transitions) {
    const from = byId.get(transition.fromClipId)
    const to = byId.get(transition.toClipId)
    assert.ok(from && to, `${transition.id} names two clips of this plan`)
    // The renderer places the audio fade by this number
    // (`ffmpeg-editorial-proxy-renderer.ts:422-425`), so a transition that sat
    // anywhere but on its own seam would fade at the wrong instant — and the
    // plan validator only COUNTS transitions (`director-run.ts:371`).
    assert.equal(from.timelineOutFrame, transition.atFrame, `${transition.id} starts where ${from.id} ends`)
    assert.equal(to.timelineInFrame, transition.atFrame, `${transition.id} ends where ${to.id} begins`)
  }

  // The CTA keeps its length and is re-anchored to the end of the timeline this
  // direction produced. Keeping the base plan's frame numbers would leave a
  // 90-frame call to action at 27 s of a 279 s cut.
  const base = baseDirectedPlan({ versionId: 'project-version-1' }).overlayTracks[0]
  const overlay = result.editPlan.overlayTracks[0]
  assert.equal(overlay.endFrame, result.editPlan.durationFrames, 'the CTA ends with the timeline')
  assert.equal(
    overlay.endFrame - overlay.startFrame,
    base.endFrame - base.startFrame,
    'and keeps exactly the length it had',
  )
  assert.notEqual(overlay.startFrame, base.startFrame, 'which is a different frame index on a different timeline')
})

test('T-F4.012 omitting the range directs the reference hull, uncovered stretches and all', async () => {
  // The recorder runs to 300 s and the three cameras stop at 200 s, which is the
  // case the request type documents: the hull a request without `range` directs
  // includes instants no camera covered, the direction reports them as
  // `uncovered` with a warning, and the compile step then refuses to turn that
  // into clips.
  const wired = wire({
    world: buildDirectableMulticamWorld({
      workspaceId: WORKSPACE, sessionId: SESSION, projectId: PROJECT, endSecond: 300, cameraEndSecond: 200,
    }),
  })
  await assert.rejects(
    () => wired.execute(request({ range: undefined })),
    (error) => error.code === 'DIRECTION_RANGE_UNRESOLVABLE'
      && Array.isArray(error.details.uncovered)
      && error.details.uncovered.length > 0,
    'the refusal names the stretches that had no eligible angle',
  )
  // The direction itself is stored BEFORE the compile step, because it is the
  // artifact that says WHY the answer was no.
  assert.equal(wired.directions.calls.appendVersion, 1)
  const stored = await wired.directions.readHead({ workspaceId: WORKSPACE, sessionId: SESSION })
  assert.ok(stored.direction.uncovered.length > 0)
  assert.equal(stored.direction.manualReviewRequired, true)
  assert.ok(stored.direction.warnings.length > 0)

  // Naming the range is how an operator says "cut the part we actually filmed",
  // and then the same world compiles.
  const named = await wired.execute(request({
    range: { sessionStartTicks: sec(1).toString(), sessionEndTicks: sec(150).toString() },
    idempotency: { clientId: CLIENT, key: 'idem-named-range' },
  }))
  assert.equal(named.direction.uncovered.length, 0)
  assert.equal(named.direction.range.start, sec(1))
  assert.equal(named.direction.range.end, sec(150))
  console.log(`omitted range uncovered=${stored.direction.uncovered.length} named shots=${named.direction.shots.length}`)
})

test('T-F4.012 a recorder restart puts the second file on the timeline, and the clock map places it', async () => {
  // Camera B starts twelve seconds into the session and the microphone stopped
  // and came back as a second file. Both are what make the clock map
  // load-bearing: linearise `resolveSourceTick` away and camera B's evidence
  // lands twelve seconds early, while the second microphone file is a recording
  // the producer never even asks about unless it walks parts.
  const world = buildDirectableMulticamWorld({
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    projectId: PROJECT,
    endSecond: 300,
    cameraBOffsetSeconds: 12,
    restart: { trackId: 'track-mic-a', assetId: 'asset-mic-a-2', stopSecond: 100, resumeSecond: 130 },
  })
  const asked = []
  const diarization = {
    async listLatestRunsForArtifacts({ sourceArtifactIds }) {
      asked.push(...sourceArtifactIds)
      return [
        {
          runId: 'diarization-mic-a-1', sourceArtifactId: 'asset-mic-a', provider: 'fixture',
          producedAt: '2029-04-01T09:02:00.000Z',
          segments: [
            { segmentId: 'seg-1', ordinal: 0, speakerKey: 'cluster-1', startMs: 1_000, endMs: 60_000 },
            // Runs past the end of the first FILE, which stopped at 100 s: it
            // describes an instant the recorder never produced.
            { segmentId: 'seg-straddle', ordinal: 1, speakerKey: 'cluster-1', startMs: 95_000, endMs: 140_000 },
          ],
        },
        {
          runId: 'diarization-mic-a-2', sourceArtifactId: 'asset-mic-a-2', provider: 'fixture',
          producedAt: '2029-04-01T09:02:00.000Z',
          segments: [{ segmentId: 'seg-2', ordinal: 0, speakerKey: 'cluster-1', startMs: 0, endMs: 40_000 }],
        },
      ].filter((run) => sourceArtifactIds.includes(run.sourceArtifactId))
    },
  }
  // Every camera decodes here, camera B included: the default fake gives camera
  // B no frames, and a track with no observation cannot show where its map put
  // it.
  const visual = {
    async measure({ windows }) {
      return windows.map((window) => ({
        trackId: window.trackId,
        partId: window.partId,
        sourceArtifactId: window.sourceArtifactId,
        sourceStartMs: window.sourceStartMs,
        sourceEndMs: window.sourceEndMs,
        sampledFrameCount: 30,
        activityBps: window.trackId === 'track-screen' ? 103 : null,
        sharpnessBps: null,
        stabilityBps: 9_100,
        exposureBps: 8_800,
        method: 'fixture/signalstats',
        evidenceRef: `media-artifact:${window.sourceArtifactId}:${window.sourceStartMs}-${window.sourceEndMs}`,
      }))
    },
  }
  const wired = wire({ world, diarization, visual })
  const evidence = await wired.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })

  assert.ok(asked.includes('asset-mic-a-2'), 'the second file of the restarted track was asked about at all')
  assert.ok(asked.includes('asset-mic-a'), 'and so was the first')
  const fromSecondFile = evidence.set.observations.filter((observation) => observation.provenance.evidenceRef.includes('diarization-mic-a-2'))
  assert.ok(fromSecondFile.length > 0, "the second file's speech became observations rather than being dropped as unknown")
  assert.ok(
    fromSecondFile.every((observation) => observation.trackId === 'track-mic-a'),
    'on the track that carries it, which is the track its first file identifies',
  )
  // Its milliseconds are relative to ITS file, so 0 ms of the second file is
  // 130 s of the session, not 0 s.
  assert.equal(fromSecondFile[0].range.start, sec(130), 'placed through the part it belongs to, not through the first part')

  // The straddling segment is refused and SAID so: stretching it across the
  // recorder gap would assert speech in a stretch nothing recorded.
  assert.ok(
    evidence.skipped.some((entry) => entry.source.includes('seg-straddle')
      && entry.reason === 'the segment does not map onto one piece of the session clock'),
    'the segment that ran past the end of its file is reported, not stretched',
  )

  // Camera B's map is anchored twelve seconds in, and the map — not a linear
  // conversion — is what places its evidence.
  const cameraB = evidence.set.observations.filter((observation) => observation.trackId === 'track-camera-b')
  assert.ok(cameraB.length > 0, 'camera B was measured')
  assert.equal(
    cameraB[0].range.start,
    sec(12),
    "camera B's first window sits where its clock map puts it, not where its file starts",
  )
  console.log(`restart asked=${new Set(asked).size} secondFile=${fromSecondFile.length} cameraBStart=${cameraB[0].range.start} skipped=${evidence.skipped.length}`)
})

test('T-F4.012 the derived evidence set is pinned: a silent change to what was read changes the hash', async () => {
  const wired = wire()
  const evidence = await wired.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  // Content-addressed and therefore assertable. Both counts and the hash are
  // pinned because the whole set is derived, and a change that adds or removes
  // observations without a test failing is a change nobody reviewed —
  // linearising the clock map away, for one, silently added three.
  assert.equal(evidence.set.observations.length, 15, 'the exact observations this world produces')
  assert.equal(evidence.skipped.length, 7, 'and the exact number of reads that produced none')
  assert.equal(evidence.set.evidenceHash, PINNED_EVIDENCE_HASH)
  assert.ok(
    evidence.skipped.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0),
    'every one of them says why',
  )
})

test('T-F4.012 persisted perception becomes reaction evidence, and a project with none gets no zeros', async () => {
  const timeline = {
    sourceArtifactId: 'asset-cam-b',
    timelineId: 'perception-timeline-1',
    producedAt: '2029-04-01T09:03:00.000Z',
    method: 'fixture/perception',
    entries: [
      { entryId: 'entry-1', startMs: 10_000, endMs: 40_000, intensityBps: 7_200, confidence: 0.8 },
      { entryId: 'entry-2', startMs: 40_000, endMs: 70_000, intensityBps: 1_100, confidence: 0.8 },
    ],
  }
  const withPerception = wire({
    perception: {
      async listReactionIntensities({ sourceArtifactIds }) {
        return sourceArtifactIds.includes(timeline.sourceArtifactId) ? [timeline] : []
      },
    },
  })
  const seen = await withPerception.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  const reactions = seen.set.observations.filter((observation) => observation.kind === 'reaction')
  assert.equal(reactions.length, 2, "both entries became observations — the floor is the direction's business, not the producer's")
  assert.ok(reactions.every((observation) => observation.trackId === 'track-camera-b'))
  assert.deepEqual(reactions.map((observation) => observation.value.intensityBps).sort((left, right) => left - right), [1_100, 7_200])
  assert.ok(reactions.every((observation) => observation.provenance.method === 'fixture/perception'))

  // A project nobody has run perception over produces no reaction observations
  // at all, which is the truth. A stub returning intensity zero would instead
  // assert "measured, and there was no reaction".
  const without = wire()
  const none = await without.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  assert.equal(none.set.observations.filter((observation) => observation.kind === 'reaction').length, 0)
  assert.notEqual(seen.set.evidenceHash, none.set.evidenceHash)
})
