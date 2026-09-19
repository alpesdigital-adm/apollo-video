import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  GRACEFUL_SIGNALS_AVAILABLE,
  GRACEFUL_SIGNALS_REASON,
  RUNTIME_SAFETY_ENABLED,
  RUNTIME_SAFETY_SKIP_REASON,
  backendsFor,
  childProcessDetails,
  createOpsStateDir,
  delay,
  descendantProcessIds,
  holdsAcross,
  mediaChildren,
  migrateRuntimeSafetyCluster,
  newRunId,
  pollUntil,
  processIsAlive,
  removeLatch,
  renderWorkerEnvironment,
  runtimeSafetyDatabaseUrl,
  scratchRoot,
  spawnSupervised,
  startRuntimeSafetyCluster,
  writeGate,
  writeLatch,
} from './helpers/runtime-safety-world.mjs'
import { callRoute, probeStreams, sha256Of } from './helpers/capture-journey.mjs'
import {
  closeJourneyObjectStore,
  journeyStorageDriver,
  journeyStorageEnvironment,
  openJourneyObjectStore,
  storedArtifactPath,
} from './helpers/journey-object-storage.mjs'
import { encodeSharedProxy, seedEditorReliabilityWorld } from './helpers/editor-reliability-world.mjs'

const execFileAsync = promisify(execFile)

/**
 * Wave 23, slice E — the worker half.
 *
 * Six journeys that interrupt and resume the real product: a real PostgreSQL 16
 * cluster this run creates, the real `scripts/run-v2-render-worker.mjs` spawned as a
 * child process, and a real FFmpeg proxy render of a real encoded master. What is
 * CONTROLLED is named as such in every assertion group: the `gate.json`/`latch.json`
 * files standing in for a monitor's writes, and (journey 7b) a back-dated gate mtime
 * standing in for a monitor that stopped writing.
 *
 * Nothing here measures load. The Hostinger thresholds are not exercised and no
 * metric is claimed: these journeys ask what the workers do when admission is
 * refused or a stop arrives, which is a question about control flow and persistence.
 *
 * Every process is owned: label, run id, PID, deadline, and a `finally` that ends it.
 * The postflight asserts zero backends per `application_name` and zero surviving
 * descendants of the PIDs this run spawned — never a scan of the machine.
 */
const RUN = RUNTIME_SAFETY_ENABLED
const PROXY_SECONDS = 6
const PROXY_FPS = 30
const POLL_MS = 200

const evidence = {
  label: 'wave23-slice-e-workers',
  real: [
    'PostgreSQL 16 cluster created by initdb for this run',
    'scripts/run-v2-render-worker.mjs spawned as a child process',
    'FFmpeg encode of the master and FFmpeg proxy render by the worker',
    'ffprobe reopening the promoted MP4',
  ],
  controlled: [
    'gate.json and latch.json written by the test instead of a monitor',
    'journey 7b back-dates the gate mtime to simulate a monitor that stopped writing',
    'journey 7a runs the real monitor but it publishes closed/sample-missing on this host',
  ],
  journeys: {},
  postflight: {},
  platform: {
    os: process.platform,
    gracefulSignals: GRACEFUL_SIGNALS_AVAILABLE,
    ...(GRACEFUL_SIGNALS_AVAILABLE ? {} : { notExecutedReason: GRACEFUL_SIGNALS_REASON }),
  },
}

/** Journeys whose subject is the graceful stop itself; see GRACEFUL_SIGNALS_REASON. */
const signalJourney = GRACEFUL_SIGNALS_AVAILABLE ? false : GRACEFUL_SIGNALS_REASON

function proxyOperationWhere(projectId) {
  return { type: 'project-proxy-render', projectId }
}

/**
 * Removes a journey's leftover queued render so the next journey owns the queue.
 *
 * The render worker claims any queued proxy render it can see — `claimNext` is only
 * narrowed by workspace when a caller asks, and the script never asks. So a journey
 * that deliberately leaves a row queued (1 and 5 refuse admission; 2 proves the
 * second was never touched) would otherwise hand journey 3 a second candidate and
 * make "the worker claimed the render under test" a coin toss.
 *
 * Deleting fixture rows from a database this run created is the reset AGENTS.md
 * allows; nothing is dropped and no shared server is touched.
 */
async function clearQueuedProxyRenders(prisma, workspaceId, projectId) {
  const rows = await prisma.v2PublicOperation.findMany({
    where: { workspaceId, type: 'project-proxy-render', projectId },
    select: { id: true, status: true },
  })
  await prisma.v2ProjectProxyRenderOperation.deleteMany({
    where: { operationId: { in: rows.map((row) => row.id) } },
  })
  await prisma.v2PublicOperation.deleteMany({
    where: { workspaceId, id: { in: rows.map((row) => row.id) } },
  })
  return rows.map((row) => ({ id: row.id, status: row.status }))
}

/** The queue as the worker sees it: every claimable proxy render, whatever the project. */
async function claimableProxyRenders(prisma) {
  return await prisma.v2PublicOperation.findMany({
    where: { type: 'project-proxy-render', status: { in: ['queued', 'retrying'] } },
    select: { id: true, projectId: true, status: true },
  })
}

/**
 * Empties the queue before a journey enqueues its own render.
 *
 * At the START rather than at the end of the previous journey, because a journey that
 * fails never reaches its own cleanup: journey 1's leftover row outlived its failure,
 * was the oldest in the queue, and journey 7's worker claimed that instead of the one
 * journey 7 was watching — which surfaced as "the worker never claimed" and hid the
 * actual defect behind a sixty-second timeout.
 */
async function resetProxyRenderQueue(prisma) {
  const rows = await prisma.v2PublicOperation.findMany({
    where: { type: 'project-proxy-render', status: { in: ['queued', 'retrying', 'running'] } },
    select: { id: true, workspaceId: true },
  })
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  await prisma.v2ProjectProxyRenderOperation.deleteMany({ where: { operationId: { in: ids } } })
  await prisma.v2PublicOperation.deleteMany({ where: { id: { in: ids } } })
  return ids
}

async function readOperation(prisma, workspaceId, projectId) {
  const row = await prisma.v2PublicOperation.findFirst({
    where: { workspaceId, ...proxyOperationWhere(projectId) },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, status: true, phase: true, attempt: true, maxAttempts: true,
      leaseOwner: true, leaseExpiresAt: true, errorCode: true, errorRetryable: true,
      nextAttemptAt: true, deadLetteredAt: true, completedAt: true,
    },
  })
  return row
}

/**
 * Enqueue one proxy render the way the product does, through the published routes.
 *
 * In-process rather than over HTTP: `callRoute` invokes the same route handler the
 * server would, so the journey needs no Next server to prove a worker claims what the
 * API enqueued. The LUT-selection route is what enqueues the render, exactly as the
 * Wave 22 fixture relies on — nothing below writes an operation row by hand.
 */
async function enqueueProxyRender({ prisma, world, project, routes }) {
  const stage = (id, kind, enabled, provider, parameters) => ({
    id,
    kind,
    version: 'v1',
    enabled,
    output: project.colorMetadata,
    implementation: {
      provider,
      version: 'v1',
      parameters,
      parametersHash: sha256Of(Buffer.from(JSON.stringify(parameters))),
    },
  })
  const compiled = await callRoute(routes.colorPipeline.POST, {
    method: 'POST',
    path: `/v1/projects/${project.projectId}/color-pipeline-compilations`,
    token: world.issued.token,
    params: { projectId: project.projectId },
    idempotencyKey: `${project.projectId}-color-1`,
    body: {
      sourceArtifactId: project.sourceArtifactId,
      sourceManifestId: project.sourceManifestId,
      outputMetadata: project.colorMetadata,
      stages: [
        stage('technical-rec709', 'technical', true, 'ffmpeg-zscale', { mode: 'identity' }),
        stage('match-source', 'match', false, 'apollo-match', { mode: 'bypass' }),
        stage('creative-none', 'creative-lut', false, 'apollo-lut', { mode: 'none' }),
        stage('output-rec709', 'output', true, 'ffmpeg-zscale', { dither: true }),
      ],
    },
  })
  assert.equal(compiled.status, 201, `colour pipeline compilation: ${JSON.stringify(compiled.payload)}`)

  const baseVersion = await prisma.v2ProjectVersion.findFirstOrThrow({
    where: { workspaceId: world.workspaceId, projectId: project.projectId },
    orderBy: { sequence: 'desc' },
    select: { id: true, baseHash: true },
  })
  const enqueued = await callRoute(routes.lutSelection.POST, {
    method: 'POST',
    path: `/v1/projects/${project.projectId}/lut-selection`,
    token: world.issued.token,
    params: { projectId: project.projectId },
    idempotencyKey: `${project.projectId}-lut-1`,
    body: {
      baseVersionId: baseVersion.id,
      baseHash: baseVersion.baseHash,
      selection: { mode: 'none' },
      reason: 'Runtime safety journey selects no creative LUT.',
    },
  })
  assert.ok(
    [200, 201].includes(enqueued.status) && enqueued.payload?.data?.operation,
    `LUT selection + proxy enqueue: ${enqueued.status} ${JSON.stringify(enqueued.payload).slice(0, 400)}`,
  )
  return enqueued.payload.data.operation.id
}

test('Wave 23 runtime safety — worker interruption and resume journeys', {
  skip: RUN ? false : RUNTIME_SAFETY_SKIP_REASON,
  timeout: 10 * 60_000,
}, async (t) => {
  const runId = newRunId()
  const root = scratchRoot(runId)
  const artifactRoot = join(root, 'artifacts')
  // One work root for both the s3 materializers' staging and the source-cleanup
  // branch, and a separate place to copy stored objects to before probing them —
  // the same three-directory shape the podcast and teacher journeys use.
  const workRoot = join(root, 'work')
  const readbackRoot = join(root, 'readback')
  const evidenceDir = join(root, 'evidence')
  for (const directory of [artifactRoot, workRoot, readbackRoot, evidenceDir]) {
    await mkdir(directory, { recursive: true })
  }

  const spawned = []
  const applicationNames = new Set()
  let cluster
  let prisma
  let world
  /** Null on the local driver; the MinIO client the readback reads through under s3. */
  let objectStore

  /**
   * A timestamped line per setup step, appended to a file rather than printed.
   *
   * `node:test` buffers a test's output until it ends, so a suite that hangs prints
   * nothing at all — the first attempt burned its whole 600 s timeout in setup and
   * left no indication of which step was blocked. This file is readable while the
   * run is still going, which is the only way to tell "slow" from "stuck".
   */
  const progressLog = join(root, 'setup.log')
  const step = async (name) => {
    await writeFile(progressLog, `${new Date().toISOString()} ${name}\n`, { flag: 'a' })
    return Date.now()
  }
  await step('setup:start')

  /**
   * Cleanup runs whatever happened above, including a timeout or an interruption.
   * Order matters and is the one AGENTS.md fixes: processes first, then the Prisma
   * client, then the cluster — a client still open is what blocks a shutdown.
   */
  t.after(async () => {
    const survivors = []
    for (const handle of spawned) {
      const descendants = await descendantProcessIds(handle.pid, { since: handle.spawnedAt })
      await handle.terminate({ graceMs: 15_000 }).catch(() => undefined)
      for (const pid of [handle.pid, ...descendants]) {
        if (await processIsAlive(pid)) survivors.push({ label: handle.label, pid })
      }
    }
    evidence.postflight.processSurvivors = survivors

    if (prisma) {
      const backends = {}
      for (const name of applicationNames) backends[name] = await backendsFor(prisma, name)
      evidence.postflight.backends = backends
      await prisma.$disconnect().catch(() => undefined)
    }
    if (objectStore) await closeJourneyObjectStore(objectStore).catch(() => undefined)
    if (world) evidence.postflight.residue = await world.cleanup().catch((error) => String(error))
    if (cluster) evidence.postflight.cluster = await cluster.stop().catch((error) => ({ error: String(error) }))

    await writeFile(join(evidenceDir, 'runtime-safety-workers.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    console.info(`runtime-safety evidence: ${join(evidenceDir, 'runtime-safety-workers.json')}`)

    // The one thing this hook asserts. A surviving process or a cluster still
    // listening is the failure this whole slice exists to prevent, and reporting it
    // only in a JSON file is how it gets missed: a run that leaks must go red.
    if (survivors.length > 0) {
      throw new Error(`the run left processes alive: ${JSON.stringify(survivors)}`)
    }
    if (cluster?.owned && evidence.postflight.cluster?.stopped !== true) {
      throw new Error(`the throwaway cluster is still up: ${JSON.stringify(evidence.postflight.cluster)}`)
    }
  })

  await step('cluster:start')
  cluster = await startRuntimeSafetyCluster({ scratchDir: root, runId })
  const suiteUrl = runtimeSafetyDatabaseUrl(cluster.baseUrl, 'suite')
  applicationNames.add(new URL(suiteUrl).searchParams.get('application_name'))
  await step(`cluster:ready port=${cluster.port} owned=${cluster.owned}`)
  const migration = await migrateRuntimeSafetyCluster(suiteUrl)
  await step('migrate:done')
  evidence.cluster = { owned: cluster.owned, port: cluster.port, migration }

  // The published routes are called in-process below, and a route handler resolves
  // its own client from `V2_DATABASE_URL` through the repository factory singleton.
  // Set before the first import that could touch it, or the routes would answer
  // PERSISTENCE_NOT_CONFIGURED while this file held a perfectly good connection.
  process.env.V2_DATABASE_URL = suiteUrl
  process.env.APOLLO_API_ENVIRONMENT ??= 'production'
  process.env.APOLLO_PROTECTED_PAYLOAD_KEY_ID ??= `runtime-safety-${runId.slice(-8)}`
  process.env.APOLLO_PROTECTED_PAYLOAD_KEY ??= Buffer.alloc(32, 7).toString('base64url')
  // The route handlers called below build media providers and materializers from the
  // environment exactly as a worker does, so this process needs the same roots — and
  // pointed INSIDE this run's temp directory, never at whatever the CI step exported.
  // Assigned, not defaulted: inheriting a shared root is how one run reads another's
  // bytes.
  for (const [name, value] of Object.entries(journeyStorageEnvironment({
    driver: journeyStorageDriver(),
    artifactRoot,
    workRoot,
  }))) {
    process.env[name] = value
  }
  process.env.APOLLO_V2_RENDER_WORK_ROOT = workRoot
  process.env.APOLLO_V2_SOURCE_CLEANUP_WORK_ROOT = workRoot
  objectStore = await openJourneyObjectStore()
  evidence.storage = {
    driver: journeyStorageDriver(),
    objectStore: objectStore !== null,
    artifactRoot,
    workRoot,
    readbackRoot,
  }

  const { PrismaClient } = await import('../../generated/prisma-v2/index.js')
  prisma = new PrismaClient({ datasourceUrl: suiteUrl })

  const routes = {
    colorPipeline: await import('../../src/app/v1/projects/[projectId]/color-pipeline-compilations/route.ts'),
    lutSelection: await import('../../src/app/v1/projects/[projectId]/lut-selection/route.ts'),
  }

  await step('routes:imported')
  const suffix = runId.slice(-8)
  const master = await encodeSharedProxy({
    artifactRoot,
    key: `runtime-safety/${suffix}/source.mp4`,
    seconds: PROXY_SECONDS,
    fps: PROXY_FPS,
  })
  evidence.master = { key: master.key, seconds: master.seconds, fps: master.fps }
  await step('master:encoded')

  world = await seedEditorReliabilityWorld({
    prisma,
    artifactRoot,
    suffix,
    proxy: master,
    projects: [
      { slug: 'gate-closed', name: `Runtime safety gate ${suffix}` },
      { slug: 'sigterm-first', name: `Runtime safety stop A ${suffix}` },
      { slug: 'sigterm-second', name: `Runtime safety stop B ${suffix}` },
      { slug: 'mid-render', name: `Runtime safety render ${suffix}` },
      { slug: 'unauthorised', name: `Runtime safety latch ${suffix}` },
      { slug: 'monitor', name: `Runtime safety monitor ${suffix}` },
      { slug: 'stale-probe', name: `Runtime safety stale ${suffix}` },
    ],
  })
  await step('world:seeded')

  /** Spawns the real render worker, remembered so the postflight can prove it ended. */
  const startWorker = async ({ caseName, opsStateDir, pollMs = POLL_MS }) => {
    const databaseUrl = runtimeSafetyDatabaseUrl(cluster.baseUrl, caseName)
    applicationNames.add(new URL(databaseUrl).searchParams.get('application_name'))
    const spawnedAt = Date.now()
    const handle = spawnSupervised({
      script: 'scripts/run-v2-render-worker.mjs',
      runId,
      label: `render-worker:${caseName}`,
      deadlineMs: 115_000,
      environment: renderWorkerEnvironment({
        databaseUrl, artifactRoot, workRoot, opsStateDir, pollMs, suffix,
      }),
    })
    handle.spawnedAt = spawnedAt
    spawned.push(handle)
    // Wait for the worker to say something before the journey starts expecting things
    // of it. Its first line is an admission-gate reading, so this also proves it read
    // the ops-state directory this journey prepared — and if it died at import, the
    // failure carries its stderr instead of an event-loop message.
    await handle.waitForFirstEvent({
      timeoutMs: 90_000,
      matches: (entry) => entry.event?.startsWith('worker-admission-gate'),
    })
    return handle
  }

  /** The gate reasons a worker logged, in order, one entry per transition. */
  const gateReasons = (handle) => handle.events()
    .filter((entry) => entry.event?.startsWith('worker-admission-gate'))
    .map((entry) => ({ event: entry.event, reason: entry.reason }))

  await t.test('journey 1: a latched gate admits nothing and the worker still stops cleanly', async () => {
    const startedAt = Date.now()
    const project = world.bySlug('gate-closed')
    await resetProxyRenderQueue(prisma)
    const opsStateDir = await createOpsStateDir(root, 'journey1')
    // CONTROLLED: the latch a monitor would have written after a stop timeout.
    await writeLatch(opsStateDir, { runId, detail: 'journey 1 controlled latch fixture' })

    const operationId = await enqueueProxyRender({ prisma, world, project, routes })
    const before = await readOperation(prisma, world.workspaceId, project.projectId)
    assert.equal(before.status, 'queued')
    assert.equal(before.attempt, 0)

    const worker = await startWorker({ caseName: 'journey1-gate-closed', opsStateDir })
    await pollUntil({
      read: () => gateReasons(worker),
      until: (reasons) => reasons.some((entry) => entry.event === 'worker-admission-gate-closed'),
      what: 'the worker to log a closed admission gate',
      timeoutMs: 30_000,
      whileAlive: (context) => worker.assertStillRunning(context),
    })

    // Five polls at 200 ms, and the row must be untouched in every one: `attempt`
    // still 0 and no lease is the only reading that distinguishes "did not claim"
    // from "claimed and released".
    const readings = await holdsAcross({
      read: () => readOperation(prisma, world.workspaceId, project.projectId),
      holds: (row) => row.status === 'queued' && row.attempt === 0 && row.leaseOwner === null,
      samples: 6,
      intervalMs: POLL_MS + 50,
      what: 'the latched worker claiming nothing',
    })

    const children = await childProcessDetails(worker.pid, { since: worker.spawnedAt })
    const rendering = mediaChildren(children)
    // Both the detail row AND its `outputArtifactId` are written when the
    // LUT-selection route ENQUEUES the render: the id is planned up front. Neither is
    // evidence of a promotion, so the question is asked of the artifact table — a
    // `v2MediaArtifact` under that id is what only a completed render can create.
    const detail = await prisma.v2ProjectProxyRenderOperation.findUnique({
      where: { operationId },
      select: { outputArtifactId: true },
    })
    const promotedArtifact = detail?.outputArtifactId
      ? await prisma.v2MediaArtifact.findUnique({
        where: { id_workspaceId: { id: detail.outputArtifactId, workspaceId: world.workspaceId } },
        select: { id: true },
      })
      : null
    const promoted = await prisma.v2MediaArtifact.count({
      where: { workspaceId: world.workspaceId, artifactKey: { contains: 'proxy' } },
    })

    const exit = await worker.terminate({ graceMs: 20_000 })
    const reasons = gateReasons(worker)

    assert.deepEqual(
      rendering, [],
      `the latched worker started rendering: ${JSON.stringify(rendering)} (all children: ${JSON.stringify(children)})`,
    )
    assert.equal(promotedArtifact, null, 'a refused admission must not promote an output artifact')
    assert.equal(promoted, 0, 'a refused admission must not promote an artifact')
    assert.ok(
      reasons.some((entry) => entry.event === 'worker-admission-gate-closed' && /incident-latch/.test(entry.reason ?? '')),
      `the worker did not name the latch: ${JSON.stringify(reasons)}`,
    )
    // One line per transition, not one per poll: an hour behind a closed gate must
    // not be an hour of identical lines.
    assert.equal(
      reasons.filter((entry) => entry.event === 'worker-admission-gate-closed').length,
      1,
      `the closed gate was logged ${reasons.length} times: ${JSON.stringify(reasons)}`,
    )
    if (GRACEFUL_SIGNALS_AVAILABLE) {
      assert.equal(exit.code, 0, `SIGTERM left exit code ${exit.code} / signal ${exit.signal}`)
    } else {
      // Windows terminated it outright, so the exit code says nothing about the
      // worker's own shutdown path. What this platform can still prove is that the
      // process ended and left nothing behind, which the postflight asserts.
      assert.equal(exit.signal, 'SIGTERM', `the worker did not end: ${JSON.stringify(exit)}`)
    }

    evidence.journeys.journey1 = {
      kind: 'real worker + real PostgreSQL, CONTROLLED latch fixture',
      operationId,
      polls: readings.length,
      statusesSeen: [...new Set(readings.map((row) => row.status))],
      attemptsSeen: [...new Set(readings.map((row) => row.attempt))],
      workerPid: worker.pid,
      children,
      renderingChildren: rendering,
      plannedOutputArtifactId: detail?.outputArtifactId ?? null,
      promotedArtifactRow: promotedArtifact,
      promotedArtifacts: promoted,
      gateReasons: reasons,
      exit,
      durationMs: Date.now() - startedAt,
      exitCodeAsserted: GRACEFUL_SIGNALS_AVAILABLE,
      cleared: await clearQueuedProxyRenders(prisma, world.workspaceId, project.projectId),
    }
  })

  await t.test('journey 2: SIGTERM between claims settles the first and leaves the second queued', {
    skip: signalJourney,
  }, async () => {
    const startedAt = Date.now()
    const first = world.bySlug('sigterm-first')
    const second = world.bySlug('sigterm-second')
    await resetProxyRenderQueue(prisma)
    const opsStateDir = await createOpsStateDir(root, 'journey2')
    // CONTROLLED: an open, fresh gate — the state a healthy monitor publishes.
    await writeGate(opsStateDir, { state: 'open', ttlMs: 60_000, runId })

    const firstId = await enqueueProxyRender({ prisma, world, project: first, routes })
    const secondId = await enqueueProxyRender({ prisma, world, project: second, routes })

    const worker = await startWorker({ caseName: 'journey2-sigterm', opsStateDir })
    // The stop is sent once PostgreSQL itself says a row is running: the only
    // moment at which "between claims" is a fact rather than a hope.
    const claimed = await pollUntil({
      read: async () => ({
        first: await readOperation(prisma, world.workspaceId, first.projectId),
        second: await readOperation(prisma, world.workspaceId, second.projectId),
      }),
      until: (rows) => rows.first.status === 'running' || rows.second.status === 'running',
      what: 'the worker to claim its first proxy render',
      timeoutMs: 60_000,
      whileAlive: (context) => worker.assertStillRunning(context),
    })
    const claimedFirst = claimed.first.status === 'running' ? first : second
    const untouched = claimedFirst === first ? second : first

    const exit = await worker.terminate({ graceMs: 45_000 })

    const settled = await readOperation(prisma, world.workspaceId, claimedFirst.projectId)
    const other = await readOperation(prisma, world.workspaceId, untouched.projectId)

    // The Slice D contract, whichever branch the timing took: the claim either
    // finished or came back claimable, and never became a permanent failure.
    if (settled.status === 'retrying') {
      assert.equal(settled.errorCode, 'worker_shutdown', `retry reason was ${settled.errorCode}`)
      assert.equal(settled.leaseOwner, null, 'a returned operation holds no lease')
      assert.equal(settled.deadLetteredAt, null, 'a shutdown is not a dead letter')
      assert.ok(settled.nextAttemptAt !== null, 'a returned operation carries a next attempt')
      // Immediately claimable, not an exponential backoff and not a lease window:
      // Slice D sets nextAttemptAt one millisecond after the settle.
      assert.ok(
        settled.nextAttemptAt.getTime() <= Date.now() + 1_000,
        `nextAttemptAt is ${settled.nextAttemptAt.toISOString()}, further than a second out`,
      )
    } else {
      assert.equal(settled.status, 'succeeded', `the claimed render settled ${settled.status}`)
    }
    assert.equal(other.status, 'queued', `the unclaimed render moved to ${other.status}`)
    assert.equal(other.attempt, 0, 'the unclaimed render was never attempted')
    assert.equal(other.leaseOwner, null)
    assert.ok([0, null].includes(exit.code) || exit.signal, `worker exit ${JSON.stringify(exit)}`)

    evidence.journeys.journey2 = {
      kind: 'real worker + real PostgreSQL, CONTROLLED open gate',
      firstId,
      secondId,
      claimedSlug: claimedFirst.slug,
      settled: {
        status: settled.status, attempt: settled.attempt, errorCode: settled.errorCode,
        leaseOwner: settled.leaseOwner, nextAttemptAt: settled.nextAttemptAt,
      },
      untouched: { status: other.status, attempt: other.attempt },
      exit,
      durationMs: Date.now() - startedAt,
    }
    // Both rows go, including the one that settled: journey 3 must be the only
    // claimable render in the database when its worker starts.
    evidence.journeys.journey2.cleared = [
      ...await clearQueuedProxyRenders(prisma, world.workspaceId, first.projectId),
      ...await clearQueuedProxyRenders(prisma, world.workspaceId, second.projectId),
    ]
  })

  await t.test('journey 3: a stop during the render ends the FFmpeg child and promotes nothing', {
    skip: signalJourney,
  }, async () => {
    const startedAt = Date.now()
    const project = world.bySlug('mid-render')
    await resetProxyRenderQueue(prisma)
    const opsStateDir = await createOpsStateDir(root, 'journey3')
    await writeGate(opsStateDir, { state: 'open', ttlMs: 60_000, runId })

    const operationId = await enqueueProxyRender({ prisma, world, project, routes })
    // The worker claims whatever is claimable, so "it claimed the one under test" is
    // only a fact when there is nothing else to claim.
    const queue = await claimableProxyRenders(prisma)
    assert.deepEqual(
      queue.map((row) => row.id), [operationId],
      `the queue held ${JSON.stringify(queue)} instead of only ${operationId}`,
    )
    const worker = await startWorker({ caseName: 'journey3-mid-render', opsStateDir })

    // The child is found by parent id, never by name: on a shared machine "every
    // ffmpeg" includes other people's.
    const renderChildren = (await pollUntil({
      read: async () => mediaChildren(
        await childProcessDetails(worker.pid, { since: worker.spawnedAt }),
      ),
      // Media children specifically: waiting for "any child" would be satisfied by a
      // console host before FFmpeg had started, and the stop would then arrive before
      // the render it is meant to interrupt.
      until: (children) => children.length > 0,
      what: "the worker's own FFmpeg child to exist",
      // Inside the 120 s per-journey cap once the spawn and the stop are added.
      timeoutMs: 60_000,
      intervalMs: 100,
      whileAlive: (context) => worker.assertStillRunning(context),
    })).map((child) => child.pid)

    const exit = await worker.terminate({ graceMs: 45_000 })
    await delay(500)

    const survivingChildren = []
    for (const pid of renderChildren) {
      if (await processIsAlive(pid)) survivingChildren.push(pid)
    }
    const row = await readOperation(prisma, world.workspaceId, project.projectId)
    const interruptedDetail = await prisma.v2ProjectProxyRenderOperation.findUnique({
      where: { operationId },
      select: { outputArtifactId: true },
    })
    // The planned id exists from enqueue; only a completed render creates the row.
    const interruptedArtifact = interruptedDetail?.outputArtifactId
      ? await prisma.v2MediaArtifact.findUnique({
        where: {
          id_workspaceId: { id: interruptedDetail.outputArtifactId, workspaceId: world.workspaceId },
        },
        select: { id: true },
      })
      : null
    // Listed as evidence, NOT asserted empty. The work root is also where the s3
    // materializer stages the source it downloads, so "no .mp4 under the work root"
    // would fail under MinIO for a file the render never produced. What proves
    // nothing was promoted is the artifact row below, on both drivers.
    const stagedFiles = (await readdir(workRoot, { recursive: true }).catch(() => []))
      .map((name) => String(name))
      .filter((name) => name.endsWith('.mp4'))

    assert.deepEqual(survivingChildren, [], `FFmpeg children outlived the worker: ${survivingChildren}`)
    assert.notEqual(row.status, 'succeeded', 'an interrupted render must not report success')
    assert.equal(interruptedArtifact, null, 'an interrupted render must not promote an artifact')
    assert.equal(row.status, 'retrying', `the interrupted render is ${row.status}`)
    assert.equal(row.errorCode, 'worker_shutdown')
    assert.equal(row.leaseOwner, null, 'an interrupted attempt releases its lease')
    assert.equal(row.deadLetteredAt, null)
    assert.equal(row.attempt, 1, 'exactly one attempt was consumed')

    evidence.journeys.journey3 = {
      kind: 'real worker + real FFmpeg child + real PostgreSQL, CONTROLLED open gate',
      operationId,
      workerPid: worker.pid,
      ffmpegChildPids: renderChildren,
      survivingChildren,
      row: {
        status: row.status, attempt: row.attempt, errorCode: row.errorCode,
        leaseOwner: row.leaseOwner, nextAttemptAt: row.nextAttemptAt,
      },
      plannedOutputArtifactId: interruptedDetail?.outputArtifactId ?? null,
      promotedArtifactRow: interruptedArtifact,
      stagedMp4s: stagedFiles,
      exit,
      durationMs: Date.now() - startedAt,
    }
  })

  // Journey 4 resumes what journey 3 interrupted, so it can only run where journey 3 did.
  await t.test('journey 4: an authorised restart resumes the same operation and promotes exactly once', {
    skip: signalJourney,
  }, async () => {
    const startedAt = Date.now()
    const project = world.bySlug('mid-render')
    const opsStateDir = await createOpsStateDir(root, 'journey4')
    await writeGate(opsStateDir, { state: 'open', ttlMs: 120_000, runId })

    const before = await readOperation(prisma, world.workspaceId, project.projectId)
    // Journey 4 resumes what journey 3 interrupted, so its precondition belongs to
    // another journey. When journey 3 did not leave an interrupted attempt, saying so
    // is the honest outcome: asserting here reported journey 4 as a failure of the
    // resume path when the resume path had never been reached, which is a false
    // accusation against the product.
    if (before?.status !== 'retrying') {
      evidence.journeys.journey4 = {
        status: 'not-executed',
        reason: 'journey 3 did not leave an interrupted attempt to resume',
        observedStatus: before?.status ?? null,
        observedErrorCode: before?.errorCode ?? null,
      }
      t.diagnostic(
        `journey 4 not-executed: journey 3 left status ${before?.status ?? 'no row'}, not retrying`,
      )
      return
    }

    const worker = await startWorker({ caseName: 'journey4-restart', opsStateDir })
    assert.notEqual(worker.pid, evidence.journeys.journey3.workerPid, 'the restart is a new process')

    const finished = await pollUntil({
      read: () => readOperation(prisma, world.workspaceId, project.projectId),
      until: (row) => ['succeeded', 'failed'].includes(row.status),
      what: 'the restarted worker to settle the resumed render',
      timeoutMs: 90_000,
      intervalMs: 250,
      whileAlive: (context) => worker.assertStillRunning(context),
    })
    const exit = await worker.terminate({ graceMs: 20_000 })

    assert.equal(finished.status, 'succeeded', `the resumed render settled ${finished.status} (${finished.errorCode})`)
    assert.equal(finished.attempt, before.attempt + 1, 'the resume consumed exactly one more attempt')

    const details = await prisma.v2ProjectProxyRenderOperation.findMany({
      where: { operation: { workspaceId: world.workspaceId, projectId: project.projectId } },
      select: { operationId: true, outputArtifactId: true, outputManifestId: true },
    })
    assert.equal(details.length, 1, `the resume produced ${details.length} promotions, not one`)

    const artifact = await prisma.v2MediaArtifact.findUniqueOrThrow({
      where: { id_workspaceId: { id: details[0].outputArtifactId, workspaceId: world.workspaceId } },
      select: { sha256: true, byteSize: true, artifactKey: true },
    })
    const manifest = await prisma.v2MediaArtifactManifest.findUniqueOrThrow({
      where: { id_workspaceId: { id: details[0].outputManifestId, workspaceId: world.workspaceId } },
      select: { manifestHash: true, artifactId: true },
    })

    // The MP4 is reopened and measured. Invariants, not byte identity: a proxy is a
    // re-encode and two runs of the same encoder need not produce the same bytes.
    // Under the S3 driver the bytes live in MinIO, so the object is fetched to a
    // temporary file rather than the readback being quietly skipped.
    // One path to probe on either driver, through the helper the CI-green journeys
    // use: local answers the content-addressed path, s3 fetches the object
    // version-bound into the readback root. Deliberately NOT a local leftover — under
    // s3 the bytes must come back out of MinIO, or the readback proves nothing about
    // what the product actually promoted.
    const driver = journeyStorageDriver()
    const proxyPath = await storedArtifactPath(objectStore, {
      artifactRoot,
      artifactKey: artifact.artifactKey,
      readbackRoot,
    })
    const { resolveFfprobeBinaryPath } = await import('../../src/v2/infrastructure/media/ffmpeg-binary.ts')
      .then((module) => module.resolveFfprobeBinaryPath ? module : module.default)
    const bytes = await readFile(proxyPath)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const streams = await probeStreams(resolveFfprobeBinaryPath(undefined, undefined), proxyPath)
    const video = streams.find((stream) => stream.codec_type === 'video')
    const audio = streams.find((stream) => stream.codec_type === 'audio')

    assert.equal(digest, artifact.sha256, 'the stored sha256 does not match the promoted bytes')
    assert.equal(Number(artifact.byteSize), bytes.byteLength, 'the stored byteSize does not match the promoted bytes')
    assert.equal(manifest.artifactId, details[0].outputArtifactId, 'the manifest names another artifact')
    assert.ok(manifest.manifestHash, 'the promotion recorded a manifest hash')
    assert.ok(video, 'the promoted proxy has no video stream')
    const duration = Number(video.duration ?? streams[0]?.duration ?? 0)
    assert.ok(
      duration >= PROXY_SECONDS - 1 && duration <= PROXY_SECONDS + 1,
      `the proxy runs ${duration}s, not about the master's ${PROXY_SECONDS}s`,
    )
    assert.ok(audio, "the master carries audio, so the proxy must too")

    evidence.journeys.journey4 = {
      kind: 'real worker restart + real FFmpeg render + ffprobe readback',
      storageDriver: driver,
      workerPid: worker.pid,
      previousWorkerPid: evidence.journeys.journey3.workerPid,
      attemptBefore: before.attempt,
      attemptAfter: finished.attempt,
      promotions: details.length,
      artifactKey: artifact.artifactKey,
      sha256Matches: digest === artifact.sha256,
      byteSize: bytes.byteLength,
      probe: {
        durationSeconds: duration,
        videoCodec: video.codec_name,
        frames: video.nb_read_frames ?? null,
        audioCodec: audio?.codec_name ?? null,
      },
      exit,
      durationMs: Date.now() - startedAt,
    }
  })

  await t.test('journey 5: a latch outranks a healthy gate until an operator releases it', async () => {
    const startedAt = Date.now()
    const project = world.bySlug('unauthorised')
    await resetProxyRenderQueue(prisma)
    const opsStateDir = await createOpsStateDir(root, 'journey5')
    // CONTROLLED: a gate that says everything is fine, and a latch that says stop
    // anyway. The point of the journey is that the second wins.
    await writeGate(opsStateDir, { state: 'open', reasons: [], ttlMs: 120_000, runId })
    await writeLatch(opsStateDir, { runId, reason: 'stop-timeout', detail: 'journey 5 controlled latch' })

    const operationId = await enqueueProxyRender({ prisma, world, project, routes })
    const worker = await startWorker({ caseName: 'journey5-unauthorised', opsStateDir })

    await pollUntil({
      read: () => gateReasons(worker),
      until: (reasons) => reasons.some((entry) => /incident-latch/.test(entry.reason ?? '')),
      what: 'the worker to refuse admission because of the latch',
      timeoutMs: 30_000,
      whileAlive: (context) => worker.assertStillRunning(context),
    })
    const refusedReadings = await holdsAcross({
      read: () => readOperation(prisma, world.workspaceId, project.projectId),
      holds: (row) => row.status === 'queued' && row.attempt === 0,
      samples: 6,
      intervalMs: POLL_MS + 50,
      what: 'a latched worker claiming nothing even with fresh metrics',
    })

    // The operator releases it. The SAME worker — still running, never restarted —
    // must resume on its own.
    await removeLatch(opsStateDir)
    const resumed = await pollUntil({
      read: () => readOperation(prisma, world.workspaceId, project.projectId),
      until: (row) => row.status !== 'queued' || row.attempt > 0,
      what: 'the same worker to resume claiming after the latch was released',
      timeoutMs: 20_000,
      intervalMs: 100,
      whileAlive: (context) => worker.assertStillRunning(context),
    })
    assert.ok(await processIsAlive(worker.pid), 'the worker must not have restarted to resume')

    const reasons = gateReasons(worker)
    const exit = await worker.terminate({ graceMs: 45_000 })

    assert.ok(
      reasons.some((entry) => entry.event === 'worker-admission-gate-closed' && /incident-latch/.test(entry.reason ?? '')),
      `the latch was not named: ${JSON.stringify(reasons)}`,
    )
    assert.ok(
      reasons.some((entry) => entry.event === 'worker-admission-gate-open'),
      `the reopening was not logged: ${JSON.stringify(reasons)}`,
    )
    // Once each: the closed transition and the open one, not one line per poll.
    assert.equal(reasons.filter((entry) => entry.event === 'worker-admission-gate-closed').length, 1)
    assert.equal(reasons.filter((entry) => entry.event === 'worker-admission-gate-open').length, 1)

    evidence.journeys.journey5 = {
      kind: 'real worker, CONTROLLED latch + fresh open gate',
      operationId,
      workerPid: worker.pid,
      refusedPolls: refusedReadings.length,
      resumedStatus: resumed.status,
      resumedAttempt: resumed.attempt,
      gateReasons: reasons,
      exit,
      durationMs: Date.now() - startedAt,
      cleared: await clearQueuedProxyRenders(prisma, world.workspaceId, project.projectId),
    }
  })

  await t.test('journey 7: a monitor that stops writing makes the gate stale and closes admission', async () => {
    const startedAt = Date.now()
    const project = world.bySlug('monitor')
    await resetProxyRenderQueue(prisma)
    const opsStateDir = await createOpsStateDir(root, 'journey7')

    // 7a — the REAL monitor, with a controlled /proc tree and a health stub this test
    // owns. What this proves: the monitor runs, publishes a real gate.json with a
    // ttl, writes its journal, and stops publishing the moment it is SIGKILLed.
    // What it does NOT prove on this host: an OPEN verdict. `isolated-ci` samples
    // every 10 s and the fixture /proc yields no usable CPU delta, so within a
    // journey deadline it answers closed/sample-missing. Recorded, not dressed up.
    const procRoot = join(root, 'proc-fixture')
    await mkdir(procRoot, { recursive: true })
    const fixtures = new URL('../fixtures/host-safety/', import.meta.url)
    for (const [name, file] of [
      ['stat', 'proc-stat-first.txt'],
      ['loadavg', 'proc-loadavg.txt'],
      ['meminfo', 'proc-meminfo.txt'],
      ['vmstat', 'proc-vmstat.txt'],
    ]) {
      await writeFile(join(procRoot, name), await readFile(new URL(file, fixtures)))
    }
    const healthPort = 55_620
    const health = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
    })
    await new Promise((resolve, reject) => {
      health.once('error', reject)
      health.listen(healthPort, '127.0.0.1', resolve)
    })

    let monitorEvidence
    try {
      const monitorUrl = runtimeSafetyDatabaseUrl(cluster.baseUrl, 'journey7-monitor')
      applicationNames.add(new URL(monitorUrl).searchParams.get('application_name'))
      const monitor = spawnSupervised({
        script: 'scripts/ops/host-safety-monitor.mjs',
        runId,
        label: 'host-safety-monitor:journey7',
        deadlineMs: 60_000,
        args: ['--run-id', `${runId}-monitor`, '--profile', 'isolated-ci', '--max-duration-ms', '45000'],
        environment: {
          V2_DATABASE_URL: monitorUrl,
          APOLLO_OPS_STATE_DIR: opsStateDir,
          APOLLO_OPS_PROC_ROOT: procRoot,
          APOLLO_OPS_HEALTH_URL: `http://127.0.0.1:${healthPort}/healthz`,
        },
      })
      spawned.push(monitor)

      const published = await pollUntil({
        read: async () => {
          try { return JSON.parse(await readFile(join(opsStateDir, 'gate.json'), 'utf8')) } catch { return null }
        },
        until: (gate) => gate !== null,
        what: 'the real monitor to publish a gate',
        timeoutMs: 40_000,
        intervalMs: 250,
        whileAlive: (context) => monitor.assertStillRunning(context),
      })
      const journalFiles = await readdir(join(opsStateDir, 'journal')).catch(() => [])

      // SIGKILL, so it cannot publish the closing gate its SIGTERM path would.
      process.kill(monitor.pid, 'SIGKILL')
      await monitor.waitExit()
      await delay(500)
      const afterKill = JSON.parse(await readFile(join(opsStateDir, 'gate.json'), 'utf8'))

      monitorEvidence = {
        kind: 'REAL monitor process, CONTROLLED /proc fixture and health stub',
        monitorPid: monitor.pid,
        publishedState: published.state,
        publishedReasons: published.reasons,
        publishedTtlMs: published.ttlMs,
        journalFiles,
        seqBeforeKill: published.seq,
        seqAfterKill: afterKill.seq,
        openVerdictObserved: published.state === 'open',
        note: 'no open verdict on this host: isolated-ci samples every 10s and a static /proc gives no CPU delta',
      }
      assert.ok(journalFiles.length > 0, 'the real monitor wrote no journal')
      assert.equal(typeof published.ttlMs, 'number', 'the real monitor published no ttl')
      assert.ok(await processIsAlive(monitor.pid) === false, 'the killed monitor is gone')
    } finally {
      await new Promise((resolve) => health.close(resolve))
    }

    // 7b — CONTROLLED: the gate a healthy monitor leaves behind, then the same file
    // back-dated past its ttl with `utimes`. That is precisely what a monitor which
    // stopped writing looks like to a worker, and it is the reading under test.
    // The ttl must outlast the worker's own start-up. At 3 s the gate was already
    // stale by the time tsx finished loading, so the worker never claimed and the
    // journey "failed" on a clock, not on the behaviour it exists to measure.
    await writeGate(opsStateDir, { state: 'open', reasons: [], ttlMs: 60_000, seq: 99, runId })
    const worker = await startWorker({ caseName: 'journey7-stale-gate', opsStateDir })

    const operationId = await enqueueProxyRender({ prisma, world, project, routes })
    await pollUntil({
      read: () => readOperation(prisma, world.workspaceId, project.projectId),
      until: (row) => row.status === 'running' || row.attempt > 0,
      what: 'the worker to claim while the gate is fresh and open',
      timeoutMs: 60_000,
      whileAlive: (context) => worker.assertStillRunning(context),
    })

    // The monitor is gone, so nothing refreshes the file: the same open verdict, now
    // older than its own ttl. That is exactly what a worker sees when a monitor dies.
    await writeGate(opsStateDir, {
      state: 'open', reasons: [], ttlMs: 60_000, seq: 99, runId, ageMs: 180_000,
    })
    await pollUntil({
      read: () => gateReasons(worker),
      until: (reasons) => reasons.some((entry) => /stale-gate/.test(entry.reason ?? '')),
      what: 'the worker to read the gate as stale',
      timeoutMs: 40_000,
      whileAlive: (context) => worker.assertStillRunning(context),
    })

    // A NEW operation, enqueued after the gate went stale, must not be claimed — and
    // the worker itself must keep running, because containment here is refusing
    // admission, not exiting.
    const probe = world.bySlug('stale-probe')
    const probeId = await enqueueProxyRender({ prisma, world, project: probe, routes })
    const stillQueued = { id: probeId }
    const heldQueued = await holdsAcross({
      read: async () => prisma.v2PublicOperation.findUniqueOrThrow({
        where: { id_workspaceId: { id: stillQueued.id, workspaceId: world.workspaceId } },
        select: { status: true, attempt: true },
      }),
      holds: (row) => row.status === 'queued' && row.attempt === 0,
      samples: 6,
      intervalMs: POLL_MS + 50,
      what: 'a stale gate refusing a fresh claim',
    })
    assert.ok(await processIsAlive(worker.pid), 'a stale gate must not kill the worker')

    const reasons = gateReasons(worker)
    const exit = await worker.terminate({ graceMs: 45_000 })

    assert.ok(
      reasons.some((entry) => entry.event === 'worker-admission-gate-closed' && entry.reason === 'stale-gate'),
      `the worker did not report a stale gate: ${JSON.stringify(reasons)}`,
    )

    evidence.journeys.journey7 = {
      realMonitor: monitorEvidence,
      staleGate: {
        kind: 'real worker + real PostgreSQL, CONTROLLED back-dated gate mtime',
        operationId,
        staleProbeOperationId: stillQueued.id,
        workerPid: worker.pid,
        queuedPolls: heldQueued.length,
        workerSurvivedStaleGate: true,
        gateReasons: reasons,
        exit,
      },
      durationMs: Date.now() - startedAt,
    }
  })

  if (!GRACEFUL_SIGNALS_AVAILABLE) {
    for (const name of ['journey2', 'journey3', 'journey4']) {
      evidence.journeys[name] = { status: 'not-executed', reason: GRACEFUL_SIGNALS_REASON }
    }
  }

  await t.test('postflight: no process and no backend of this run survives', async () => {
    for (const handle of spawned) {
      const descendants = await descendantProcessIds(handle.pid, { since: handle.spawnedAt })
      await handle.terminate({ graceMs: 15_000 }).catch(() => undefined)
      for (const pid of [handle.pid, ...descendants]) {
        assert.equal(
          await processIsAlive(pid), false,
          `${handle.label} left PID ${pid} alive`,
        )
      }
    }
    const backends = {}
    for (const name of applicationNames) {
      if (name === new URL(runtimeSafetyDatabaseUrl(cluster.baseUrl, 'suite')).searchParams.get('application_name')) {
        // The suite's own client is still open here; it is disconnected in `t.after`,
        // and the count below would be its own backend.
        continue
      }
      backends[name] = await backendsFor(prisma, name)
      assert.equal(backends[name], 0, `${name} still has ${backends[name]} backends`)
    }
    evidence.postflight.workerBackends = backends
    evidence.postflight.spawnedPids = spawned.map((handle) => ({ label: handle.label, pid: handle.pid }))
  })
})
