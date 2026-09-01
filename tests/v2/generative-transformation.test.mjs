import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyProviderCallbackReplay,
  signProviderCallback,
  verifyProviderCallback,
} from '../../src/v2/domain/provider-job-callback.ts'
import {
  closeProviderJobMcpSession,
  createProviderJobRetryPolicy,
  createProviderJobTransportState,
  providerJobBackoffMs,
  providerJobNextAttemptMs,
  scheduleProviderJobAttempt,
} from '../../src/v2/domain/provider-job-transport.ts'

import {
  TRANSFORMATION_GOLDENS,
  TRANSFORMATION_MODE_CONTRACTS,
  TRANSFORMATION_MODE_REGISTRY_HASH,
  TRANSFORMATION_MODES,
  annotationToMask,
  calculateNovelty,
  chooseFallback,
  createTransformationBrief,
  createTransformationProviderDefinition,
  createTransformationProviderHealth,
  critiqueTransformation,
  planAdvancedCleanup,
  projectTransformationProviderInput,
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

test('T-FR-113 callback verification runs over the exact bytes and survives restarts', () => {
  // The shallow model this replaces guarded replay with a `Set<string>` held in
  // memory. It is gone; verification is now a pure decision over raw bytes and
  // the consumed-event record lives in PostgreSQL, so a restart no longer makes
  // every replayed callback look new. Persistence is proved in
  // tests/v2/prisma-transformation-jobs.integration.mjs; this covers the decision.
  const secret = new Uint8Array(32).fill(7)
  const now = new Date('2029-03-01T10:00:00.000Z')
  const job = { id: 'provider-job-1', workspaceId: 'workspace-1', providerId: 'controlled-v2v', providerJobId: 'remote-77', terminal: false }
  const rawBody = Buffer.from(JSON.stringify({ providerJobId: 'remote-77', status: 'completed', occurredAt: '2029-03-01T09:59:58.000Z' }), 'utf8')
  const headers = signProviderCallback({ secret, eventId: 'event-1', rawBody, timestamp: now })

  const accepted = verifyProviderCallback({ secret, rawBody, headers, job, now })
  assert.equal(accepted.outcome, 'accepted')
  assert.equal(accepted.event.providerJobId, 'remote-77')
  assert.equal(accepted.event.status, 'completed')

  // Same bytes, same id: a duplicate delivery, which providers do routinely.
  const duplicate = verifyProviderCallback({ secret, rawBody, headers, job, now })
  assert.equal(classifyProviderCallbackReplay({ stored: accepted.event, incoming: duplicate.event }).outcome, 'duplicate')

  // Same event id, different bytes: the id is being reused to say something new.
  const reusedIdBody = Buffer.from(JSON.stringify({ providerJobId: 'remote-77', status: 'failed', occurredAt: '2029-03-01T09:59:59.000Z' }), 'utf8')
  const replay = verifyProviderCallback({
    secret, rawBody: reusedIdBody,
    headers: signProviderCallback({ secret, eventId: 'event-1', rawBody: reusedIdBody, timestamp: now }),
    job, now,
  })
  assert.equal(classifyProviderCallbackReplay({ stored: accepted.event, incoming: replay.event }).outcome, 'rejected')

  // Every rejection is a decision, never a thrown surprise, and never mutates.
  assert.equal(verifyProviderCallback({ secret: new Uint8Array(32).fill(9), rawBody, headers, job, now }).reason, 'signature-invalid')
  assert.equal(verifyProviderCallback({ secret, rawBody, headers, job, now: new Date('2029-03-01T11:00:00.000Z') }).reason, 'timestamp-outside-window')
  assert.equal(verifyProviderCallback({ secret, rawBody, headers, job: { ...job, providerJobId: 'other' }, now }).reason, 'correlation-mismatch')
  assert.equal(verifyProviderCallback({ secret, rawBody, headers, job: { ...job, terminal: true }, now }).reason, 'job-terminal')
  // A body whose signature covers different bytes than those presented.
  assert.equal(verifyProviderCallback({ secret, rawBody: reusedIdBody, headers, job, now }).reason, 'signature-invalid')
})

test('T-FR-113 the transport schedule is deterministic and honours Retry-After', () => {
  const policy = createProviderJobRetryPolicy({ maxAttempts: 5, initialBackoffMs: 1_000, maximumBackoffMs: 20_000, backoffMultiplier: 2 })
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((attempt) => providerJobBackoffMs(policy, attempt)), [1_000, 2_000, 4_000, 8_000, 16_000, 20_000])
  // The provider's Retry-After wins whenever it is longer: honouring a shorter
  // delay than the provider asked for is how a 429 becomes a ban.
  assert.equal(providerJobNextAttemptMs({ policy, attempt: 0, retryAfterMs: 9_000 }), 9_000)
  assert.equal(providerJobNextAttemptMs({ policy, attempt: 3, retryAfterMs: 500 }), 8_000)

  // A transport can only carry a provider whose completion mode allows it.
  const base = { workspaceId: 'workspace-1', projectId: 'project-1', jobId: 'provider-job-1', deadlineAt: '2029-03-01T11:00:00.000Z', createdAt: '2029-03-01T10:00:00.000Z' }
  assert.throws(() => createProviderJobTransportState({ ...base, transport: 'webhook', completion: 'synchronous' }), /cannot carry/)
  assert.throws(() => createProviderJobTransportState({ ...base, transport: 'polling', completion: 'webhook' }), /cannot carry/)

  // An MCP session going away is bookkeeping, not a failure: the durable job,
  // its provider job id and its schedule belong to Apollo, not to the session.
  const mcp = createProviderJobTransportState({ ...base, transport: 'mcp', completion: 'polling', mcpSessionId: 'mcp-session-1' })
  const closed = closeProviderJobMcpSession({ state: mcp, occurredAt: '2029-03-01T10:05:00.000Z' })
  assert.equal(closed.mcpSessionClosedAt, '2029-03-01T10:05:00.000Z')
  assert.equal(closed.waitKind, mcp.waitKind)
  assert.equal(closed.nextAttemptAt, mcp.nextAttemptAt)

  // A scheduled attempt never runs past the deadline.
  const polling = createProviderJobTransportState({ ...base, transport: 'polling', completion: 'polling' })
  const parked = scheduleProviderJobAttempt({ state: polling, waitKind: 'poll', occurredAt: '2029-03-01T10:59:59.000Z', retryAfterMs: 600_000 })
  assert.equal(parked.nextAttemptAt, base.deadlineAt)
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
