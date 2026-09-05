import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addCaptureSessionTrack,
  createCaptureSession,
} from '../../src/v2/domain/capture-session.ts'
import {
  resolveSessionFrameRate,
  runCaptureSyncWorker,
} from '../../src/v2/application/run-capture-sync-worker.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createSessionClock } from '../../src/v2/domain/session-clock.ts'
import {
  createTickInterval,
  createTimebase,
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

/**
 * The clock a 90 kHz session would have had persisted.
 *
 * Passed explicitly because the worker no longer invents 30000/1001 when
 * nothing names a frame rate: a 90 kHz timebase is a media clock, and inverting
 * it would claim the camera ran at ninety thousand frames a second.
 */
function sessionClock(session) {
  return createSessionClock({
    sessionId: session.sessionId,
    timebase: timebaseFromRate(90_000),
    frameRate: rational(t(30_000), t(1_001)),
    authority: {
      origin: 'primary-camera',
      sourceId: session.referenceTrackId,
      provenance: 'original-capture',
      evidenceRef: 'probe-reference-camera',
    },
    establishedAt: at(0),
  })
}

/** A repository that remembers, so the worker's writes can be inspected. */
function fakeSessions(session, options = {}) {
  const evidence = []
  const maps = []
  const coverage = []
  return {
    evidence,
    maps,
    coverage,
    async readHead() { return session },
    async readVersion() { return session },
    async listVersions() { return [session] },
    async listHeads() { return [] },
    async persistClock() { throw new Error('unused') },
    async readClock() { return options.clock === undefined ? sessionClock(session) : options.clock },
    async persistClockMap(input) { maps.push(input.map); return { map: input.map, replayed: false } },
    async readClockMap() { return null },
    async listClockMaps() { return maps },
    async persistCoverage(input) { coverage.push(input.coverage); return { coverage: input.coverage, replayed: false } },
    async readCoverage() { return null },
    async listCoverage() { return coverage },
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
      // A sequence, because a lease is lost at a moment: the interesting case
      // is the beat that succeeds before the measurement and the beat that
      // fails during it.
      if (Array.isArray(options.heartbeatAliveSequence)) {
        return options.heartbeatAliveSequence[state.heartbeats - 1] ?? false
      }
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
function cleanSignals(overrides = {}) {
  return {
    async observe(input) {
      // Awaited the way the real adapter awaits it, so a test can watch the
      // lease die inside the measurement rather than only around it.
      if (input?.heartbeat) await input.heartbeat()
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
        residualTicks: overrides.residualTicks ?? t(0),
        confidence: 0.94,
        independenceGroup: 'audio',
        evidenceRefs: overrides.evidenceRefs ?? ['probe-audio-1'],
      }]
    },
  }
}

/**
 * One observation per part, the shape the real adapter emits.
 *
 * Every entry names the part it measured through `part:<id>` and they all share
 * one independence group, exactly as `FfmpegAudioSyncSignalSource` does — which
 * is why a disagreement between them produces no contradiction and had to be
 * caught where the map is built instead.
 */
function perPartSignals(entries) {
  return {
    async observe(input) {
      if (input?.heartbeat) await input.heartbeat()
      return entries.map((entry, index) => ({
        signalId: `audio-p${index}-r0`,
        method: 'audio-fingerprint',
        timebase: timebaseFromRate(90_000),
        offsetTicks: entry.offsetTicks,
        anchors: [
          {
            anchorId: `audio-p${index}-w0`,
            sourceTick: entry.coverage.start,
            sessionTick: entry.coverage.start + entry.offsetTicks,
            evidenceRef: `probe-${entry.partId}`,
          },
          {
            anchorId: `audio-p${index}-w1`,
            sourceTick: entry.coverage.end - sec(1),
            sessionTick: entry.coverage.end - sec(1) + entry.offsetTicks,
            evidenceRef: `probe-${entry.partId}`,
          },
        ],
        preconditions: [
          { id: 'both-tracks-carry-audio', satisfied: true, detail: 'both tracks carry a mono stream' },
          { id: 'common-acoustic-event', satisfied: true, detail: 'the same sweep appears in both' },
        ],
        ambiguity: {
          bestPeak: 0.9,
          secondBestPeak: entry.secondBestPeak ?? 0.1,
          windowsConsidered: 20,
          windowsAgreeing: 18,
        },
        coverage: [entry.coverage],
        residualTicks: entry.residualTicks ?? t(0),
        confidence: entry.confidence ?? 0.9,
        independenceGroup: 'audio-fingerprint',
        evidenceRefs: [`part:${entry.partId}`, 'part:part-1'],
      }))
    },
  }
}

/** No signal survives its preconditions, so the cascade must refuse. */
function emptySignals() {
  return { async observe() { return [] } }
}

/** A source that throws whatever the caller says a broken session throws. */
function throwingSignals(error) {
  return {
    async observe() { throw error },
  }
}

/** A phone whose recorder wrote two files, with the coverage the caller names. */
function twoPartPhoneSession(
  secondCoverage,
  splitReason = 'file-size-limit',
  firstCoverage = createTickInterval(t(0), sec(300)),
) {
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
      parts: [
        part({
          partId: 'part-phone-1',
          ordinal: 0,
          sourceAssetId: 'asset-phone',
          coverage: firstCoverage,
          splitReason,
        }),
        part({
          partId: 'part-phone-2',
          ordinal: 1,
          // A second file is a second asset: two parts sharing one asset and
          // stream is the same stream claimed twice, and the aggregate refuses
          // it.
          sourceAssetId: 'asset-phone-2',
          coverage: secondCoverage,
          splitReason,
          evidence: { ...part().evidence, ingestArtifactId: 'artifact-2', probeHash: h(3) },
        }),
      ],
    }),
    lineage: { ...LINEAGE, operation: 'add-track', commandId: 'command-2' },
  })
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
    claimed: false, runId: null, workspaceId: null, settled: false, resolved: 0, review: 0, insufficient: 0,
    coverageDerived: 0, coverageRefused: 0, mapRefused: 0, mediaUnavailable: 0,
  })
})

test('T-F4.012 the worker refuses to invent a frame rate it cannot read anywhere', async () => {
  // The defect this replaces: with no persisted session clock — which is every
  // session in production — the worker fell back to 30000/1001, so a 25 fps
  // session had every residual threshold in the cascade measured against a
  // frame it never had.
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session, { clock: null })
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: cleanSignals(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.settled, true)
  assert.equal(runs.state.settled.status, 'failed')
  assert.match(runs.state.settled.failureReason, /frame rate/)
  assert.equal(sessions.evidence.length, 0, 'nothing may be measured in frames nobody could name')
})

test('T-F4.012 a camera timebase that is a frame duration names the rate by itself', () => {
  // The ordinary case once the fallback is gone: a 1/25 video track carries its
  // own frame rate, and a 90 kHz media clock carries none.
  const camera = track({ timebase: createTimebase(rational(t(1), t(25))) })
  assert.equal(
    resolveSessionFrameRate({ clock: null, referenceTrack: camera })?.source,
    'reference-track-timebase',
  )
  assert.deepEqual(
    { ...resolveSessionFrameRate({ clock: null, referenceTrack: camera }).frameRate },
    { num: t(25), den: t(1) },
  )
  assert.equal(resolveSessionFrameRate({ clock: null, referenceTrack: track() }), null)
})

test('T-F4.012 the worker derives and persists coverage for every track', () => {
  // Guards map §19.2: createTrackCoverage had no runtime caller, so coverageBps
  // was null on every diagnostic and coverage-below-floor could never fire.
  return (async () => {
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

    assert.equal(result.coverageDerived, 2, 'the reference track is measured too')
    assert.equal(result.coverageRefused, 0)
    assert.deepEqual(
      sessions.coverage.map((entry) => entry.trackId).sort(),
      ['track-camera-main', 'track-phone'],
    )
    // Derivation is bound to the exact session version it was read from, so a
    // later reference change makes it refusably stale rather than silently old.
    assert.equal(sessions.coverage[0].derivedFrom.sessionVersion, session.version)
    assert.equal(sessions.coverage[0].derivedFrom.referenceEpoch, session.referenceEpoch)
  })()
})

test('T-F4.012 two files that touch exactly become one piece, not a refused map', async () => {
  // The blocker. `buildMapPieces` could only emit `file-split` or
  // `recorder-restart`, both discontinuous causes, and
  // `piecewise-clock-map.ts:244-250` refuses a discontinuous cause whose source
  // ticks continue without a gap. The ordinary 4 GB split therefore threw a
  // DomainError out of the worker: the run stayed claimed, was never settled,
  // and the `--once` driver died on an unhandled rejection.
  const session = twoPartPhoneSession(createTickInterval(sec(300), sec(600)))
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: perPartSignals([
      { partId: 'part-phone-1', coverage: createTickInterval(t(0), sec(300)), offsetTicks: t(4_500) },
      { partId: 'part-phone-2', coverage: createTickInterval(sec(300), sec(600)), offsetTicks: t(4_500) },
    ]),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.settled, true)
  assert.equal(result.mapRefused, 0, 'a contiguous split is a legal map, not a refused one')
  assert.equal(runs.state.settled.status, 'succeeded')
  assert.equal(sessions.maps.length, 1)
  const pieces = sessions.maps[0].pieces
  assert.equal(pieces.length, 1, 'one law describes both files')
  assert.deepEqual({ ...pieces[0].sourceCoverage }, { start: t(0), end: sec(600) })
  assert.equal(pieces[0].openedBy, null)
  assert.equal(sessions.maps[0].boundaries.length, 0)
})

test('T-F4.012 a second file with its own offset is mapped with its own offset', async () => {
  // The silent one. The adapter measures one offset per (candidate part x
  // reference part) pair and the cascade elects a single signal, so stamping
  // the elected offset onto every piece handed part 2 part 1's alignment —
  // with no warning at all, because both observations share an independence
  // group and the cascade skips contradiction detection inside a group.
  const session = twoPartPhoneSession(createTickInterval(sec(300), sec(600)))
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: perPartSignals([
      { partId: 'part-phone-1', coverage: createTickInterval(t(0), sec(300)), offsetTicks: t(4_500) },
      { partId: 'part-phone-2', coverage: createTickInterval(sec(300), sec(600)), offsetTicks: t(94_500) },
    ]),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.settled, true)
  assert.equal(result.mapRefused, 0)
  const pieces = sessions.maps[0].pieces
  assert.equal(pieces.length, 2, 'two offsets cannot be one affine law')
  assert.equal(pieces[0].map.offsetTicks, t(4_500))
  assert.equal(pieces[1].map.offsetTicks, t(94_500), "part 2 keeps the 1.05s it measured")
  // The boundary is continuous in source ticks, so its cause must be one that
  // does not claim the recorder stopped.
  assert.equal(pieces[1].openedBy, 'residual-exceeded')
  assert.equal(sessions.maps[0].boundaries[0].sourceGap, null)
  assert.match(pieces[1].openedByDetail, /94500 session ticks/)
})

test('T-F4.012 a hole between two files still opens a discontinuous piece', async () => {
  // The other half of the same rule: a cause that says the source stopped
  // producing time has to be backed by ticks that actually stop.
  const session = twoPartPhoneSession(createTickInterval(sec(310), sec(600)), 'card-change')
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  await runCaptureSyncWorker({
    sessions,
    runs,
    signals: perPartSignals([
      { partId: 'part-phone-1', coverage: createTickInterval(t(0), sec(300)), offsetTicks: t(4_500) },
      { partId: 'part-phone-2', coverage: createTickInterval(sec(310), sec(600)), offsetTicks: t(4_500) },
    ]),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  const map = sessions.maps[0]
  assert.equal(map.pieces.length, 2, 'nothing may be resolved inside the ten seconds nobody recorded')
  assert.equal(map.pieces[1].openedBy, 'recorder-restart')
  assert.deepEqual({ ...map.boundaries[0].sourceGap }, { start: sec(300), end: sec(310) })
})

test('T-F4.012 a part nobody measured inherits the law and says so in its confidence', async () => {
  // Only part 1 was measured. Part 2 has no signal of its own, so it takes the
  // elected law — which is defensible only while the map admits it is not the
  // same claim as a measured piece.
  // The measured part covers two thirds of the session so the verdict really is
  // auto-apply: without that the two pieces would both be `medium` for the
  // verdict's own reason and the assertion would prove nothing.
  const session = twoPartPhoneSession(
    createTickInterval(sec(410), sec(600)),
    'recorder-restart',
    createTickInterval(t(0), sec(400)),
  )
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  await runCaptureSyncWorker({
    sessions,
    runs,
    signals: perPartSignals([
      { partId: 'part-phone-1', coverage: createTickInterval(t(0), sec(400)), offsetTicks: t(4_500) },
    ]),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  const pieces = sessions.maps[0].pieces
  assert.equal(pieces.length, 2)
  assert.equal(pieces[0].confidence, 'high', 'the piece a signal actually measured')
  assert.equal(pieces[1].confidence, 'medium', 'an inherited law is never high confidence')
  assert.equal(pieces[1].map.offsetTicks, t(4_500))
})

test('T-F4.012 a track the domain will not map is refused, not thrown out of the run', async () => {
  // Two parts claiming the same ticks with two different offsets: two laws for
  // one instant, which `createPiecewiseClockMap` refuses and should. What must
  // not happen is what used to: the DomainError escaping `runCaptureSyncWorker`
  // and leaving the run claimed with no status, no failure reason and a lease
  // to expire — and the `--once` driver dead on an unhandled rejection.
  const session = twoPartPhoneSession(createTickInterval(sec(200), sec(600)))
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: perPartSignals([
      { partId: 'part-phone-1', coverage: createTickInterval(t(0), sec(300)), offsetTicks: t(4_500) },
      { partId: 'part-phone-2', coverage: createTickInterval(sec(200), sec(600)), offsetTicks: t(94_500) },
    ]),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.settled, true, 'the run is settled, not orphaned')
  assert.equal(runs.state.settled.status, 'succeeded')
  assert.equal(result.mapRefused, 1, 'the refusal is counted, not swallowed and not thrown')
  assert.equal(sessions.maps.length, 0)
  // The verdict was still filed: the cascade did answer, and an operator needs
  // to see both the answer and the fact that no map could be built from it.
  assert.equal(sessions.evidence.length, 1)
  assert.equal(result.coverageRefused, 1, 'two parts claiming one instant is a human decision')
})

test('T-F4.012 the piece carries the residual the elected signal measured', async () => {
  // The mutation this catches: reverting `residualBoundTicks` to a hardcoded
  // zero left every suite green, because every fixture measured a residual of
  // zero and `createSourceToSessionMapping` adds one tick of rounding bound to
  // whatever it is handed — so `0 + 1` and `measured + 1` were the same number.
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  await runCaptureSyncWorker({
    sessions,
    runs,
    signals: cleanSignals({ residualTicks: t(3) }),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  const record = sessions.evidence[0]
  assert.equal(record.assessments[0].residualSessionTicks, t(3))
  assert.equal(
    sessions.maps[0].pieces[0].residualBoundTicks,
    t(4),
    'the measured residual plus the one tick integer rounding always costs',
  )
})

test('T-F4.012 a track whose file is gone degrades that track, not the run', async () => {
  // BRIEF-H §2: no file means no observation, never an invented one, and the
  // worker walks the path it already had to `insufficient-evidence`. Failing
  // the whole run instead made one phone nobody copied off the card block the
  // synchronization of every other camera in the session — the opposite of the
  // policy the coverage loop argues for twenty lines earlier.
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: throwingSignals(new DomainError(
      'MEDIA_ARTIFACT_NOT_FOUND',
      'Capture part part-phone-1 names artifact artifact-1, which does not exist',
    )),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.settled, true)
  assert.equal(runs.state.settled.status, 'succeeded', 'an absent file is a fact, not a broken run')
  assert.equal(result.mediaUnavailable, 1)
  assert.equal(result.insufficient, 1)
  assert.equal(sessions.evidence[0].outcome, 'insufficient-evidence')
  assert.equal(sessions.maps.length, 0, 'nothing may be mapped from a file nobody opened')
  assert.equal(result.coverageDerived, 2, 'the other tracks are still measured')
})

test('T-F4.012 a codec that will not open still fails the run', async () => {
  // The other side of the same classification. "We never listened" must not be
  // filed as "we listened and heard nothing".
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session)
  const runs = fakeRuns({ baseSessionHash: session.sessionHash })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: throwingSignals(new DomainError(
      'INVALID_MEDIA_ARTIFACT',
      'audio could not be decoded from phone.mp4 for synchronization',
    )),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(result.mediaUnavailable, 0)
  assert.equal(runs.state.settled.status, 'failed')
  assert.match(runs.state.settled.failureReason, /sync signal source failed/)
})

test('T-F4.012 a lease lost inside the measurement stops before anything is filed', async () => {
  // The heartbeat was taken only before `observe`, so a measurement longer than
  // the lease — one correlation at the adapter's analysis cap measures 71 s of
  // uninterruptible CPU — was reclaimed mid-flight and its result filed against
  // a claim that no longer existed. The adapter now beats from inside, and a
  // beat that fails there is checked before the verdict is written.
  const session = sessionWithTwoTracks()
  const sessions = fakeSessions(session)
  const runs = fakeRuns({
    baseSessionHash: session.sessionHash,
    heartbeatAliveSequence: [true, false],
  })
  const result = await runCaptureSyncWorker({
    sessions,
    runs,
    signals: cleanSignals(),
    owner: 'worker-1',
    clock: () => new Date(at(10)),
  })()

  assert.equal(runs.state.heartbeats, 2, 'the beat inside the measurement really happened')
  assert.equal(result.abandonedBecause, 'lease-lost')
  assert.equal(result.settled, false)
  assert.equal(sessions.evidence.length, 0, 'nothing may be written after the lease is gone')
  assert.equal(runs.state.settled, null)
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
