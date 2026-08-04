import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext, materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { enqueueProjectDirectorRunService } from '../../src/v2/application/enqueue-project-director-run.ts'
import { runNextProjectDirectorOperationService } from '../../src/v2/application/run-project-director-operation-worker.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createProjectVersion } from '../../src/v2/domain/project-version.ts'
import { createDirectorRunInvalidations, parseDirectorRunImpact } from '../../src/v2/domain/director-run-impact.ts'
import {
  advancePublicOperationPhase,
  cancelPublicOperation,
  createQueuedPublicOperation,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'

const baseHash = 'a'.repeat(64)

function directorEnqueueActor(credentialId = 'credential-director-1') {
  const auditContext = createExternalAuditContext({
    clientId: 'client-1', credentialId, workspaceId: 'workspace-1', environment: 'production',
    delegatedUserId: 'user-director-enqueue-1', delegatedIdentityId: 'identity-director-enqueue-1',
    workspaceRole: 'director',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'ui-session',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function compiledEditorialPlan(selectedInsert = false) {
  const words = [
    ['Seja', 0, 8], ['bem-vindo.', 8, 24],
    ['Comunicar', 34, 48], ['bem', 48, 56], ['muda', 56, 66], ['resultados.', 66, 88],
    ['Esta', 112, 120], ['imersão', 120, 136], ['desenvolve', 136, 154], ['clareza.', 154, 174],
    ['Você', 208, 220], ['vai', 220, 228], ['praticar', 228, 244], ['com', 244, 252], ['confiança.', 252, 276],
  ].map(([text, timelineStartFrame, timelineEndFrame], index) => ({
    text,
    sourceStartSeconds: index < 6 ? timelineStartFrame / 30 : (timelineStartFrame + 120) / 30,
    sourceEndSeconds: index < 6 ? timelineEndFrame / 30 : (timelineEndFrame + 120) / 30,
    timelineStartFrame,
    timelineEndFrame,
  }))
  return Object.freeze({
    schemaVersion: 2,
    state: 'compiled',
    id: 'edit-plan-base-1',
    projectVersionId: 'project-version-4',
    storyPlanId: null,
    fps: 30,
    durationFrames: 300,
    sources: Object.freeze([{ id: 'source-1', artifactId: 'artifact-master-1', kind: 'video', durationSeconds: 14 }]),
    videoTracks: Object.freeze([{ id: 'track-base', kind: 'base-video', clips: Object.freeze([
      Object.freeze({ id: 'clip-1', sourceArtifactId: 'artifact-master-1', sourceInFrame: 0, sourceOutFrame: 100, timelineInFrame: 0, timelineOutFrame: 100, rate: 1 }),
      Object.freeze({
        id: 'clip-2',
        sourceArtifactId: selectedInsert ? 'artifact-selected-insert-1' : 'artifact-master-1',
        sourceInFrame: selectedInsert ? 0 : 160,
        sourceOutFrame: selectedInsert ? 100 : 260,
        timelineInFrame: 100,
        timelineOutFrame: 200,
        rate: 1,
        ...(selectedInsert ? {
          audioSourceArtifactId: 'artifact-master-1',
          audioSourceInFrame: 160,
          audioSourceOutFrame: 260,
        } : {}),
      }),
      Object.freeze({ id: 'clip-3', sourceArtifactId: 'artifact-master-1', sourceInFrame: 320, sourceOutFrame: 420, timelineInFrame: 200, timelineOutFrame: 300, rate: 1 }),
    ]) }]),
    overlayTracks: Object.freeze([]), subtitleTracks: Object.freeze([]), audioTracks: Object.freeze([]), effectTracks: Object.freeze([]),
    markers: Object.freeze([
      Object.freeze({ kind: 'editorial-cut', atFrame: 100, sourceStartSeconds: 3.333, sourceEndSeconds: 5.333, ruleIds: Object.freeze(['date-january-31', 'date-february-1']) }),
      Object.freeze({ kind: 'editorial-cut', atFrame: 200, sourceStartSeconds: 8.666, sourceEndSeconds: 10.666, ruleIds: Object.freeze(['duration-two-days']) }),
    ]),
    protectedElements: Object.freeze([]), localeVariantRefs: Object.freeze([]), formatVariantRefs: Object.freeze([]),
    lineageRefs: Object.freeze(['artifact-master-1']),
    editorial: Object.freeze({
      commandType: 'remove-spoken-content',
      exclusions: Object.freeze([
        Object.freeze({ sourceStartSeconds: 3.333, sourceEndSeconds: 5.333, ruleIds: Object.freeze(['date-january-31', 'date-february-1']), labels: Object.freeze(['31 de janeiro', '1 de fevereiro']), matchedText: '31 de janeiro e 1 de fevereiro' }),
        Object.freeze({ sourceStartSeconds: 8.666, sourceEndSeconds: 10.666, ruleIds: Object.freeze(['duration-two-days']), labels: Object.freeze(['dois dias']), matchedText: 'dois dias' }),
      ]),
      retainedSourceRanges: Object.freeze([
        Object.freeze({ sourceStartSeconds: 0, sourceEndSeconds: 3.333 }),
        Object.freeze({ sourceStartSeconds: 5.333, sourceEndSeconds: 8.666 }),
        Object.freeze({ sourceStartSeconds: 10.666, sourceEndSeconds: 14 }),
      ]),
    }),
    retimedTranscript: Object.freeze({ sourceTranscriptId: 'transcript-1', words: Object.freeze(words.map((word) => Object.freeze(word))) }),
    movementPolicy: Object.freeze({ automaticZoom: false, protectedOpeningFrames: 120 }),
    subtitlePolicy: Object.freeze({ faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 }),
    createdAt: '2026-07-18T20:00:00.000Z',
  })
}

class InMemoryDirectorRepository {
  constructor(options = {}) {
    this.selectedInsert = options.selectedInsert ?? false
    this.outputReferences = options.outputReferences ?? [
      { artifactId: 'artifact-proxy-4', kind: 'proxy', sourceVersionId: 'project-version-4', variantId: '9:16' },
      { artifactId: 'artifact-final-4', kind: 'final', sourceVersionId: 'project-version-4', variantId: '9:16' },
    ]
    this.currentVersion = createProjectVersion({
      id: 'project-version-4', workspaceId: 'workspace-1', projectId: 'project-1', sequence: 4,
      parentVersionId: 'project-version-3',
      snapshotRefs: { brief: 'snapshot-brief-1', editPlan: 'snapshot-edit-4', policies: 'snapshot-policy-1' },
      baseHash, createdBy: 'client-1', createdAt: '2026-07-18T20:00:00.000Z',
    })
    this.records = new Map()
  }

  async findIdempotentResult({ workspaceId, projectId, idempotencyKey }) {
    return this.records.get(`${workspaceId}:${projectId}:${idempotencyKey}`) ?? null
  }

  async readContext({ workspaceId, projectId }) {
    if (workspaceId !== 'workspace-1' || projectId !== 'project-1') return null
    return {
      workspaceId,
      project: { id: projectId, objective: 'discovery', format: '9:16', locale: 'pt-BR' },
      currentVersion: this.currentVersion,
      brief: { productionBrief: { ownerInput: { text: 'Tom direto, natural e sem efeitos gratuitos.' } } },
      policies: { automaticZoom: false, faceProtection: true },
      editPlan: compiledEditorialPlan(this.selectedInsert),
      currentDurationFrames: 300,
      proxyVariantId: '9:16',
      outputReferences: this.outputReferences,
      transcript: {
        id: 'transcript-1', sourceArtifactId: 'artifact-master-1', language: 'pt-BR',
        provider: 'groq', model: 'whisper-large-v3', transcriptHash: 'b'.repeat(64),
      },
    }
  }

  async commitOrReplay(bundle) {
    this.lastBundle = bundle
    const impact = parseDirectorRunImpact(bundle.command.payload.impact)
    const invalidations = createDirectorRunInvalidations({ impact, createdAt: bundle.command.createdAt })
    const result = Object.freeze({ run: bundle.run, command: bundle.command, version: bundle.version, impact, invalidations, replayed: false })
    this.records.set(`${bundle.command.workspaceId}:${bundle.command.projectId}:${bundle.command.idempotencyKey}`, {
      requestFingerprint: bundle.requestFingerprint,
      result,
    })
    this.currentVersion = bundle.version
    return result
  }
}

function fixture(options = {}) {
  const repository = new InMemoryDirectorRepository(options)
  const counters = new Map()
  let event = 0
  const service = runProjectDirectorService({
    repository,
    clock: () => new Date('2026-07-18T22:00:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
    createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
  })
  return { repository, service }
}

function request(overrides = {}) {
  return {
    workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'project-version-4', baseHash,
    actor: { type: 'api-client', id: 'client-1' }, idempotency: { key: 'director-first-pass' },
    reason: 'Planejar e criticar a composição completa.',
    ...overrides,
  }
}

test('Director V2 persists perception, treatment, story, edit plan and critic as one immutable version', async () => {
  const { repository, service } = fixture()
  const result = await service(request())
  const plan = result.run.editPlan

  assert.equal(result.replayed, false)
  assert.equal(result.command.type, 'run-director')
  assert.equal(result.command.payload.schemaVersion, 2)
  assert.equal(result.version.sequence, 5)
  assert.equal(result.version.parentVersionId, 'project-version-4')
  assert.equal(result.run.status, 'planned')
  assert.deepEqual(repository.lastBundle.snapshots.map((snapshot) => snapshot.kind), ['perception', 'treatment', 'story', 'edit-plan', 'quality-report'])
  assert.equal(result.run.perception.timeline.observations.length, compiledEditorialPlan().retimedTranscript.words.length)
  assert.equal(result.run.treatmentPlan.patternBreaks.allowed.includes('zoom'), false)
  assert.equal(result.run.storyPlan.blocks.length, 3)
  assert.equal(plan.videoTracks[0].clips.length, 3)
  assert.equal(plan.movementPolicy.automaticZoom, false)
  assert.equal(plan.movementPolicy.protectedOpeningFrames, 120)
  assert.equal(plan.effectTracks.length, 0)
  assert.equal(plan.transitions.length, 2)
  assert.equal(plan.transitions.every((transition) => transition.type === 'straight-cut' && transition.audioFadeMs === 24), true)
  const cues = plan.subtitleTracks.flatMap((track) => track.cues)
  assert.ok(cues.length > 0)
  assert.equal(cues.every((cue) => cue.anchor === 'bottom' && cue.text.length <= 32), true)
  assert.equal(cues.every((cue, index) => index === 0 || cue.startFrame >= cues[index - 1].endFrame), true)
  const captionText = cues.map((cue) => cue.text).join(' ').toLowerCase()
  assert.equal(captionText.includes('31 de janeiro'), false)
  assert.equal(captionText.includes('1 de fevereiro'), false)
  assert.equal(captionText.includes('dois dias'), false)
  assert.equal(result.run.decisions.some((decision) => decision.choice === 'no_effect'), true)
  assert.equal(result.run.decisions.some((decision) => decision.choice === 'no_insert'), true)
  assert.equal(result.run.qualityReport.status, 'approved-with-warnings')
  assert.equal(Object.values(result.run.qualityReport.hardChecks).every(Boolean), true)
  assert.equal(repository.lastBundle.event.type, 'project.version.created')
  assert.deepEqual(result.impact.changeKinds, ['director-replan'])
  assert.deepEqual(result.impact.dependencyTypes, ['audio', 'content', 'policy', 'timing', 'visual'])
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: 300 }])
  assert.deepEqual(result.impact.minimalRenders, [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: 300 }] }])
  assert.deepEqual(result.impact.affectedArtifacts.map((item) => item.artifactId), ['artifact-final-4', 'artifact-proxy-4'])
  assert.equal(result.invalidations.length, 2)
  assert.equal(result.invalidations.every((item) => item.status === 'stale' && item.impactHash === result.impact.impactHash), true)
  assert.equal(repository.lastBundle.event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(repository.lastBundle.event.data.artifactInvalidationCount, 2)
  assert.deepEqual(
    parseDirectorRunImpact(JSON.parse(stableSerialize(result.impact))),
    result.impact,
  )
  assert.throws(
    () => parseDirectorRunImpact({ ...result.impact, impactHash: 'f'.repeat(64) }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('Director V2 replays exactly and rejects payload or version drift', async () => {
  const { service } = fixture()
  const first = await service(request())
  const replay = await service(request())
  assert.equal(replay.replayed, true)
  assert.equal(replay.run.id, first.run.id)
  assert.equal(replay.version.id, first.version.id)

  await assert.rejects(
    () => service(request({ reason: 'Outra intenção para a mesma chave.' })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )

  const stale = fixture()
  await assert.rejects(
    () => stale.service(request({ baseHash: 'c'.repeat(64), idempotency: { key: 'director-stale' } })),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT',
  )
})

test('Director V2 preserves a selected B-roll insert with bound source audio and an explicit decision', async () => {
  const { service } = fixture({ selectedInsert: true })
  const result = await service(request())
  const insertedClip = result.run.editPlan.videoTracks[0].clips[1]

  assert.equal(insertedClip.sourceArtifactId, 'artifact-selected-insert-1')
  assert.equal(insertedClip.audioSourceArtifactId, 'artifact-master-1')
  assert.equal(result.run.treatmentPlan.mode, 'talking-head')
  assert.equal(result.run.decisions.some((decision) =>
    decision.category === 'insert' && decision.choice === 'use_selected_insert'), true)
  assert.equal(result.run.assumptions.some((assumption) =>
    assumption.includes('asset-selection') && assumption.includes('rights')), true)
})

test('Director V2 still requests one full proxy without fabricating stale artifacts when the base has no completed outputs', async () => {
  const { service } = fixture({ outputReferences: [] })
  const result = await service(request())

  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.impact.affectedVariantIds, [])
  assert.deepEqual(result.impact.minimalRenders, [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: 300 }] }])
  assert.deepEqual(result.invalidations, [])
})

test('Director enqueue allocates one immutable result version and replays before reading mutable project state', async () => {
  const directorRuns = new InMemoryDirectorRepository()
  let contextReads = 0
  const originalReadContext = directorRuns.readContext.bind(directorRuns)
  directorRuns.readContext = async (input) => {
    contextReads += 1
    return originalReadContext(input)
  }
  let stored
  const operations = {
    async findReplay(input) {
      if (!stored) return null
      assert.equal(input.requestFingerprint, stored.requestFingerprint)
      assert.equal(input.actorContextHash, stored.authenticationAudit.contextHash)
      return { operation: stored.operation, context: stored.context, authenticationAudit: stored.authenticationAudit, replayed: true }
    },
    async createOrReplay(input) {
      stored = input
      return { operation: input.operation, context: input.context, authenticationAudit: input.authenticationAudit, replayed: false }
    },
  }
  let sequence = 0
  const enqueue = enqueueProjectDirectorRunService({
    directorRuns,
    operations,
    clock: () => new Date('2026-08-03T22:30:00.000Z'),
    createId: (kind) => `${kind}-director-enqueue-${++sequence}`,
  })
  const input = {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    baseVersionId: 'project-version-4',
    baseHash,
    actor: directorEnqueueActor(),
    idempotencyKey: 'director-enqueue-key-1',
    reason: 'Recompute the full editorial plan.',
    traceId: 'trace-director-enqueue-1',
  }
  const first = await enqueue(input)
  assert.equal(first.replayed, false)
  assert.equal(first.operation.type, 'project-director-run')
  assert.equal(first.operation.projectId, 'project-1')
  assert.deepEqual(first.authenticationAudit, materializeActorAuditContext(input.actor))
  assert.deepEqual(first.operation.target, {
    type: 'project-version',
    id: 'project-version-director-enqueue-1',
  })
  assert.deepEqual(first.context, {
    kind: 'project-director-run',
    projectId: 'project-1',
    baseVersionId: 'project-version-4',
    baseHash,
    resultVersionId: 'project-version-director-enqueue-1',
    delegatedUserId: 'user-director-enqueue-1',
    reason: 'Recompute the full editorial plan.',
  })
  directorRuns.readContext = async () => {
    throw new Error('replay must not read mutable state')
  }
  const replay = await enqueue(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.operation.id, first.operation.id)
  assert.equal(contextReads, 1)
})

test('Director enqueue fails closed for a stale immutable base', async () => {
  const directorRuns = new InMemoryDirectorRepository()
  const enqueue = enqueueProjectDirectorRunService({
    directorRuns,
    operations: {
      async findReplay() { return null },
      async createOrReplay() { throw new Error('stale requests must not persist') },
    },
    createId: (kind) => `${kind}-stale-director-1`,
  })
  await assert.rejects(
    () => enqueue({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      baseVersionId: 'project-version-stale-1',
      baseHash,
      actor: directorEnqueueActor(),
      idempotencyKey: 'director-stale-enqueue-1',
    }),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT',
  )
})

test('Director worker fences the atomic commit and settles the allocated version target', async () => {
  const directorRuns = new InMemoryDirectorRepository()
  let operation = createQueuedPublicOperation({
    id: 'operation-director-worker-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    clientId: 'client-1',
    type: 'project-director-run',
    target: { type: 'project-version', id: 'project-version-worker-result-1' },
    createdAt: '2026-08-03T22:40:00.000Z',
  })
  const context = Object.freeze({
    kind: 'project-director-run',
    projectId: 'project-1',
    baseVersionId: 'project-version-4',
    baseHash,
    resultVersionId: 'project-version-worker-result-1',
    delegatedUserId: 'user-director-worker-1',
    reason: 'Run through the durable worker.',
  })
  let lease
  const activeLease = (input) =>
    lease?.owner === input.leaseOwner &&
    lease?.attempt === input.attempt &&
    Date.parse(lease.expiresAt) > Date.parse(input.now)
  const operations = {
    async claimNext(input) {
      assert.equal(input.type, 'project-director-run')
      operation = startPublicOperationAttempt(operation, input.now)
      lease = {
        owner: input.leaseOwner,
        attempt: operation.attempt,
        expiresAt: input.leaseUntil,
      }
      return { operation, context, lease: { ...lease, heartbeatAt: input.now } }
    },
    async heartbeat(input) {
      if (!activeLease(input)) return false
      lease.expiresAt = input.leaseUntil
      return true
    },
    async findById() { return { operation, context } },
    async failOrRetry() { throw new Error('successful worker must not fail') },
  }
  const originalCommit = directorRuns.commitOrReplay.bind(directorRuns)
  directorRuns.commitOrReplay = async (bundle) => {
    assert.deepEqual(bundle.operationFence, {
      operationId: operation.id,
      leaseOwner: 'worker-director-1',
      attempt: 1,
      now: bundle.operationFence.now,
    })
    assert.equal(bundle.version.id, context.resultVersionId)
    assert.equal(bundle.command.author.delegatedUserId, context.delegatedUserId)
    if (!activeLease(bundle.operationFence)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'lease lost before commit')
    }
    const result = await originalCommit(bundle)
    operation = advancePublicOperationPhase(operation, 'persisting', bundle.operationFence.now)
    operation = succeedPublicOperation(operation, bundle.operationFence.now)
    lease = undefined
    return result
  }
  let counter = 0
  const runNext = runNextProjectDirectorOperationService({
    operations,
    directorRuns,
    clock: () => new Date('2026-08-03T22:40:01.000Z'),
    createId: (kind) => `${kind}-worker-${++counter}`,
    createEventId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
  })
  const outcome = await runNext('worker-director-1')
  assert.deepEqual(outcome, {
    operationId: 'operation-director-worker-1',
    status: 'succeeded',
  })
  assert.equal(operation.status, 'succeeded')
  assert.deepEqual(operation.result.resource, context.kind === 'project-director-run'
    ? { type: 'project-version', id: context.resultVersionId }
    : null)
})

function createResilientDirectorOperation() {
  let operation = createQueuedPublicOperation({
    id: 'operation-director-resilience-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    clientId: 'client-1',
    type: 'project-director-run',
    target: { type: 'project-version', id: 'project-version-resilience-result-1' },
    maxAttempts: 3,
    createdAt: '2026-08-03T23:00:00.000Z',
  })
  const context = Object.freeze({
    kind: 'project-director-run',
    projectId: 'project-1',
    baseVersionId: 'project-version-4',
    baseHash,
    resultVersionId: 'project-version-resilience-result-1',
    reason: 'Exercise durable Director recovery.',
  })
  let lease
  let reclaimExpired = false
  const activeLease = (input) =>
    lease?.owner === input.leaseOwner &&
    lease?.attempt === input.attempt &&
    Date.parse(lease.expiresAt) > Date.parse(input.now)
  const record = () => ({ operation, context })
  const repository = {
    async claimNext(input) {
      if (
        !['queued', 'retrying'].includes(operation.status) &&
        !(operation.status === 'running' && reclaimExpired)
      ) return null
      if (
        operation.status === 'retrying' &&
        Date.parse(operation.nextAttemptAt) > Date.parse(input.now)
      ) return null
      operation = startPublicOperationAttempt(operation, input.now)
      reclaimExpired = false
      lease = {
        owner: input.leaseOwner,
        attempt: operation.attempt,
        expiresAt: input.leaseUntil,
      }
      return { ...record(), lease: { ...lease, heartbeatAt: input.now } }
    },
    async heartbeat(input) {
      if (!activeLease(input)) return false
      lease.expiresAt = input.leaseUntil
      return true
    },
    async findById() { return record() },
    async failOrRetry(input) {
      if (!activeLease(input)) return null
      operation = retryOrFailPublicOperation(
        operation,
        input.error,
        input.now,
        input.nextAttemptAt,
      )
      lease = undefined
      return record()
    },
  }
  return {
    context,
    repository,
    get operation() { return operation },
    activeLease,
    expireForReclaim() { reclaimExpired = true },
    cancel(at) {
      operation = cancelPublicOperation(operation, at)
      lease = undefined
    },
    async settle(bundle, commit) {
      if (!activeLease(bundle.operationFence)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director operation fence is stale')
      }
      const result = await commit(bundle)
      operation = advancePublicOperationPhase(
        operation,
        'persisting',
        bundle.operationFence.now,
      )
      operation = succeedPublicOperation(operation, bundle.operationFence.now)
      lease = undefined
      return result
    },
  }
}

function createDirectorResilienceClock() {
  let current = Date.parse('2026-08-03T23:00:00.000Z')
  return () => new Date((current += 100))
}

function resilientDirectorWorker(harness, directorRuns, clock) {
  let counter = 0
  return runNextProjectDirectorOperationService({
    operations: harness.repository,
    directorRuns,
    clock,
    createId: (kind) => `${kind}-resilience-${++counter}`,
    createEventId: () =>
      `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 8,
  })
}

test('Director worker retries a transient persistence outage and commits once after restart', async () => {
  const harness = createResilientDirectorOperation()
  const directorRuns = new InMemoryDirectorRepository()
  const originalRead = directorRuns.readContext.bind(directorRuns)
  const originalCommit = directorRuns.commitOrReplay.bind(directorRuns)
  let contextReads = 0
  let commits = 0
  directorRuns.readContext = async (input) => {
    contextReads += 1
    if (contextReads === 1) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'temporary database outage')
    }
    return originalRead(input)
  }
  directorRuns.commitOrReplay = async (bundle) => {
    commits += 1
    return harness.settle(bundle, originalCommit)
  }
  const runNext = resilientDirectorWorker(
    harness,
    directorRuns,
    createDirectorResilienceClock(),
  )
  assert.equal((await runNext('director-worker-retry-1')).status, 'retrying')
  assert.equal(harness.operation.status, 'retrying')
  assert.equal(harness.operation.attempt, 1)
  assert.equal((await runNext('director-worker-retry-2')).status, 'succeeded')
  assert.equal(harness.operation.attempt, 2)
  assert.equal(harness.operation.status, 'succeeded')
  assert.equal(contextReads, 2)
  assert.equal(commits, 1)
  assert.equal(directorRuns.currentVersion.id, harness.context.resultVersionId)
})

test('Director worker reclaims an expired running attempt without accepting its stale result', async () => {
  const harness = createResilientDirectorOperation()
  const directorRuns = new InMemoryDirectorRepository()
  const originalCommit = directorRuns.commitOrReplay.bind(directorRuns)
  const staleClaim = await harness.repository.claimNext({
    type: 'project-director-run',
    leaseOwner: 'director-worker-stale-1',
    now: '2026-08-03T23:00:00.050Z',
    leaseUntil: '2026-08-03T23:00:00.075Z',
  })
  harness.expireForReclaim()
  directorRuns.commitOrReplay = (bundle) => harness.settle(bundle, originalCommit)
  const runNext = resilientDirectorWorker(
    harness,
    directorRuns,
    createDirectorResilienceClock(),
  )
  assert.equal((await runNext('director-worker-reclaim-2')).status, 'succeeded')
  assert.equal(harness.operation.attempt, 2)
  await assert.rejects(
    () => harness.settle({ operationFence: {
      operationId: staleClaim.operation.id,
      leaseOwner: 'director-worker-stale-1',
      attempt: 1,
      now: '2026-08-03T23:00:00.200Z',
    } }, async () => {
      throw new Error('stale commit must never execute')
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(directorRuns.currentVersion.id, harness.context.resultVersionId)
})

test('Director cancellation during planning revokes the fence and publishes no version', async () => {
  const harness = createResilientDirectorOperation()
  const directorRuns = new InMemoryDirectorRepository()
  const originalVersionId = directorRuns.currentVersion.id
  directorRuns.commitOrReplay = async (bundle) => {
    harness.cancel('2026-08-03T23:00:00.450Z')
    return harness.settle(bundle, async () => {
      throw new Error('canceled Director must not commit')
    })
  }
  const runNext = resilientDirectorWorker(
    harness,
    directorRuns,
    createDirectorResilienceClock(),
  )
  const outcome = await runNext('director-worker-cancel-1')
  assert.equal(outcome.status, 'lease-lost')
  assert.equal(harness.operation.status, 'canceled')
  assert.equal(directorRuns.currentVersion.id, originalVersionId)
  assert.equal(directorRuns.records.size, 0)
})

test('Director transient retry is bounded and dead-letters without publishing a version', async () => {
  const harness = createResilientDirectorOperation()
  const directorRuns = new InMemoryDirectorRepository()
  const originalVersionId = directorRuns.currentVersion.id
  directorRuns.readContext = async () => {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'database remains unavailable')
  }
  const runNext = resilientDirectorWorker(
    harness,
    directorRuns,
    createDirectorResilienceClock(),
  )
  assert.equal((await runNext('director-worker-exhaust-1')).status, 'retrying')
  assert.equal((await runNext('director-worker-exhaust-2')).status, 'retrying')
  assert.equal((await runNext('director-worker-exhaust-3')).status, 'failed')
  assert.equal(harness.operation.attempt, 3)
  assert.equal(harness.operation.status, 'failed')
  assert.equal(harness.operation.retryable, false)
  assert.equal(harness.operation.error.retryable, false)
  assert.equal(harness.operation.deadLetteredAt, harness.operation.completedAt)
  assert.equal(directorRuns.currentVersion.id, originalVersionId)
  assert.equal(directorRuns.records.size, 0)
})
