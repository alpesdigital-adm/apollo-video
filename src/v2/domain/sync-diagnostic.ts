import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { SyncCeiling } from './capture-protocol.ts'
import type { TickInterval } from './session-time.ts'

/**
 * F4.011 — the versioned synchronization diagnostic (FR-149, spec 05 §18).
 *
 * One document answering the only question an editor has before cutting: can I
 * trust this timeline, and if not, what do I do about it?
 *
 * Three decisions shape it.
 *
 * **Status is derived, never set.** A caller that could write `synced-high`
 * would eventually write it on a session that had not earned it — not from
 * malice, from a retry loop or a default. The status falls out of the residual,
 * the coverage and the anchors, and `deriveStatus` is the only place it comes
 * from.
 *
 * **Automatic anchors and manual anchors never overwrite each other.** They are
 * separate collections. Editing manual anchors leaves the measured ones exactly
 * as they were, which is what makes "undo my correction" possible without
 * re-running detection.
 *
 * **A version is a snapshot, not a mutation.** Every anchor edit produces the
 * next version carrying the hash of the one it replaced, so the diagnostic a
 * cut was approved against stays readable after somebody nudges an anchor.
 */

export const SYNC_DIAGNOSTIC_SCHEMA_VERSION = 'sync-diagnostic/v1' as const

export const DIAGNOSTIC_STATUSES = Object.freeze([
  'synced-high',
  'synced-medium',
  'partial',
  'needs-input',
  'failed',
] as const)
export type DiagnosticStatus = (typeof DIAGNOSTIC_STATUSES)[number]

export const ANCHOR_ORIGINS = Object.freeze(['automatic', 'manual'] as const)
export type AnchorOrigin = (typeof ANCHOR_ORIGINS)[number]

export const DIAGNOSTIC_WARNINGS = Object.freeze([
  'insufficient-evidence',
  'residual-above-target',
  'coverage-below-floor',
  'drift-uncorrectable',
  'anchors-contradictory',
  'protocol-requirements-unmet',
  'single-channel-marker-only',
  'reference-track-changed',
] as const)
export type DiagnosticWarning = (typeof DIAGNOSTIC_WARNINGS)[number]

export const RECOMMENDED_ACTIONS = Object.freeze([
  'add-manual-anchor',
  'move-manual-anchor',
  'reshoot-with-marker',
  'select-different-reference',
  'accept-and-review-manually',
  'split-into-piecewise-segment',
] as const)
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number]

export interface DiagnosticAnchor {
  readonly anchorId: string
  readonly origin: AnchorOrigin
  /** Milliseconds on the track's own timeline. */
  readonly sourceMs: number
  /** Milliseconds on the session timeline. */
  readonly sessionMs: number
  /** How the anchor was obtained: a marker, a correlation, or a person. */
  readonly method: string
  readonly confidence: number
  /** Residual against the fitted map, filled in after the fit. Null before. */
  readonly residualMs: number | null
  readonly evidenceRef: string
  readonly createdAt: string
}

export interface TrackDiagnostic {
  readonly trackId: string
  readonly methods: readonly string[]
  readonly confidence: number
  readonly offsetMs: number | null
  readonly residualMs: number | null
  readonly driftPpm: number | null
  /** Covered fraction in basis points, so it stays an integer. */
  readonly coverageBps: number
  readonly gaps: readonly Readonly<TickInterval>[]
  readonly automaticAnchors: readonly Readonly<DiagnosticAnchor>[]
  readonly manualAnchors: readonly Readonly<DiagnosticAnchor>[]
  /** Ids of the piecewise map pieces this track resolved into. */
  readonly pieceIds: readonly string[]
  readonly status: DiagnosticStatus
  readonly warnings: readonly DiagnosticWarning[]
  /** Session-time instants an editor can scrub to and compare. */
  readonly previewSampleMs: readonly number[]
}

export interface SyncDiagnostic {
  readonly schemaVersion: typeof SYNC_DIAGNOSTIC_SCHEMA_VERSION
  readonly workspaceId: string
  readonly sessionId: string
  readonly referenceTrackId: string
  /** 1-based. Every anchor edit produces the next one. */
  readonly version: number
  readonly previousVersionHash: string | null
  /** The exact session version and reference epoch this describes. */
  readonly sessionVersion: number
  readonly referenceEpoch: number
  readonly status: DiagnosticStatus
  readonly globalConfidence: number
  readonly tracks: readonly Readonly<TrackDiagnostic>[]
  readonly warnings: readonly DiagnosticWarning[]
  readonly recommendedActions: readonly RecommendedAction[]
  readonly manualRequired: boolean
  /** The ceiling the capture protocol placed on this session, if evaluated. */
  readonly protocolCeiling: SyncCeiling | null
  readonly generatedAt: string
  readonly diagnosticHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

/**
 * Thresholds, named rather than inlined.
 *
 * The residual targets are in milliseconds because that is what an editor
 * perceives: lip-sync error becomes visible somewhere around 40 ms and
 * objectionable well before 100. Coverage is in basis points to stay integral.
 */
export const DIAGNOSTIC_POLICY = Object.freeze({
  highResidualMs: 20,
  mediumResidualMs: 60,
  minimumCoverageBps: 9_000,
  partialCoverageBps: 7_000,
  highConfidence: 0.85,
  mediumConfidence: 0.7,
  /** Anchors disagreeing by more than this cannot both describe one map. */
  contradictionMs: 250,
})

function assertId(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is not a canonical identifier`)
  return value
}

/**
 * Derive one track's status from what was actually measured.
 *
 * Ordered worst-first so the first condition that applies wins: a track with
 * no offset at all is `needs-input` even if its coverage looks excellent,
 * because coverage of an unaligned track measures nothing useful.
 */
export function deriveTrackStatus(input: {
  offsetMs: number | null
  residualMs: number | null
  coverageBps: number
  confidence: number
  hasContradictoryAnchors: boolean
}): DiagnosticStatus {
  if (input.hasContradictoryAnchors) return 'needs-input'
  // No offset means nothing aligned this track. Coverage and confidence
  // describe a measurement that was never made.
  if (input.offsetMs === null || input.residualMs === null) return 'needs-input'
  if (input.coverageBps < DIAGNOSTIC_POLICY.partialCoverageBps) return 'partial'
  if (
    input.residualMs <= DIAGNOSTIC_POLICY.highResidualMs
    && input.coverageBps >= DIAGNOSTIC_POLICY.minimumCoverageBps
    && input.confidence >= DIAGNOSTIC_POLICY.highConfidence
  ) return 'synced-high'
  if (
    input.residualMs <= DIAGNOSTIC_POLICY.mediumResidualMs
    && input.confidence >= DIAGNOSTIC_POLICY.mediumConfidence
  ) return 'synced-medium'
  return 'partial'
}

/**
 * The session's status is its worst track, not its average.
 *
 * Averaging would let three good tracks carry one that never aligned, and the
 * editor would find out on the timeline.
 */
export function deriveSessionStatus(tracks: readonly Readonly<TrackDiagnostic>[]): DiagnosticStatus {
  if (tracks.length === 0) return 'needs-input'
  const rank: Record<DiagnosticStatus, number> = {
    failed: 0,
    'needs-input': 1,
    partial: 2,
    'synced-medium': 3,
    'synced-high': 4,
  }
  return tracks.reduce<DiagnosticStatus>(
    (worst, track) => (rank[track.status] < rank[worst] ? track.status : worst),
    'synced-high',
  )
}

/**
 * Whether two anchors can describe the same affine map.
 *
 * Compares the session instant each predicts for the other's source instant.
 * Two anchors far apart in time legitimately differ in raw offset when there
 * is drift; what cannot happen is disagreeing about where the same source
 * instant lands.
 */
export function anchorsContradict(
  left: Readonly<DiagnosticAnchor>,
  right: Readonly<DiagnosticAnchor>,
): boolean {
  if (left.sourceMs === right.sourceMs) {
    return Math.abs(left.sessionMs - right.sessionMs) > DIAGNOSTIC_POLICY.contradictionMs
  }
  // Different instants: a single line through both is always possible, so the
  // question is whether the implied rate is physically plausible. A recorder
  // off by more than a part in a hundred is broken, not drifting.
  const rate = (right.sessionMs - left.sessionMs) / (right.sourceMs - left.sourceMs)
  return !Number.isFinite(rate) || rate <= 0 || Math.abs(rate - 1) > 0.01
}

export function createSyncDiagnostic(input: {
  workspaceId: string
  sessionId: string
  referenceTrackId: string
  version: number
  previousVersionHash: string | null
  sessionVersion: number
  referenceEpoch: number
  tracks: readonly Readonly<TrackDiagnostic>[]
  protocolCeiling?: SyncCeiling | null
  generatedAt: string
}): Readonly<SyncDiagnostic> {
  assertId(input.workspaceId, 'workspaceId')
  assertId(input.sessionId, 'sessionId')
  assertId(input.referenceTrackId, 'referenceTrackId')
  assertDomain(
    Number.isSafeInteger(input.version) && input.version >= 1,
    'INVALID_ARGUMENT',
    'a diagnostic version is a positive integer',
  )
  assertDomain(
    (input.version === 1) === (input.previousVersionHash === null),
    'INVALID_ARGUMENT',
    'version 1 has nothing before it, and every later version must name what it replaced',
  )
  assertDomain(
    Number.isSafeInteger(input.sessionVersion) && input.sessionVersion >= 1
      && Number.isSafeInteger(input.referenceEpoch) && input.referenceEpoch >= 1,
    'INVALID_ARGUMENT',
    'a diagnostic must name the session version and reference epoch it describes',
  )
  assertDomain(
    !input.tracks.some((track) => track.trackId === input.referenceTrackId),
    'INVALID_ARGUMENT',
    'the reference track is the clock and is not diagnosed against itself',
  )

  for (const track of input.tracks) {
    assertId(track.trackId, 'trackId')
    assertDomain(
      track.coverageBps >= 0 && track.coverageBps <= 10_000,
      'INVALID_ARGUMENT',
      `track ${track.trackId} coverage must be in basis points`,
    )
    assertDomain(
      track.confidence >= 0 && track.confidence <= 1,
      'INVALID_ARGUMENT',
      `track ${track.trackId} confidence must be in [0,1]`,
    )
    // A track claiming an offset has to say how well it fits. An offset with
    // no residual is a number nobody can challenge.
    assertDomain(
      (track.offsetMs === null) === (track.residualMs === null),
      'INVALID_ARGUMENT',
      `track ${track.trackId} must report an offset and its residual together, or neither`,
    )
    const expected = deriveTrackStatus({
      offsetMs: track.offsetMs,
      residualMs: track.residualMs,
      coverageBps: track.coverageBps,
      confidence: track.confidence,
      hasContradictoryAnchors: track.warnings.includes('anchors-contradictory'),
    })
    // The status is derived, so a supplied one that disagrees is refused
    // rather than trusted: this is the field every downstream gate reads.
    assertDomain(
      track.status === expected,
      'INVALID_ARGUMENT',
      `track ${track.trackId} reports ${track.status} but its measurements derive ${expected}`,
    )
  }

  const status = deriveSessionStatus(input.tracks)
  const warnings = Object.freeze([...new Set(input.tracks.flatMap((track) => track.warnings))].sort())
  const manualRequired = status === 'needs-input' || status === 'failed'
    || input.protocolCeiling === 'manual-anchors-required'
    || input.protocolCeiling === 'not-synchronizable'
  const globalConfidence = input.tracks.length === 0
    ? 0
    // The weakest track, for the same reason the status is the worst one.
    : Math.min(...input.tracks.map((track) => track.confidence))

  const body = {
    schemaVersion: SYNC_DIAGNOSTIC_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    referenceTrackId: input.referenceTrackId,
    version: input.version,
    previousVersionHash: input.previousVersionHash,
    sessionVersion: input.sessionVersion,
    referenceEpoch: input.referenceEpoch,
    status,
    globalConfidence,
    tracks: Object.freeze(input.tracks.map((track) => Object.freeze({
      ...track,
      methods: Object.freeze([...track.methods]),
      gaps: Object.freeze([...track.gaps]),
      automaticAnchors: Object.freeze([...track.automaticAnchors]),
      manualAnchors: Object.freeze([...track.manualAnchors]),
      pieceIds: Object.freeze([...track.pieceIds]),
      warnings: Object.freeze([...track.warnings]),
      previewSampleMs: Object.freeze([...track.previewSampleMs]),
    }))),
    warnings,
    recommendedActions: deriveActions(status, warnings, input.protocolCeiling ?? null),
    manualRequired,
    protocolCeiling: input.protocolCeiling ?? null,
    generatedAt: input.generatedAt,
  }
  return Object.freeze({ ...body, diagnosticHash: calculateCanonicalHash(body) })
}

/**
 * What to do about it.
 *
 * An action list is the difference between a diagnostic and a complaint. Each
 * one is something the operator can actually perform from the UI.
 */
function deriveActions(
  status: DiagnosticStatus,
  warnings: readonly DiagnosticWarning[],
  ceiling: SyncCeiling | null,
): readonly RecommendedAction[] {
  const actions = new Set<RecommendedAction>()
  if (status === 'needs-input' || status === 'failed') actions.add('add-manual-anchor')
  if (warnings.includes('anchors-contradictory')) {
    actions.add('move-manual-anchor')
    // Two anchors that cannot share a map may still each be right about their
    // own stretch of the recording.
    actions.add('split-into-piecewise-segment')
  }
  if (warnings.includes('insufficient-evidence')) {
    actions.add('add-manual-anchor')
    if (ceiling === 'not-synchronizable') actions.add('reshoot-with-marker')
  }
  if (warnings.includes('coverage-below-floor')) actions.add('split-into-piecewise-segment')
  if (warnings.includes('reference-track-changed')) actions.add('select-different-reference')
  if (status === 'synced-medium' || status === 'partial') actions.add('accept-and-review-manually')
  return Object.freeze([...actions].sort())
}

export function assertSyncDiagnosticIntegrity(diagnostic: Readonly<SyncDiagnostic>): Readonly<SyncDiagnostic> {
  assertDomain(
    diagnostic.schemaVersion === SYNC_DIAGNOSTIC_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored sync diagnostic schema is invalid',
  )
  const { diagnosticHash, ...body } = diagnostic
  assertDomain(
    calculateCanonicalHash(body) === diagnosticHash,
    'PERSISTENCE_CONFLICT',
    'stored sync diagnostic hash does not match its body',
  )
  return diagnostic
}

/**
 * Whether unattended editing is allowed.
 *
 * Deliberately not a threshold on a single number. Every one of these is a way
 * the timeline could be wrong in a manner an unattended cut would not survive,
 * and the protocol ceiling is included because a session that never had the
 * evidence cannot be rescued by a confident-looking fit.
 */
export function canAutoEdit(diagnostic: Readonly<SyncDiagnostic>): Readonly<{
  allowed: boolean
  blockedBy: readonly string[]
}> {
  const blocked: string[] = []
  if (diagnostic.status !== 'synced-high' && diagnostic.status !== 'synced-medium') {
    blocked.push(`session status is ${diagnostic.status}`)
  }
  if (diagnostic.manualRequired) blocked.push('manual input is required')
  if (diagnostic.globalConfidence < DIAGNOSTIC_POLICY.mediumConfidence) {
    blocked.push(`weakest track confidence ${diagnostic.globalConfidence.toFixed(2)} is below the floor`)
  }
  if (diagnostic.warnings.includes('insufficient-evidence')) blocked.push('a track has no usable evidence')
  if (diagnostic.warnings.includes('anchors-contradictory')) blocked.push('anchors contradict each other')
  if (
    diagnostic.protocolCeiling === 'manual-anchors-required'
    || diagnostic.protocolCeiling === 'not-synchronizable'
  ) {
    blocked.push(`the capture protocol caps this session at ${diagnostic.protocolCeiling}`)
  }
  return Object.freeze({ allowed: blocked.length === 0, blockedBy: Object.freeze(blocked) })
}
