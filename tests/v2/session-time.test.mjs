import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addRational,
  affineRoundTripError,
  applyAffineClockMap,
  assertInt64,
  canonicalizeIntervals,
  compareIntervals,
  compareRational,
  convertTick,
  createAffineClockMap,
  createTickInterval,
  createTimebase,
  deserializeRational,
  deserializeTickInterval,
  divideRational,
  intervalContains,
  intervalContainsInterval,
  intervalGaps,
  intervalIntersection,
  intervalsOverlap,
  invertAffineClockMap,
  multiplyRational,
  ppmToRate,
  rational,
  rationalEquals,
  rationalToPpm,
  serializeRational,
  serializeTickInterval,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'

/**
 * Deterministic pseudo-random source. The seed is printed by every property
 * test that uses it so a failure can be replayed exactly — an unseeded
 * generator turns a real defect into "it failed once on CI".
 */
function lcg(seed) {
  let state = BigInt(seed) & 0xffffffffn
  return () => {
    state = (1103515245n * state + 12345n) & 0x7fffffffn
    return state
  }
}

const SEEDS = Object.freeze({ roundTrip: 20260903, canonical: 424242, drift: 8675309 })

// ---------------------------------------------------------------------------
// Rational arithmetic
// ---------------------------------------------------------------------------

test('T-FR-141 rationals normalize so equal numbers are the same value', () => {
  // 1/-2 and -1/2 are the same number. If they were two different objects, every
  // comparison downstream would need to know that, and one of them would forget.
  assert.ok(rationalEquals(rational(1n, -2n), rational(-1n, 2n)))
  assert.ok(rationalEquals(rational(2n, 4n), rational(1n, 2n)))
  assert.ok(rationalEquals(rational(-6n, -8n), rational(3n, 4n)))
  assert.equal(rational(0n, 5n).num, 0n)

  assert.throws(() => rational(1n, 0n), /zero denominator/)

  // 30000/1001 is exactly representable here and not representable at all as a
  // float. That is the entire reason this type exists.
  const ntsc = rational(30000n, 1001n)
  assert.equal(serializeRational(ntsc), '30000/1001')
  assert.ok(rationalEquals(deserializeRational('30000/1001'), ntsc))
  assert.ok(rationalEquals(multiplyRational(ntsc, divideRational(rational(1n), ntsc)), rational(1n)))
})

test('T-FR-144 ppm converts to an exact rate and back', () => {
  // +120 ppm is exactly 1000120/1000000 — the drift the heterogeneous session
  // E2E injects on purpose.
  const rate = ppmToRate(120)
  assert.ok(rationalEquals(rate, rational(1_000_120n, 1_000_000n)))
  assert.equal(rationalToPpm(rate), 120)

  assert.equal(rationalToPpm(ppmToRate(-45)), -45)
  assert.equal(rationalToPpm(ppmToRate(0)), 0)
  assert.equal(compareRational(ppmToRate(120), ppmToRate(119)), 1)
  assert.ok(rationalEquals(addRational(rational(1n, 3n), rational(1n, 6n)), rational(1n, 2n)))
})

// ---------------------------------------------------------------------------
// Half-open intervals
// ---------------------------------------------------------------------------

test('T-FR-143 intervals are half-open and zero-length is refused', () => {
  const interval = createTickInterval(0n, 100n)
  assert.equal(intervalContains(interval, 0n), true)
  assert.equal(intervalContains(interval, 99n), true)
  // The boundary tick belongs to the *next* interval. This is what lets
  // coverage tile a timeline without a fudge factor.
  assert.equal(intervalContains(interval, 100n), false)

  assert.throws(() => createTickInterval(50n, 50n), /non-empty and forward/)
  assert.throws(() => createTickInterval(100n, 50n), /non-empty and forward/)

  // Adjacent, therefore not overlapping.
  assert.equal(intervalsOverlap(createTickInterval(0n, 100n), createTickInterval(100n, 200n)), false)
  assert.equal(intervalsOverlap(createTickInterval(0n, 101n), createTickInterval(100n, 200n)), true)
  assert.equal(intervalIntersection(createTickInterval(0n, 100n), createTickInterval(100n, 200n)), null)
  assert.deepEqual(
    intervalIntersection(createTickInterval(0n, 150n), createTickInterval(100n, 200n)),
    { start: 100n, end: 150n },
  )
  assert.ok(intervalContainsInterval(createTickInterval(0n, 200n), createTickInterval(50n, 200n)))
  assert.equal(intervalContainsInterval(createTickInterval(0n, 200n), createTickInterval(50n, 201n)), false)
})

test('T-FR-143 canonicalization merges adjacency, reports overlap, and finds gaps', () => {
  // Overlap is a fact about the recording — two parts claiming the same ticks.
  // Merging it silently would erase the thing coverage exists to surface.
  const { merged, overlaps } = canonicalizeIntervals([
    createTickInterval(300n, 400n),
    createTickInterval(0n, 100n),
    createTickInterval(100n, 200n),
    createTickInterval(150n, 250n),
  ])
  assert.deepEqual(merged.map((i) => [i.start, i.end]), [[0n, 250n], [300n, 400n]])
  assert.deepEqual(overlaps.map((i) => [i.start, i.end]), [[150n, 200n]])

  assert.deepEqual(
    intervalGaps(merged, createTickInterval(0n, 500n)).map((i) => [i.start, i.end]),
    [[250n, 300n], [400n, 500n]],
  )
  // A source that starts late leaves a gap at the head, not a shifted start.
  assert.deepEqual(
    intervalGaps([createTickInterval(120n, 400n)], createTickInterval(0n, 400n)).map((i) => [i.start, i.end]),
    [[0n, 120n]],
  )
  assert.deepEqual(canonicalizeIntervals([]).merged, [])
})

test(`T-FR-143 canonicalization is order-independent (seed ${SEEDS.canonical})`, () => {
  const next = lcg(SEEDS.canonical)
  for (let trial = 0; trial < 200; trial += 1) {
    const intervals = Array.from({ length: 6 }, () => {
      const start = next() % 1_000n
      return createTickInterval(start, start + 1n + (next() % 200n))
    })
    const forward = canonicalizeIntervals(intervals)
    const reversed = canonicalizeIntervals([...intervals].reverse())
    const shuffled = canonicalizeIntervals([...intervals].sort(() => (next() % 2n === 0n ? -1 : 1)))
    assert.deepEqual(forward.merged, reversed.merged, `seed ${SEEDS.canonical} trial ${trial}`)
    assert.deepEqual(forward.merged, shuffled.merged, `seed ${SEEDS.canonical} trial ${trial}`)
    // Merged output is itself canonical: sorted, disjoint, non-adjacent.
    for (let i = 1; i < forward.merged.length; i += 1) {
      assert.ok(compareIntervals(forward.merged[i - 1], forward.merged[i]) < 0)
      assert.ok(forward.merged[i].start > forward.merged[i - 1].end)
    }
  }
})

// ---------------------------------------------------------------------------
// Clock maps
// ---------------------------------------------------------------------------

test('T-FR-141 an identity map round-trips exactly at every tick', () => {
  const map = createAffineClockMap({ rate: rational(1n), offsetTicks: 4_500n })
  for (const tick of [0n, 1n, 90_000n, 648_000_000n]) {
    assert.equal(applyAffineClockMap(map, tick), tick + 4_500n)
    assert.equal(affineRoundTripError(map, tick), 0n)
  }
})

test(`T-FR-141 round-trip error stays bounded under drift (seed ${SEEDS.roundTrip})`, () => {
  const next = lcg(SEEDS.roundTrip)
  // A rate that compresses time cannot be exactly invertible: distinct source
  // ticks collapse onto one session tick. What must hold is that the error is
  // bounded by rounding, not that it is zero — claiming zero would be a lie the
  // first time someone used 120 ppm.
  for (const ppm of [-500, -120, -1, 0, 1, 120, 500]) {
    const map = createAffineClockMap({ rate: ppmToRate(ppm), offsetTicks: BigInt(next() % 10_000n) })
    for (let trial = 0; trial < 100; trial += 1) {
      const tick = BigInt(next() % 648_000_000n)
      const error = affineRoundTripError(map, tick)
      const magnitude = error < 0n ? -error : error
      assert.ok(magnitude <= 1n, `seed ${SEEDS.roundTrip} ppm ${ppm} tick ${tick} error ${error}`)
    }
  }
})

test('T-FR-141 mapping is monotonic inside a piece', () => {
  const map = createAffineClockMap({ rate: ppmToRate(120), offsetTicks: -1_000n })
  let previous = applyAffineClockMap(map, 0n)
  for (let tick = 1n; tick < 5_000n; tick += 7n) {
    const mapped = applyAffineClockMap(map, tick)
    assert.ok(mapped >= previous, `monotonicity broke at ${tick}`)
    previous = mapped
  }
})

test('T-FR-141 a non-positive rate is refused rather than producing a map with no inverse', () => {
  assert.throws(() => createAffineClockMap({ rate: rational(0n, 1n), offsetTicks: 0n }), /strictly positive/)
  assert.throws(() => createAffineClockMap({ rate: rational(-1n, 1n), offsetTicks: 0n }), /strictly positive/)
})

test('T-FR-141 overflow is refused at construction, not at persistence', () => {
  // A value that only fails when it is written fails in the worst place: after
  // the work that produced it is already gone.
  assert.throws(() => assertInt64(2n ** 63n, 'probe'), /overflows the 64-bit range/)
  assert.equal(assertInt64(2n ** 63n - 1n, 'probe'), 2n ** 63n - 1n)
  assert.throws(() => createTickInterval(0n, 2n ** 70n), /overflows/)
  const huge = createAffineClockMap({ rate: rational(1_000_000n, 1n), offsetTicks: 0n })
  assert.throws(() => applyAffineClockMap(huge, 2n ** 60n), /overflows/)
})

// ---------------------------------------------------------------------------
// Timebase conversion
// ---------------------------------------------------------------------------

test('T-FR-141 timebase conversion rounds once, at the end', () => {
  const mpegts = timebaseFromRate(90_000)
  const audio48k = timebaseFromRate(48_000)
  // One second is one second in either base.
  assert.equal(convertTick({ tick: 90_000n, from: mpegts, to: audio48k }), 48_000n)
  assert.equal(convertTick({ tick: 48_000n, from: audio48k, to: mpegts }), 90_000n)

  // 44.1 kHz into 48 kHz is not an integer ratio, which is exactly the
  // scratch-audio case the sync E2E has to survive.
  const audio441k = timebaseFromRate(44_100)
  assert.equal(convertTick({ tick: 44_100n, from: audio441k, to: audio48k }), 48_000n)
  assert.equal(convertTick({ tick: 1n, from: audio441k, to: audio48k }), 1n)

  assert.equal(convertTick({ tick: 1n, from: timebaseFromRate(3), to: timebaseFromRate(2) }), 1n)
  assert.equal(convertTick({ tick: 1n, from: timebaseFromRate(3), to: timebaseFromRate(2), rounding: 'ceil' }), 1n)
  assert.equal(convertTick({ tick: 1n, from: timebaseFromRate(3), to: timebaseFromRate(2), rounding: 'floor' }), 0n)

  // Half-even, so a long chain does not drift in one direction.
  const half = { from: timebaseFromRate(2), to: timebaseFromRate(1) }
  assert.equal(convertTick({ tick: 1n, ...half }), 0n)
  assert.equal(convertTick({ tick: 3n, ...half }), 2n)
  assert.equal(convertTick({ tick: 5n, ...half }), 2n)
  assert.equal(convertTick({ tick: 7n, ...half }), 4n)

  assert.throws(() => createTimebase(rational(-1n, 90_000n)), /advance forward in time/)
})

test('T-FR-141 negative ticks convert symmetrically', () => {
  // Session time can start before a source: a camera that began late has
  // negative session ticks in its own frame of reference.
  const from = timebaseFromRate(90_000)
  const to = timebaseFromRate(48_000)
  assert.equal(convertTick({ tick: -90_000n, from, to }), -48_000n)
  assert.equal(convertTick({ tick: -1n, from: timebaseFromRate(3), to: timebaseFromRate(2), rounding: 'floor' }), -1n)
  assert.equal(convertTick({ tick: -1n, from: timebaseFromRate(3), to: timebaseFromRate(2), rounding: 'ceil' }), 0n)

  const map = createAffineClockMap({ rate: ppmToRate(-120), offsetTicks: -5_000n })
  assert.ok(applyAffineClockMap(map, 0n) < applyAffineClockMap(map, 1_000n))
  assert.ok(invertAffineClockMap(map, applyAffineClockMap(map, 1_000n)) >= 999n)
})

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

test('T-FR-141 ticks serialize as decimal text because JSON has no bigint', () => {
  const interval = createTickInterval(-9_223_372_036_854_775_000n, 9_223_372_036_854_775_000n)
  const wire = serializeTickInterval(interval)
  assert.equal(typeof wire.start, 'string')
  assert.deepEqual(deserializeTickInterval(wire), interval)
  assert.throws(() => deserializeTickInterval({ start: '1.5', end: '2' }), /decimal integer string/)
  assert.throws(() => deserializeTickInterval({ start: '0', end: '0' }), /non-empty and forward/)
  assert.throws(() => deserializeRational('30000'), /"num\/den"/)
})
