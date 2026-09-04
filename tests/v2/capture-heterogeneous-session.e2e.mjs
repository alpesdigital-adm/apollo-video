import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addCaptureSessionTrack,
  addCaptureSessionTrackPart,
  assertCaptureSessionIntegrity,
  createCaptureSession,
} from '../../src/v2/domain/capture-session.ts'
import { fitClockDrift, createDriftAnchor } from '../../src/v2/domain/clock-drift.ts'
import {
  createPiecewiseClockMap,
  describedSourceTicks,
  isSessionRangeResolvable,
  resolveSourceTick,
} from '../../src/v2/domain/piecewise-clock-map.ts'
import {
  createSessionClock,
  createSourceClock,
  createSourceToSessionMapping,
} from '../../src/v2/domain/session-clock.ts'
import {
  createTickInterval,
  ppmToRate,
  rational,
  rationalToPpm,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'
import { presentSyncTrack, presentClockMap } from '../../src/v2/public-api/capture-session-contract.ts'

/**
 * E2E — one heterogeneous session, end to end.
 *
 * Four recorders that agree about nothing:
 *
 * - an A camera with timecode at 90 kHz, which becomes the session clock;
 * - a 48 kHz master audio recorder, the delivered sound;
 * - a 44.1 kHz scratch recorder, useful only for sync;
 * - a phone at 600 ticks per second running 120 ppm fast, whose card filled
 *   ten seconds into the second half so it wrote two files.
 *
 * Every number below is exact. 48000 and 44100 have no common timebase with
 * 90000 that a decimal rate could express, 30000/1001 is not a decimal at all,
 * and +120 ppm over twenty minutes is 144 ms — more than three frames at 25 fps,
 * which is the difference between lip-sync and visibly wrong.
 */

const t = (n) => BigInt(n)
const HZ = t(90_000)
const sec = (n) => HZ * t(n)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const h = (n) => String(n).repeat(64).slice(0, 64)

const SESSION_TB = timebaseFromRate(90_000)
const NTSC = rational(BigInt(30_000), BigInt(1_001))
const TWENTY_MINUTES = 1_200

function part(input) {
  return {
    partId: input.partId,
    ordinal: input.ordinal ?? 0,
    sourceAssetId: input.sourceAssetId,
    timebase: input.timebase,
    coverage: input.coverage,
    streamIndex: 0,
    splitReason: input.splitReason ?? 'single-file',
    evidence: {
      ingestArtifactId: `artifact-${input.partId}`,
      ingestSha256: h(1),
      probeHash: h(2),
      probeSource: 'packet-scan',
      observedAt: at(5),
    },
  }
}

function track(input) {
  const first = input.firstPart
  return {
    trackId: input.trackId,
    role: input.role,
    device: {
      deviceId: input.deviceId,
      recorderId: `${input.deviceId}-recorder`,
      make: null,
      model: null,
      serial: null,
    },
    sourceAssetId: first.sourceAssetId,
    timebase: input.timebase,
    streamIndex: 0,
    syncAudioPolicy: input.syncAudioPolicy,
    includeInFinalMix: input.includeInFinalMix,
    parts: [first],
  }
}

const LINEAGE = {
  commandId: 'command-1',
  operation: 'create-session',
  actorKind: 'human',
  actorId: 'user-editor-1',
  occurredAt: at(0),
  note: 'A camera, master audio, scratch recorder and a phone.',
}

/** The whole session, built the way the API builds it: one command at a time. */
function buildSession() {
  // The A camera is the clock. It is an original capture with timecode, which
  // is the only reason it may define time for everything else.
  let session = createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-heterogeneous',
    clock: { timebase: SESSION_TB, rounding: 'nearest-half-even' },
    referenceTrackId: 'track-camera-main',
    tracks: [track({
      trackId: 'track-camera-main',
      role: 'camera-main',
      deviceId: 'device-camera-a',
      timebase: SESSION_TB,
      syncAudioPolicy: 'final-candidate',
      includeInFinalMix: true,
      firstPart: part({
        partId: 'part-camera-1',
        sourceAssetId: 'asset-camera-main',
        timebase: SESSION_TB,
        coverage: createTickInterval(t(0), sec(TWENTY_MINUTES)),
      }),
    })],
    lineage: LINEAGE,
    createdAt: at(0),
  })

  // 48 kHz master audio: the sound that ships.
  session = addCaptureSessionTrack(session, {
    track: track({
      trackId: 'track-master-audio',
      role: 'master-audio',
      deviceId: 'device-recorder-48k',
      timebase: timebaseFromRate(48_000),
      syncAudioPolicy: 'final-candidate',
      includeInFinalMix: true,
      firstPart: part({
        partId: 'part-master-1',
        sourceAssetId: 'asset-master-audio',
        timebase: timebaseFromRate(48_000),
        coverage: createTickInterval(t(0), t(48_000) * t(TWENTY_MINUTES)),
      }),
    }),
    lineage: { ...LINEAGE, operation: 'add-track', commandId: 'command-2' },
  })

  // 44.1 kHz scratch: useful for sync, never mixed. Declaring it sync-only is
  // what stops it reaching the delivered mix by accident.
  session = addCaptureSessionTrack(session, {
    track: track({
      trackId: 'track-scratch-audio',
      role: 'scratch-audio',
      deviceId: 'device-recorder-441k',
      timebase: timebaseFromRate(44_100),
      syncAudioPolicy: 'sync-only',
      includeInFinalMix: false,
      firstPart: part({
        partId: 'part-scratch-1',
        sourceAssetId: 'asset-scratch-audio',
        timebase: timebaseFromRate(44_100),
        coverage: createTickInterval(t(0), t(44_100) * t(TWENTY_MINUTES)),
      }),
    }),
    lineage: { ...LINEAGE, operation: 'add-track', commandId: 'command-3' },
  })

  // The phone: 600 ticks per second, two files, ten seconds missing between.
  session = addCaptureSessionTrack(session, {
    track: track({
      trackId: 'track-phone',
      role: 'phone',
      deviceId: 'device-phone',
      timebase: timebaseFromRate(600),
      syncAudioPolicy: 'sync-only',
      includeInFinalMix: false,
      firstPart: part({
        partId: 'part-phone-1',
        sourceAssetId: 'asset-phone-clip-1',
        timebase: timebaseFromRate(600),
        coverage: createTickInterval(t(0), t(600) * t(600)),
      }),
    }),
    lineage: { ...LINEAGE, operation: 'add-track', commandId: 'command-4' },
  })

  return addCaptureSessionTrackPart(session, {
    trackId: 'track-phone',
    part: part({
      partId: 'part-phone-2',
      ordinal: 1,
      sourceAssetId: 'asset-phone-clip-2',
      timebase: timebaseFromRate(600),
      // 366000 ticks at 600/s is 610 s: ten seconds after the first file ended.
      coverage: createTickInterval(t(366_000), t(600) * t(TWENTY_MINUTES)),
      splitReason: 'recorder-restart',
    }),
    lineage: { ...LINEAGE, operation: 'add-track-part', commandId: 'command-5' },
  })
}

test('E2E-FR-140 four recorders at four rates form one session, each keeping its own timebase', () => {
  const session = buildSession()
  assert.equal(assertCaptureSessionIntegrity(session), session)
  assert.equal(session.tracks.length, 4)
  assert.equal(session.version, 5)
  assert.equal(session.referenceTrackId, 'track-camera-main')

  // Not one of these was rewritten into the session's 90 kHz. A recorder that
  // counts in 44100ths is entitled to say so, and normalizing it here would put
  // a rounding between the file and every measurement made from it.
  const rates = Object.fromEntries(session.tracks.map((entry) => [
    entry.trackId,
    `${entry.timebase.secondsPerTick.num}/${entry.timebase.secondsPerTick.den}`,
  ]))
  assert.deepEqual(rates, {
    'track-camera-main': '1/90000',
    'track-master-audio': '1/48000',
    'track-scratch-audio': '1/44100',
    'track-phone': '1/600',
  })

  // The scratch recorder is kept out of the delivered mix by policy, not by
  // convention: its offset is measured but its sound never ships.
  const scratch = session.tracks.find((entry) => entry.trackId === 'track-scratch-audio')
  assert.equal(scratch.syncAudioPolicy, 'sync-only')
  assert.equal(scratch.includeInFinalMix, false)

  // Adding tracks made the derivations stale, and the session says which.
  assert.ok(session.staleDerivations.includes('track-coverage'))
  assert.ok(session.staleDerivations.includes('session-clock-map'))
})

test('E2E-FR-144 the phone drifts +120 ppm, and the fit recovers it exactly', () => {
  const clock = createSessionClock({
    sessionId: 'capture-session-heterogeneous',
    timebase: SESSION_TB,
    frameRate: NTSC,
    authority: {
      origin: 'primary-camera',
      sourceId: 'track-camera-main',
      provenance: 'original-capture',
      evidenceRef: 'probe-camera-main',
    },
    establishedAt: at(0),
  })
  const source = createSourceClock({
    sourceId: 'asset-phone-clip-1',
    timebase: timebaseFromRate(600),
    provenance: 'original-capture',
  })

  // Anchors that lie exactly on session = 4500 + 1.000120 * source, spread
  // across the whole first file so the fit has a span to measure over.
  const rate = ppmToRate(120)
  const anchors = [0, 150, 300, 450, 580].map((second, index) => {
    const sourceTick = t(600) * t(second)
    // The phone's ticks are 600/s; the session counts 90 kHz. 150 session ticks
    // per phone tick, exactly, before drift.
    const sessionExact = (sourceTick * t(150) * rate.num) / rate.den + t(4_500)
    return createDriftAnchor({
      id: `anchor-phone-${index}`,
      sourceTick: sourceTick * t(150),
      sessionTick: sessionExact,
      method: 'audio',
      confidence: 'high',
      evidenceRef: `probe-phone-anchor-${index}`,
    })
  })

  const fit = fitClockDrift({
    clock,
    source: createSourceClock({
      sourceId: 'asset-phone-clip-1',
      timebase: SESSION_TB,
      provenance: 'original-capture',
    }),
    anchors,
    span: createTickInterval(t(0), sec(600)),
  })

  assert.equal(fit.status, 'fitted')
  assert.equal(fit.driftPpm, 120)
  assert.equal(rationalToPpm(fit.driftRate), 120)
  assert.equal(fit.offsetTicks, t(4_500))
  // Over twenty minutes, 120 ppm accumulates 1200 s x 120e-6 = 0.144 s, which
  // is 12,960 ticks at 90 kHz. That is not a rounding detail: it is more than
  // three frames at 25 fps, and the difference between lip-sync and visibly
  // wrong.
  const accumulated = (sec(TWENTY_MINUTES) * t(120)) / t(1_000_000)
  assert.equal(accumulated, t(12_960))
  assert.equal(accumulated / t(90), t(144), '144 ms of skew, in whole milliseconds')
  assert.equal(source.timebase.secondsPerTick.den, BigInt(600))
})

test('E2E-FR-145 the phone restart becomes two pieces, and the gap resolves to nothing', () => {
  const clock = createSessionClock({
    sessionId: 'capture-session-heterogeneous',
    timebase: SESSION_TB,
    frameRate: NTSC,
    authority: {
      origin: 'primary-camera',
      sourceId: 'track-camera-main',
      provenance: 'original-capture',
      evidenceRef: 'probe-camera-main',
    },
    establishedAt: at(0),
  })
  const source = createSourceClock({
    sourceId: 'asset-phone-clip-1',
    timebase: SESSION_TB,
    provenance: 'original-capture',
  })

  const mapping = (from, to, offsetTicks) => createSourceToSessionMapping({
    clock,
    source,
    sourceCoverage: createTickInterval(from, to),
    driftRate: ppmToRate(120),
    offsetTicks,
    residualBoundTicks: t(30),
    confidence: 'high',
    anchorIds: ['anchor-phone-0', 'anchor-phone-4'],
    evidenceRefs: ['probe-phone-anchor-0'],
  })

  const map = createPiecewiseClockMap({
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-heterogeneous',
    sourceId: 'asset-phone-clip-1',
    clock,
    derivedFrom: { sessionVersion: 5, referenceEpoch: 1 },
    pieces: [
      { pieceId: 'piece-phone-1', mapping: mapping(t(0), sec(600), t(4_500)) },
      {
        pieceId: 'piece-phone-2',
        mapping: mapping(sec(610), sec(TWENTY_MINUTES), t(911_980)),
        openedBy: 'recorder-restart',
        openedByDetail: 'card filled at 00:10:00; the recorder wrote a second file ten seconds later',
      },
    ],
  })

  // Inside either file, a source tick resolves. Between them it does not, and
  // the refusal carries no number: interpolating there is exactly how a
  // twenty-minute edit ends up a frame out for its second half.
  assert.equal(resolveSourceTick(map, sec(300)).pieceId, 'piece-phone-1')
  assert.equal(resolveSourceTick(map, sec(900)).pieceId, 'piece-phone-2')
  const inGap = resolveSourceTick(map, sec(605))
  assert.equal(inGap.status, 'uncovered')
  assert.equal(inGap.reason, 'in-discontinuity')
  assert.equal(inGap.tick, undefined)

  // The hull spans twenty minutes; ten seconds of it were never recorded.
  assert.equal(describedSourceTicks(map), sec(TWENTY_MINUTES) - sec(10))
  assert.equal(map.uncovered.length, 1)
  assert.equal(map.uncovered[0].start, sec(600))
  assert.equal(map.uncovered[0].end, sec(610))

  // A range spanning the restart cannot be selected even though both ends are
  // covered: the material between them does not exist.
  const [first, second] = map.pieces
  assert.equal(isSessionRangeResolvable(map, first.sessionCoverage), true)
  assert.equal(
    isSessionRangeResolvable(
      map,
      createTickInterval(first.sessionCoverage.end - sec(1), second.sessionCoverage.start + sec(1)),
    ),
    false,
  )

  // And the boundary reports the measured size of the discontinuity rather
  // than smoothing it away.
  assert.equal(map.boundaries.length, 1)
  assert.equal(map.boundaries[0].cause, 'recorder-restart')
  assert.equal(map.boundaries[0].sourceGap.end - map.boundaries[0].sourceGap.start, sec(10))
  assert.ok(map.boundaries[0].sessionJumpTicks > t(0))

  // The API view keeps ticks as decimal strings, so nothing rounds on the way
  // out either.
  const view = presentClockMap(map)
  assert.equal(view.pieces.length, 2)
  // The rate is carried in lowest terms: ppmToRate(120) is 1000120/1000000,
  // which reduces exactly to 25003/25000. Reducing is what keeps two
  // spellings of the same rate hashing identically.
  assert.equal(view.pieces[0].rate, '25003/25000')
  assert.equal(view.pieces[1].openedBy, 'recorder-restart')
  assert.equal(view.uncovered[0].start, sec(600).toString())
  assert.match(view.pieces[0].offsetTicks, /^[0-9]+$/)
})

test('E2E-FR-142 a track the cascade could not measure is reported as such, with no map', () => {
  const record = {
    schemaVersion: 'sync-evidence/v1',
    sessionId: 'capture-session-heterogeneous',
    trackId: 'track-scratch-audio',
    referenceTrackId: 'track-camera-main',
    sessionTimebase: SESSION_TB,
    sessionFrameRate: NTSC,
    sessionBounds: createTickInterval(t(0), sec(TWENTY_MINUTES)),
    outcome: 'insufficient-evidence',
    manualRequired: true,
    selectedSignalId: null,
    selectedMethod: null,
    clockMap: null,
    assessments: [],
    discarded: [],
    contradictions: [],
    corroborations: [],
    outcomeReasons: ['audio-fingerprint: no common acoustic event above the ambiguity floor'],
    thresholds: {},
  }
  const view = presentSyncTrack({ record, map: null, coverage: null })
  assert.equal(view.outcome, 'insufficient-evidence')
  assert.equal(view.map, null)
  assert.equal(view.selectedMethod, null)
  assert.equal(view.manualRequired, true)
  assert.ok(view.outcomeReasons[0].length > 0, 'a refusal must say what it tried')
})
