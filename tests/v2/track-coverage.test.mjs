import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTO_EDIT_MINIMUM_CONFIDENCE_BPS,
  assertCoverageDerivedFrom,
  assertCoverageSelectable,
  assertTrackCoverageIntegrity,
  calculateTrackCoverageHash,
  coveredDuration,
  createTrackCoverage,
  isAutoEditable,
} from '../../src/v2/domain/track-coverage.ts'
import { createTickInterval, timebaseFromRate } from '../../src/v2/domain/session-time.ts'

const TB = timebaseFromRate(1_000)
const at = (second) => new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const t = (n) => BigInt(n)

const derivedFrom = Object.freeze({ sessionId: 'capture-session-1', sessionVersion: 3, referenceEpoch: 1 })

function claim(overrides = {}) {
  return {
    partId: 'part-1',
    ordinal: 0,
    timebase: TB,
    interval: createTickInterval(t(0), t(1_000)),
    confidenceBps: 9_500,
    evidence: { kind: 'packet-scan', ref: 'probe-1' },
    ...overrides,
  }
}

function coverage(overrides = {}) {
  return createTrackCoverage({
    workspaceId: 'workspace-1',
    trackId: 'track-cam-main',
    derivedFrom,
    timebase: TB,
    claims: [claim()],
    ...overrides,
  })
}

test('T-FR-143 a single continuous part yields one available interval and no gaps', () => {
  const result = coverage()
  assert.equal(result.available.length, 1)
  assert.deepEqual(result.available[0].interval, { start: t(0), end: t(1_000) })
  assert.deepEqual([...result.gaps], [])
  assert.deepEqual(result.bounds, { start: t(0), end: t(1_000) })
  assert.equal(coveredDuration(result), t(1_000))
  assert.equal(assertTrackCoverageIntegrity(result), result)
})

test('T-FR-143 the bounds are the hull of what parts claimed, never a wished-for duration', () => {
  // A source that starts late genuinely starts late. Extending its bounds back
  // to zero would be inventing material that was never recorded.
  const result = coverage({
    claims: [claim({ interval: createTickInterval(t(2_000), t(5_000)) })],
  })
  assert.deepEqual(result.bounds, { start: t(2_000), end: t(5_000) })
  assert.deepEqual([...result.gaps], [], 'there is no gap before a source that simply began later')
  assert.equal(coveredDuration(result), t(3_000))
})

test('T-FR-143 an internal gap is derived, belongs to no file, and carries no claim', () => {
  const result = coverage({
    claims: [
      claim({ partId: 'part-1', ordinal: 0, interval: createTickInterval(t(0), t(1_000)) }),
      claim({ partId: 'part-2', ordinal: 1, interval: createTickInterval(t(1_500), t(2_500)) }),
    ],
  })
  assert.equal(result.available.length, 2)
  assert.equal(result.gaps.length, 1)
  assert.deepEqual(result.gaps[0].interval, { start: t(1_000), end: t(1_500) })
  assert.equal(result.gaps[0].availability, 'gap')
  // A derived gap belongs to no file and asserts nothing about the world.
  assert.equal(result.gaps[0].partId, null)
  assert.equal(result.gaps[0].evidence.kind, 'derived-gap')
  assert.equal(coveredDuration(result), t(2_000))

  const split = result.recorderSplits.find((entry) => entry.fromPartId === 'part-1')
  assert.equal(split.kind, 'gap')
  assert.equal(split.boundaryTick, t(1_000))
  assert.deepEqual(split.measured, { start: t(1_000), end: t(1_500) })
})

test('T-FR-143 adjacent parts touch exactly and are not a gap', () => {
  // Half-open bounds: [0,1000) and [1000,2000) tile the timeline. A closed
  // model would have to invent a rule for tick 1000.
  const result = coverage({
    claims: [
      claim({ partId: 'part-1', ordinal: 0, interval: createTickInterval(t(0), t(1_000)) }),
      claim({ partId: 'part-2', ordinal: 1, interval: createTickInterval(t(1_000), t(2_000)) }),
    ],
  })
  assert.deepEqual([...result.gaps], [])
  assert.equal(coveredDuration(result), t(2_000))
  const split = result.recorderSplits[0]
  assert.equal(split.kind, 'contiguous')
  assert.equal(split.measured, null, 'parts that touch exactly measure no gap and no overlap')
})

test('T-FR-143 an overlap nobody acknowledged cannot be built at all', () => {
  // Two parts claiming the same ticks is a fact about the recording. The module
  // refuses to construct a coverage that simply ignores it — stronger than
  // demoting it quietly, because a coverage that silently swallowed the dispute
  // would look identical to one where the parts never overlapped.
  assert.throws(
    () => coverage({
      claims: [
        claim({ partId: 'part-1', ordinal: 0, interval: createTickInterval(t(0), t(1_200)) }),
        claim({ partId: 'part-2', ordinal: 1, interval: createTickInterval(t(1_000), t(2_000)) }),
      ],
    }),
    /claim the same ticks and no resolution/,
  )
})

test('T-FR-143 manual-review acknowledges the dispute and demotes it to unverified', () => {
  // `manual-review` is how an operator says "I saw it and have not decided".
  // It is not a way of postponing the decision into the edit: the disputed
  // region becomes unverified, which auto-edit cannot touch.
  const result = coverage({
    claims: [
      claim({ partId: 'part-1', ordinal: 0, interval: createTickInterval(t(0), t(1_200)) }),
      claim({ partId: 'part-2', ordinal: 1, interval: createTickInterval(t(1_000), t(2_000)) }),
    ],
    overlapDecisions: [{
      leftPartId: 'part-1',
      rightPartId: 'part-2',
      interval: createTickInterval(t(1_000), t(1_200)),
      resolution: 'manual-review',
      keepPartId: null,
      decidedBy: 'operator-1',
      decidedAt: at(10),
      note: 'both cards look plausible here; needs a human with the timeline open',
    }],
  })

  const disputed = createTickInterval(t(1_000), t(1_200))
  assert.ok(
    result.unverified.some((entry) => entry.interval.start === disputed.start && entry.interval.end === disputed.end),
    'the disputed region must land in unverified',
  )
  assert.equal(isAutoEditable(result, disputed), false)
  assert.throws(() => assertCoverageSelectable(result, { interval: disputed, purpose: 'auto-edit' }), /./)
  // Nobody kept it, and the record says so rather than picking a winner.
  assert.equal(result.overlaps[0].keepPartId, null)
  assert.equal(result.recorderSplits[0].kind, 'overlap')
})

test('T-FR-143 a resolved overlap becomes available and names who decided', () => {
  const result = coverage({
    claims: [
      claim({ partId: 'part-1', ordinal: 0, interval: createTickInterval(t(0), t(1_200)) }),
      claim({ partId: 'part-2', ordinal: 1, interval: createTickInterval(t(1_000), t(2_000)) }),
    ],
    overlapDecisions: [{
      leftPartId: 'part-1',
      rightPartId: 'part-2',
      interval: createTickInterval(t(1_000), t(1_200)),
      resolution: 'prefer-part',
      keepPartId: 'part-1',
      decidedBy: 'operator-1',
      decidedAt: at(10),
      note: 'part-1 is the continuous card; part-2 restarted mid-take',
    }],
  })
  assert.equal(isAutoEditable(result, createTickInterval(t(1_000), t(1_200))), true)
  const decision = result.overlaps[0]
  assert.equal(decision.keepPartId, 'part-1')
  assert.equal(decision.decidedBy, 'operator-1')
  assert.match(decision.note, /continuous card/)
})

test('T-FR-143 a source outside coverage cannot be selected', () => {
  const result = coverage({ claims: [claim({ interval: createTickInterval(t(0), t(1_000)) })] })
  // Wholly outside.
  assert.throws(() => assertCoverageSelectable(result, { interval: createTickInterval(t(2_000), t(3_000)), purpose: 'auto-edit' }), /./)
  // Partially outside is still outside — a range that runs past the end of the
  // recording cannot be half-honoured.
  assert.throws(() => assertCoverageSelectable(result, { interval: createTickInterval(t(900), t(1_100)), purpose: 'auto-edit' }), /./)
  assert.equal(isAutoEditable(result, createTickInterval(t(900), t(1_100))), false)
  // Inside is fine.
  assert.equal(assertCoverageSelectable(result, { interval: createTickInterval(t(100), t(900)), purpose: 'auto-edit' }).length, 1)
})

test('T-FR-143 unverified is usable for analysis and never for auto-edit', () => {
  const result = coverage({
    claims: [claim({ interval: createTickInterval(t(0), t(2_000)) })],
    defects: [{
      availability: 'unverified',
      interval: createTickInterval(t(500), t(900)),
      evidence: { kind: 'operator-report', ref: 'note-1' },
    }],
  })
  const suspect = createTickInterval(t(500), t(900))
  assert.equal(isAutoEditable(result, suspect), false)
  // Analysis may look at it — that is how a human decides whether it is real.
  assert.equal(assertCoverageSelectable(result, { interval: suspect, purpose: 'analysis' }).length >= 1, true)
  assert.throws(() => assertCoverageSelectable(result, { interval: suspect, purpose: 'auto-edit' }), /./)
})

test('T-FR-143 a corrupt range is not available at any purpose', () => {
  const result = coverage({
    claims: [claim({ interval: createTickInterval(t(0), t(2_000)) })],
    defects: [{
      availability: 'corrupt',
      interval: createTickInterval(t(800), t(1_000)),
      evidence: { kind: 'decoder-walk', ref: 'probe-corrupt' },
    }],
  })
  const broken = createTickInterval(t(800), t(1_000))
  assert.equal(isAutoEditable(result, broken), false)
  assert.throws(() => assertCoverageSelectable(result, { interval: broken, purpose: 'analysis' }), /./)
  assert.equal(result.corrupt.length, 1)
})

test('T-FR-143 low confidence blocks auto-edit even inside available coverage', () => {
  const result = coverage({
    claims: [claim({ confidenceBps: AUTO_EDIT_MINIMUM_CONFIDENCE_BPS - 1 })],
  })
  assert.equal(isAutoEditable(result, createTickInterval(t(100), t(200))), false)
  // Analysis is still allowed: low confidence is a reason to look, not to hide.
  assert.equal(assertCoverageSelectable(result, { interval: createTickInterval(t(100), t(200)), purpose: 'analysis' }).length, 1)
})

test('T-FR-143 canonicalization is deterministic and order-independent', () => {
  const claims = [
    claim({ partId: 'part-3', ordinal: 2, interval: createTickInterval(t(4_000), t(5_000)) }),
    claim({ partId: 'part-1', ordinal: 0, interval: createTickInterval(t(0), t(1_000)) }),
    claim({ partId: 'part-2', ordinal: 1, interval: createTickInterval(t(1_500), t(2_500)) }),
  ]
  const forward = coverage({ claims })
  const reversed = coverage({ claims: [...claims].reverse() })
  // Same input, same bytes — so a persisted coverage can be re-derived and
  // compared instead of trusted.
  assert.equal(forward.coverageHash, reversed.coverageHash)
  assert.deepEqual(forward.available, reversed.available)
  assert.deepEqual(forward.gaps, reversed.gaps)
  assert.equal(forward.coverageHash, calculateTrackCoverageHash({ ...forward, coverageHash: undefined }))
})

test('T-FR-143 coverage derived from another session version is refused', () => {
  // Changing the reference track mints a new session version. This is what
  // makes a stale pairing impossible to express rather than merely discouraged.
  const result = coverage()
  assert.equal(assertCoverageDerivedFrom(result, derivedFrom), result)
  assert.throws(
    () => assertCoverageDerivedFrom(result, { ...derivedFrom, sessionVersion: 4 }),
    /stale|derivation|version/i,
  )
  assert.throws(
    () => assertCoverageDerivedFrom(result, { ...derivedFrom, referenceEpoch: 2 }),
    /stale|derivation|epoch/i,
  )
})

test('T-FR-143 a tampered stored coverage is refused on read', () => {
  const stored = coverage()
  assert.throws(() => assertTrackCoverageIntegrity({ ...stored, trackId: 'track-other' }), /hash/)
  assert.throws(
    () => assertTrackCoverageIntegrity({ ...stored, available: [...stored.available, stored.available[0]] }),
    /hash/,
  )
})
