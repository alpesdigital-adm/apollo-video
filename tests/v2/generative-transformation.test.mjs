import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  TRANSFORMATION_GOLDENS,
  TRANSFORMATION_MODE_CONTRACTS,
  TRANSFORMATION_MODE_REGISTRY_HASH,
  TRANSFORMATION_MODES,
  annotationToMask,
  applyProviderCallback,
  calculateNovelty,
  chooseFallback,
  createProviderJob,
  createTransformationBrief,
  createTransformationProviderDefinition,
  createTransformationProviderHealth,
  critiqueTransformation,
  planAdvancedCleanup,
  projectTransformationProviderInput,
  resumeProviderJob,
  routeTransformationProvider,
  transitionTransformationProviderHealth,
} from '../../src/v2/domain/generative-transformation.ts'

function provider(overrides = {}) {
  return createTransformationProviderDefinition({
    id: overrides.id ?? 'provider-primary', workspaceId: 'workspace-golden', displayName: overrides.displayName ?? 'Primary provider', adapterId: overrides.adapterId ?? 'adapter-primary', adapterVersion: '1.0.0', transport: 'api', credentialRef: overrides.credentialRef ?? 'secret/provider-primary', enabled: overrides.enabled ?? true,
    capabilities: [{ id: overrides.capabilityId ?? 'capability-relight', operation: overrides.operation ?? 'relight', capabilityVersion: '1.0.0', modes: overrides.modes ?? ['relight'], regions: overrides.regions ?? ['br'], maximumDurationFrames: overrides.maximumDurationFrames ?? 900, maximumWidth: 3840, maximumHeight: 2160, supportsAudio: true, price: { currency: 'BRL', fixedMinorUnits: overrides.fixedMinorUnits ?? 10, perSecondMinorUnits: overrides.perSecondMinorUnits ?? 5 }, qualityScoreBps: overrides.qualityScoreBps ?? 9_000, dataRetention: 'transient' }],
    createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z',
  })
}

function health(providerId, overrides = {}) {
  return createTransformationProviderHealth({ providerId, workspaceId: 'workspace-golden', status: overrides.status ?? 'healthy', circuitState: overrides.circuitState ?? 'closed', consecutiveFailures: overrides.consecutiveFailures ?? 0, observedLatencyMs: 120, observedAt: '2026-08-30T12:01:00.000Z', ...(overrides.cooldownUntil ? { cooldownUntil: overrides.cooldownUntil } : {}) })
}

test('T-FR-110 creates immutable frame-first briefs and detects invalid invariants', () => {
  const brief = TRANSFORMATION_GOLDENS.medieval
  assert.equal(brief.durationFrames, 180)
  assert.equal(brief.preserve.includes('identity'), true)
  assert.equal(brief.fallbackLadder.at(-1), 'source-unchanged')
  assert.match(brief.briefHash, /^[a-f0-9]{64}$/)
  assert.throws(() => createTransformationBrief({ ...brief, allowedChanges: ['identity'] }), /disjoint/)
  assert.throws(() => createTransformationBrief({ ...brief, sourceRange: { startFrame: 30, endFrame: 30 } }), /half-open/)
})
test('T-FR-110 provider projection excludes project, story, rights and identity references', () => {
  const projected = projectTransformationProviderInput(TRANSFORMATION_GOLDENS.medieval)
  const json = JSON.stringify(projected)
  for (const forbidden of ['workspace-golden', 'project-golden', 'story-plan-medieval', 'rights-medieval', 'identity-medieval']) assert.equal(json.includes(forbidden), false)
  assert.equal(projected.sourceArtifactHash, '6'.repeat(64))
})

test('T-FR-111 declares an exhaustive provider-independent registry for six modes', () => {
  assert.equal(TRANSFORMATION_MODES.length, 6)
  assert.match(TRANSFORMATION_MODE_REGISTRY_HASH, /^[a-f0-9]{64}$/)
  for (const mode of TRANSFORMATION_MODES) {
    const contract = TRANSFORMATION_MODE_CONTRACTS[mode]
    assert.equal(contract.mode, mode)
    assert.equal(contract.defaultFallbackLadder.at(-1), 'source-unchanged')
    assert.ok(contract.requiredInputs.length > 0)
    assert.equal(Object.hasOwn(contract, 'provider'), false)
  }
})

test('T-FR-112 routing records discarded reasons without mutating the brief', () => {
  const good = provider()
  const unavailable = provider({ id: 'provider-cheap', adapterId: 'adapter-cheap', credentialRef: 'secret/provider-cheap', capabilityId: 'capability-cheap', qualityScoreBps: 9_800, fixedMinorUnits: 0 })
  const brief = TRANSFORMATION_GOLDENS.simple
  const before = JSON.stringify(brief)
  const routed = routeTransformationProvider({ brief, providers: [unavailable, good], health: [health(unavailable.id, { status: 'unavailable' }), health(good.id)], policy: { region: 'br', maximumCostMinorUnits: 200, minimumQualityScoreBps: 8_000, output: { width: 1080, height: 1920, includeAudio: true, fps: 30 } }, createdAt: '2026-08-30T12:02:00.000Z' })
  assert.equal(routed.selectedProviderId, good.id)
  assert.ok(routed.candidates.find((item) => item.providerId === unavailable.id).reasons.includes('health-unavailable'))
  assert.equal(JSON.stringify(brief), before)
  assert.match(routed.selectionHash, /^[a-f0-9]{64}$/)
})

test('T-FR-112 circuit breaker opens deterministically without deleting provider state', () => {
  const current = health('provider-primary', { status: 'degraded', consecutiveFailures: 1 })
  const opened = transitionTransformationProviderHealth({ current, outcome: 'failure', observedAt: '2026-08-30T12:03:00.000Z', failureThreshold: 2, cooldownMs: 60_000 })
  assert.equal(opened.circuitState, 'open')
  assert.equal(opened.cooldownUntil, '2026-08-30T12:04:00.000Z')
  const recovered = transitionTransformationProviderHealth({ current: opened, outcome: 'success', observedAt: '2026-08-30T12:05:00.000Z', failureThreshold: 2, cooldownMs: 60_000 })
  assert.equal(recovered.circuitState, 'closed')
})

test('T-FR-113 durable jobs resume and reject forged or replayed callbacks', () => {
  let job = createProviderJob(TRANSFORMATION_GOLDENS.simple, 'webhook')
  job = resumeProviderJob(job)
  const secret = 'secret', nonce = 'n1', signature = createHash('sha256').update(`${job.correlationId}:${nonce}:${secret}`).digest('hex'), consumed = new Set()
  const completed = applyProviderCallback(job, { correlationId: job.correlationId, artifact: 'result.mp4', signature, nonce }, secret, consumed)
  assert.equal(completed.job.state, 'completed')
  assert.equal(applyProviderCallback(job, { correlationId: job.correlationId, artifact: 'result.mp4', signature, nonce }, secret, consumed).duplicate, true)
  assert.throws(() => applyProviderCallback(job, { correlationId: job.correlationId, signature: '00', nonce: 'n2' }, secret, consumed))
})

test('T-FR-114 through T-FR-116 preserve novelty fallback and protected-change behavior', () => {
  const novelty = calculateNovelty({ transformations: [{ group: 'zoom', novelty: .2, durationMs: 1000, atMs: 0 }, { group: 'zoom', novelty: .8, durationMs: 2000, atMs: 500 }, { group: 'relight', novelty: .4, durationMs: 1000, atMs: 3000 }], windowMs: 1000, limit: 1 })
  assert.equal(novelty.treatment, 'balanced')
  assert.equal(novelty.rejected.length, 1)
  const fallback = chooseFallback(TRANSFORMATION_GOLDENS.medieval, [{ mode: 'video-to-video', valid: false, intentScore: .9, artifact: 'bad.mp4', cost: 4 }, { mode: 'actor-composite', valid: true, intentScore: .8, artifact: 'good.mp4', cost: 2 }])
  assert.equal(fallback.applied, 'actor-composite')
  assert.equal(fallback.incurredCost, 6)
  const critic = critiqueTransformation(TRANSFORMATION_GOLDENS.medieval, { intent: .98, temporal: .96, artifacts: .02, risk: .05, changed: ['identity'], regionScores: [{ rangeMs: [2000, 3000], score: .6 }] })
  assert.equal(critic.passed, false)
  assert.equal(critic.issue.code, 'protected-content-changed')
})

test('T-FR-123 and T-FR-218 keep cleanup derivatives immutable and mask review explicit', () => {
  const mask = annotationToMask({ pixels: { x: 100, y: 50, width: 200, height: 100 }, canvas: { width: 1000, height: 500 }, rangeMs: [0, 2000], confidence: .9, format: '9:16' })
  assert.deepEqual(mask.normalized, { x: .1, y: .1, width: .2, height: .2 })
  const plan = planAdvancedCleanup({ mask, sourceId: 'source', operation: 'inpaint', qualityThreshold: .8, estimated: { quality: .9, cost: 4 }, alternatives: [{ method: 'crop', quality: .85, cost: 1 }] })
  assert.equal(plan.immutableSource, true)
  assert.equal(plan.chosen.cost, 1)
})
