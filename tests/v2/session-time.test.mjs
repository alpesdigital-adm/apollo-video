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
    state = (BigInt(1103515245) * state + BigInt(12345)) & 0x7fffffffn
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
  assert.ok(rationalEquals(rational(BigInt(1), -BigInt(2)), rational(-BigInt(1), BigInt(2))))
  assert.ok(rationalEquals(rational(BigInt(2), BigInt(4)), rational(BigInt(1), BigInt(2))))
  assert.ok(rationalEquals(rational(-BigInt(6), -BigInt(8)), rational(BigInt(3), BigInt(4))))
  assert.equal(rational(BigInt(0), BigInt(5)).num, BigInt(0))

  assert.throws(() => rational(BigInt(1), BigInt(0)), /zero denominator/)

  // 30000/1001 is exactly representable here and not representable at all as a
  // float. That is the entire reason this type exists.
  const ntsc = rational(BigInt(30000), BigInt(1001))
  assert.equal(serializeRational(ntsc), '30000/1001')
  assert.ok(rationalEquals(deserializeRational('30000/1001'), ntsc))
  assert.ok(rationalEquals(multiplyRational(ntsc, divideRational(rational(BigInt(1)), ntsc)), rational(BigInt(1))))
})

test('T-FR-144 ppm converts to an exact rate and back', () => {
  // +120 ppm is exactly 1000120/1000000 — the drift the heterogeneous session
  // E2E injects on purpose.
  const rate = ppmToRate(120)
  assert.ok(rationalEquals(rate, rational(BigInt(1000120), BigInt(1000000))))
  assert.equal(rationalToPpm(rate), 120)

  assert.equal(rationalToPpm(ppmToRate(-45)), -45)
  assert.equal(rationalToPpm(ppmToRate(0)), 0)
  assert.equal(compareRational(ppmToRate(120), ppmToRate(119)), 1)
  assert.ok(rationalEquals(addRational(rational(BigInt(1), BigInt(3)), rational(BigInt(1), BigInt(6))), rational(BigInt(1), BigInt(2))))
})

// ---------------------------------------------------------------------------
// Half-open intervals
// ---------------------------------------------------------------------------

test('T-FR-143 intervals are half-open and zero-length is refused', () => {
  const interval = createTickInterval(BigInt(0), BigInt(100))
  assert.equal(intervalContains(interval, BigInt(0)), true)
  assert.equal(intervalContains(interval, BigInt(99)), true)
  // The boundary tick belongs to the *next* interval. This is what lets
  // coverage tile a timeline without a fudge factor.
  assert.equal(intervalContains(interval, BigInt(100)), false)

  assert.throws(() => createTickInterval(BigInt(50), BigInt(50)), /non-empty and forward/)
  assert.throws(() => createTickInterval(BigInt(100), BigInt(50)), /non-empty and forward/)

  // Adjacent, therefore not overlapping.
  assert.equal(intervalsOverlap(createTickInterval(BigInt(0), BigInt(100)), createTickInterval(BigInt(100), BigInt(200))), false)
  assert.equal(intervalsOverlap(createTickInterval(BigInt(0), BigInt(101)), createTickInterval(BigInt(100), BigInt(200))), true)
  assert.equal(intervalIntersection(createTickInterval(BigInt(0), BigInt(100)), createTickInterval(BigInt(100), BigInt(200))), null)
  assert.deepEqual(
    intervalIntersection(createTickInterval(BigInt(0), BigInt(150)), createTickInterval(BigInt(100), BigInt(200))),
    { start: BigInt(100), end: BigInt(150) },
  )
  assert.ok(intervalContainsInterval(createTickInterval(BigInt(0), BigInt(200)), createTickInterval(BigInt(50), BigInt(200))))
  assert.equal(intervalContainsInterval(createTickInterval(BigInt(0), BigInt(200)), createTickInterval(BigInt(50), BigInt(201))), false)
})

test('T-FR-143 canonicalization merges adjacency, reports overlap, and finds gaps', () => {
  // Overlap is a fact about the recording — two parts claiming the same ticks.
  // Merging it silently would erase the thing coverage exists to surface.
  const { merged, overlaps } = canonicalizeIntervals([
    createTickInterval(BigInt(300), BigInt(400)),
    createTickInterval(BigInt(0), BigInt(100)),
    createTickInterval(BigInt(100), BigInt(200)),
    createTickInterval(BigInt(150), BigInt(250)),
  ])
  assert.deepEqual(merged.map((i) => [i.start, i.end]), [[BigInt(0), BigInt(250)], [BigInt(300), BigInt(400)]])
  assert.deepEqual(overlaps.map((i) => [i.start, i.end]), [[BigInt(150), BigInt(200)]])

  assert.deepEqual(
    intervalGaps(merged, createTickInterval(BigInt(0), BigInt(500))).map((i) => [i.start, i.end]),
    [[BigInt(250), BigInt(300)], [BigInt(400), BigInt(500)]],
  )
  // A source that starts late leaves a gap at the head, not a shifted start.
  assert.deepEqual(
    intervalGaps([createTickInterval(BigInt(120), BigInt(400))], createTickInterval(BigInt(0), BigInt(400))).map((i) => [i.start, i.end]),
    [[BigInt(0), BigInt(120)]],
  )
  assert.deepEqual(canonicalizeIntervals([]).merged, [])
})

test(`T-FR-143 canonicalization is order-independent (seed ${SEEDS.canonical})`, () => {
  const next = lcg(SEEDS.canonical)
  for (let trial = 0; trial < 200; trial += 1) {
    const intervals = Array.from({ length: 6 }, () => {
      const start = next() % BigInt(1000)
      return createTickInterval(start, start + BigInt(1) + (next() % BigInt(200)))
    })
    const forward = canonicalizeIntervals(intervals)
    const reversed = canonicalizeIntervals([...intervals].reverse())
    const shuffled = canonicalizeIntervals([...intervals].sort(() => (next() % BigInt(2) === BigInt(0) ? -1 : 1)))
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
  const map = createAffineClockMap({ rate: rational(BigInt(1)), offsetTicks: BigInt(4500) })
  for (const tick of [BigInt(0), BigInt(1), BigInt(90000), BigInt(648000000)]) {
    assert.equal(applyAffineClockMap(map, tick), tick + BigInt(4500))
    assert.equal(affineRoundTripError(map, tick), BigInt(0))
  }
})

test(`T-FR-141 round-trip error stays bounded under drift (seed ${SEEDS.roundTrip})`, () => {
  const next = lcg(SEEDS.roundTrip)
  // A rate that compresses time cannot be exactly invertible: distinct source
  // ticks collapse onto one session tick. What must hold is that the error is
  // bounded by rounding, not that it is zero — claiming zero would be a lie the
  // first time someone used 120 ppm.
  for (const ppm of [-500, -120, -1, 0, 1, 120, 500]) {
    const map = createAffineClockMap({ rate: ppmToRate(ppm), offsetTicks: BigInt(next() % BigInt(10000)) })
    for (let trial = 0; trial < 100; trial += 1) {
      const tick = BigInt(next() % BigInt(648000000))
      const error = affineRoundTripError(map, tick)
      const magnitude = error < BigInt(0) ? -error : error
      assert.ok(magnitude <= BigInt(1), `seed ${SEEDS.roundTrip} ppm ${ppm} tick ${tick} error ${error}`)
    }
  }
})

test('T-FR-141 mapping is monotonic inside a piece', () => {
  const map = createAffineClockMap({ rate: ppmToRate(120), offsetTicks: -BigInt(1000) })
  let previous = applyAffineClockMap(map, BigInt(0))
  for (let tick = BigInt(1); tick < BigInt(5000); tick += BigInt(7)) {
    const mapped = applyAffineClockMap(map, tick)
    assert.ok(mapped >= previous, `monotonicity broke at ${tick}`)
    previous = mapped
  }
})

test('T-FR-141 a non-positive rate is refused rather than producing a map with no inverse', () => {
  assert.throws(() => createAffineClockMap({ rate: rational(BigInt(0), BigInt(1)), offsetTicks: BigInt(0) }), /strictly positive/)
  assert.throws(() => createAffineClockMap({ rate: rational(-BigInt(1), BigInt(1)), offsetTicks: BigInt(0) }), /strictly positive/)
})

test('T-FR-141 overflow is refused at construction, not at persistence', () => {
  // A value that only fails when it is written fails in the worst place: after
  // the work that produced it is already gone.
  assert.throws(() => assertInt64(BigInt(2) ** BigInt(63), 'probe'), /overflows the 64-bit range/)
  assert.equal(assertInt64(BigInt(2) ** BigInt(63) - BigInt(1), 'probe'), BigInt(2) ** BigInt(63) - BigInt(1))
  assert.throws(() => createTickInterval(BigInt(0), BigInt(2) ** BigInt(70)), /overflows/)
  const huge = createAffineClockMap({ rate: rational(BigInt(1000000), BigInt(1)), offsetTicks: BigInt(0) })
  assert.throws(() => applyAffineClockMap(huge, BigInt(2) ** BigInt(60)), /overflows/)
})

// ---------------------------------------------------------------------------
// Timebase conversion
// ---------------------------------------------------------------------------

test('T-FR-141 timebase conversion rounds once, at the end', () => {
  const mpegts = timebaseFromRate(90_000)
  const audio48k = timebaseFromRate(48_000)
  // One second is one second in either base.
  assert.equal(convertTick({ tick: BigInt(90000), from: mpegts, to: audio48k }), BigInt(48000))
  assert.equal(convertTick({ tick: BigInt(48000), from: audio48k, to: mpegts }), BigInt(90000))

  // 44.1 kHz into 48 kHz is not an integer ratio, which is exactly the
  // scratch-audio case the sync E2E has to survive.
  const audio441k = timebaseFromRate(44_100)
  assert.equal(convertTick({ tick: BigInt(44100), from: audio441k, to: audio48k }), BigInt(48000))
  assert.equal(convertTick({ tick: BigInt(1), from: audio441k, to: audio48k }), BigInt(1))

  assert.equal(convertTick({ tick: BigInt(1), from: timebaseFromRate(3), to: timebaseFromRate(2) }), BigInt(1))
  assert.equal(convertTick({ tick: BigInt(1), from: timebaseFromRate(3), to: timebaseFromRate(2), rounding: 'ceil' }), BigInt(1))
  assert.equal(convertTick({ tick: BigInt(1), from: timebaseFromRate(3), to: timebaseFromRate(2), rounding: 'floor' }), BigInt(0))

  // Half-even, so a long chain does not drift in one direction.
  const half = { from: timebaseFromRate(2), to: timebaseFromRate(1) }
  assert.equal(convertTick({ tick: BigInt(1), ...half }), BigInt(0))
  assert.equal(convertTick({ tick: BigInt(3), ...half }), BigInt(2))
  assert.equal(convertTick({ tick: BigInt(5), ...half }), BigInt(2))
  assert.equal(convertTick({ tick: BigInt(7), ...half }), BigInt(4))

  assert.throws(() => createTimebase(rational(-BigInt(1), BigInt(90000))), /advance forward in time/)
})

test('T-FR-141 negative ticks convert symmetrically', () => {
  // Session time can start before a source: a camera that began late has
  // negative session ticks in its own frame of reference.
  const from = timebaseFromRate(90_000)
  const to = timebaseFromRate(48_000)
  assert.equal(convertTick({ tick: -BigInt(90000), from, to }), -BigInt(48000))
  assert.equal(convertTick({ tick: -BigInt(1), from: timebaseFromRate(3), to: timebaseFromRate(2), rounding: 'floor' }), -BigInt(1))
  assert.equal(convertTick({ tick: -BigInt(1), from: timebaseFromRate(3), to: timebaseFromRate(2), rounding: 'ceil' }), BigInt(0))

  const map = createAffineClockMap({ rate: ppmToRate(-120), offsetTicks: -BigInt(5000) })
  assert.ok(applyAffineClockMap(map, BigInt(0)) < applyAffineClockMap(map, BigInt(1000)))
  assert.ok(invertAffineClockMap(map, applyAffineClockMap(map, BigInt(1000))) >= BigInt(999))
})

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

test('T-FR-141 ticks serialize as decimal text because JSON has no bigint', () => {
  const interval = createTickInterval(-BigInt(9223372036854775000), BigInt(9223372036854775000))
  const wire = serializeTickInterval(interval)
  assert.equal(typeof wire.start, 'string')
  assert.deepEqual(deserializeTickInterval(wire), interval)
  assert.throws(() => deserializeTickInterval({ start: '1.5', end: '2' }), /decimal integer string/)
  assert.throws(() => deserializeTickInterval({ start: '0', end: '0' }), /non-empty and forward/)
  assert.throws(() => deserializeRational('30000'), /"num\/den"/)
})
