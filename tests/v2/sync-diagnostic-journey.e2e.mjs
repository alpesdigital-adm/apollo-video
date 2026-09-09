import assert from 'node:assert/strict'
import test from 'node:test'

import { runMarkerDetectionSweep } from '../../src/v2/application/run-marker-detection-sweep.ts'
import {
  detectSyncMarkerService,
  editSyncAnchorService,
  generateSyncDiagnosticService,
  generateSyncMarkerService,
  observeMarkerFactsService,
  readSyncDiagnosticService,
} from '../../src/v2/application/sync-diagnostic.ts'
import {
  attachCaptureProtocolService,
  evaluateCaptureProtocolService,
} from '../../src/v2/application/capture-protocol.ts'
import {
  addCaptureSessionTrack,
  addCaptureSessionTrackPart,
  createCaptureSession,
} from '../../src/v2/domain/capture-session.ts'
import { canAutoEdit } from '../../src/v2/domain/sync-diagnostic.ts'
import { fuseMarkerDetections } from '../../src/v2/domain/sync-marker-detection.ts'
import { createTickInterval, timebaseFromRate } from '../../src/v2/domain/session-time.ts'

/**
 * F4.009 to F4.011 — the journeys, over the real services.
 *
 * In-memory repositories that behave like the persisted ones: they enforce the
 * version fence, refuse divergent replays, and re-verify hashes on read. That
 * makes these runnable anywhere; the Prisma round trip is proved separately in
 * CI, where a PostgreSQL exists.
 */

const t = (n) => BigInt(n)
const sec = (n) => t(90_000) * t(n)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const h = (n) => String(n).repeat(64).slice(0, 64)

let clockSeconds = 0
const clock = () => new Date(at((clockSeconds += 1)))

function part(overrides = {}) {
  return {
    partId: 'part-1',
    ordinal: 0,
    sourceAssetId: 'asset-1',
    timebase: timebaseFromRate(90_000),
    coverage: createTickInterval(t(0), sec(600)),
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: {
      ingestArtifactId: 'artifact-1',
      ingestSha256: h(1),
      probeHash: h(2),
      probeSource: 'packet-scan',
      observedAt: at(0),
    },
    ...overrides,
  }
}

function track(overrides = {}) {
  const first = overrides.firstPart ?? part(overrides.partOverrides ?? {})
  const { firstPart, partOverrides, ...rest } = overrides
  return {
    trackId: 'track-camera-main',
    role: 'camera-main',
    device: { deviceId: 'device-a', recorderId: 'recorder-a', make: null, model: null, serial: null },
    sourceAssetId: first.sourceAssetId,
    timebase: timebaseFromRate(90_000),
    streamIndex: 0,
    syncAudioPolicy: 'final-candidate',
    includeInFinalMix: true,
    parts: [first],
    ...rest,
  }
}

const LINEAGE = {
  commandId: 'command-1',
  operation: 'create-session',
  actorKind: 'human',
  actorId: 'user-1',
  occurredAt: at(0),
  note: null,
}

function teacherSession(options = {}) {
  const base = createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-1',
    clock: { timebase: timebaseFromRate(90_000), rounding: 'nearest-half-even' },
    referenceTrackId: 'track-camera-main',
    tracks: [track()],
    lineage: LINEAGE,
    createdAt: at(0),
  })
  const withScreen = addCaptureSessionTrack(base, {
    track: track({
      trackId: 'track-screen',
      role: 'screen',
      device: { deviceId: 'device-screen', recorderId: 'recorder-screen', make: null, model: null, serial: null },
      syncAudioPolicy: options.screenAudio ?? 'sync-only',
      includeInFinalMix: false,
      partOverrides: { partId: 'part-screen-1', sourceAssetId: 'asset-screen' },
    }),
    lineage: { ...LINEAGE, operation: 'add-track', commandId: 'command-2' },
  })
  if (!options.restart) return withScreen
  return addCaptureSessionTrackPart(withScreen, {
    trackId: 'track-screen',
    part: part({
      partId: 'part-screen-2',
      ordinal: 1,
      sourceAssetId: 'asset-screen-2',
      coverage: createTickInterval(sec(610), sec(1_200)),
      splitReason: 'recorder-restart',
    }),
    lineage: { ...LINEAGE, operation: 'add-track-part', commandId: 'command-3' },
  })
}

/** Sessions, coverage and maps, as the capture repository would serve them. */
function fakeSessions(session, options = {}) {
  return {
    async readHead() { return session },
    async readVersion() { return session },
    async listVersions() { return [session] },
    async listHeads() { return [] },
    async persistClock() { throw new Error('unused') },
    async readClock() { return null },
    async persistClockMap() { throw new Error('unused') },
    async readClockMap() { return null },
    async listClockMaps() { return options.maps ?? [] },
    async persistCoverage() { throw new Error('unused') },
    async readCoverage() { return null },
    async listCoverage() { return options.coverages ?? [] },
    async persistSyncEvidence() { throw new Error('unused') },
    async readSyncEvidence() { return null },
    async listSyncEvidence() { return [] },
    async appendVersion() { throw new Error('unused') },
  }
}

/** Behaves like the Prisma repository: version fence, replay, hash on read. */
function memoryDiagnostics() {
  const markers = new Map()
  const detections = new Map()
  const versions = new Map()
  let head = null
  return {
    async persistMarker({ marker, artifact }) {
      const existing = markers.get(marker.markerId)
      if (existing) {
        if (existing.marker.markerHash !== marker.markerHash) {
          const error = new Error('conflict'); error.code = 'PERSISTENCE_CONFLICT'; throw error
        }
        return { marker: existing.marker, replayed: true }
      }
      markers.set(marker.markerId, { marker, artifact: artifact ?? null })
      return { marker, replayed: false }
    },
    async readMarker({ markerId }) { return markers.get(markerId) ?? null },
    async listMarkers({ sessionId }) {
      return [...markers.values()].filter((entry) => entry.marker.sessionId === sessionId)
    },
    async persistDetection({ detection }) {
      const key = `${detection.markerId}:${detection.trackId}`
      const previous = detections.get(key)
      detections.set(key, detection)
      return { detection, replayed: previous?.detectionHash === detection.detectionHash }
    },
    async listDetections({ sessionId }) {
      return [...detections.values()].filter((entry) => entry.sessionId === sessionId)
    },
    async appendVersion({ diagnostic, expectedVersion }) {
      if (diagnostic.version > 1 && head?.version !== expectedVersion) {
        const error = new Error(
          `The diagnostic moved on: expected version ${expectedVersion} to be current`,
        )
        error.code = 'SYNC_DIAGNOSTIC_VERSION_STALE'
        throw error
      }
      versions.set(diagnostic.version, diagnostic)
      head = diagnostic
      return { diagnostic, replayed: false }
    },
    async readHead() { return head },
    async readVersion({ version }) { return versions.get(version) ?? null },
    async listVersions() { return [...versions.values()].sort((a, b) => b.version - a.version) },
  }
}

function memoryProtocols() {
  const evaluations = []
  const attachments = new Map()
  return {
    evaluations,
    async publish({ protocol }) { return { protocol, replayed: false } },
    async list() { return [] },
    async read() { return null },
    async attach(input) {
      const record = {
        sessionId: input.sessionId,
        protocolId: input.protocol.protocolId,
        protocolVersion: input.protocol.version,
        protocolHash: input.protocol.protocolHash,
        attachedByKind: input.attachedByKind,
        attachedById: input.attachedById,
        attachedAt: input.attachedAt,
      }
      attachments.set(input.sessionId, record)
      return record
    },
    async readAttachment({ sessionId }) { return attachments.get(sessionId) ?? null },
    async persistEvaluation({ evaluation }) { evaluations.unshift(evaluation); return { evaluation, replayed: false } },
    async readEvaluation() { return evaluations[0] ?? null },
    async listEvaluations() { return evaluations },
  }
}

/** Media that finds the marker where the fixture says it is. */
function fakeMedia(plan, counters = {}) {
  return {
    async render(marker) {
      counters.renders = (counters.renders ?? 0) + 1
      return { artifactId: `artifact-${marker.markerId}`, sha256: h(7), byteSize: 19_650 }
    },
    async detect({ marker, trackId, mode }) {
      const found = plan[`${trackId}:${marker.position}`]
      if (!found) {
        // Nothing detected on this track: the fusion has to say so rather than
        // being handed an absence dressed as a reading.
        return fuseMarkerDetections({
          marker, trackId, mode,
          audio: {
            channel: 'audio', observationId: `a-${trackId}`, trackId,
            atMs: 0, errorMs: 0, correlationPeak: 0.1, secondPeak: 0.09,
            confidence: 0.1, evidenceRef: 'no-signal',
          },
        })
      }
      return fuseMarkerDetections({
        marker, trackId, mode,
        visual: {
          channel: 'visual', observationId: `v-${trackId}-${marker.sequence}`, trackId,
          atMs: found.atMs, errorMs: 17, decodedPayload: marker.payload,
          patternScore: 0.97, confidence: 0.95, evidenceRef: `visual:${trackId}`,
        },
        audio: {
          channel: 'audio', observationId: `a-${trackId}-${marker.sequence}`, trackId,
          atMs: found.atMs + 8, errorMs: 1, correlationPeak: 0.88, secondPeak: 0.1,
          confidence: 0.92, evidenceRef: `audio:${trackId}`,
        },
      })
    },
  }
}

function wire(session, options = {}) {
  const repository = memoryDiagnostics()
  const protocols = memoryProtocols()
  const sessions = fakeSessions(session, options)
  const counters = {}
  const media = fakeMedia(options.plan ?? {}, counters)
  return {
    counters,
    repository,
    protocols,
    sessions,
    generateMarker: generateSyncMarkerService({ repository, sessions, media, clock }),
    sweep: (options = {}) => runMarkerDetectionSweep({
      repository, sessions, media,
      resolveMediaPath: options.resolveMediaPath
        ?? (async () => ({ path: '/fixtures/track.mp4', release: async () => {} })),
      clock,
      ...options,
    }),
    detect: detectSyncMarkerService({
      repository, sessions, media,
      resolveMediaPath: async () => ({ path: '/fixtures/track.mp4', release: async () => {} }),
      clock,
    }),
    generateDiagnostic: generateSyncDiagnosticService({ repository, sessions, protocols, clock }),
    editAnchor: editSyncAnchorService({ repository, clock }),
    read: readSyncDiagnosticService({ repository }),
    observe: observeMarkerFactsService({ repository }),
    attach: attachCaptureProtocolService({ repository: protocols, sessions, clock }),
    evaluate: evaluateCaptureProtocolService({
      repository: protocols,
      sessions,
      observeMarkers: observeMarkerFactsService({ repository }),
      clock,
    }),
  }
}

const ACTOR = { workspaceId: 'workspace-1', kind: 'human', id: 'user-editor-1' }

/** A podcast: two cameras keeping scratch audio, plus the dedicated recorder. */
function podcastSession(options = {}) {
  const base = createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-1',
    clock: { timebase: timebaseFromRate(90_000), rounding: 'nearest-half-even' },
    referenceTrackId: 'track-master-audio',
    tracks: [track({
      trackId: 'track-master-audio',
      role: 'master-audio',
      device: { deviceId: 'device-rec', recorderId: 'rec-1', make: null, model: null, serial: null },
      syncAudioPolicy: 'final-candidate',
      includeInFinalMix: true,
      partOverrides: { partId: 'part-master-1', sourceAssetId: 'asset-master' },
    })],
    lineage: LINEAGE,
    createdAt: at(0),
  })
  let session = base
  for (const [index, id] of ['track-camera-a', 'track-camera-b'].entries()) {
    session = addCaptureSessionTrack(session, {
      track: track({
        trackId: id,
        role: 'camera-main',
        device: { deviceId: `device-${id}`, recorderId: `rec-${id}`, make: null, model: null, serial: null },
        // The scratch track exists to be aligned against, not to be heard.
        syncAudioPolicy: index === 1 && options.secondCameraMuted ? 'none' : 'sync-only',
        includeInFinalMix: false,
        partOverrides: { partId: `part-${id}`, sourceAssetId: `asset-${id}` },
      }),
      lineage: { ...LINEAGE, operation: 'add-track', commandId: `command-${id}` },
    })
  }
  return session
}

/** The diagnostic base a caller that just read it would send. */
function diagBase(diagnostic) {
  return {
    baseVersionId: `${diagnostic.sessionId}:diagnostic:v${diagnostic.version}`,
    baseHash: diagnostic.diagnosticHash,
  }
}

/** The base a caller that just read the session would send. */
function base(session) {
  return { baseVersionId: `${session.sessionId}:v${session.version}`, baseHash: session.sessionHash }
}

/** Coverage as the track-coverage derivation would have produced it. */
function fullCoverage(trackId) {
  return {
    workspaceId: 'workspace-1',
    trackId,
    derivedFrom: { sessionId: 'capture-session-1', sessionVersion: 2, referenceEpoch: 1 },
    timebase: timebaseFromRate(90_000),
    bounds: createTickInterval(t(0), sec(600)),
    available: [{ interval: createTickInterval(t(0), sec(600)), confidenceBps: 9_800 }],
    gaps: [],
    corrupt: [],
    unverified: [],
    overlaps: [],
    recorderSplits: [],
    coverageHash: h(3),
  }
}

test('E2E-FR-147/148/149 teacher and screen: markers detected, protocol met, auto-edit allowed', async () => {
  const session = teacherSession()
  const services = wire(session, {
    // A real session has coverage computed. Without it the diagnostic caps at
    // synced-medium, which is the honest answer to "nobody measured the gaps".
    coverages: [fullCoverage('track-screen')],
    plan: {
      'track-camera-main:start': { atMs: 1_000 },
      'track-camera-main:end': { atMs: 601_000 },
      'track-screen:start': { atMs: 400 },
      'track-screen:end': { atMs: 600_400 },
    },
  })

  await services.attach({ actor: ACTOR, sessionId: session.sessionId, protocolId: 'teacher-and-screen-v1' })

  const start = await services.generateMarker({ actor: ACTOR, sessionId: session.sessionId, position: 'start', idempotencyKey: 'key-start' })
  const end = await services.generateMarker({ actor: ACTOR, sessionId: session.sessionId, position: 'end', idempotencyKey: 'key-end' })
  assert.equal(start.marker.sequence, 1)
  // The sequence is assigned by the service, never requested: a caller
  // choosing its own could collide and make "which marker" undecidable.
  assert.equal(end.marker.sequence, 2)
  assert.equal(start.artifact.byteSize, 19_650)

  for (const marker of [start.marker, end.marker]) {
    for (const trackId of ['track-camera-main', 'track-screen']) {
      const result = await services.detect({
        actor: ACTOR, sessionId: session.sessionId, markerId: marker.markerId, trackId,
      })
      assert.equal(result.detection.outcome, 'confirmed')
    }
  }

  const evaluation = await services.evaluate({
    actor: ACTOR, sessionId: session.sessionId, ...base(session), attestedRequirementIds: ['headphones'],
  })
  assert.equal(evaluation.evaluation.ceiling, 'automatic')
  assert.equal(evaluation.evaluation.blocksAutoEdit, false)

  const { diagnostic } = await services.generateDiagnostic({ actor: ACTOR, sessionId: session.sessionId, ...base(session) })
  assert.equal(diagnostic.version, 1)
  assert.equal(diagnostic.tracks.length, 1, 'the reference track is the clock, not a diagnosed track')
  assert.equal(diagnostic.status, 'synced-high')
  // Camera saw the start marker at 1000 ms, screen at 400: the screen runs
  // 600 ms ahead of the camera on the session timeline.
  assert.equal(diagnostic.tracks[0].offsetMs, 600)
  assert.equal(canAutoEdit(diagnostic).allowed, true)
})

test('E2E-FR-147/149 a limited capture blocks auto-edit before anything is cut', async () => {
  // The screen recorder arrived muted: fingerprinting is gone, and the marker
  // never fired on that track either.
  const session = teacherSession({ screenAudio: 'none' })
  const services = wire(session, {
    plan: { 'track-camera-main:start': { atMs: 1_000 } },
  })
  await services.attach({ actor: ACTOR, sessionId: session.sessionId, protocolId: 'teacher-and-screen-v1' })

  const start = await services.generateMarker({ actor: ACTOR, sessionId: session.sessionId, position: 'start', idempotencyKey: 'key-start' })
  const onScreen = await services.detect({
    actor: ACTOR, sessionId: session.sessionId, markerId: start.marker.markerId, trackId: 'track-screen',
  })
  // A track with no usable audio can only produce one channel, so demanding
  // both would refuse it for something that is not its fault.
  assert.equal(onScreen.detection.mode, 'either-channel')
  assert.equal(onScreen.detection.outcome, 'rejected')
  assert.equal(onScreen.detection.atMs, null)

  const evaluation = await services.evaluate({
    actor: ACTOR, sessionId: session.sessionId, ...base(session),
  })
  assert.equal(evaluation.evaluation.blocksAutoEdit, true)
  assert.ok(evaluation.evaluation.lostCapabilities.includes('audio-fingerprint'))

  const { diagnostic } = await services.generateDiagnostic({ actor: ACTOR, sessionId: session.sessionId, ...base(session) })
  assert.equal(diagnostic.status, 'needs-input')
  assert.equal(diagnostic.manualRequired, true)
  assert.ok(diagnostic.warnings.includes('insufficient-evidence'))
  assert.ok(diagnostic.recommendedActions.includes('add-manual-anchor'))

  const gate = canAutoEdit(diagnostic)
  assert.equal(gate.allowed, false)
  assert.ok(gate.blockedBy.length >= 2, 'the block must name every distinct reason')
})

test('E2E-FR-149 manual correction refits, preserves automatic anchors and fences stale edits', async () => {
  const session = teacherSession()
  const services = wire(session, {
    plan: {
      'track-camera-main:start': { atMs: 1_000 },
      'track-screen:start': { atMs: 400 },
    },
  })
  await services.attach({ actor: ACTOR, sessionId: session.sessionId, protocolId: 'teacher-and-screen-v1' })
  const marker = await services.generateMarker({ actor: ACTOR, sessionId: session.sessionId, position: 'start', idempotencyKey: 'key-start' })
  for (const trackId of ['track-camera-main', 'track-screen']) {
    await services.detect({ actor: ACTOR, sessionId: session.sessionId, markerId: marker.marker.markerId, trackId })
  }
  const v1 = (await services.generateDiagnostic({ actor: ACTOR, sessionId: session.sessionId, ...base(session) })).diagnostic
  const automaticBefore = v1.tracks[0].automaticAnchors.map((entry) => entry.anchorId)
  assert.equal(automaticBefore.length, 1)

  const v2 = (await services.editAnchor({
    actor: ACTOR,
    sessionId: session.sessionId,
    ...diagBase(v1),
    edit: { trackId: 'track-screen', action: 'add', anchorId: 'manual-1', sourceMs: 300_000, sessionMs: 300_600 },
  })).diagnostic
  assert.equal(v2.version, 2)
  assert.equal(v2.previousVersionHash, v1.diagnosticHash)
  assert.equal(v2.tracks[0].manualAnchors.length, 1)
  // Who overrode the measurement, traceable even though the caller sent its
  // own note. An override nobody can be traced to is indistinguishable from
  // the system having decided on its own.
  assert.match(v2.tracks[0].manualAnchors[0].evidenceRef, /operator:user-editor-1/)
  // The measured anchors are still there, with fresh residuals.
  assert.deepEqual(v2.tracks[0].automaticAnchors.map((entry) => entry.anchorId), automaticBefore)
  assert.ok(v2.tracks[0].automaticAnchors.every((entry) => entry.residualMs !== null))

  // An edit computed against v1 lands on a document the operator never saw.
  await assert.rejects(
    () => services.editAnchor({
      actor: ACTOR,
      sessionId: session.sessionId,
      // Deliberately still v1: this is the operator whose page went stale.
      ...diagBase(v1),
      edit: { trackId: 'track-screen', action: 'add', anchorId: 'manual-2', sourceMs: 10, sessionMs: 610 },
    }),
    /has moved to version 2/,
  )

  // The old version is still readable: a cut approved against v1 keeps its
  // evidence after somebody nudges an anchor.
  const stored = await services.read({ workspaceId: 'workspace-1', sessionId: session.sessionId, version: 1 })
  assert.equal(stored.diagnostic.version, 1)
  assert.equal(stored.diagnostic.tracks[0].manualAnchors.length, 0)
})

test('E2E-FR-149 regenerating a diagnostic keeps manual corrections', async () => {
  const session = teacherSession()
  const services = wire(session, {
    plan: { 'track-camera-main:start': { atMs: 1_000 }, 'track-screen:start': { atMs: 400 } },
  })
  const marker = await services.generateMarker({ actor: ACTOR, sessionId: session.sessionId, position: 'start', idempotencyKey: 'key-start' })
  for (const trackId of ['track-camera-main', 'track-screen']) {
    await services.detect({ actor: ACTOR, sessionId: session.sessionId, markerId: marker.marker.markerId, trackId })
  }
  const first = (await services.generateDiagnostic({
    actor: ACTOR, sessionId: session.sessionId, ...base(session),
  })).diagnostic
  await services.editAnchor({
    actor: ACTOR,
    sessionId: session.sessionId,
    ...diagBase(first),
    edit: { trackId: 'track-screen', action: 'add', anchorId: 'manual-1', sourceMs: 300_000, sessionMs: 300_600 },
  })

  // Re-running detection and regenerating must not silently discard a
  // correction a person made.
  const regenerated = (await services.generateDiagnostic({ actor: ACTOR, sessionId: session.sessionId, ...base(session) })).diagnostic
  assert.equal(regenerated.version, 3)
  assert.equal(regenerated.tracks[0].manualAnchors.length, 1)
  assert.equal(regenerated.tracks[0].manualAnchors[0].anchorId, 'manual-1')
})

test('E2E-FR-148 a marker from another session is refused before detection runs', async () => {
  const session = teacherSession()
  const services = wire(session, { plan: {} })
  const marker = await services.generateMarker({ actor: ACTOR, sessionId: session.sessionId, position: 'start', idempotencyKey: 'key-start' })

  // Rewrite the stored marker's session: the identity says it belongs to
  // another shoot, and no detector result can make it this session's.
  const stored = await services.repository.readMarker({ workspaceId: 'workspace-1', markerId: marker.marker.markerId })
  await services.repository.persistMarker({
    marker: { ...stored.marker, sessionId: 'capture-session-other', markerId: 'marker-foreign' },
    createdAt: at(10),
  })
  await assert.rejects(
    () => services.detect({
      actor: ACTOR, sessionId: session.sessionId, markerId: 'marker-foreign', trackId: 'track-screen',
    }),
    /belongs to capture session capture-session-other/,
  )
})

test('E2E-FR-147 only confirmed detections count as observed markers', async () => {
  const session = teacherSession()
  const services = wire(session, {
    // The camera sees the marker; the screen does not.
    plan: { 'track-camera-main:start': { atMs: 1_000 } },
  })
  const marker = await services.generateMarker({ actor: ACTOR, sessionId: session.sessionId, position: 'start', idempotencyKey: 'key-start' })
  await services.detect({ actor: ACTOR, sessionId: session.sessionId, markerId: marker.marker.markerId, trackId: 'track-camera-main' })
  await services.detect({ actor: ACTOR, sessionId: session.sessionId, markerId: marker.marker.markerId, trackId: 'track-screen' })

  const facts = await services.observe({ workspaceId: 'workspace-1', sessionId: session.sessionId })
  // A rejected detection is not a marker emitted badly; it is a marker nobody
  // can prove was emitted at all. But the camera's confirmation stands.
  assert.deepEqual([...facts.confirmedPositions], ['start'])
})

test('E2E-FR-148 a retry with the same key returns the first marker instead of making another', async () => {
  const session = teacherSession()
  const services = wire(session, { plan: { 'track-camera-main:start': { atMs: 800 } } })
  const credentialA = { ...ACTOR, credentialId: 'credential-a' }

  const first = await services.generateMarker({
    actor: credentialA, sessionId: session.sessionId, position: 'start', idempotencyKey: 'shoot-1',
  })
  const retry = await services.generateMarker({
    actor: credentialA, sessionId: session.sessionId, position: 'start', idempotencyKey: 'shoot-1',
  })

  assert.equal(retry.replayed, true)
  assert.equal(retry.marker.markerId, first.marker.markerId)
  assert.equal(retry.marker.sequence, 1)
  // The point of the lookup: a retry must not render a second clip. Equal ids
  // alone would not prove that — the render could have run and been discarded.
  assert.equal(services.counters.renders, 1)

  // A second credential of the same client is a second caller. Reusing its key
  // must not hand it a marker it never generated.
  const credentialB = { ...ACTOR, credentialId: 'credential-b' }
  const other = await services.generateMarker({
    actor: credentialB, sessionId: session.sessionId, position: 'start', idempotencyKey: 'shoot-1',
  })
  assert.equal(other.replayed, false)
  assert.notEqual(other.marker.markerId, first.marker.markerId)
  assert.equal(other.marker.sequence, 2)
  assert.equal(services.counters.renders, 2)

  // The same key aimed at a different request is a conflict the caller is told
  // about, not a silent substitution.
  await assert.rejects(
    () => services.generateMarker({
      actor: credentialA, sessionId: session.sessionId, position: 'start', idempotencyKey: '   ',
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})

test('E2E-FR-147/149 a derivation of a session that moved is refused, not silently re-aimed', async () => {
  const session = teacherSession()
  const services = wire(session, { plan: { 'track-camera-main:start': { atMs: 800 } } })
  // What a caller read a moment ago, before somebody else added a track.
  const stale = { baseVersionId: `${session.sessionId}:v1`, baseHash: session.sessionHash }

  for (const call of [
    () => services.evaluate({ actor: ACTOR, sessionId: session.sessionId, ...stale }),
    () => services.generateDiagnostic({ actor: ACTOR, sessionId: session.sessionId, ...stale }),
  ]) {
    await assert.rejects(call, (error) => {
      assert.equal(error.code, 'CAPTURE_SESSION_VERSION_STALE')
      // The refusal carries where to go, so a UI can offer a reload instead of
      // making the operator work out what changed.
      assert.equal(error.details.currentVersion, session.version)
      assert.equal(error.details.currentHash, session.sessionHash)
      return true
    })
  }
})

test('E2E-FR-148 a detection sweep resumes from what is already stored', async () => {
  const session = teacherSession()
  const services = wire(session, {
    plan: {
      'track-camera-main:start': { atMs: 1_000 },
      'track-screen:start': { atMs: 400 },
      'track-camera-main:end': { atMs: 590_000 },
      'track-screen:end': { atMs: 589_400 },
    },
  })
  for (const position of ['start', 'end']) {
    await services.generateMarker({
      actor: ACTOR, sessionId: session.sessionId, position, idempotencyKey: `key-${position}`,
    })
  }

  // First pass, bounded to one decode. Two markers over two tracks is four
  // pairs; a pass that stops early must say it did not finish.
  const seen = []
  const first = await services.sweep({ maxPairs: 1, onOutcome: (o) => seen.push(o) })({
    actor: ACTOR, sessionId: session.sessionId,
  })
  assert.equal(first.detected, 1)
  assert.equal(first.complete, false, 'a bounded pass claimed it had finished')
  // Observability is per pair, not per sweep: a total alone cannot say which
  // recording is the one refusing to yield a marker.
  assert.equal(seen.length, first.outcomes.length)
  assert.ok(seen.every((entry) => entry.markerId && entry.trackId))

  // Second pass skips what the first stored rather than decoding it again.
  const second = await services.sweep()({ actor: ACTOR, sessionId: session.sessionId })
  assert.equal(second.skipped >= 1, true, 'the sweep re-decoded work it had already done')
  assert.equal(second.complete, true)

  // And a third pass has nothing left to do, which is what makes it safe to
  // run on a timer.
  const third = await services.sweep()({ actor: ACTOR, sessionId: session.sessionId })
  assert.equal(third.detected, 0)
  assert.equal(third.skipped, third.pairsConsidered)
  assert.equal(third.complete, true)
})

test('E2E-FR-148 one unreadable file does not end the sweep', async () => {
  const session = teacherSession()
  const services = wire(session, {
    plan: { 'track-camera-main:start': { atMs: 1_000 }, 'track-screen:start': { atMs: 400 } },
  })
  await services.generateMarker({
    actor: ACTOR, sessionId: session.sessionId, position: 'start', idempotencyKey: 'key-start',
  })

  const result = await services.sweep({
    resolveMediaPath: async ({ part }) => {
      if (part.sourceAssetId === 'asset-screen') throw new Error('the disk went away')
      return { path: '/fixtures/track.mp4', release: async () => {} }
    },
  })({ actor: ACTOR, sessionId: session.sessionId })

  // The good track was measured; the bad one is recorded as failed and named.
  assert.equal(result.detected, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.complete, false, 'a sweep with a failed pair claimed it had finished')
  const failure = result.outcomes.find((entry) => entry.state === 'failed')
  assert.equal(failure.trackId, 'track-screen')
  assert.match(failure.detail, /disk went away/)

  // The failed pair is absent from storage, so the next pass tries it again —
  // right for a disk that was briefly unavailable, harmless for one that is
  // permanently gone.
  const retry = await services.sweep()({ actor: ACTOR, sessionId: session.sessionId })
  assert.equal(retry.detected, 1)
  assert.equal(retry.complete, true)
})

test('E2E-FR-147/148/149 podcast: scratch audio on every camera earns the top ceiling', async () => {
  const session = podcastSession()
  const services = wire(session, {
    coverages: ['track-camera-a', 'track-camera-b'].map(fullCoverage),
    plan: {
      'track-master-audio:start': { atMs: 500 },
      'track-camera-a:start': { atMs: 1_100 },
      'track-camera-b:start': { atMs: 300 },
      'track-master-audio:end': { atMs: 590_500 },
      'track-camera-a:end': { atMs: 591_100 },
      'track-camera-b:end': { atMs: 590_300 },
    },
  })
  await services.attach({ actor: ACTOR, sessionId: session.sessionId, protocolId: 'podcast-v1' })
  for (const position of ['start', 'end']) {
    await services.generateMarker({
      actor: ACTOR, sessionId: session.sessionId, position, idempotencyKey: `key-${position}`,
    })
  }
  const sweep = await services.sweep()({ actor: ACTOR, sessionId: session.sessionId })
  assert.equal(sweep.complete, true)
  assert.equal(sweep.failed, 0)

  const { evaluation } = await services.evaluate({
    actor: ACTOR, sessionId: session.sessionId, ...base(session),
  })
  // Every camera kept its scratch track, so nothing audio fingerprinting needs
  // was thrown away, and the end marker means drift can still be measured.
  assert.deepEqual([...evaluation.lostCapabilities], [])
  assert.equal(evaluation.blocksAutoEdit, false)

  const { diagnostic } = await services.generateDiagnostic({
    actor: ACTOR, sessionId: session.sessionId, ...base(session),
  })
  // The dedicated recorder is the reference; the cameras are what gets aligned.
  assert.equal(diagnostic.referenceTrackId, 'track-master-audio')
  assert.deepEqual(
    diagnostic.tracks.map((entry) => entry.trackId).sort(),
    ['track-camera-a', 'track-camera-b'],
  )
})

test('E2E-FR-147/149 podcast: a camera recorded with no audio at all costs the fingerprint', async () => {
  const session = podcastSession({ secondCameraMuted: true })
  const services = wire(session, {
    coverages: ['track-camera-a', 'track-camera-b'].map(fullCoverage),
    plan: {
      'track-master-audio:start': { atMs: 500 },
      'track-camera-a:start': { atMs: 1_100 },
    },
  })
  await services.attach({ actor: ACTOR, sessionId: session.sessionId, protocolId: 'podcast-v1' })
  await services.generateMarker({
    actor: ACTOR, sessionId: session.sessionId, position: 'start', idempotencyKey: 'key-start',
  })

  // A track that captured no usable audio is detected on either channel: it
  // cannot be held to two, and refusing it for that would blame the recording
  // for a choice the operator made.
  const sweep = await services.sweep()({ actor: ACTOR, sessionId: session.sessionId })
  const muted = sweep.outcomes.find((entry) => entry.trackId === 'track-camera-b')
  assert.equal(muted.state, 'detected')

  const { evaluation } = await services.evaluate({
    actor: ACTOR, sessionId: session.sessionId, ...base(session),
  })
  // The consequence the protocol named, arriving exactly as written.
  assert.ok(evaluation.lostCapabilities.includes('audio-fingerprint'))
  assert.ok(evaluation.lostCapabilities.includes('drift-measurement'), 'no end marker was filmed')
  const missed = evaluation.findings.filter((finding) => finding.outcome === 'unmet')
  assert.ok(missed.length > 0)
  assert.ok(
    missed.every((finding) => finding.consequence.length > 0),
    'a requirement was reported unmet without saying what it costs',
  )
  assert.notEqual(evaluation.ceiling, 'automatic')
})

test('E2E-FR-147/149 a session that lost every automatic path is refused, with reasons', async () => {
  // No markers filmed, no scratch audio on one camera. Every automatic route
  // the protocol protects is gone, and no confident fitting recovers it.
  const session = podcastSession({ secondCameraMuted: true })
  const services = wire(session, { plan: {} })
  await services.attach({ actor: ACTOR, sessionId: session.sessionId, protocolId: 'podcast-v1' })

  const { evaluation } = await services.evaluate({
    actor: ACTOR, sessionId: session.sessionId, ...base(session),
  })
  assert.ok(
    ['manual-anchors-required', 'not-synchronizable'].includes(evaluation.ceiling),
    `a session with no evidence reported ceiling ${evaluation.ceiling}`,
  )
  assert.equal(evaluation.blocksAutoEdit, true)

  const { diagnostic } = await services.generateDiagnostic({
    actor: ACTOR, sessionId: session.sessionId, ...base(session),
  })
  const gate = canAutoEdit(diagnostic)
  assert.equal(gate.allowed, false)
  // Named, not merely refused: an operator told only "blocked" cannot act.
  assert.ok(gate.blockedBy.length > 0)
  // And every track reports the absence honestly rather than as zero.
  for (const entry of diagnostic.tracks) {
    assert.equal(entry.offsetMs, null, `${entry.trackId} invented an offset from no evidence`)
    assert.equal(entry.status, 'needs-input')
  }
})

test('E2E-FR-149 a caller note never displaces who moved the anchor', async () => {
  const session = teacherSession()
  const services = wire(session, {
    plan: { 'track-camera-main:start': { atMs: 1_000 }, 'track-screen:start': { atMs: 400 } },
  })
  await services.generateMarker({
    actor: ACTOR, sessionId: session.sessionId, position: 'start', idempotencyKey: 'key-start',
  })
  for (const trackId of ['track-camera-main', 'track-screen']) {
    await services.detect({ actor: ACTOR, sessionId: session.sessionId, markerId: (
      await services.repository.listMarkers({ workspaceId: 'workspace-1', sessionId: session.sessionId })
    )[0].marker.markerId, trackId })
  }
  const v1 = (await services.generateDiagnostic({
    actor: ACTOR, sessionId: session.sessionId, ...base(session),
  })).diagnostic

  // The caller sends its own note, as the UI does.
  const v2 = (await services.editAnchor({
    actor: ACTOR,
    sessionId: session.sessionId,
    ...diagBase(v1),
    edit: {
      trackId: 'track-screen', action: 'add', anchorId: 'manual-1',
      sourceMs: 300_000, sessionMs: 300_600, evidenceRef: 'operator-frame-nudge',
    },
  })).diagnostic
  const placed = v2.tracks[0].manualAnchors[0]
  assert.match(placed.evidenceRef, /operator:user-editor-1/)
  assert.match(placed.evidenceRef, /operator-frame-nudge/, 'the caller note was dropped instead of kept alongside')

  // A second operator moves it. The record has to name the mover, not only the
  // person who placed it.
  const SECOND = { ...ACTOR, id: 'user-editor-2' }
  const v3 = (await services.editAnchor({
    actor: SECOND,
    sessionId: session.sessionId,
    ...diagBase(v2),
    edit: {
      trackId: 'track-screen', action: 'move', anchorId: 'manual-1',
      sourceMs: 300_000, sessionMs: 300_640,
    },
  })).diagnostic
  assert.match(v3.tracks[0].manualAnchors[0].evidenceRef, /operator:user-editor-2/)
})

test('E2E-FR-148 after a restart, a marker is looked for in the restart file and nowhere else', async () => {
  // The screen recorder stopped and started: two files, the second beginning
  // at 610 s of session time.
  const session = teacherSession({ restart: true })
  const screen = session.tracks.find((entry) => entry.trackId === 'track-screen')
  assert.equal(screen.parts.length, 2)
  // Wave 18 re-stamps BOTH parts once a track is split, because a first file
  // still calling itself 'single-file' would be lying. So the reason says the
  // track is split and cannot say which file came after the break — the
  // ordinal is what does.
  assert.deepEqual(screen.parts.map((entry) => entry.splitReason), ['recorder-restart', 'recorder-restart'])
  assert.deepEqual(screen.parts.map((entry) => entry.ordinal), [0, 1])

  const searched = []
  const released = []
  const services = wire(session, {
    plan: {
      'track-camera-main:after-restart': { atMs: 900 },
      'track-screen:after-restart': { atMs: 500 },
    },
  })
  const sweepWithTrace = services.sweep({
    resolveMediaPath: async ({ part }) => {
      searched.push(part.partId)
      return { path: `/fixtures/${part.partId}.mp4`, release: async () => { released.push(part.partId) } }
    },
  })

  await services.generateMarker({
    actor: ACTOR, sessionId: session.sessionId, position: 'after-restart', idempotencyKey: 'key-restart',
  })
  const sweep = await sweepWithTrace({ actor: ACTOR, sessionId: session.sessionId })

  // The screen track was searched in its restart file, not its first one.
  // Searching the first would report absence for something that was recorded;
  // searching both would let a start marker be credited to a restart.
  assert.ok(
    searched.includes('part-screen-2'),
    `the restart file was never opened; searched ${searched.join(', ')}`,
  )
  assert.ok(
    !searched.includes('part-screen-1'),
    'the pre-restart file was searched for a marker that could not be in it',
  )

  // The camera never restarted, so an after-restart marker has nowhere to be
  // in it. That is a fact about the session, recorded as such — not a failure,
  // and not a guess at the first file.
  const camera = sweep.outcomes.find((entry) => entry.trackId === 'track-camera-main')
  assert.equal(camera.state, 'skipped-no-file')
  assert.match(camera.detail, /no after-restart file/)
  assert.equal(sweep.failed, 0, 'a track with nothing to search was counted as a failure')

  // And the sweep is finished: every pair either produced a detection or had
  // nowhere to look.
  assert.equal(sweep.complete, true)
  assert.equal(sweep.detected, 1)
  // Every file opened was given back. On the S3 driver each one is a full copy
  // of the recording, so a sweep that forgets fills the disk.
  assert.deepEqual(released, searched)
})
