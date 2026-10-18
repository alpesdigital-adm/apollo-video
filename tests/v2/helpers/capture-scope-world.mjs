/**
 * Two workspaces that happen to pick the same capture-session, track, source
 * and marker tokens.
 *
 * Every id a caller chooses for a capture session is only unique inside its
 * workspace. This builds the domain objects of one workspace's capture family
 * (session chain, clock, clock map, coverage, sync evidence, protocol
 * evaluation, marker, detection, diagnostic) from tokens the caller passes in,
 * so a suite can build the same family twice with the same tokens and a
 * different `variant`, and then prove that neither copy reads, replaces or
 * collides with the other.
 *
 * `variant` (0 or 1) changes the content of every aggregate that carries a hash,
 * so a row that came back with the wrong owner's hash is detectable by value.
 */

/** Shared by the tokens of every workspace in a suite. */
export function scopeTokens(run) {
  return Object.freeze({
    sessionId: `scope-session-${run}`,
    trackId: `scope-track-main-${run}`,
    phoneTrackId: `scope-track-phone-${run}`,
    sourceId: `scope-source-${run}`,
    markerId: `scope-marker-${run}`,
  })
}

export async function buildScopeWorld({ workspaceId, projectId, tokens, variant }) {
  const { createCaptureSession, addCaptureSessionTrack } = await import('../../../src/v2/domain/capture-session.ts')
  const { PUBLISHED_CAPTURE_PROTOCOLS } = await import('../../../src/v2/domain/capture-protocol-catalog.ts')
  const { evaluateCaptureProtocol } = await import('../../../src/v2/domain/capture-protocol-evaluation.ts')
  const { createPiecewiseClockMap } = await import('../../../src/v2/domain/piecewise-clock-map.ts')
  const {
    createSessionClock,
    createSourceClock,
    createSourceToSessionMapping,
  } = await import('../../../src/v2/domain/session-clock.ts')
  const { createTickInterval, rational, timebaseFromRate } = await import('../../../src/v2/domain/session-time.ts')
  const { evaluateSyncEvidence } = await import('../../../src/v2/domain/sync-evidence.ts')
  const { createSyncDiagnostic, deriveTrackStatus } = await import('../../../src/v2/domain/sync-diagnostic.ts')
  const { fuseMarkerDetections } = await import('../../../src/v2/domain/sync-marker-detection.ts')
  const { createSyncMarker } = await import('../../../src/v2/domain/sync-marker.ts')
  const { createTrackCoverage } = await import('../../../src/v2/domain/track-coverage.ts')

  const { sessionId, trackId, phoneTrackId, sourceId, markerId } = tokens
  const t = (n) => BigInt(n)
  const timebase = timebaseFromRate(90_000)
  const sec = (n) => t(90_000) * t(n)
  const h = (n) => String(n).repeat(64).slice(0, 64)
  const at = (second) => new Date(Date.parse('2029-06-01T09:00:00.000Z') + second * 1_000).toISOString()
  const seconds = 600 + variant * 60

  const track = (id, role, assetId, syncAudioPolicy, includeInFinalMix) => ({
    trackId: id,
    role,
    device: { deviceId: `device-${id}`, recorderId: `recorder-${id}`, make: null, model: null, serial: null },
    sourceAssetId: assetId,
    timebase,
    streamIndex: 0,
    syncAudioPolicy,
    includeInFinalMix,
    parts: [{
      partId: `part-${id}`,
      ordinal: 0,
      sourceAssetId: assetId,
      timebase,
      coverage: createTickInterval(t(0), sec(seconds)),
      streamIndex: 0,
      splitReason: 'single-file',
      evidence: {
        ingestArtifactId: `artifact-${id}`,
        ingestSha256: h(3 + variant),
        probeHash: h(5 + variant),
        probeSource: 'packet-scan',
        observedAt: at(1),
      },
    }],
  })

  const lineage = (commandId, operation, second) => ({
    commandId,
    operation,
    actorKind: 'human',
    actorId: `scope-actor-${variant}`,
    occurredAt: at(second),
    note: null,
  })

  const session1 = createCaptureSession({
    workspaceId,
    projectId,
    sessionId,
    clock: { timebase, rounding: 'nearest-half-even' },
    referenceTrackId: trackId,
    tracks: [track(trackId, 'camera-main', `asset-${trackId}`, 'final-candidate', true)],
    lineage: lineage('command-1', 'create-session', 2),
    createdAt: at(2),
  })
  const session2 = addCaptureSessionTrack(session1, {
    track: track(phoneTrackId, 'phone', `asset-${phoneTrackId}`, 'sync-only', false),
    lineage: lineage('command-2', 'add-track', 3),
  })

  const clock = createSessionClock({
    sessionId,
    timebase,
    frameRate: rational(t(30_000), t(1_001)),
    authority: {
      origin: 'primary-camera',
      sourceId: `asset-${trackId}`,
      provenance: 'original-capture',
      evidenceRef: `probe-${variant}`,
    },
    establishedAt: at(4 + variant),
  })

  const clockMap = createPiecewiseClockMap({
    workspaceId,
    sessionId,
    sourceId,
    clock,
    derivedFrom: { sessionVersion: session2.version, referenceEpoch: session2.referenceEpoch },
    pieces: [{
      pieceId: 'piece-a',
      mapping: createSourceToSessionMapping({
        clock,
        source: createSourceClock({ sourceId, timebase, provenance: 'original-capture' }),
        sourceCoverage: createTickInterval(sec(0), sec(seconds)),
        driftRate: rational(t(1)),
        offsetTicks: t(4_500 * (variant + 1)),
        residualBoundTicks: t(30),
        confidence: 'high',
        anchorIds: ['anchor-1'],
        evidenceRefs: ['probe-phone-1'],
      }),
    }],
  })

  const coverageTimebase = timebaseFromRate(1_000)
  const coverage = createTrackCoverage({
    workspaceId,
    trackId,
    derivedFrom: {
      sessionId,
      sessionVersion: session2.version,
      referenceEpoch: session2.referenceEpoch,
    },
    timebase: coverageTimebase,
    claims: [{
      partId: 'part-1',
      ordinal: 0,
      timebase: coverageTimebase,
      interval: createTickInterval(t(0), t(1_000 * (variant + 1))),
      confidenceBps: 9_500,
      evidence: { kind: 'packet-scan', ref: 'probe-1' },
    }],
  })

  const evidence = evaluateSyncEvidence({
    sessionId,
    trackId: phoneTrackId,
    referenceTrackId: trackId,
    sessionTimebase: timebase,
    sessionFrameRate: rational(t(30_000), t(1_001)),
    sessionBounds: createTickInterval(t(0), sec(seconds)),
    signals: [],
  })

  const protocol = PUBLISHED_CAPTURE_PROTOCOLS[0]
  const evaluation = evaluateCaptureProtocol({
    workspaceId,
    protocol,
    session: session2,
    markers: { confirmedPositions: variant === 0 ? ['start'] : [] },
    evaluatedAt: at(7),
  })

  const marker = createSyncMarker({
    markerId,
    workspaceId,
    sessionId,
    kind: 'audiovisual',
    position: 'start',
    sequence: 1,
    emittedAt: at(8),
  })
  const detection = fuseMarkerDetections({
    marker,
    trackId,
    mode: 'both-channels',
    visual: {
      channel: 'visual',
      observationId: `obs-v-${variant}`,
      trackId,
      atMs: 800 + variant,
      errorMs: 17,
      decodedPayload: marker.payload,
      patternScore: 1,
      confidence: 0.97,
      evidenceRef: 'frame-scan-1',
    },
    audio: {
      channel: 'audio',
      observationId: `obs-a-${variant}`,
      trackId,
      atMs: 802 + variant,
      errorMs: 2,
      correlationPeak: 0.86,
      secondPeak: 0.11,
      confidence: 0.95,
      evidenceRef: 'chirp-1',
    },
  })

  const trackDiagnostic = {
    trackId: phoneTrackId,
    methods: ['marker-correlation'],
    confidence: 0.95,
    offsetMs: -1_240 - variant,
    residualMs: 4,
    driftPpm: null,
    coverageBps: 9_800,
    gaps: [createTickInterval(sec(120), sec(130))],
    automaticAnchors: [{
      anchorId: 'anchor-1',
      origin: 'automatic',
      sourceMs: 800,
      sessionMs: 2_040,
      method: 'marker-correlation',
      confidence: 0.95,
      residualMs: 4,
      evidenceRef: markerId,
      createdAt: at(11),
    }],
    manualAnchors: [],
    pieceIds: ['piece-a'],
    status: deriveTrackStatus({
      offsetMs: -1_240 - variant,
      residualMs: 4,
      coverageBps: 9_800,
      confidence: 0.95,
      hasContradictoryAnchors: false,
    }),
    warnings: [],
    previewSampleMs: [0, 60_000],
  }
  const diagnostic = createSyncDiagnostic({
    workspaceId,
    sessionId,
    referenceTrackId: trackId,
    version: 1,
    previousVersionHash: null,
    sessionVersion: session2.version,
    referenceEpoch: session2.referenceEpoch,
    tracks: [trackDiagnostic],
    protocolCeiling: evaluation.ceiling,
    generatedAt: at(11),
  })

  return Object.freeze({
    at,
    session1,
    session2,
    clock,
    clockMap,
    coverage,
    evidence,
    protocol,
    evaluation,
    marker,
    detection,
    diagnostic,
    attachedById: `scope-actor-${variant}`,
  })
}
