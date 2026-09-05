import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COVERAGE_CONFIDENCE_POLICY,
  deriveTrackCoverage,
} from '../../src/v2/application/derive-track-coverage.ts'
import { createCaptureSession } from '../../src/v2/domain/capture-session.ts'
import {
  AUTO_EDIT_MINIMUM_CONFIDENCE_BPS,
  assertCoverageSelectable,
  coveredDuration,
} from '../../src/v2/domain/track-coverage.ts'
import {
  createTickInterval,
  createTimebase,
  rational,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'

/**
 * F4.005 at runtime — the producer the map found missing.
 *
 * What these prove is not that `createTrackCoverage` works (Wave 18 proved
 * that) but that the worker's derivation feeds it the right facts: that a hole
 * between two files survives as a hole, that a part nobody probed cannot reach
 * an automatic cut, and that the confidence attached to each range came from a
 * named policy rather than from whatever number was convenient.
 */

const t = (n) => BigInt(n)
/** 25 fps: a camera timebase, where one tick is exactly one frame. */
const FRAMES = createTimebase(rational(t(1), t(25)))
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const h = (n) => String(n).repeat(64).slice(0, 64)

function part(overrides = {}) {
  return {
    partId: 'part-a-1',
    ordinal: 0,
    sourceAssetId: 'asset-a-1',
    timebase: FRAMES,
    coverage: createTickInterval(t(0), t(1_500)),
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: {
      ingestArtifactId: 'artifact-a-1',
      ingestSha256: h(1),
      probeHash: h(2),
      probeSource: 'packet-scan',
      observedAt: at(0),
    },
    ...overrides,
  }
}

function track(trackId, parts, overrides = {}) {
  return {
    trackId,
    role: 'camera-main',
    device: { deviceId: `device-${trackId}`, recorderId: `recorder-${trackId}`, make: null, model: null, serial: null },
    sourceAssetId: parts[0].sourceAssetId,
    timebase: FRAMES,
    streamIndex: 0,
    syncAudioPolicy: 'final-candidate',
    includeInFinalMix: true,
    parts,
    ...overrides,
  }
}

function sessionWith(...tracks) {
  return createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-1',
    clock: { timebase: timebaseFromRate(90_000), rounding: 'nearest-half-even' },
    referenceTrackId: tracks[0].trackId,
    tracks,
    lineage: {
      commandId: 'command-1',
      operation: 'create-session',
      actorKind: 'human',
      actorId: 'user-1',
      occurredAt: at(0),
      note: null,
    },
    createdAt: at(0),
  })
}

/** The refusal itself, so the reason it carries can be read. */
function refusalFrom(act) {
  let caught = null
  try {
    act()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'the range had to be refused and was not')
  return caught
}

function coverageOfTrack(session, trackId) {
  return deriveTrackCoverage({
    session,
    track: session.tracks.find((entry) => entry.trackId === trackId),
  })
}

test('T-F4.012 two files that touch exactly become one continuous range', () => {
  const session = sessionWith(track('track-camera-main', [
    part({ partId: 'part-a-1', ordinal: 0, splitReason: 'file-size-limit' }),
    part({
      partId: 'part-a-2',
      ordinal: 1,
      sourceAssetId: 'asset-a-2',
      coverage: createTickInterval(t(1_500), t(3_000)),
      splitReason: 'file-size-limit',
      evidence: { ...part().evidence, ingestArtifactId: 'artifact-a-2', probeHash: h(3) },
    }),
  ]))
  const coverage = coverageOfTrack(session, 'track-camera-main')

  assert.equal(coverage.gaps.length, 0)
  assert.deepEqual({ ...coverage.bounds }, { start: t(0), end: t(3_000) })
  assert.equal(coveredDuration(coverage), t(3_000))
  assert.equal(coverage.recorderSplits.length, 1)
  assert.equal(coverage.recorderSplits[0].kind, 'contiguous')
  // The whole span is selectable: two files with nothing missing between them
  // is not a reason to refuse an automatic cut across the join.
  assert.equal(
    assertCoverageSelectable(coverage, {
      interval: createTickInterval(t(1_000), t(2_000)),
      purpose: 'auto-edit',
    }).length,
    2,
  )
})

test('T-F4.012 the seconds a card change lost stay lost', () => {
  // Eleven seconds at 25 fps. The gap is derived from the parts, so it exists
  // whether or not anybody noticed it at ingest — which is the point: a caller
  // cannot declare it away because a caller never declares it at all.
  const session = sessionWith(track('track-camera-main', [
    part({ partId: 'part-a-1', ordinal: 0, splitReason: 'card-change' }),
    part({
      partId: 'part-a-2',
      ordinal: 1,
      sourceAssetId: 'asset-a-2',
      coverage: createTickInterval(t(1_775), t(3_000)),
      splitReason: 'card-change',
      evidence: { ...part().evidence, ingestArtifactId: 'artifact-a-2', probeHash: h(3) },
    }),
  ]))
  const coverage = coverageOfTrack(session, 'track-camera-main')

  assert.equal(coverage.gaps.length, 1)
  assert.deepEqual({ ...coverage.gaps[0].interval }, { start: t(1_500), end: t(1_775) })
  assert.equal(coverage.gaps[0].partId, null, 'a gap belongs to no file')
  assert.equal(coverage.gaps[0].evidence.kind, 'derived-gap')
  assert.equal(coverage.recorderSplits[0].kind, 'gap')

  const refused = refusalFrom(() => assertCoverageSelectable(coverage, {
    interval: createTickInterval(t(1_400), t(1_900)),
    purpose: 'auto-edit',
  }))
  assert.equal(refused.code, 'CAPTURE_COVERAGE_NOT_AVAILABLE')
  assert.equal(refused.details.reason, 'gap', 'the reason sends the operator to another camera')
  // Either side of the gap is still perfectly usable. A hole does not condemn
  // the recording, it condemns the range that contains it.
  assert.equal(
    assertCoverageSelectable(coverage, {
      interval: createTickInterval(t(0), t(1_500)),
      purpose: 'auto-edit',
    }).length,
    1,
  )
})

test('T-F4.012 a part nobody probed is refused for auto-edit', () => {
  // What this case actually gates: the policy keeps an unprobed part below
  // AUTO_EDIT_MINIMUM_CONFIDENCE_BPS by construction, so promoting
  // `declared-metadata` above the floor makes it fail. It does NOT gate the
  // worker — this file never imports `runCaptureSyncWorker`, and deleting the
  // worker's coverage call leaves it 6/6 green. The phase-6 gate for that is
  // `capture-sync-worker.test.mjs` 'T-F4.012 the worker derives and persists
  // coverage for every track', which dies with `0 !== 2`.
  const session = sessionWith(
    track('track-camera-main', [part()]),
    track('track-phone', [part({
      partId: 'part-b-1',
      sourceAssetId: 'asset-b-1',
      evidence: {
        ...part().evidence,
        ingestArtifactId: 'artifact-b-1',
        probeHash: h(4),
        probeSource: 'declared-metadata',
      },
    })], {
      role: 'phone',
      syncAudioPolicy: 'sync-only',
      includeInFinalMix: false,
    }),
  )
  const coverage = coverageOfTrack(session, 'track-phone')

  assert.equal(coverage.available.length, 0, 'a declared duration is not coverage')
  assert.equal(coverage.unverified.length, 1)
  assert.deepEqual({ ...coverage.unverified[0].interval }, { start: t(0), end: t(1_500) })
  assert.equal(coverage.gaps.length, 0, 'unprobed is not the same fact as missing')

  const refused = refusalFrom(() => assertCoverageSelectable(coverage, {
    interval: createTickInterval(t(100), t(200)),
    purpose: 'auto-edit',
  }))
  assert.equal(refused.code, 'CAPTURE_COVERAGE_UNVERIFIED')
  assert.equal(refused.details.reason, 'unverified', 'the reason sends the operator to a probe')

  // And the distinction earns its keep: analysis may look at the range an
  // automatic cut may not use. Collapsing the two would either blind the
  // analysis or licence the cut.
  assert.equal(
    assertCoverageSelectable(coverage, {
      interval: createTickInterval(t(100), t(200)),
      purpose: 'analysis',
    }).length,
    1,
  )
})

test('T-F4.012 confidence comes from the named policy, not from the derivation', () => {
  const session = sessionWith(track('track-camera-main', [
    part({ partId: 'part-a-1', ordinal: 0, splitReason: 'recorder-restart' }),
    part({
      partId: 'part-a-2',
      ordinal: 1,
      sourceAssetId: 'asset-a-2',
      coverage: createTickInterval(t(1_500), t(3_000)),
      splitReason: 'recorder-restart',
      evidence: { ...part().evidence, ingestArtifactId: 'artifact-a-2', probeHash: h(3), probeSource: 'container-index' },
    }),
  ]))
  const coverage = coverageOfTrack(session, 'track-camera-main')

  assert.deepEqual(
    coverage.available.map((entry) => [entry.partId, entry.confidenceBps, entry.evidence.kind]),
    [
      ['part-a-1', COVERAGE_CONFIDENCE_POLICY['packet-scan'].confidenceBps, 'packet-scan'],
      ['part-a-2', COVERAGE_CONFIDENCE_POLICY['container-index'].confidenceBps, 'container-index'],
    ],
  )
  // The evidence reference is the probe hash, so the interval can be re-derived
  // from the same file and compared against what was stored.
  assert.equal(coverage.available[0].evidence.ref, h(2))
})

test('T-F4.012 the policy keeps unprobed sources below the auto-edit floor by construction', () => {
  // Not a restatement of the numbers: the relation is what the refusal above
  // depends on, and it must hold for every source, including ones added later.
  for (const [source, entry] of Object.entries(COVERAGE_CONFIDENCE_POLICY)) {
    assert.equal(
      entry.confidenceBps >= AUTO_EDIT_MINIMUM_CONFIDENCE_BPS,
      entry.verified,
      `${source} must be admissible for auto-edit exactly when it was actually probed`,
    )
    assert.ok(
      Number.isSafeInteger(entry.confidenceBps) && entry.confidenceBps >= 0 && entry.confidenceBps <= 10_000,
      `${source} confidence must be integer basis points`,
    )
  }
  assert.equal(COVERAGE_CONFIDENCE_POLICY['declared-metadata'].verified, false)
  assert.equal(COVERAGE_CONFIDENCE_POLICY['operator-report'].verified, false)
})

test('T-F4.012 coverage is keyed by track and bound to the session version it read', () => {
  // map §19.10: the clock map is keyed by sourceAssetId and coverage by
  // trackId. A join that mixes the two silently returns nothing.
  const session = sessionWith(track('track-camera-main', [part()]))
  const coverage = coverageOfTrack(session, 'track-camera-main')

  assert.equal(coverage.trackId, 'track-camera-main')
  assert.notEqual(coverage.trackId, session.tracks[0].sourceAssetId)
  assert.deepEqual({ ...coverage.derivedFrom }, {
    sessionId: session.sessionId,
    sessionVersion: session.version,
    referenceEpoch: session.referenceEpoch,
  })
  assert.match(coverage.coverageHash, /^[a-f0-9]{64}$/)
})
