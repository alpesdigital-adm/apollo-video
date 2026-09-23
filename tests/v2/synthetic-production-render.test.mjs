import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  assertSyntheticProductionRenderQualityReport,
  calculateSyntheticProductionRenderQualityHash,
  assertSyntheticProductionRenderCheckpoint,
  syntheticProductionRenderOutputKey,
} from '../../src/v2/domain/synthetic-production-render.ts'
import { runNextSyntheticProductionRenderService } from '../../src/v2/application/run-synthetic-production-render-worker.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  createSyntheticPresenterEditPlan,
  createSyntheticPresenterProfileSnapshot,
} from '../../src/v2/domain/synthetic-production.ts'
import { compileSyntheticPresenterRenderInputs } from '../../src/v2/application/compile-synthetic-presenter-render.ts'

const hash = (character) => character.repeat(64)

function checkpoint(overrides = {}) {
  const base = {
    operationId: 'operation-render-1',
    outputArtifactId: 'artifact-render-1',
    attempt: 2,
    outputKind: 'final',
    renderInputHash: hash('1'),
    outputSha256: hash('2'),
    byteSize: 8192,
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 300,
    codec: 'h264',
    audioCodec: 'aac',
    container: 'mp4',
    runtimeIdentity: {
      commitSha: 'a'.repeat(40),
      treeHash: hash('3'),
      contractGraphHash: hash('4'),
      toolchainHash: hash('5'),
      renderBundleHash: hash('6'),
    },
    committedAt: '2026-09-23T12:00:00.000Z',
    recordedAt: '2026-09-23T12:00:01.000Z',
    ...overrides,
  }
  return {
    ...base,
    outputKey: base.outputKey ?? syntheticProductionRenderOutputKey(base),
    runtimeIdentityHash: base.runtimeIdentityHash ?? calculateCanonicalHash(base.runtimeIdentity),
  }
}

function quality(overrides = {}) {
  const body = {
    schemaVersion: 'synthetic-production-render-quality/v1',
    id: 'quality-render-1',
    workspaceId: 'workspace-render-1',
    projectId: 'project-render-1',
    projectVersionId: 'version-render-1',
    productionRunId: 'run-render-1',
    publicOperationId: 'operation-render-1',
    editPlanSnapshotId: 'snapshot-render-1',
    planHash: hash('1'),
    renderInputHash: hash('2'),
    propsHash: hash('3'),
    outputKind: 'final',
    outputArtifactId: 'artifact-render-1',
    outputManifestId: 'manifest-render-1',
    outputSha256: hash('4'),
    byteSize: 8192,
    expected: { width: 1920, height: 1080, fps: 30, durationInFrames: 300, codec: 'h264', audioCodec: 'aac', container: 'mp4' },
    measured: { width: 1920, height: 1080, fps: 30, durationInFrames: 300, codec: 'h264', audioCodec: 'aac', container: 'mp4', decodable: true },
    runtimeIdentityHash: hash('5'),
    issues: [],
    passed: true,
    evaluatedAt: '2026-09-23T12:00:02.000Z',
    ...overrides,
  }
  return { ...body, reportHash: calculateSyntheticProductionRenderQualityHash(body) }
}

test('synthetic render checkpoint accepts only its server-derived attempt key', () => {
  const value = checkpoint()
  assert.equal(assertSyntheticProductionRenderCheckpoint(value), value)

  for (const outputKey of [
    '../outside.mp4',
    '/absolute/output.mp4',
    'synthetic-production-renders\\outside.mp4',
    syntheticProductionRenderOutputKey({ ...value, attempt: value.attempt + 1 }),
    syntheticProductionRenderOutputKey({ ...value, outputArtifactId: 'artifact-render-2' }),
  ]) {
    assert.throws(
      () => assertSyntheticProductionRenderCheckpoint({ ...value, outputKey }),
      (error) => error.code === 'INVALID_ARGUMENT',
    )
  }
})

test('synthetic render checkpoint rejects an identity hash detached from the renderer', () => {
  const value = checkpoint()
  assert.throws(
    () => assertSyntheticProductionRenderCheckpoint({
      ...value,
      runtimeIdentity: { ...value.runtimeIdentity, toolchainHash: hash('9') },
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})

test('synthetic quality rejects rehashed non-canonical codecs and invented decode state', () => {
  const valid = quality()
  assert.equal(assertSyntheticProductionRenderQualityReport(valid), valid)

  const vp9Body = {
    ...valid,
    expected: { ...valid.expected, codec: 'vp9' },
    measured: { ...valid.measured, codec: 'vp9' },
  }
  delete vp9Body.reportHash
  assert.throws(
    () => assertSyntheticProductionRenderQualityReport({
      ...vp9Body,
      reportHash: calculateSyntheticProductionRenderQualityHash(vp9Body),
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )

  const undecodableBody = {
    ...valid,
    measured: { ...valid.measured, decodable: 'yes' },
  }
  delete undecodableBody.reportHash
  assert.throws(
    () => assertSyntheticProductionRenderQualityReport({
      ...undecodableBody,
      reportHash: calculateSyntheticProductionRenderQualityHash(undecodableBody),
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})

test('synthetic quality preserves a measured technical rejection without approving finalization', () => {
  const base = quality()
  const body = {
    ...base,
    measured: { ...base.measured, width: 1280 },
    issues: [{ code: 'RENDER_CONTRACT_MISMATCH', severity: 'error', message: 'Decoded width differs from RenderInput.' }],
    passed: false,
  }
  delete body.reportHash
  const rejected = { ...body, reportHash: calculateSyntheticProductionRenderQualityHash(body) }
  assert.equal(assertSyntheticProductionRenderQualityReport(rejected), rejected)
})

function finalizationWorker({ finalize }) {
  const calls = []
  const worker = runNextSyntheticProductionRenderService({
    operations: {
      async resumeWaiting(command) { calls.push(['resume', command]); return true },
      async failOrRetry(command) {
        calls.push(['fail', command])
        return { operation: { status: command.error.retryable ? 'retrying' : 'failed' } }
      },
      async claimNext() { throw new Error('waiting render must finalize before claiming new work') },
    },
    renders: {
      async findReadyToFinalize() {
        return { workspaceId: 'workspace-render-1', operationId: 'operation-render-1', attempt: 3 }
      },
      async finalizeAttested(command) { calls.push(['finalize', command]); return finalize(command) },
    },
    protectedInputs: {}, materialize: async () => { throw new Error('not reached') },
    renderer: {}, inspector: {}, promoter: {}, artifacts: {}, runtimeIdentity: {},
    clock: () => new Date('2026-09-23T12:00:00.000Z'),
  })
  return { worker, calls }
}

test('synthetic render resumes an attested waiting operation without rendering twice', async () => {
  const { worker, calls } = finalizationWorker({ finalize: async () => true })
  assert.deepEqual(await worker('worker-render-finalizer'), {
    operationId: 'operation-render-1', status: 'succeeded',
  })
  assert.deepEqual(calls.map(([kind]) => kind), ['resume', 'finalize'])
  assert.equal(calls[0][1].attempt, 3)
  assert.equal(calls[1][1].attempt, 3)
})

test('synthetic render terminal binding failure settles the resumed lease without rerendering', async () => {
  const { worker, calls } = finalizationWorker({
    finalize: async () => { throw new DomainError('PERSISTENCE_CONFLICT', 'tampered attestation') },
  })
  assert.deepEqual(await worker('worker-render-finalizer'), {
    operationId: 'operation-render-1', status: 'failed',
  })
  assert.deepEqual(calls.map(([kind]) => kind), ['resume', 'finalize', 'fail'])
  assert.equal(calls[2][1].error.retryable, false)
})

function renderWorkerFixture() {
  const audio = {
    id: 'audio-render-worker',
    artifactId: 'artifact-audio-render-worker',
    artifactKey: 'synthetic/audio-render-worker.wav',
    kind: 'audio',
    sha256: hash('a'),
    byteSize: 1_024,
    durationMs: 2_000,
    locale: 'pt-BR',
    scriptHash: hash('b'),
    alignment: [{ text: 'Olá mundo', startMs: 0, endMs: 2_000 }],
  }
  const video = {
    id: 'video-render-worker',
    artifactId: 'artifact-video-render-worker',
    artifactKey: 'synthetic/video-render-worker.mp4',
    kind: 'video',
    sha256: hash('c'),
    byteSize: 4_096,
  }
  const profile = createSyntheticPresenterProfileSnapshot({
    id: 'profile-render-worker',
    version: 1,
    actorIdentityId: 'identity-render-worker',
    avatar: { adapterId: 'controlled-avatar', adapterVersion: '1.0.0', identityRef: 'avatar-render-worker' },
    voice: { id: 'voice-render-worker', version: 1, adapterId: 'controlled-tts', adapterVersion: '1.0.0' },
    defaultLocale: 'pt-BR',
    status: 'active',
    disclosure: 'Conteúdo gerado com IA',
    consent: {
      id: 'consent-render-worker',
      evidenceArtifactId: 'artifact-consent-render-worker',
      evidenceSha256: hash('d'),
      granted: true,
      allowedUses: ['ads'],
      allowedMarkets: ['BRA'],
      allowedLocales: ['pt-BR'],
      allowedOperations: ['tts', 'audio-avatar'],
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  })
  const plan = createSyntheticPresenterEditPlan({
    id: 'plan-render-worker',
    workspaceId: 'workspace-render-worker',
    projectId: 'project-render-worker',
    projectVersionId: 'version-render-worker',
    profile,
    audio,
    blocks: [{
      id: 'block-render-worker',
      text: 'Olá mundo',
      rangeMs: [0, 2_000],
      cacheKey: hash('e'),
      providerJobId: 'job-render-worker',
      audioSha256: audio.sha256,
      artifact: video,
      critic: { id: 'critic-render-worker', resultHash: hash('f'), status: 'approved' },
    }],
    bRoll: [],
    overlays: [],
    captions: true,
    use: 'ads',
    market: 'BRA',
    authorization: {
      id: 'authorization-render-worker',
      authorizationHash: hash('1'),
      outcome: 'allowed',
      use: 'ads',
      market: 'BRA',
      locale: 'pt-BR',
      syntheticOperations: ['tts', 'audio-avatar'],
      artifactIds: [audio.artifactId, video.artifactId],
      decisions: [audio.artifactId, video.artifactId].map((artifactId, index) => ({
        artifactId,
        rightsSnapshotId: `rights-render-worker-${index}`,
        rightsSnapshotHash: hash(String(index + 2)),
        validUntil: '2029-01-01T00:15:00.000Z',
      })),
      evaluatedAt: '2029-01-01T00:00:00.000Z',
      expiresAt: '2029-01-01T00:15:00.000Z',
    },
    createdAt: '2029-01-01T00:01:00.000Z',
  })
  const runtimeIdentity = {
    commitSha: 'a'.repeat(40),
    treeHash: hash('2'),
    contractGraphHash: hash('3'),
    toolchainHash: hash('4'),
    renderBundleHash: hash('5'),
  }
  const spec = compileSyntheticPresenterRenderInputs({
    plan,
    renderer: { id: 'remotion', version: '4.0.489', digest: runtimeIdentity.toolchainHash },
    aspectRatio: '16:9',
  }).final
  const context = {
    kind: 'synthetic-production-render',
    projectId: plan.projectId,
    projectVersionId: plan.projectVersionId,
    projectVersionHash: hash('6'),
    productionRunId: 'run-render-worker',
    editPlanSnapshotId: 'snapshot-render-worker',
    editPlanSnapshotHash: hash('7'),
    planHash: spec.plan.hash,
    outputKind: 'final',
    aspectRatio: '16:9',
    renderInputRef: 'protected/render-worker.json',
    renderInputHash: spec.inputHash,
    propsHash: spec.composition.propsHash,
    outputArtifactId: 'artifact-output-render-worker',
    outputManifestId: 'manifest-output-render-worker',
  }
  context.contextHash = calculateCanonicalHash(context)
  const claimed = {
    operation: { id: 'operation-render-worker', workspaceId: plan.workspaceId },
    context,
    authenticationAudit: {},
    lease: { owner: 'worker-render', attempt: 2, heartbeatAt: '2029-01-01T00:00:00.000Z', expiresAt: '2029-01-01T00:01:00.000Z' },
  }
  return { plan, spec, context, claimed, runtimeIdentity }
}

function renderWorkerDependencies(overrides = {}) {
  const fixture = renderWorkerFixture()
  const events = []
  let persistedCheckpoint = overrides.checkpoint
  const operations = {
    async claimNext() { events.push('claim'); return fixture.claimed },
    async advancePhase(command) { events.push(command.phase); return true },
    async heartbeat() { events.push('heartbeat'); return true },
    async wait() { events.push('wait'); return true },
    async failOrRetry(command) {
      events.push('fail')
      overrides.onFailure?.(command.error)
      return { operation: { status: command.error.retryable ? 'retrying' : 'failed' } }
    },
  }
  const renders = {
    async findReadyToFinalize() { return null },
    async readBinding() {
      return {
        context: fixture.context,
        plan: fixture.plan,
        ...(persistedCheckpoint ? { checkpoint: persistedCheckpoint } : {}),
      }
    },
    async recordCheckpoint(command) {
      events.push('checkpoint')
      persistedCheckpoint = command.checkpoint
      return true
    },
    async recordQuality(command) {
      events.push('quality')
      overrides.onQuality?.(command.report)
      return true
    },
  }
  let tick = 0
  return {
    fixture,
    events,
    dependencies: {
      operations,
      renders,
      protectedInputs: { async read() { return fixture.spec } },
      async materialize() { return { ...fixture.spec, schemaVersion: 'materialized-render-input/v1' } },
      renderer: overrides.renderer,
      inspector: overrides.inspector ?? { async inspect() { throw new Error('inspector must not be reached') } },
      promoter: overrides.promoter ?? { async promote() { throw new Error('promoter must not be reached') } },
      artifacts: overrides.artifacts ?? { async persistOrReplay() { throw new Error('artifact persistence must not be reached') } },
      runtimeIdentity: { async read() { return fixture.runtimeIdentity } },
      clock: () => new Date(Date.parse('2029-01-01T00:00:00.000Z') + (++tick * 1_000)),
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 30_000,
    },
  }
}

test('synthetic render refuses checkpoint recovery when the durable receipt hash changed', async () => {
  const fixture = renderWorkerFixture()
  const persisted = checkpoint({
    operationId: fixture.claimed.operation.id,
    outputArtifactId: fixture.context.outputArtifactId,
    attempt: fixture.claimed.lease.attempt,
    outputKind: fixture.context.outputKind,
    renderInputHash: fixture.context.renderInputHash,
    outputSha256: hash('8'),
    byteSize: 9_001,
    runtimeIdentity: fixture.runtimeIdentity,
  })
  let inspectCalls = 0
  let recoverCalls = 0
  const { dependencies, events } = renderWorkerDependencies({
    checkpoint: persisted,
    renderer: {
      async recover() {
        recoverCalls += 1
        return {
          outputKey: persisted.outputKey,
          outputSha256: hash('9'),
          byteSize: persisted.byteSize,
          inputHash: fixture.context.renderInputHash,
          committedAt: persisted.committedAt,
        }
      },
    },
    inspector: { async inspect() { inspectCalls += 1; throw new Error('not reached') } },
  })

  const worker = runNextSyntheticProductionRenderService(dependencies)
  assert.deepEqual(await worker('worker-render'), {
    operationId: fixture.claimed.operation.id,
    status: 'failed',
  })
  assert.equal(recoverCalls, 1)
  assert.equal(inspectCalls, 0)
  assert.equal(events.includes('rendering'), true)
  assert.equal(events.includes('checkpoint'), false)
  assert.equal(events.at(-1), 'fail')
})

test('synthetic render persists a technical rejection before failing the operation', async () => {
  const fixture = renderWorkerFixture()
  const receipt = {
    outputKey: syntheticProductionRenderOutputKey({
      operationId: fixture.claimed.operation.id,
      outputArtifactId: fixture.context.outputArtifactId,
      attempt: fixture.claimed.lease.attempt,
      outputKind: fixture.context.outputKind,
    }),
    outputSha256: hash('8'),
    byteSize: 9_001,
    inputHash: fixture.context.renderInputHash,
    committedAt: '2029-01-01T00:00:05.000Z',
  }
  let rejectedReport
  let failure
  const { dependencies, events } = renderWorkerDependencies({
    renderer: {
      async stage() {
        return {
          async commit() { return receipt },
          async discard() {},
        }
      },
    },
    inspector: {
      async inspect() {
        return {
          width: fixture.spec.output.width - 1,
          height: fixture.spec.output.height,
          fps: fixture.spec.output.fps,
          durationInFrames: fixture.spec.output.durationInFrames,
          codec: 'h264',
          audioCodec: 'aac',
          container: 'mp4',
          decodable: true,
        }
      },
    },
    promoter: {
      async promote() {
        return { artifactKey: 'synthetic/render-worker.mp4', sha256: receipt.outputSha256, byteSize: receipt.byteSize }
      },
    },
    artifacts: { async persistOrReplay() { return { replayed: false } } },
    onQuality(report) { rejectedReport = report },
    onFailure(error) { failure = error },
  })

  const worker = runNextSyntheticProductionRenderService(dependencies)
  assert.deepEqual(await worker('worker-render'), {
    operationId: fixture.claimed.operation.id,
    status: 'failed',
  })
  assert.ok(rejectedReport, `expected quality before failure, received ${failure?.code}; events=${events.join(',')}`)
  assert.equal(rejectedReport.passed, false)
  assert.equal(rejectedReport.measured.width, fixture.spec.output.width - 1)
  assert.equal(rejectedReport.issues[0].code, 'RENDER_CONTRACT_MISMATCH')
  assert.ok(events.indexOf('quality') < events.indexOf('fail'))
  assert.equal(events.includes('wait'), false)
})
