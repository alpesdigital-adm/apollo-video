import test from 'node:test'
import assert from 'node:assert/strict'
import { NARRATIVE_POLICY_FIXTURES, createNarrativeSafetyContext, validateNarrativeEdit } from '../../src/v2/domain/narrative-safety.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { preflightNarrativeSafetyService } from '../../src/v2/application/preflight-narrative-safety.ts'
import { parseNarrativeSafetyPreflightBody } from '../../src/v2/public-api/narrative-safety-contract.ts'
import { PrismaNarrativeSafetyRepository } from '../../src/v2/infrastructure/prisma/narrative-safety-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createStoryPlan } from '../../src/v2/domain/story-plan.ts'
import { createDesiredActionReference } from '../../src/v2/domain/desired-action.ts'

const fixtures = Object.values(NARRATIVE_POLICY_FIXTURES)
const block = (statement) => ({ id: statement.storyBlockId, actId: 'development', role: statement.kind === 'fact' ? 'context' : statement.kind === 'testimony' ? 'proof' : 'argument', intent: statement.kind, dependencies: [], sourceCandidateIds: [statement.sourceArtifactId], durationTargetMs: { min: 1_000, ideal: 2_000, max: 3_000 }, content: { claimIds: statement.claims.map((claim) => claim.id), qualifierIds: [], proofIds: statement.kind === 'testimony' || statement.dependencies.some((dependency) => dependency.kind === 'proof') ? ['proof-context'] : [] }, presentation: 'source-video', sourceRangeId: statement.id })
const storyPlan = { schemaVersion: 1, objective: 'sale', targetDurationMs: { min: 6_000, max: 12_000 }, acts: [{ id: 'development', role: 'development', blockIds: fixtures.map((statement) => statement.storyBlockId) }], blocks: fixtures.map(block) }
const context = createNarrativeSafetyContext({ storyPlanId: 'story-plan-safety', storyPlan, statements: fixtures })
const preserved = (id, overrides = {}) => { const statement = context.statements.find((value) => value.id === id); return { statementId: id, speakerId: statement.speakerId, sourceArtifactId: statement.sourceArtifactId, sourceRangeMs: statement.rangeMs, preservedText: statement.text, ...overrides } }

const persistedStoryPlan = (() => {
  const sourceRanges = fixtures.map((statement) => ({ id: `range-${statement.id}`, artifactId: statement.sourceArtifactId, startMs: statement.rangeMs[0], endMs: statement.rangeMs[1], rightsRef: 'rights-master' }))
  const sourceCandidates = fixtures.map((statement, index) => ({ id: `candidate-${statement.id}`, sourceRangeId: `range-${statement.id}`, purpose: statement.kind === 'fact' ? 'context' : statement.kind === 'testimony' ? 'proof' : 'argument', rank: index + 1 }))
  const blocks = fixtures.map((statement) => ({ ...block(statement), sourceCandidateIds: [`candidate-${statement.id}`], sourceRangeId: `range-${statement.id}` }))
  const desiredActionRef = createDesiredActionReference({ schemaVersion: 1, kind: 'learn', destination: { type: 'url', value: 'https://example.com/safety' }, verbalCta: 'Learn more', visualCta: 'Learn more', disclosures: [] })
  const claims = fixtures.flatMap((statement) => statement.claims.map((claim) => ({ id: claim.id, text: claim.text, qualifierIds: [], proofContextIds: [] })))
  const plan = createStoryPlan({
    id: 'story-plan-safety', workspaceId: 'workspace-safety', projectId: 'project-safety', projectVersionId: 'project-version-safety', objective: 'sale', desiredActionRef,
    treatmentPlanRef: { id: 'treatment-plan-safety', schemaVersion: 3, contentHash: '9'.repeat(64) }, targetDurationMs: { min: 6_000, max: 12_000 },
    acts: [{ id: 'development', role: 'development', blockIds: fixtures.map((statement) => statement.storyBlockId) }], blocks, sourceRanges, sourceCandidates,
    qualifiers: [], claims, proofContexts: [{ id: 'proof-context', claimIds: [], sourceCandidateIds: [`candidate-${fixtures[0].id}`], attribution: 'Source evidence' }],
    createdBy: { type: 'api-client', id: 'client-safety' }, createdAt: '2026-08-13T12:00:00.000Z',
  })
  return plan
})()

test('T-FR-063 structures claims, qualifiers, negation, causality, deadlines and proof dependencies', () => {
  assert.match(context.contextHash, /^[a-f0-9]{64}$/)
  const promise = context.statements.find((statement) => statement.kind === 'promise')
  assert.deepEqual(promise.claims.map((claim) => claim.id), ['claim-promise'])
  assert.deepEqual(promise.qualifiers.map((item) => item.text), ['pode'])
  assert.deepEqual(promise.deadlines.map((item) => item.text), ['em até 30 dias'])
  assert.equal(promise.dependencies[0].kind, 'proof')
  const comparison = context.statements.find((statement) => statement.kind === 'comparison')
  assert.deepEqual(comparison.negations.map((item) => item.text), ['Não'])
  assert.deepEqual(comparison.causalMarkers.map((item) => item.text), ['por acaso'])
})

test('T-FR-063 blocks promise trim and localizes source evidence with typed restore action', () => {
  const result = validateNarrativeEdit(context, [preserved('statement-proof'), preserved('statement-promise', { preservedText: 'melhorar a clareza' })])
  assert.equal(result.safe, false)
  assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set(['QUALIFIER_REMOVED', 'DEADLINE_REMOVED']))
  assert.equal(result.issues.every((issue) => issue.schemaVersion === 'narrative-quality-issue/v1' && issue.rangeMs[1] > issue.rangeMs[0] && issue.evidence[0].rangeMs && issue.restoreAction.kind === 'restore-token'), true)
})

test('T-FR-063 blocks testimony attribution and removed context before montage', () => {
  const result = validateNarrativeEdit(context, [preserved('statement-testimony', { speakerId: 'speaker-expert' })])
  assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set(['ATTRIBUTION_CHANGED', 'DEPENDENCY_REMOVED']))
  assert.deepEqual(result.issues.find((issue) => issue.code === 'ATTRIBUTION_CHANGED').restoreAction.refs, ['speaker-client'])
})

test('T-FR-063 blocks comparison negation, causality and context reordering', () => {
  const result = validateNarrativeEdit(context, [preserved('statement-comparison', { preservedText: 'É mais rápido que o processo anterior.' }), preserved('statement-context')])
  assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set(['NEGATION_REMOVED', 'CAUSALITY_CHANGED', 'DEPENDENCY_REORDERED']))
})

test('T-FR-063 blocks fabricated source text and ranges that exclude retained critical evidence', () => {
  const fabricated = validateNarrativeEdit(context, [preserved('statement-proof'), preserved('statement-promise', { preservedText: 'O método garante melhorar a clareza em até 30 dias.' })])
  assert.equal(fabricated.issues.some((issue) => issue.code === 'SOURCE_TEXT_CHANGED'), true)
  const excludedRange = validateNarrativeEdit(context, [preserved('statement-proof'), preserved('statement-promise', { sourceRangeMs: [4_700, 7_000] })])
  const qualifier = excludedRange.issues.find((issue) => issue.code === 'QUALIFIER_REMOVED')
  assert.deepEqual(qualifier.rangeMs, [4_400, 4_700])
  assert.deepEqual(qualifier.restoreAction.sourceRangeMs, [4_400, 4_700])
})

test('T-FR-063 fails closed for unknown/duplicate/source drift and accepts safe composition', () => {
  const drift = validateNarrativeEdit(context, [preserved('statement-context'), preserved('statement-context'), { statementId: 'statement-unknown', speakerId: 'speaker-client', sourceArtifactId: 'artifact-master', sourceRangeMs: [0, 10], preservedText: 'unknown' }, preserved('statement-proof', { sourceRangeMs: [1_900, 4_000] })])
  assert.deepEqual(new Set(drift.issues.map((issue) => issue.code)), new Set(['STATEMENT_DUPLICATED', 'UNKNOWN_STATEMENT', 'SOURCE_RANGE_CHANGED']))
  const safe = validateNarrativeEdit(context, [preserved('statement-context'), preserved('statement-proof'), preserved('statement-promise'), preserved('statement-testimony'), preserved('statement-comparison')])
  assert.equal(safe.safe, true); assert.deepEqual(safe.issues, [])
})

test('T-FR-063 rejects evidence or StoryPlan bindings that are not exact', () => {
  assert.throws(() => createNarrativeSafetyContext({ storyPlanId: 'story-plan-safety', storyPlan, statements: [{ ...NARRATIVE_POLICY_FIXTURES.promise, qualifiers: [{ text: 'garantido', rangeMs: [4_400, 4_700] }] }, ...fixtures.filter((item) => item.id !== 'statement-promise')] }), /verbatim/)
  assert.throws(() => createNarrativeSafetyContext({ storyPlanId: 'story-plan-safety', storyPlan: { ...storyPlan, blocks: storyPlan.blocks.filter((item) => item.id !== 'block-promise') }, statements: fixtures }), /missing StoryBlock/)
  assert.throws(() => createNarrativeSafetyContext({ storyPlanId: 'story-plan-safety', storyPlan, statements: [{ ...NARRATIVE_POLICY_FIXTURES.promise, dependencies: [{ statementId: 'statement-proof', kind: 'invented', requiredOrder: 'before' }] }, ...fixtures.filter((item) => item.id !== 'statement-promise')] }), /dependency is invalid/)
  assert.throws(() => validateNarrativeEdit({ ...context, contextHash: '0'.repeat(64) }, [preserved('statement-context')]), /context integrity/)
})

test('T-FR-063 application preflight binds exact ProjectVersion, StoryPlan and base hash without persistence', async () => {
  let loads = 0
  const repository = { async load() { loads += 1; return { projectVersionId: 'project-version-safety', projectVersionBaseHash: 'a'.repeat(64), storyPlanId: 'story-plan-safety', storySnapshotHash: 'b'.repeat(64), storyPlan, context } } }
  const auditContext = createExternalAuditContext({ clientId: 'client-safety', credentialId: 'credential-safety', workspaceId: 'workspace-safety', environment: 'production' })
  const actor = { clientId: 'client-safety', credentialId: 'credential-safety', workspaceId: 'workspace-safety', environment: 'production', scopes: new Set(['projects:read']), authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
  const edit = [preserved('statement-context'), preserved('statement-proof'), preserved('statement-promise'), preserved('statement-testimony'), preserved('statement-comparison')]
  const service = preflightNarrativeSafetyService({ repository })
  const result = await service({ workspaceId: 'workspace-safety', projectId: 'project-safety', projectVersionId: 'project-version-safety', expectedBaseHash: 'a'.repeat(64), storyPlanId: 'story-plan-safety', edit, actor })
  assert.equal(result.safe, true); assert.match(result.preflightHash, /^[a-f0-9]{64}$/); assert.equal(loads, 1)
  await assert.rejects(() => service({ workspaceId: 'workspace-safety', projectId: 'project-safety', projectVersionId: 'project-version-safety', expectedBaseHash: 'c'.repeat(64), storyPlanId: 'story-plan-safety', edit, actor }), /stale/)
  await assert.rejects(() => service({ workspaceId: 'workspace-other', projectId: 'project-safety', projectVersionId: 'project-version-safety', expectedBaseHash: 'a'.repeat(64), storyPlanId: 'story-plan-safety', edit, actor }), /does not belong/)
  await assert.rejects(() => service({ workspaceId: 'workspace-safety', projectId: 'project-safety', projectVersionId: 'project-version-safety', expectedBaseHash: 'a'.repeat(64), storyPlanId: 'story-plan-safety', edit, actor: { ...actor, scopes: new Set([]) } }), /required scope/)
})

test('T-FR-063 public request is exact and accepts only localized source-preserving edit items', () => {
  const body = { projectVersionId: 'project-version-safety', expectedBaseHash: 'a'.repeat(64), storyPlanId: 'story-plan-safety', edit: [preserved('statement-context')] }
  assert.deepEqual(parseNarrativeSafetyPreflightBody(body), body)
  assert.throws(() => parseNarrativeSafetyPreflightBody({ ...body, statements: fixtures }), /unknown fields/)
  assert.throws(() => parseNarrativeSafetyPreflightBody({ ...body, edit: [{ ...body.edit[0], trusted: true }] }), /unknown fields/)
})

test('T-FR-063 Prisma adapter reads only the exact immutable StoryPlan snapshot and verifies canonical bytes', async () => {
  const stored = { schemaVersion: 'narrative-safety-story-snapshot/v1', storyPlan: persistedStoryPlan, narrativeSafety: context }
  const contentJson = stableSerialize(stored)
  const { id: _id, workspaceId: _workspaceId, projectId: _projectId, projectVersionId: _projectVersionId, storyHash: _storyHash, createdBy: _createdBy, createdAt: _createdAt, ...storyCore } = persistedStoryPlan
  const storyRow = { id: persistedStoryPlan.id, workspaceId: persistedStoryPlan.workspaceId, projectId: persistedStoryPlan.projectId, projectVersionId: persistedStoryPlan.projectVersionId, schemaVersion: 3, treatmentPlanId: persistedStoryPlan.treatmentPlanRef.id, treatmentSchemaVersion: persistedStoryPlan.treatmentPlanRef.schemaVersion, treatmentContentHash: persistedStoryPlan.treatmentPlanRef.contentHash, storyJson: stableSerialize(storyCore), storyHash: persistedStoryPlan.storyHash, createdByClientId: persistedStoryPlan.createdBy.id, createdAt: new Date(persistedStoryPlan.createdAt) }
  let receivedWhere
  const client = { v2ProjectVersion: { async findFirst(query) { receivedWhere = query.where; return { id: 'project-version-safety', baseHash: 'a'.repeat(64), storySnapshot: { kind: 'story', schemaVersion: 1, contentJson, contentHash: calculateCanonicalHash(stored) } } } }, v2StoryPlan: { async findFirst() { return storyRow } } }
  const repository = new PrismaNarrativeSafetyRepository(client)
  const loaded = await repository.load({ workspaceId: 'workspace-safety', projectId: 'project-safety', projectVersionId: 'project-version-safety', storyPlanId: 'story-plan-safety' })
  assert.deepEqual(receivedWhere, { id: 'project-version-safety', projectId: 'project-safety', workspaceId: 'workspace-safety', storySnapshotId: { not: null } })
  assert.equal(loaded.context.contextHash, context.contextHash)
  assert.equal(loaded.storySnapshotHash, calculateCanonicalHash(stored))
  const corrupt = new PrismaNarrativeSafetyRepository({ v2ProjectVersion: { async findFirst() { return { id: 'project-version-safety', baseHash: 'a'.repeat(64), storySnapshot: { kind: 'story', schemaVersion: 1, contentJson: contentJson.replace('pode', 'deve'), contentHash: calculateCanonicalHash(stored) } } } }, v2StoryPlan: { async findFirst() { return storyRow } } })
  await assert.rejects(() => corrupt.load({ workspaceId: 'workspace-safety', projectId: 'project-safety', projectVersionId: 'project-version-safety', storyPlanId: 'story-plan-safety' }), /integrity validation/)
  const staleStory = new PrismaNarrativeSafetyRepository({ v2ProjectVersion: client.v2ProjectVersion, v2StoryPlan: { async findFirst() { return { ...storyRow, storyHash: '0'.repeat(64) } } } })
  await assert.rejects(() => staleStory.load({ workspaceId: 'workspace-safety', projectId: 'project-safety', projectVersionId: 'project-version-safety', storyPlanId: 'story-plan-safety' }), /StoryPlan failed integrity/)
})
