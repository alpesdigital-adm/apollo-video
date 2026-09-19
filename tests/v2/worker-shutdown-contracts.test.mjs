import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import {
  addCaptureSessionTrack,
  createCaptureSession,
} from '../../src/v2/domain/capture-session.ts'
import { createSessionClock } from '../../src/v2/domain/session-clock.ts'
import {
  createTickInterval,
  rational,
  timebaseFromRate,
} from '../../src/v2/domain/session-time.ts'
import { runNextPublicOperationService } from '../../src/v2/application/run-public-operation-worker.ts'
import { runCaptureSyncWorker } from '../../src/v2/application/run-capture-sync-worker.ts'
import { runProviderJobWorkerLoop } from '../../src/v2/application/provider-jobs.ts'
import { runCoordinatedWebhookDeliveryWorkerLoop } from '../../src/v2/application/run-webhook-delivery-worker.ts'
import { WORKER_SHUTDOWN_ERROR_CODE } from '../../src/v2/application/worker-lifecycle.ts'

const SCRIPTS = fileURLToPath(new URL('../../scripts/', import.meta.url))

/**
 * Wave 23, slice D. Three kinds of proof, in one file because they are one claim:
 *
 * 1. Structural, over the ten entrypoints. A shutdown guarantee that only one
 *    script implements is not a guarantee, and the Gate Zero inventory found three
 *    scripts stopping on a bare `let stopping = false` and four with no Prisma
 *    disconnect at all. These read the file text, because what must not regress is
 *    the wiring — and a behavioural test of a top-level-await script would have to
 *    spawn it against a real database.
 * 2. Behavioural, with controlled ports, for the pieces that decide when a claim may
 *    happen: the render chain's five branches, capture-sync's cascade, and the two
 *    loops that live in the application layer.
 * 3. Domain, against the real transition functions with a fenced fake repository
 *    (the pattern `public-operation-worker.test.mjs` established), for what a
 *    graceful shutdown leaves behind: claimable, not dead-lettered, not promoted.
 */
const ENTRYPOINTS = [
  { file: 'run-v2-render-worker.mjs', role: 'render-worker', loops: true },
  { file: 'run-v2-render-worker-once.mjs', role: 'render-worker-once', loops: false },
  { file: 'run-v2-ingest-worker.mjs', role: 'ingest-worker', loops: true },
  { file: 'run-v2-capture-sync-worker.mjs', role: 'capture-sync-worker', loops: true },
  { file: 'run-v2-long-form-worker.mjs', role: 'long-form-worker', loops: true },
  { file: 'run-v2-provider-worker.mjs', role: 'provider-worker', loops: true },
  { file: 'run-v2-webhook-worker.mjs', role: 'webhook-worker', loops: true },
  { file: 'run-v2-music-analysis-worker.mjs', role: 'music-analysis-worker', loops: true },
  { file: 'run-v2-localization-media-worker.mjs', role: 'localization-media-worker', loops: true },
  {
    file: 'run-v2-localization-translation-worker.mjs',
    role: 'localization-translation-worker',
    loops: true,
  },
]

async function entrypointSource(file) {
  return await readFile(new URL(file, `file://${SCRIPTS.replaceAll('\\', '/')}`), 'utf8')
}

test('every worker entrypoint stops through createWorkerShutdown, not a bare flag', async () => {
  for (const entrypoint of ENTRYPOINTS) {
    const source = await entrypointSource(entrypoint.file)
    assert.match(
      source,
      /createWorkerShutdown\(\{/,
      `${entrypoint.file} must build its stop path with createWorkerShutdown`,
    )
    assert.doesNotMatch(
      source,
      /let\s+stopping\s*=/,
      `${entrypoint.file} must not reintroduce the bare stopping flag`,
    )
    // The signal handlers belong to the helper: a script registering its own again
    // would abort a controller the helper does not own and could not dispose.
    assert.doesNotMatch(
      source,
      /process\.once\(\s*['"]SIG(INT|TERM)['"]/,
      `${entrypoint.file} must not register its own signal handlers`,
    )
    assert.doesNotMatch(
      source,
      /new AbortController\(\)/,
      `${entrypoint.file} must not keep a second AbortController beside the shutdown`,
    )
  }
})

test('every worker entrypoint asks the host admission gate before claiming', async () => {
  for (const entrypoint of ENTRYPOINTS) {
    const source = await entrypointSource(entrypoint.file)
    assert.match(
      source,
      /createFileAdmissionGate\(\)/,
      `${entrypoint.file} must read the host ops-state gate`,
    )
    assert.match(
      source,
      /shutdown\.admits\(\)/,
      `${entrypoint.file} must consult the gate before a claim`,
    )
  }
})

test('every worker entrypoint threads its shutdown signal into the claim', async () => {
  for (const entrypoint of ENTRYPOINTS) {
    const source = await entrypointSource(entrypoint.file)
    assert.match(
      source,
      /shutdown\.signal/,
      `${entrypoint.file} must pass its shutdown signal into the work it admits`,
    )
  }
})

test('every worker entrypoint awaits the Prisma disconnect helper in cleanup', async () => {
  for (const entrypoint of ENTRYPOINTS) {
    const source = await entrypointSource(entrypoint.file)
    assert.match(
      source,
      /disconnectV2PostgresClient/,
      `${entrypoint.file} must import and call the named disconnect helper`,
    )
    assert.match(
      source,
      /runWithCleanup\(/,
      `${entrypoint.file} must run its cleanups through runWithCleanup`,
    )
    assert.match(
      source,
      /name: ['"]prisma-disconnect['"], run: \(\) => (prismaClient\.)?disconnectV2PostgresClient\(\)/,
      `${entrypoint.file} must register the disconnect as a cleanup, not a best-effort call`,
    )
    assert.match(
      source,
      /name: ['"]shutdown-listeners['"]/,
      `${entrypoint.file} must dispose its signal listeners in cleanup`,
    )
  }
})

test('every worker entrypoint names its PostgreSQL backends before building a client', async () => {
  for (const entrypoint of ENTRYPOINTS) {
    const source = await entrypointSource(entrypoint.file)
    assert.match(
      source,
      /process\.env\.APOLLO_PROCESS_ROLE \?\?=/,
      `${entrypoint.file} must declare its process role with ??= so a deployment can override it`,
    )
    assert.ok(
      source.includes(entrypoint.role),
      `${entrypoint.file} must default its role to ${entrypoint.role}`,
    )
  }
})

test('no worker entrypoint kills by name, by pattern or detached from the run', async () => {
  for (const entrypoint of ENTRYPOINTS) {
    const source = await entrypointSource(entrypoint.file)
    assert.doesNotMatch(source, /pkill|killall|taskkill/, `${entrypoint.file} must not scan the host for processes`)
    assert.doesNotMatch(source, /detached\s*:\s*true/, `${entrypoint.file} must not detach a child`)
  }
})

/**
 * Which application services must union an outer signal into the controller their
 * ports already receive, and which cannot.
 *
 * Structural rather than behavioural for the four that need a dozen real ports to
 * reach their first abortable call: the union itself is `linkAbortSignal`, which
 * `worker-lifecycle.test.mjs` tests directly, and the end-to-end path is proven
 * behaviourally below for the artifact-render branch, which uses the same helper.
 */
const SIGNAL_UNIONS = [
  'run-public-operation-worker.ts',
  'run-project-final-export-worker.ts',
  'run-source-cleanup-worker.ts',
  'run-media-ingest-worker.ts',
]

test('every worker with an internal abort controller unions the outer signal into it', async () => {
  const application = fileURLToPath(new URL('../../src/v2/application/', import.meta.url))
  for (const file of SIGNAL_UNIONS) {
    const source = await readFile(join(application, file), 'utf8')
    assert.match(
      source,
      /linkAbortSignal\(signal, abortController\)/,
      `${file} must union the outer signal into the controller its ports receive`,
    )
    assert.match(
      source,
      /ownerLink\.dispose\(\)/,
      `${file} must remove the outer listener so a long-lived signal does not accumulate them`,
    )
    assert.match(
      source,
      /signal\?: AbortSignal/,
      `${file} must accept an optional signal so existing (leaseOwner) call sites stay valid`,
    )
    assert.match(
      source,
      /if \(signal\?\.aborted\) return null/,
      `${file} must refuse to claim once it has been told to stop`,
    )
  }
  // The proxy render worker already had the union, under its own parameter name,
  // because the localization runtime calls it with a target and a signal.
  const proxy = await readFile(join(application, 'run-project-proxy-render-worker.ts'), 'utf8')
  assert.match(proxy, /target\.signal\?\.addEventListener\('abort', abortFromTarget, \{ once: true \}\)/)
  assert.match(proxy, /target\.signal\?\.removeEventListener\('abort', abortFromTarget\)/)
})

test('the render worker checks admission between all five branches of its chain', async () => {
  const source = await entrypointSource('run-v2-render-worker.mjs')
  for (const branch of [
    'project-director',
    'project-final-export',
    'project-proxy-render',
    'source-cleanup',
    'artifact-render',
  ]) {
    assert.ok(source.includes(branch), `the chain must still name the ${branch} branch`)
  }
  // The old shape — five awaits joined by `??` — could not be interrupted between
  // branches, because there is nowhere in that expression to put a check.
  assert.doesNotMatch(
    source,
    /await runNextProjectDirector\([^)]*\) \?\?/,
    'the chain must not be a single nullish-coalescing expression again',
  )
  const loopBody = source.slice(source.indexOf('for (const branch of branches)'))
  assert.match(
    loopBody.slice(0, 260),
    /await shutdown\.admits\(\)/,
    'admission must be re-read inside the per-branch loop, not once per iteration',
  )
})

/** The five branches as the script wires them, with the real claim replaced. */
function renderChainHarness(options = {}) {
  const claims = []
  const controller = new AbortController()
  const gateAdmits = options.gateAdmits ?? (() => true)
  const shutdown = {
    signal: controller.signal,
    stopping: () => controller.signal.aborted,
    admits: async () => (
      controller.signal.aborted
        ? { admits: false, reason: 'shutdown:SIGTERM' }
        : { admits: gateAdmits(claims.length) ? true : false, reason: null }
    ),
  }
  const branch = (name) => async (signal) => {
    claims.push({ name, aborted: signal?.aborted === true })
    if (options.abortDuring === name) controller.abort(new Error('Worker received SIGTERM'))
    return null
  }
  const branches = [
    { name: 'project-director', run: branch('project-director') },
    { name: 'project-final-export', run: branch('project-final-export') },
    { name: 'project-proxy-render', run: branch('project-proxy-render') },
    { name: 'source-cleanup', run: branch('source-cleanup') },
    { name: 'artifact-render', run: branch('artifact-render') },
  ]
  return {
    claims,
    controller,
    async runIteration() {
      for (const entry of branches) {
        const admission = await shutdown.admits()
        if (!admission.admits) return null
        const outcome = await entry.run(shutdown.signal)
        if (outcome) return outcome
      }
      return null
    },
  }
}

test('a signal delivered inside one render branch stops the chain before the next', async () => {
  const harness = renderChainHarness({ abortDuring: 'project-final-export' })
  await harness.runIteration()
  assert.deepEqual(
    harness.claims.map((claim) => claim.name),
    ['project-director', 'project-final-export'],
    'the three branches after the aborting one must never be claimed',
  )
})

test('a closed gate stops the chain at the branch boundary without claiming', async () => {
  const harness = renderChainHarness({ gateAdmits: (claimed) => claimed < 2 })
  await harness.runIteration()
  assert.deepEqual(
    harness.claims.map((claim) => claim.name),
    ['project-director', 'project-final-export'],
  )
  assert.deepEqual(harness.claims.map((claim) => claim.aborted), [false, false])
})

test('the render chain hands the live signal to each branch it does claim', async () => {
  const harness = renderChainHarness()
  await harness.runIteration()
  assert.equal(harness.claims.length, 5)
  for (const claim of harness.claims) {
    assert.equal(claim.aborted, false, `${claim.name} received a signal object`)
  }
  // And the signal it received is the one the abort travels through.
  const second = renderChainHarness({ abortDuring: 'project-director' })
  await second.runIteration()
  assert.deepEqual(second.claims.map((claim) => claim.name), ['project-director'])
})

test('the artifact-render branch refuses to claim once its signal is aborted', async () => {
  let claimed = 0
  const runNext = runNextPublicOperationService({
    operations: {
      async claimNext() { claimed += 1; return null },
      async heartbeat() { return true },
      async advancePhase() { return true },
      async succeed() { return null },
      async failOrRetry() { return null },
      async findById() { return null },
      async findReplay() { return null },
      async createOrReplay() { throw new Error('not used') },
    },
    checkpoints: { async findByOperationId() { return null }, async record() { return null } },
    render: async () => { throw new Error('not reached') },
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
  })
  const controller = new AbortController()
  controller.abort()
  assert.equal(await runNext('worker-aborted-before-claim', controller.signal), null)
  assert.equal(claimed, 0, 'an aborted worker must not take a lease it is about to abandon')
})

/**
 * The fenced fake `public-operation-repository`, using the real domain transitions.
 * Copied in shape from `public-operation-worker.test.mjs` so the invariants under
 * test are the production ones, not a restatement of this file's expectations.
 */
function createFencedOperations(overrides = {}) {
  let operation = createQueuedPublicOperation({
    id: 'operation-shutdown-test',
    workspaceId: 'workspace-shutdown-test',
    clientId: 'client-shutdown-test',
    type: 'artifact-render',
    target: {
      type: 'media-artifact',
      id: 'artifact-shutdown-test',
      manifestId: 'manifest-shutdown-test',
    },
    maxAttempts: overrides.maxAttempts ?? 3,
    createdAt: '2026-09-18T12:00:00.000Z',
  })
  let lease
  let denyHeartbeat = false
  const context = Object.freeze({
    kind: 'artifact-render',
    authorizationId: 'authorization-shutdown-test',
    inputHash: 'a'.repeat(64),
  })
  const record = () => ({ operation, context })
  const matches = (input) =>
    Boolean(lease) &&
    lease.owner === input.leaseOwner &&
    lease.attempt === input.attempt &&
    Date.parse(lease.expiresAt) > Date.parse(input.now)

  return {
    get operation() { return operation },
    loseLease() { denyHeartbeat = true; lease = undefined },
    repository: {
      async findById() { return record() },
      async findReplay() { return null },
      async createOrReplay() { throw new Error('not used') },
      async claimNext(input) {
        // Exactly the production predicate: queued rows, and retrying rows whose
        // nextAttemptAt has come. A `retrying` row with a future nextAttemptAt, or a
        // `failed` row, is not claimable.
        const claimable =
          operation.status === 'queued' ||
          (operation.status === 'retrying' &&
            Date.parse(operation.nextAttemptAt) <= Date.parse(input.now))
        if (!claimable) return null
        operation = startPublicOperationAttempt(operation, input.now)
        lease = {
          owner: input.leaseOwner,
          attempt: operation.attempt,
          expiresAt: input.leaseUntil,
        }
        denyHeartbeat = false
        return { ...record(), lease: Object.freeze({ ...lease }) }
      },
      async heartbeat(input) {
        if (denyHeartbeat || !matches(input)) return false
        lease = { ...lease, expiresAt: input.leaseUntil }
        return true
      },
      async advancePhase(input) {
        if (!matches(input)) return false
        operation = advancePublicOperationPhase(operation, input.phase, input.now)
        return true
      },
      async succeed(input) {
        if (!matches(input)) return null
        operation = succeedPublicOperation(operation, input.now)
        lease = undefined
        return record()
      },
      async failOrRetry(input) {
        if (!matches(input)) return null
        operation = retryOrFailPublicOperation(
          operation,
          input.error,
          input.now,
          input.nextAttemptAt,
        )
        // The production adapter clears the lease columns for any non-running status,
        // which is what makes a `retrying` row claimable by anyone.
        lease = undefined
        return record()
      },
    },
  }
}

function steppingClock(startIso = '2026-09-18T12:00:00.000Z') {
  let current = Date.parse(startIso)
  return () => new Date((current += 100))
}

test('a graceful shutdown leaves the operation retrying, claimable at once, and not dead-lettered', async () => {
  const operations = createFencedOperations()
  const controller = new AbortController()
  let promoted = false
  const runNext = runNextPublicOperationService({
    operations: operations.repository,
    checkpoints: {
      async findByOperationId() { return null },
      async record() { promoted = true; return { checkpoint: {}, replayed: false } },
    },
    clock: steppingClock(),
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 1_000,
    async render(request) {
      // The operator stops the worker while the renderer is running: the signal the
      // worker handed down is the one that fires.
      controller.abort(new Error('Worker received SIGTERM'))
      assert.equal(request.signal.aborted, true, 'the outer signal must reach the renderer')
      throw new Error('render aborted')
    },
  })

  const outcome = await runNext('worker-shutdown-graceful', controller.signal)
  assert.deepEqual(outcome, { operationId: 'operation-shutdown-test', status: 'retrying' })
  assert.equal(promoted, false, 'an aborted attempt must not promote an artifact')

  const settled = operations.operation
  assert.equal(settled.status, 'retrying')
  assert.equal(settled.phase, 'retrying')
  assert.equal(settled.error, undefined, 'a retrying operation carries no terminal error')
  assert.equal(settled.deadLetteredAt, undefined, 'a shutdown is not a permanent failure')
  assert.equal(settled.completedAt, undefined)
  assert.equal(settled.retryable, true)
  assert.equal(settled.attempt, 1)
  // Claimable without waiting out the 60s lease: nextAttemptAt is one millisecond
  // after the settle, not an exponential backoff and not the lease window.
  const gap = Date.parse(settled.nextAttemptAt) - Date.parse(settled.updatedAt)
  assert.equal(gap, 1)

  const reclaimed = await operations.repository.claimNext({
    leaseOwner: 'worker-took-over-after-shutdown',
    now: new Date(Date.parse(settled.nextAttemptAt) + 1).toISOString(),
    leaseUntil: new Date(Date.parse(settled.nextAttemptAt) + 60_000).toISOString(),
    type: 'artifact-render',
  })
  assert.ok(reclaimed, 'another worker must be able to claim it immediately')
  assert.equal(reclaimed.operation.status, 'running')
  assert.equal(reclaimed.lease.attempt, 2)
  assert.equal(reclaimed.lease.owner, 'worker-took-over-after-shutdown')
})

test('the shutdown error code is the retryable structured code, never a user cancel', async () => {
  const operations = createFencedOperations()
  const controller = new AbortController()
  const recorded = []
  const repository = {
    ...operations.repository,
    async failOrRetry(input) {
      recorded.push(input.error)
      return operations.repository.failOrRetry(input)
    },
  }
  const runNext = runNextPublicOperationService({
    operations: repository,
    checkpoints: { async findByOperationId() { return null }, async record() { return null } },
    clock: steppingClock(),
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 1_000,
    async render() {
      controller.abort(new Error('Worker received SIGINT'))
      throw new Error('render aborted')
    },
  })
  await runNext('worker-shutdown-code', controller.signal)
  assert.deepEqual(recorded, [{
    code: WORKER_SHUTDOWN_ERROR_CODE,
    message: 'Worker shut down before the attempt finished',
    retryable: true,
  }])
  // `canceled` is the user's verdict and is terminal; a deploy must never produce it.
  assert.notEqual(operations.operation.status, 'canceled')
  assert.notEqual(operations.operation.status, 'failed')
})

test('a shutdown on the last attempt fails without scheduling an attempt the domain forbids', async () => {
  // `retryOrFailPublicOperation` refuses a nextAttemptAt once the attempt budget is
  // spent, and the row would be reaped to `failed` by `claimNext` on lease expiry
  // anyway — so shutdown records the same terminal outcome rather than a rejected
  // transition, and does it immediately instead of a lease window later.
  const operations = createFencedOperations({ maxAttempts: 1 })
  const controller = new AbortController()
  const runNext = runNextPublicOperationService({
    operations: operations.repository,
    checkpoints: { async findByOperationId() { return null }, async record() { return null } },
    clock: steppingClock(),
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 1_000,
    async render() {
      controller.abort(new Error('Worker received SIGTERM'))
      throw new Error('render aborted')
    },
  })
  const outcome = await runNext('worker-shutdown-last-attempt', controller.signal)
  assert.deepEqual(outcome, { operationId: 'operation-shutdown-test', status: 'failed' })
  assert.equal(operations.operation.status, 'failed')
  assert.equal(operations.operation.error.code, WORKER_SHUTDOWN_ERROR_CODE)
  assert.equal(operations.operation.error.retryable, false)
  assert.equal(Boolean(operations.operation.deadLetteredAt), true)
})

test('an attempt that lost its lease cannot promote and does not overwrite the winner', async () => {
  const operations = createFencedOperations()
  const controller = new AbortController()
  let recordCalls = 0
  const runNext = runNextPublicOperationService({
    operations: operations.repository,
    checkpoints: {
      async findByOperationId() { return null },
      // The production checkpoint repository fences on
      // {leaseOwner, attempt, leaseExpiresAt} inside the promotion transaction and
      // returns null when the row moved on. Null is the whole protection.
      async record() { recordCalls += 1; return null },
    },
    clock: steppingClock(),
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 1_000,
    async render(request) {
      // Another worker reclaims the row while this attempt is rendering, then the
      // operator stops this one. Lease loss must win over the shutdown path.
      operations.loseLease()
      controller.abort(new Error('Worker received SIGTERM'))
      return Object.freeze({
        schemaVersion: 'authorized-render-receipt/v1',
        authorizationId: 'authorization-shutdown-test',
        artifactId: 'artifact-shutdown-test',
        manifestId: 'manifest-shutdown-test',
        inputHash: 'a'.repeat(64),
        revalidationHash: 'b'.repeat(64),
        output: Object.freeze({
          outputKey: 'private/output.mp4',
          outputSha256: 'c'.repeat(64),
          byteSize: 1024,
          committedAt: '2026-09-18T12:00:05.000Z',
        }),
        getOutputKey() { return 'workspaces/test/renders/output.mp4' },
        toJSON() { return {} },
        signalSeen: request.signal.aborted,
      })
    },
  })

  const outcome = await runNext('worker-lost-the-race', controller.signal)
  assert.deepEqual(outcome, { operationId: 'operation-shutdown-test', status: 'lease-lost' })
  assert.equal(recordCalls, 1, 'the checkpoint fence is what refuses, and it was asked')
  // The row is untouched by the loser: still `running` under the other worker's
  // attempt, never rewritten to retrying/failed by the attempt that lost.
  assert.equal(operations.operation.status, 'running')
  assert.equal(operations.operation.error, undefined)
})

const HZ = 90_000n
const captureAt = (second) =>
  new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1000).toISOString()
const captureHash = (n) => String(n).repeat(64).slice(0, 64)

/** A reference camera and one phone, enough to enter the per-track cascade. */
function captureSessionWithTwoTracks() {
  const part = (overrides = {}) => ({
    partId: 'part-1',
    ordinal: 0,
    sourceAssetId: 'asset-cam-main',
    timebase: timebaseFromRate(90_000),
    coverage: createTickInterval(0n, HZ * 600n),
    streamIndex: 0,
    splitReason: 'single-file',
    evidence: {
      ingestArtifactId: 'artifact-1',
      ingestSha256: captureHash(1),
      probeHash: captureHash(2),
      probeSource: 'packet-scan',
      observedAt: captureAt(0),
    },
    ...overrides,
  })
  const track = (overrides = {}) => {
    const { partOverrides, ...rest } = overrides
    return {
      trackId: 'track-camera-main',
      role: 'camera-main',
      device: { deviceId: 'device-a', recorderId: 'recorder-a', make: null, model: null, serial: null },
      sourceAssetId: 'asset-cam-main',
      timebase: timebaseFromRate(90_000),
      streamIndex: 0,
      syncAudioPolicy: 'final-candidate',
      includeInFinalMix: true,
      parts: [part(partOverrides ?? {})],
      ...rest,
    }
  }
  const lineage = {
    commandId: 'command-1',
    operation: 'create-session',
    actorKind: 'human',
    actorId: 'user-1',
    occurredAt: captureAt(0),
    note: null,
  }
  const base = createCaptureSession({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'capture-session-1',
    clock: { timebase: timebaseFromRate(90_000), rounding: 'nearest-half-even' },
    referenceTrackId: 'track-camera-main',
    tracks: [track()],
    lineage,
    createdAt: captureAt(0),
  })
  return addCaptureSessionTrack(base, {
    track: track({
      trackId: 'track-phone',
      role: 'phone',
      syncAudioPolicy: 'sync-only',
      includeInFinalMix: false,
      sourceAssetId: 'asset-phone',
      device: { deviceId: 'device-phone', recorderId: 'recorder-phone', make: null, model: null, serial: null },
      partOverrides: { partId: 'part-phone-1', sourceAssetId: 'asset-phone' },
    }),
    lineage: { ...lineage, operation: 'add-track', commandId: 'command-2' },
  })
}

test('capture-sync abandons at the track boundary on shutdown, keeping coverage and settling nothing', async () => {
  const session = captureSessionWithTwoTracks()
  const controller = new AbortController()
  const settlements = []
  let observed = 0
  const worker = runCaptureSyncWorker({
    sessions: {
      async readHead() { return session },
      async readClock() {
        return createSessionClock({
          sessionId: 'capture-session-1',
          timebase: timebaseFromRate(90_000),
          frameRate: rational(30_000n, 1_001n),
          authority: {
            origin: 'primary-camera',
            sourceId: 'track-camera-main',
            provenance: 'original-capture',
            evidenceRef: 'probe-reference-camera',
          },
          establishedAt: captureAt(0),
        })
      },
      async persistCoverage() {
        // The operator stops the worker while the coverage pass is still running,
        // which is before the cascade's first FFmpeg measurement.
        controller.abort(new Error('Worker received SIGTERM'))
      },
    },
    runs: {
      async claim() {
        return {
          leaseToken: 'capture-sync-lease-token',
          run: {
            id: 'capture-sync-run-1',
            workspaceId: 'workspace-1',
            sessionId: 'capture-session-1',
            baseSessionHash: session.sessionHash,
          },
        }
      },
      async heartbeat() { return true },
      async settle(input) { settlements.push(input); return { settled: true, run: null } },
      async read() { return null },
    },
    signals: { async observe() { observed += 1; return [] } },
    owner: 'capture-sync:test:2',
    clock: () => new Date(captureAt(10)),
  })

  const outcome = await worker(controller.signal)
  assert.equal(outcome.claimed, true)
  assert.equal(outcome.abandonedBecause, 'worker-shutdown')
  assert.equal(outcome.settled, false, 'a deploy must not settle a capture sync run')
  assert.deepEqual(settlements, [], 'settle must never be called on a shutdown')
  assert.equal(observed, 0, 'the cascade must not start a measurement it cannot finish')
  // The coverage rows written before the stop are real measurements and are reported.
  assert.equal(outcome.coverageDerived, 2)
})

test('capture-sync refuses a claim on shutdown', async () => {
  const controller = new AbortController()
  let claims = 0
  const runs = {
    async claim() {
      claims += 1
      return {
        leaseToken: 'capture-sync-lease-token',
        run: {
          id: 'capture-sync-run-1',
          workspaceId: 'workspace-capture-sync',
          sessionId: 'session-capture-sync',
          baseSessionHash: 'hash-mismatch-never-reached',
        },
      }
    },
    async heartbeat() { return true },
    async settle() { throw new Error('a shutdown must not settle a capture sync run') },
    async read() { return null },
  }
  const worker = runCaptureSyncWorker({
    sessions: {
      async readHead() { throw new Error('not reached') },
      async readClock() { throw new Error('not reached') },
      async persistCoverage() { throw new Error('not reached') },
    },
    runs,
    signals: { async observe() { throw new Error('not reached') } },
    owner: 'capture-sync:test:1',
    clock: () => new Date('2026-09-18T12:00:00.000Z'),
  })

  controller.abort(new Error('Worker received SIGTERM'))
  const outcome = await worker(controller.signal)
  assert.equal(claims, 0, 'an aborted capture-sync worker must not claim a run')
  assert.deepEqual(outcome, {
    claimed: false, runId: null, workspaceId: null, settled: false, resolved: 0, review: 0,
    insufficient: 0, coverageDerived: 0, coverageRefused: 0, mapRefused: 0, mediaUnavailable: 0,
  })
})

test('the provider loop asks the gate before each claim and never after admission', async () => {
  const controller = new AbortController()
  const calls = []
  let admits = false
  await runProviderJobWorkerLoop({
    workerId: 'provider:test:1',
    signal: controller.signal,
    pollIntervalMs: 100,
    admits: async () => {
      calls.push('gate')
      return admits
    },
    runNext: async (workerId, signal) => {
      calls.push('claim')
      assert.equal(signal, controller.signal, 'the loop must pass its own signal into the claim')
      controller.abort(new Error('Worker received SIGTERM'))
      return null
    },
    wait: async () => {
      // Opening the gate only after the first refusal proves the refusal was observed
      // rather than the loop simply never having been closed.
      admits = true
    },
  })
  assert.deepEqual(calls, ['gate', 'gate', 'claim'])
})

test('the webhook coordinator refuses to take a shard lease behind a closed gate', async () => {
  const controller = new AbortController()
  let shardClaims = 0
  let refusals = 0
  await runCoordinatedWebhookDeliveryWorkerLoop({
    claimShard: async () => { shardClaims += 1; return null },
    heartbeatShard: async () => true,
    releaseShard: async () => true,
    runAssignedShard: async () => undefined,
    signal: controller.signal,
    heartbeatIntervalMs: 1_000,
    retryIntervalMs: 100,
    admits: async () => {
      refusals += 1
      return false
    },
    wait: async () => {
      if (refusals >= 2) controller.abort(new Error('Worker received SIGTERM'))
    },
  })
  assert.equal(shardClaims, 0, 'a shard lease is an admission and must wait for the gate')
  assert.equal(refusals, 2)
})
