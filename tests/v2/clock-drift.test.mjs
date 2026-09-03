import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_DRIFT_POLICY,
  createDriftAnchor,
  createMappingFromDriftFit,
  driftToleranceRate,
  fitClockDrift,
} from '../../src/v2/domain/clock-drift.ts'
import { createSessionClock, createSourceClock } from '../../src/v2/domain/session-clock.ts'
import {
  createTickInterval,
  ppmToRate,
  rational,
  rationalToPpm,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'

const t = (n) => BigInt(n)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()

const CLOCK = createSessionClock({
  sessionId: 'capture-session-1',
  timebase: timebaseFromRate(90_000),
  frameRate: rational(BigInt(30)),
  authority: { origin: 'primary-camera', sourceId: 'asset-cam', provenance: 'original-capture', evidenceRef: 'probe-1' },
  establishedAt: at(0),
})
const SOURCE = createSourceClock({
  sourceId: 'asset-cam',
  timebase: timebaseFromRate(90_000),
  provenance: 'original-capture',
})

const SPAN_SECONDS = 3_600
const SPAN = createTickInterval(t(0), t(90_000) * t(SPAN_SECONDS))

/**
 * Build anchors that lie exactly on a known affine law, so the fit has a truth
 * to be measured against instead of being asked to agree with itself.
 */
function anchorsFor({ ppm, offsetTicks = 0, seconds = [0, 900, 1_800, 2_700, 3_500], jitter = () => 0 }) {
  const rate = ppmToRate(ppm)
  return seconds.map((second, index) => {
    const sourceTick = t(90_000) * t(second)
    const exact = (sourceTick * rate.num) / rate.den + t(offsetTicks)
    return createDriftAnchor({
      id: `anchor-${index}`,
      sourceTick,
      sessionTick: exact + t(jitter(index)),
      method: 'audio',
      confidence: 'high',
      evidenceRef: `probe-anchor-${index}`,
    })
  })
}

function fit(overrides = {}) {
  return fitClockDrift({ clock: CLOCK, source: SOURCE, anchors: anchorsFor({ ppm: 120 }), span: SPAN, ...overrides })
}

test('T-FR-144 a known injected drift is recovered exactly from distributed anchors', () => {
  // +120 ppm over an hour is 432 ms of accumulated skew — the difference
  // between lip-sync and visibly wrong.
  const result = fit()
  assert.equal(result.status, 'fitted')
  assert.equal(result.driftPpm, 120)
  assert.equal(rationalToPpm(result.driftRate), 120)
  assert.equal(result.offsetTicks, t(0))
  assert.equal(result.usedAnchorIds.length, 5)
  assert.deepEqual([...result.rejected], [])
  // Every anchor lies on the law, so nothing is left over.
  assert.equal(result.residualDistribution.maxAbsTicks, t(0))
  assert.ok(result.residuals.every((entry) => entry.residualTicks === t(0)))
  assert.equal(result.decision, 'auto-apply')
})

test('T-FR-144 negative drift is recovered with the same fidelity', () => {
  const result = fit({ anchors: anchorsFor({ ppm: -45 }) })
  assert.equal(result.status, 'fitted')
  assert.equal(result.driftPpm, -45)
  assert.equal(rationalToPpm(result.driftRate), -45)
})

test('T-FR-144 an offset is recovered alongside the rate', () => {
  const result = fit({ anchors: anchorsFor({ ppm: 120, offsetTicks: 45_000 }) })
  assert.equal(result.status, 'fitted')
  assert.equal(result.driftPpm, 120)
  assert.equal(result.offsetTicks, t(45_000))
})

test('T-FR-144 the fit uses every anchor, not just the first and the last', () => {
  // The shallow model this replaces took only the endpoints. The discriminator
  // is not that the rate moves — displacing the *middle* anchor is precisely
  // where a least-squares fit is most robust, and the rate barely shifts. It is
  // that a two-point fit through the endpoints leaves those endpoints with
  // residual exactly zero, by construction. Here they do not.
  const anchors = anchorsFor({ ppm: 120, jitter: (index) => (index === 2 ? 9_000 : 0) })
  const result = fit({ anchors })
  assert.equal(result.status, 'fitted')

  const byId = new Map(result.residuals.map((entry) => [entry.anchorId, entry.residualTicks]))
  assert.notEqual(byId.get('anchor-0'), t(0), 'an endpoint-only fit would leave this at exactly zero')
  assert.notEqual(byId.get('anchor-4'), t(0), 'an endpoint-only fit would leave this at exactly zero')
  assert.equal(byId.get('anchor-2'), t(7_199))

  // The displaced anchor is flagged as an outlier but stays in the fit: removing
  // it would hide the very disagreement that makes the result untrustworthy.
  assert.ok(result.outlierAnchorIds.includes('anchor-2'))
  assert.ok(result.usedAnchorIds.includes('anchor-2'))
  // 7199 ticks is past the two-frame residual target, so this is not applied.
  assert.equal(result.decision, 'new-piece')
})

test('T-FR-144 anchors clustered at one end refuse to produce a rate', () => {
  // Five anchors inside the first four minutes of an hour say nothing about
  // what the clocks do afterwards. Extrapolating from them is exactly the
  // invented precision ADR-130 forbids.
  const result = fit({ anchors: anchorsFor({ ppm: 120, seconds: [0, 30, 60, 120, 240] }) })
  assert.equal(result.status, 'insufficient-evidence')
  assert.ok(['anchors-clustered', 'anchors-outside-span'].includes(result.reason))
  assert.match(result.detail, /\S/)
})

test('T-FR-144 two anchors that contradict each other are refused, never averaged', () => {
  // One source instant cannot be two session instants. The mean of the two is a
  // number that describes neither.
  const base = anchorsFor({ ppm: 120 })
  const contradiction = createDriftAnchor({
    id: 'anchor-contradiction',
    sourceTick: base[2].sourceTick,
    sessionTick: base[2].sessionTick + t(90_000),
    method: 'manual',
    confidence: 'high',
    evidenceRef: 'operator-note-1',
  })
  const result = fit({ anchors: [...base, contradiction] })
  assert.equal(result.status, 'insufficient-evidence')
  assert.equal(result.reason, 'conflicting-anchors')
})

test('T-FR-144 too few anchors is a refusal with a reason, not a guess', () => {
  const result = fit({ anchors: anchorsFor({ ppm: 120, seconds: [0] }) })
  assert.equal(result.status, 'insufficient-evidence')
  assert.equal(result.reason, 'too-few-anchors')
  assert.deepEqual([...result.usedAnchorIds], ['anchor-0'])
})

test('T-FR-144 drift inside tolerance is measured and deliberately left alone', () => {
  // The threshold is derived from the frame rate, not fixed in ppm: "one frame
  // per ten minutes" is a different rate error at 24 fps than at 60.
  const tolerance = driftToleranceRate(CLOCK, DEFAULT_DRIFT_POLICY.toleranceWindowSeconds)
  const smallPpm = Math.max(1, Math.floor(rationalToPpm(tolerance) / 2))
  const result = fit({ anchors: anchorsFor({ ppm: smallPpm }) })

  assert.equal(result.status, 'fitted')
  assert.equal(result.tolerance.withinTolerance, true)
  assert.equal(result.correction.action, 'none')
  assert.equal(result.correction.reason, 'within-tolerance')
  // Measured and reported all the same — "no correction" is a decision, not
  // an absence of information.
  assert.equal(result.driftPpm, smallPpm)
})

test('T-FR-144 an unsafe stretch of speech fails closed, and silence is never assumed', () => {
  const violent = DEFAULT_DRIFT_POLICY.speechStretchLimitPpm * 3
  const speech = fit({ anchors: anchorsFor({ ppm: violent }), carriesSpeech: true })
  assert.equal(speech.status, 'fitted')
  assert.equal(speech.correction.action, 'refused')
  assert.equal(speech.correction.reason, 'unsafe-speech-stretch')
  // `decision` and `correction.action` are deliberately different questions.
  // The mapping is still trustworthy — aligning two tracks by an offset is
  // safe — while time-stretching speech by three thousand ppm is not. Refusing
  // the whole mapping because the stretch is unsafe would throw away a correct
  // alignment; refusing only the stretch keeps both facts true.
  assert.equal(speech.correction.action, 'refused')
  assert.equal(speech.decision, 'auto-apply')

  // Omitting the flag must behave like speech. Assuming a track is
  // instrument-only and stretching it is the failure the default guards.
  const defaulted = fit({ anchors: anchorsFor({ ppm: violent }) })
  assert.equal(defaulted.correction.carriesSpeech, true)
  assert.equal(defaulted.correction.action, 'refused')

  // Declared non-speech, the same rate may be applied.
  const instrumental = fit({ anchors: anchorsFor({ ppm: violent }), carriesSpeech: false })
  assert.equal(instrumental.correction.carriesSpeech, false)
  assert.notEqual(instrumental.correction.reason, 'unsafe-speech-stretch')
})

test('T-FR-144 a large residual proposes a split instead of averaging through it', () => {
  // A step in the middle of the span is not drift: it is two regimes. Fitting
  // one line through it produces a rate that is wrong on both sides.
  const stepped = anchorsFor({ ppm: 120, jitter: (index) => (index >= 3 ? 180_000 : 0) })
  const result = fit({ anchors: stepped })
  assert.equal(result.status, 'fitted')
  assert.equal(result.decision, 'new-piece')
  // A single line through two regimes reports a rate that is wrong on both
  // sides: the true drift is 120 ppm and the fit lands at 801.
  assert.equal(result.driftPpm, 801)
  assert.equal(result.outlierAnchorIds.length, 4)
  assert.ok(result.residualBoundTicks > t(0))
  assert.ok(result.splitProposal !== null, 'a step must propose a split, not be averaged through')
  assert.ok(result.splitProposal.jumpTicks > t(0))
  assert.notEqual(result.splitProposal.afterAnchorId, result.splitProposal.beforeAnchorId)
})

test('T-FR-144 hold-out validation checks the fit against anchors it never saw', () => {
  const many = anchorsFor({ ppm: 120, seconds: [0, 400, 800, 1_200, 1_600, 2_000, 2_400, 2_800, 3_200, 3_500] })
  const result = fit({ anchors: many })
  assert.equal(result.status, 'fitted')
  assert.equal(result.holdOut.status, 'validated')
  assert.ok(result.holdOut.heldOutAnchorIds.length > 0)
  // The held-out anchors are not in the training set — otherwise the check
  // would only be asking the fit whether it agrees with itself.
  for (const id of result.holdOut.heldOutAnchorIds) {
    assert.equal(result.holdOut.trainingAnchorIds.includes(id), false)
  }
  assert.equal(result.holdOut.driftPpm, 120)

  // Below the threshold, holding anchors back would break the distribution
  // gate, so the module says it did not perform the check rather than pretending.
  const few = fit({ anchors: anchorsFor({ ppm: 120 }) })
  assert.equal(few.holdOut.status, 'not-performed')
  assert.equal(few.holdOut.reason, 'too-few-anchors')
})

test('T-FR-144 a fitted result carries the residual bound into the mapping it produces', () => {
  const result = fit()
  const mapping = createMappingFromDriftFit({
    fit: result,
    clock: CLOCK,
    source: SOURCE,
    sourceCoverage: SPAN,
    evidenceRefs: ['probe-anchor-0'],
  })
  assert.equal(mapping.driftPpm, 120)
  assert.ok(mapping.precision.boundTicks >= result.residualBoundTicks)
  // The anchors that produced the fit travel with the mapping, so the claim
  // stays auditable after the fit object is gone.
  assert.deepEqual([...mapping.anchorIds], [...result.usedAnchorIds])
})
