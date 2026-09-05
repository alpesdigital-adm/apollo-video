import assert from 'node:assert/strict'
import test from 'node:test'

import { createCaptureSession } from '../../src/v2/domain/capture-session.ts'
import { PIECE_BOUNDARY_CAUSES } from '../../src/v2/domain/piecewise-clock-map.ts'
import {
  PLAYBACK_DETECTION_METHODS,
  PLAYBACK_DISCONTINUITY_REASONS,
  PLAYBACK_MAP_SCHEMA_VERSION,
  PLAYBACK_MODES,
  applyPlaybackAnchor,
  assertPlaybackMapIntegrity,
  buildPlaybackMap,
  compilePlaybackToShots,
  createPlaybackMap,
  createPlaybackPolicy,
  defaultPlaybackPolicy,
  resolveReactionTick,
} from '../../src/v2/domain/playback-map.ts'
import {
  createTickInterval,
  rational,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'
import {
  MAXIMUM_ABSENCE_CONFIDENCE,
  absenceConfidence,
  confidenceFromPeakRatio,
  correlateAudioWindows,
} from '../../src/v2/infrastructure/media/ffmpeg-playback-fingerprint.ts'

/**
 * F4.015 — the react playback map, invariant by invariant.
 *
 * The fixture that matters here is the *unhealthy* one: a reaction twice as long
 * as the reference, with a pause, a commentary, a replay, a seek and a stretch
 * where the player was hidden. A map that only ever sees continuous playback
 * proves nothing, because continuous playback is the one case a naive
 * implementation also gets right.
 */

const TICKS_PER_SECOND = 90_000n
const REACTION_TIMEBASE = timebaseFromRate(90_000)
const REFERENCE_TIMEBASE = timebaseFromRate(90_000)

const seconds = (value) => BigInt(Math.round(value * 90_000))
const digest = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()

const POLICY = createPlaybackPolicy({
  calibrationVersion: 'react-playback-test/2026-09-04',
  reactionTimebase: REACTION_TIMEBASE,
  windowMs: 1_000,
  maxPauseMs: 10_000,
  seekThresholdMs: 1_200,
  continuityToleranceMs: 400,
})

function part(overrides = {}) {
  return {
    partId: 'part-reaction-1',
    ordinal: 0,
    sourceAssetId: 'asset-reaction-1',
    timebase: REACTION_TIMEBASE,
    coverage: createTickInterval(0n, seconds(40)),
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: {
      ingestArtifactId: 'artifact-reaction-1',
      ingestSha256: digest('a'),
      probeHash: digest('b'),
      probeSource: 'packet-scan',
      observedAt: at(1),
    },
    ...overrides,
  }
}

function reactionTrack() {
  return {
    trackId: 'track-reaction',
    role: 'reaction',
    device: {
      deviceId: 'device-webcam',
      recorderId: 'recorder-obs-1',
      make: 'Logitech',
      model: 'Brio',
      serial: null,
    },
    sourceAssetId: 'asset-reaction-1',
    timebase: REACTION_TIMEBASE,
    streamIndex: 0,
    syncAudioPolicy: 'final-candidate',
    includeInFinalMix: true,
    parts: [part()],
  }
}

function referenceTrack() {
  return {
    trackId: 'track-reference',
    role: 'reference-video',
    device: {
      deviceId: 'device-screen',
      recorderId: 'recorder-obs-2',
      make: null,
      model: null,
      serial: null,
    },
    sourceAssetId: 'asset-reference-1',
    timebase: REFERENCE_TIMEBASE,
    streamIndex: 0,
    syncAudioPolicy: 'sync-only',
    includeInFinalMix: false,
    parts: [part({
      partId: 'part-reference-1',
      sourceAssetId: 'asset-reference-1',
      coverage: createTickInterval(0n, seconds(30)),
      evidence: {
        ingestArtifactId: 'artifact-reference-1',
        ingestSha256: digest('c'),
        probeHash: digest('d'),
        probeSource: 'packet-scan',
        observedAt: at(1),
      },
    })],
  }
}

function reactSession() {
  return createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-react',
    clock: { timebase: REACTION_TIMEBASE, rounding: 'nearest-half-even' },
    referenceTrackId: 'track-reference',
    tracks: [reactionTrack(), referenceTrack()],
    lineage: {
      commandId: 'command-create-session',
      operation: 'create-session',
      actorKind: 'human',
      actorId: 'operator-1',
      occurredAt: at(0),
      note: null,
    },
    createdAt: at(0),
  })
}

const REFERENCE_MEDIA = Object.freeze({
  assetId: 'asset-reference-1',
  sha256: digest('c'),
  durationTicks: seconds(30),
  timebase: REFERENCE_TIMEBASE,
})

const REACTION_MEDIA = Object.freeze({
  assetId: 'asset-reaction-1',
  sha256: digest('a'),
  durationTicks: seconds(40),
})

function observation(reactionSecond, referenceSecond, overrides = {}) {
  const reactionTick = seconds(reactionSecond)
  return {
    reactionTick,
    referenceTick: referenceSecond === null ? null : seconds(referenceSecond),
    confidence: 0.9,
    method: 'audio-fingerprint',
    evidenceRef: `fingerprint:${reactionTick}`,
    peakRatio: 4,
    ...overrides,
  }
}

/**
 * The unhealthy scenario, as a list of windows.
 *
 * playing 0-6 · paused 6-10 · playing 10-14 · commentary 14-25 · playing 25-28 ·
 * replay 28-31 · seek 31-34 · hidden 34-36 · playing 36-40, against a
 * thirty-second reference.
 *
 * Both no-reference stretches resume the reference at the tick it left (6 and
 * 10), which is what makes each of them a pause-class gap at all. The replay
 * therefore follows a *locked* run rather than a gap: a stretch with no
 * reference after which the reference resumes BEHIND is not a pause — "paused
 * then rewound" and "played on unobserved then rewound further back" both fit —
 * and the aggregate leaves it uncovered instead of picking one.
 */
function scenarioObservations() {
  const windows = []
  const push = (fromSecond, toSecond, reference) => {
    for (let tick = fromSecond; tick < toSecond; tick += 0.5) {
      windows.push(observation(tick, reference === null ? null : reference + (tick - fromSecond)))
    }
  }
  push(0, 6, 0)
  push(6, 10, null)
  push(10, 14, 6)
  push(14, 25, null)
  push(25, 28, 10)
  push(28, 31, 2)
  push(31, 34, 20)
  push(34, 36, null)
  push(36, 40, 26)
  return windows
}

function scenarioMap(overrides = {}) {
  return buildPlaybackMap({
    mapId: 'playback-map-1',
    session: reactSession(),
    reactionTrack: reactionTrack(),
    referenceTrack: referenceTrack(),
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: REACTION_MEDIA,
    observations: scenarioObservations(),
    policy: POLICY,
    ...overrides,
  })
}

test('T-F4.015 the six playback modes are the spec 05 §16 vocabulary, not a four-value stub', () => {
  assert.deepEqual([...PLAYBACK_MODES], [
    'playing', 'paused', 'rewind', 'replay', 'seek', 'commentary-only',
  ])
  // The discontinuity vocabulary spreads the clock map's causes rather than
  // retyping them, so 'seek' and 'rewind' mean one thing in the whole codebase.
  for (const cause of PIECE_BOUNDARY_CAUSES) {
    assert.ok(PLAYBACK_DISCONTINUITY_REASONS.includes(cause), `${cause} must survive the spread`)
  }
  assert.deepEqual([...PLAYBACK_DETECTION_METHODS], [
    'audio-fingerprint', 'player-visual', 'ocr-timestamp', 'manual-anchor',
  ])
})

test('T-F4.015 a paused piece cannot claim the reference produced time', () => {
  const build = (mode, referenceRange) => () => createPlaybackMap({
    mapId: 'playback-map-x',
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-react',
    sessionVersion: 1,
    referenceEpoch: 1,
    reactionTrackId: 'track-reaction',
    referenceTrackId: 'track-reference',
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: REACTION_MEDIA,
    pieces: [{
      pieceId: 'piece-000',
      mode,
      reactionRange: createTickInterval(0n, seconds(40)),
      referenceRange,
      direction: referenceRange === null ? 'none' : 'forward',
      confidence: 0.8,
      evidenceRefs: ['fingerprint:0'],
      detectionMethod: 'audio-fingerprint',
    }],
  })
  assert.throws(build('paused', createTickInterval(0n, seconds(5))), (error) =>
    error.code === 'INVALID_ARGUMENT' && /cannot claim the reference produced time/.test(error.message))
  assert.throws(build('commentary-only', createTickInterval(0n, seconds(5))), (error) =>
    error.code === 'INVALID_ARGUMENT')
  // And the mirror: a playing piece must name what it played.
  assert.throws(build('playing', null), (error) =>
    error.code === 'INVALID_ARGUMENT' && /must name the reference range/.test(error.message))
})

test('T-F4.015 the reaction duration is never usable as the reference duration', () => {
  // The naive linearisation: one playing piece over the whole reaction, with a
  // reference range as long as the reaction. The reference measured thirty
  // seconds, and says so.
  assert.throws(
    () => createPlaybackMap({
      mapId: 'playback-map-naive',
      workspaceId: 'workspace-1',
      sessionId: 'capture-session-react',
      sessionVersion: 1,
      referenceEpoch: 1,
      reactionTrackId: 'track-reaction',
      referenceTrackId: 'track-reference',
      referenceMedia: REFERENCE_MEDIA,
      reactionMedia: REACTION_MEDIA,
      pieces: [{
        pieceId: 'piece-000',
        mode: 'playing',
        reactionRange: createTickInterval(0n, seconds(40)),
        referenceRange: createTickInterval(0n, seconds(40)),
        direction: 'forward',
        confidence: 0.9,
        evidenceRefs: ['fingerprint:0'],
        detectionMethod: 'audio-fingerprint',
      }],
    }),
    (error) => error.code === 'INVALID_ARGUMENT' &&
      /plays reference time the reference does not have/.test(error.message) &&
      error.details.referenceDurationTicks === seconds(30).toString(),
  )

  const map = scenarioMap()
  assert.notEqual(map.reactionMedia.durationTicks, map.referenceMedia.durationTicks)
  // No piece, and no sum of pieces, silently equals the other recording.
  const played = map.pieces
    .filter((piece) => piece.referenceRange !== null)
    .reduce((total, piece) => total + (piece.referenceRange.end - piece.referenceRange.start), 0n)
  assert.notEqual(played, map.reactionMedia.durationTicks)
  for (const piece of map.pieces) {
    if (piece.referenceRange === null) continue
    assert.ok(piece.referenceRange.end <= map.referenceMedia.durationTicks)
  }
})

test('T-F4.015 pieces and uncovered stretches must tile the reaction exactly', () => {
  const map = scenarioMap()
  const tiles = [
    ...map.pieces.map((piece) => piece.reactionRange),
    ...map.uncovered.map((entry) => entry.range),
  ].sort((left, right) => (left.start < right.start ? -1 : 1))
  let cursor = 0n
  for (const tile of tiles) {
    assert.equal(tile.start, cursor)
    cursor = tile.end
  }
  assert.equal(cursor, REACTION_MEDIA.durationTicks)

  assert.throws(
    () => createPlaybackMap({
      mapId: 'playback-map-holed',
      workspaceId: 'workspace-1',
      sessionId: 'capture-session-react',
      sessionVersion: 1,
      referenceEpoch: 1,
      reactionTrackId: 'track-reaction',
      referenceTrackId: 'track-reference',
      referenceMedia: REFERENCE_MEDIA,
      reactionMedia: REACTION_MEDIA,
      pieces: [{
        pieceId: 'piece-000',
        mode: 'playing',
        reactionRange: createTickInterval(0n, seconds(10)),
        referenceRange: createTickInterval(0n, seconds(10)),
        direction: 'forward',
        confidence: 0.9,
        evidenceRefs: ['fingerprint:0'],
        detectionMethod: 'audio-fingerprint',
      }],
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /reach the end of the reaction/.test(error.message),
  )
})

test('T-F4.015 a rate exists only when a method that measures one measured it', () => {
  const withRate = (detectionMethod, rate) => () => createPlaybackMap({
    mapId: 'playback-map-rate',
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-react',
    sessionVersion: 1,
    referenceEpoch: 1,
    reactionTrackId: 'track-reaction',
    referenceTrackId: 'track-reference',
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: REACTION_MEDIA,
    pieces: [{
      pieceId: 'piece-000',
      mode: 'playing',
      reactionRange: createTickInterval(0n, seconds(40)),
      referenceRange: createTickInterval(0n, seconds(20)),
      rate,
      direction: 'forward',
      confidence: 0.9,
      evidenceRefs: ['fingerprint:0'],
      detectionMethod,
    }],
  })
  assert.throws(withRate('manual-anchor', rational(1n, 2n)), (error) =>
    error.code === 'INVALID_ARGUMENT' && /does not measure a rate/.test(error.message))
  assert.throws(withRate('audio-fingerprint', rational(-1n, 2n)), (error) =>
    error.code === 'INVALID_ARGUMENT' && /non-positive rate/.test(error.message))
  assert.doesNotThrow(withRate('audio-fingerprint', rational(1n, 2n)))
  // Absent is a legal state and is not silently promoted to 1/1.
  const unmeasured = withRate('audio-fingerprint', undefined)()
  assert.equal(unmeasured.pieces[0].rate, null)
  assert.ok(unmeasured.warnings.includes('rate-unmeasured'))
})

test('T-F4.015 a slope needs two windows; one window fixes an offset and no rate', () => {
  const single = buildPlaybackMap({
    mapId: 'playback-map-single',
    session: reactSession(),
    reactionTrack: reactionTrack(),
    referenceTrack: referenceTrack(),
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: REACTION_MEDIA,
    observations: [observation(0, 0), observation(0.5, null), observation(1, null)],
    policy: POLICY,
  })
  assert.equal(single.pieces[0].mode, 'playing')
  assert.equal(single.pieces[0].rate, null, 'one window cannot produce a slope')
  assert.ok(single.warnings.includes('rate-unmeasured'))
})

test('T-F4.015 buildPlaybackMap separates a pause, a commentary, a replay, a seek and a hidden player', () => {
  const map = scenarioMap()
  assert.equal(map.schemaVersion, PLAYBACK_MAP_SCHEMA_VERSION)
  assert.deepEqual(map.pieces.map((piece) => piece.mode), [
    'playing', 'paused', 'playing', 'commentary-only', 'playing', 'replay', 'seek', 'playing',
  ])

  const [first, paused, resumed, commentary, resumedAgain, replay, seek, tail] = map.pieces
  // The reference does not advance during the pause, and playback resumes from
  // the tick it left.
  assert.equal(paused.referenceRange, null)
  assert.equal(paused.direction, 'none')
  assert.equal(paused.discontinuityReason, 'pause')
  assert.equal(resumed.referenceRange.start, first.referenceRange.end)

  // Longer than the pause ceiling, so it is commentary and not a pause — and
  // the reference still resumes where it left, which is what lets it be either.
  assert.equal(commentary.referenceRange, null)
  assert.ok(commentary.reactionRange.end - commentary.reactionRange.start > POLICY.maxPauseTicks)
  assert.equal(resumedAgain.referenceRange.start, resumed.referenceRange.end)

  assert.equal(replay.direction, 'backward')
  assert.equal(replay.discontinuityReason, 'rewind')
  assert.ok(replay.referenceRange.start < resumed.referenceRange.end, 'a replay goes back')

  assert.equal(seek.discontinuityReason, 'seek')
  assert.ok(seek.referenceRange.start > replay.referenceRange.end + POLICY.seekThresholdTicks)

  // The hidden player: the reference moved while nobody could see it.
  assert.equal(map.uncovered.length, 1)
  assert.equal(map.uncovered[0].reason, 'manual-anchor-required')
  assert.deepEqual(map.uncovered[0].range, createTickInterval(seconds(34), seconds(36)))
  assert.equal(map.status, 'needs-input')
  assert.ok(map.warnings.includes('manual-anchor-required'))
  assert.equal(tail.discontinuityReason, 'coverage-gap')
})

test('T-F4.015 a rewind that runs past what was played is a rewind, not a replay', () => {
  const windows = []
  for (let tick = 0; tick < 10; tick += 0.5) windows.push(observation(tick, tick))
  // Back to reference second 5, then on past second 10 — new ground, so the
  // reference range was not merely played again.
  for (let tick = 10; tick < 20; tick += 0.5) windows.push(observation(tick, 5 + (tick - 10)))
  const map = buildPlaybackMap({
    mapId: 'playback-map-rewind',
    session: reactSession(),
    reactionTrack: reactionTrack(),
    referenceTrack: referenceTrack(),
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: { ...REACTION_MEDIA, durationTicks: seconds(20) },
    observations: windows,
    policy: POLICY,
  })
  assert.deepEqual(map.pieces.map((piece) => piece.mode), ['playing', 'rewind'])
  assert.equal(map.pieces[1].direction, 'backward')
  assert.equal(map.pieces[1].discontinuityReason, 'rewind')
})

test('T-F4.015 two plausible references in one window become uncovered, never an invented piece', () => {
  const windows = scenarioObservations()
  // Same window, two references four seconds apart: the correlator found both
  // and could not choose.
  windows.push(observation(2, 17, { evidenceRef: 'fingerprint:rival', confidence: 0.88 }))
  const map = buildPlaybackMap({
    mapId: 'playback-map-conflict',
    session: reactSession(),
    reactionTrack: reactionTrack(),
    referenceTrack: referenceTrack(),
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: REACTION_MEDIA,
    observations: windows,
    policy: POLICY,
  })
  const conflicted = map.uncovered.filter((entry) => entry.reason === 'conflicting-evidence')
  assert.equal(conflicted.length, 1)
  assert.equal(conflicted[0].range.start, seconds(2))
  assert.ok(map.warnings.includes('conflicting-evidence'))
  // No piece covers the contested window.
  assert.ok(!map.pieces.some((piece) =>
    piece.reactionRange.start <= seconds(2) && piece.reactionRange.end > seconds(2)))
})

test('T-F4.015 a window whose peak never cleared admission is uncovered, not a low-confidence piece', () => {
  const windows = scenarioObservations()
  const weak = windows.findIndex((entry) => entry.reactionTick === seconds(3))
  windows[weak] = observation(3, 3, { peakRatio: 1.05, confidence: 0.2 })
  const map = buildPlaybackMap({
    mapId: 'playback-map-weak',
    session: reactSession(),
    reactionTrack: reactionTrack(),
    referenceTrack: referenceTrack(),
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: REACTION_MEDIA,
    observations: windows,
    policy: POLICY,
  })
  assert.ok(map.uncovered.some((entry) =>
    entry.reason === 'conflicting-evidence' && entry.range.start === seconds(3)))
})

test('T-F4.015 resolveReactionTick answers differently for playing, no-reference and uncovered', () => {
  const map = scenarioMap()

  const playing = resolveReactionTick(map, seconds(3))
  assert.equal(playing.status, 'resolved')
  assert.equal(playing.mode, 'playing')
  assert.equal(playing.referenceTick, seconds(3))
  assert.equal(playing.rateAssumed, false, 'this piece measured its slope')

  const paused = resolveReactionTick(map, seconds(8))
  assert.equal(paused.status, 'no-reference')
  assert.equal(paused.mode, 'paused')

  const commentary = resolveReactionTick(map, seconds(20))
  assert.equal(commentary.status, 'no-reference')
  assert.equal(commentary.mode, 'commentary-only')

  const hidden = resolveReactionTick(map, seconds(35))
  assert.equal(hidden.status, 'uncovered')
  assert.equal(hidden.reason, 'manual-anchor-required')

  assert.equal(resolveReactionTick(map, seconds(100)).reason, 'after-last-piece')

  // A piece without a measured rate answers, and says the 1/1 was assumed here.
  const assumed = buildPlaybackMap({
    mapId: 'playback-map-assumed',
    session: reactSession(),
    reactionTrack: reactionTrack(),
    referenceTrack: referenceTrack(),
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: { ...REACTION_MEDIA, durationTicks: seconds(2) },
    observations: [observation(0, 4)],
    policy: POLICY,
  })
  assert.equal(assumed.pieces[0].rate, null)
  const answer = resolveReactionTick(assumed, seconds(1))
  assert.equal(answer.status, 'resolved')
  assert.equal(answer.rateAssumed, true)
  // The assumption served the lookup and was not written back into the map.
  assert.equal(assumed.pieces[0].rate, null)
})

test('T-F4.015 an anchor edit against a stale version is refused with the current version and hash', () => {
  const map = scenarioMap()
  const edit = {
    anchorId: 'anchor-hidden-1',
    reactionTick: seconds(35),
    referenceTick: seconds(24),
    mode: 'playing',
    actorId: 'operator-7',
    note: 'read the player clock in the frame',
    createdAt: at(600),
  }
  assert.throws(
    () => applyPlaybackAnchor(map, { expectedVersion: map.version, expectedHash: digest('f'), anchor: edit }),
    (error) => error.code === 'PLAYBACK_MAP_VERSION_STALE' &&
      error.details.currentVersion === map.version &&
      error.details.currentHash === map.mapHash,
  )
  assert.throws(
    () => applyPlaybackAnchor(map, { expectedVersion: 99, expectedHash: map.mapHash, anchor: edit }),
    (error) => error.code === 'PLAYBACK_MAP_VERSION_STALE',
  )
})

test('T-F4.015 an anchor resolves the hidden stretch and records who placed it', () => {
  const map = scenarioMap()
  const next = applyPlaybackAnchor(map, {
    expectedVersion: map.version,
    expectedHash: map.mapHash,
    anchor: {
      anchorId: 'anchor-hidden-1',
      reactionTick: seconds(35),
      referenceTick: seconds(24),
      mode: 'playing',
      actorId: 'operator-7',
      note: 'read the player clock in the frame',
      createdAt: at(600),
    },
  })

  assert.equal(next.version, map.version + 1)
  assert.equal(next.previousVersionHash, map.mapHash)
  assert.equal(next.status, 'resolved')
  assert.equal(next.uncovered.length, 0)
  assert.deepEqual(next.pieces.map((piece) => piece.mode), [
    'playing', 'paused', 'playing', 'commentary-only', 'playing', 'replay', 'seek',
    'playing', 'playing',
  ])
  const resolved = next.pieces.find((piece) => piece.detectionMethod === 'manual-anchor')
  assert.deepEqual(resolved.reactionRange, createTickInterval(seconds(34), seconds(36)))
  // The anchor names reaction second 35, one second into the uncovered [34, 36),
  // and reference second 24 — so the piece starts at reference 23, not 24.
  // Anchoring the reference tick to the head of the range instead ignored the
  // instant the operator pointed at and shifted the whole piece by a second.
  assert.deepEqual(resolved.referenceRange, createTickInterval(seconds(23), seconds(25)))
  // The requirement, not the implementation: the anchored instant resolves to
  // the anchored reference instant. This is the assertion the offset bug fails.
  const atAnchor = resolveReactionTick(next, seconds(35))
  assert.equal(atAnchor.status, 'resolved')
  assert.equal(atAnchor.referenceTick, seconds(24))
  assert.equal(resolved.discontinuityReason, 'manual-anchor')
  // One point is not a slope: the operator asserted continuity, nobody measured
  // it, so the piece carries no rate.
  assert.equal(resolved.rate, null)

  // The actor comes first and the note is appended, never the other way round.
  assert.equal(next.anchors.length, 1)
  assert.equal(next.anchors[0].evidenceRef, 'operator:operator-7 (read the player clock in the frame)')
  assert.equal(next.anchors[0].origin, 'manual')

  // Anchors only ever grow: an automatic one already on the map survives.
  const withAutomatic = createPlaybackMap({
    mapId: map.mapId,
    workspaceId: map.workspaceId,
    sessionId: map.sessionId,
    sessionVersion: map.sessionVersion,
    referenceEpoch: map.referenceEpoch,
    reactionTrackId: map.reactionTrackId,
    referenceTrackId: map.referenceTrackId,
    referenceMedia: map.referenceMedia,
    reactionMedia: map.reactionMedia,
    pieces: map.pieces,
    uncovered: map.uncovered,
    anchors: [{
      anchorId: 'anchor-automatic-1',
      origin: 'automatic',
      reactionTick: seconds(1),
      referenceTick: seconds(1),
      mode: 'playing',
      method: 'audio-fingerprint',
      confidence: 0.8,
      evidenceRef: 'fingerprint:90000',
      createdAt: at(10),
    }],
  })
  const afterEdit = applyPlaybackAnchor(withAutomatic, {
    expectedVersion: withAutomatic.version,
    expectedHash: withAutomatic.mapHash,
    anchor: {
      anchorId: 'anchor-hidden-2',
      reactionTick: seconds(35),
      referenceTick: seconds(24),
      actorId: 'operator-7',
      createdAt: at(600),
    },
  })
  assert.deepEqual(afterEdit.anchors.map((anchor) => anchor.anchorId), [
    'anchor-automatic-1', 'anchor-hidden-2',
  ])
  assert.equal(afterEdit.anchors[1].evidenceRef, 'operator:operator-7')
})

test('T-F4.015 an anchor cannot be placed where a piece already answers', () => {
  const map = scenarioMap()
  assert.throws(
    () => applyPlaybackAnchor(map, {
      expectedVersion: map.version,
      expectedHash: map.mapHash,
      anchor: {
        anchorId: 'anchor-redundant',
        reactionTick: seconds(3),
        referenceTick: seconds(3),
        actorId: 'operator-7',
        createdAt: at(600),
      },
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /already has a piece/.test(error.message),
  )
})

test('T-F4.015 compiling picks the reference for playback, the reaction for silence, and never the reference audio', () => {
  const map = scenarioMap()
  assert.throws(
    () => compilePlaybackToShots(map, {
      planFps: rational(30n, 1n),
      referenceTimebase: REFERENCE_TIMEBASE,
      reactionTimebase: REACTION_TIMEBASE,
    }),
    (error) => error.code === 'PLAYBACK_MAP_UNRESOLVED',
  )

  const resolved = applyPlaybackAnchor(map, {
    expectedVersion: map.version,
    expectedHash: map.mapHash,
    anchor: {
      anchorId: 'anchor-hidden-1',
      reactionTick: seconds(35),
      referenceTick: seconds(24),
      mode: 'playing',
      actorId: 'operator-7',
      createdAt: at(600),
    },
  })
  const { shots } = compilePlaybackToShots(resolved, {
    planFps: rational(30n, 1n),
    referenceTimebase: REFERENCE_TIMEBASE,
    reactionTimebase: REACTION_TIMEBASE,
  })

  assert.equal(shots.length, resolved.pieces.length)
  assert.equal(shots[0].timelineInFrame, 0)
  assert.equal(shots[shots.length - 1].timelineOutFrame, 40 * 30)
  for (const [index, shot] of shots.entries()) {
    assert.equal(shot.rate, 1)
    assert.equal(shot.audioSourceAssetId, REACTION_MEDIA.assetId, 'the audience came for the reactor')
    assert.equal(
      shot.sourceAssetId,
      shot.mode === 'paused' || shot.mode === 'commentary-only'
        ? REACTION_MEDIA.assetId
        : REFERENCE_MEDIA.assetId,
    )
    assert.equal(shot.sourceOutFrame - shot.sourceInFrame, shot.timelineOutFrame - shot.timelineInFrame)
    if (index > 0) assert.equal(shot.timelineInFrame, shots[index - 1].timelineOutFrame)
  }
  // The replay really does point back at reference frames already used.
  const replay = shots.find((shot) => shot.mode === 'replay')
  assert.equal(replay.sourceInFrame, 2 * 30)
  const seek = shots.find((shot) => shot.mode === 'seek')
  assert.equal(seek.sourceInFrame, 20 * 30)
})

test('T-F4.015 compiling refuses a reference timebase the map was not measured in', () => {
  const map = scenarioMap()
  const resolved = applyPlaybackAnchor(map, {
    expectedVersion: map.version,
    expectedHash: map.mapHash,
    anchor: {
      anchorId: 'anchor-hidden-1',
      reactionTick: seconds(35),
      referenceTick: seconds(24),
      mode: 'playing',
      actorId: 'operator-7',
      createdAt: at(600),
    },
  })
  assert.throws(
    () => compilePlaybackToShots(resolved, {
      planFps: rational(30n, 1n),
      referenceTimebase: timebaseFromRate(48_000),
      reactionTimebase: REACTION_TIMEBASE,
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /does not match the one the map was measured in/.test(error.message),
  )
})

test('T-F4.015 the hash covers every tick and refuses a body that changed underneath it', () => {
  const first = scenarioMap()
  const second = scenarioMap()
  assert.equal(first.mapHash, second.mapHash, 'the same observations hash the same')
  assert.equal(first.mapHash.length, 64)
  assert.doesNotThrow(() => assertPlaybackMapIntegrity(first))

  const movedByOneTick = buildPlaybackMap({
    mapId: 'playback-map-1',
    session: reactSession(),
    reactionTrack: reactionTrack(),
    referenceTrack: referenceTrack(),
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: { ...REACTION_MEDIA, durationTicks: REACTION_MEDIA.durationTicks - 1n },
    observations: scenarioObservations(),
    policy: POLICY,
  })
  assert.notEqual(movedByOneTick.mapHash, first.mapHash, 'one tick of difference is a different map')

  const tampered = {
    ...first,
    pieces: first.pieces.map((piece, index) => (index === 0
      ? { ...piece, referenceRange: createTickInterval(0n, seconds(7)) }
      : piece)),
  }
  assert.throws(() => assertPlaybackMapIntegrity(tampered), (error) =>
    error.code === 'PERSISTENCE_CONFLICT')

  // The map-level body too, not only the pieces. Rewriting a piece exercises
  // `calculatePlaybackPieceHash`; everything the map hash adds on top of the
  // piece hashes — the uncovered list, the reference identity, the status —
  // went unproved, and dropping `uncovered` from the hashed body left the whole
  // suite green.
  const mapLevelTampering = [
    ['uncovered reason', {
      ...first,
      uncovered: first.uncovered.map((entry) => ({ ...entry, reason: 'conflicting-evidence' })),
    }],
    ['uncovered range', {
      ...first,
      uncovered: first.uncovered.map((entry) => ({
        ...entry,
        range: createTickInterval(entry.range.start, entry.range.end + 1n),
      })),
    }],
    ['reference duration', {
      ...first,
      referenceMedia: { ...first.referenceMedia, durationTicks: seconds(60) },
    }],
    ['reference identity', {
      ...first,
      referenceMedia: { ...first.referenceMedia, sha256: digest('e') },
    }],
    ['status', { ...first, status: 'resolved' }],
  ]
  for (const [what, body] of mapLevelTampering) {
    assert.throws(
      () => assertPlaybackMapIntegrity(body),
      (error) => error.code === 'PERSISTENCE_CONFLICT',
      `${what} changed underneath the hash and the read accepted it`,
    )
  }
})

test('T-F4.015 the default policy states its calibration and converts thresholds into ticks once', () => {
  const policy = defaultPlaybackPolicy(REACTION_TIMEBASE)
  assert.match(policy.calibrationVersion, /^react-playback\//)
  assert.equal(policy.windowTicks, TICKS_PER_SECOND)
  assert.equal(policy.maxPauseTicks, TICKS_PER_SECOND * 10n)
  assert.equal(policy.seekThresholdTicks, seconds(1.2))
  // The admission floor is the sync cascade's, not a second opinion.
  assert.equal(policy.minimumPeakRatioForAdmission, 1.2)
  assert.equal(policy.minimumWindowsForRate, 2)
  assert.throws(
    () => createPlaybackPolicy({
      calibrationVersion: 'x',
      reactionTimebase: REACTION_TIMEBASE,
      windowMs: 1_000,
      maxPauseMs: 10_000,
      seekThresholdMs: 1_200,
      continuityToleranceMs: 400,
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /name the calibration/.test(error.message),
  )
})

// ---------------------------------------------------------------------------
// The correlator, on synthetic signals only — no FFmpeg, no files.
// ---------------------------------------------------------------------------

function chirpSeconds(count, sampleRate) {
  const samples = new Float64Array(count * sampleRate)
  for (let second = 0; second < count; second += 1) {
    // Every second is a different sweep, and consecutive seconds sweep in
    // opposite directions: a constant tone would correlate equally well at every
    // second of the reference, which is the ambiguity this fixture exists to
    // avoid.
    const start = 200 + 20 * ((second * 7) % count)
    const span = second % 2 === 0 ? 300 : -300
    for (let index = 0; index < sampleRate; index += 1) {
      const t = index / sampleRate
      const phase = 2 * Math.PI * (start * t + (span * t * t) / 2)
      samples[second * sampleRate + index] = 0.6 * Math.sin(phase)
    }
  }
  return samples
}

test('T-F4.015 correlateAudioWindows finds each window of the candidate in the reference', () => {
  const sampleRate = 8_000
  const reference = chirpSeconds(8, sampleRate)
  // The candidate is reference seconds 2 through 5.
  const candidate = reference.slice(2 * sampleRate, 5 * sampleRate)

  const windows = correlateAudioWindows({
    reference,
    candidate,
    sampleRate,
    windowMs: 1_000,
    hopMs: 500,
    correlationRate: 2_000,
  })

  // Whole windows only: a partial tail window would be a shorter needle whose
  // peak is not comparable with the rest.
  assert.equal(windows.length, Math.floor((candidate.length - sampleRate) / (sampleRate / 2)) + 1)
  const errors = []
  for (const [index, window] of windows.entries()) {
    if (window.lagSamples === null) continue
    const expected = 2 * sampleRate + index * (sampleRate / 2)
    if (expected + sampleRate > reference.length) continue
    errors.push(Math.abs(window.lagSamples - expected))
    assert.ok(window.confidence < 1, 'a correlator that returns certainty has stopped measuring')
  }
  const worst = Math.max(...errors)
  console.log(`correlator: ${errors.length} windows, worst lag error ${worst} samples at ${sampleRate} Hz`)
  assert.ok(worst <= 64, `worst lag error ${worst} samples exceeds the decimation grid`)
})

test('T-F4.015 a silent window gets no lag at all, not lag zero', () => {
  const sampleRate = 8_000
  const reference = chirpSeconds(4, sampleRate)
  const candidate = new Float64Array(2 * sampleRate)
  const windows = correlateAudioWindows({ reference, candidate, sampleRate, windowMs: 1_000, hopMs: 500 })
  assert.ok(windows.length > 0)
  for (const window of windows) {
    assert.equal(window.lagSamples, null, 'silence names no instant; lag 0 would name the first sample')
    assert.equal(window.confidence, 0)
  }

  // Non-finite PCM is silence as far as this function is concerned. `NaN <
  // energyFloor` is false and `NaN === 0` is false, so both gates used to be
  // skipped, every score came back NaN, the sort was a no-op and the winner was
  // whatever the loop started with — offset 0. That is exactly the answer this
  // type's doc comment says must never be produced.
  for (const filler of [NaN, Infinity, -Infinity]) {
    const broken = correlateAudioWindows({
      reference,
      candidate: new Float64Array(2 * sampleRate).fill(filler),
      sampleRate,
      windowMs: 1_000,
      hopMs: 500,
    })
    assert.ok(broken.length > 0)
    for (const window of broken) {
      assert.equal(window.lagSamples, null, `${filler} samples named the first sample of the reference`)
      assert.equal(window.confidence, 0)
    }
  }

  // A non-finite window or hop is bad input, not an empty measurement: `NaN <= 0`
  // is false, so it slipped past the guard and produced zero windows, which the
  // domain reads as "the reference was never playing".
  for (const bad of [{ windowMs: NaN }, { hopMs: NaN }, { windowMs: Infinity }, { hopMs: -Infinity }]) {
    assert.throws(
      () => correlateAudioWindows({ reference, candidate, sampleRate, windowMs: 1_000, hopMs: 500, ...bad }),
      TypeError,
      `${JSON.stringify(bad)} was accepted`,
    )
  }
})

test('T-F4.015 a refused window reports confidence in the absence, not the ratio of the match it refused', () => {
  const floor = 0.5
  // Far below the correlation floor: nothing in the window is explained by the
  // reference, and the shortfall is the measurement.
  assert.ok(absenceConfidence(0.06, floor) > 0.85)
  assert.ok(absenceConfidence(0.06, floor) <= MAXIMUM_ABSENCE_CONFIDENCE)
  // Just below it: half the window could be the reference, so the absence is
  // barely established at all.
  assert.ok(absenceConfidence(0.485, floor) < 0.05)
  // At or above the floor the window is ambiguity, not absence: the reference is
  // plausibly there and only the runner-up test refused it.
  assert.equal(absenceConfidence(0.5, floor), 0)
  assert.equal(absenceConfidence(0.9, floor), 0)
  // Silence is the strongest absence this detector can measure, and still not 1:
  // a reference can play a silent passage.
  assert.equal(absenceConfidence(0, floor), MAXIMUM_ABSENCE_CONFIDENCE)
  assert.ok(MAXIMUM_ABSENCE_CONFIDENCE < 1)

  // And the number that reaches the domain is that one. A gap piece's confidence
  // is the least confident absent window in the run — never the peak-over-
  // runner-up ratio of a correlation the detector rejected.
  const windows = []
  for (let tick = 0; tick < 6; tick += 0.5) windows.push(observation(tick, tick))
  for (let tick = 6; tick < 10; tick += 0.5) {
    windows.push(observation(tick, null, { confidence: tick === 7 ? 0.31 : 0.88, peakRatio: 0 }))
  }
  for (let tick = 10; tick < 14; tick += 0.5) windows.push(observation(tick, 6 + (tick - 10)))
  const map = buildPlaybackMap({
    mapId: 'playback-map-absence',
    session: reactSession(),
    reactionTrack: reactionTrack(),
    referenceTrack: referenceTrack(),
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: { ...REACTION_MEDIA, durationTicks: seconds(14) },
    observations: windows,
    policy: POLICY,
  })
  const paused = map.pieces.find((piece) => piece.mode === 'paused')
  assert.ok(paused, 'the reference resumed where it left, so the gap is a pause')
  assert.equal(paused.confidence, 0.31, 'the weakest observer of an absence sets the number')
})

test('T-F4.015 confidence is a documented function of the peak ratio and never reaches one', () => {
  assert.equal(confidenceFromPeakRatio(1), 0)
  assert.ok(confidenceFromPeakRatio(1.1) < 0.35)
  assert.equal(Math.round(confidenceFromPeakRatio(1.2) * 100) / 100, 0.35)
  assert.equal(Math.round(confidenceFromPeakRatio(1.5) * 100) / 100, 0.8)
  assert.ok(confidenceFromPeakRatio(1000) < 1)
  assert.ok(confidenceFromPeakRatio(1e9) < 1)
})

/**
 * A map body straight from the outside, bypassing `buildPlaybackMap`.
 *
 * The four invariants below cannot be produced by the builder — it tiles by
 * construction and names its own modes — which is exactly why they went
 * untested: deleting each guard left both suites green. A rehydrated aggregate
 * comes from a row, not from the builder, so `createPlaybackMap` is the surface
 * that has to refuse them.
 */
function handBuiltMap(pieces, uncovered = []) {
  return () => createPlaybackMap({
    mapId: 'playback-map-hand',
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-react',
    sessionVersion: 1,
    referenceEpoch: 1,
    reactionTrackId: 'track-reaction',
    referenceTrackId: 'track-reference',
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: REACTION_MEDIA,
    pieces,
    uncovered,
  })
}

function handBuiltMapWith(referenceMedia, pieces) {
  return () => createPlaybackMap({
    mapId: 'playback-map-hand',
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-react',
    sessionVersion: 1,
    referenceEpoch: 1,
    reactionTrackId: 'track-reaction',
    referenceTrackId: 'track-reference',
    referenceMedia,
    reactionMedia: REACTION_MEDIA,
    pieces,
  })
}

function playingPiece(pieceId, reactionRange, referenceRange, overrides = {}) {
  return {
    pieceId,
    mode: 'playing',
    reactionRange,
    referenceRange,
    direction: 'forward',
    confidence: 0.9,
    evidenceRefs: [`fingerprint:${reactionRange.start}`],
    detectionMethod: 'audio-fingerprint',
    ...overrides,
  }
}

test('T-F4.015 the reactor lived each instant once: overlapping reaction ranges are refused', () => {
  assert.throws(
    handBuiltMap([
      playingPiece('p-000', createTickInterval(0n, seconds(20)), createTickInterval(0n, seconds(20))),
      playingPiece('p-001', createTickInterval(seconds(19), seconds(40)), createTickInterval(seconds(19), seconds(29))),
    ]),
    (error) => error.code === 'INVALID_ARGUMENT' && /overlaps the piece before it/.test(error.message),
  )
})

test('T-F4.015 a hole no uncovered stretch accounts for is refused, not silently skipped', () => {
  assert.throws(
    handBuiltMap([
      playingPiece('p-000', createTickInterval(0n, seconds(10)), createTickInterval(0n, seconds(10))),
      // Reaction seconds 10-20 belong to nothing at all, and no `uncovered`
      // entry claims them. A map with a hole answers "no piece here" for an
      // instant it never examined.
      playingPiece('p-001', createTickInterval(seconds(20), seconds(40)), createTickInterval(seconds(10), seconds(30)), {
        discontinuityReason: 'coverage-gap',
      }),
    ]),
    (error) => error.code === 'INVALID_ARGUMENT' &&
      /tile the reaction without gaps or overlap/.test(error.message),
  )
  // The same two pieces with the hole declared are a legal map.
  assert.doesNotThrow(handBuiltMap(
    [
      playingPiece('p-000', createTickInterval(0n, seconds(10)), createTickInterval(0n, seconds(10))),
      playingPiece('p-001', createTickInterval(seconds(20), seconds(40)), createTickInterval(seconds(10), seconds(30)), {
        discontinuityReason: 'coverage-gap',
      }),
    ],
    [{ range: createTickInterval(seconds(10), seconds(20)), reason: 'manual-anchor-required' }],
  ))
})

test('T-F4.015 a seek must say it is a seek, and a rewind must be reached backwards', () => {
  const opening = playingPiece('p-000', createTickInterval(0n, seconds(20)), createTickInterval(0n, seconds(20)))
  assert.throws(
    handBuiltMap([
      opening,
      playingPiece('p-001', createTickInterval(seconds(20), seconds(40)), createTickInterval(seconds(25), seconds(30)), {
        mode: 'seek',
        discontinuityReason: 'coverage-gap',
      }),
    ]),
    (error) => error.code === 'INVALID_ARGUMENT' && /must record .seek. as the reason it begins/.test(error.message),
  )
  for (const mode of ['rewind', 'replay']) {
    assert.throws(
      handBuiltMap([
        opening,
        playingPiece('p-001', createTickInterval(seconds(20), seconds(40)), createTickInterval(seconds(5), seconds(15)), {
          mode,
          direction: 'forward',
          discontinuityReason: 'rewind',
        }),
      ]),
      (error) => error.code === 'INVALID_ARGUMENT' && /must be reached by going backwards/.test(error.message),
      `a ${mode} reached forwards was accepted`,
    )
  }
})

test('T-F4.015 a rate is refused whichever way its sign or its zero is spelled', () => {
  // `rational()` normalises the sign, but a `Rational` is a bare {num, den} and
  // a rehydrated piece never goes through it. Guarding only the numerator let
  // 1/-2 — the same -0.5 as -1/2 — into a map that passed integrity, and the
  // lookup then answered with a reference tick outside the piece's own range.
  for (const rate of [rational(-1n, 2n), { num: 1n, den: -2n }, { num: -1n, den: -2n }, { num: 1n, den: 0n }]) {
    assert.throws(
      handBuiltMap([
        playingPiece('p-000', createTickInterval(0n, seconds(40)), createTickInterval(0n, seconds(20)), { rate }),
      ]),
      (error) => error.code === 'INVALID_ARGUMENT' && /strictly positive/.test(error.message),
      `rate ${rate.num}/${rate.den} was accepted`,
    )
  }
  // A legal rate still resolves, and never outside the range the piece names.
  const map = createPlaybackMap({
    mapId: 'playback-map-rate',
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-react',
    sessionVersion: 1,
    referenceEpoch: 1,
    reactionTrackId: 'track-reaction',
    referenceTrackId: 'track-reference',
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: REACTION_MEDIA,
    pieces: [
      playingPiece('p-000', createTickInterval(0n, seconds(40)), createTickInterval(seconds(4), seconds(24)), {
        rate: { num: 1n, den: 2n },
      }),
    ],
  })
  for (const second of [0, 1, 20, 39]) {
    const answer = resolveReactionTick(map, seconds(second))
    assert.equal(answer.status, 'resolved')
    assert.ok(
      answer.referenceTick >= seconds(4) && answer.referenceTick < seconds(24),
      `resolving second ${second} left the piece's own reference range`,
    )
  }
})

test('T-F4.015 a gap after which the reference resumes behind is uncovered, not a pause', () => {
  const windows = []
  for (let tick = 0; tick < 6; tick += 0.5) windows.push(observation(tick, tick))
  for (let tick = 6; tick < 10; tick += 0.5) windows.push(observation(tick, null))
  // The reference left at second 6 and comes back at second 2. "Paused, then
  // rewound" and "played on unobserved, then rewound further back" both fit, so
  // the aggregate names neither.
  for (let tick = 10; tick < 16; tick += 0.5) windows.push(observation(tick, 2 + (tick - 10)))
  const map = buildPlaybackMap({
    mapId: 'playback-map-resume-behind',
    session: reactSession(),
    reactionTrack: reactionTrack(),
    referenceTrack: referenceTrack(),
    referenceMedia: REFERENCE_MEDIA,
    reactionMedia: { ...REACTION_MEDIA, durationTicks: seconds(16) },
    observations: windows,
    policy: POLICY,
  })
  assert.ok(!map.pieces.some((piece) => piece.mode === 'paused'), 'the player was not observed to stop')
  assert.equal(map.uncovered.length, 1)
  assert.equal(map.uncovered[0].reason, 'manual-anchor-required')
  assert.equal(map.status, 'needs-input')
  assert.ok(map.warnings.includes('manual-anchor-required'))
  assert.throws(
    () => compilePlaybackToShots(map, {
      planFps: rational(30n, 1n),
      referenceTimebase: REFERENCE_TIMEBASE,
      reactionTimebase: REACTION_TIMEBASE,
    }),
    (error) => error.code === 'PLAYBACK_MAP_UNRESOLVED',
  )
})

test('T-F4.015 the reference and the reaction cannot be the same recording', () => {
  assert.throws(
    () => buildPlaybackMap({
      mapId: 'playback-map-same-file',
      session: reactSession(),
      reactionTrack: reactionTrack(),
      referenceTrack: referenceTrack(),
      // Two different tracks, one file. Every shot would then carry the same
      // bytes as source and as audio source, in every mode.
      referenceMedia: { ...REFERENCE_MEDIA, assetId: REACTION_MEDIA.assetId, sha256: REACTION_MEDIA.sha256 },
      reactionMedia: REACTION_MEDIA,
      observations: scenarioObservations(),
      policy: POLICY,
    }),
    (error) => error.code === 'INVALID_ARGUMENT' && /cannot be the same recording/.test(error.message),
  )
  // Either half on its own is enough to refuse it.
  for (const shared of [{ assetId: REACTION_MEDIA.assetId }, { sha256: REACTION_MEDIA.sha256 }]) {
    assert.throws(
      handBuiltMapWith(
        { ...REFERENCE_MEDIA, ...shared },
        [playingPiece('p-000', createTickInterval(0n, seconds(40)), createTickInterval(0n, seconds(20)))],
      ),
      (error) => error.code === 'INVALID_ARGUMENT' && /cannot be the same recording/.test(error.message),
      `${JSON.stringify(Object.keys(shared))} shared was accepted`,
    )
  }
})

test('T-F4.015 an observation peak ratio must be a finite measurement, like the confidence beside it', () => {
  for (const peakRatio of [Infinity, NaN, -1]) {
    assert.throws(
      () => buildPlaybackMap({
        mapId: 'playback-map-ratio',
        session: reactSession(),
        reactionTrack: reactionTrack(),
        referenceTrack: referenceTrack(),
        referenceMedia: REFERENCE_MEDIA,
        reactionMedia: { ...REACTION_MEDIA, durationTicks: seconds(4) },
        observations: [observation(0, 0, { peakRatio }), observation(0.5, 0.5, { peakRatio })],
        policy: POLICY,
      }),
      (error) => error.code === 'INVALID_ARGUMENT' &&
        /peak ratio must be a finite, non-negative measurement/.test(error.message),
      `peakRatio ${peakRatio} was admitted`,
    )
  }
})
