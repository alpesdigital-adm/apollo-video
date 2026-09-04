import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertEditorialSynthesisIntegrity,
  createEditorialSynthesis,
  msToFrames,
  splicedJoins,
  synthesisCompressionBps,
} from '../../src/v2/domain/editorial-synthesis.ts'
import { rational } from '../../src/v2/domain/session-time.ts'
import { STORY_GOLDEN_FIXTURES } from '../../src/v2/domain/story-plan.ts'

const NTSC = rational(BigInt(30_000), BigInt(1_001))
const TWO_HOURS_MS = 7_200_000
const TWO_MINUTES_MS = 120_000
const h = (n) => 'a'.repeat(63) + String(n)

const LINEAGE = {
  sourceArtifactId: 'artifact-master',
  sourceArtifactSha256: h(1),
  sourceManifestId: 'manifest-master',
  sourceManifestHash: h(2),
  indexRunId: 'index-run-1',
  momentId: 'moment-1',
  momentHash: h(3),
  evaluationId: 'evaluation-1',
  evaluationHash: h(4),
}

/**
 * Six windows drawn from a two-hour master, together exactly two minutes.
 *
 * The claim, its qualifier and its proof context deliberately live in three
 * different windows: that is the arrangement a topical selector produces, and
 * the one where dropping a window quietly changes what was said.
 */
const GOLDEN_RANGES = [
  { rangeId: 'range-1', startMs: 120_000, endMs: 145_000, claimIds: [], qualifierIds: [], proofContextIds: [] },
  { rangeId: 'range-2', startMs: 900_000, endMs: 918_000, claimIds: [], qualifierIds: [], proofContextIds: [] },
  { rangeId: 'range-3', startMs: 1_800_000, endMs: 1_822_000, claimIds: ['claim-1'], qualifierIds: [], proofContextIds: [] },
  { rangeId: 'range-4', startMs: 3_600_000, endMs: 3_615_000, claimIds: [], qualifierIds: ['qualifier-1'], proofContextIds: [] },
  { rangeId: 'range-5', startMs: 5_400_000, endMs: 5_425_000, claimIds: [], qualifierIds: [], proofContextIds: ['proof-1'] },
  { rangeId: 'range-6', startMs: 7_000_000, endMs: 7_015_000, claimIds: [], qualifierIds: [], proofContextIds: [] },
]

function ranges(overrides = []) {
  const byId = new Map(overrides.map((entry) => [entry.rangeId, entry]))
  return GOLDEN_RANGES.map((range) => ({
    ...range,
    ...(byId.get(range.rangeId) ?? {}),
    lineage: LINEAGE,
    rightsSnapshotId: 'rights-master',
    rightsStatus: 'approved',
    consentStatus: 'approved',
  }))
}

function joinsFor(list, overrides = {}) {
  return list.slice(0, -1).map((range, index) => ({
    beforeRangeId: range.rangeId,
    afterRangeId: list[index + 1].rangeId,
    kind: 'spliced',
    justification: `window ${index + 1} closes the thought that window ${index + 2} opens`,
    continuityRisks: ['argument'],
    ...(overrides[index] ?? {}),
  }))
}

/**
 * The golden story plan, scaled to a two-minute cut.
 *
 * `validateStoryPlan` sums the blocks' ideal durations and requires the total to
 * sit inside the plan's target, so the block targets move with the target
 * rather than the target alone — four blocks of thirty seconds.
 */
const PLAN = {
  ...STORY_GOLDEN_FIXTURES.linear,
  id: 'story-plan-1',
  mode: 'multi-range',
  targetDurationMs: { min: 100_000, max: 140_000 },
  blocks: STORY_GOLDEN_FIXTURES.linear.blocks.map((block) => ({
    ...block,
    durationTargetMs: { min: 20_000, ideal: 30_000, max: 45_000 },
  })),
}

function synthesis(overrides = {}) {
  const list = overrides.ranges ?? ranges()
  return createEditorialSynthesis({
    id: 'synthesis-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    objective: 'two-minute cut of the founder interview',
    targetDurationMs: TWO_MINUTES_MS,
    toleranceMs: 2_000,
    sourceDurationMs: TWO_HOURS_MS,
    frameRate: NTSC,
    storyPlan: PLAN,
    editPlanId: 'edit-plan-1',
    ...overrides,
    ranges: list,
    joins: overrides.joins ?? joinsFor(list),
  })
}

test('T-FR-135 golden: two hours of master become a two-minute multi-range cut', () => {
  const result = synthesis()

  assert.equal(result.synthesizedDurationMs, TWO_MINUTES_MS)
  assert.equal(result.sourceDurationMs, TWO_HOURS_MS)
  assert.equal(result.droppedMs, TWO_HOURS_MS - TWO_MINUTES_MS)
  // 120 s of 7200 s survived: one part in sixty, 167 basis points once rounded.
  assert.equal(synthesisCompressionBps(result), 167)
  assert.equal(result.ranges.length, 6)
  assert.equal(result.joins.length, 5)
  assert.equal(result.chronologyPreserved, true)
  assert.equal(result.reorderReason, null)

  // The plan admits what it is. The contiguous path declares `false` here and
  // is entitled to; this one is not.
  assert.equal(result.editPlan.synthesizedRanges, true)
  assert.equal(result.editPlan.mode, 'multi-range')

  const [track] = result.editPlan.videoTracks
  assert.equal(track.clips.length, 6)

  // The output timeline is continuous even though the source is not: clip N+1
  // starts exactly where clip N ended, with no hole for the render to fill.
  let expected = 0
  for (const clip of track.clips) {
    assert.equal(clip.timelineInFrame, expected, `clip ${clip.clipId} does not abut its predecessor`)
    assert.ok(clip.timelineOutFrame > clip.timelineInFrame)
    expected = clip.timelineOutFrame
  }
  assert.equal(result.editPlan.durationFrames, expected)

  // Lineage survives the assembly: every clip can be traced to the moment,
  // evaluation, index run, manifest and rights snapshot it came from.
  assert.deepEqual([...result.editPlan.lineageRefs], [
    'evaluation:evaluation-1',
    'index-run:index-run-1',
    'manifest:manifest-master',
    'moment:moment-1',
    'rights:rights-master',
  ])
  assert.equal(result.editPlan.sources.length, 1)
  assert.equal(result.editPlan.sources[0].artifactSha256, h(1))
})

test('T-FR-135 a claim cannot be included without the words that qualify it', () => {
  // The failure multi-range invents and single-range cannot. The cut is clean,
  // the audio continuous, and the speaker is made to say something flatly
  // stronger than what they said.
  assert.throws(
    () => synthesis({ ranges: ranges([{ rangeId: 'range-4', qualifierIds: [] }]) }),
    /claim-1 is included without its qualifier qualifier-1/,
  )
  assert.throws(
    () => synthesis({ ranges: ranges([{ rangeId: 'range-5', proofContextIds: [] }]) }),
    /without its proof context proof-1/,
  )

  // Dropping the claim itself is fine — the qualifier alone asserts nothing.
  const withoutClaim = synthesis({ ranges: ranges([{ rangeId: 'range-3', claimIds: [] }]) })
  assert.deepEqual([...withoutClaim.contextProof.claimsIncluded], [])
  assert.equal(withoutClaim.contextProof.claimsRequiringQualifiers, 0)
})

test('T-FR-135 the context check is recorded whether or not it found anything', () => {
  // A proof that only exists on failure is not a proof: afterwards nobody can
  // tell whether the check ran or the branch was never reached.
  const result = synthesis()
  assert.deepEqual([...result.contextProof.claimsIncluded], ['claim-1'])
  assert.deepEqual([...result.contextProof.qualifiersIncluded], ['qualifier-1'])
  assert.deepEqual([...result.contextProof.proofContextsIncluded], ['proof-1'])
  assert.equal(result.contextProof.claimsRequiringQualifiers, 1)
  assert.equal(result.contextProof.claimsRequiringProof, 1)
})

test('T-FR-135 ranges that overlap in the source are refused', () => {
  // The same sentence twice is a stutter, and once compiled to frame numbers it
  // is nearly invisible in a plan.
  assert.throws(
    () => synthesis({ ranges: ranges([{ rangeId: 'range-2', startMs: 140_000, endMs: 158_000 }]) }),
    /overlap in the source; the same words cannot be spoken twice/,
  )
})

test('T-FR-135 departing from source order must be declared, never inferred', () => {
  const reordered = [ranges()[5], ...ranges().slice(0, 5)]
  assert.throws(
    () => synthesis({ ranges: reordered, joins: joinsFor(reordered) }),
    /reordering changes what the material asserts about cause and must be declared/,
  )
  assert.throws(
    () => synthesis({ ranges: reordered, joins: joinsFor(reordered), allowReorder: { reason: 'hook' } }),
    /reason an editor can defend/,
  )

  // Declared, it is allowed and recorded — pulling a hook from the end is
  // ordinary craft, and the record is what makes it reviewable.
  const declared = synthesis({
    ranges: reordered,
    joins: joinsFor(reordered),
    allowReorder: { reason: 'the closing line is the strongest hook and opens the cut' },
  })
  assert.equal(declared.chronologyPreserved, false)
  assert.equal(declared.reorderReason, 'the closing line is the strongest hook and opens the cut')
  // Reordering does not license overlap: the source-order check still ran.
  assert.equal(declared.ranges[0].rangeId, 'range-6')
})

test('T-FR-135 whether a join is a splice is measured, not declared', () => {
  // A caller that labels a splice "contiguous" is claiming the speaker said
  // these words consecutively. The source decides that, not the caller.
  assert.throws(
    () => synthesis({ joins: joinsFor(ranges(), { 0: { kind: 'contiguous' } }) }),
    /declared contiguous but the source says spliced/,
  )

  // And a genuinely abutting pair may not be dressed up as a splice either.
  const abutting = ranges([{ rangeId: 'range-2', startMs: 145_000, endMs: 163_000 }])
  assert.throws(
    () => synthesis({ ranges: abutting, joins: joinsFor(abutting) }),
    /declared spliced but the source says contiguous/,
  )

  const honest = synthesis({
    ranges: abutting,
    joins: joinsFor(abutting, { 0: { kind: 'contiguous', justification: '' } }),
  })
  assert.equal(honest.joins[0].kind, 'contiguous')
  assert.equal(honest.joins[0].droppedMs, 0)
  // A contiguous join needs no justification: the source already made it.
  assert.equal(honest.joins[0].justification, '')
  assert.equal(splicedJoins(honest).length, 4)
})

test('T-FR-135 a splice must justify the words it puts next to each other', () => {
  assert.throws(
    () => synthesis({ joins: joinsFor(ranges(), { 2: { justification: 'flows' } }) }),
    /joins words the speaker never said consecutively and must justify it/,
  )

  const result = synthesis()
  assert.equal(result.joins[0].droppedMs, 900_000 - 145_000)
  // The join lands at the end of the first window on the output timeline.
  assert.equal(result.joins[0].timelineMs, 25_000)
  assert.deepEqual([...result.joins[0].continuityRisks], ['argument'])
})

test('T-FR-135 a synthesis that misses its target duration is refused', () => {
  assert.throws(
    () => synthesis({ targetDurationMs: 90_000, toleranceMs: 2_000 }),
    /runs 120000 ms against a target of 90000 ms, outside the 2000 ms tolerance/,
  )
  // Inside the tolerance it stands, and the achieved duration is reported
  // rather than rounded to the target.
  const loose = synthesis({ targetDurationMs: 119_000, toleranceMs: 2_000 })
  assert.equal(loose.synthesizedDurationMs, 120_000)
  assert.equal(loose.targetDurationMs, 119_000)
})

test('T-FR-135 rights and consent are re-checked at synthesis, not trusted from selection', () => {
  // A window can be chosen while approved and assembled after a revocation.
  assert.throws(
    () => synthesis({ ranges: ranges().map((range, index) => index === 2 ? { ...range, rightsStatus: 'blocked' } : range) }),
    /carries no approved rights snapshot/,
  )
  assert.throws(
    () => synthesis({ ranges: ranges().map((range, index) => index === 4 ? { ...range, consentStatus: 'blocked' } : range) }),
    /carries blocked consent/,
  )
  // `not-required` is a real answer, not a missing one.
  const noConsent = synthesis({ ranges: ranges().map((range) => ({ ...range, consentStatus: 'not-required' })) })
  assert.equal(noConsent.ranges[0].consentStatus, 'not-required')
})

test('T-FR-135 frame conversion is exact at 30000/1001 and anchored to the source', () => {
  // 29.97 has no decimal form and neither does a tick count derived from it.
  assert.equal(msToFrames(0, NTSC), 0)
  assert.equal(msToFrames(1_000, NTSC), 29)
  assert.equal(msToFrames(TWO_HOURS_MS, NTSC), 215_784)

  // Boundaries are computed from the source, not from the clip length, so a
  // clip never claims a frame its range does not contain. The two disagree at
  // real boundaries: 1034 ms to 1068 ms spans two source frames, while the same
  // 34 ms measured from zero spans one. The source-anchored answer is the one
  // that matches what is on the card.
  assert.equal(msToFrames(1_034, NTSC), 30)
  assert.equal(msToFrames(1_068, NTSC), 32)
  assert.equal(msToFrames(1_068, NTSC) - msToFrames(1_034, NTSC), 2)
  assert.equal(msToFrames(1_068 - 1_034, NTSC), 1)

  // Whatever the per-clip answers, they must sum to the plan's total exactly —
  // this is the property a float pipeline loses first, one frame at a time.
  const result = synthesis()
  const [track] = result.editPlan.videoTracks
  const summed = track.clips.reduce((total, clip) => total + (clip.timelineOutFrame - clip.timelineInFrame), 0)
  assert.equal(summed, result.editPlan.durationFrames)
})

test('T-FR-135 a range shorter than one frame is refused', () => {
  // It would appear in the plan and render nothing: invisible in both.
  const tiny = ranges([{ rangeId: 'range-6', startMs: 7_000_000, endMs: 7_000_010 }])
  assert.throws(
    () => synthesis({ ranges: tiny, targetDurationMs: 105_010, toleranceMs: 2_000 }),
    /shorter than one frame and would compile to a clip that renders nothing/,
  )
})

test('T-FR-135 a range past the end of the source is refused', () => {
  assert.throws(
    () => synthesis({ ranges: ranges([{ rangeId: 'range-6', startMs: 7_190_000, endMs: 7_205_000 }]) }),
    /runs past the end of the source/,
  )
})

test('T-FR-135 the synthesis is deterministic and a tampered stored copy is refused', () => {
  const first = synthesis()
  const second = synthesis()
  assert.equal(first.synthesisHash, second.synthesisHash)
  assert.equal(first.editPlan.selectionHash, second.editPlan.selectionHash)

  assert.equal(assertEditorialSynthesisIntegrity(first), first)
  assert.throws(
    () => assertEditorialSynthesisIntegrity({ ...first, synthesizedDurationMs: 121_000 }),
    /hash/,
  )
  // Rewriting a justification after the fact must not pass unnoticed: the
  // justifications are the audit trail for the splices.
  assert.throws(
    () => assertEditorialSynthesisIntegrity({
      ...first,
      joins: first.joins.map((join, index) => index === 0 ? { ...join, justification: 'because' } : join),
    }),
    /hash/,
  )
})

test('T-FR-135 the join count must match the range count', () => {
  assert.throws(
    () => synthesis({ joins: joinsFor(ranges()).slice(0, 3) }),
    /needs exactly 5 joins/,
  )
  assert.throws(
    () => synthesis({ joins: joinsFor(ranges()).map((join, index) => index === 1 ? { ...join, afterRangeId: 'range-6' } : join) }),
    /must describe the pair range-2 → range-3/,
  )
})

/** Deterministic LCG; the seed is printed so a failure reproduces from the log. */
function lcg(seed) {
  let state = BigInt(seed) % BigInt(2_147_483_647)
  if (state <= BigInt(0)) state += BigInt(2_147_483_646)
  return () => {
    state = (state * BigInt(16_807)) % BigInt(2_147_483_647)
    return Number(state) / 2_147_483_647
  }
}

test('T-FR-135 property: any selection compiles to a gapless, monotonic timeline', () => {
  const SEED = 20260911
  console.log(`editorial synthesis property seed=${SEED}`)
  const random = lcg(SEED)
  let splicedSeen = 0
  let contiguousSeen = 0

  for (let round = 0; round < 150; round += 1) {
    const count = 2 + Math.floor(random() * 6)
    const list = []
    let cursor = Math.floor(random() * 60_000)
    for (let index = 0; index < count; index += 1) {
      const length = 3_000 + Math.floor(random() * 20_000)
      // A third of boundaries abut exactly, so both join kinds are exercised
      // rather than the wide uniform draw making every join a splice.
      const gap = random() < 0.34 ? 0 : 1 + Math.floor(random() * 400_000)
      list.push({
        rangeId: `range-${index}`,
        startMs: cursor,
        endMs: cursor + length,
        lineage: LINEAGE,
        rightsSnapshotId: 'rights-master',
        rightsStatus: 'approved',
        consentStatus: 'approved',
        claimIds: [],
        qualifierIds: [],
        proofContextIds: [],
      })
      cursor = cursor + length + gap
    }
    if (cursor > TWO_HOURS_MS) continue

    const total = list.reduce((sum, range) => sum + (range.endMs - range.startMs), 0)
    const joins = list.slice(0, -1).map((range, index) => {
      const kind = list[index + 1].startMs === range.endMs ? 'contiguous' : 'spliced'
      if (kind === 'spliced') splicedSeen += 1
      else contiguousSeen += 1
      return {
        beforeRangeId: range.rangeId,
        afterRangeId: list[index + 1].rangeId,
        kind,
        justification: kind === 'spliced' ? `round ${round} join ${index} keeps the argument intact` : '',
        continuityRisks: [],
      }
    })

    const result = createEditorialSynthesis({
      id: 'synthesis-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      objective: 'property round',
      targetDurationMs: total,
      toleranceMs: 0,
      sourceDurationMs: TWO_HOURS_MS,
      frameRate: NTSC,
      storyPlan: PLAN,
      editPlanId: 'edit-plan-1',
      ranges: list,
      joins,
    })

    const [track] = result.editPlan.videoTracks
    let cursorFrame = 0
    for (const clip of track.clips) {
      assert.equal(clip.timelineInFrame, cursorFrame, `round ${round}: timeline hole (seed=${SEED})`)
      assert.ok(clip.timelineOutFrame > clip.timelineInFrame, `round ${round}: empty clip (seed=${SEED})`)
      assert.ok(clip.sourceOutFrame > clip.sourceInFrame, `round ${round}: empty source span (seed=${SEED})`)
      cursorFrame = clip.timelineOutFrame
    }
    assert.equal(result.editPlan.durationFrames, cursorFrame, `round ${round}: total disagrees (seed=${SEED})`)
    assert.equal(result.synthesizedDurationMs, total, `round ${round}: duration disagrees (seed=${SEED})`)
    assert.equal(result.droppedMs, TWO_HOURS_MS - total)
  }

  console.log(`spliced joins=${splicedSeen}, contiguous joins=${contiguousSeen}`)
  assert.ok(splicedSeen > 20, `too few splices to be meaningful (seed=${SEED})`)
  assert.ok(contiguousSeen > 5, `the contiguous join went untested (seed=${SEED})`)
})
