import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AssBoundaryUnrepresentableError, assCentisecondTimestamp, createAssBoundaryBinder, createFpsStageAssBoundaryBinder,
  derivePinnedLibassNowMs, frameRateTimeBase, isAssBoundaryUnrepresentable, legalAssCentisecondPreimage,
} from '../../src/v2/domain/libass-clock-model.ts'

// Everything below is arithmetic over the pinned FFmpeg/libass behaviour. The independent oracle
// is written without importing the code under test: libass shows an event iff start <= now < end
// (milliseconds, half-open), `now` is trunc(pts * q2d * 1000) in binary64, ASS stores centiseconds.
const oracleNow = (pts, num, den) => Math.trunc(pts * (num / den) * 1000)
const visibleFrames = (nowList, startCs, endCs) =>
  nowList.flatMap((now, frame) => (startCs * 10 <= now && now < endCs * 10 ? [frame] : []))

test('cause: the frame arrives one millisecond low on the physical v5 vectors, and v1 boundaries land one frame late', () => {
  // [pts, time_base, expected libass now]. 100000@1/1e6 is frame 6 of 60 fps after concat; 6@1/60 is the same frame in lavfi.
  const vectors = [[6, 60, 100], [100000, 1000000, 99], [111, 30, 3699], [3700000, 1000000, 3699], [803, 100, 8029], [8030000, 1000000, 8029]]
  for (const [pts, den, expected] of vectors) {
    assert.equal(oracleNow(pts, 1, den), expected, `${pts}@1/${den}`)
    assert.equal(derivePinnedLibassNowMs(String(pts), { numerator: '1', denominator: String(den) }), BigInt(expected))
  }
  // The exact-rational boundary of v1: the centisecond of the exact frame time. With now = 99 (3699, 8029) the
  // event starting at 100 (3700, 8030) is not yet visible at the target frame: the frame is lit one frame late.
  for (const [pts, den, expected, exactCs] of [[100000, 1000000, 99, 10], [111, 30, 3699, 370], [803, 100, 8029, 803]]) {
    assert.ok(expected < exactCs * 10 && oracleNow(pts, 1, den) < exactCs * 10)
  }
  // The inclusive start is not the problem: with now = 100 the event at exactly 100 is shown.
  assert.deepEqual(visibleFrames([83, 100, 116], 10, 11), [1])
  assert.deepEqual(visibleFrames([83, 99, 116], 10, 11), [])
})

test('cause: how often the exact-rational boundary of v1 is late, by frame rate and time base (model count over 20000 frames)', () => {
  const late = (fps, scaleMicroseconds) => {
    let exact = 0, count = 0
    for (let frame = 0; frame < 20000; frame += 1) {
      if ((frame * 100) % fps !== 0) continue
      exact += 1
      const now = scaleMicroseconds ? oracleNow(Math.round(frame * 1e6 / fps), 1, 1e6) : oracleNow(frame, 1, fps)
      if (now < Math.floor(frame * 100 / fps) * 10) count += 1
    }
    return [exact, count]
  }
  assert.deepEqual(late(30, false), [6667, 450]); assert.deepEqual(late(30, true), [6667, 1920])
  assert.deepEqual(late(25, true), [20000, 5937]); assert.deepEqual(late(100, false), [20000, 97])
  assert.deepEqual(late(24, true), [3334, 0])
})

const FPS = [24, 25, 30, 48, 50, 60, 100, 120, 240]
const FRAMES = 120
const CLOCKS = [
  ['fps-stage', (fps) => ({ num: 1, den: fps, pts: (frame) => frame })],
  ['concat-1e6', (fps) => ({ num: 1, den: 1000000, pts: (frame) => Math.round(frame * 1e6 / fps) })],
  ['mpegts-90k', (fps) => ({ num: 1, den: 90000, pts: (frame) => Math.round(frame * 90000 / fps) })],
]

function modelFor(fps, makeClock) {
  const { num, den, pts } = makeClock(fps)
  const timeBase = { numerator: String(num), denominator: String(den) }
  const now = Array.from({ length: FRAMES }, (_unused, frame) => oracleNow(pts(frame), num, den))
  // Independent representability oracle: for every possible start/end centisecond, the first lit frame
  // and the exclusive end frame. A requested interval [a, b) is representable iff some start has first == a
  // and some end has endOf == b.
  const limit = Math.floor(now[FRAMES - 1] / 10) + 3
  const firstOf = Array.from({ length: limit + 1 }, (_unused, cs) => {
    const frame = now.findIndex((value) => value >= cs * 10)
    return frame < 0 ? FRAMES : frame
  })
  const endOf = Array.from({ length: limit + 1 }, (_unused, cs) => now.filter((value) => value < cs * 10).length)
  const binder = createAssBoundaryBinder({ frameCount: FRAMES,
    nowMsAt: (frame) => derivePinnedLibassNowMs(String(pts(frame)), timeBase),
    beforeFirstNowMs: BigInt(-1), endExclusiveNowMs: BigInt(now[FRAMES - 1]) + BigInt(10) })
  return { now, firstOf, endOf, binder, timeBase }
}

test('binder is sound and complete against an independent libass visibility oracle for every interval', () => {
  let representable = 0, refused = 0
  const refusedByFps = new Map()
  for (const fps of FPS) for (const [label, makeClock] of CLOCKS) {
    const { now, firstOf, endOf, binder } = modelFor(fps, makeClock)
    // Frame times strictly increase in milliseconds for these clocks at the sizes tested.
    for (let frame = 1; frame < FRAMES; frame += 1) assert.ok(now[frame] >= now[frame - 1], `${fps} ${label} monotonic`)
    for (let start = 0; start < FRAMES; start += 1) for (let end = start + 1; end <= FRAMES; end += 1) {
      const startExists = firstOf.some((first) => first === start), endExists = endOf.some((last) => last === end)
      const key = `${fps} fps ${label} [${start},${end})`
      let result
      try { result = binder.interval(start, end) } catch (error) {
        assert.ok(isAssBoundaryUnrepresentable(error) && error instanceof AssBoundaryUnrepresentableError, key)
        assert.equal(error.code, 'INVALID_RENDER_INPUT'); assert.equal(error.details.reason, 'ASS_BOUNDARY_UNREPRESENTABLE')
        assert.ok(Number.isSafeInteger(error.details.frame) && [start, end].includes(error.details.frame), key)
        // Completeness: refusal only when no centisecond pair can draw exactly [start, end).
        assert.ok(!(startExists && endExists), `${key} refused although representable`)
        refused += 1; refusedByFps.set(fps, (refusedByFps.get(fps) ?? 0) + 1)
        continue
      }
      // Soundness: the emitted pair draws exactly the requested frames, no neighbour and nothing else.
      const startCs = Number(result.startCs), endCs = Number(result.endCs)
      assert.deepEqual(visibleFrames(now, startCs, endCs), Array.from({ length: end - start }, (_unused, offset) => start + offset), key)
      assert.ok(startExists && endExists, `${key} emitted although the oracle finds it unrepresentable`)
      representable += 1
    }
  }
  assert.ok(representable > 100000 && refused > 1000, `representable=${representable} refused=${refused}`)
  // Rates up to 60 fps have a window of at least 16 ms per frame: every interval is representable in the fps-stage clock.
  for (const fps of [24, 25, 30, 48, 50, 60]) assert.equal(refusedByFps.get(fps) ?? 0, 0, `${fps} fps never refuses`)
  assert.ok(refusedByFps.get(120) > 0 && refusedByFps.get(240) > refusedByFps.get(120))
})

test('adjacent intervals partition the frames: shared boundary, no gap and no overlap', () => {
  // Up to 60 fps every frame window spans at least 10 ms, so every boundary is representable (see the soundness test).
  for (const fps of [24, 25, 30, 48, 50, 60]) for (const [label, makeClock] of CLOCKS) {
    const { now, binder } = modelFor(fps, makeClock)
    for (const [a, b, c] of [[0, 1, 2], [1, 2, 3], [3, 6, 7], [10, 40, 41], [FRAMES - 3, FRAMES - 1, FRAMES]]) {
      const first = binder.interval(a, b), next = binder.interval(b, c)
      assert.equal(first.endCs, next.startCs, `${fps} ${label} ${a}/${b}/${c}`)
      const lit = [...visibleFrames(now, Number(first.startCs), Number(first.endCs)), ...visibleFrames(now, Number(next.startCs), Number(next.endCs))]
      assert.deepEqual(lit, Array.from({ length: c - a }, (_unused, offset) => a + offset))
    }
  }
})

test('rates above 60 fps are not banned: they fail closed per interval with a typed refusal and are proven unrepresentable', () => {
  const at120 = createFpsStageAssBoundaryBinder({ fps: 120, frameCount: 12 })
  assert.deepEqual([...Array(5).keys()].map((frame) => at120.nowMs(frame)), [0n, 8n, 16n, 25n, 33n])
  assert.throws(() => at120.interval(1, 2), (error) => isAssBoundaryUnrepresentable(error) &&
    error.refusal === 'no-centisecond-in-frame-window' && error.details.frame === 1 &&
    error.details.previousMs === '0' && error.details.currentMs === '8' && /not representable/.test(error.message))
  assert.deepEqual(at120.interval(2, 3), { startCs: 1n, endCs: 2n })
  assert.deepEqual(at120.interval(0, 12), { startCs: 0n, endCs: 10n }) // last frame at 91 ms, end bound 101 ms
  // 240 fps constructs, binds the representable windows and refuses the others; no frame-rate ceiling exists in the model.
  const at240 = createFpsStageAssBoundaryBinder({ fps: 240, frameCount: 48 })
  let ok = 0, refused = 0
  for (let start = 0; start < 48; start += 1) for (let end = start + 1; end <= 48; end += 1) {
    try { at240.interval(start, end); ok += 1 } catch (error) { assert.ok(isAssBoundaryUnrepresentable(error)); refused += 1 }
  }
  assert.ok(ok > 0 && refused > ok, `240 fps ok=${ok} refused=${refused}`)
  assert.deepEqual(at240.interval(0, 48), { startCs: 0n, endCs: 20n })
  assert.doesNotThrow(() => createFpsStageAssBoundaryBinder({ fps: 1000, frameCount: 3 }))
})

test('collapsed milliseconds are a typed refusal too, and malformed input stays an ordinary domain error', () => {
  assert.throws(() => legalAssCentisecondPreimage(100n, 100n), (error) => isAssBoundaryUnrepresentable(error) &&
    error.refusal === 'collapsed-milliseconds' && /ordered/.test(error.message))
  assert.throws(() => legalAssCentisecondPreimage(5n, 3n), (error) => isAssBoundaryUnrepresentable(error))
  assert.throws(() => legalAssCentisecondPreimage(1, 2n), (error) => !isAssBoundaryUnrepresentable(error) && error.code === 'INVALID_RENDER_INPUT')
  assert.deepEqual(legalAssCentisecondPreimage(83n, 99n), { minimum: 9n, maximum: 9n })
  assert.deepEqual(legalAssCentisecondPreimage(-1n, 0n), { minimum: 0n, maximum: 0n })
  assert.equal(assCentisecondTimestamp(360123n), '1:00:01.23')
})

test('fps-stage clock: explicit domain bounds, rational rates and invalid rates', () => {
  const binder = createFpsStageAssBoundaryBinder({ fps: 30, frameCount: 6 })
  assert.equal(binder.boundary(0), 0n)
  assert.deepEqual(binder.interval(1, 2), { startCs: 3n, endCs: 6n })
  assert.equal(binder.boundary(6), 17n + 0n) // first centisecond after the last frame (166 ms + 10 ms)
  assert.deepEqual(binder.timestamps(1, 2), { start: '0:00:00.03', end: '0:00:00.06' })
  assert.throws(() => binder.boundary(7), /outside the fragment clock/)
  assert.throws(() => binder.interval(2, 2), /Invalid ASS local frame interval/)
  assert.throws(() => binder.nowMs(6), /outside the fragment/)
  // The time base is the inverse of the reduced rate, as `fps=` publishes it.
  assert.deepEqual(frameRateTimeBase(60), { numerator: '1', denominator: '60' })
  assert.deepEqual(frameRateTimeBase({ numerator: 30000, denominator: 1001 }), { numerator: '1001', denominator: '30000' })
  assert.deepEqual(frameRateTimeBase({ numerator: 60000, denominator: 2002 }), { numerator: '1001', denominator: '30000' })
  const ntsc = createFpsStageAssBoundaryBinder({ fps: { numerator: 30000, denominator: 1001 }, frameCount: 12 })
  assert.deepEqual(ntsc.interval(1, 2), { startCs: 3n, endCs: 6n })
  for (const bad of [0, -1, 29.97, Number.NaN, Infinity, null, undefined, { numerator: 30, denominator: 0 },
    { numerator: 1002001, denominator: 1 }, { numerator: 30000.5, denominator: 1001 }, '30'])
    assert.throws(() => frameRateTimeBase(bad), (error) => error.code === 'INVALID_RENDER_INPUT', String(bad))
  assert.throws(() => createFpsStageAssBoundaryBinder({ fps: 30, frameCount: 0 }), (error) => error.code === 'INVALID_RENDER_INPUT')
})

test('a fragment rebased to a local clock is bound again: a global interval representable at 120 fps can be refused locally', () => {
  const global = createFpsStageAssBoundaryBinder({ fps: 120, frameCount: 60 })
  // Global [5,6) is representable (centiseconds 4..5, window of frame 5 is (33, 41] ms).
  const globalInterval = global.interval(5, 6)
  assert.deepEqual(globalInterval, { startCs: 4n, endCs: 5n })
  // A fragment that starts at global frame 4 restarts its clock at 0: the same cue is local [1, 2), whose window
  // (0, 8] ms contains no centisecond. It is refused locally although it was representable globally.
  const local = createFpsStageAssBoundaryBinder({ fps: 120, frameCount: 56 })
  assert.throws(() => local.interval(1, 2), (error) => isAssBoundaryUnrepresentable(error) && error.details.frame === 1)
  // And the global centiseconds are wrong on the local clock: they would light local frame 5, not local frame 1.
  const localNow = Array.from({ length: 56 }, (_unused, frame) => Number(local.nowMs(frame)))
  assert.deepEqual(visibleFrames(localNow, Number(globalInterval.startCs), Number(globalInterval.endCs)), [5])
})
