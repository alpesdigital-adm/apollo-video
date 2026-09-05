// The domain arrives through `await import`, never a static `import … from
// '….ts'`. tsx — which runs every database-backed suite in this repository —
// resolves a static specifier before it transforms the target, so an `.mjs`
// file that names a `.ts` export statically dies at link time with "does not
// provide an export named …" no matter how correct the export is. The Wave 19
// precedent (sync-diagnostic-persistence.e2e.mjs) reaches the domain the same
// way, and both loaders — plain `node` and `tsx` — link this shape.
const {
  addCaptureSessionTrack,
  addCaptureSessionTrackPart,
  captureSessionDerivationRef,
  createCaptureSession,
} = await import('../../src/v2/domain/capture-session.ts')
const { evaluateColorCritic } = await import('../../src/v2/domain/color-critic-report.ts')
const { createCameraColorMeasurement } = await import('../../src/v2/domain/color-measurement.ts')
const { createMulticamEvidenceSet } = await import('../../src/v2/domain/multicam-evidence.ts')
const { directMulticam } = await import('../../src/v2/domain/multicam-direction.ts')
const { deriveMulticamMatchPlan } = await import('../../src/v2/domain/multicam-match-plan.ts')
const { createPiecewiseClockMap } = await import('../../src/v2/domain/piecewise-clock-map.ts')
const {
  applyPlaybackAnchor,
  buildPlaybackMap,
  createPlaybackPolicy,
} = await import('../../src/v2/domain/playback-map.ts')
const {
  createSessionClock,
  createSourceClock,
  createSourceToSessionMapping,
} = await import('../../src/v2/domain/session-clock.ts')
const { createTickInterval, rational, timebaseFromRate } = await import('../../src/v2/domain/session-time.ts')
const { createSyncDiagnostic, deriveTrackStatus } = await import('../../src/v2/domain/sync-diagnostic.ts')
const { createTrackCoverage } = await import('../../src/v2/domain/track-coverage.ts')

/**
 * The Wave 20 aggregates the persistence suites store, built by the domain.
 *
 * Nothing here is hand-written: every hash is the hash the constructor
 * computed, so a round trip that comes back with a different one is a defect in
 * the repository and not in the fixture. That is the whole point — a fixture
 * with a typed-in hash would prove that the database can store a string.
 *
 * Each scenario is deliberately the unhealthy one. The direction runs past the
 * end of both cameras, so it carries an uncovered stretch, a warning and
 * `manualReviewRequired`; the match plan is derived from a camera two and a
 * half stops under its reference, so the correction is clamped and a human is
 * asked; the playback map is a reaction with a pause, a commentary, a replay, a
 * seek and a stretch where the player was hidden. A healthy fixture is the one
 * case a naive implementation also gets right.
 *
 * Lives in its own module rather than inside a test file so the E2E can import
 * it under tsx while a plain `node` run can build the same aggregates without a
 * database in sight.
 */

const HZ = 90_000
const TB = timebaseFromRate(HZ)
const tick = (value) => BigInt(value)
const ms = (value) => tick(90) * tick(Math.round(value))
const sec = (value) => ms(value * 1_000)
const sha = (seed) => seed.repeat(64).slice(0, 64)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1_000).toISOString()

// ---------------------------------------------------------------------------
// F4.012 — a session, its derivations, and a direction that runs out of camera
// ---------------------------------------------------------------------------

function part(overrides = {}) {
  return {
    partId: 'part-1',
    ordinal: 0,
    sourceAssetId: 'asset-1',
    timebase: TB,
    coverage: createTickInterval(tick(0), sec(600)),
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: {
      ingestArtifactId: 'artifact-1',
      ingestSha256: sha('a'),
      probeHash: sha('b'),
      probeSource: 'packet-scan',
      observedAt: at(0),
    },
    ...overrides,
  }
}

function track({ trackId, role, deviceId, assetId, coverage, syncAudioPolicy = 'sync-only', includeInFinalMix = false }) {
  return {
    trackId,
    role,
    device: { deviceId, recorderId: `rec-${deviceId}`, make: null, model: null, serial: null },
    sourceAssetId: assetId,
    timebase: TB,
    streamIndex: 0,
    syncAudioPolicy,
    includeInFinalMix,
    parts: [part({ partId: `part-${trackId}`, sourceAssetId: assetId, coverage })],
  }
}

function lineage(operation, commandId) {
  return { commandId, operation, actorKind: 'human', actorId: 'operator-1', occurredAt: at(0), note: null }
}

function coverageFor(workspaceId, session, trackId) {
  const entry = session.tracks.find((candidate) => candidate.trackId === trackId)
  return createTrackCoverage({
    workspaceId,
    trackId,
    derivedFrom: captureSessionDerivationRef(session),
    timebase: entry.timebase,
    claims: entry.parts.map((piece) => ({
      partId: piece.partId,
      ordinal: piece.ordinal,
      timebase: piece.timebase,
      interval: piece.coverage,
      confidenceBps: 9_800,
      evidence: { kind: 'packet-scan', ref: `probe-${piece.partId}` },
    })),
  })
}

function mapFor(workspaceId, sessionId, session, clock, trackId, offsetTicks) {
  const entry = session.tracks.find((candidate) => candidate.trackId === trackId)
  const source = createSourceClock({
    sourceId: entry.sourceAssetId,
    timebase: entry.timebase,
    provenance: 'original-capture',
  })
  const anchored = offsetTicks !== tick(0)
  return createPiecewiseClockMap({
    workspaceId,
    sessionId,
    sourceId: entry.sourceAssetId,
    clock,
    derivedFrom: { sessionVersion: session.version, referenceEpoch: session.referenceEpoch },
    pieces: entry.parts.map((piece) => ({
      pieceId: `${trackId}-piece-${piece.ordinal}`,
      // A piece that follows another has to say what opened it, and a cause
      // that means "the source stopped producing time" has to show the gap
      // (`piecewise-clock-map.ts:224-250`). The parts of a restarted track are
      // laid out with a hole between them, so `recorder-restart` is both the
      // true cause and the one the map will accept.
      ...(piece.ordinal === 0
        ? {}
        : {
          openedBy: 'recorder-restart',
          openedByDetail: `the recorder stopped after ${piece.ordinal === 1 ? 'the first' : `part ${piece.ordinal}`} file and came back as a new one`,
        }),
      mapping: createSourceToSessionMapping({
        clock,
        source,
        sourceCoverage: piece.coverage,
        driftRate: rational(1),
        offsetTicks,
        residualBoundTicks: tick(0),
        confidence: 'high',
        anchorIds: anchored ? [`anchor-${trackId}`] : [],
        evidenceRefs: anchored ? [`marker-${trackId}`] : [],
      }),
    })),
  })
}

function observe(trackId, [fromSecond, toSecond], kind, value) {
  const id = `obs-${kind}-${trackId}-${fromSecond}-${toSecond}`
  return {
    observationId: id,
    trackId,
    range: createTickInterval(sec(fromSecond), sec(toSecond)),
    kind,
    value: { kind, ...value },
    confidence: 0.9,
    provenance: {
      method: `fixture/${kind}`,
      evaluatorKind: 'controlled',
      evidenceRef: `run:${id}`,
      producedAt: at(0),
    },
  }
}

const speaks = (trackId, range) =>
  observe(trackId, range, 'active-speaker', { speakerKey: `cluster-${trackId}`, identityResolved: false })

/**
 * A podcast whose two cameras stop at 300 s while the recorder runs to 600 s,
 * directed over [0 s, 400 s).
 *
 * The last hundred seconds have no eligible angle at all, which is what makes
 * this fixture worth storing: `uncovered` is non-empty, a warning names it, and
 * `manualReviewRequired` is therefore true rather than declared — the exact
 * three columns `multicam_directions_manual_review_check` ties together.
 */
export function buildDirectionWorld({ workspaceId, sessionId, projectId }) {
  const master = track({
    trackId: 'track-master-audio',
    role: 'master-audio',
    deviceId: 'dev-rec',
    assetId: 'asset-master',
    coverage: createTickInterval(tick(0), sec(600)),
    syncAudioPolicy: 'final-candidate',
    includeInFinalMix: true,
  })
  const cameraA = track({
    trackId: 'track-camera-a',
    role: 'camera-main',
    deviceId: 'dev-a',
    assetId: 'asset-cam-a',
    coverage: createTickInterval(tick(0), sec(300)),
  })
  const cameraB = track({
    trackId: 'track-camera-b',
    role: 'camera-main',
    deviceId: 'dev-b',
    assetId: 'asset-cam-b',
    coverage: createTickInterval(tick(0), sec(300)),
  })
  const micA = track({
    trackId: 'track-mic-a',
    role: 'microphone',
    deviceId: 'dev-a',
    assetId: 'asset-mic-a',
    coverage: createTickInterval(tick(0), sec(600)),
  })
  const micB = track({
    trackId: 'track-mic-b',
    role: 'microphone',
    deviceId: 'dev-b',
    assetId: 'asset-mic-b',
    coverage: createTickInterval(tick(0), sec(600)),
  })

  let session = createCaptureSession({
    workspaceId,
    projectId,
    sessionId,
    clock: { timebase: TB, rounding: 'nearest-half-even' },
    referenceTrackId: master.trackId,
    tracks: [master],
    lineage: lineage('create-session', 'command-create'),
    createdAt: at(0),
  })
  for (const [index, entry] of [cameraA, cameraB, micA, micB].entries()) {
    session = addCaptureSessionTrack(session, {
      track: entry,
      lineage: lineage('add-track', `command-add-${index}`),
    })
  }

  const clock = createSessionClock({
    sessionId,
    timebase: TB,
    frameRate: rational(30, 1),
    authority: {
      origin: 'master-audio',
      sourceId: 'asset-master',
      provenance: 'original-capture',
      evidenceRef: 'probe-master',
    },
    establishedAt: at(0),
  })

  const clockMaps = [
    mapFor(workspaceId, sessionId, session, clock, 'track-camera-a', tick(0)),
    mapFor(workspaceId, sessionId, session, clock, 'track-camera-b', sec(30)),
  ]
  const coverages = ['track-master-audio', 'track-camera-a', 'track-camera-b']
    .map((trackId) => coverageFor(workspaceId, session, trackId))

  const diagnostic = createSyncDiagnostic({
    workspaceId,
    sessionId,
    referenceTrackId: session.referenceTrackId,
    version: 1,
    previousVersionHash: null,
    sessionVersion: session.version,
    referenceEpoch: session.referenceEpoch,
    tracks: [
      { trackId: 'track-camera-a', offsetMs: 0 },
      { trackId: 'track-camera-b', offsetMs: 30_000 },
    ].map(({ trackId, offsetMs }) => {
      const base = {
        trackId,
        methods: ['apollo-marker'],
        confidence: 0.9,
        offsetMs,
        residualMs: 8,
        driftPpm: null,
        coverageBps: 9_800,
        gaps: [],
        automaticAnchors: [],
        manualAnchors: [],
        pieceIds: [],
        warnings: [],
        previewSampleMs: [],
      }
      return { ...base, status: deriveTrackStatus({ ...base, hasContradictoryAnchors: false }) }
    }),
    protocolCeiling: 'automatic',
    generatedAt: at(120),
  })

  const evidence = createMulticamEvidenceSet({
    session,
    observations: [
      speaks('track-mic-a', [1, 120]),
      speaks('track-mic-b', [120, 250]),
      speaks('track-mic-a', [250, 300]),
    ],
    generatedAt: at(130),
  })

  const direction = directMulticam({
    session,
    coverages,
    clockMaps,
    diagnostic,
    protocolCeiling: null,
    evidence,
    format: { aspectRatio: '16:9' },
    range: createTickInterval(sec(1), sec(400)),
    generatedAt: at(140),
  })

  return { session, clock, coverages, clockMaps, diagnostic, evidence, direction }
}

// ---------------------------------------------------------------------------
// F4.013 / F4.014 — measurements, a clamped match plan, and the critic
// ---------------------------------------------------------------------------

const METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

const STATISTICS_EVALUATOR = Object.freeze({ id: 'ffmpeg-rgb24-statistics', kind: 'measured', version: '1.0.0' })
const SKIN_EVALUATOR = Object.freeze({ id: 'ycbcr-skin-band-mask', kind: 'controlled', version: '1.0.0' })

/** BT.709-encoded luma `ev` stops from `base`, at the domain's display gamma. */
export function lumaAtEv(base, ev) {
  return base * 2 ** (ev / 2.2)
}

export function buildMeasurement(overrides = {}) {
  const o = {
    measurementId: 'ccm-a-1',
    sessionId: null,
    sourceAssetId: 'artifact-a',
    sourceSha256: sha('a'),
    cameraId: 'camera-a',
    start: 0,
    end: 1_000,
    startFrame: 0,
    endFrame: 60,
    sampledFrames: 8,
    confidence: 1,
    exposure: 0.5,
    rOverG: 1,
    bOverG: 0.9,
    contrast: 0.2,
    saturation: 0.1,
    blacks: 0.001,
    highlights: 0.001,
    tonal: 0.5,
    skinHue: null,
    ...overrides,
  }
  const evidenceRef = `rawvideo-rgb24:${o.measurementId}`
  const measured = (value, unit, components, evaluator = STATISTICS_EVALUATOR) => ({
    status: 'measured',
    value,
    unit,
    evaluator,
    evidenceRef,
    ...(components ? { components } : {}),
  })
  return createCameraColorMeasurement({
    measurementId: o.measurementId,
    sessionId: o.sessionId,
    sourceAssetId: o.sourceAssetId,
    sourceSha256: o.sourceSha256,
    cameraId: o.cameraId,
    range: createTickInterval(BigInt(o.start), BigInt(o.end)),
    sourceRange: { startFrame: o.startFrame, endFrame: o.endFrame },
    sampledFrames: o.sampledFrames,
    technical: { metadata: METADATA, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    dimensions: {
      whiteBalance: measured(o.bOverG / o.rOverG, 'ratio', { rOverG: o.rOverG, bOverG: o.bOverG, bOverR: o.bOverG / o.rOverG }),
      exposure: measured(o.exposure, 'normalized-luma'),
      contrast: measured(o.contrast, 'normalized-luma', { p5: 0.1, p95: 0.9, spread: 0.8 }),
      blacks: measured(o.blacks, 'ratio', { threshold: 4 / 255 }),
      highlights: measured(o.highlights, 'ratio', { threshold: 251 / 255 }),
      saturation: measured(o.saturation, 'normalized-chroma'),
      tonalResponse: measured(o.tonal, 'normalized-luma', { p1: 0.02, p5: 0.1, p25: 0.3, p50: o.tonal, p75: 0.7, p95: 0.9, p99: 0.98 }),
      // Not measured is not zero: no skin-band pixels means no skin statistic,
      // and the dimension says so in words with no number beside it.
      skin: o.skinHue === null
        ? { status: 'not-applicable', reason: 'fewer than 2% of sampled pixels fall in the skin band; no skin-band region to measure' }
        : measured(o.skinHue, 'degrees', { areaRatio: 0.2, meanY: 0.55, meanCb: 105, meanCr: 150 }, SKIN_EVALUATOR),
    },
    confidence: o.confidence,
  })
}

/**
 * Camera B sits two and a half stops under camera A, which is past
 * `maxExposureCorrectionEv`: the correction is clamped to the policy limit and
 * the plan says a human has to decide. `humanReviewRequired` is therefore
 * derived from an issue rather than declared, which is what
 * `multicam_match_plans_review_check` checks.
 */
export function buildMatchWorld({ workspaceId, projectId, sessionId, sessionVersion = 1 }) {
  const measurements = [
    buildMeasurement({ measurementId: `${sessionId}-ccm-a`, sessionId, cameraId: 'camera-a' }),
    buildMeasurement({
      measurementId: `${sessionId}-ccm-b`,
      sessionId,
      cameraId: 'camera-b',
      sourceAssetId: 'artifact-b',
      sourceSha256: sha('c'),
      exposure: lumaAtEv(0.5, -2.5),
    }),
  ]
  const plan = deriveMulticamMatchPlan({
    planId: `${sessionId}-mmp-1`,
    workspaceId,
    projectId,
    sessionId,
    sessionVersion,
    referenceEpoch: 1,
    referenceCameraId: 'camera-a',
    referenceCameraSelection: {
      selectedBy: { kind: 'director', id: 'director-1' },
      selectedAt: at(0),
      baseVersionId: `${sessionId}:v${sessionVersion}`,
      baseHash: sha('b'),
    },
    measurements,
    lineage: { colorProbeIds: ['probe-a', 'probe-b'] },
    createdAt: at(10),
  })
  return { measurements, plan }
}

/**
 * The critic over the same two cameras, before and after the output transform.
 * The `after` measurements name different bytes, so the two stages are two
 * populations rather than one measured twice.
 */
export function buildCriticReport({ workspaceId, projectId, projectVersionId, reportId, matchPlan }) {
  const stage = (suffix, sourceAssetId, sourceSha256, extra = {}) => [
    buildMeasurement({ measurementId: `${reportId}-${suffix}-a`, cameraId: 'camera-a', sourceAssetId, sourceSha256, ...extra }),
    buildMeasurement({ measurementId: `${reportId}-${suffix}-b`, cameraId: 'camera-b', sourceAssetId, sourceSha256, ...extra }),
  ]
  return evaluateColorCritic({
    reportId,
    workspaceId,
    projectId,
    projectVersionId,
    subject: { kind: 'output', artifactId: 'artifact-output' },
    before: stage('before', 'artifact-intermediate', sha('d')),
    after: stage('after', 'artifact-output', sha('e')),
    ...(matchPlan ? { matchPlan } : {}),
    creativeIntent: { declared: false },
    evaluatedAt: at(100),
  })
}

// ---------------------------------------------------------------------------
// F4.015 — a reaction with a pause, a commentary, a replay and a seek
// ---------------------------------------------------------------------------

const PLAYBACK_POLICY = createPlaybackPolicy({
  calibrationVersion: 'react-playback-fixture/2026-09-05',
  reactionTimebase: TB,
  windowMs: 1_000,
  maxPauseMs: 10_000,
  seekThresholdMs: 1_200,
  continuityToleranceMs: 400,
})

function playbackTrack({ trackId, role, assetId, deviceId, endSecond, syncAudioPolicy, includeInFinalMix }) {
  return {
    trackId,
    role,
    device: { deviceId, recorderId: `recorder-${deviceId}`, make: null, model: null, serial: null },
    sourceAssetId: assetId,
    timebase: TB,
    streamIndex: 0,
    syncAudioPolicy,
    includeInFinalMix,
    parts: [part({
      partId: `part-${trackId}`,
      sourceAssetId: assetId,
      coverage: createTickInterval(tick(0), sec(endSecond)),
      evidence: {
        ingestArtifactId: `artifact-${trackId}`,
        ingestSha256: sha(assetId === 'asset-reaction-1' ? 'a' : 'c'),
        probeHash: sha('b'),
        probeSource: 'packet-scan',
        observedAt: at(1),
      },
    })],
  }
}

/**
 * @param uncoveredStretches How many stretches the map leaves for a person.
 *   Two of them is the case that broke persistence: the operator answers the
 *   later one first, `applyPlaybackAnchor` appends, and the anchor array is no
 *   longer in tick order. Anything that re-derives the order on read hands
 *   back a different map than the one that was stored.
 */
export function buildPlaybackWorld({ workspaceId, sessionId, projectId, uncoveredStretches = 1 }) {
  const reaction = playbackTrack({
    trackId: 'track-reaction',
    role: 'reaction',
    assetId: 'asset-reaction-1',
    deviceId: 'device-webcam',
    endSecond: 40,
    syncAudioPolicy: 'final-candidate',
    includeInFinalMix: true,
  })
  const reference = playbackTrack({
    trackId: 'track-reference',
    role: 'reference-video',
    assetId: 'asset-reference-1',
    deviceId: 'device-screen',
    endSecond: 30,
    syncAudioPolicy: 'sync-only',
    includeInFinalMix: false,
  })
  const session = createCaptureSession({
    workspaceId,
    projectId,
    sessionId,
    clock: { timebase: TB, rounding: 'nearest-half-even' },
    referenceTrackId: 'track-reference',
    tracks: [reaction, reference],
    lineage: lineage('create-session', 'command-create-react'),
    createdAt: at(0),
  })

  const referenceMedia = Object.freeze({
    assetId: 'asset-reference-1',
    sha256: sha('c'),
    durationTicks: sec(30),
    timebase: TB,
  })
  const reactionMedia = Object.freeze({
    assetId: 'asset-reaction-1',
    sha256: sha('a'),
    durationTicks: sec(40),
  })

  const observations = []
  const push = (fromSecond, toSecond, referenceSecond) => {
    for (let second = fromSecond; second < toSecond; second += 0.5) {
      const reactionTick = sec(second)
      observations.push({
        reactionTick,
        referenceTick: referenceSecond === null ? null : sec(referenceSecond + (second - fromSecond)),
        confidence: 0.9,
        method: 'audio-fingerprint',
        evidenceRef: `fingerprint:${reactionTick}`,
        peakRatio: 4,
      })
    }
  }
  // With a second stretch asked for, the player is hidden from six to ten
  // seconds and the reference comes back one second AHEAD of where it stopped:
  // played through, paused-then-seeked and scrubbed all fit that evidence, so
  // the map names none of them and asks a person (ADR-135). The one-second
  // shift is carried through the pause that follows, so the rest of the story
  // — the seek back, the seek forward, the hidden stretch at 34s — is the same
  // in both shapes.
  const shift = uncoveredStretches >= 2 ? 1 : 0
  push(0, 6, 0)
  push(6, 10, null)
  push(10, 14, 6 + shift)
  push(14, 25, null)
  push(25, 28, 10 + shift)
  push(28, 31, 2)
  push(31, 34, 20)
  push(34, 36, null)
  push(36, 40, 26)

  const map = buildPlaybackMap({
    mapId: `${sessionId}-playback-1`,
    session,
    reactionTrack: reaction,
    referenceTrack: reference,
    referenceMedia,
    reactionMedia,
    observations,
    policy: PLAYBACK_POLICY,
  })

  // The observations travel with the world. The persistence suites want the
  // map; the F4.015 runtime suite wants what the detector saw, because the
  // service under test is the one that calls a detector — handing it the
  // finished map would test nothing it does.
  return { session, map, referenceMedia, reactionMedia, observations }
}

/**
 * The next version of a map, produced by a person answering one uncovered
 * stretch.
 *
 * `stretch` picks which one. It exists because answering them in tick order is
 * the easy case: a map anchored [late, early] is the one that stopped being
 * readable when the anchors were stored without their position.
 */
export function anchorPlaybackMap(map, { anchorId, actorId, note, createdAt, stretch = 0 }) {
  const target = map.uncovered[stretch]
  if (!target) throw new Error(`the playback fixture has no uncovered stretch ${stretch} to anchor`)
  const reactionTick = target.range.start
  return applyPlaybackAnchor(map, {
    expectedVersion: map.version,
    expectedHash: map.mapHash,
    anchor: {
      anchorId,
      reactionTick,
      referenceTick: null,
      mode: 'commentary-only',
      actorId,
      note,
      createdAt,
    },
  })
}

/**
 * A session that can actually be CUT, for the F4.012 integration lane.
 *
 * `buildDirectionWorld` above is deliberately the unhealthy case: its cameras
 * stop at 300 s while the recorder runs to 600 s, so the direction carries an
 * uncovered stretch and `compileShotsToSourceRanges` refuses it by design. That
 * is the right fixture for persistence and the wrong one for an integration
 * that has to reach a `RenderInput`, so this is its healthy twin — every track
 * covers the same 300 s, every non-reference track has a clock map, and the
 * screen carries measurable activity.
 *
 * It is still not the happy path everywhere: the screen is a third angle with
 * its own context, and the microphones are audio-only tracks bound to cameras by
 * device, which is what makes the active-speaker mapping non-trivial
 * (`speakerCamerasFor`).
 *
 * Two options exist because the default world has no discontinuity anywhere,
 * and a world with no discontinuity cannot tell a clock map from a linear
 * conversion — the whole `resolveSourceTick` limb could be deleted and every
 * suite stayed green. The comment here used to *claim* the first of them
 * ("camera B runs 12 s behind") over five identity maps with `offsetTicks:
 * tick(0)`; now it is a parameter, and the suites that need it ask for it.
 *
 * - `cameraBOffsetSeconds` starts camera B late: its file's t=0 lands at that
 *   session instant, so the map is genuinely anchored (`offsetTicks !== 0`
 *   flips `anchored`), and the opening of the session has no camera-B picture
 *   at all — a real `coverage-*` rejection instead of the audio-only one.
 * - `cameraEndSecond` stops the three pictures before the recorder does, so the
 *   reference track's own hull — what a request that omits `range` directs —
 *   contains instants no camera covered. That is the case the request type
 *   documents at length and the one the compile step then refuses.
 * - `restart` splits one track into two files with a recorder gap between them,
 *   exactly as `addCaptureSessionTrackPart` models it. The clock map then has
 *   two pieces with a hole, so an analysis that straddles the hole resolves to
 *   nothing and must be reported rather than stretched across it, and the
 *   second file only reaches the evidence producer if the producer looks at
 *   parts rather than at `track.sourceAssetId`.
 */
export function buildDirectableMulticamWorld({
  workspaceId,
  sessionId,
  projectId,
  endSecond = 300,
  cameraEndSecond = endSecond,
  cameraBOffsetSeconds = 0,
  restart = null,
}) {
  const span = createTickInterval(tick(0), sec(endSecond))
  const pictureSpan = createTickInterval(tick(0), sec(cameraEndSecond))
  const master = track({
    trackId: 'track-master-audio',
    role: 'master-audio',
    deviceId: 'dev-rec',
    assetId: 'asset-master',
    coverage: span,
    syncAudioPolicy: 'final-candidate',
    includeInFinalMix: true,
  })
  // The restarted track's FIRST file stops early; the second is appended below
  // through the aggregate, so the split reason and the version chain are the
  // ones a real recorder restart produces rather than a hand-written pair.
  const firstSpan = (trackId, whole) => (restart && restart.trackId === trackId
    ? createTickInterval(tick(0), sec(restart.stopSecond))
    : whole)
  const cameraA = track({ trackId: 'track-camera-a', role: 'camera-main', deviceId: 'dev-a', assetId: 'asset-cam-a', coverage: firstSpan('track-camera-a', pictureSpan) })
  const cameraB = track({ trackId: 'track-camera-b', role: 'camera-main', deviceId: 'dev-b', assetId: 'asset-cam-b', coverage: firstSpan('track-camera-b', pictureSpan) })
  const screen = track({ trackId: 'track-screen', role: 'screen', deviceId: 'dev-screen', assetId: 'asset-screen', coverage: firstSpan('track-screen', pictureSpan) })
  const micA = track({ trackId: 'track-mic-a', role: 'microphone', deviceId: 'dev-a', assetId: 'asset-mic-a', coverage: firstSpan('track-mic-a', span) })
  const micB = track({ trackId: 'track-mic-b', role: 'microphone', deviceId: 'dev-b', assetId: 'asset-mic-b', coverage: firstSpan('track-mic-b', span) })

  let session = createCaptureSession({
    workspaceId,
    projectId,
    sessionId,
    clock: { timebase: TB, rounding: 'nearest-half-even' },
    referenceTrackId: master.trackId,
    tracks: [master],
    lineage: lineage('create-session', 'command-create'),
    createdAt: at(0),
  })
  // Every link of the chain is kept, not only the head: a repository that
  // appends versions refuses to start at version 6, so a suite that stores this
  // session has to walk it the way the operator built it.
  const versions = [session]
  for (const [index, entry] of [cameraA, cameraB, screen, micA, micB].entries()) {
    session = addCaptureSessionTrack(session, { track: entry, lineage: lineage('add-track', `command-add-${index}`) })
    versions.push(session)
  }
  if (restart) {
    session = addCaptureSessionTrackPart(session, {
      trackId: restart.trackId,
      part: part({
        partId: `${restart.trackId}-part-2`,
        ordinal: 1,
        sourceAssetId: restart.assetId,
        coverage: createTickInterval(sec(restart.resumeSecond), sec(endSecond)),
        splitReason: 'recorder-restart',
      }),
      lineage: lineage('add-track-part', 'command-restart'),
    })
    versions.push(session)
  }

  const clock = createSessionClock({
    sessionId,
    timebase: TB,
    frameRate: rational(30, 1),
    authority: { origin: 'master-audio', sourceId: 'asset-master', provenance: 'original-capture', evidenceRef: 'probe-master' },
    establishedAt: at(0),
  })

  // Every non-reference track has a map: without one the track resolves to
  // nothing, and a millisecond measured on its file has nowhere to land on the
  // session clock.
  const clockMaps = ['track-camera-a', 'track-camera-b', 'track-screen', 'track-mic-a', 'track-mic-b']
    .map((trackId) => mapFor(
      workspaceId,
      sessionId,
      session,
      clock,
      trackId,
      trackId === 'track-camera-b' ? sec(cameraBOffsetSeconds) : tick(0),
    ))
  const coverages = session.tracks.map((entry) => coverageFor(workspaceId, session, entry.trackId))

  const diagnostic = createSyncDiagnostic({
    workspaceId,
    sessionId,
    referenceTrackId: session.referenceTrackId,
    version: 1,
    previousVersionHash: null,
    sessionVersion: session.version,
    referenceEpoch: session.referenceEpoch,
    tracks: ['track-camera-a', 'track-camera-b', 'track-screen', 'track-mic-a', 'track-mic-b'].map((trackId) => {
      const base = {
        trackId,
        methods: ['apollo-marker'],
        confidence: 0.9,
        offsetMs: 0,
        residualMs: 6,
        driftPpm: null,
        coverageBps: 9_800,
        gaps: [],
        automaticAnchors: [],
        manualAnchors: [],
        pieceIds: [],
        warnings: [],
        previewSampleMs: [],
      }
      return { ...base, status: deriveTrackStatus({ ...base, hasContradictoryAnchors: false }) }
    }),
    protocolCeiling: 'automatic',
    generatedAt: at(120),
  })

  return { session, versions, clock, coverages, clockMaps, diagnostic }
}

export const fixtureInstant = at
export const fixtureSeconds = sec
export const fixtureSha = sha
export const fixtureTicks = tick
export const fixtureTimebase = TB
