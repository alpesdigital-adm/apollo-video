import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  addCaptureSessionTrack,
  addCaptureSessionTrackPart,
  captureSessionDerivationRef,
  createCaptureSession,
} from '../../src/v2/domain/capture-session.ts'
import {
  CAMERA_ID_TOKEN,
  colorCameraIdForTrack,
  colorCameraIdsForSession,
} from '../../src/v2/domain/camera-identity.ts'
import { DOMAIN_ERROR_CODES } from '../../src/v2/domain/errors.ts'
import { PUBLIC_ERROR_CATALOG } from '../../src/v2/public-api/public-error-catalog.ts'
import {
  assertMulticamEvidenceSetIntegrity,
  createMulticamEvidenceSet,
  MULTICAM_EVIDENCE_KINDS,
} from '../../src/v2/domain/multicam-evidence.ts'
import {
  ANGLE_REJECTIONS,
  assertMulticamDirectionIntegrity,
  calculateAngleCandidateHash,
  calculateMulticamDirectionHash,
  calculateShotDecisionHash,
  compileShotsToSourceRanges,
  DEFAULT_DIRECTION_POLICY,
  deriveAngleCandidates,
  directionConfidenceBand,
  DIRECTION_RULES,
  directMulticam,
  millisecondsToTicks,
  resolveDirectionPolicy,
  toAngleDecision,
} from '../../src/v2/domain/multicam-direction.ts'
import { createPiecewiseClockMap } from '../../src/v2/domain/piecewise-clock-map.ts'
import {
  createSessionClock,
  createSourceClock,
  createSourceToSessionMapping,
} from '../../src/v2/domain/session-clock.ts'
import { createTickInterval, rational, timebaseFromRate } from '../../src/v2/domain/session-time.ts'
import { createSyncDiagnostic, deriveTrackStatus } from '../../src/v2/domain/sync-diagnostic.ts'
import { createTrackCoverage } from '../../src/v2/domain/track-coverage.ts'

/**
 * F4.012 — multicamera direction goldens (FR-150).
 *
 * Every session below is built through the Wave 18/19 constructors, every
 * coverage through `createTrackCoverage`, every map through
 * `createPiecewiseClockMap`, every diagnostic through `createSyncDiagnostic`.
 * The direction never receives a number it could not have derived itself.
 */

/** A candidate without its hash, ready to be resealed after a change. */
function withoutHash(candidate) {
  const { candidateHash: _candidateHash, ...body } = candidate
  return body
}

const t = (n) => BigInt(n)
const HZ = 90_000
// Seconds may be fractional: 90 000 ticks per second is 90 per millisecond, so a
// half-second interjection is an exact tick count and never a rounded float.
const ms = (n) => t(90) * t(Math.round(n))
const sec = (n) => ms(n * 1_000)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const h = (n) => String(n).repeat(64).slice(0, 64)
const seconds = (tick) => Number(tick) / HZ
const WORKSPACE = 'workspace-1'
const SESSION = 'capture-session-1'
const TB = timebaseFromRate(HZ)

function part(overrides = {}) {
  return {
    partId: 'part-1',
    ordinal: 0,
    sourceAssetId: 'asset-1',
    timebase: TB,
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

function track({ trackId, role, deviceId, assetId, coverage, timebase = TB, syncAudioPolicy = 'sync-only', includeInFinalMix = false }) {
  const first = part({ partId: `part-${trackId}`, sourceAssetId: assetId, timebase, coverage })
  return {
    trackId,
    role,
    device: { deviceId, recorderId: `rec-${deviceId}`, make: null, model: null, serial: null },
    sourceAssetId: assetId,
    timebase,
    streamIndex: 0,
    syncAudioPolicy,
    includeInFinalMix,
    parts: [first],
  }
}

const LINEAGE = { commandId: 'command-1', operation: 'create-session', actorKind: 'human', actorId: 'user-1', occurredAt: at(0), note: null }

function buildSession({ referenceTrack, others, clockAuthority }) {
  let session = createCaptureSession({
    workspaceId: WORKSPACE,
    projectId: 'project-1',
    sessionId: SESSION,
    clock: { timebase: TB, rounding: 'nearest-half-even' },
    referenceTrackId: referenceTrack.trackId,
    tracks: [referenceTrack],
    lineage: LINEAGE,
    createdAt: at(0),
  })
  others.forEach((entry, index) => {
    session = addCaptureSessionTrack(session, {
      track: entry,
      lineage: { ...LINEAGE, operation: 'add-track', commandId: `command-add-${index}` },
    })
  })
  const clock = createSessionClock({
    sessionId: SESSION,
    timebase: TB,
    frameRate: rational(30, 1),
    authority: clockAuthority,
    establishedAt: at(0),
  })
  return { session, clock }
}

function coverageFor(session, trackId, { confidenceBps = 9_800 } = {}) {
  const entry = session.tracks.find((candidate) => candidate.trackId === trackId)
  return createTrackCoverage({
    workspaceId: WORKSPACE,
    trackId,
    derivedFrom: captureSessionDerivationRef(session),
    timebase: entry.timebase,
    claims: entry.parts.map((piece) => ({
      partId: piece.partId,
      ordinal: piece.ordinal,
      timebase: piece.timebase,
      interval: piece.coverage,
      confidenceBps,
      evidence: { kind: 'packet-scan', ref: `probe-${piece.partId}` },
    })),
  })
}

/**
 * One piecewise map per track, pieces in the order the recorder wrote the files.
 *
 * `refit` builds the second piece as a re-fit rather than a restart: the source
 * ticks continue without a gap, so the boundary cause must be a continuous one
 * (`piecewise-clock-map.ts:66-70` refuses `file-split`/`recorder-restart` when
 * nothing is missing) and the later piece admits a wider residual. Nothing is
 * lost across it — but no single law spans it, so a selection cannot cross it.
 */
function mapFor(session, clock, trackId, offsetTicks, { refit = false } = {}) {
  const entry = session.tracks.find((candidate) => candidate.trackId === trackId)
  const source = createSourceClock({ sourceId: entry.sourceAssetId, timebase: entry.timebase, provenance: 'original-capture' })
  const claims = offsetTicks !== t(0)
  return createPiecewiseClockMap({
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    sourceId: entry.sourceAssetId,
    clock,
    derivedFrom: { sessionVersion: session.version, referenceEpoch: session.referenceEpoch },
    pieces: [...entry.parts].sort((left, right) => left.ordinal - right.ordinal).map((piece, index) => ({
      pieceId: `${trackId}-piece-${piece.ordinal}`,
      mapping: createSourceToSessionMapping({
        clock,
        source,
        sourceCoverage: piece.coverage,
        driftRate: rational(1),
        offsetTicks,
        residualBoundTicks: index === 0 || !refit ? t(0) : t(4_500),
        confidence: index === 0 || !refit ? 'high' : 'medium',
        anchorIds: claims ? [`anchor-${trackId}`] : [],
        evidenceRefs: claims ? [`marker-${trackId}`] : [],
      }),
      ...(index === 0 ? {} : {
        // The boundary cause is read from what the recorder did, not typed: a
        // restart that lost material is a restart; a re-fit over continuous
        // ticks is the fit admitting one line did not describe the span.
        openedBy: refit ? 'residual-exceeded' : 'recorder-restart',
        openedByDetail: refit
          ? `the residual passed its bound after ${piece.coverage.start} source ticks`
          : `recorder wrote part ${piece.ordinal} (${piece.splitReason})`,
      }),
    })),
  })
}

function diagnosticFor(session, tracks, { ceiling = 'automatic', version = 1, sessionVersion = session.version } = {}) {
  return createSyncDiagnostic({
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    referenceTrackId: session.referenceTrackId,
    version,
    previousVersionHash: null,
    sessionVersion,
    referenceEpoch: session.referenceEpoch,
    tracks: tracks.map(({ trackId, offsetMs, coverageBps = 9_800, confidence = 0.9, residualMs = 8 }) => {
      const base = {
        trackId,
        methods: ['apollo-marker'],
        confidence,
        offsetMs,
        residualMs,
        driftPpm: null,
        coverageBps,
        gaps: [],
        automaticAnchors: [],
        manualAnchors: [],
        pieceIds: [],
        warnings: [],
        previewSampleMs: [],
      }
      return { ...base, status: deriveTrackStatus({ ...base, hasContradictoryAnchors: false }) }
    }),
    protocolCeiling: ceiling,
    generatedAt: at(120),
  })
}

/**
 * Observation ids are derived from what the observation says, never from a
 * counter: two fixtures describing the same evidence must produce the same
 * bytes, or "the same inputs hash to the same direction" would be testing the
 * order the fixtures happened to run in.
 */
function observe(trackId, [from, to], kind, value, confidence = 0.9, unit = sec) {
  const id = `obs-${kind}-${trackId}-${unit(from)}-${unit(to)}`
  return {
    observationId: id,
    trackId,
    range: createTickInterval(unit(from), unit(to)),
    kind,
    value: { kind, ...value },
    confidence,
    provenance: { method: `fixture/${kind}`, evaluatorKind: 'controlled', evidenceRef: `run:${id}`, producedAt: at(0) },
  }
}

const speaks = (trackId, range, confidence) =>
  observe(trackId, range, 'active-speaker', { speakerKey: `cluster-${trackId}`, identityResolved: false }, confidence)

function sequence(direction) {
  return direction.shots.map((shot) => [shot.chosen.trackId, seconds(shot.sessionRange.start), seconds(shot.sessionRange.end)])
}

// ---------------------------------------------------------------------------
// Podcast: master recorder as the clock, two cameras, one lapel mic per camera body.
// ---------------------------------------------------------------------------

function podcastWorld({ cameraBGap = false, cameraBRestart = false, observations, protectedSelections, range, cameraAGap = false, masterAudio = {}, micAAudio = {} } = {}) {
  const master = track({ trackId: 'track-master-audio', role: 'master-audio', deviceId: 'dev-rec', assetId: 'asset-master', coverage: createTickInterval(t(0), sec(600)), syncAudioPolicy: 'final-candidate', includeInFinalMix: true, ...masterAudio })
  const cameraA = track({ trackId: 'track-camera-a', role: 'camera-main', deviceId: 'dev-a', assetId: 'asset-cam-a', coverage: createTickInterval(t(0), cameraAGap ? sec(125) : sec(600)) })
  const cameraB = track({ trackId: 'track-camera-b', role: 'camera-main', deviceId: 'dev-b', assetId: 'asset-cam-b', coverage: createTickInterval(t(0), cameraBGap || cameraBRestart ? sec(200) : sec(540)) })
  const micA = track({ trackId: 'track-mic-a', role: 'microphone', deviceId: 'dev-a', assetId: 'asset-mic-a', coverage: createTickInterval(t(0), sec(600)), ...micAAudio })
  const micB = track({ trackId: 'track-mic-b', role: 'microphone', deviceId: 'dev-b', assetId: 'asset-mic-b', coverage: createTickInterval(t(0), sec(540)) })
  let { session, clock } = buildSession({
    referenceTrack: master,
    others: [cameraA, cameraB, micA, micB],
    clockAuthority: { origin: 'master-audio', sourceId: 'asset-master', provenance: 'original-capture', evidenceRef: 'probe-master' },
  })
  if (cameraBGap) {
    // The recorder of camera B stopped for thirty seconds: two files, one gap.
    session = addCaptureSessionTrackPart(session, {
      trackId: 'track-camera-b',
      part: part({ partId: 'part-track-camera-b-2', ordinal: 1, sourceAssetId: 'asset-cam-b-2', coverage: createTickInterval(sec(230), sec(540)), splitReason: 'recorder-restart' }),
      lineage: { ...LINEAGE, operation: 'add-track-part', commandId: 'command-part-b-2' },
    })
  }
  if (cameraBRestart) {
    // Camera B rolled over to a second card without losing a frame: two files,
    // continuous source ticks, and a map the fitter had to split in two anyway.
    // Nothing is missing at the boundary, but no single law spans it, so cutting
    // B → B across it is a cut from an angle to itself.
    session = addCaptureSessionTrackPart(session, {
      trackId: 'track-camera-b',
      part: part({ partId: 'part-track-camera-b-2', ordinal: 1, sourceAssetId: 'asset-cam-b-2', coverage: createTickInterval(sec(200), sec(540)), splitReason: 'card-change' }),
      lineage: { ...LINEAGE, operation: 'add-track-part', commandId: 'command-part-b-2' },
    })
  }
  if (cameraAGap) {
    session = addCaptureSessionTrackPart(session, {
      trackId: 'track-camera-a',
      part: part({ partId: 'part-track-camera-a-2', ordinal: 1, sourceAssetId: 'asset-cam-a-2', coverage: createTickInterval(sec(155), sec(600)), splitReason: 'recorder-restart' }),
      lineage: { ...LINEAGE, operation: 'add-track-part', commandId: 'command-part-a-2' },
    })
  }
  // Camera A started half a second after the recorder; camera B thirty seconds after.
  const clockMaps = [
    mapFor(session, clock, 'track-camera-a', t(45_000)),
    mapFor(session, clock, 'track-camera-b', sec(30), { refit: cameraBRestart }),
    // A microphone only needs a map when it is the audio bed: the bed is resolved
    // to source ticks exactly like an angle, and a track with no map is unusable.
    ...(micAAudio.includeInFinalMix ? [mapFor(session, clock, 'track-mic-a', t(45_000))] : []),
  ]
  const coverages = ['track-master-audio', 'track-camera-a', 'track-camera-b', ...(micAAudio.includeInFinalMix ? ['track-mic-a'] : [])]
    .map((trackId) => coverageFor(session, trackId))
  const diagnostic = diagnosticFor(session, [
    { trackId: 'track-camera-a', offsetMs: 500 },
    { trackId: 'track-camera-b', offsetMs: 30_000, coverageBps: 9_000, residualMs: 12 },
  ])
  const evidence = createMulticamEvidenceSet({
    session,
    observations: observations ?? [
      speaks('track-mic-a', [1, 120]),
      speaks('track-mic-b', [120, 250]),
      speaks('track-mic-a', [250, 400]),
      speaks('track-mic-b', [400, 560]),
    ],
    generatedAt: at(130),
  })
  const inputs = {
    session,
    coverages,
    clockMaps,
    diagnostic,
    protocolCeiling: null,
    evidence,
    format: { aspectRatio: '16:9' },
    protectedSelections,
    range: range ?? createTickInterval(sec(1), sec(560)),
    generatedAt: at(140),
  }
  return { session, clock, coverages, clockMaps, diagnostic, evidence, inputs, direct: (overrides = {}) => directMulticam({ ...inputs, ...overrides }) }
}

test('T-FR-150 golden 1: a podcast follows the active speaker across two cameras with different offsets and coverage', () => {
  const world = podcastWorld()
  const direction = world.direct()

  assert.deepEqual(sequence(direction), [
    ['track-camera-a', 1, 120],
    ['track-camera-b', 120, 250],
    ['track-camera-a', 250, 400],
    ['track-camera-b', 400, 560],
  ])
  for (const shot of direction.shots) {
    assert.equal(shot.rule, 'speech-prefers-active-speaker', `${shot.shotId} was decided by ${shot.rule}`)
    assert.ok(shot.confidenceBand === 'high' || shot.confidenceBand === 'medium', `${shot.shotId} ${shot.confidence} ${shot.confidenceBand}`)
    assert.ok(shot.evidenceRefs.some((ref) => ref.startsWith('observation:')), 'a speaker shot cites the observation that chose it')
    assert.equal(shot.audioTrackId, 'track-master-audio')
    // Nothing selects camera B before it existed (session 30 s) or after it stopped (570 s).
    if (shot.chosen.trackId === 'track-camera-b') {
      assert.ok(shot.sessionRange.start >= sec(30) && shot.sessionRange.end <= sec(570), `${shot.shotId} cuts to camera B outside its coverage`)
    }
  }
  assert.equal(direction.manualReviewRequired, false)
  assert.deepEqual(direction.warnings, [])
  assert.deepEqual(direction.uncovered, [])
  assert.equal(direction.audio.trackId, 'track-master-audio')
  assert.deepEqual(
    direction.audio.rejected.map((entry) => entry.trackId).sort(),
    ['track-camera-a', 'track-camera-b', 'track-mic-a', 'track-mic-b'],
    'every track excluded from the final mix is recorded as rejected for the audio bed',
  )

  const compiled = compileShotsToSourceRanges(direction, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: world.coverages })
  assert.equal(compiled.clips.length, 4)
  // Camera A: session [1 s, 120 s) is source [0.5 s, 119.5 s) → frames [15, 3585) at 30 fps.
  assert.equal(compiled.clips[0].sourceAssetId, 'asset-cam-a')
  assert.equal(compiled.clips[0].sourceInFrame, 15)
  assert.equal(compiled.clips[0].sourceOutFrame, 3_585)
  assert.equal(compiled.clips[0].cameraId, 'track-camera-a')
  // Camera B: session [120 s, 250 s) is source [90 s, 220 s) → frames [2700, 6600).
  assert.equal(compiled.clips[1].sourceAssetId, 'asset-cam-b')
  assert.equal(compiled.clips[1].sourceInFrame, 2_700)
  assert.equal(compiled.clips[1].sourceOutFrame, 6_600)
  // Audio is the master, in plan-fps frames, with the exact span of the video (renderer :578).
  for (const clip of compiled.clips) {
    assert.equal(clip.audioSourceAssetId, 'asset-master')
    assert.equal(clip.audioSourceInFrame, seconds(clip.sessionRange.start) * 30)
    assert.equal(clip.audioSourceOutFrame - clip.audioSourceInFrame, clip.sourceOutFrame - clip.sourceInFrame)
    assert.equal(clip.rate, 1)
  }
  // Timeline is contiguous by construction.
  compiled.clips.forEach((clip, index) => {
    assert.equal(clip.timelineInFrame, index === 0 ? 0 : compiled.clips[index - 1].timelineOutFrame)
    assert.equal(clip.timelineOutFrame - clip.timelineInFrame, clip.sourceOutFrame - clip.sourceInFrame)
  })
  assert.equal(compiled.durationFrames, (560 - 1) * 30)
  assert.deepEqual(compiled.sources.map((source) => [source.sourceAssetId, source.kinds, source.durationFrames]), [
    ['asset-cam-a', ['video'], 18_000],
    ['asset-cam-b', ['video'], 16_200],
    ['asset-master', ['audio'], 18_000],
  ])
  console.log(`golden-1 podcast shots=${compiled.clips.length} durationFrames=${compiled.durationFrames} directionHash=${direction.directionHash.slice(0, 12)}`)
})

test('T-FR-150 golden 1b: the audio bed reads what the audio IS, not only that somebody marked it for the mix', () => {
  // A recorder whose channel carries no final content (`syncAudioPolicy: 'none'`)
  // is still legally markable for the mix (`capture-session.ts:363` gates only by
  // role), so reading `includeInFinalMix` alone laid an empty channel under every
  // shot while the lapel microphone that WAS a final candidate sat unused.
  const world = podcastWorld({
    masterAudio: { syncAudioPolicy: 'none', includeInFinalMix: true },
    micAAudio: { syncAudioPolicy: 'final-candidate', includeInFinalMix: true },
  })
  const direction = world.direct()
  assert.equal(direction.audio.trackId, 'track-mic-a', 'the final candidate wins over the marked-but-silent master')
  assert.deepEqual(
    direction.audio.rejected.find((entry) => entry.trackId === 'track-master-audio'),
    { trackId: 'track-master-audio', reason: 'audio-not-final-candidate' },
  )
  for (const shot of direction.shots) assert.equal(shot.audioTrackId, 'track-mic-a')
  const compiled = compileShotsToSourceRanges(direction, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: world.coverages })
  for (const clip of compiled.clips) assert.equal(clip.audioSourceAssetId, 'asset-mic-a')

  // A camera whose audio exists only to line clocks up is refused for the same
  // reason, by name, even when it is marked for the mix.
  const syncOnly = podcastWorld({ masterAudio: { syncAudioPolicy: 'sync-only', includeInFinalMix: true } }).direct()
  assert.equal(syncOnly.audio.trackId, null)
  assert.deepEqual(
    syncOnly.audio.rejected.find((entry) => entry.trackId === 'track-master-audio'),
    { trackId: 'track-master-audio', reason: 'audio-not-final-candidate' },
  )
  assert.ok(syncOnly.warnings.some((warning) => warning.code === 'audio-master-unavailable'), 'a session with no bed says so instead of picking one')
  assert.equal(syncOnly.manualReviewRequired, true)
  console.log(`golden-1b audio bed=${direction.audio.trackId} rejected=${direction.audio.rejected.length} noBed=${syncOnly.audio.trackId}`)
})

test('T-FR-150 golden 1 is sensitive: swapping which microphone spoke changes the shots', () => {
  const original = podcastWorld().direct()
  const swapped = podcastWorld({
    observations: [
      speaks('track-mic-b', [1, 120]),
      speaks('track-mic-a', [120, 250]),
      speaks('track-mic-b', [250, 400]),
      speaks('track-mic-a', [400, 560]),
    ],
  }).direct()
  assert.notDeepEqual(sequence(swapped), sequence(original))
  assert.notEqual(swapped.directionHash, original.directionHash)
  // Camera B cannot be cut to before it exists, so the swapped world opens on A without evidence.
  assert.equal(swapped.shots[0].chosen.trackId, 'track-camera-a')
  assert.equal(swapped.shots[0].rule, 'conservative-hold')
  assert.equal(swapped.shots[1].chosen.trackId, 'track-camera-b')
  assert.equal(seconds(swapped.shots[1].sessionRange.start), 30)
})

test('T-FR-150 golden 1 is deterministic: the same inputs hash to the same direction', () => {
  const left = podcastWorld().direct()
  const right = podcastWorld().direct()
  assert.equal(left.directionHash, right.directionHash)
  assert.deepEqual(left.shots.map((shot) => shot.decisionHash), right.shots.map((shot) => shot.decisionHash))
  assert.equal(assertMulticamDirectionIntegrity(left), left)
})

// ---------------------------------------------------------------------------
// Teacher + screen: different durations, different timebases, screen with sync-only audio.
// ---------------------------------------------------------------------------

function teacherWorld({ observations } = {}) {
  const camera = track({ trackId: 'track-camera-main', role: 'camera-main', deviceId: 'dev-cam', assetId: 'asset-cam-main', coverage: createTickInterval(t(0), sec(1_200)), syncAudioPolicy: 'final-candidate', includeInFinalMix: true })
  const screen = track({ trackId: 'track-screen', role: 'screen', deviceId: 'dev-laptop', assetId: 'asset-screen', timebase: timebaseFromRate(1_000), coverage: createTickInterval(t(0), t(900_000)), syncAudioPolicy: 'sync-only' })
  const { session, clock } = buildSession({
    referenceTrack: camera,
    others: [screen],
    clockAuthority: { origin: 'primary-camera', sourceId: 'asset-cam-main', provenance: 'original-capture', evidenceRef: 'probe-cam-main' },
  })
  // The screen recording started twenty seconds after the camera and lasts fifteen minutes; the camera twenty.
  const clockMaps = [mapFor(session, clock, 'track-screen', sec(20))]
  const coverages = ['track-camera-main', 'track-screen'].map((trackId) => coverageFor(session, trackId))
  const diagnostic = diagnosticFor(session, [{ trackId: 'track-screen', offsetMs: 20_000 }])
  const evidence = createMulticamEvidenceSet({
    session,
    observations: observations ?? [
      observe('track-camera-main', [100, 160], 'demonstration', { surface: 'screen' }),
      observe('track-screen', [100, 160], 'screen-activity', { activityBps: 8_000 }, 0.95),
      observe('track-camera-main', [400, 430], 'demonstration', { surface: 'screen' }),
    ],
    generatedAt: at(130),
  })
  const inputs = { session, coverages, clockMaps, diagnostic, protocolCeiling: null, evidence, format: { aspectRatio: '16:9' }, generatedAt: at(140) }
  return { session, clock, coverages, clockMaps, diagnostic, evidence, inputs, direct: (overrides = {}) => directMulticam({ ...inputs, ...overrides }) }
}

test('T-FR-150 golden 2: the screen wins during a demonstration and the direction returns to the teacher afterwards', () => {
  const world = teacherWorld()
  const direction = world.direct()
  assert.deepEqual(sequence(direction), [
    ['track-camera-main', 0, 100],
    ['track-screen', 100, 160],
    ['track-camera-main', 160, 400],
    ['track-screen', 400, 430],
    ['track-camera-main', 430, 1_200],
  ])
  assert.deepEqual(direction.shots.map((shot) => shot.rule), [
    'conservative-hold',
    'demonstration-prefers-screen',
    'cutaway-return',
    'demonstration-prefers-screen',
    'cutaway-return',
  ])
  const resolved = resolveDirectionPolicy(DEFAULT_DIRECTION_POLICY, world.session.clock.timebase)
  for (const shot of direction.shots) {
    assert.ok(shot.sessionRange.end - shot.sessionRange.start >= resolved.minimumShotTicks, `${shot.shotId} is shorter than the minimum shot`)
    assert.equal(shot.audioTrackId, 'track-camera-main', 'without a recorder the teacher camera is the audio bed')
  }
  assert.equal(direction.manualReviewRequired, false)
  assert.deepEqual(direction.warnings, [])

  const compiled = compileShotsToSourceRanges(direction, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: world.coverages })
  const screenClip = compiled.clips[1]
  // Screen ticks are milliseconds: session 100 s is screen 80 000 ms → frame 2400 at 30 fps, in the part's own index.
  assert.equal(screenClip.sourceAssetId, 'asset-screen')
  assert.equal(screenClip.sourceInFrame, 2_400)
  assert.equal(screenClip.sourceOutFrame, 4_200)
  assert.equal(screenClip.cameraId, 'track-screen')
  assert.equal(screenClip.audioSourceAssetId, 'asset-cam-main')
  assert.equal(screenClip.audioSourceInFrame, 3_000)
  assert.equal(screenClip.audioSourceOutFrame, 4_800)
  assert.equal(compiled.durationFrames, 1_200 * 30)
  assert.deepEqual(compiled.sources.map((source) => [source.sourceAssetId, source.durationFrames]), [['asset-cam-main', 36_000], ['asset-screen', 27_000]])
  console.log(`golden-2 teacher shots=${compiled.clips.length} durationFrames=${compiled.durationFrames} screenIn=${screenClip.sourceInFrame}`)
})

test('T-FR-150 golden 2: the screen is never selected before it started recording, even during a demonstration', () => {
  const world = teacherWorld({
    observations: [observe('track-camera-main', [5, 40], 'demonstration', { surface: 'screen' })],
  })
  const direction = world.direct()
  // Screen coverage begins at session 20 s: the demonstration before that has no screen to cut to.
  assert.deepEqual(sequence(direction), [
    ['track-camera-main', 0, 20],
    ['track-screen', 20, 40],
    ['track-camera-main', 40, 1_200],
  ])
  const early = deriveAngleCandidates({ ...world.inputs, window: createTickInterval(sec(5), sec(20)), previousShot: null })
  const screen = early.find((candidate) => candidate.trackId === 'track-screen')
  assert.equal(screen.eligible, false)
  assert.deepEqual(screen.rejectionReasons, ['sync-uncovered'])
  assert.equal(screen.sourceRange, null)
  assert.ok(screen.scoreComponents.demonstration.value > 0, 'the rejected candidate still shows the evidence that argued for it')
})

// ---------------------------------------------------------------------------
// React: a reference video and a reactor's phone that started five seconds earlier.
// ---------------------------------------------------------------------------

function reactWorld({ observations } = {}) {
  const reference = track({ trackId: 'track-reference', role: 'reference-video', deviceId: 'dev-player', assetId: 'asset-reference', coverage: createTickInterval(t(0), sec(300)) })
  const reaction = track({ trackId: 'track-reaction', role: 'reaction', deviceId: 'dev-phone', assetId: 'asset-reaction', coverage: createTickInterval(t(0), sec(320)), syncAudioPolicy: 'final-candidate', includeInFinalMix: true })
  const { session, clock } = buildSession({
    referenceTrack: reference,
    others: [reaction],
    clockAuthority: { origin: 'operator-selected', sourceId: 'asset-reference', provenance: 'original-capture', evidenceRef: 'operator:editor-1' },
  })
  const clockMaps = [mapFor(session, clock, 'track-reaction', -sec(5))]
  const coverages = ['track-reference', 'track-reaction'].map((trackId) => coverageFor(session, trackId))
  const diagnostic = diagnosticFor(session, [{ trackId: 'track-reaction', offsetMs: -5_000 }])
  const evidence = createMulticamEvidenceSet({
    session,
    observations: observations ?? [
      observe('track-reaction', [60, 63], 'reaction', { intensityBps: 8_000 }),
      observe('track-reaction', [200, 210], 'reaction', { intensityBps: 9_000 }),
      observe('track-reaction', [250, 251], 'reaction', { intensityBps: 2_000 }),
    ],
    generatedAt: at(130),
  })
  const inputs = { session, coverages, clockMaps, diagnostic, protocolCeiling: null, evidence, format: { aspectRatio: '16:9' }, generatedAt: at(140) }
  return { session, clock, coverages, clockMaps, diagnostic, evidence, inputs, direct: (overrides = {}) => directMulticam({ ...inputs, ...overrides }) }
}

test('T-FR-150 golden 3: a reaction earns a cutaway of at least the minimum and at most the cap, then returns', () => {
  const world = reactWorld()
  const direction = world.direct()
  assert.deepEqual(sequence(direction), [
    ['track-reference', 0, 60],
    ['track-reaction', 60, 63],
    ['track-reference', 63, 200],
    ['track-reaction', 200, 204],
    ['track-reference', 204, 300],
  ])
  assert.deepEqual(direction.shots.map((shot) => shot.rule), [
    'conservative-hold',
    'reaction-cutaway',
    'cutaway-return',
    'reaction-cutaway',
    'cutaway-return',
  ])
  const resolved = resolveDirectionPolicy(DEFAULT_DIRECTION_POLICY, world.session.clock.timebase)
  for (const shot of direction.shots.filter((entry) => entry.chosen.context === 'reaction')) {
    const duration = shot.sessionRange.end - shot.sessionRange.start
    assert.ok(duration >= resolved.minimumShotTicks && duration <= resolved.maxCutawayTicks, `${shot.shotId} lasts ${duration} ticks`)
  }
  // A reaction below the intensity floor earns nothing: no shot at 250 s.
  assert.ok(!direction.shots.some((shot) => seconds(shot.sessionRange.start) === 250))
  // The reactor's phone carries the delivered audio; the reference video cannot reach the mix.
  assert.equal(direction.audio.trackId, 'track-reaction')
  for (const shot of direction.shots) assert.equal(shot.audioTrackId, 'track-reaction')

  const compiled = compileShotsToSourceRanges(direction, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: world.coverages })
  // Reaction source runs five seconds ahead of the session: session 60 s is reaction 65 s → frame 1950.
  assert.equal(compiled.clips[1].sourceAssetId, 'asset-reaction')
  assert.equal(compiled.clips[1].sourceInFrame, 1_950)
  assert.equal(compiled.clips[1].sourceOutFrame, 2_040)
  assert.equal(compiled.clips[0].audioSourceAssetId, 'asset-reaction')
  assert.equal(compiled.clips[0].audioSourceInFrame, 150)
  assert.equal(compiled.clips[0].audioSourceOutFrame, 150 + 1_800)
  // One file is both an angle and the audio bed here. It is listed once, with
  // BOTH its uses — recording only the last use a shot made of it threw the
  // other away, and the integration builds `DirectedEditPlan.sources[]` from
  // this list without re-deriving it.
  assert.deepEqual(compiled.sources.map((source) => [source.sourceAssetId, source.kinds]), [
    ['asset-reaction', ['audio', 'video']],
    ['asset-reference', ['video']],
  ])
  console.log(`golden-3 react shots=${compiled.clips.length} durationFrames=${compiled.durationFrames} reactionKinds=${compiled.sources[0].kinds.join('+')}`)
})

// ---------------------------------------------------------------------------
// Coverage gap in the middle of camera B.
// ---------------------------------------------------------------------------

test('T-FR-150 golden 4: a recorder gap in camera B is a rejection with both the sync and the coverage reason, and no shot touches it', () => {
  // B's guest speaks straight through the gap, so nothing but the missing
  // material can explain the direction leaving B — and returning to it.
  const world = podcastWorld({
    cameraBGap: true,
    observations: [speaks('track-mic-a', [1, 120]), speaks('track-mic-b', [120, 400]), speaks('track-mic-a', [400, 560])],
  })
  // Camera B source [200 s, 230 s) is missing; with its 30 s offset that is session [230 s, 260 s).
  const inGap = deriveAngleCandidates({ ...world.inputs, window: createTickInterval(sec(235), sec(255)), previousShot: null })
  const cameraB = inGap.find((candidate) => candidate.trackId === 'track-camera-b')
  assert.equal(cameraB.eligible, false)
  assert.deepEqual(cameraB.rejectionReasons, ['coverage-gap', 'sync-uncovered'])
  assert.equal(cameraB.coverage.availability, 'gap')
  assert.equal(cameraB.coverage.confidenceBps, null, 'a gap has no confidence, not a zero one')
  assert.equal(cameraB.sourceRange, null)
  const cameraA = inGap.find((candidate) => candidate.trackId === 'track-camera-a')
  assert.equal(cameraA.eligible, true)
  for (const rejection of cameraB.rejectionReasons) assert.ok(ANGLE_REJECTIONS.includes(rejection))

  const direction = world.direct()
  assert.deepEqual(sequence(direction), [
    ['track-camera-a', 1, 120],
    ['track-camera-b', 120, 230],
    ['track-camera-a', 230, 260],
    ['track-camera-b', 260, 400],
    ['track-camera-a', 400, 560],
  ])
  const gap = createTickInterval(sec(230), sec(260))
  for (const shot of direction.shots.filter((entry) => entry.chosen.trackId === 'track-camera-b')) {
    assert.ok(shot.sessionRange.end <= gap.start || shot.sessionRange.start >= gap.end, `${shot.shotId} intersects camera B's gap`)
  }
  const fallback = direction.shots[2]
  assert.equal(fallback.rule, 'conservative-hold', 'losing the speaker\'s camera is a fallback, not a preference')
  assert.equal(fallback.confidenceBand, 'medium')
  assert.equal(direction.manualReviewRequired, false)
  assert.deepEqual(direction.uncovered, [])

  const compiled = compileShotsToSourceRanges(direction, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: world.coverages })
  // The second file of camera B is its own asset, counted from its own first frame.
  const afterGap = compiled.clips[3]
  assert.equal(afterGap.sourceAssetId, 'asset-cam-b-2')
  assert.equal(afterGap.partId, 'part-track-camera-b-2')
  assert.equal(afterGap.sourceInFrame, 0)
  assert.equal(afterGap.sourceOutFrame, 140 * 30)
  assert.ok(compiled.sources.some((source) => source.sourceAssetId === 'asset-cam-b-2'))
  console.log(`golden-4 gap shots=${compiled.clips.length} gapRange=${seconds(gap.start)}-${seconds(gap.end)} uncovered=${direction.uncovered.length}`)
})

test('T-FR-150 golden 4: when every camera is out of coverage the range stays uncovered and cannot be compiled', () => {
  const world = podcastWorld({ range: createTickInterval(t(0), sec(560)) })
  const direction = world.direct()
  // Camera A begins at session 0.5 s and camera B at 30 s: the first half second has no angle.
  assert.deepEqual(direction.uncovered.map((entry) => [entry.start, entry.end]), [[t(0), t(45_000)]])
  assert.equal(direction.manualReviewRequired, true)
  assert.ok(direction.warnings.some((warning) => warning.code === 'no-eligible-candidate'))
  assert.equal(direction.shots[0].sessionRange.start, t(45_000))
  // A direction with holes constructs, hashes and verifies — ticks are serialized before hashing.
  assert.equal(assertMulticamDirectionIntegrity(direction), direction)
  assert.throws(
    () => compileShotsToSourceRanges(direction, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1) }),
    (error) => error.code === 'DIRECTION_RANGE_UNRESOLVABLE' && Array.isArray(error.details.uncovered),
  )
})

// ---------------------------------------------------------------------------
// Protected selection.
// ---------------------------------------------------------------------------

test('T-FR-150 golden 5: a protected selection on A during B\'s speech is kept and named', () => {
  const world = podcastWorld({
    protectedSelections: [{ selectionId: 'selection-1', trackId: 'track-camera-a', sessionRange: createTickInterval(sec(130), sec(150)), reason: 'the host reaction matters more than the speaker', attestedBy: 'editor-1' }],
  })
  const direction = world.direct()
  assert.deepEqual(sequence(direction), [
    ['track-camera-a', 1, 120],
    ['track-camera-b', 120, 130],
    ['track-camera-a', 130, 150],
    ['track-camera-b', 150, 250],
    ['track-camera-a', 250, 400],
    ['track-camera-b', 400, 560],
  ])
  const kept = direction.shots[2]
  assert.equal(kept.rule, 'protected-selection')
  assert.deepEqual(kept.chosen.protected, { selectionId: 'selection-1', reason: 'the host reaction matters more than the speaker' })
  assert.ok(kept.reason.includes('editor-1'))
  assert.equal(kept.chosen.scoreComponents.protectedBonus.value, DEFAULT_DIRECTION_POLICY.weights.protectedBonus)
  assert.equal(direction.manualReviewRequired, false)
})

test('T-FR-150 golden 5: a protected selection that lost coverage is not honoured silently', () => {
  // Camera A's recorder stopped at 125 s and came back at 155 s (source), i.e. session [125.5 s, 155.5 s).
  const world = podcastWorld({
    cameraAGap: true,
    protectedSelections: [{ selectionId: 'selection-1', trackId: 'track-camera-a', sessionRange: createTickInterval(sec(130), sec(150)), reason: 'keep the host', attestedBy: 'editor-1' }],
  })
  const direction = world.direct()
  const violation = direction.warnings.find((warning) => warning.code === 'protected-selection-ineligible')
  assert.ok(violation, 'the direction must say the selection could not be honoured')
  assert.equal(violation.trackId, 'track-camera-a')
  assert.ok(violation.detail.includes('coverage-gap') && violation.detail.includes('sync-uncovered'))
  assert.equal(direction.manualReviewRequired, true)
  // Nothing cut to camera A inside its gap, protected or not.
  for (const shot of direction.shots.filter((entry) => entry.chosen.trackId === 'track-camera-a')) {
    assert.ok(shot.sessionRange.end <= ms(125_500) || shot.sessionRange.start >= ms(155_500), `${shot.shotId} cuts to camera A in its gap`)
  }
  assert.ok(!direction.shots.some((shot) => shot.rule === 'protected-selection'))
})

// ---------------------------------------------------------------------------
// Ambiguous active speaker.
// ---------------------------------------------------------------------------

test('T-FR-150 golden 6: two speakers at once are ambiguous — the direction holds, drops to a low band and asks for review', () => {
  const world = podcastWorld({
    observations: [
      speaks('track-mic-a', [1, 100]),
      ...[100, 110, 120, 130, 140, 150, 160, 170, 180, 190].flatMap((from) => [
        speaks('track-mic-a', [from, from + 10], 0.8),
        speaks('track-mic-b', [from, from + 10], 0.8),
      ]),
      observe('track-master-audio', [100, 200], 'concurrent-speech', { speakerCount: 2 }, 0.85),
      speaks('track-mic-b', [200, 300]),
    ],
    range: createTickInterval(sec(1), sec(300)),
  })
  const direction = world.direct()
  assert.deepEqual(sequence(direction), [
    ['track-camera-a', 1, 200],
    ['track-camera-b', 200, 300],
  ])
  const held = direction.shots[0]
  assert.ok(held.confidenceBand === 'low' || held.confidenceBand === 'insufficient', `${held.confidence} is ${held.confidenceBand}`)
  assert.equal(direction.manualReviewRequired, true)
  const ambiguity = direction.warnings.filter((warning) => warning.code === 'ambiguous-active-speaker')
  assert.ok(ambiguity.length >= 1)
  assert.ok(ambiguity.every((warning) => warning.shotId === held.shotId))
  // Ten contested windows, one shot: the direction never alternated.
  assert.equal(direction.shots.filter((shot) => seconds(shot.sessionRange.start) >= 100 && seconds(shot.sessionRange.start) < 200).length, 0)
})

test('T-FR-150 an active speaker on a recorder bound to no camera cannot name an angle', () => {
  const world = podcastWorld({
    observations: [speaks('track-master-audio', [1, 560])],
  })
  const direction = world.direct()
  const unmapped = direction.warnings.find((warning) => warning.code === 'active-speaker-unmapped')
  assert.ok(unmapped)
  assert.equal(direction.shots.length, 1)
  assert.equal(direction.shots[0].rule, 'conservative-hold')
  assert.equal(direction.shots[0].chosen.activeSpeaker, null, 'the recorder\'s cluster is not attributed to either camera')
  assert.equal(direction.manualReviewRequired, true)
})

// ---------------------------------------------------------------------------
// Rules 4, 5 and 8 in isolation.
// ---------------------------------------------------------------------------

test('T-FR-150 rule 4: two redundant angles with equal evidence are not switched without gain', () => {
  const world = podcastWorld({ observations: [] })
  const direction = world.direct()
  assert.equal(direction.shots.length, 1)
  assert.equal(direction.shots[0].chosen.trackId, 'track-camera-a')
  assert.equal(direction.shots[0].rule, 'conservative-hold')
  assert.equal(direction.shots[0].confidenceBand, 'medium')
  assert.equal(direction.manualReviewRequired, false)
  const alternative = direction.shots[0].alternatives.find((entry) => entry.trackId === 'track-camera-b')
  assert.ok(alternative.rejectedBecause.includes('redundant-angles-hold'))
})

test('T-FR-150 rule 5: a same-angle discontinuity is covered by the other angle and never cut silently', () => {
  // Camera B changed card without losing a frame while B is the only speaker:
  // the material is continuous but the source is two files, so B → B across the
  // boundary is a cut from an angle to itself.
  const world = podcastWorld({
    cameraBRestart: true,
    observations: [speaks('track-mic-b', [1, 560])],
  })
  const direction = world.direct()
  const seq = sequence(direction)
  // Camera A covers the discontinuity for the policy's jump-cut length at 230 s, then B returns.
  const cover = direction.shots.find((shot) => shot.rule === 'jump-cut-avoided')
  assert.ok(cover, `expected a jump-cut cover in ${JSON.stringify(seq)}`)
  assert.equal(cover.chosen.trackId, 'track-camera-a')
  assert.equal(seconds(cover.sessionRange.start), 230)
  assert.equal(seconds(cover.sessionRange.end), 232)
  const next = direction.shots[cover.ordinal + 1]
  assert.equal(next.chosen.trackId, 'track-camera-b')
  assert.equal(seconds(next.sessionRange.start), 232)
  assert.ok(!direction.warnings.some((warning) => warning.code === 'jump-cut-unavoidable'))
  for (let index = 1; index < direction.shots.length; index += 1) {
    assert.notEqual(direction.shots[index].chosen.trackId, direction.shots[index - 1].chosen.trackId, 'no two consecutive shots share a track')
  }
})

test('T-FR-150 rule 5: when nothing else is eligible the jump cut stays and is reported', () => {
  const world = teacherWorld({ observations: [] })
  // Give the teacher camera a restart and make the screen ineligible everywhere by withholding its coverage.
  let session = addCaptureSessionTrackPart(world.session, {
    trackId: 'track-camera-main',
    part: part({ partId: 'part-cam-2', ordinal: 1, sourceAssetId: 'asset-cam-main-2', coverage: createTickInterval(sec(1_210), sec(1_500)), splitReason: 'recorder-restart' }),
    lineage: { ...LINEAGE, operation: 'add-track-part', commandId: 'command-part-cam-2' },
  })
  const coverages = [coverageFor(session, 'track-camera-main')]
  const diagnostic = diagnosticFor(session, [{ trackId: 'track-screen', offsetMs: 20_000 }])
  const evidence = createMulticamEvidenceSet({ session, observations: [], generatedAt: at(130) })
  const direction = directMulticam({ session, coverages, clockMaps: [], diagnostic, protocolCeiling: null, evidence, format: { aspectRatio: '16:9' }, generatedAt: at(140), range: createTickInterval(sec(1_100), sec(1_400)) })
  assert.deepEqual(sequence(direction), [
    ['track-camera-main', 1_100, 1_200],
    ['track-camera-main', 1_210, 1_400],
  ])
  assert.deepEqual(direction.uncovered.map((entry) => [seconds(entry.start), seconds(entry.end)]), [[1_200, 1_210]])
  const jump = direction.warnings.find((warning) => warning.code === 'jump-cut-unavoidable')
  assert.ok(jump)
  assert.equal(jump.shotId, direction.shots[1].shotId)
  assert.equal(direction.manualReviewRequired, true)
  const screen = deriveAngleCandidates({ session, coverages, clockMaps: [], diagnostic, protocolCeiling: null, evidence, window: createTickInterval(sec(1_100), sec(1_150)), previousShot: null })
    .find((candidate) => candidate.trackId === 'track-screen')
  assert.deepEqual(screen.rejectionReasons, ['coverage-missing', 'sync-map-missing'])
})

test('T-FR-150 rule 8: the minimum shot length holds an angle through a brief speaker change', () => {
  const world = podcastWorld({
    observations: [
      speaks('track-mic-a', [1, 120]),
      speaks('track-mic-b', [120, 120.5].map((value) => value), 0.9),
      speaks('track-mic-a', [121, 300]),
    ],
    range: createTickInterval(sec(1), sec(300)),
  })
  // A half-second interjection is shorter than the minimum shot: the direction must not cut to it and back.
  const direction = world.direct()
  assert.equal(direction.shots.length, 2, JSON.stringify(sequence(direction)))
  assert.equal(direction.shots[0].chosen.trackId, 'track-camera-a')
  assert.equal(direction.shots[1].chosen.trackId, 'track-camera-b')
  assert.equal(direction.shots[1].sessionRange.start, sec(120))
  assert.equal(direction.shots[1].rule, 'speech-prefers-active-speaker')
  assert.ok(direction.shots[1].sessionRange.end - direction.shots[1].sessionRange.start >= millisecondsToTicks(DEFAULT_DIRECTION_POLICY.minimumShotMs, TB))
  assert.ok(direction.shots[1].alternatives.some((entry) => entry.rejectedBecause.includes('minimum-shot-hold')))
})

test('T-FR-150 rule 8: a vertical output format penalizes the wide context and the policy names every number', () => {
  const world = podcastWorld({ observations: [] })
  // With no evidence a wide (unmapped) camera and a speaker camera are separated only by baseline and format.
  const candidates = deriveAngleCandidates({ ...world.inputs, format: { aspectRatio: '9:16' }, window: createTickInterval(sec(10), sec(20)), previousShot: null })
  const cameraA = candidates.find((candidate) => candidate.trackId === 'track-camera-a')
  assert.equal(cameraA.context, 'wide', 'a camera no observation ever mapped to is wide, not a speaker')
  assert.equal(cameraA.scoreComponents.formatPenalty.value, -(1 - 0.5) * DEFAULT_DIRECTION_POLICY.contextBaseline.wide)
  const resolved = resolveDirectionPolicy(DEFAULT_DIRECTION_POLICY, TB)
  assert.equal(resolved.minimumShotTicks, t(108_000))
  assert.equal(resolved.maxCutawayTicks, t(360_000))
  assert.equal(millisecondsToTicks(1_000, timebaseFromRate(1_000)), t(1_000))
  assert.throws(
    () => resolveDirectionPolicy({ ...DEFAULT_DIRECTION_POLICY, maxCutawayMs: 100 }, TB),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  for (const rule of DIRECTION_RULES) assert.equal(typeof rule, 'string')
})

// ---------------------------------------------------------------------------
// Gates that must never be bypassed.
// ---------------------------------------------------------------------------

test('T-FR-150 an unverified range never enters auto-switch and a below-floor range is a rejection with its bps', () => {
  const world = podcastWorld()
  const session = world.session
  const cameraA = session.tracks.find((entry) => entry.trackId === 'track-camera-a')
  const doubtful = createTrackCoverage({
    workspaceId: WORKSPACE,
    trackId: 'track-camera-a',
    derivedFrom: captureSessionDerivationRef(session),
    timebase: TB,
    claims: cameraA.parts.map((piece) => ({ partId: piece.partId, ordinal: piece.ordinal, timebase: TB, interval: piece.coverage, confidenceBps: 9_800, evidence: { kind: 'packet-scan', ref: 'probe-a' } })),
    defects: [{ availability: 'unverified', interval: createTickInterval(sec(100), sec(200)), evidence: { kind: 'operator-report', ref: 'nobody probed this stretch' } }],
  })
  const weak = coverageFor(session, 'track-camera-b', { confidenceBps: 6_000 })
  const coverages = [world.coverages[0], doubtful, weak]
  const candidates = deriveAngleCandidates({ ...world.inputs, coverages, window: createTickInterval(sec(150), sec(160)), previousShot: null })
  const a = candidates.find((candidate) => candidate.trackId === 'track-camera-a')
  const b = candidates.find((candidate) => candidate.trackId === 'track-camera-b')
  assert.deepEqual(a.rejectionReasons, ['coverage-unverified'])
  assert.equal(a.coverage.availability, 'unverified')
  assert.deepEqual(b.rejectionReasons, ['coverage-below-floor'])
  assert.equal(b.coverage.confidenceBps, 6_000)
  const direction = directMulticam({ ...world.inputs, coverages })
  for (const shot of direction.shots) {
    if (shot.chosen.trackId === 'track-camera-a') assert.ok(shot.sessionRange.end <= ms(100_500) || shot.sessionRange.start >= ms(200_500))
    assert.notEqual(shot.chosen.trackId, 'track-camera-b', 'a below-floor camera is never chosen')
  }
})

test('T-FR-150 a session that is not auto-editable only admits tracks that are synchronized on their own', () => {
  const world = podcastWorld()
  const diagnostic = diagnosticFor(world.session, [
    { trackId: 'track-camera-a', offsetMs: 500 },
    // Camera B never aligned: no offset, no residual → needs-input, and the session with it.
    { trackId: 'track-camera-b', offsetMs: null, residualMs: null, confidence: 0.2, coverageBps: null },
  ])
  assert.equal(diagnostic.status, 'needs-input')
  const direction = world.direct({ diagnostic })
  assert.ok(direction.warnings.some((warning) => warning.code === 'session-not-auto-editable'))
  assert.ok(direction.shots.every((shot) => shot.chosen.trackId === 'track-camera-a'))
  const b = direction.shots[0].alternatives.find((entry) => entry.trackId === 'track-camera-b')
  assert.ok(b.rejectedBecause.includes('sync-below-threshold'))
  assert.equal(direction.manualReviewRequired, true)

  const ceiling = world.direct({ protocolCeiling: 'manual-anchors-required' })
  assert.equal(ceiling.shots.length, 0)
  assert.ok(ceiling.uncovered.length === 1)
  assert.ok(ceiling.warnings.some((warning) => warning.code === 'no-eligible-candidate' && warning.detail.includes('protocol-ceiling')))
})

test('T-FR-150 derivations of another session version are refused before any candidate is derived', () => {
  const world = podcastWorld()
  // Each stale input is a REAL derivation — built by its own constructor, its
  // own hash intact — so what is refused is the version it names, not a broken
  // hash. A `{ ...spread, field: other }` here would have been refused by the
  // integrity check below and proved nothing about staleness.
  const older = diagnosticFor(world.session, [
    { trackId: 'track-camera-a', offsetMs: 500 },
    { trackId: 'track-camera-b', offsetMs: 30_000, coverageBps: 9_000, residualMs: 12 },
  ], { sessionVersion: world.session.version - 1 })
  assert.equal(older.sessionVersion, world.session.version - 1)
  assert.throws(() => world.direct({ diagnostic: older }), (error) => error.code === 'CAPTURE_SESSION_DERIVATION_STALE')
  const staleCoverage = createTrackCoverage({
    workspaceId: WORKSPACE,
    trackId: 'track-camera-a',
    derivedFrom: { ...captureSessionDerivationRef(world.session), referenceEpoch: 2 },
    timebase: TB,
    claims: [{ partId: 'part-track-camera-a', ordinal: 0, timebase: TB, interval: createTickInterval(t(0), sec(600)), confidenceBps: 9_800, evidence: { kind: 'packet-scan', ref: 'probe-a' } }],
  })
  assert.throws(() => world.direct({ coverages: [world.coverages[0], staleCoverage, world.coverages[2]] }), (error) => error.code === 'CAPTURE_SESSION_DERIVATION_STALE')
  // A genuine evidence set built over a session that has since gained a part.
  const staleEvidence = podcastWorld({ cameraBGap: true }).evidence
  assert.notEqual(staleEvidence.sessionVersion, world.session.version)
  assert.throws(() => world.direct({ evidence: staleEvidence }), (error) => error.code === 'CAPTURE_SESSION_DERIVATION_STALE')
})

test('T-FR-150 every measurement is re-verified against its own hash before the direction copies it', () => {
  const world = podcastWorld()
  // `directMulticam` stamps `diagnosticHash` and `evidenceHash` into the body it
  // hashes. If it trusted them, a body edited under a stale hash would seal a
  // false provenance that `assertMulticamDirectionIntegrity` then confirms.
  const tamperedDiagnostic = { ...world.diagnostic, protocolCeiling: 'manual-anchors-required' }
  assert.throws(
    () => world.direct({ diagnostic: tamperedDiagnostic }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
    'a diagnostic whose body no longer matches its hash never reaches the direction',
  )
  const tamperedEvidence = { ...world.evidence, observations: world.evidence.observations.map((entry) => ({ ...entry, confidence: 0.2 })) }
  assert.throws(() => world.direct({ evidence: tamperedEvidence }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const tamperedCoverage = { ...world.coverages[1], available: world.coverages[1].available.map((entry) => ({ ...entry, confidenceBps: 10_000 })) }
  assert.throws(() => world.direct({ coverages: [world.coverages[0], tamperedCoverage, world.coverages[2]] }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const tamperedMap = { ...world.clockMaps[0], pieces: world.clockMaps[0].pieces.map((piece) => ({ ...piece, confidence: 'low' })) }
  assert.throws(() => world.direct({ clockMaps: [tamperedMap, world.clockMaps[1]] }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  // The compile step reads the same measurements and re-verifies them too.
  const direction = world.direct()
  assert.throws(
    () => compileShotsToSourceRanges(direction, { session: world.session, clockMaps: [tamperedMap, world.clockMaps[1]], planFps: rational(30, 1) }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.throws(
    () => compileShotsToSourceRanges(direction, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: [tamperedCoverage] }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('T-FR-150 a range no part covers is refused even when one clock-map piece spans it', () => {
  // The map and the parts are separate derivations. A fitter that saw
  // continuous ticks across a recorder restart produces one piece spanning the
  // whole file, and the only thing standing between the direction and material
  // the recorder never wrote is the part check. Everywhere else in this suite
  // the coverage gate or `isSessionRangeResolvable` refuses first, so that
  // check is never the gate under test — here both are deliberately silent.
  const world = podcastWorld({ cameraAGap: true })
  const source = createSourceClock({ sourceId: 'asset-cam-a', timebase: TB, provenance: 'original-capture' })
  const oneWidePiece = createPiecewiseClockMap({
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    sourceId: 'asset-cam-a',
    clock: world.clock,
    derivedFrom: { sessionVersion: world.session.version, referenceEpoch: world.session.referenceEpoch },
    pieces: [{
      pieceId: 'track-camera-a-piece-0',
      mapping: createSourceToSessionMapping({
        clock: world.clock,
        source,
        sourceCoverage: createTickInterval(t(0), sec(600)),
        driftRate: rational(1),
        offsetTicks: t(45_000),
        residualBoundTicks: t(0),
        confidence: 'high',
        anchorIds: ['anchor-track-camera-a'],
        evidenceRefs: ['marker-track-camera-a'],
      }),
    }],
  })
  // A coverage with no defect anywhere in the file: the coverage gate has
  // nothing to say about the hole, because nobody measured a hole.
  const clean = createTrackCoverage({
    workspaceId: WORKSPACE,
    trackId: 'track-camera-a',
    derivedFrom: captureSessionDerivationRef(world.session),
    timebase: TB,
    claims: [{ partId: 'part-track-camera-a', ordinal: 0, timebase: TB, interval: createTickInterval(t(0), sec(600)), confidenceBps: 9_800, evidence: { kind: 'packet-scan', ref: 'probe-a' } }],
  })
  const inputs = {
    ...world.inputs,
    coverages: [world.coverages[0], clean, world.coverages[2]],
    clockMaps: [oneWidePiece, world.clockMaps[1]],
  }
  // Camera A wrote nothing between source 125 s and 155 s; with its half-second
  // offset that is session 125.5 s to 155.5 s.
  const inHole = deriveAngleCandidates({ ...inputs, window: createTickInterval(sec(130), sec(150)), previousShot: null })
    .find((candidate) => candidate.trackId === 'track-camera-a')
  assert.equal(inHole.eligible, false)
  assert.equal(inHole.sourceRange, null, 'no source range is invented for material that was never written')
  assert.deepEqual([...inHole.rejectionReasons], ['sync-uncovered'], 'the part check is the only gate that fired')
  assert.deepEqual([clean.gaps.length, clean.corrupt.length, clean.unverified.length], [0, 0, 0], 'the coverage measured no defect anywhere in the file')
  assert.equal(inHole.coverage.availability, 'unmeasured', 'with no source range there is nothing to ask the coverage about, and nothing is guessed')
  // Either side of the hole the same track, map and coverage resolve normally.
  const before = deriveAngleCandidates({ ...inputs, window: createTickInterval(sec(100), sec(120)), previousShot: null })
    .find((candidate) => candidate.trackId === 'track-camera-a')
  assert.equal(before.eligible, true)
  assert.equal(before.sourcePartId, 'part-track-camera-a')
  const after = deriveAngleCandidates({ ...inputs, window: createTickInterval(sec(300), sec(320)), previousShot: null })
    .find((candidate) => candidate.trackId === 'track-camera-a')
  assert.equal(after.eligible, true)
  assert.equal(after.sourcePartId, 'part-track-camera-a-2')
  console.log(`part-gate inHole=${inHole.rejectionReasons.join(',')} before=${before.sourcePartId} after=${after.sourcePartId}`)
})

// ---------------------------------------------------------------------------
// Falsification: a forged eligible candidate over a gap is refused at compile time.
// ---------------------------------------------------------------------------

test('T-FR-150 falsification: a forged eligible candidate over camera B\'s gap passes the hash check and is refused by the compiler', () => {
  const world = podcastWorld({ cameraBGap: true })
  const honest = world.direct()
  // The shot the gap forced, found by the gap rather than by ordinal: an index
  // asserts how the runs happened to merge, which is not what is under test.
  const fallback = honest.shots.find((shot) => shot.sessionRange.start <= sec(245) && sec(245) < shot.sessionRange.end)
  assert.ok(fallback, 'some shot covers the middle of camera B\'s gap')
  assert.equal(fallback.chosen.trackId, 'track-camera-a')
  const forgedRange = fallback.sessionRange
  const real = deriveAngleCandidates({ ...world.inputs, window: forgedRange, previousShot: null }).find((candidate) => candidate.trackId === 'track-camera-b')
  assert.equal(real.eligible, false)

  // Somebody writes a direction claiming camera B was fine there, with consistent hashes.
  const { candidateHash: _candidateHash, ...candidateBody } = real
  const forgedBody = {
    ...candidateBody,
    eligible: true,
    rejectionReasons: [],
    sourceRange: createTickInterval(sec(200), sec(230)),
    sourcePieceId: 'track-camera-b-piece-0',
    sourcePartId: 'part-track-camera-b',
    sourcePartAssetId: 'asset-cam-b',
    coverage: { availability: 'available', confidenceBps: 9_000 },
  }
  const forgedCandidate = { ...forgedBody, candidateHash: calculateAngleCandidateHash(forgedBody) }
  const { decisionHash: _decisionHash, ...shotBody } = fallback
  // The forger has to replace camera B in the evaluated window too, not only in
  // `chosen`: since the decided window is retained (ADR-118) a shot whose chosen
  // angle is absent from its own candidates is refused for that alone, and the
  // point here is a forgery the hashes cannot tell from an honest cut.
  const forgedShotBody = {
    ...shotBody,
    chosen: forgedCandidate,
    evaluated: shotBody.evaluated.map((candidate) => (candidate.trackId === 'track-camera-b' ? forgedCandidate : candidate)),
    rule: 'speech-prefers-active-speaker',
  }
  const forgedShot = { ...forgedShotBody, decisionHash: calculateShotDecisionHash(forgedShotBody) }
  const { directionHash: _directionHash, ...directionBody } = honest
  const forgedDirectionBody = { ...directionBody, shots: honest.shots.map((shot) => (shot.shotId === fallback.shotId ? forgedShot : shot)) }
  const forged = { ...forgedDirectionBody, directionHash: calculateMulticamDirectionHash(forgedDirectionBody) }

  assert.equal(assertMulticamDirectionIntegrity(forged), forged, 'the hash cannot tell a forged eligibility from a real one')
  assert.throws(
    () => compileShotsToSourceRanges(forged, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1) }),
    (error) => error.code === 'DIRECTION_RANGE_UNRESOLVABLE'
      && error.details.shotId === fallback.shotId
      && error.details.trackId === 'track-camera-b'
      && error.details.cause === 'in-discontinuity',
    'the map refuses the forged range without consulting anybody\'s eligibility flag',
  )
  // And a shot whose map is continuous but whose coverage turns out to be
  // corrupt is refused by the coverage gate. The defect is placed over the
  // source range the direction ACTUALLY cut — read off the chosen candidate —
  // rather than over a session interval the shots were assumed to span, so the
  // assertion cannot pass or fail on how the runs happened to merge.
  const damaged = honest.shots.find((shot) => shot.chosen.trackId === 'track-camera-a')
  assert.ok(damaged && damaged.chosen.sourceRange, 'the direction cut camera A somewhere')
  const corrupt = createTrackCoverage({
    workspaceId: WORKSPACE,
    trackId: 'track-camera-a',
    derivedFrom: captureSessionDerivationRef(world.session),
    timebase: TB,
    claims: [{ partId: 'part-track-camera-a', ordinal: 0, timebase: TB, interval: createTickInterval(t(0), sec(600)), confidenceBps: 9_800, evidence: { kind: 'packet-scan', ref: 'probe-a' } }],
    defects: [{ availability: 'corrupt', interval: damaged.chosen.sourceRange, evidence: { kind: 'decoder-walk', ref: 'decoder reported broken GOP' } }],
  })
  assert.throws(
    () => compileShotsToSourceRanges(honest, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: [corrupt] }),
    (error) => error.code === 'DIRECTION_RANGE_UNRESOLVABLE'
      && error.details.cause === 'coverage-corrupt'
      && error.details.shotId === damaged.shotId
      && error.details.trackId === 'track-camera-a',
    'the shot named in the refusal is the shot whose material is broken',
  )
})

test('T-FR-150 a tampered direction fails integrity; one tick of difference is a different hash', () => {
  const world = podcastWorld()
  const direction = world.direct()
  const tampered = { ...direction, shots: direction.shots.map((shot, index) => (index === 0 ? { ...shot, audioTrackId: null } : shot)) }
  assert.throws(() => assertMulticamDirectionIntegrity(tampered), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const oneTick = world.direct({ range: createTickInterval(sec(1) + t(1), sec(560)) })
  assert.notEqual(oneTick.directionHash, direction.directionHash)
  assert.notEqual(oneTick.shots[0].decisionHash, direction.shots[0].decisionHash)
  assert.equal(oneTick.shots.length, direction.shots.length)
  // JSON with tagged ticks survives: the storage encoding the integration will use.
  const roundTrip = JSON.parse(JSON.stringify(direction, (_key, value) => (typeof value === 'bigint' ? { $tick: value.toString() } : value)))
  assert.equal(roundTrip.shots[0].sessionRange.start.$tick, '90000')
})

test('T-FR-150 falsification: the direction hash binds which angle each shot chose, and everything under it', () => {
  const world = podcastWorld()
  const honest = world.direct()
  const shot = honest.shots[1]
  assert.equal(shot.chosen.trackId, 'track-camera-b')
  // A forgery that keeps shotId, ordinal, sessionRange and audioTrackId and
  // swaps only the angle — with the candidate and shot hashes recomputed so the
  // artifact is internally consistent. If the direction hash did not bind the
  // choice, this would be the same bytes as the honest direction.
  const alternative = deriveAngleCandidates({ ...world.inputs, window: shot.sessionRange, previousShot: null })
    .find((candidate) => candidate.trackId === 'track-camera-a')
  assert.equal(alternative.eligible, true, 'camera A really could have been cut there — the forgery is plausible')
  const reseal = (changes) => {
    const { decisionHash: _decisionHash, ...shotBody } = shot
    // Swapping the angle means swapping it in the retained window as well —
    // `assertMulticamDirectionIntegrity` refuses a shot cut to a candidate it
    // never evaluated — so the forgery stays internally consistent and only the
    // hash is left to tell it apart.
    const swapped = changes.chosen
      ? { evaluated: shotBody.evaluated.map((candidate) => (candidate.trackId === changes.chosen.trackId ? changes.chosen : candidate)) }
      : {}
    const forgedShotBody = { ...shotBody, ...swapped, ...changes }
    const forgedShot = { ...forgedShotBody, decisionHash: calculateShotDecisionHash(forgedShotBody) }
    const { directionHash: _directionHash, ...body } = honest
    const forgedBody = { ...body, shots: honest.shots.map((entry) => (entry.shotId === shot.shotId ? forgedShot : entry)) }
    return { ...forgedBody, directionHash: calculateMulticamDirectionHash(forgedBody) }
  }
  const swappedAngle = reseal({ chosen: alternative })
  assert.equal(swappedAngle.shots[1].shotId, shot.shotId)
  assert.equal(swappedAngle.shots[1].ordinal, shot.ordinal)
  assert.equal(swappedAngle.shots[1].audioTrackId, shot.audioTrackId)
  assert.deepEqual(swappedAngle.shots[1].sessionRange, shot.sessionRange)
  assert.equal(assertMulticamDirectionIntegrity(swappedAngle), swappedAngle, 'the forgery is internally consistent — only the hash can tell')
  assert.notEqual(swappedAngle.directionHash, honest.directionHash, 'the direction hash binds the chosen track')
  // Each field the shot decided by is bound on its own, and so is everything the
  // shot hash covers but the direction body does not name.
  assert.notEqual(reseal({ rule: 'conservative-hold' }).directionHash, honest.directionHash, 'the rule that decided the shot is bound')
  assert.notEqual(reseal({ confidence: 0.5 }).directionHash, honest.directionHash, 'the confidence is bound')
  assert.notEqual(reseal({ reason: 'because somebody said so' }).directionHash, honest.directionHash, 'the shot hash reaches the direction hash')
  console.log(`falsify honest=${honest.directionHash.slice(0, 12)} swapped=${swappedAngle.directionHash.slice(0, 12)}`)
})

test('T-FR-150 a shot maps to the Director decision shape with evidence, alternatives and the angle category', () => {
  const direction = podcastWorld().direct()
  const decision = toAngleDecision(direction.shots[1])
  assert.equal(decision.category, 'angle')
  assert.equal(decision.choice, 'track-camera-b')
  assert.ok(decision.evidenceRefs.length >= 1 && decision.evidenceRefs.length <= 32)
  assert.ok(decision.evidenceRefs.every((ref) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(ref)), 'refs satisfy the decision-confidence REF grammar')
  assert.ok(decision.alternatives.some((entry) => entry.startsWith('track-camera-a:')))
  assert.ok(decision.alternatives.some((entry) => entry.includes('not-a-video-source')))
  assert.equal(decision.confidence, direction.shots[1].confidence)
  assert.deepEqual(['high', 'medium', 'low', 'insufficient'].map((band) => band), [0.85, 0.65, 0.4, 0.39].map(directionConfidenceBand))
})

test('T-FR-150 a densely evidenced shot keeps the refs that made it legal and records how many it dropped', () => {
  // Forty-one observations inside one shot: more than the 32 a Director decision
  // may carry (`decision-confidence.ts:41-43`). Sorting the whole set and taking
  // the first 32 dropped exactly the two gate refs, because `observation:` sorts
  // before `sync-diagnostic:` and `track-coverage:`.
  const dense = Array.from({ length: 41 }, (_, index) => speaks('track-mic-a', [1 + index * 5, 6 + index * 5]))
  const direction = podcastWorld({ observations: dense }).direct()
  const shot = direction.shots[0]
  assert.equal(shot.chosen.trackId, 'track-camera-a')
  assert.equal(shot.evidenceRefs.length, 32)
  assert.ok(shot.evidenceRefs.includes(`sync-diagnostic:${SESSION}:v1`), 'the shot still cites the diagnostic that let it be cut')
  assert.ok(shot.evidenceRefs.includes('track-coverage:track-camera-a'), 'the shot still cites the coverage that let it be cut')
  const observations = shot.evidenceRefs.filter((ref) => ref.startsWith('observation:'))
  assert.equal(observations.length, 30, 'the observations fill exactly what the two reserved gate refs leave')
  assert.ok(shot.evidenceRefsTruncated > 0, 'the drop is recorded, not inferred')
  assert.equal(observations.length + shot.evidenceRefsTruncated, shot.chosen.scoreComponents.speaker.evidenceRefs.length)
  assert.ok(shot.evidenceRefs.every((ref) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(ref)))
  assert.equal(toAngleDecision(shot).evidenceRefs.length, 32, 'the Director decision boundary is satisfied by construction')
  // A shot that cited everything says so with a zero, and a stored shot whose
  // two numbers contradict each other is refused on read.
  for (const honest of podcastWorld().direct().shots) assert.equal(honest.evidenceRefsTruncated, 0)
  const lying = { ...direction, shots: [{ ...shot, evidenceRefs: shot.evidenceRefs.slice(0, 5), evidenceRefsTruncated: 27 }] }
  assert.throws(() => assertMulticamDirectionIntegrity(lying), (error) => error.code === 'PERSISTENCE_CONFLICT')
  console.log(`refs shot=${shot.shotId} cited=${shot.evidenceRefs.length} dropped=${shot.evidenceRefsTruncated}`)
})

// ---------------------------------------------------------------------------
// Evidence set.
// ---------------------------------------------------------------------------

test('T-FR-150 evidence: nothing is invented — zero magnitudes, foreign tracks and resolved identities are refused', () => {
  const { session } = podcastWorld()
  const valid = createMulticamEvidenceSet({ session, observations: [speaks('track-mic-a', [1, 10])], generatedAt: at(1) })
  assert.equal(valid.sessionVersion, session.version)
  assert.equal(assertMulticamEvidenceSetIntegrity(valid), valid)
  assert.equal(MULTICAM_EVIDENCE_KINDS.length, 8)
  const refuse = (observation, code = 'INVALID_ARGUMENT') =>
    assert.throws(() => createMulticamEvidenceSet({ session, observations: [observation], generatedAt: at(1) }), (error) => error.code === code)
  refuse(observe('track-camera-a', [1, 2], 'reaction', { intensityBps: 0 }))
  refuse(observe('track-screen', [1, 2], 'screen-activity', { activityBps: 5_000 }), 'CAPTURE_TRACK_NOT_FOUND')
  refuse(observe('track-mic-a', [1, 2], 'active-speaker', { speakerKey: 'x', identityResolved: true }))
  refuse(observe('track-camera-a', [1, 2], 'technical-quality', { sharpnessBps: null, stabilityBps: null, exposureBps: null }))
  refuse({ ...speaks('track-mic-a', [1, 10]), confidence: Number.NaN })
  refuse({ ...speaks('track-mic-a', [1, 10]), range: { start: 10, end: 20 } })
  refuse({ ...speaks('track-mic-a', [1, 10]), range: createTickInterval(sec(10), sec(20)), value: { kind: 'silence', levelDbfs: null } })
  const tampered = { ...valid, observations: valid.observations.map((entry) => ({ ...entry, confidence: 0.1 })) }
  assert.throws(() => assertMulticamEvidenceSetIntegrity(tampered), (error) => error.code === 'PERSISTENCE_CONFLICT')
})

// ---------------------------------------------------------------------------
// Camera identity.
// ---------------------------------------------------------------------------

test('T-FR-150 camera identity folds a track id into the ColorPlan token grammar, deterministically, and refuses collisions', () => {
  assert.equal(colorCameraIdForTrack({ trackId: 'Cam/A:Main' }), 'cam-a-main')
  assert.equal(colorCameraIdForTrack({ trackId: 'track-camera-a' }), 'track-camera-a')
  assert.equal(colorCameraIdForTrack({ trackId: 'Cam/A:Main' }), colorCameraIdForTrack({ trackId: 'Cam/A:Main' }))
  assert.ok(CAMERA_ID_TOKEN.test(colorCameraIdForTrack({ trackId: 'X.y_z:9/w' })))
  const source = readFileSync(fileURLToPath(new URL('../../src/v2/domain/color-and-export.ts', import.meta.url)), 'utf8')
  const token = /const TOKEN = (\/[^\n]+\/)\n/.exec(source)
  assert.ok(token, 'color-and-export.ts declares the TOKEN grammar')
  assert.equal(`/${CAMERA_ID_TOKEN.source}/`, token[1], 'the camera key grammar is the ColorPlan token grammar')
  const { session } = podcastWorld()
  const ids = colorCameraIdsForSession(session)
  assert.equal(ids.get('track-camera-a'), 'track-camera-a')
  assert.equal(ids.size, session.tracks.length)
  const collide = { sessionId: SESSION, tracks: [{ trackId: 'cam/a' }, { trackId: 'cam-a' }] }
  assert.throws(() => colorCameraIdsForSession(collide), (error) => error.code === 'CAMERA_IDENTITY_COLLISION' && error.details.trackIds.length === 2)
})

// ---------------------------------------------------------------------------
// Source frames belong to the source's cadence, not the plan's.
// ---------------------------------------------------------------------------

test('T-FR-150 source frames are counted at the track\'s own frame rate, and a cadence the renderer cannot cut is refused', () => {
  const world = podcastWorld()
  const direction = world.direct()
  // Everything was shot at 60 fps and the plan runs at 60 fps: source frames are
  // counted through the part's own timebase (90 kHz ticks), not assumed.
  const compiled = compileShotsToSourceRanges(direction, {
    session: world.session,
    clockMaps: world.clockMaps,
    planFps: rational(60, 1),
    coverages: world.coverages,
    sourceFrameRates: ['track-camera-a', 'track-camera-b', 'track-master-audio'].map((trackId) => ({ trackId, frameRate: rational(60, 1) })),
  })
  const [first, second] = compiled.clips
  assert.equal(first.trackId, 'track-camera-a')
  // Session [1 s, 120 s) is camera A source [0.5 s, 119.5 s): frame 30 at 60 fps,
  // where a 30 fps reading would have trimmed at frame 15 — half a minute of
  // material earlier by the end of a long shot.
  assert.equal(first.sourceInFrame, 30)
  assert.equal(first.sourceOutFrame, 7_170)
  assert.deepEqual(first.sourceFrameRate, rational(60, 1))
  assert.equal(first.timelineOutFrame - first.timelineInFrame, 119 * 60)
  assert.equal(first.audioSourceInFrame, 60)
  assert.equal(first.audioSourceOutFrame - first.audioSourceInFrame, first.sourceOutFrame - first.sourceInFrame)
  assert.equal(second.sourceInFrame, 5_400)
  const cameraA = compiled.sources.find((source) => source.sourceAssetId === 'asset-cam-a')
  assert.deepEqual(cameraA.frameRate, rational(60, 1))
  assert.equal(cameraA.durationFrames, 600 * 60)
  assert.equal(compiled.durationFrames, (560 - 1) * 60)
  // The same direction compiled at two plan cadences is two different files.
  const atThirty = compileShotsToSourceRanges(direction, { session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: world.coverages })
  assert.notEqual(compiled.compilationHash, atThirty.compilationHash)
  assert.equal(atThirty.durationFrames, (560 - 1) * 30)

  // A track whose media cadence differs from the plan's is refused HERE, where
  // an operator can act on it. The renderer trims video by source frame index
  // (`:752`) and audio by plan-fps index (`:737-738`), then demands the two
  // spans be equal (`:578`) — only true when the two cadences agree. Emitting
  // the clip would either desynchronize the audio by the ratio of the rates or
  // die at render time as INVALID_RENDER_INPUT.
  assert.throws(
    () => compileShotsToSourceRanges(direction, {
      session: world.session,
      clockMaps: world.clockMaps,
      planFps: rational(30, 1),
      coverages: world.coverages,
      sourceFrameRates: [{ trackId: 'track-camera-a', frameRate: rational(60, 1) }],
    }),
    (error) => error.code === 'DIRECTION_SOURCE_CADENCE_UNSUPPORTED'
      && error.details.trackId === 'track-camera-a'
      && error.details.sourceFrameRate === '60/1'
      && error.details.planFps === '30/1',
    'a 60 fps source under a 30 fps plan is refused, not silently desynchronized',
  )
  // Every clip that IS emitted satisfies the renderer's own predicate.
  for (const clip of [...compiled.clips, ...atThirty.clips]) {
    assert.equal(clip.audioSourceOutFrame - clip.audioSourceInFrame, clip.sourceOutFrame - clip.sourceInFrame)
    assert.equal(clip.timelineOutFrame - clip.timelineInFrame, clip.sourceOutFrame - clip.sourceInFrame)
  }
  assert.throws(
    () => compileShotsToSourceRanges(direction, {
      session: world.session,
      clockMaps: world.clockMaps,
      planFps: rational(30, 1),
      sourceFrameRates: [{ trackId: 'track-camera-a', frameRate: rational(60, 1) }, { trackId: 'track-camera-a', frameRate: rational(50, 1) }],
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
    'two rates for one track is a contradiction, not a last-one-wins',
  )
  console.log(`source-cadence camA in=${first.sourceInFrame} out=${first.sourceOutFrame} timeline=${first.timelineOutFrame - first.timelineInFrame} camB in=${second.sourceInFrame}`)
})

test('T-FR-150 every direction refusal is a domain error code the public envelope can carry', () => {
  for (const code of ['DIRECTION_RANGE_UNRESOLVABLE', 'DIRECTION_SOURCE_CADENCE_UNSUPPORTED', 'CAMERA_IDENTITY_COLLISION']) {
    assert.ok(DOMAIN_ERROR_CODES.includes(code), `${code} is a domain error code`)
    // The catalog refuses to build unless every code is classified exactly
    // once, so importing it at all is the proof; the assertions name what a
    // caller will see.
    assert.equal(PUBLIC_ERROR_CATALOG[code].status, 422)
    assert.equal(PUBLIC_ERROR_CATALOG[code].category, 'policy')
    assert.equal(PUBLIC_ERROR_CATALOG[code].retryable, false)
  }
})

test('T-FR-150 falsification: the evaluated window is checked in its own right, not only by the shot hash', () => {
  // Every guard `assertMulticamDirectionIntegrity` puts on `shot.evaluated` sits
  // BEHIND the shot hash, so a reviewer who only tampers with storage never
  // reaches them — the hash refuses first. The forger here has code access: each
  // forgery is resealed all the way up (candidate → shot → direction) so it is
  // internally consistent, which is exactly the artifact a bug in this module or
  // a repair script would write. Without the guards, five of the six below are
  // accepted as an honest cut.
  const world = podcastWorld()
  const honest = world.direct()
  const shot = honest.shots[0]
  assert.ok(shot.evaluated.length >= 3, 'the shot really did weigh several angles')

  const reseal = (evaluated, chosen = shot.chosen) => {
    const { decisionHash: _decisionHash, ...shotBody } = shot
    const forgedShotBody = { ...shotBody, chosen, evaluated }
    const forgedShot = { ...forgedShotBody, decisionHash: calculateShotDecisionHash(forgedShotBody) }
    const { directionHash: _directionHash, ...body } = honest
    const forgedBody = { ...body, shots: honest.shots.map((entry) => (entry.shotId === shot.shotId ? forgedShot : entry)) }
    return { ...forgedBody, directionHash: calculateMulticamDirectionHash(forgedBody) }
  }
  const refuses = (forged, fragment, why) => {
    assert.throws(
      () => assertMulticamDirectionIntegrity(forged),
      (error) => error.code === 'PERSISTENCE_CONFLICT' && new RegExp(fragment).test(error.message),
      why,
    )
  }
  // The shot hash is genuinely satisfied by each of these, so the guards are
  // what refuses them and not the arithmetic above.
  const selfConsistent = (forged) => {
    const { decisionHash, ...body } = forged.shots.find((entry) => entry.shotId === shot.shotId)
    assert.equal(calculateShotDecisionHash(body), decisionHash, 'the forgery reseals its own shot hash')
    const { directionHash, ...directionBody } = forged
    assert.equal(calculateMulticamDirectionHash(directionBody), directionHash, 'and the direction hash above it')
  }

  // 1. One angle counted twice — a duplicated candidateId lets a rejected angle
  //    also appear as an eligible one, and a reviewer reading the table sees two
  //    rows that disagree about the same camera.
  const duplicated = reseal([...shot.evaluated, shot.evaluated[0]])
  selfConsistent(duplicated)
  refuses(duplicated, 'evaluated candidate .* twice', 'a candidate counted twice is refused')

  // 2. The list out of the order the hash covers. `ordinal` is what the database
  //    stores, so a permuted list is what a repair script writes.
  const permuted = reseal([shot.evaluated[1], shot.evaluated[0], ...shot.evaluated.slice(2)])
  selfConsistent(permuted)
  refuses(permuted, 'not in track order', 'the retained order is checked, not assumed')

  // 3. A candidate whose eligibility contradicts its own reasons: the one field
  //    a reviewer reads to decide whether a camera can be trusted again.
  const rejected = shot.evaluated.find((candidate) => !candidate.eligible)
  assert.ok(rejected, 'this shot rejected something')
  const liarBody = { ...withoutHash(rejected), eligible: true }
  const liar = { ...liarBody, candidateHash: calculateAngleCandidateHash(liarBody) }
  const lying = reseal(shot.evaluated.map((candidate) => (candidate.candidateId === liar.candidateId ? liar : candidate)))
  selfConsistent(lying)
  refuses(lying, 'claims eligibility its rejection reasons contradict', 'eligible with reasons is a contradiction, not a row')

  // 4. A candidate describing another range: evidence smuggled in from a
  //    different instant of the session, with every hash in order.
  const elsewhere = deriveAngleCandidates({
    ...world.inputs,
    window: createTickInterval(shot.sessionRange.end, shot.sessionRange.end + (shot.sessionRange.end - shot.sessionRange.start)),
    previousShot: null,
  }).find((candidate) => candidate.trackId === rejected.trackId)
  assert.ok(elsewhere && elsewhere.sessionRange.start !== shot.sessionRange.start)
  const foreign = reseal(shot.evaluated.map((candidate) => (candidate.trackId === elsewhere.trackId ? elsewhere : candidate)))
  selfConsistent(foreign)
  refuses(foreign, 'describes another range', 'a candidate weighed over a different window is refused')

  // 5. A candidate whose body no longer produces its own hash — the shape a
  //    hand-edited row takes once somebody remembers to reseal the shot but not
  //    the candidate.
  const detached = { ...rejected, rejectionReasons: Object.freeze(['sync-missing']) }
  const unsealed = reseal(shot.evaluated.map((candidate) => (candidate.candidateId === detached.candidateId ? detached : candidate)))
  selfConsistent(unsealed)
  refuses(unsealed, 'hash does not match its body', 'each evaluated candidate is verified in its own right')

  // 6. A shot cut to an angle that is not in the window it says it evaluated:
  //    the record would claim a decision nobody can audit.
  const withoutChosen = shot.evaluated.filter((candidate) => candidate.candidateId !== shot.chosen.candidateId)
  assert.equal(withoutChosen.length, shot.evaluated.length - 1)
  const orphaned = reseal(withoutChosen)
  selfConsistent(orphaned)
  refuses(orphaned, 'which is not among the candidates it evaluated', 'the chosen angle has to be one it weighed')

  // And the honest one still passes, so none of the above is refused by accident.
  assert.equal(assertMulticamDirectionIntegrity(honest), honest)
  console.log(`evaluated guards shot=${shot.shotId} candidates=${shot.evaluated.length} rejected=${shot.evaluated.filter((candidate) => !candidate.eligible).length}`)
})
