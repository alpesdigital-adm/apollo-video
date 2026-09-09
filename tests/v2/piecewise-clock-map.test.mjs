import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PIECE_BOUNDARY_CAUSES,
  assertPiecewiseClockMapIntegrity,
  createPiecewiseClockMap,
  describedSourceTicks,
  driftByPiece,
  isSessionRangeResolvable,
  resolvableSessionRanges,
  resolveSessionTick,
  resolveSourceTick,
} from '../../src/v2/domain/piecewise-clock-map.ts'
import {
  createSessionClock,
  createSourceClock,
  createSourceToSessionMapping,
} from '../../src/v2/domain/session-clock.ts'
import {
  createTickInterval,
  ppmToRate,
  rational,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'

const t = (n) => BigInt(n)
const HZ = t(90_000)
const sec = (n) => HZ * t(n)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()

const CLOCK = createSessionClock({
  sessionId: 'capture-session-1',
  timebase: timebaseFromRate(90_000),
  frameRate: rational(BigInt(30_000), BigInt(1_001)),
  authority: {
    origin: 'primary-camera',
    sourceId: 'asset-cam-main',
    provenance: 'original-capture',
    evidenceRef: 'probe-cam-main',
  },
  establishedAt: at(0),
})

const SOURCE = createSourceClock({
  sourceId: 'asset-phone',
  timebase: timebaseFromRate(90_000),
  provenance: 'original-capture',
})

function mapping({ from, to, offsetTicks = 0, ppm = 0, residual = 0, confidence = 'high', anchors, evidence }) {
  const claimsAlignment = offsetTicks !== 0 || ppm !== 0
  return createSourceToSessionMapping({
    clock: CLOCK,
    source: SOURCE,
    sourceCoverage: createTickInterval(from, to),
    driftRate: ppm === 0 ? rational(BigInt(1)) : ppmToRate(ppm),
    offsetTicks: t(offsetTicks),
    residualBoundTicks: t(residual),
    confidence,
    anchorIds: anchors ?? (claimsAlignment ? ['anchor-1'] : []),
    evidenceRefs: evidence ?? (claimsAlignment ? ['probe-phone-1'] : []),
  })
}

/** Two pieces separated by a ten-second recorder restart. */
function restartedMap(overrides = {}) {
  return createPiecewiseClockMap({
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-1',
    sourceId: 'asset-phone',
    clock: CLOCK,
    derivedFrom: { sessionVersion: 4, referenceEpoch: 1 },
    pieces: [
      { pieceId: 'piece-a', mapping: mapping({ from: sec(0), to: sec(600), offsetTicks: 4_500, ppm: 120, residual: 30 }) },
      {
        pieceId: 'piece-b',
        mapping: mapping({ from: sec(610), to: sec(1_200), offsetTicks: 900_000, ppm: 120, residual: 30 }),
        openedBy: 'recorder-restart',
        openedByDetail: 'card full at 10:09:58; recorder wrote a new file after ten seconds',
      },
    ],
    ...overrides,
  })
}

test('T-FR-145 a piece resolves inside its coverage and the map refuses the gap between pieces', () => {
  const map = restartedMap()
  assert.equal(map.pieces.length, 2)
  assert.deepEqual(map.pieces.map((piece) => piece.ordinal), [0, 1])

  const inside = resolveSourceTick(map, sec(300))
  assert.equal(inside.status, 'resolved')
  assert.equal(inside.pieceId, 'piece-a')

  // The ten seconds between stop and restart are not a short piece with an
  // interpolated rate: the recorder produced no time there at all.
  const inGap = resolveSourceTick(map, sec(605))
  assert.equal(inGap.status, 'uncovered')
  assert.equal(inGap.reason, 'in-discontinuity')
  assert.equal(inGap.tick, undefined, 'a refusal must not smuggle a number alongside it')

  assert.equal(resolveSourceTick(map, t(-1)).reason, 'before-first-piece')
  assert.equal(resolveSourceTick(map, sec(1_200)).reason, 'after-last-piece')
  // Half-open: the last tick inside is covered, the end tick is not.
  assert.equal(resolveSourceTick(map, sec(1_200) - t(1)).status, 'resolved')
})

test('T-FR-145 the gap is reported as uncovered source range, never folded into the hull', () => {
  const map = restartedMap()
  assert.equal(map.sourceBounds.start, sec(0))
  assert.equal(map.sourceBounds.end, sec(1_200))
  assert.equal(map.uncovered.length, 1)
  assert.equal(map.uncovered[0].start, sec(600))
  assert.equal(map.uncovered[0].end, sec(610))

  // The hull spans 1200 s; only 1190 s of it is described by any law. Reporting
  // the hull as coverage would claim ten seconds of material that never existed.
  assert.equal(describedSourceTicks(map), sec(1_190))
  assert.notEqual(describedSourceTicks(map), map.sourceBounds.end - map.sourceBounds.start)
})

test('T-FR-145 two pieces claiming the same source tick are refused, not ordered', () => {
  // Conversion would depend on which law was consulted, and both answers would
  // be defensible. There is no correct way to pick one.
  assert.throws(
    () => restartedMap({
      pieces: [
        { pieceId: 'piece-a', mapping: mapping({ from: sec(0), to: sec(600) }) },
        {
          pieceId: 'piece-b',
          mapping: mapping({ from: sec(599), to: sec(1_200), offsetTicks: 900_000 }),
          openedBy: 'seek',
          openedByDetail: 'operator scrubbed backwards during the take',
        },
      ],
    }),
    /a tick cannot obey two laws/,
  )
})

test('T-FR-145 a piece that follows another must name a recognized cause and explain it', () => {
  const second = mapping({ from: sec(610), to: sec(1_200), offsetTicks: 900_000 })
  const build = (openedBy, openedByDetail) => restartedMap({
    pieces: [
      { pieceId: 'piece-a', mapping: mapping({ from: sec(0), to: sec(600) }) },
      { pieceId: 'piece-b', mapping: second, openedBy, openedByDetail },
    ],
  })

  assert.throws(() => build(undefined, 'a detail'), /must say what opened it/)
  assert.throws(() => build('vibes', 'the clocks felt different'), /not a recognized piece boundary cause/)
  // A boundary an operator cannot act on is a boundary nobody can audit.
  assert.throws(() => build('recorder-restart', 'restart'), /explain its boundary in words an operator can act on/)
  assert.throws(() => build('recorder-restart', '          '), /explain its boundary in words/)

  // And the first piece opens the map: there is nothing before it to be a
  // boundary with.
  assert.throws(
    () => restartedMap({
      pieces: [{
        pieceId: 'piece-a',
        mapping: mapping({ from: sec(0), to: sec(600) }),
        openedBy: 'seek',
        openedByDetail: 'nothing precedes this piece, so nothing opened it',
      }],
    }),
    /first piece opens the map/,
  )
})

test('T-FR-145 a discontinuous cause must actually show a gap in the source ticks', () => {
  // The recorded cause and the measured evidence are not allowed to disagree:
  // "the recorder restarted" while the PTS runs unbroken is one of them lying.
  assert.throws(
    () => restartedMap({
      pieces: [
        { pieceId: 'piece-a', mapping: mapping({ from: sec(0), to: sec(600) }) },
        {
          pieceId: 'piece-b',
          mapping: mapping({ from: sec(600), to: sec(1_200), offsetTicks: 900_000 }),
          openedBy: 'recorder-restart',
          openedByDetail: 'claims a restart while the source ticks run unbroken',
        },
      ],
    }),
    /claims recorder-restart but its source ticks continue without a gap/,
  )

  // A continuous cause across abutting pieces is exactly right, though: a seek
  // in the *session* leaves the source timeline whole.
  const abutting = restartedMap({
    pieces: [
      { pieceId: 'piece-a', mapping: mapping({ from: sec(0), to: sec(600) }) },
      {
        pieceId: 'piece-b',
        mapping: mapping({ from: sec(600), to: sec(1_200), offsetTicks: 900_000 }),
        openedBy: 'pts-regression',
        openedByDetail: 'PTS jumped backwards by ten seconds at the file boundary',
      },
    ],
  })
  assert.equal(abutting.boundaries[0].sourceGap, null)
  assert.equal(abutting.uncovered.length, 0)
})

test('T-FR-145 the boundary reports the measured size of the discontinuity', () => {
  const map = restartedMap()
  assert.equal(map.boundaries.length, 1)
  const [boundary] = map.boundaries
  assert.equal(boundary.beforePieceId, 'piece-a')
  assert.equal(boundary.afterPieceId, 'piece-b')
  assert.equal(boundary.cause, 'recorder-restart')
  assert.equal(boundary.sourceGap.start, sec(600))
  assert.equal(boundary.sourceGap.end, sec(610))

  // Piece A would have placed the restart instant at offset 4500; piece B puts
  // it at 900000. The jump is the difference — 895500 ticks, just under ten
  // seconds — and it is a fact about the recording, not an error to smooth away.
  assert.equal(boundary.sessionJumpTicks, t(895_500))
})

test('T-FR-145 inverse mapping exists only inside a piece', () => {
  const map = restartedMap()
  for (const sourceTick of [sec(0), sec(1), sec(300), sec(600) - t(1), sec(610), sec(900)]) {
    const forward = resolveSourceTick(map, sourceTick)
    assert.equal(forward.status, 'resolved')
    const back = resolveSessionTick(map, forward.tick)
    assert.equal(back.status, 'resolved')
    assert.equal(back.pieceId, forward.pieceId)
    // Integer arithmetic rounds once each way, so a round trip can move by at
    // most one tick — and the map says so rather than claiming exactness.
    const delta = back.tick - sourceTick
    assert.ok(delta >= t(-1) && delta <= t(1), `round trip moved ${delta} ticks at ${sourceTick}`)
  }

  // A session instant that falls between the two pieces' session coverage has
  // no source tick, and no piece is willing to invent one.
  const between = map.pieces[0].sessionCoverage.end + t(10)
  const refused = resolveSessionTick(map, between)
  assert.equal(refused.status, 'uncovered')
  assert.equal(refused.reason, 'in-discontinuity')
})

test('T-FR-145 a session range that spans a boundary is not selectable', () => {
  const map = restartedMap()
  const [first, second] = resolvableSessionRanges(map)
  assert.equal(resolvableSessionRanges(map).length, 2)

  assert.equal(isSessionRangeResolvable(map, createTickInterval(first.start, first.end)), true)
  assert.equal(isSessionRangeResolvable(map, createTickInterval(first.start + sec(1), first.start + sec(2))), true)
  // Both endpoints are covered and the range is still refused: the material
  // between them does not exist, and a selection crossing it would be a cut
  // nobody chose.
  assert.equal(isSessionRangeResolvable(map, createTickInterval(first.end - sec(1), second.start + sec(1))), false)
  assert.equal(isSessionRangeResolvable(map, createTickInterval(second.end - sec(1), second.end + sec(1))), false)
})

test('T-FR-145 drift is reported per piece, never averaged into one figure', () => {
  const map = restartedMap({
    pieces: [
      { pieceId: 'piece-a', mapping: mapping({ from: sec(0), to: sec(600), ppm: 120, offsetTicks: 4_500 }) },
      {
        pieceId: 'piece-b',
        // A different oscillator regime after the restart. Averaging 120 and
        // -40 into 40 would describe neither half of the recording.
        mapping: mapping({ from: sec(610), to: sec(1_200), ppm: -40, offsetTicks: 900_000 }),
        openedBy: 'recorder-restart',
        openedByDetail: 'card full at 10:09:58; recorder wrote a new file after ten seconds',
      },
    ],
  })
  assert.deepEqual(driftByPiece(map).map((entry) => entry.driftPpm), [120, -40])
})

test('T-FR-145 a map is deterministic, and a tampered stored map is refused on read', () => {
  const first = restartedMap()
  const second = restartedMap()
  assert.equal(first.mapHash, second.mapHash, 'the same pieces must hash identically')

  // Order of input must not change the result: pieces are sorted by coverage.
  const reversed = restartedMap({
    pieces: [
      {
        pieceId: 'piece-b',
        mapping: mapping({ from: sec(610), to: sec(1_200), offsetTicks: 900_000, ppm: 120, residual: 30 }),
        openedBy: 'recorder-restart',
        openedByDetail: 'card full at 10:09:58; recorder wrote a new file after ten seconds',
      },
      { pieceId: 'piece-a', mapping: mapping({ from: sec(0), to: sec(600), offsetTicks: 4_500, ppm: 120, residual: 30 }) },
    ],
  })
  assert.equal(reversed.mapHash, first.mapHash)

  assert.equal(assertPiecewiseClockMapIntegrity(first), first)
  assert.throws(() => assertPiecewiseClockMapIntegrity({ ...first, sourceId: 'asset-other' }), /hash/)
  assert.throws(
    () => assertPiecewiseClockMapIntegrity({ ...first, derivedFrom: { sessionVersion: 9, referenceEpoch: 1 } }),
    /hash/,
  )
})

test('T-FR-145 a map must be assembled under its own session and from one source', () => {
  assert.throws(
    () => restartedMap({ sessionId: 'capture-session-2' }),
    /assembled under the clock of its own session/,
  )

  const otherSource = createSourceToSessionMapping({
    clock: CLOCK,
    source: createSourceClock({ sourceId: 'asset-cam-alt', timebase: timebaseFromRate(90_000), provenance: 'original-capture' }),
    sourceCoverage: createTickInterval(sec(610), sec(1_200)),
    driftRate: rational(BigInt(1)),
    offsetTicks: t(0),
    residualBoundTicks: t(0),
    confidence: 'high',
    anchorIds: [],
    evidenceRefs: [],
  })
  assert.throws(
    () => restartedMap({
      pieces: [
        { pieceId: 'piece-a', mapping: mapping({ from: sec(0), to: sec(600) }) },
        { pieceId: 'piece-b', mapping: otherSource, openedBy: 'recorder-restart', openedByDetail: 'a piece measured on a different camera entirely' },
      ],
    }),
    /maps asset-cam-alt, not asset-phone/,
  )
})

/**
 * Deterministic LCG. Seeds are printed so a failure is reproducible from the
 * test output alone rather than requiring the run to be caught live.
 */
function lcg(seed) {
  let state = BigInt(seed) % BigInt(2_147_483_647)
  if (state <= BigInt(0)) state += BigInt(2_147_483_646)
  return () => {
    state = (state * BigInt(16_807)) % BigInt(2_147_483_647)
    return Number(state) / 2_147_483_647
  }
}

test('T-FR-145 property: random piece sequences never overlap, never interpolate a gap', () => {
  const SEED = 20260907
  console.log(`piecewise sequence property seed=${SEED}`)
  const random = lcg(SEED)
  let roundsWithGap = 0
  let roundsFullyAbutting = 0

  for (let round = 0; round < 200; round += 1) {
    const pieceCount = 2 + Math.floor(random() * 4)
    const pieces = []
    const gaps = []
    let cursor = t(Math.floor(random() * 90_000))

    for (let index = 0; index < pieceCount; index += 1) {
      const span = sec(30 + Math.floor(random() * 300))
      const start = cursor
      const end = start + span
      // Deliberately bimodal. A uniform draw over a wide range is almost never
      // zero, so the abutting case — pieces that meet exactly, with a
      // continuous cause — would go untested while the suite still looked
      // random. Roughly a third of boundaries are made to abut exactly.
      const gapAfter = random() < 0.34 ? t(0) : t(1 + Math.floor(random() * 900_000))
      const openedBy = index === 0
        ? undefined
        : gaps[index - 1] > t(0)
          ? 'recorder-restart'
          : 'pts-regression'
      pieces.push({
        pieceId: `piece-${index}`,
        mapping: mapping({
          from: start,
          to: end,
          offsetTicks: Math.floor(random() * 1_000_000),
          ppm: Math.floor(random() * 200) - 100,
          residual: Math.floor(random() * 50),
        }),
        ...(openedBy ? { openedBy, openedByDetail: `round ${round} piece ${index} opened by ${openedBy}` } : {}),
      })
      gaps.push(gapAfter)
      cursor = end + gapAfter
    }

    const map = createPiecewiseClockMap({
      workspaceId: 'workspace-1',
      sessionId: 'capture-session-1',
      sourceId: 'asset-phone',
      clock: CLOCK,
      derivedFrom: { sessionVersion: 1, referenceEpoch: 1 },
      pieces,
    })

    // No two pieces ever share a source tick, and every piece is strictly after
    // the one before it.
    for (let index = 1; index < map.pieces.length; index += 1) {
      assert.ok(
        map.pieces[index].sourceCoverage.start >= map.pieces[index - 1].sourceCoverage.end,
        `round ${round}: pieces overlap (seed=${SEED})`,
      )
    }

    // Every tick in a real gap is refused; every tick in a piece resolves inside
    // that piece and nowhere else.
    for (let index = 0; index < map.pieces.length - 1; index += 1) {
      const gapStart = map.pieces[index].sourceCoverage.end
      const gapEnd = map.pieces[index + 1].sourceCoverage.start
      if (gapEnd > gapStart) {
        const probe = gapStart + (gapEnd - gapStart) / t(2)
        const resolution = resolveSourceTick(map, probe)
        assert.equal(resolution.status, 'uncovered', `round ${round}: interpolated a gap (seed=${SEED})`)
        assert.equal(resolution.reason, 'in-discontinuity')
      }
    }

    for (const piece of map.pieces) {
      const mid = piece.sourceCoverage.start + (piece.sourceCoverage.end - piece.sourceCoverage.start) / t(2)
      const resolution = resolveSourceTick(map, mid)
      assert.equal(resolution.status, 'resolved')
      assert.equal(resolution.pieceId, piece.pieceId, `round ${round}: resolved to the wrong piece (seed=${SEED})`)
    }

    // Described ticks never exceed the hull, and equal it only when no gap exists.
    const hull = map.sourceBounds.end - map.sourceBounds.start
    const described = describedSourceTicks(map)
    assert.ok(described <= hull, `round ${round}: described more than the hull (seed=${SEED})`)
    const hasGap = map.uncovered.length > 0
    assert.equal(described === hull, !hasGap, `round ${round}: coverage and gaps disagree (seed=${SEED})`)
    if (hasGap) roundsWithGap += 1
    else roundsFullyAbutting += 1
  }

  // Prove the generator reached both regimes. Without this, a change that made
  // every boundary a gap would leave the suite green and the abutting path —
  // pieces that meet exactly — silently untested.
  console.log(`rounds with a gap=${roundsWithGap}, fully abutting=${roundsFullyAbutting}`)
  assert.ok(roundsWithGap > 20, `too few gapped rounds to be meaningful (seed=${SEED})`)
  assert.ok(roundsFullyAbutting > 5, `the abutting case went untested (seed=${SEED})`)
})

test('T-FR-145 property: any overlap at all is refused, however small', () => {
  const SEED = 8675311
  console.log(`piecewise overlap property seed=${SEED}`)
  const random = lcg(SEED)

  for (let round = 0; round < 200; round += 1) {
    const start = t(Math.floor(random() * 900_000))
    const end = start + sec(60 + Math.floor(random() * 120))
    // One tick of overlap is as fatal as an hour: the ambiguity is the problem,
    // not its size.
    const overlap = t(1 + Math.floor(random() * 90_000))
    const secondStart = end - overlap

    assert.throws(
      () => createPiecewiseClockMap({
        workspaceId: 'workspace-1',
        sessionId: 'capture-session-1',
        sourceId: 'asset-phone',
        clock: CLOCK,
        derivedFrom: { sessionVersion: 1, referenceEpoch: 1 },
        pieces: [
          { pieceId: 'piece-0', mapping: mapping({ from: start, to: end }) },
          {
            pieceId: 'piece-1',
            mapping: mapping({ from: secondStart, to: secondStart + sec(60), offsetTicks: 1_000 }),
            openedBy: 'seek',
            openedByDetail: `round ${round} overlapping by ${overlap} ticks`,
          },
        ],
      }),
      /a tick cannot obey two laws/,
      `round ${round}: an overlap of ${overlap} ticks was accepted (seed=${SEED})`,
    )
  }
})

test('T-FR-145 every declared boundary cause is constructible', () => {
  // A cause nobody can build is a cause that will never be tested; this keeps
  // the enum and the constructor from drifting apart.
  for (const cause of PIECE_BOUNDARY_CAUSES) {
    const gap = { 'recorder-restart': sec(10), 'coverage-gap': sec(10), 'file-split': sec(10) }[cause] ?? t(0)
    const map = restartedMap({
      pieces: [
        { pieceId: 'piece-a', mapping: mapping({ from: sec(0), to: sec(600) }) },
        {
          pieceId: 'piece-b',
          mapping: mapping({ from: sec(600) + gap, to: sec(1_200), offsetTicks: 900_000 }),
          openedBy: cause,
          openedByDetail: `constructed to exercise the ${cause} boundary cause`,
        },
      ],
    })
    assert.equal(map.boundaries[0].cause, cause)
    assert.equal(map.boundaries[0].sourceGap === null, gap === t(0))
  }
})
