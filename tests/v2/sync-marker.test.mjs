import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertSyncMarkerIntegrity,
  classifyDecodedPayload,
  createSyncMarker,
  deriveSessionCode,
  markerChecksum,
  markerPayload,
} from '../../src/v2/domain/sync-marker.ts'
import {
  assertMarkerDetectionIntegrity,
  fuseMarkerDetections,
  judgeAudioObservation,
  judgeVisualObservation,
  offsetBetweenDetections,
  SPOKEN_CODE_MINIMUM_ERROR_MS,
} from '../../src/v2/domain/sync-marker-detection.ts'

const AT = '2029-04-01T09:00:00.000Z'

function marker(overrides = {}) {
  return createSyncMarker({
    markerId: 'marker-1',
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-1',
    kind: 'audiovisual',
    position: 'start',
    sequence: 1,
    emittedAt: AT,
    ...overrides,
  })
}

function visual(m, overrides = {}) {
  return {
    channel: 'visual',
    observationId: 'obs-visual-1',
    trackId: 'track-camera',
    atMs: 4_500,
    errorMs: 17,
    decodedPayload: m.payload,
    patternScore: 0.96,
    confidence: 0.94,
    evidenceRef: 'probe-visual-1',
    ...overrides,
  }
}

function audio(overrides = {}) {
  return {
    channel: 'audio',
    observationId: 'obs-audio-1',
    trackId: 'track-camera',
    atMs: 4_512,
    errorMs: 8,
    correlationPeak: 0.91,
    secondPeak: 0.12,
    confidence: 0.9,
    evidenceRef: 'probe-audio-1',
    ...overrides,
  }
}

test('T-FR-148 a marker carries session, sequence and checksum, not just an instant', () => {
  const m = marker()
  assert.equal(assertSyncMarkerIntegrity(m), m)
  assert.match(m.sessionCode, /^[ABCDEFGHJKLMNPQRTUVWXY2346789]{6}$/)
  // The session code is derived, so the same session always shows the same
  // code — an operator comparing screen against app must not see it change.
  assert.equal(m.sessionCode, deriveSessionCode('capture-session-1'))
  assert.equal(m.payload, markerPayload({
    sessionCode: m.sessionCode,
    sequence: 1,
    position: 'start',
    emittedAt: AT,
  }))
  assert.equal(m.checksum, markerChecksum(m.payload))
  // A clap gives an instant. This says which session, which marker, and
  // whether the bytes are intact.
  assert.notEqual(marker({ sessionId: 'capture-session-2', markerId: 'marker-2' }).sessionCode, m.sessionCode)
})

test('T-FR-148 the visual pattern and the chirp are refused when they could be mistaken for the room', () => {
  // One bright frame is a light switching on. Three alternations are not.
  assert.throws(
    () => marker({ visual: { patternFrames: ['white'], frameRateNum: 30, frameRateDen: 1, codeSizePx: 240 } }),
    /at least three frames/,
  )
  // A constant tone correlates against speech nearly as well as against
  // itself; the chirp has to sweep.
  assert.throws(
    () => marker({ audio: { startHz: 1_000, endHz: 1_000, durationMs: 200, sampleRate: 48_000 } }),
    /must sweep upward/,
  )
  assert.throws(
    () => marker({ audio: { startHz: 1_000, endHz: 30_000, durationMs: 200, sampleRate: 48_000 } }),
    /below the Nyquist limit/,
  )
})

test('T-FR-148 a decoded payload is classified by what is wrong with it', () => {
  const m = marker()
  assert.equal(classifyDecodedPayload(m, m.payload).match, true)

  // A marker from another session, a re-used card. Different action from a
  // corrupted read of the right marker, so it gets a different reason.
  const other = marker({ sessionId: 'capture-session-2', markerId: 'marker-2' })
  assert.deepEqual(classifyDecodedPayload(m, other.payload), { match: false, reason: 'foreign-session' })

  const third = marker({ markerId: 'marker-3', sequence: 3 })
  assert.deepEqual(classifyDecodedPayload(m, third.payload), { match: false, reason: 'wrong-sequence' })
  assert.deepEqual(classifyDecodedPayload(m, 'garbage'), { match: false, reason: 'malformed' })

  // Same fields, edited timestamp: the checksum no longer covers it.
  const tampered = m.payload.replace('09:00:00', '09:00:05')
  assert.deepEqual(classifyDecodedPayload(m, tampered), { match: false, reason: 'checksum-mismatch' })
})

test('T-FR-148 each channel is judged on its own signal', () => {
  const m = marker()
  assert.equal(judgeVisualObservation(m, visual(m)).usable, true)
  assert.equal(judgeAudioObservation(audio()).usable, true)

  // Visual: a weak pattern is rejected before its code is even considered.
  const weakPattern = judgeVisualObservation(m, visual(m, { patternScore: 0.4 }))
  assert.equal(weakPattern.usable, false)
  assert.equal(weakPattern.rejection, 'pattern-mismatch')

  // Audio: a peak barely above the runner-up could have picked either.
  const ambiguous = judgeAudioObservation(audio({ correlationPeak: 0.5, secondPeak: 0.45 }))
  assert.equal(ambiguous.usable, false)
  assert.match(ambiguous.reason, /could have picked either/)

  // A second peak of zero is cleanly separated, not infinitely confident.
  assert.equal(judgeAudioObservation(audio({ secondPeak: 0 })).usable, true)
})

test('T-FR-148 a readable pattern with an unreadable code is a time, not an identity', () => {
  const m = marker()
  const verdict = judgeVisualObservation(m, visual(m, { decodedPayload: null }))
  assert.equal(verdict.usable, true)
  assert.match(verdict.reason, /code could not be read/)

  // And on its own it cannot confirm anything: it does not say which marker.
  const alone = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'either-channel',
    visual: visual(m, { decodedPayload: null }),
  })
  assert.equal(alone.outcome, 'rejected')
  assert.equal(alone.rejection, 'single-channel-not-permitted')
  assert.equal(alone.atMs, null)
})

test('T-FR-148 both channels agreeing confirms, and the instant is the flash', () => {
  const m = marker()
  const detection = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(m),
    audio: audio(),
  })
  assert.equal(detection.outcome, 'confirmed')
  assert.equal(detection.rejection, null)
  // The flash is the event; the chirp arrives later by the time sound needs to
  // cross the room. Averaging would bake half the room's depth into the offset.
  assert.equal(detection.atMs, 4_500)
  assert.equal(detection.errorMs, 17)
  assert.equal(detection.visualObservationId, 'obs-visual-1')
  assert.equal(detection.audioObservationId, 'obs-audio-1')
  assert.equal(assertMarkerDetectionIntegrity(detection), detection)
})

test('T-FR-148 both-channels mode refuses when only one channel is usable', () => {
  const m = marker()
  const noAudio = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(m),
    audio: audio({ confidence: 0.2 }),
  })
  assert.equal(noAudio.outcome, 'rejected')
  assert.equal(noAudio.rejection, 'audio-rejected')
  assert.equal(noAudio.atMs, null, 'a refusal must not carry an instant')

  const noVisual = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(m, { patternScore: 0.1 }),
    audio: audio(),
  })
  assert.equal(noVisual.rejection, 'visual-rejected')
})

test('T-FR-148 channels that disagree past acoustic delay are two events, not one', () => {
  const m = marker()
  // Sound crosses a room in tens of milliseconds. Four hundred is a different
  // flash and a different chirp.
  const detection = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(m),
    audio: audio({ atMs: 4_900 }),
  })
  assert.equal(detection.outcome, 'rejected')
  assert.equal(detection.rejection, 'channels-disagree-on-time')
  assert.ok(detection.reasons.some((reason) => /disagree by 400 ms/.test(reason)))

  // Thirty milliseconds is a camera ten metres away, and is accepted.
  const acceptable = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(m),
    audio: audio({ atMs: 4_530 }),
  })
  assert.equal(acceptable.outcome, 'confirmed')
  assert.equal(acceptable.errorMs, 30, 'the disagreement widens the bound rather than being ignored')
})

test('T-FR-148 a marker from another session is refused by name', () => {
  const m = marker()
  const foreign = marker({ sessionId: 'capture-session-2', markerId: 'marker-2' })
  const detection = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(m, { decodedPayload: foreign.payload }),
    audio: audio(),
  })
  // Named separately because it means somebody reused a card, and no agreement
  // between channels makes it this session's marker.
  assert.equal(detection.rejection, 'foreign-session')
  assert.equal(detection.atMs, null)
})

test('T-FR-148 a tampered payload is refused even when both channels are strong', () => {
  const m = marker()
  const detection = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(m, { decodedPayload: m.payload.replace('start', 'end') }),
    audio: audio(),
  })
  assert.equal(detection.outcome, 'rejected')
  assert.equal(detection.atMs, null)
})

test('T-FR-148 a single channel is usable but never counts as confirmation', () => {
  const m = marker()
  const detection = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'either-channel',
    audio: audio(),
  })
  assert.equal(detection.outcome, 'single-channel-only')
  assert.equal(detection.atMs, 4_512)
  // One channel is one opinion; its confidence is capped below anything the
  // fusion calls confirmed.
  assert.ok(detection.confidence <= 0.75)
})

test('T-FR-148 a spoken code never claims frame accuracy', () => {
  // spec 05 §15 is explicit. A person reading a number has latency between
  // deciding to speak and making sound, and nothing downstream recovers it.
  const spoken = marker({ kind: 'spoken-code', markerId: 'marker-spoken' })
  const detection = fuseMarkerDetections({
    marker: spoken,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(spoken, { errorMs: 8 }),
    audio: audio({ atMs: 4_505, errorMs: 5 }),
  })
  assert.equal(detection.outcome, 'confirmed')
  assert.ok(
    detection.errorMs >= SPOKEN_CODE_MINIMUM_ERROR_MS,
    `spoken code reported ${detection.errorMs} ms, below the floor it cannot justify`,
  )

  // The audiovisual marker with the same observations reports the real bound.
  const audiovisual = fuseMarkerDetections({
    marker: marker(),
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(marker(), { errorMs: 8 }),
    audio: audio({ atMs: 4_505, errorMs: 5 }),
  })
  assert.ok(audiovisual.errorMs < SPOKEN_CODE_MINIMUM_ERROR_MS)
})

test('T-FR-148 an offset needs two resolved detections and adds their errors', () => {
  const m = marker()
  const onReference = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(m),
    audio: audio(),
  })
  const onTarget = fuseMarkerDetections({
    marker: m,
    trackId: 'track-screen',
    mode: 'both-channels',
    visual: visual(m, { trackId: 'track-screen', observationId: 'obs-visual-2', atMs: 1_200, errorMs: 20 }),
    audio: audio({ trackId: 'track-screen', observationId: 'obs-audio-2', atMs: 1_210 }),
  })
  const offset = offsetBetweenDetections({ reference: onReference, target: onTarget })
  assert.equal(offset.offsetMs, 3_300)
  // Uncertainty of a difference is the sum, never the larger.
  assert.equal(offset.errorMs, 37)

  const rejected = fuseMarkerDetections({
    marker: m,
    trackId: 'track-screen',
    mode: 'both-channels',
    visual: visual(m, { trackId: 'track-screen', patternScore: 0.1 }),
    audio: audio({ trackId: 'track-screen' }),
  })
  assert.throws(
    () => offsetBetweenDetections({ reference: onReference, target: rejected }),
    /a rejected detection has no instant to subtract/,
  )
})

test('T-FR-148 a detection is tamper-evident', () => {
  const m = marker()
  const detection = fuseMarkerDetections({
    marker: m,
    trackId: 'track-camera',
    mode: 'both-channels',
    visual: visual(m),
    audio: audio(),
  })
  assert.throws(() => assertMarkerDetectionIntegrity({ ...detection, atMs: 9_999 }), /hash/)
  assert.throws(() => assertMarkerDetectionIntegrity({ ...detection, outcome: 'rejected' }), /hash/)
  assert.throws(() => assertSyncMarkerIntegrity({ ...m, checksum: 'deadbeefdeadbeef' }), /checksum/)
})
