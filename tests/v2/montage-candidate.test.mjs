import test from 'node:test'
import assert from 'node:assert/strict'

import { createMontageCandidateSeed, createMontageSelection, evaluateMontageCandidate, MONTAGE_ALTERNATIVE_POLICY_VERSION, MONTAGE_RUBRIC } from '../../src/v2/domain/montage-candidate.ts'
import { canonicalMontageCost, canonicalMontageScore, createMontageAlternativeRunService, readMontageAlternativeRunService, selectMontageCandidate } from '../../src/v2/application/select-montage-candidate.ts'
import { authenticatedActor } from './helpers/authentication-audit.mjs'

const storyPlanRef = { id: 'story-plan-v1', hash: 'a'.repeat(64) }
const seed = (id, overrides = {}) => ({
  id, seed: `seed-${id}`, storyPlanRef, mode: 'chronological', hook: { id: `hook-${id}`, selfContained: true },
  blockOrder: ['block-hook', 'block-body', 'block-cta'], permittedBlockOrders: [['block-hook', 'block-body', 'block-cta'], ['block-body', 'block-hook', 'block-cta']],
  assets: [{ id: `asset-${id}`, rightsApproved: true }], patternBreaks: [{ id: `break-${id}`, atMs: 1_000, group: `group-${id}` }],
  maximumPatternBreaks: 3, confidence: 0.9, rubricSignals: { narrative: 0.8, objective: 0.75, continuity: 0.9, evidence: 0.85 }, ...overrides,
})

test('T-FR-062 canonical seed binds hook, permitted order, assets and pattern breaks', () => {
  const created = createMontageCandidateSeed(seed('canonical'))
  assert.equal(created.schemaVersion, 'montage-candidate-seed/v1')
  assert.deepEqual({ hook: created.hook.id, order: created.blockOrder, asset: created.assets[0].id, pattern: created.patternBreaks[0].id }, { hook: 'hook-canonical', order: ['block-hook', 'block-body', 'block-cta'], asset: 'asset-canonical', pattern: 'break-canonical' })
  assert.match(created.seedHash, /^[a-f0-9]{64}$/)
  assert.equal(createMontageCandidateSeed(created).seedHash, created.seedHash)
})

test('T-FR-062 hard gates run before score and cost callbacks for every rejected candidate', () => {
  let scored = 0; let costed = 0
  const rejectedSeeds = [
    seed('hook', { mode: 'cold-open', hook: { id: 'hook-unsafe', selfContained: false } }),
    seed('order', { blockOrder: ['block-body', 'block-cta', 'block-hook'] }),
    seed('rights', { assets: [{ id: 'asset-denied', rightsApproved: false }] }),
    seed('budget', { maximumPatternBreaks: 0 }),
    seed('coverage', { blockOrder: ['block-hook', 'block-body'] }),
  ]
  const result = selectMontageCandidate({ seeds: rejectedSeeds, score: () => (scored += 1), estimateCost: () => (costed += 1) })
  assert.equal(scored, 0); assert.equal(costed, 0); assert.equal(result.status, 'blocked')
  assert.deepEqual(result.candidates.map(({ rejectionReasons }) => rejectionReasons[0]), ['HOOK_NOT_SELF_CONTAINED', 'ORDER_NOT_PERMITTED', 'RIGHTS_NOT_APPROVED', 'PATTERN_BUDGET_EXCEEDED', 'ORDER_NOT_PERMITTED'])
  assert.ok(result.candidates.every(({ score, estimatedCost }) => score === null && estimatedCost === null))
})

test('T-FR-062 all candidates share one rubric and diversity is normalized across four axes', () => {
  const result = selectMontageCandidate({ seeds: [
    seed('candidate-a'),
    seed('candidate-b', { mode: 'cold-open', blockOrder: ['block-body', 'block-hook', 'block-cta'] }),
    seed('candidate-c', { hook: { id: 'hook-candidate-a', selfContained: true }, assets: [{ id: 'asset-candidate-a', rightsApproved: true }], patternBreaks: [{ id: 'break-candidate-a', atMs: 1_000, group: 'group-candidate-a' }] }),
  ] })
  assert.equal(result.rubric, MONTAGE_RUBRIC)
  assert.deepEqual(result.diversity, { candidateCount: 3, eligibleCount: 3, uniqueHooks: 2, uniqueOrders: 2, uniqueAssetSets: 2, uniquePatternSets: 2, normalized: { hooks: 0.666667, orders: 0.666667, assets: 0.666667, patterns: 0.666667, overall: 0.666667 } })
})

test('T-FR-062 winner is deterministic by score, then cost, then canonical ID while retaining alternatives', () => {
  const result = selectMontageCandidate({ seeds: [seed('candidate-z'), seed('candidate-b'), seed('candidate-a')], score: () => 0.8, estimateCost: (candidate) => candidate.id === 'candidate-z' ? 2 : 1 })
  assert.equal(result.status, 'review'); assert.equal(result.reason, 'SCORE_TIE'); assert.equal(result.winnerId, 'candidate-a')
  assert.equal(result.candidates.length, 3); assert.ok(result.candidates.every(({ candidateHash }) => /^[a-f0-9]{64}$/.test(candidateHash)))
  assert.match(result.selectionHash, /^[a-f0-9]{64}$/)
})

test('T-FR-062 returns review for low confidence and block for zero eligible candidates', () => {
  const low = selectMontageCandidate({ seeds: [seed('low', { confidence: 0.55, rubricSignals: { narrative: 1, objective: 1, continuity: 1, evidence: 1 } })] })
  assert.deepEqual({ status: low.status, reason: low.reason, winnerId: low.winnerId }, { status: 'review', reason: 'LOW_CONFIDENCE', winnerId: 'low' })
  const blocked = selectMontageCandidate({ seeds: [seed('denied', { assets: [{ id: 'asset-denied', rightsApproved: false }] })] })
  assert.deepEqual({ status: blocked.status, reason: blocked.reason, winnerId: blocked.winnerId }, { status: 'blocked', reason: 'NO_ELIGIBLE_CANDIDATE', winnerId: null })
})

test('T-FR-062 hydration rejects candidate or selection tampering', () => {
  const canonical = createMontageCandidateSeed(seed('integrity'))
  const evaluated = evaluateMontageCandidate({ seed: canonical, score: canonicalMontageScore, estimateCost: canonicalMontageCost })
  assert.throws(() => createMontageSelection({ candidates: [{ ...evaluated, estimatedCost: 999 }] }), /inconsistent/)
  assert.throws(() => evaluateMontageCandidate({ seed: { ...canonical, confidence: 0.1 }, score: canonicalMontageScore, estimateCost: canonicalMontageCost }), /seed hash/)
  const otherStoryPlan = evaluateMontageCandidate({ seed: createMontageCandidateSeed(seed('other-plan', { storyPlanRef: { id: 'story-plan-v2', hash: storyPlanRef.hash } })), score: canonicalMontageScore, estimateCost: canonicalMontageCost })
  assert.throws(() => createMontageSelection({ candidates: [evaluated, otherStoryPlan] }), /same StoryPlan contract/)
})

const actor = authenticatedActor({ clientId: 'client-montage', credentialId: 'credential-montage', workspaceId: 'workspace-montage', scopes: ['projects:write', 'projects:read'] })

test('T-FR-062 application persists complete selection and replays before any scoring work', async () => {
  const records = new Map(); let createCount = 0
  const repository = {
    async readStoryPlanReference(input) { return input.storyPlanId === storyPlanRef.id ? { id: storyPlanRef.id, hash: storyPlanRef.hash } : null },
    async findReplay(input) { return [...records.values()].find((record) => record.idempotencyKey === input.idempotencyKey && record.createdByClientId === input.actorClientId) ?? null },
    async create(input) { createCount += 1; const run = Object.freeze({ ...input.run, requestFingerprint: input.requestFingerprint, idempotencyKey: input.idempotencyKey }); records.set(run.id, run); return Object.freeze({ run, replayed: false }) },
    async read(input) { return [...records.values()].find((run) => run.id === input.runId && run.workspaceId === input.workspaceId && run.projectId === input.projectId) ?? null },
  }
  const service = createMontageAlternativeRunService({ repository, clock: () => new Date('2026-08-13T13:00:00.000Z'), createRunId: () => 'montage-run-001' })
  const request = { workspaceId: actor.workspaceId, projectId: 'project-montage', policyVersion: MONTAGE_ALTERNATIVE_POLICY_VERSION, storyPlanRef, seeds: [seed('candidate-a'), seed('candidate-b', { rubricSignals: { narrative: 0.95, objective: 0.95, continuity: 0.95, evidence: 0.95 } })], actor, idempotencyKey: 'montage-key-001' }
  const created = await service(request); const replay = await service(request)
  assert.equal(created.replayed, false); assert.equal(replay.replayed, true); assert.equal(createCount, 1)
  assert.equal(created.run.selection.winnerId, 'candidate-b'); assert.equal(created.run.selection.candidates.length, 2)
  assert.equal((await readMontageAlternativeRunService({ repository })({ workspaceId: actor.workspaceId, projectId: 'project-montage', runId: created.run.id })).runHash, created.run.runHash)
  await assert.rejects(() => service({ ...request, seeds: [seed('different')] }), /different montage alternative request/)
  await assert.rejects(() => service({ ...request, storyPlanRef: { ...storyPlanRef, hash: 'b'.repeat(64) }, seeds: [seed('stale', { storyPlanRef: { ...storyPlanRef, hash: 'b'.repeat(64) } })], idempotencyKey: 'montage-key-stale' }), /stale StoryPlan hash/)
})
