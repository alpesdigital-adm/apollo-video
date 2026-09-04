import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPTURE_SESSION_STATUSES,
  CAPTURE_TRACK_ROLES,
  addCaptureSessionTrack,
  addCaptureSessionTrackPart,
  assertCaptureSessionIntegrity,
  calculateCaptureSessionHash,
  captureSessionHead,
  changeCaptureSessionReferenceTrack,
  changeCaptureSessionStatus,
  createCaptureSession,
  findCaptureTrack,
} from '../../src/v2/domain/capture-session.ts'
import {
  createTickInterval,
  rationalEquals,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'

const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const digest = (character) => character.repeat(64)

function lineage(operation, overrides = {}) {
  return {
    commandId: `command-${operation}`,
    operation,
    actorKind: 'human',
    actorId: 'operator-1',
    occurredAt: at(0),
    note: null,
    ...overrides,
  }
}

function evidence(overrides = {}) {
  return {
    ingestArtifactId: 'artifact-cam-main-1',
    ingestSha256: digest('a'),
    probeHash: digest('b'),
    probeSource: 'packet-scan',
    observedAt: at(1),
    ...overrides,
  }
}

function part(overrides = {}) {
  return {
    partId: 'part-cam-main-1',
    ordinal: 0,
    sourceAssetId: 'asset-cam-main-1',
    timebase: timebaseFromRate(90_000),
    coverage: createTickInterval(BigInt(0), BigInt(90_000) * BigInt(600)),
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: evidence(),
    ...overrides,
  }
}

function track(overrides = {}) {
  return {
    trackId: 'track-cam-main',
    role: 'camera-main',
    device: {
      deviceId: 'device-a7s',
      recorderId: 'recorder-card-1',
      make: 'Sony',
      model: 'A7S III',
      serial: null,
    },
    sourceAssetId: 'asset-cam-main-1',
    timebase: timebaseFromRate(90_000),
    streamIndex: 0,
    syncAudioPolicy: 'sync-only',
    includeInFinalMix: true,
    parts: [part()],
    ...overrides,
  }
}

function session(overrides = {}) {
  return createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-1',
    clock: { timebase: timebaseFromRate(90_000), rounding: 'nearest-half-even' },
    referenceTrackId: 'track-cam-main',
    tracks: [track()],
    lineage: lineage('create-session'),
    createdAt: at(0),
    ...overrides,
  })
}

test('T-FR-140 the nine roles are editorial functions, and scratch is never master', () => {
  assert.deepEqual([...CAPTURE_TRACK_ROLES], [
    'camera-main', 'camera-alt', 'screen', 'phone', 'reaction',
    'reference-video', 'microphone', 'master-audio', 'scratch-audio',
  ])
  // The two audio roles are the same shape of bytes and must never be
  // interchangeable: one may reach the final mix, the other exists only to line
  // clocks up.
  assert.notEqual(
    CAPTURE_TRACK_ROLES.indexOf('scratch-audio'),
    CAPTURE_TRACK_ROLES.indexOf('master-audio'),
  )
  assert.ok(CAPTURE_SESSION_STATUSES.includes('needs-input'))
  assert.ok(CAPTURE_SESSION_STATUSES.includes('partial'))
})

test('T-FR-140 a session is created at version 1 with no predecessor', () => {
  const created = session()
  assert.equal(created.version, 1)
  assert.equal(created.previousVersionHash, null)
  assert.equal(created.status, 'draft')
  assert.equal(created.referenceEpoch, 1)
  assert.deepEqual([...created.staleDerivations], [])
  assert.equal(assertCaptureSessionIntegrity(created), created)
  assert.equal(created.sessionHash, calculateCaptureSessionHash({ ...created, sessionHash: undefined }))

  const head = captureSessionHead(created)
  assert.equal(head.sessionId, 'capture-session-1')
  assert.equal(head.version, 1)
})

test('T-FR-140 the original rational timebase survives, per track and per part', () => {
  // Spec 05 invariant 1: preserve PTS/timebase before normalizing. The only way
  // to guarantee that is to have no setter for it — so this asserts the value
  // that came in is the value that comes out, bit for bit.
  const created = session({
    tracks: [
      track({ timebase: timebaseFromRate(90_000) }),
      track({
        trackId: 'track-master-audio',
        role: 'master-audio',
        sourceAssetId: 'asset-master-audio',
        timebase: timebaseFromRate(48_000),
        syncAudioPolicy: 'final-candidate',
        parts: [part({
          partId: 'part-master-1',
          sourceAssetId: 'asset-master-audio',
          timebase: timebaseFromRate(48_000),
          coverage: createTickInterval(BigInt(0), BigInt(48_000) * BigInt(605)),
          evidence: evidence({ ingestArtifactId: 'artifact-master-1' }),
        })],
      }),
    ],
  })

  const camera = findCaptureTrack(created, 'track-cam-main')
  const audio = findCaptureTrack(created, 'track-master-audio')
  assert.ok(rationalEquals(camera.timebase.secondsPerTick, timebaseFromRate(90_000).secondsPerTick))
  assert.ok(rationalEquals(audio.timebase.secondsPerTick, timebaseFromRate(48_000).secondsPerTick))
  // A 90 kHz video and a 48 kHz master are different quantities. Nothing here
  // normalized them into one session unit; that is a mapping, and a mapping is
  // evidence-bearing work that belongs downstream.
  assert.equal(rationalEquals(camera.timebase.secondsPerTick, audio.timebase.secondsPerTick), false)
  assert.notEqual(camera.parts[0].coverage.end, audio.parts[0].coverage.end)
})

test('T-FR-140 adding a source after ingest produces a new version, never a mutation', () => {
  // A camera found on somebody's phone two hours into the edit changes what the
  // session *is*. If that were an in-place edit, every plan derived from the
  // older session would silently start describing a different event.
  const v1 = session()
  const frozen = JSON.stringify(v1, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))

  const v2 = addCaptureSessionTrack(v1, {
    track: track({
      trackId: 'track-phone',
      role: 'phone',
      sourceAssetId: 'asset-phone-1',
      device: { deviceId: 'device-phone', recorderId: 'recorder-phone', make: null, model: null, serial: null },
      parts: [part({
        partId: 'part-phone-1',
        sourceAssetId: 'asset-phone-1',
        // Starts late and ends early: a real second camera, not a clone.
        coverage: createTickInterval(BigInt(90_000) * BigInt(120), BigInt(90_000) * BigInt(480)),
        evidence: evidence({ ingestArtifactId: 'artifact-phone-1' }),
      })],
    }),
    lineage: lineage('add-track', { commandId: 'command-add-phone', occurredAt: at(60) }),
  })

  assert.equal(v2.version, 2)
  assert.equal(v2.previousVersionHash, v1.sessionHash)
  assert.equal(v2.tracks.length, 2)
  assert.equal(v1.tracks.length, 1, 'version 1 must not have been touched')
  assert.equal(
    JSON.stringify(v1, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    frozen,
    'the earlier version is immutable',
  )
  assert.equal(assertCaptureSessionIntegrity(v2), v2)

  const phone = findCaptureTrack(v2, 'track-phone')
  assert.equal(phone.parts[0].coverage.start, BigInt(90_000) * BigInt(120))
  assert.equal(phone.parts[0].coverage.end, BigInt(90_000) * BigInt(480))
})

test('T-FR-140/T-FR-143 a recorder restart is two parts, each with its own clock', () => {
  const v1 = session()
  const v2 = addCaptureSessionTrackPart(v1, {
    trackId: 'track-cam-main',
    part: part({
      partId: 'part-cam-main-2',
      ordinal: 1,
      sourceAssetId: 'asset-cam-main-2',
      // The recorder came back in a different timebase — which real recorders do.
      timebase: timebaseFromRate(60_000),
      coverage: createTickInterval(BigInt(0), BigInt(60_000) * BigInt(300)),
      splitReason: 'recorder-restart',
      evidence: evidence({ ingestArtifactId: 'artifact-cam-main-2' }),
    }),
    lineage: lineage('add-track-part', { commandId: 'command-add-part', occurredAt: at(120) }),
  })

  const camera = findCaptureTrack(v2, 'track-cam-main')
  assert.equal(camera.parts.length, 2)
  assert.equal(camera.parts[1].splitReason, 'recorder-restart')
  // Each part counts ticks in its own base. Comparing the raw numbers across
  // parts would be meaningless, and the model makes that impossible to forget.
  assert.ok(rationalEquals(camera.parts[0].timebase.secondsPerTick, timebaseFromRate(90_000).secondsPerTick))
  assert.ok(rationalEquals(camera.parts[1].timebase.secondsPerTick, timebaseFromRate(60_000).secondsPerTick))
  assert.equal(v2.version, 2)

  assert.throws(
    () => addCaptureSessionTrackPart(v2, {
      trackId: 'track-does-not-exist',
      part: part({ partId: 'part-orphan' }),
      lineage: lineage('add-track-part'),
    }),
    /is not in this capture session/,
  )
})

test('T-FR-140 changing the reference track is loud: epoch bumps and derivations go stale', () => {
  // The reference is the clock everything else is measured against. Replacing
  // it invalidates every map derived from the old one, so it must not be
  // possible to do quietly.
  const v2 = addCaptureSessionTrack(session(), {
    track: track({
      trackId: 'track-screen',
      role: 'screen',
      sourceAssetId: 'asset-screen-1',
      syncAudioPolicy: 'none',
      // A screen grab with no usable audio cannot be marked for the final mix.
      // The aggregate refuses the pair outright — this line is not decoration,
      // it is the invariant, and the first draft of this test violated it.
      includeInFinalMix: false,
      parts: [part({ partId: 'part-screen-1', sourceAssetId: 'asset-screen-1', evidence: evidence({ ingestArtifactId: 'artifact-screen-1' }) })],
    }),
    lineage: lineage('add-track', { commandId: 'command-add-screen' }),
  })
  const synced = changeCaptureSessionStatus(v2, {
    status: 'synced',
    lineage: lineage('change-status', { commandId: 'command-sync', occurredAt: at(200) }),
  })
  assert.equal(synced.status, 'synced')

  const rereferenced = changeCaptureSessionReferenceTrack(synced, {
    referenceTrackId: 'track-screen',
    lineage: lineage('change-reference-track', { commandId: 'command-reref', occurredAt: at(300) }),
  })

  assert.equal(rereferenced.referenceTrackId, 'track-screen')
  assert.ok(rereferenced.referenceEpoch > synced.referenceEpoch, 'the epoch must advance')
  assert.ok(rereferenced.staleDerivations.length > 0, 'downstream derivations must be named stale')
  // It must not still claim to be synced against a reference it no longer uses.
  assert.notEqual(rereferenced.status, 'synced')

  assert.throws(
    () => changeCaptureSessionReferenceTrack(rereferenced, {
      referenceTrackId: 'track-not-here',
      lineage: lineage('change-reference-track'),
    }),
    /CAPTURE_TRACK_NOT_FOUND|not in this capture session|referenceTrackId/,
  )
})

test('T-FR-140 a tampered stored session is refused on read', () => {
  const stored = session()
  assert.throws(
    () => assertCaptureSessionIntegrity({ ...stored, referenceTrackId: 'track-swapped' }),
    /hash/,
  )
  assert.throws(
    () => assertCaptureSessionIntegrity({ ...stored, sessionHash: digest('f') }),
    /hash/,
  )
  assert.throws(
    () => assertCaptureSessionIntegrity({ ...stored, version: 99 }),
    /hash/,
  )
})

test('T-FR-140 the reference track must be one of the session tracks', () => {
  assert.throws(
    () => session({ referenceTrackId: 'track-absent' }),
    /reference/i,
  )
  assert.throws(() => session({ tracks: [] }), /track/i)
})
