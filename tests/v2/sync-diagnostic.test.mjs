import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertSyncDiagnosticIntegrity,
  canAutoEdit,
  createSyncDiagnostic,
  deriveSessionStatus,
  deriveTrackStatus,
  DIAGNOSTIC_POLICY,
} from '../../src/v2/domain/sync-diagnostic.ts'
import { createTickInterval } from '../../src/v2/domain/session-time.ts'
import {
  applyAnchorEdit,
  fitAnchors,
  refitDiagnostic,
} from '../../src/v2/domain/sync-diagnostic-anchors.ts'

const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()

function anchor(overrides = {}) {
  return {
    anchorId: 'anchor-auto-1',
    origin: 'automatic',
    sourceMs: 0,
    sessionMs: 4_500,
    method: 'apollo-marker',
    confidence: 0.95,
    residualMs: 0,
    evidenceRef: 'marker-detection-1',
    createdAt: at(0),
    ...overrides,
  }
}

function track(overrides = {}) {
  const base = {
    trackId: 'track-screen',
    methods: ['apollo-marker'],
    confidence: 0.92,
    offsetMs: 4_500,
    residualMs: 8,
    driftPpm: 0,
    coverageBps: 9_800,
    gaps: [],
    automaticAnchors: [anchor(), anchor({ anchorId: 'anchor-auto-2', sourceMs: 600_000, sessionMs: 604_500 })],
    manualAnchors: [],
    pieceIds: ['piece-1'],
    warnings: [],
    previewSampleMs: [0, 300_000, 600_000],
    ...overrides,
  }
  return {
    ...base,
    status: base.status ?? deriveTrackStatus({
      offsetMs: base.offsetMs,
      residualMs: base.residualMs,
      coverageBps: base.coverageBps,
      confidence: base.confidence,
      hasContradictoryAnchors: base.warnings.includes('anchors-contradictory'),
    }),
  }
}

function diagnostic(overrides = {}) {
  return createSyncDiagnostic({
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-1',
    referenceTrackId: 'track-camera-main',
    version: 1,
    previousVersionHash: null,
    sessionVersion: 3,
    referenceEpoch: 1,
    tracks: [track()],
    protocolCeiling: 'automatic',
    generatedAt: at(60),
    ...overrides,
  })
}

test('T-FR-149 status is derived from measurements, never accepted from the caller', () => {
  const good = diagnostic()
  assert.equal(good.status, 'synced-high')
  assert.equal(good.tracks[0].status, 'synced-high')

  // A caller writing synced-high on a track that did not earn it is refused.
  assert.throws(
    () => diagnostic({
      tracks: [{ ...track({ residualMs: 400, confidence: 0.4 }), status: 'synced-high' }],
    }),
    /reports synced-high but its measurements derive/,
  )
})

test('T-FR-149 a track with no offset is needs-input however good its coverage looks', () => {
  // Coverage of a track that was never aligned measures nothing useful.
  assert.equal(
    deriveTrackStatus({ offsetMs: null, residualMs: null, coverageBps: 10_000, confidence: 0.99, hasContradictoryAnchors: false }),
    'needs-input',
  )
  assert.equal(
    deriveTrackStatus({ offsetMs: 100, residualMs: 5, coverageBps: 9_900, confidence: 0.95, hasContradictoryAnchors: true }),
    'needs-input',
  )
})

test('T-FR-149 a session is as good as its worst track, not its average', () => {
  const mixed = diagnostic({
    tracks: [
      track(),
      track({
        trackId: 'track-phone',
        offsetMs: null,
        residualMs: null,
        automaticAnchors: [],
        warnings: ['insufficient-evidence'],
      }),
    ],
  })
  // Averaging would let one good track carry one that never aligned, and the
  // editor would discover it on the timeline.
  assert.equal(mixed.status, 'needs-input')
  assert.equal(mixed.manualRequired, true)
  assert.equal(deriveSessionStatus([]), 'needs-input')
})

test('T-FR-149 an offset without a residual is refused', () => {
  // An offset nobody can challenge is not a measurement.
  assert.throws(
    () => diagnostic({ tracks: [track({ offsetMs: 4_500, residualMs: null, status: 'needs-input' })] }),
    /must report an offset and its residual together/,
  )
})

test('T-FR-149 the reference track is not diagnosed against itself', () => {
  assert.throws(
    () => diagnostic({ tracks: [track({ trackId: 'track-camera-main' })] }),
    /is the clock and is not diagnosed against itself/,
  )
})

test('T-FR-149 a fit over two anchors recovers offset and drift; one anchor claims no drift', () => {
  // Two anchors 600 s apart with 60 ms of accumulated skew: 100 ppm.
  const fit = fitAnchors([
    anchor({ sourceMs: 0, sessionMs: 4_500 }),
    anchor({ anchorId: 'a2', sourceMs: 600_000, sessionMs: 604_560 }),
  ])
  assert.equal(Math.round(fit.offsetMs), 4_500)
  assert.equal(fit.driftPpm, 100)
  assert.ok(fit.residualMs < 0.001)

  // One anchor fixes an offset and says nothing about rate. Reporting zero
  // drift would be inventing a measurement nobody made.
  const single = fitAnchors([anchor({ sourceMs: 1_000, sessionMs: 5_500 })])
  assert.equal(single.offsetMs, 4_500)
  assert.equal(single.rate, 1)
  assert.equal(fitAnchors([]), null)
})

test('T-FR-149 adding a manual anchor refits and leaves automatic anchors intact', () => {
  const first = diagnostic()
  const automaticBefore = first.tracks[0].automaticAnchors.map((entry) => entry.anchorId)

  const second = applyAnchorEdit({
    diagnostic: first,
    expectedVersion: 1,
    edit: {
      trackId: 'track-screen',
      action: 'add',
      anchorId: 'anchor-manual-1',
      sourceMs: 300_000,
      sessionMs: 304_500,
      editedAt: at(120),
    },
    actorId: 'user-editor-1',
  })

  assert.equal(second.version, 2)
  assert.equal(second.previousVersionHash, first.diagnosticHash)
  assert.equal(second.tracks[0].manualAnchors.length, 1)
  // The rule spec 05 §17 states outright: editing manual anchors never
  // destroys the measured ones.
  assert.deepEqual(
    second.tracks[0].automaticAnchors.map((entry) => entry.anchorId),
    automaticBefore,
  )
  assert.ok(second.tracks[0].methods.includes('manual-anchor'))
  // Every automatic anchor got a fresh residual against the new fit rather
  // than keeping a stale one.
  assert.ok(second.tracks[0].automaticAnchors.every((entry) => entry.residualMs !== null))
  // The earlier version is untouched and still readable.
  assert.equal(first.version, 1)
  assert.equal(first.tracks[0].manualAnchors.length, 0)
})

test('T-FR-149 moving and removing a manual anchor recompute the fit', () => {
  const v1 = diagnostic()
  const v2 = applyAnchorEdit({
    diagnostic: v1,
    expectedVersion: 1,
    edit: { trackId: 'track-screen', action: 'add', anchorId: 'm1', sourceMs: 300_000, sessionMs: 304_500, editedAt: at(120) },
    actorId: 'user-1',
  })
  const v3 = applyAnchorEdit({
    diagnostic: v2,
    expectedVersion: 2,
    edit: { trackId: 'track-screen', action: 'move', anchorId: 'm1', sourceMs: 300_000, sessionMs: 304_530, editedAt: at(180) },
    actorId: 'user-1',
  })
  assert.equal(v3.version, 3)
  assert.equal(v3.tracks[0].manualAnchors[0].sessionMs, 304_530)
  // Moving it off the line the automatic anchors describe raises the residual.
  assert.ok(v3.tracks[0].residualMs > v2.tracks[0].residualMs)

  const v4 = applyAnchorEdit({
    diagnostic: v3,
    expectedVersion: 3,
    edit: { trackId: 'track-screen', action: 'remove', anchorId: 'm1', editedAt: at(240) },
    actorId: 'user-1',
  })
  assert.equal(v4.tracks[0].manualAnchors.length, 0)
  assert.equal(v4.tracks[0].automaticAnchors.length, 2, 'removing a correction must not remove a measurement')
})

test('T-FR-149 an edit computed against an older version is refused', () => {
  const v1 = diagnostic()
  const v2 = applyAnchorEdit({
    diagnostic: v1,
    expectedVersion: 1,
    edit: { trackId: 'track-screen', action: 'add', anchorId: 'm1', sourceMs: 300_000, sessionMs: 304_500, editedAt: at(120) },
    actorId: 'user-1',
  })
  // The anchor indices, the fit and the status all moved; applying an edit
  // computed against v1 would land on a document the operator never saw.
  assert.throws(
    () => applyAnchorEdit({
      diagnostic: v2,
      expectedVersion: 1,
      edit: { trackId: 'track-screen', action: 'add', anchorId: 'm2', sourceMs: 10, sessionMs: 4_510, editedAt: at(180) },
      actorId: 'user-1',
    }),
    /this diagnostic is at version 2; the edit was computed against 1/,
  )
})

test('T-FR-149 automatic anchors cannot be removed or shadowed by hand', () => {
  const v1 = diagnostic()
  assert.throws(
    () => applyAnchorEdit({
      diagnostic: v1,
      expectedVersion: 1,
      edit: { trackId: 'track-screen', action: 'remove', anchorId: 'anchor-auto-1', editedAt: at(120) },
      actorId: 'user-1',
    }),
    /automatic anchors cannot be removed by hand/,
  )
  assert.throws(
    () => applyAnchorEdit({
      diagnostic: v1,
      expectedVersion: 1,
      edit: { trackId: 'track-screen', action: 'add', anchorId: 'anchor-auto-1', sourceMs: 5, sessionMs: 9, editedAt: at(120) },
      actorId: 'user-1',
    }),
    /cannot be shadowed by a manual one/,
  )
})

test('T-FR-149 contradictory anchors are surfaced with a split offered, not silently dropped', () => {
  const v1 = diagnostic()
  // A manual anchor implying a rate far off unity: no single affine map
  // describes it together with the automatic ones.
  const v2 = applyAnchorEdit({
    diagnostic: v1,
    expectedVersion: 1,
    edit: { trackId: 'track-screen', action: 'add', anchorId: 'm-bad', sourceMs: 300_000, sessionMs: 800_000, editedAt: at(120) },
    actorId: 'user-1',
  })
  assert.ok(v2.tracks[0].warnings.includes('anchors-contradictory'))
  assert.equal(v2.tracks[0].status, 'needs-input')
  assert.equal(v2.tracks[0].offsetMs, null, 'a contradiction must not produce an offset anyway')
  // Both anchors are still there: each may be right about its own stretch.
  assert.equal(v2.tracks[0].manualAnchors.length, 1)
  assert.equal(v2.tracks[0].automaticAnchors.length, 2)
  assert.ok(v2.recommendedActions.includes('split-into-piecewise-segment'))
  assert.ok(v2.recommendedActions.includes('move-manual-anchor'))
})

test('T-FR-149 auto-edit is blocked for every distinct reason, and says which', () => {
  assert.equal(canAutoEdit(diagnostic()).allowed, true)

  const needsInput = diagnostic({
    tracks: [track({ offsetMs: null, residualMs: null, automaticAnchors: [], warnings: ['insufficient-evidence'] })],
  })
  const blocked = canAutoEdit(needsInput)
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.blockedBy.some((reason) => /status is needs-input/.test(reason)))
  assert.ok(blocked.blockedBy.some((reason) => /no usable evidence/.test(reason)))

  // A session the protocol capped can never be rescued by a confident fit.
  const capped = diagnostic({ protocolCeiling: 'manual-anchors-required' })
  const cappedResult = canAutoEdit(capped)
  assert.equal(cappedResult.allowed, false)
  assert.ok(cappedResult.blockedBy.some((reason) => /caps this session/.test(reason)))
})

test('T-FR-149 a diagnostic is tamper-evident and a refit advances the version', () => {
  const first = diagnostic()
  assert.equal(assertSyncDiagnosticIntegrity(first), first)
  assert.throws(() => assertSyncDiagnosticIntegrity({ ...first, status: 'failed' }), /hash/)
  assert.throws(() => assertSyncDiagnosticIntegrity({ ...first, manualRequired: true }), /hash/)

  const refit = refitDiagnostic({ diagnostic: first, generatedAt: at(300) })
  assert.equal(refit.version, 2)
  assert.equal(refit.previousVersionHash, first.diagnosticHash)
  assert.ok(refit.globalConfidence >= DIAGNOSTIC_POLICY.mediumConfidence)
})

test('T-FR-149 a diagnostic with coverage gaps can be hashed at all', () => {
  // Ticks are bigints and the canonical hasher refuses them, so a diagnostic
  // carrying gaps could not be constructed — the exact session worth
  // diagnosing. Every earlier test here passed an empty gap list, which is why
  // nothing caught it until a browser fixture put a real gap in one.
  const sec = (n) => BigInt(90_000) * BigInt(n)
  const withGaps = (gaps) => createSyncDiagnostic({
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-1',
    referenceTrackId: 'track-camera-main',
    version: 1,
    previousVersionHash: null,
    sessionVersion: 1,
    referenceEpoch: 1,
    tracks: [{
      trackId: 'track-screen',
      methods: [],
      confidence: 0,
      offsetMs: null,
      residualMs: null,
      driftPpm: null,
      coverageBps: null,
      gaps,
      automaticAnchors: [],
      manualAnchors: [],
      pieceIds: [],
      status: deriveTrackStatus({
        offsetMs: null, residualMs: null, coverageBps: null,
        confidence: 0, hasContradictoryAnchors: false,
      }),
      warnings: ['insufficient-evidence'],
      previewSampleMs: [],
    }],
    protocolCeiling: 'manual-anchors-required',
    generatedAt: '2029-04-01T09:00:00.000Z',
  })

  const one = withGaps([createTickInterval(sec(120), sec(130))])
  assert.match(one.diagnosticHash, /^[a-f0-9]{64}$/)
  // Round trips: what the constructor hashed is what the check recomputes.
  assert.equal(assertSyncDiagnosticIntegrity(one).diagnosticHash, one.diagnosticHash)

  // And serialising the ticks did not collapse them into the same digest: a
  // gap that ends one tick later is a different document.
  const other = withGaps([createTickInterval(sec(120), sec(130) + BigInt(1))])
  assert.notEqual(one.diagnosticHash, other.diagnosticHash)
  // The ticks themselves survive as bigints on the aggregate.
  assert.equal(one.tracks[0].gaps[0].end, sec(130))
  assert.equal(typeof one.tracks[0].gaps[0].end, 'bigint')
})
