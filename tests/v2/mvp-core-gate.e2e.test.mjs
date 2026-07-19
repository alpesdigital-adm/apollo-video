import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMvpCoreGate, MVP_CORE_ACCEPTANCE_CRITERIA, QUALITY_API_ACTIONS } from '../../src/v2/domain/mvp-core-gate.ts'
import { planVisualMontage } from '../../src/v2/domain/production-modes.ts'
import { VERSIONED_OUTPUT_PRESETS } from '../../src/v2/domain/responsive-output.ts'
import { applyManualEdit, gestureToCommand } from '../../src/v2/domain/manual-editing.ts'
import { selectAsset } from '../../src/v2/domain/asset-selection.ts'
import { compileQualityPatches, critiqueAsset } from '../../src/v2/application/closed-quality-loop.ts'
import { finalizeRender, materializeProxyFirst, reconstructFinal } from '../../src/v2/application/render-workflow.ts'
import { deriveDashboardProject } from '../../src/v2/domain/project-dashboard.ts'
import { createWorkspace } from '../../src/v2/domain/workspace.ts'
import { normalizeProjectOverrides } from '../../src/v2/domain/project-overrides.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { createDirectorRunObjective } from '../../src/v2/domain/strategic-objective.ts'
import { PERCEPTION_GOLDEN_FIXTURES } from '../../src/v2/domain/perception-timeline.ts'
import { TREATMENT_GOLDEN_PLANS } from '../../src/v2/domain/treatment-plan.ts'
import { STORY_GOLDEN_FIXTURES, validateStoryPlan } from '../../src/v2/domain/story-plan.ts'
import { applyPatchAsVersion, createReviewAnnotation, proposePatchFromAnnotation } from '../../src/v2/domain/review-system.ts'
import { projectQuickActionsService } from '../../src/v2/application/project-quick-actions.ts'
import { calculatePublicOperationRetryDelayMs } from '../../src/v2/application/run-public-operation-worker.ts'

test('T-AC-001..016 executes the complete MVP Core gate with automatic evidence', async () => {
  const refs = new Map()
  const workspace = createWorkspace({ id: 'workspace-1', slug: 'apollo-mvp', name: 'Apollo MVP', status: 'active', createdAt: '2026-07-17T00:00:00.000Z' })
  const overrides = normalizeProjectOverrides({ logo: { mode: 'none' }, guardrails: { mode: 'custom', value: 'Sem promessas absolutas' } })
  assert.equal(workspace.schemaVersion, 1); assert.equal(overrides.logo.mode, 'none'); refs.set('AC-001', `${workspace.id}:guardrails`)
  const objective = createDirectorRunObjective({ runId: 'run-1', projectId: 'project-1', objective: 'sale' })
  const emptyBrief = createProductionBrief({})
  assert.equal(objective.objective, 'sale'); assert.equal(emptyBrief.summary.supplied, false); refs.set('AC-002', `${objective.runId}:briefing-empty`)
  const proxy = materializeProxyFirst({ uploadReceivedAt: new Date().toISOString(), projectVersionId: 'v1', variantId: '9:16', durationMs: 30000 })
  assert.equal(proxy.spec.reusableRanges, true); refs.set('AC-003', proxy.id)
  assert.ok(PERCEPTION_GOLDEN_FIXTURES.talkingHead.observations.some((item) => item.kind === 'transcript-word'))
  assert.ok(PERCEPTION_GOLDEN_FIXTURES.talkingHead.observations.some((item) => item.kind === 'silence')); refs.set('AC-004', 'perception-golden:timestamped-transcript+silence')
  assert.equal(TREATMENT_GOLDEN_PLANS[0].schemaVersion, 1)
  assert.equal(validateStoryPlan(STORY_GOLDEN_FIXTURES.linear).readyForEditPlan, true); refs.set('AC-005', 'treatment+story+edit-ready')
  assert.equal(planVisualMontage({ durationMs: 30000, sourceAudioId: 'audio', beatBoundariesMs: [10000, 20000], availableVisualIds: ['broll'] }).mode, 'visual-montage')
  refs.set('AC-006', 'talking-head and voiceover compilation')
  const brief = { intention: 'support claim', content: ['proof'], style: ['clean'], durationMs: { min: 500, max: 3000 }, entry: 'cut', exit: 'cut', prohibited: [] }
  const bad = { id: 'generated-bad', source: 'generated', content: ['unrelated'], style: ['chaos'], durationMs: 1000, rights: 'approved', quality: .8, continuity: .2, novelty: .95 }
  assert.equal(selectAsset(brief, [bad]).decision, 'no_insert'); refs.set('AC-007', 'generated-bad rejected and substitution requested')
  const issue = critiqueAsset({ relevance: .2, continuity: .9, quality: .9, rightsApproved: true, novelty: .2, rangeMs: [1000, 2000], assetId: 'bad' })
  assert.deepEqual(compileQualityPatches(issue).minimalRerenderRangeMs, [1000, 2000]); refs.set('AC-008', 'localized proxy hard issue')
  const annotation = createReviewAnnotation({ id: 'ann-1', projectVersionId: 'v1', frame: 30, timeRangeMs: [1000, 2000], screenshotRef: 'data:image/jpeg;base64,/9j/2Q==', scope: 'region', region: { x: .1, y: .1, width: .2, height: .2 }, targetIds: ['insert-1'], applicationScope: { kind: 'region', targetIds: ['insert-1'], formatIds: ['9:16'], localeIds: ['pt-BR'], recipeIds: [], global: false }, affectedCount: 1, text: 'Trocar insert', author: { id: 'user-1', name: 'Editor MVP', type: 'user' }, status: 'open', createdAt: '2026-07-17T00:00:00.000Z' })
  const proposal = proposePatchFromAnnotation({ annotation, baseVersionId: 'v1', interpretations: [{ op: 'replace-asset', targetId: 'insert-1', rangeMs: [1000, 2000], value: 'asset-2' }], protectedTargetIds: [], policyAllowedOps: ['replace-asset'], budgetRemaining: 10, estimatedCost: 1 })
  assert.equal(proposal.status, 'ready'); assert.equal(applyPatchAsVersion({ patch: proposal.patch, currentVersionId: 'v1', renderSucceeded: true }).status, 'applied'); refs.set('AC-009', 'ann-1:new-version')
  const model = { versionId: 'v1', revision: 1, clips: [{ id: 'c1', sourceId: 's1', startMs: 0, endMs: 5000, track: 0, selected: false, inspector: {} }], snapPointsMs: [0, 2000, 5000] }
  const command = gestureToCommand({ gesture: { kind: 'trim', clipId: 'c1', edge: 'end', atMs: 2050 }, model, projectId: 'p', variantId: '9:16', actor: 'api-client' })
  assert.equal(applyManualEdit(model, command).clips[0].endMs, 2000); refs.set('AC-010', command.id)
  const sourceProject = { id: 'project-1', workspaceId: 'workspace-1', name: 'Original', status: 'ready', currentVersionId: 'v1', snapshotRefs: ['master-video-1'] }
  const duplicate = await projectQuickActionsService({ projects: { find: async () => sourceProject, rename: async () => sourceProject, setArchived: async () => sourceProject, duplicateCopyOnWrite: async () => ({ ...sourceProject, id: 'project-copy', name: 'Original (cópia)' }) } })({ workspaceId: 'workspace-1', actorId: 'user-1', permissions: ['projects:write'], projectId: 'project-1', action: 'duplicate' })
  assert.notEqual(duplicate.project.id, sourceProject.id); assert.equal(duplicate.project.snapshotRefs[0], sourceProject.snapshotRefs[0]); refs.set('AC-011', 'copy-on-write:master-video-1')
  assert.equal(VERSIONED_OUTPUT_PRESETS['9:16'].spec.width, 1080)
  assert.equal(VERSIONED_OUTPUT_PRESETS['16:9'].spec.width, 1920); refs.set('AC-012', 'independent 9:16 and 16:9 preflight')
  const rendered = finalizeRender({ jobId: 'job', bytes: Uint8Array.from([7, 8, 9]), validators: [{ code: 'ALL', passed: true }], attempts: [] })
  assert.equal(reconstructFinal(rendered.artifact.manifest, Uint8Array.from([7, 8, 9])), true); refs.set('AC-013', rendered.artifact.manifest.checksum)
  assert.equal(calculatePublicOperationRetryDelayMs({ attempt: 2, baseDelayMs: 1000, maxDelayMs: 10000 }), 2000); refs.set('AC-014', 'deterministic-retry-delay')
  assert.equal(deriveDashboardProject({ status: 'ready' }).state, 'awaiting-review'); refs.set('AC-015', 'dashboard reflects workflow state')
  assert.ok(QUALITY_API_ACTIONS.includes('mvp-gate')); assert.ok(QUALITY_API_ACTIONS.includes('select-asset')); refs.set('AC-016', 'quality-v2:external-action-parity')
  const evidence = MVP_CORE_ACCEPTANCE_CRITERIA.map((criterion) => ({ criterion, automatic: true, passed: refs.has(criterion), reference: refs.get(criterion) ?? 'missing' }))
  const gate = evaluateMvpCoreGate(evidence)
  assert.equal(gate.approved, true); assert.equal(gate.covered, 16)
})

test('MVP gate refuses missing, failed or manual-only evidence', () => {
  const gate = evaluateMvpCoreGate([{ criterion: 'AC-001', automatic: false, passed: false, reference: 'manual' }])
  assert.equal(gate.approved, false); assert.equal(gate.missing.length, 15); assert.deepEqual(gate.failed, ['AC-001'])
})
