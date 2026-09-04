import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SYNC_EVIDENCE_THRESHOLDS,
  REQUIRED_SYNC_PRECONDITIONS,
  SYNC_METHODS,
  applySyncEvidenceRecord,
  evaluateSyncEvidence,
  peakRatioOf,
  serializeSyncEvidenceRecord,
} from '../../src/v2/domain/sync-evidence.ts'
import { createTickInterval, rational, timebaseFromRate } from '../../src/v2/domain/session-time.ts'

/**
 * Preconditions are a contract of the method, not free text a provider makes
 * up: `REQUIRED_SYNC_PRECONDITIONS` names exactly what each method must be able
 * to assert before it may be considered at all.
 */
function satisfiedPreconditionsFor(method) {
  return REQUIRED_SYNC_PRECONDITIONS[method].map((id) => ({
    id,
    satisfied: true,
    detail: `${id} holds for this pair of tracks`,
  }))
}

function unmetPrecondition(method, detail) {
  return REQUIRED_SYNC_PRECONDITIONS[method].map((id, index) => ({
    id,
    satisfied: index !== 0,
    detail: index === 0 ? detail : `${id} holds`,
  }))
}

const t = (n) => BigInt(n)
const SESSION_TB = timebaseFromRate(90_000)
const FRAME_RATE = rational(BigInt(30))
const FRAME_TICKS = 3_000
const BOUNDS = createTickInterval(t(0), t(90_000) * t(3_600))

/** Anchors spread across the three thirds, so distribution gates are satisfied. */
function anchors(offsetTicks, count = 6) {
  return Array.from({ length: count }, (_, index) => {
    const sourceTick = t(90_000) * t(index * 600)
    return {
      anchorId: `anchor-${index}`,
      sourceTick,
      sessionTick: sourceTick + t(offsetTicks),
      evidenceRef: `probe-${index}`,
    }
  })
}

function signal(overrides = {}) {
  const offsetTicks = overrides.offsetTicks ?? t(45_000)
  return {
    signalId: 'signal-audio',
    method: 'audio-fingerprint',
    timebase: SESSION_TB,
    offsetTicks,
    anchors: anchors(Number(offsetTicks)),
    preconditions: satisfiedPreconditionsFor(overrides.method ?? 'audio-fingerprint'),
    ambiguity: { bestPeak: 0.92, secondBestPeak: 0.31, windowsConsidered: 12, windowsAgreeing: 11 },
    coverage: [BOUNDS],
    residualTicks: t(120),
    confidence: 0.93,
    independenceGroup: 'audio-correlation',
    evidenceRefs: ['probe-audio-1'],
    ...overrides,
  }
}

function evaluate(signals, thresholds) {
  return evaluateSyncEvidence({
    sessionId: 'capture-session-1',
    trackId: 'track-cam-alt',
    referenceTrackId: 'track-cam-main',
    sessionTimebase: SESSION_TB,
    sessionFrameRate: FRAME_RATE,
    sessionBounds: BOUNDS,
    signals,
    ...(thresholds ? { thresholds } : {}),
  })
}

test('T-FR-142 the cascade is the documented order, strongest evidence first', () => {
  assert.deepEqual([...SYNC_METHODS], [
    'shared-timecode', 'trusted-metadata', 'apollo-marker',
    'audio-fingerprint', 'visual-event', 'transcript-lip', 'manual-anchor',
  ])
})

test('T-FR-142 precedence beats a higher score, not the other way round', () => {
  // The defect this replaces ranked by score with precedence only as a
  // tiebreak. Here the audio signal is better on every quality axis and the
  // timecode still wins, because "one clock read directly" is a different kind
  // of evidence, not a better measurement of the same kind.
  const record = evaluate([
    signal({
      signalId: 'signal-audio', method: 'audio-fingerprint',
      confidence: 0.99, residualTicks: t(10),
      ambiguity: { bestPeak: 0.99, secondBestPeak: 0.05, windowsConsidered: 40, windowsAgreeing: 40 },
      independenceGroup: 'audio-correlation',
    }),
    signal({
      signalId: 'signal-timecode', method: 'shared-timecode',
      confidence: 0.80, residualTicks: t(300),
      ambiguity: { bestPeak: 0.80, secondBestPeak: 0.40, windowsConsidered: 4, windowsAgreeing: 3 },
      independenceGroup: 'timecode-read',
    }),
  ])

  assert.equal(record.selectedMethod, 'shared-timecode')
  assert.equal(record.selectedSignalId, 'signal-timecode')
  const audio = record.discarded.find((entry) => entry.signalId === 'signal-audio')
  assert.equal(audio.reason, 'outranked-by-precedence')
  // The discarded alternative keeps its score, so a reader can see it was the
  // stronger measurement and still lost on kind.
  assert.ok(audio.score > 0)
  assert.match(audio.detail, /\S/)
})

test('T-FR-142 no common signal produces insufficient-evidence and no offset at all', () => {
  const record = evaluate([])
  assert.equal(record.outcome, 'insufficient-evidence')
  assert.equal(record.selectedSignalId, null)
  assert.equal(record.selectedMethod, null)
  // Enforced, not merely intended: there is no map to apply.
  assert.equal(record.clockMap, null)
  assert.equal(record.manualRequired, true)
  assert.ok(record.outcomeReasons.length > 0)
  assert.throws(() => applySyncEvidenceRecord(record, t(0)), /./)
})

test('T-FR-142 an unmet precondition removes a signal from consideration', () => {
  // A screen recording with no audio cannot be aligned by audio correlation,
  // however confident the correlator claims to be.
  const record = evaluate([
    signal({
      preconditions: unmetPrecondition('audio-fingerprint', 'the screen track has no audio stream'),
    }),
  ])
  assert.equal(record.outcome, 'insufficient-evidence')
  assert.equal(record.clockMap, null)
  const discarded = record.discarded.find((entry) => entry.signalId === 'signal-audio')
  assert.equal(discarded.reason, 'precondition-unmet')
  assert.match(discarded.detail, /both-tracks-carry-audio/)
})

test('T-FR-142 an ambiguous peak is refused: the search could have picked either', () => {
  // A ratio near 1 means the second-best window was almost as good. Emitting
  // the best one anyway is inventing a decision the measurement did not make.
  const record = evaluate([
    signal({ ambiguity: { bestPeak: 0.51, secondBestPeak: 0.50, windowsConsidered: 20, windowsAgreeing: 3 } }),
  ])
  assert.equal(record.outcome, 'insufficient-evidence')
  assert.equal(record.clockMap, null)
  assert.equal(record.discarded[0].reason, 'ambiguous-peak')

  // And a signal that reports no ambiguity evidence at all cannot be admitted
  // either: "I did not measure the runner-up" is not "there was no runner-up".
  const silent = evaluate([signal({ ambiguity: undefined })])
  assert.equal(silent.discarded[0].reason, 'ambiguity-evidence-missing')
  assert.equal(peakRatioOf(undefined), null)
})

test('T-FR-142 two independent signals that agree corroborate each other', () => {
  const record = evaluate([
    signal({ signalId: 'signal-audio', independenceGroup: 'audio-correlation' }),
    signal({ signalId: 'signal-visual', method: 'visual-event', independenceGroup: 'visual-flash', evidenceRefs: ['probe-visual-1'] }),
  ])
  assert.equal(record.outcome, 'auto-apply')
  assert.ok(record.corroborations.length > 0)
  assert.equal(record.corroborations[0].deltaSessionTicks, t(0))
  assert.equal(record.clockMap !== null, true)
  assert.equal(applySyncEvidenceRecord(record, t(0)), t(45_000))
})

test('T-FR-142 two windows of the same correlation are one opinion, not two', () => {
  // Signals sharing an independence group measured the same physical thing.
  // Counting them as mutual corroboration would manufacture confidence out of
  // one measurement reported twice.
  const record = evaluate([
    signal({ signalId: 'signal-audio-a', independenceGroup: 'audio-correlation' }),
    signal({ signalId: 'signal-audio-b', independenceGroup: 'audio-correlation', evidenceRefs: ['probe-audio-2'] }),
  ])
  assert.deepEqual([...record.corroborations], [])
  assert.deepEqual([...record.contradictions], [])
})

test('T-FR-142 independent signals that contradict hard emit no offset', () => {
  // One track cannot sit at two places on the session clock. Picking the
  // better-scoring of two irreconcilable answers is exactly the invented
  // precision the cascade exists to refuse.
  const far = t(FRAME_TICKS * (DEFAULT_SYNC_EVIDENCE_THRESHOLDS.hardContradictionFrames + 20))
  const record = evaluate([
    signal({ signalId: 'signal-audio', independenceGroup: 'audio-correlation', offsetTicks: t(45_000) }),
    signal({
      signalId: 'signal-visual', method: 'visual-event', independenceGroup: 'visual-flash',
      offsetTicks: t(45_000) + far, evidenceRefs: ['probe-visual-1'],
    }),
  ])
  assert.ok(record.contradictions.length > 0)
  assert.equal(record.contradictions.some((entry) => entry.severity === 'hard'), true)
  assert.equal(record.outcome, 'insufficient-evidence')
  assert.equal(record.clockMap, null)
  assert.equal(record.manualRequired, true)
})

test('T-FR-142 a soft contradiction survives but cannot be applied automatically', () => {
  const soft = t(FRAME_TICKS * (DEFAULT_SYNC_EVIDENCE_THRESHOLDS.softContradictionFrames + 1))
  const record = evaluate([
    signal({ signalId: 'signal-audio', independenceGroup: 'audio-correlation', offsetTicks: t(45_000) }),
    signal({
      signalId: 'signal-visual', method: 'visual-event', independenceGroup: 'visual-flash',
      offsetTicks: t(45_000) + soft, evidenceRefs: ['probe-visual-1'],
    }),
  ])
  assert.ok(record.contradictions.some((entry) => entry.severity === 'soft'))
  assert.notEqual(record.outcome, 'auto-apply')
})

test('T-FR-142 a manual anchor is a fallback, and it is enough on its own', () => {
  // Last in the cascade, but a human pointing at the same instant in two
  // recordings is real evidence — it just loses to anything measured.
  const record = evaluate([
    signal({
      signalId: 'signal-manual', method: 'manual-anchor', independenceGroup: 'operator',
      ambiguity: { bestPeak: 1, secondBestPeak: 0.001, windowsConsidered: 1, windowsAgreeing: 1 },
      evidenceRefs: ['operator-action-1'],
    }),
  ])
  assert.equal(record.selectedMethod, 'manual-anchor')
  assert.notEqual(record.outcome, 'insufficient-evidence')
})

test('T-FR-142 every discarded alternative records why it lost', () => {
  const record = evaluate([
    signal({ signalId: 'signal-timecode', method: 'shared-timecode', independenceGroup: 'timecode-read' }),
    signal({ signalId: 'signal-audio', independenceGroup: 'audio-correlation' }),
    signal({
      signalId: 'signal-broken', method: 'visual-event', independenceGroup: 'visual-flash',
      preconditions: unmetPrecondition('visual-event', 'no flash in the alt camera'),
      evidenceRefs: ['probe-visual-2'],
    }),
  ])
  assert.equal(record.discarded.length, 2)
  for (const entry of record.discarded) {
    assert.ok(entry.reason, 'a discard without a reason is unauditable')
    assert.match(entry.detail, /\S/)
    assert.ok(Number.isFinite(entry.score))
    assert.ok(Number.isFinite(entry.precedence))
  }
  // The thresholds actually used travel with the record, so a later reader can
  // tell whether a decision would still hold under today's policy.
  assert.equal(record.thresholds.schemaVersion, DEFAULT_SYNC_EVIDENCE_THRESHOLDS.schemaVersion)
})

test('T-FR-142 the record serializes without leaking bigint or losing the verdict', () => {
  const record = evaluate([signal()])
  const wire = serializeSyncEvidenceRecord(record)
  const json = JSON.stringify(wire)
  assert.match(json, /"outcome"/)
  assert.equal(json.includes('undefined'), false)
  // A round trip through JSON must not silently turn a refusal into a pass.
  assert.equal(JSON.parse(json).outcome, record.outcome)
})

test('T-FR-142 a measured rate is distinguished from an assumed one', () => {
  // `rate` absent means "not measured", never "1.0". Recording the difference
  // is what stops an unmeasured signal from later looking like a confirmed
  // zero-drift alignment.
  const assumed = evaluate([signal()])
  const measured = evaluate([signal({ rate: rational(BigInt(1_000_120), BigInt(1_000_000)) })])
  const assumedAssessment = assumed.assessments.find((entry) => entry.signalId === 'signal-audio')
  const measuredAssessment = measured.assessments.find((entry) => entry.signalId === 'signal-audio')

  assert.equal(assumedAssessment.rateMeasured, false)
  assert.equal(assumedAssessment.ratePpm, 0)
  assert.equal(measuredAssessment.rateMeasured, true)
  assert.equal(measuredAssessment.ratePpm, 120)
})
