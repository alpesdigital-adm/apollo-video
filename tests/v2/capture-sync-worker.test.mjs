import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addCaptureSessionTrack,
  createCaptureSession,
} from '../../src/v2/domain/capture-session.ts'
import { runCaptureSyncWorker } from '../../src/v2/application/run-capture-sync-worker.ts'
import {
  createTickInterval,
  rational,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'

const t = (n) => BigInt(n)
const HZ = t(90_000)
const sec = (n) => HZ * t(n)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const h = (n) => String(n).repeat(64).slice(0, 64)

function part(overrides = {}) {
  return {
    partId: 'part-1',
    ordinal: 0,
    sourceAssetId: 'asset-cam-main',
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
  const first = overrides.parts?.[0] ?? part(overrides.partOverrides ?? {})
  const { partOverrides, ...rest } = overrides
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

function sessionWithTwoTracks() {
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
  return addCaptureSessionTrack(base, {
    track: track({
      trackId: 'track-phone',
      role: 'phone',
      syncAudioPolicy: 'sync-only',
      includeInFinalMix: false,
      device: { deviceId: 'device-phone', recorderId: 'recorder-phone', make: null, model: null, serial: null },
      partOverrides: { partId: 'part-phone-1', sourceAssetId: 'asset-phone' },
    }),
    lineage: { ...LINEAGE, operation: 'add-track', commandId: 'command-2' },
  })
}

/** A repository that remembers, so the worker's writes can be inspected. */
function fakeSessions(session) {
  const evidence = []
  const maps = []
  return {
    evidence,
    maps,
    async readHead() { return session },
    async readVersion() { return session },
    async listVersions() { return [session] },
    async listHeads() { return [] },
    async persistClock() { throw new Error('unused') },
    async readClock() { return null },
    async persistClockMap(input) { maps.push(input.map); return { map: input.map, replayed: false } },
    async readClockMap() { return null },
    async listClockMaps() { return maps },
    async persistCoverage(input) { return { coverage: input.coverage, replayed: false } },
    async readCoverage() { return null },
    async listCoverage() { return [] },
    async persistSyncEvidence(input) { evidence.push(input.record); return { record: input.record, replayed: false } },
    async readSyncEvidence() { return null },
    async listSyncEvidence() { return evidence },
    async appendVersion() { throw new Error('unused') },
  }
}

function fakeRuns(options = {}) {
  const state = {
    claims: 0,
    heartbeats: 0,
    settled: null,
    run: {
      id: 'capture-sync-run-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'capture-session-1',
      baseVersionId: 'capture-session-1:v2',
      baseSessionHash: options.baseSessionHash,
      baseVersion: 2,
      status: 'running',
      fencingToken: t(1),
      attemptCount: 1,
      maxAttempts: 3,
      trackCount: 1,
      resolvedCount: null,
      reviewCount: null,
      insufficientCount: null,
      failureReason: null,
      leaseExpiresAt: at(60),
      heartbeatAt: at(0),
      startedAt: at(0),
      settledAt: null,
      createdAt: at(0),
      updatedAt: at(0),
    },
  }
  return {
    state,
    async claim() {
      state.claims += 1
      if (options.nothingToClaim) return null
      return { run: state.run, leaseToken: 'lease-token-1' }
    },
    async heartbeat() {
      state.heartbeats += 1
      return options.heartbeatAlive ?? true
    },
    async settle(input) {
      state.settled = input.outcome
      if (options.settleRefusedBecause) {
        return { settled: false, run: state.run, reason: options.settleRefusedBecause }
      }
      return { settled: true, run: state.run }
    },
    async request() { throw new Error('unused') },
    async read() { return state.run },
    async readLatestForSession() { return state.run },
  }
}

/** Signals that place the phone 4500 ticks late, cleanly enough to auto-apply. */
function cleanSignals() {
  return {
    async observe() {
      return [{
        signalId: 'signal-audio-1',
        method: 'audio-fingerprint',
        timebase: timebaseFromRate(90_000),
        offsetTicks: t(4_500),
        anchors: [
          { anchorId: 'anchor-1', sourceTick: t(0), sessionTick: t(4_500), evidenceRef: 'probe-audio-1' },
          { anchorId: 'anchor-2', sourceTick: sec(300), sessionTick: sec(300) + t(4_500), evidenceRef: 'probe-audio-1' },
        ],
        // The method's required preconditions, both met. A method whose
        // preconditions are unmet is inadmissible however good its score.
        preconditions: [
          { id: 'both-tracks-carry-audio', satisfied: true, detail: 'both tracks carry a mono 48 kHz stream' },
          { id: 'common-acoustic-event', satisfied: true, detail: 'a hand clap at 00:00:12 appears in both' },
        ],
        // The peak is eight times the runner-up: the search could not plausibly
        // have picked the other one.
        ambiguity: { bestPeak: 0.92, secondBestPeak: 0.11, windowsConsidered: 40, windowsAgreeing: 38 },
        coverage: [createTickInterval(t(0), sec(600))],
        residualTicks: t(0),
        confidence: 0.94,
        independenceGroup: 'audio',
        evidenceRefs: ['probe-audio-1'],
      }]
    },
  }
}

/** No signal survives its preconditions, so the cascade must refuse. */
function emptySignals() {
  return { async observe() { return [] } }
}

test('T-FR-142 the worker persists one verdict per non-reference track', async () => {
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: cleanSignals(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.claimed, true)
  assert.equal(result.settled, true)
  // Two tracks, one of which is the reference: exactly one verdict.
  assert.equal(sessions.evidence.length, 1)
  assert.equal(sessions.evidence[0].trackId, 'track-phone')
  assert.equal(result.resolved + result.review + result.insufficient, 1)
  assert.deepEqual(runs.state.settled, {
    status: 'succeeded',
    resolvedCount: result.resolved,
    reviewCount: result.review,
    insufficientCount: result.insufficient,
  })
})

test('T-FR-142 insufficient evidence persists the verdict and writes no map', async () => {
  // The failure this guards: writing an identity map when nothing was measured
  // would make "we could not tell" indistinguishable from "they aligned".
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: emptySignals(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.insufficient, 1)
  assert.equal(result.resolved, 0)
  assert.equal(sessions.evidence.length, 1)
  assert.equal(sessions.evidence[0].outcome, 'insufficient-evidence')
  assert.equal(sessions.evidence[0].clockMap, null)
  assert.equal(sessions.maps.length, 0, 'a refusal must not leave a map behind')
  // The run still succeeded: the cascade answered, and the answer was that it
  // could not tell. That is a result, not a failure of the run.
  assert.equal(runs.state.settled.status, 'succeeded')
})

test('T-FR-142 a worker that loses its lease stops instead of writing', async () => {
  // The restart case. The worker paused, the lease expired, another worker took
  // the run. This one's result describes a claim that no longer exists.
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash, heartbeatAlive: false })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: cleanSignals(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.claimed, true)
  assert.equal(result.settled, false)
  assert.equal(result.abandonedBecause, 'lease-lost')
  assert.equal(runs.state.heartbeats, 1)
  assert.equal(sessions.evidence.length, 0, 'nothing may be written after the lease is gone')
  assert.equal(runs.state.settled, null, 'a worker without a lease must not settle')
})

test('T-FR-142 a run whose session moved is failed, not filed against the new version', async () => {
  // A map attributed to the wrong version is worse than no map: the tracks it
  // measured may not be the tracks in the session any more.
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: h(9) })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: cleanSignals(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.abandonedBecause, 'session-moved')
  assert.equal(sessions.evidence.length, 0)
  assert.equal(sessions.maps.length, 0)
  assert.equal(runs.state.settled.status, 'failed')
  assert.match(runs.state.settled.failureReason, /moved to version/)
})

test('T-FR-142 an empty queue is not an error', async () => {
  const session = sessionWithTwoTracks()
  const result = await runCaptureSyncWorker({
    sessions: fakeSessions(session),
    runs: fakeRuns({ nothingToClaim: true, baseSessionHash: session.sessionHash }),
    signals: cleanSignals(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()
  assert.deepEqual({ ...result }, {
    claimed: false, runId: null, settled: false, resolved: 0, review: 0, insufficient: 0,
  })
})

test('T-FR-145 a settlement refused as superseded is reported, not swallowed', async () => {
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session)
  const runs = fakeRuns({
    baseSessionHash: session.sessionHash,
    settleRefusedBecause: 'superseded',
  })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: cleanSignals(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.settled, false)
  assert.equal(result.abandonedBecause, 'superseded')
  // The verdicts were written before the settle was refused. That is correct:
  // they are content-addressed and a newer run will overwrite them with its
  // own, so the wasted work is bounded and nothing false was recorded.
  assert.equal(sessions.evidence.length, 1)
})
