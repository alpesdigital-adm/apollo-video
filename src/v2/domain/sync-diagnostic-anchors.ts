import { assertDomain } from './errors.ts'
import {
  anchorsContradict,
  createSyncDiagnostic,
  deriveTrackStatus,
  DIAGNOSTIC_POLICY,
  type DiagnosticAnchor,
  type DiagnosticWarning,
  type SyncDiagnostic,
  type TrackDiagnostic,
} from './sync-diagnostic.ts'

/**
 * F4.011 — manual anchor editing (FR-149, spec 05 §17).
 *
 * Every edit produces the next version of the diagnostic rather than mutating
 * one, and every edit refits the affected track from its anchors: offset,
 * residual, drift and confidence are all recomputed, never patched.
 *
 * The rule that spec 05 §17 states outright and this module enforces
 * structurally: **saving or cancelling never destroys automatic anchors**.
 * They live in a separate collection that these functions read and never
 * write. An operator who nudges an anchor and changes their mind gets the
 * measured alignment back without re-running detection, because it was never
 * gone.
 *
 * The second rule is that a contradiction is surfaced, not resolved. Two
 * anchors that cannot describe one affine map might each be right about their
 * own stretch of the recording — that is what a piecewise segment is for — so
 * the diagnostic says so and offers the split rather than silently dropping
 * whichever anchor fits worse.
 */

export interface AnchorEdit {
  readonly trackId: string
  readonly action: 'add' | 'move' | 'remove'
  readonly anchorId: string
  /** Required for add and move; ignored for remove. */
  readonly sourceMs?: number
  readonly sessionMs?: number
  readonly evidenceRef?: string
  readonly editedAt: string
}

/**
 * Least-squares fit of session = offset + rate * source.
 *
 * Over every anchor, automatic and manual together: they are all measurements
 * of the same relationship, and weighting one kind above the other would mean
 * deciding in advance whose evidence counts.
 */
export function fitAnchors(anchors: readonly Readonly<DiagnosticAnchor>[]): Readonly<{
  offsetMs: number
  rate: number
  residualMs: number
  driftPpm: number
} | null> {
  if (anchors.length === 0) return null
  if (anchors.length === 1) {
    // One anchor fixes an offset and says nothing about rate. Reporting a
    // drift of zero here would be inventing a measurement that was not made.
    return Object.freeze({
      offsetMs: anchors[0]!.sessionMs - anchors[0]!.sourceMs,
      rate: 1,
      residualMs: 0,
      driftPpm: 0,
    })
  }
  const n = anchors.length
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumXY = 0
  for (const anchor of anchors) {
    sumX += anchor.sourceMs
    sumY += anchor.sessionMs
    sumXX += anchor.sourceMs * anchor.sourceMs
    sumXY += anchor.sourceMs * anchor.sessionMs
  }
  const denominator = n * sumXX - sumX * sumX
  if (denominator === 0) {
    // Every anchor at the same source instant: an offset, no rate.
    return Object.freeze({
      offsetMs: sumY / n - sumX / n,
      rate: 1,
      residualMs: Math.max(...anchors.map((a) => Math.abs(a.sessionMs - a.sourceMs - (sumY / n - sumX / n)))),
      driftPpm: 0,
    })
  }
  const rate = (n * sumXY - sumX * sumY) / denominator
  const offset = (sumY - rate * sumX) / n
  const residual = Math.max(
    ...anchors.map((anchor) => Math.abs(anchor.sessionMs - (offset + rate * anchor.sourceMs))),
  )
  return Object.freeze({
    offsetMs: offset,
    rate,
    residualMs: residual,
    // Drift is the rate's departure from unity, in parts per million.
    driftPpm: Math.round((rate - 1) * 1_000_000),
  })
}

function refitTrack(
  track: Readonly<TrackDiagnostic>,
  manualAnchors: readonly Readonly<DiagnosticAnchor>[],
): Readonly<TrackDiagnostic> {
  const all = [...track.automaticAnchors, ...manualAnchors]
    .sort((left, right) => left.sourceMs - right.sourceMs)

  // A contradiction is a property of the set, so it is checked before the fit:
  // a line through two irreconcilable anchors is always drawable and always
  // meaningless.
  let contradictory = false
  for (let index = 0; index < all.length; index += 1) {
    for (let other = index + 1; other < all.length; other += 1) {
      if (anchorsContradict(all[index]!, all[other]!)) {
        contradictory = true
        break
      }
    }
    if (contradictory) break
  }

  const fit = contradictory ? null : fitAnchors(all)
  const withResidual = (anchor: Readonly<DiagnosticAnchor>): Readonly<DiagnosticAnchor> => Object.freeze({
    ...anchor,
    residualMs: fit ? Math.abs(anchor.sessionMs - (fit.offsetMs + fit.rate * anchor.sourceMs)) : null,
  })

  const warnings = new Set<DiagnosticWarning>(
    track.warnings.filter((warning) =>
      warning !== 'anchors-contradictory' && warning !== 'residual-above-target'),
  )
  if (contradictory) warnings.add('anchors-contradictory')
  if (fit && fit.residualMs > DIAGNOSTIC_POLICY.mediumResidualMs) warnings.add('residual-above-target')

  // Confidence rises with corroboration but never reaches certainty: more
  // anchors agreeing is stronger evidence, and no number of them makes the
  // measurement exact.
  const confidence = contradictory
    ? Math.min(track.confidence, 0.4)
    : Math.min(0.98, Math.max(track.confidence, 0.5 + Math.min(all.length, 5) * 0.09))

  const status = deriveTrackStatus({
    offsetMs: fit ? fit.offsetMs : null,
    residualMs: fit ? fit.residualMs : null,
    coverageBps: track.coverageBps,
    confidence,
    hasContradictoryAnchors: contradictory,
  })

  return Object.freeze({
    ...track,
    // Automatic anchors are read and rewritten with fresh residuals, never
    // dropped: this is the collection an operator's edit must not touch.
    automaticAnchors: Object.freeze(track.automaticAnchors.map(withResidual)),
    manualAnchors: Object.freeze(manualAnchors.map(withResidual)),
    offsetMs: fit ? Math.round(fit.offsetMs * 1_000) / 1_000 : null,
    residualMs: fit ? Math.round(fit.residualMs * 1_000) / 1_000 : null,
    driftPpm: fit && all.length > 1 ? fit.driftPpm : null,
    confidence,
    status,
    warnings: Object.freeze([...warnings].sort()),
    methods: Object.freeze([...new Set([
      ...track.methods,
      ...(manualAnchors.length > 0 ? ['manual-anchor'] : []),
    ])].sort()),
  })
}

/**
 * Apply one anchor edit and return the next version of the diagnostic.
 *
 * `expectedVersion` is the fence. An edit computed against version 3 is
 * meaningless once version 4 exists — the anchor indices, the fit and the
 * status all moved — so it is refused rather than applied to a document the
 * operator never saw.
 */
export function applyAnchorEdit(input: {
  diagnostic: Readonly<SyncDiagnostic>
  expectedVersion: number
  edit: Readonly<AnchorEdit>
  actorId: string
}): Readonly<SyncDiagnostic> {
  const { diagnostic, edit } = input
  assertDomain(
    diagnostic.version === input.expectedVersion,
    'SYNC_DIAGNOSTIC_VERSION_STALE',
    `this diagnostic is at version ${diagnostic.version}; the edit was computed against ${input.expectedVersion}`,
  )
  const track = diagnostic.tracks.find((entry) => entry.trackId === edit.trackId)
  assertDomain(
    track !== undefined,
    'CAPTURE_TRACK_NOT_FOUND',
    `track ${edit.trackId} is not part of this diagnostic`,
  )

  const manual = [...track!.manualAnchors]
  const index = manual.findIndex((anchor) => anchor.anchorId === edit.anchorId)

  if (edit.action === 'add') {
    assertDomain(index === -1, 'INVALID_ARGUMENT', `anchor ${edit.anchorId} already exists on this track`)
    assertDomain(
      typeof edit.sourceMs === 'number' && typeof edit.sessionMs === 'number',
      'INVALID_ARGUMENT',
      'adding an anchor needs both a source instant and a session instant',
    )
    assertDomain(
      edit.sourceMs >= 0 && edit.sessionMs >= 0,
      'INVALID_ARGUMENT',
      'anchor instants cannot be negative',
    )
    // An automatic anchor with this id would make the two collections
    // ambiguous, and a manual edit must never shadow a measurement.
    assertDomain(
      !track!.automaticAnchors.some((anchor) => anchor.anchorId === edit.anchorId),
      'INVALID_ARGUMENT',
      `anchor ${edit.anchorId} is an automatic anchor and cannot be shadowed by a manual one`,
    )
    manual.push(Object.freeze({
      anchorId: edit.anchorId,
      origin: 'manual' as const,
      sourceMs: edit.sourceMs,
      sessionMs: edit.sessionMs,
      method: 'manual-anchor',
      confidence: 0.9,
      residualMs: null,
      evidenceRef: edit.evidenceRef ?? `operator:${input.actorId}`,
      createdAt: edit.editedAt,
    }))
  } else if (edit.action === 'move') {
    assertDomain(index >= 0, 'INVALID_ARGUMENT', `anchor ${edit.anchorId} is not a manual anchor on this track`)
    assertDomain(
      typeof edit.sourceMs === 'number' && typeof edit.sessionMs === 'number',
      'INVALID_ARGUMENT',
      'moving an anchor needs both a source instant and a session instant',
    )
    manual[index] = Object.freeze({
      ...manual[index]!,
      sourceMs: edit.sourceMs,
      sessionMs: edit.sessionMs,
      residualMs: null,
      createdAt: edit.editedAt,
    })
  } else {
    // Removing an automatic anchor is not an edit an operator may make: it
    // would delete a measurement rather than a correction.
    assertDomain(
      index >= 0,
      'INVALID_ARGUMENT',
      `anchor ${edit.anchorId} is not a manual anchor on this track; automatic anchors cannot be removed by hand`,
    )
    manual.splice(index, 1)
  }

  const refitted = refitTrack(track!, manual)
  return createSyncDiagnostic({
    workspaceId: diagnostic.workspaceId,
    sessionId: diagnostic.sessionId,
    referenceTrackId: diagnostic.referenceTrackId,
    version: diagnostic.version + 1,
    previousVersionHash: diagnostic.diagnosticHash,
    sessionVersion: diagnostic.sessionVersion,
    referenceEpoch: diagnostic.referenceEpoch,
    tracks: diagnostic.tracks.map((entry) => (entry.trackId === edit.trackId ? refitted : entry)),
    protocolCeiling: diagnostic.protocolCeiling,
    generatedAt: edit.editedAt,
  })
}

/** Refit every track without changing any anchor. Used after a re-detection. */
export function refitDiagnostic(input: {
  diagnostic: Readonly<SyncDiagnostic>
  generatedAt: string
}): Readonly<SyncDiagnostic> {
  return createSyncDiagnostic({
    workspaceId: input.diagnostic.workspaceId,
    sessionId: input.diagnostic.sessionId,
    referenceTrackId: input.diagnostic.referenceTrackId,
    version: input.diagnostic.version + 1,
    previousVersionHash: input.diagnostic.diagnosticHash,
    sessionVersion: input.diagnostic.sessionVersion,
    referenceEpoch: input.diagnostic.referenceEpoch,
    tracks: input.diagnostic.tracks.map((track) => refitTrack(track, track.manualAnchors)),
    protocolCeiling: input.diagnostic.protocolCeiling,
    generatedAt: input.generatedAt,
  })
}
