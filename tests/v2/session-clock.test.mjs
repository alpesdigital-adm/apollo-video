import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertSessionClockIntegrity,
  classifyClockPrecision,
  composeClockRate,
  createSessionClock,
  createSourceClock,
  createSourceToSessionMapping,
  extractDriftRate,
  mapSessionTickToSource,
  mapSourceTickToSession,
  sessionTicksPerFrame,
  timebaseRatio,
} from '../../src/v2/domain/session-clock.ts'
import {
  createTickInterval,
  ppmToRate,
  rational,
  rationalEquals,
  rationalToPpm,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'

const SESSION_TB = timebaseFromRate(90_000)
const NTSC = rational(BigInt(30_000), BigInt(1_001))
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const t = (n) => BigInt(n)

function clock(overrides = {}) {
  return createSessionClock({
    sessionId: 'capture-session-1',
    timebase: SESSION_TB,
    frameRate: NTSC,
    authority: {
      origin: 'primary-camera',
      sourceId: 'asset-cam-main',
      provenance: 'original-capture',
      evidenceRef: 'probe-cam-main',
    },
    establishedAt: at(0),
    ...overrides,
  })
}

function source(overrides = {}) {
  return createSourceClock({
    sourceId: 'asset-cam-main',
    timebase: timebaseFromRate(90_000),
    provenance: 'original-capture',
    ...overrides,
  })
}

function mapping(overrides = {}) {
  return createSourceToSessionMapping({
    clock: clock(),
    source: source(),
    sourceCoverage: createTickInterval(t(0), t(90_000) * t(600)),
    driftRate: rational(BigInt(1)),
    offsetTicks: t(0),
    residualBoundTicks: t(0),
    confidence: 'high',
    anchorIds: ['anchor-1'],
    evidenceRefs: ['probe-cam-main'],
    ...overrides,
  })
}

test('T-FR-141 a normalized rendition can never be the timing authority', () => {
  // A normalized file is an *output* of the pipeline. Making it the clock means
  // the timeline moves whenever a transcode setting changes, and nothing
  // downstream can tell that it moved.
  assert.throws(
    () => clock({
      authority: {
        origin: 'primary-camera',
        sourceId: 'asset-proxy',
        provenance: 'normalized-rendition',
        evidenceRef: 'probe-proxy',
      },
    }),
    /normalized rendition cannot be the session timing authority/,
  )
  // The same rule applies to a source clock: reading PTS off the transcode
  // would bake whatever the transcode did into the sync evidence.
  assert.throws(
    () => source({ provenance: 'normalized-rendition' }),
    /original capture, not from a normalized rendition/,
  )
  assert.throws(() => source({ provenance: 'synthetic' }), /original capture/)
})

test('T-FR-141 a synthetic clock is anchored to no source and must say so', () => {
  const synthetic = clock({
    authority: { origin: 'synthetic-union', sourceId: null, provenance: 'synthetic', evidenceRef: 'operator-decision-1' },
  })
  assert.equal(synthetic.authority.sourceId, null)
  assert.throws(
    () => clock({
      authority: { origin: 'synthetic-union', sourceId: 'asset-cam-main', provenance: 'synthetic', evidenceRef: 'x' },
    }),
    /anchored to no source/,
  )
})

test('T-FR-141 ticks per frame is exact where no float pipeline reproduces it', () => {
  // 90 kHz at 30000/1001 fps is exactly 3003 ticks per frame. A decimal frame
  // rate cannot express 29.97 and a decimal tick count cannot express 3003.0033.
  assert.ok(rationalEquals(sessionTicksPerFrame(clock()), rational(BigInt(3_003))))
  const pal = clock({ timebase: timebaseFromRate(90_000), frameRate: rational(BigInt(25)) })
  assert.ok(rationalEquals(sessionTicksPerFrame(pal), rational(BigInt(3_600))))
})

test('T-FR-141 a timebase coarser than the frame grid is refused', () => {
  // A clock that cannot name a frame boundary makes every "within one frame"
  // claim unverifiable, so it is rejected rather than allowed to under-report.
  assert.throws(
    () => clock({ timebase: timebaseFromRate(10), frameRate: rational(BigInt(25)) }),
    /./,
  )
})

test('T-FR-141 drift is what remains after the timebase ratio is divided out', () => {
  // The distinction this module exists for. A 90 kHz source on a 1 MHz session
  // clock has a full map rate near 11.1; reporting that as ppm would announce
  // ten million ppm of "drift" on a perfectly synchronized recorder.
  const sessionTb = timebaseFromRate(1_000_000)
  const sourceTb = timebaseFromRate(90_000)
  const ratio = timebaseRatio(sourceTb, sessionTb)
  assert.ok(rationalEquals(ratio, rational(BigInt(1_000_000), BigInt(90_000))))

  const composed = composeClockRate({ source: sourceTb, session: sessionTb, driftRate: ppmToRate(120) })
  const recovered = extractDriftRate({ source: sourceTb, session: sessionTb, rate: composed })
  assert.equal(rationalToPpm(recovered), 120, 'drift survives composition and extraction exactly')

  // With no drift at all, the composed rate is pure ratio and ppm is zero.
  const clean = composeClockRate({ source: sourceTb, session: sessionTb, driftRate: rational(BigInt(1)) })
  assert.equal(rationalToPpm(extractDriftRate({ source: sourceTb, session: sessionTb, rate: clean })), 0)
})

test('T-FR-141 a mapping round-trips inside its coverage and refuses to speak outside it', () => {
  const map = mapping()
  for (const tick of [t(0), t(90_000), t(90_000) * t(300), t(90_000) * t(600) - t(1)]) {
    const session = mapSourceTickToSession(map, tick)
    assert.equal(mapSessionTickToSource(map, session), tick)
  }
  // Half-open: the end tick is not in the coverage.
  assert.throws(() => mapSourceTickToSession(map, t(90_000) * t(600)), /outside the coverage/)
  assert.throws(() => mapSourceTickToSession(map, t(-1)), /outside the coverage/)
  // Outside the mapped range the mapping says nothing, rather than extrapolating.
  assert.throws(() => mapSessionTickToSource(map, map.sessionCoverage.end), /outside the coverage/)
})

test('T-FR-141 mapping stays monotonic under drift', () => {
  const drifted = mapping({ driftRate: ppmToRate(120), offsetTicks: t(4_500) })
  assert.equal(drifted.driftPpm, 120)
  let previous = mapSourceTickToSession(drifted, t(0))
  for (let tick = t(90_000); tick < t(90_000) * t(600); tick += t(90_000) * t(37)) {
    const mapped = mapSourceTickToSession(drifted, tick)
    assert.ok(mapped > previous, `monotonicity broke at ${tick}`)
    previous = mapped
  }
  // The reported ppm is a truncated human figure; the rational rate is the
  // authority and must still be exact.
  assert.ok(rationalEquals(drifted.driftRate, ppmToRate(120)))
})

test('T-FR-141 negative drift is a first-class case', () => {
  const slow = mapping({ driftRate: ppmToRate(-45), offsetTicks: t(-1_200) })
  assert.equal(slow.driftPpm, -45)
  assert.ok(mapSourceTickToSession(slow, t(0)) < mapSourceTickToSession(slow, t(90_000)))
  const mid = t(90_000) * t(120)
  assert.equal(mapSessionTickToSource(slow, mapSourceTickToSession(slow, mid)), mid)
})

test('T-FR-141 precision is a bound against the frame grid, not an estimate', () => {
  // 3003 ticks is one NTSC frame at 90 kHz. "Sub-frame" means the bound fits in
  // *half* a frame — you can place the instant within a frame only if your error
  // is smaller than the distance to its neighbour. A full frame of error is
  // 'frame' accuracy, not sub-frame, and the first draft of this test assumed
  // the looser definition.
  assert.equal(classifyClockPrecision(clock(), t(1)), 'sub-frame')
  assert.equal(classifyClockPrecision(clock(), t(1_501)), 'sub-frame')
  assert.equal(classifyClockPrecision(clock(), t(1_502)), 'frame')
  assert.equal(classifyClockPrecision(clock(), t(3_003)), 'frame')
  // Above one frame and up to three, the error spans frames but is still
  // countable in them; past three the bound stops meaning anything frame-shaped.
  assert.equal(classifyClockPrecision(clock(), t(3_004)), 'multi-frame')
  assert.equal(classifyClockPrecision(clock(), t(9_009)), 'multi-frame')
  assert.equal(classifyClockPrecision(clock(), t(9_010)), 'coarse')

  // The reported bound is the measured residual PLUS the one tick integer
  // arithmetic inevitably costs. Reporting only the residual would understate
  // the uncertainty by exactly the amount the rounding introduced.
  const precise = mapping({ residualBoundTicks: t(10) })
  assert.equal(precise.precision.boundTicks, t(11))
  assert.equal(precise.precision.precisionClass, 'sub-frame')
  assert.throws(() => mapping({ residualBoundTicks: t(-1) }), /residual bound cannot be negative/)
})

test('T-FR-141 a mapping that claims alignment must name the evidence for it', () => {
  // ADR-130: return insufficient evidence rather than invent precision. Before
  // this invariant existed the aggregate accepted a high-confidence mapping
  // with a 45,000-tick offset and 120 ppm of drift backed by nothing at all.
  assert.throws(
    () => mapping({ offsetTicks: t(45_000), anchorIds: [] }),
    /must name the anchors it was measured from/,
  )
  assert.throws(
    () => mapping({ driftRate: ppmToRate(120), evidenceRefs: [] }),
    /must name evidence that can be re-opened/,
  )

  // The exception is the mapping that claims nothing: the reference track
  // against itself is true by definition and needs no anchor to justify it.
  const identity = mapping({ driftRate: rational(BigInt(1)), offsetTicks: t(0), anchorIds: [], evidenceRefs: [] })
  assert.equal(identity.driftPpm, 0)
  assert.deepEqual([...identity.anchorIds], [])

  assert.throws(() => mapping({ confidence: 'certain' }), /not a recognized level/)
})

test('T-FR-141 a tampered stored clock is refused on read', () => {
  const stored = clock()
  assert.equal(assertSessionClockIntegrity(stored), stored)
  assert.throws(() => assertSessionClockIntegrity({ ...stored, sessionId: 'other' }), /hash/)
  assert.throws(() => assertSessionClockIntegrity({ ...stored, frameRate: rational(BigInt(25)) }), /hash/)
})
