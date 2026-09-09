import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEditorialSynthesisService,
  listEditorialSynthesesService,
  readEditorialSynthesisService,
} from '../../src/v2/application/editorial-synthesis.ts'
import {
  assertEditorialSynthesisIntegrity,
} from '../../src/v2/domain/editorial-synthesis.ts'
import { rational } from '../../src/v2/domain/session-time.ts'
import { STORY_GOLDEN_FIXTURES } from '../../src/v2/domain/story-plan.ts'
import {
  parseCreateEditorialSynthesisBody,
  presentEditorialSynthesis,
  presentEditorialSynthesisSummary,
} from '../../src/v2/public-api/editorial-synthesis-contract.ts'

/**
 * E2E — two hours of master become a two-minute multi-range cut.
 *
 * The journey runs through the real boundary parser, the real service, the real
 * domain and a repository that behaves like the persisted one: it refuses a
 * different body under the same id, and it verifies the stored hash on read.
 * What it does not do is talk to Postgres, so the whole journey is executable
 * on any machine — the Prisma round trip is proved separately in CI.
 *
 * The arrangement under test is the one a topical selector actually produces:
 * a claim in one window, the words that qualify it in another, and the customer
 * who proves it in a third. Six windows, none adjacent, spread across two
 * hours.
 */

const TWO_HOURS_MS = 7_200_000
const TWO_MINUTES_MS = 120_000
const NTSC = rational(BigInt(30_000), BigInt(1_001))
const h = (n) => 'a'.repeat(63) + String(n)

const LINEAGE = {
  sourceArtifactId: 'artifact-master-interview',
  sourceArtifactSha256: h(1),
  sourceManifestId: 'manifest-master-interview',
  sourceManifestHash: h(2),
  indexRunId: 'index-run-1',
  momentId: 'moment-1',
  momentHash: h(3),
  evaluationId: 'evaluation-1',
  evaluationHash: h(4),
}

const WINDOWS = [
  { rangeId: 'range-1', startMs: 120_000, endMs: 145_000, claimIds: [], qualifierIds: [], proofContextIds: [] },
  { rangeId: 'range-2', startMs: 900_000, endMs: 918_000, claimIds: [], qualifierIds: [], proofContextIds: [] },
  { rangeId: 'range-3', startMs: 1_800_000, endMs: 1_822_000, claimIds: ['claim-1'], qualifierIds: [], proofContextIds: [] },
  { rangeId: 'range-4', startMs: 3_600_000, endMs: 3_615_000, claimIds: [], qualifierIds: ['qualifier-1'], proofContextIds: [] },
  { rangeId: 'range-5', startMs: 5_400_000, endMs: 5_425_000, claimIds: [], qualifierIds: [], proofContextIds: ['proof-1'] },
  { rangeId: 'range-6', startMs: 7_000_000, endMs: 7_015_000, claimIds: [], qualifierIds: [], proofContextIds: [] },
]

const PLAN = {
  ...STORY_GOLDEN_FIXTURES.linear,
  id: 'story-plan-founder-1',
  targetDurationMs: { min: 100_000, max: 140_000 },
  blocks: STORY_GOLDEN_FIXTURES.linear.blocks.map((block) => ({
    ...block,
    durationTargetMs: { min: 20_000, ideal: 30_000, max: 45_000 },
  })),
}

/** Behaves like the persisted repository: replay converges, divergence conflicts. */
function memoryRepository() {
  const rows = new Map()
  return {
    async persist({ synthesis, createdAt }) {
      const existing = rows.get(synthesis.id)
      if (existing) {
        if (existing.synthesis.synthesisHash === synthesis.synthesisHash) {
          return { synthesis: existing.synthesis, replayed: true }
        }
        const error = new Error('conflict')
        error.code = 'PERSISTENCE_CONFLICT'
        throw error
      }
      rows.set(synthesis.id, { synthesis, createdAt })
      return { synthesis, replayed: false }
    },
    async read({ synthesisId }) {
      const stored = rows.get(synthesisId)
      if (!stored) return null
      // The stored copy is re-verified on the way out, exactly as the Prisma
      // adapter does, so a tampered row fails here rather than rendering.
      assertEditorialSynthesisIntegrity(stored.synthesis)
      return stored
    },
    async list() {
      return [...rows.values()]
    },
    async listByMoment() { return [] },
  }
}

const storyPlans = {
  async read({ storyPlanId }) {
    return storyPlanId === PLAN.id
      ? { plan: PLAN, requestFingerprint: h(5), idempotencyKey: 'key-1' }
      : null
  },
}

/** The request exactly as a client would send it, strings and all. */
function requestBody(overrides = {}) {
  const ranges = (overrides.windows ?? WINDOWS).map((window) => ({
    ...window,
    lineage: LINEAGE,
    rightsSnapshotId: 'rights-master-interview',
    rightsStatus: 'approved',
    consentStatus: 'approved',
  }))
  return {
    synthesisId: 'synthesis-founder-two-minute',
    objective: 'two-minute cut of the founder interview',
    targetDurationMs: TWO_MINUTES_MS,
    toleranceMs: 2_000,
    sourceDurationMs: TWO_HOURS_MS,
    frameRate: '30000/1001',
    storyPlanId: PLAN.id,
    editPlanId: 'edit-plan-founder-1',
    ranges,
    joins: ranges.slice(0, -1).map((range, index) => ({
      beforeRangeId: range.rangeId,
      afterRangeId: ranges[index + 1].rangeId,
      kind: 'spliced',
      justification: `window ${index + 1} closes the thought that window ${index + 2} opens`,
      continuityRisks: ['argument'],
    })),
    ...overrides.body,
  }
}

function service(repository) {
  return createEditorialSynthesisService({
    repository,
    storyPlans,
    clock: () => new Date('2029-04-02T14:30:00.000Z'),
  })
}

test('E2E-FR-135 two hours of master become a two-minute cut, persisted and readable', async () => {
  const repository = memoryRepository()
  const body = parseCreateEditorialSynthesisBody(requestBody())

  const created = await service(repository)({
    workspaceId: 'workspace-1',
    projectId: 'project-founder-interview',
    ...body,
  })
  assert.equal(created.replayed, false)

  const summary = presentEditorialSynthesisSummary(created.synthesis)
  assert.equal(summary.synthesizedDurationMs, TWO_MINUTES_MS)
  assert.equal(summary.sourceDurationMs, TWO_HOURS_MS)
  assert.equal(summary.droppedMs, TWO_HOURS_MS - TWO_MINUTES_MS)
  // 120 s of 7200 s: one part in sixty.
  assert.equal(summary.compressionBps, 167)
  assert.equal(summary.rangeCount, 6)
  assert.equal(summary.spliceCount, 5)
  assert.equal(summary.chronologyPreserved, true)

  const stored = await readEditorialSynthesisService({ repository })({
    workspaceId: 'workspace-1',
    synthesisId: body.synthesisId,
  })
  const view = presentEditorialSynthesis(stored.synthesis, stored.createdAt)

  // The output timeline is continuous even though the source is not.
  assert.equal(view.durationFrames, summary.durationFrames)
  assert.ok(view.durationFrames > 0)
  assert.equal(view.frameRate, '30000/1001')
  assert.equal(view.createdAt, '2029-04-02T14:30:00.000Z')

  // Every join names the gap it crossed and where it lands on the timeline.
  assert.equal(view.joins.length, 5)
  assert.equal(view.joins[0].droppedMs, 900_000 - 145_000)
  assert.equal(view.joins[0].timelineMs, 25_000)
  assert.ok(view.joins.every((join) => join.justification.length >= 12))

  // Lineage survives: every clip traces to the moment and rights it came from.
  assert.deepEqual([...view.lineageRefs], [
    'evaluation:evaluation-1',
    'index-run:index-run-1',
    'manifest:manifest-master-interview',
    'moment:moment-1',
    'rights:rights-master-interview',
  ])

  // And the proof that nothing was said out of context is present whether or
  // not it found anything.
  assert.deepEqual([...view.contextProof.claimsIncluded], ['claim-1'])
  assert.deepEqual([...view.contextProof.qualifiersIncluded], ['qualifier-1'])
  assert.equal(view.contextProof.claimsRequiringQualifiers, 1)
  assert.equal(view.contextProof.claimsRequiringProof, 1)
})

test('E2E-FR-135 the same request twice converges instead of writing a second cut', async () => {
  const repository = memoryRepository()
  const body = parseCreateEditorialSynthesisBody(requestBody())
  const input = { workspaceId: 'workspace-1', projectId: 'project-founder-interview', ...body }

  const first = await service(repository)(input)
  const second = await service(repository)(input)

  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.equal(second.synthesis.synthesisHash, first.synthesis.synthesisHash)
  const all = await listEditorialSynthesesService({ repository })({
    workspaceId: 'workspace-1',
    projectId: 'project-founder-interview',
  })
  assert.equal(all.length, 1)
})

test('E2E-FR-135 dropping the window that carries the qualifier is refused end to end', async () => {
  // The whole point of the feature, exercised through the same path a client
  // takes. The cut would be clean, the audio continuous, and the founder would
  // be made to say something flatly stronger than what they said.
  const repository = memoryRepository()
  const windows = WINDOWS.map((window) =>
    window.rangeId === 'range-4' ? { ...window, qualifierIds: [] } : window)
  const body = parseCreateEditorialSynthesisBody(requestBody({ windows }))

  await assert.rejects(
    () => service(repository)({
      workspaceId: 'workspace-1',
      projectId: 'project-founder-interview',
      ...body,
    }),
    /claim-1 is included without its qualifier qualifier-1/,
  )

  const all = await listEditorialSynthesesService({ repository })({
    workspaceId: 'workspace-1',
    projectId: 'project-founder-interview',
  })
  assert.equal(all.length, 0, 'a refused cut must leave nothing behind')
})

test('E2E-FR-135 a revoked right refuses the cut even though selection had approved it', async () => {
  const repository = memoryRepository()
  const windows = WINDOWS.map((window) => ({ ...window }))
  const raw = requestBody({ windows })
  raw.ranges[2].rightsStatus = 'blocked'
  const body = parseCreateEditorialSynthesisBody(raw)

  await assert.rejects(
    () => service(repository)({
      workspaceId: 'workspace-1',
      projectId: 'project-founder-interview',
      ...body,
    }),
    /carries no approved rights snapshot/,
  )
})

test('E2E-FR-135 reordering the windows is refused unless it is declared', async () => {
  const repository = memoryRepository()
  const reordered = [WINDOWS[5], ...WINDOWS.slice(0, 5)]
  const raw = requestBody({ windows: reordered })

  await assert.rejects(
    () => service(repository)({
      workspaceId: 'workspace-1',
      projectId: 'project-founder-interview',
      ...parseCreateEditorialSynthesisBody(raw),
    }),
    /reordering changes what the material asserts about cause and must be declared/,
  )

  const declared = await service(repository)({
    workspaceId: 'workspace-1',
    projectId: 'project-founder-interview',
    ...parseCreateEditorialSynthesisBody({
      ...raw,
      allowReorder: { reason: 'the closing line is the strongest hook and opens the cut' },
    }),
  })
  assert.equal(declared.synthesis.chronologyPreserved, false)
  assert.equal(
    declared.synthesis.reorderReason,
    'the closing line is the strongest hook and opens the cut',
  )
})
