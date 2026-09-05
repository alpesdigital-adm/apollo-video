import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileSynthesisRenderPlanService,
  compileSynthesisToDirectedPlan,
} from '../../src/v2/application/compile-synthesis-to-directed-plan.ts'
import { validateDirectedEditPlan } from '../../src/v2/domain/director-run.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createEditorialSynthesis } from '../../src/v2/domain/editorial-synthesis.ts'
import { rational } from '../../src/v2/domain/session-time.ts'
import { STORY_GOLDEN_FIXTURES } from '../../src/v2/domain/story-plan.ts'

/**
 * F4.016 condition 6 — the bridge from a multi-range synthesis to a plan the
 * renderer accepts.
 *
 * The fixture is the two-hour master cut to two minutes: six windows from
 * different hours of an interview, with a claim, its qualifier and its proof
 * context deliberately in three separate windows. That is the arrangement where
 * losing a window quietly changes what was said, and it is why "every range
 * survives, once, in output order" is asserted rather than assumed.
 */

const NTSC = rational(BigInt(30_000), BigInt(1_001))
const TWO_HOURS_MS = 7_200_000
const TWO_MINUTES_MS = 120_000
const h = (n) => 'a'.repeat(63) + String(n)
const MASTER_SHA = h(1)

const LINEAGE = {
  sourceArtifactId: 'artifact-master',
  sourceArtifactSha256: MASTER_SHA,
  sourceManifestId: 'manifest-master',
  sourceManifestHash: h(2),
  indexRunId: 'index-run-1',
  momentId: 'moment-1',
  momentHash: h(3),
  evaluationId: 'evaluation-1',
  evaluationHash: h(4),
}

const WINDOWS = [
  { rangeId: 'range-1', startMs: 120_000, endMs: 145_000 },
  { rangeId: 'range-2', startMs: 900_000, endMs: 918_000 },
  { rangeId: 'range-3', startMs: 1_800_000, endMs: 1_822_000, claimIds: ['claim-1'] },
  { rangeId: 'range-4', startMs: 3_600_000, endMs: 3_615_000, qualifierIds: ['qualifier-1'] },
  { rangeId: 'range-5', startMs: 5_400_000, endMs: 5_425_000, proofContextIds: ['proof-1'] },
  { rangeId: 'range-6', startMs: 7_000_000, endMs: 7_015_000 },
]

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

function ranges() {
  return WINDOWS.map((window) => ({
    claimIds: [],
    qualifierIds: [],
    proofContextIds: [],
    ...window,
    lineage: LINEAGE,
    rightsSnapshotId: 'rights-master',
    rightsStatus: 'approved',
    consentStatus: 'approved',
  }))
}

function joinsFor(list) {
  return list.slice(0, -1).map((range, index) => ({
    beforeRangeId: range.rangeId,
    afterRangeId: list[index + 1].rangeId,
    kind: 'spliced',
    justification: `window ${index + 1} closes the thought that window ${index + 2} opens`,
    continuityRisks: ['argument'],
  }))
}

function synthesis() {
  const list = ranges()
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
    ranges: list,
    joins: joinsFor(list),
  })
}

const OPTIONS = Object.freeze({
  sources: [{ artifactId: 'artifact-master', sha256: MASTER_SHA, durationSeconds: 7_200 }],
  projectVersionId: 'version-1',
  objective: 'discovery',
  createdAt: '2029-06-01T09:00:00.000Z',
})

/**
 * The project's media-asset links, as the service will ask for them.
 *
 * The service takes no sources from its caller any more: it resolves every
 * `range.lineage.sourceArtifactId` here — the same lookup the render path uses —
 * and reads the digest and the measured duration off the artifact.
 */
function fakeRenderSources(entries = [
  { artifactId: 'artifact-master', sha256: MASTER_SHA, byteSize: 4_096, mediaType: 'video', durationSeconds: 7_200 },
]) {
  const rows = new Map(entries.map((entry) => [entry.artifactId, entry]))
  const asked = []
  return {
    asked,
    async resolveForProject({ workspaceId, projectId, artifactIds }) {
      asked.push({ workspaceId, projectId, artifactIds: [...artifactIds] })
      return artifactIds.flatMap((artifactId) => {
        const row = rows.get(artifactId)
        return row ? [row] : []
      })
    },
  }
}

function memorySnapshots() {
  const rows = []
  return {
    rows,
    async persist({ snapshot, createdAt }) {
      const existing = rows.find((row) =>
        row.origin === snapshot.origin && row.sourceId === snapshot.sourceId &&
        row.sourceHash === snapshot.sourceHash &&
        row.plan.projectVersionId === snapshot.plan.projectVersionId)
      if (existing) {
        if (existing.planHash === snapshot.planHash) return { snapshot: existing, replayed: true }
        throw new DomainError('PERSISTENCE_CONFLICT', 'a different plan is stored for that source hash')
      }
      const stored = Object.freeze({ ...snapshot, createdAt })
      rows.push(stored)
      return { snapshot: stored, replayed: false }
    },
    async readLatestForSource({ origin, sourceId }) {
      return [...rows].reverse().find((row) => row.origin === origin && row.sourceId === sourceId) ?? null
    },
    async listForProject() { return rows },
  }
}

test('T-F4.016 every selected range survives, once, in output order, and the plan validates', () => {
  const cut = synthesis()
  const plan = compileSynthesisToDirectedPlan(cut, OPTIONS)

  validateDirectedEditPlan(plan)
  const clips = plan.videoTracks[0].clips
  assert.equal(clips.length, cut.ranges.length)
  assert.deepEqual(
    clips.map((clip) => clip.id),
    cut.ranges.map((range) => `clip-${range.rangeId}`),
  )
  // The retained source ranges are the windows themselves, in seconds. A
  // compiler that dropped one would drop the qualifier that makes claim-1
  // honest, and the render would still be clean.
  assert.deepEqual(
    plan.editorial.retainedSourceRanges,
    cut.ranges.map((range) => ({
      sourceStartSeconds: range.startMs / 1_000,
      sourceEndSeconds: range.endMs / 1_000,
    })),
  )
  assert.ok(clips.every((clip) => clip.rate === 1), 'a synthesis selects; it never retimes')
  assert.equal(plan.storyPlanId, 'story-plan-1', 'the StoryPlan reference is a real one')
  assert.equal(plan.treatmentPlanId, 'multi-range-synthesis:synthesis-1')
  assert.equal(plan.directorRunId, 'multi-range-synthesis:synthesis-1')
})

test('T-F4.016 the output is the sum of the ranges, not the duration of the master', () => {
  const cut = synthesis()
  const plan = compileSynthesisToDirectedPlan(cut, OPTIONS)

  const fps = 30_000 / 1_001
  const expected = Math.round(TWO_MINUTES_MS / 1_000 * fps)
  assert.ok(
    Math.abs(plan.durationFrames - expected) <= cut.ranges.length,
    `${plan.durationFrames} frames against ${expected} expected`,
  )
  // The falsifier for "assume the output is as long as the source": two hours
  // at this rate is 215,784 frames, sixty times what this plan runs.
  const masterFrames = Math.round(TWO_HOURS_MS / 1_000 * fps)
  assert.ok(plan.durationFrames * 50 < masterFrames, 'the cut is a small fraction of the master')
  // Contiguous on the timeline, whatever the source did between windows.
  let cursor = 0
  for (const clip of plan.videoTracks[0].clips) {
    assert.equal(clip.timelineInFrame, cursor)
    cursor = clip.timelineOutFrame
  }
  assert.equal(cursor, plan.durationFrames)
})

test('T-F4.016 every splice becomes a marker carrying the dropped span and its continuity risks', () => {
  const cut = synthesis()
  const plan = compileSynthesisToDirectedPlan(cut, OPTIONS)

  assert.equal(plan.markers.length, cut.joins.length, 'all five joins in this fixture are splices')
  assert.equal(plan.transitions.length, cut.ranges.length - 1)
  for (const [index, join] of cut.joins.entries()) {
    const marker = plan.markers[index]
    assert.deepEqual([...marker.ruleIds], ['synthesis:spliced', 'continuity:argument'])
    const before = cut.ranges.find((range) => range.rangeId === join.beforeRangeId)
    const after = cut.ranges.find((range) => range.rangeId === join.afterRangeId)
    assert.equal(marker.sourceStartSeconds, before.endMs / 1_000)
    assert.equal(marker.sourceEndSeconds, after.startMs / 1_000)
    // The seam carries the editor's own justification, not a generated
    // sentence: what defends this cut is what the person wrote.
    assert.ok(
      plan.transitions[index].reason.includes(join.justification),
      plan.transitions[index].reason,
    )
    assert.ok(plan.transitions[index].reason.includes(String(join.droppedMs)))
  }
})

test('T-F4.016 a source whose bytes are no longer the selected ones is refused', () => {
  const cut = synthesis()
  const swapped = {
    ...OPTIONS,
    sources: [{ artifactId: 'artifact-master', sha256: h(9), durationSeconds: 7_200 }],
  }
  assert.throws(
    () => compileSynthesisToDirectedPlan(cut, swapped),
    (error) => error.code === 'MEDIA_ARTIFACT_IDENTITY_MISMATCH' &&
      error.details.selectedSha256 === MASTER_SHA,
  )
  assert.throws(
    () => compileSynthesisToDirectedPlan(cut, { ...OPTIONS, sources: [] }),
    (error) => error.code === 'MEDIA_ARTIFACT_NOT_FOUND',
  )
})

test('T-F4.016 a declared duration that the ranges contradict is refused', () => {
  const cut = synthesis()
  // A five-second master whose ranges read to the two-hour mark. The only check
  // this used to face was "finite and positive", so it compiled: the stored plan
  // then carried five seconds as the provenance of a cut taken from two hours.
  assert.throws(
    () => compileSynthesisToDirectedPlan(cut, {
      ...OPTIONS,
      sources: [{ artifactId: 'artifact-master', sha256: MASTER_SHA, durationSeconds: 5 }],
    }),
    (error) => error.code === 'INVALID_RENDER_INPUT' && error.details.lastReadMs === 7_015_000,
  )
  // Long enough for every range, and still not the master the synthesis says it
  // selected from: the aggregate declares two hours, the file measures three.
  assert.throws(
    () => compileSynthesisToDirectedPlan(cut, {
      ...OPTIONS,
      sources: [{ artifactId: 'artifact-master', sha256: MASTER_SHA, durationSeconds: 10_800 }],
    }),
    (error) => error.code === 'INVALID_RENDER_INPUT' &&
      error.details.declaredMs === TWO_HOURS_MS,
  )
})

test('T-F4.016 a splice whose clip cannot be found is refused, not anchored at frame 0', () => {
  const cut = synthesis()
  // Frame 0 is a legitimate position — it is the first clip's `timelineInFrame`
  // — so a lookup miss defaulted to 0 was indistinguishable from a real marker
  // on the opening frame, in a document a reviewer navigates by.
  const renamed = {
    ...cut,
    editPlan: {
      ...cut.editPlan,
      videoTracks: cut.editPlan.videoTracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, clipId: `renamed-${clip.clipId}` })),
      })),
    },
  }
  assert.throws(
    () => compileSynthesisToDirectedPlan(renamed, OPTIONS),
    (error) => error.code === 'INVALID_RENDER_INPUT' &&
      error.details.joinAfterRangeId === cut.joins[0].afterRangeId,
  )
})

test('T-F4.016 the service stores one snapshot per cut and replays a recompile', async () => {
  const cut = synthesis()
  const snapshots = memorySnapshots()
  const sources = fakeRenderSources()
  const compile = compileSynthesisRenderPlanService({
    syntheses: {
      async read({ synthesisId }) {
        return synthesisId === cut.id ? { synthesis: cut, createdAt: OPTIONS.createdAt } : null
      },
      async persist() { throw new Error('unused') },
      async list() { return [] },
      async listByMoment() { return [] },
    },
    sources,
    snapshots,
    clock: () => new Date(OPTIONS.createdAt),
  })
  const call = (overrides = {}) => compile({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    synthesisId: 'synthesis-1',
    projectVersionId: 'version-1',
    objective: 'discovery',
    ...overrides,
  })

  const first = await call()
  const second = await call()

  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.equal(second.planHash, first.planHash)
  assert.equal(snapshots.rows.length, 1)
  assert.equal(snapshots.rows[0].sourceHash, cut.synthesisHash)
  assert.equal(snapshots.rows[0].clipCount, cut.ranges.length)
  // The measurements in the stored plan came from the server, and the input
  // carries no field a caller could have put them in.
  assert.deepEqual(
    first.plan.sources.map((source) => ({ ...source })),
    [{ id: 'source-artifact-master', artifactId: 'artifact-master', kind: 'video', durationSeconds: 7_200 }],
  )
  assert.deepEqual(sources.asked[0], {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    artifactIds: ['artifact-master'],
  })

  const missing = await call({ synthesisId: 'synthesis-absent' })
    .then(() => null, (error) => error)
  assert.equal(missing?.code, 'EDITORIAL_SYNTHESIS_NOT_FOUND')
})

test('T-F4.016 the service refuses a master the project cannot render from, and never takes one from the caller', async () => {
  const cut = synthesis()
  const snapshots = memorySnapshots()
  const syntheses = {
    async read({ synthesisId }) {
      return synthesisId === cut.id ? { synthesis: cut, createdAt: OPTIONS.createdAt } : null
    },
    async persist() { throw new Error('unused') },
    async list() { return [] },
    async listByMoment() { return [] },
  }
  const compileWith = (sources) => compileSynthesisRenderPlanService({
    syntheses, sources, snapshots, clock: () => new Date(OPTIONS.createdAt),
  })({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    synthesisId: 'synthesis-1',
    projectVersionId: 'version-1',
    objective: 'discovery',
    // Named on purpose: an input the service does not read. Under the old
    // signature these three fields were the only measurements it had.
    sources: [{ artifactId: 'artifact-master', sha256: MASTER_SHA, durationSeconds: 7_200 }],
  })

  const unlinked = await compileWith(fakeRenderSources([])).then(() => null, (error) => error)
  assert.equal(unlinked?.code, 'MEDIA_ARTIFACT_NOT_FOUND')
  assert.equal(unlinked.details.artifactId, 'artifact-master')

  const swapped = await compileWith(fakeRenderSources([{
    artifactId: 'artifact-master', sha256: h(9), byteSize: 4_096, mediaType: 'video', durationSeconds: 7_200,
  }])).then(() => null, (error) => error)
  assert.equal(swapped?.code, 'MEDIA_ARTIFACT_IDENTITY_MISMATCH')

  const unprobed = await compileWith(fakeRenderSources([{
    artifactId: 'artifact-master', sha256: MASTER_SHA, byteSize: 4_096, mediaType: 'video', durationSeconds: null,
  }])).then(() => null, (error) => error)
  assert.equal(unprobed?.code, 'INVALID_RENDER_INPUT')

  assert.equal(snapshots.rows.length, 0, 'no refusal may leave a snapshot behind')
})
