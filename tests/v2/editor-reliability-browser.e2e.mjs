import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { assertIsolatedDatabase, sha256Of } from './helpers/capture-journey.mjs'
import {
  encodeSharedProxy,
  auditCensus,
  materialiseProxy,
  replayProxyEnqueue,
  seedEditorReliabilityWorld,
  summarizeInventory,
  tokenizePath,
} from './helpers/editor-reliability-world.mjs'

const { stableSerialize } = await import('../../src/v2/domain/canonical-hash.ts')

/**
 * "Editor confiável" — what one open of the editor actually costs, and what it
 * does when the read behind it refuses.
 *
 * This suite RAISES NOTHING itself. It expects `V2_DATABASE_URL` to already
 * name a migrated disposable PostgreSQL (see the local-postgres recipe) and a
 * production `.next` build to already exist, and it deliberately leaves every
 * governance control at its production default — `APOLLO_GOVERNANCE_ANOMALY_
 * REQUEST_MINIMUM` is NOT set, because the number this suite is here to
 * measure is precisely how close one page open comes to the 20-request floor.
 *
 * Evidence strength is labelled per finding and carried into the JSON:
 *   - `pg-real`      — asserted against rows in PostgreSQL.
 *   - `api-real`     — asserted against a published /v1 route over HTTP.
 *   - `browser-real` — observed in a real Chromium against the real page.
 *   - `transport-stub` — produced by `page.route()` interception. NEVER
 *     evidence about governance or persistence; only about what the UI does
 *     when a read answers that way.
 *
 * Nothing secret is written anywhere: no cookie, no bearer token, no signed
 * URL and no annotation text reaches the log or the JSON.
 */

const enabled = process.env.APOLLO_EDITOR_RELIABILITY_E2E === '1'
const execFileAsync = promisify(execFile)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const serializePrismaRow = (row) => stableSerialize(JSON.parse(JSON.stringify(row)))

function redactDiagnostic(value) {
  const text = value instanceof Error
    ? [value.name, value.message, value.stack, value.cause ? `cause: ${redactDiagnostic(value.cause)}` : '']
        .filter(Boolean)
        .join('\n')
    : String(value)
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s@/]+@/gi, 'postgresql://[redacted]@')
    .replace(/(password|token|secret|authorization)(["'=:\s]+)[^\s,"'}]+/gi, '$1$2[redacted]')
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=\S+/g, '$1=[redacted]')
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next production server exited with ${child.exitCode}`)
    try {
      if ((await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(1_000) })).ok) return
    } catch {}
    await delay(250)
  }
  throw new Error('Next production server did not become ready within 40 seconds')
}

/** SIGTERM, 5s grace, SIGKILL, 2s grace — and refuse to pretend it stopped. */
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  // On Linux `next start` leaves on the SIGTERM itself: exitCode stays null and
  // signalCode becomes 'SIGTERM' (or the code is 143). Both are a clean stop.
  // This promise never rejects — a rejection settled after the race below would
  // surface as an unhandled rejection instead of a cleanup error.
  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve('exit'))
    child.once('error', () => resolve('error'))
  })
  child.kill('SIGTERM')
  let timer
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5_000)
    }),
  ])
  clearTimeout(timer)
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    let killTimer
    const killed = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        killTimer = setTimeout(() => resolve(false), 2_000)
      }),
    ])
    clearTimeout(killTimer)
    if (!killed) throw new Error(`Next production server PID ${child.pid} ignored SIGKILL`)
  }
  if (child.exitCode === null && child.signalCode === null)
    throw new Error(`Next production server PID ${child.pid} did not stop`)
}

/**
 * A recorder that keeps method/path/status/count and nothing identifying.
 *
 * `inFlight` is what makes a duplicate visible: two requests for the same
 * tokenized path that overlap in time are a double read, not a retry.
 */
function createRecorder(baseUrl, tokens) {
  const entries = []
  const requestPhase = new WeakMap()
  const inFlightByPhase = new Map()
  const maxConcurrentByPhase = new Map()
  let active = false
  let label = null

  const keyOf = (url) => tokenizePath(new URL(url).pathname, tokens)
  const inScope = (url) => {
    try {
      const parsed = new URL(url)
      return parsed.origin === baseUrl && parsed.pathname.startsWith('/v1/')
    } catch {
      return false
    }
  }

  return {
    start(nextLabel) {
      label = nextLabel
      active = true
      inFlightByPhase.set(nextLabel, new Map())
      maxConcurrentByPhase.set(nextLabel, new Map())
    },
    async stop() {
      const stoppedLabel = label
      const deadline = Date.now() + 10_000
      let quietSince = null
      let drained = false
      while (Date.now() < deadline) {
        const remaining = [...(inFlightByPhase.get(stoppedLabel)?.values() ?? [])]
          .reduce((sum, count) => sum + count, 0)
        if (remaining === 0) {
          quietSince ??= Date.now()
          if (Date.now() - quietSince >= 200) { drained = true; break }
        } else quietSince = null
        await delay(25)
      }
      const remaining = [...(inFlightByPhase.get(stoppedLabel)?.values() ?? [])]
        .reduce((sum, count) => sum + count, 0)
      assert.equal(drained && remaining === 0, true, `phase ${stoppedLabel} did not drain finite API reads`)
      active = false
      const taken = entries.filter((entry) => entry.phase === stoppedLabel)
      const duplicates = [...(maxConcurrentByPhase.get(stoppedLabel)?.entries() ?? [])]
        .filter(([, value]) => value > 1)
        .map(([key, value]) => ({ path: key, maxConcurrent: value }))
      return { label: stoppedLabel, entries: taken, summary: summarizeInventory(taken), duplicates }
    },
    attach(page) {
      page.on('request', (request) => {
        if (!active || !inScope(request.url())) return
        const phase = label
        const key = `${request.method()} ${keyOf(request.url())}`
        requestPhase.set(request, { phase, key })
        const inFlight = inFlightByPhase.get(phase)
        const maxConcurrent = maxConcurrentByPhase.get(phase)
        const next = (inFlight.get(key) ?? 0) + 1
        inFlight.set(key, next)
        maxConcurrent.set(key, Math.max(maxConcurrent.get(key) ?? 0, next))
      })
      page.on('requestfinished', (request) => {
        const captured = requestPhase.get(request)
        if (!captured) return
        const inFlight = inFlightByPhase.get(captured.phase)
        const key = captured.key
        inFlight.set(key, Math.max(0, (inFlight.get(key) ?? 1) - 1))
        requestPhase.delete(request)
      })
      page.on('requestfailed', (request) => {
        const captured = requestPhase.get(request)
        if (!captured) return
        const inFlight = inFlightByPhase.get(captured.phase)
        const key = captured.key
        inFlight.set(key, Math.max(0, (inFlight.get(key) ?? 1) - 1))
        entries.push({
          phase: captured.phase,
          method: request.method(),
          path: keyOf(request.url()),
          status: 'request-failed',
          code: request.failure()?.errorText ?? null,
          at: Date.now(),
        })
        requestPhase.delete(request)
      })
      page.on('response', (response) => {
        const captured = requestPhase.get(response.request())
        if (!captured) return
        const entry = {
          phase: captured.phase,
          method: response.request().method(),
          path: keyOf(response.url()),
          status: response.status(),
          contentRange: response.headers()['content-range'] ? 'present' : null,
          retryAfter: response.headers()['retry-after'] ?? null,
          at: Date.now(),
        }
        entries.push(entry)
        if (response.status() >= 400)
          void response
            .json()
            .then((body) => {
              entry.code = body?.error?.code ?? null
              entry.requestId = body?.error?.requestId ?? body?.requestId ?? null
            })
            .catch(() => {
              entry.code = 'response-body-unavailable'
            })
      })
    },
    all: () => entries,
  }
}

/** Open a project the way an operator does: from the list, by clicking it. */
async function openProjectCard(page, baseUrl, projectName) {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
  const card = page.locator('article').filter({ hasText: projectName }).first()
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  await card.getByRole('button', { name: 'Abrir', exact: true }).click()
  await page.waitForURL('**/projects/**', { timeout: 20_000 })
}

/** The page's own read ledger, when the build exposes one. */
async function readLedger(page) {
  return page
    .evaluate(() => (typeof window.__apolloEditorReads === 'function' ? window.__apolloEditorReads() : null))
    .catch((error) => ({ unavailable: error instanceof Error ? error.name : 'unknown' }))
}

/** What the page must not let anyone do while the review read is refused. */
async function dependentActionState(page) {
  const state = {}
  for (const id of ['review-save', 'review-patch-apply', 'review-batch-apply', 'review-batch-prepare']) {
    const locator = page.getByTestId(id)
    const count = await locator.count()
    state[id] = count === 0 ? 'absent' : (await locator.first().isDisabled().catch(() => null)) ? 'disabled' : 'enabled'
  }
  const previewCount = await page.getByTestId('project-preview').count()
  state.previewVideoPresent = previewCount > 0
  state.previewIsVideoElement = previewCount
    ? await page.getByTestId('project-preview').first().evaluate((node) => node.tagName.toLowerCase() === 'video')
    : false
  return state
}

async function assertWorkspaceFixtureHydrates(prisma, workspaceId, projectId, phase) {
  const { PrismaProjectWorkspaceQueryRepository } = await import(
    '../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts'
  )
  try {
    const workspace = await new PrismaProjectWorkspaceQueryRepository(prisma).read({ workspaceId, projectId })
    assert.ok(workspace, `workspace fixture disappeared during ${phase}`)
    return { phase, status: 'hydrated', currentVersionId: workspace.project.currentVersionId ?? null }
  } catch (error) {
    throw new Error(
      `workspace fixture failed repository hydration during ${phase}: ` +
        String(error instanceof Error ? `${error.name}: ${error.message}` : error),
      { cause: error },
    )
  }
}

async function assertTimelineFixtureHydrates(prisma, workspaceId, projectId, phase) {
  const { PrismaManualEditRepository } = await import(
    '../../src/v2/infrastructure/prisma/manual-edit-repository.ts'
  )
  const { readManualTimelineService } = await import('../../src/v2/application/manual-edit.ts')
  try {
    const timeline = await readManualTimelineService({ repository: new PrismaManualEditRepository(prisma) })({
      workspaceId,
      projectId,
    })
    return { phase, status: 'hydrated', editPlanHash: timeline.editPlanHash }
  } catch (error) {
    throw new Error(
      `timeline fixture failed repository hydration during ${phase}: ` +
        String(error instanceof Error ? `${error.name}: ${error.message}` : error),
      { cause: error },
    )
  }
}

/** The refusal block, read exactly through the ids the fix published. */
async function refusalBlock(page) {
  const block = page.getByTestId('review-unavailable')
  const code = page.getByTestId('review-unavailable-code')
  const retry = page.getByTestId('review-retry')
  const proxyCode = page.getByTestId('proxy-review-unavailable-code')
  const codeText = (await code.count()) ? (await code.first().innerText()).slice(0, 160) : null
  const retryText = (await retry.count()) ? (await retry.first().innerText()).slice(0, 80) : null
  return {
    blockVisible: await block.count(),
    codeText,
    codeNamesRequestId: codeText !== null && /request\s+\S+/i.test(codeText),
    retryPresent: await retry.count(),
    retryText,
    retryDisabled: (await retry.count()) ? await retry.first().isDisabled().catch(() => null) : null,
    retryCountsDown: retryText !== null && /Tentar novamente em \d+\s*s/i.test(retryText),
    proxyReviewUnavailableCode: (await proxyCode.count())
      ? (await proxyCode.first().innerText()).slice(0, 160)
      : null,
    dependentActions: await dependentActionState(page),
  }
}

/** The editor has settled when the preview or a refusal is on screen. */
async function waitForEditorSettle(page) {
  // Settle on what the page actually reaches, not on what it ought to reach:
  // an inventory of a page that refused to mount its preview is still an
  // inventory, and swallowing it would hide the very state worth measuring.
  // Capped hard: the second open has to land inside the same 60-second window
  // as the first, or the request-rate floor is never exercised at all.
  const markers = ['project-preview', 'review-unavailable', 'proxy-review-gate', 'manual-editor']
  const deadline = Date.now() + 8_000
  let reached = null
  while (Date.now() < deadline && reached === null) {
    for (const marker of markers) {
      if ((await page.getByTestId(marker).count()) > 0) {
        reached = marker
        break
      }
    }
    if (reached === null) await delay(250)
  }
  // Let the mount-time fan-out land before the inventory is closed.
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
  if (reached === null) {
    const heading = await page
      .locator('h1, h2')
      .first()
      .innerText()
      .catch(() => '')
    return `no-marker(${heading.slice(0, 60).replace(/\s+/g, ' ')})`
  }
  return reached
}

test(
  'the editor opens, plays, annotates once and refuses readably — with the cost of each open recorded',
  { skip: !enabled, timeout: 600_000 },
  async () => {
    assertIsolatedDatabase()
    const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
    const root = await mkdtemp(join(tmpdir(), 'apollo-editor-reliability-'))
    const artifactRoot = join(root, 'artifacts')
    // Evidence lives under the run's temp root unless a durable directory is
    // named. Never inside the repository, either way.
    const evidenceDir = process.env.APOLLO_EDITOR_RELIABILITY_EVIDENCE_DIR
      ? join(process.env.APOLLO_EDITOR_RELIABILITY_EVIDENCE_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      : join(root, 'evidence')
    const suffix = randomUUID().slice(0, 8)
    const evidence = {
      suffix,
      startedAt: new Date().toISOString(),
      governance: { anomalyRequestMinimumOverride: process.env.APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM ?? null },
      phases: [],
      findings: [],
    }
    const record = (strength, name, detail) => {
      evidence.findings.push({ strength, name, ...detail })
    }

    let world, proxy, browser, server, testFailure, serverLogs = ''
    const cleanupErrors = []
    try {
      await mkdir(artifactRoot, { recursive: true })
      await mkdir(evidenceDir, { recursive: true })

      proxy = await encodeSharedProxy({ artifactRoot, key: `editor-reliability/${suffix}/source.mp4`, seconds: 3, fps: 30 })
      world = await seedEditorReliabilityWorld({
        prisma,
        artifactRoot,
        suffix,
        proxy,
        projects: [
          { slug: 'clean', name: `Editor confiavel ${suffix}` },
          { slug: 'conflict', name: `Editor conflito ${suffix}` },
          { slug: 'no-review', name: `Editor sem laudo ${suffix}` },
        ],
      })
      const clean = world.bySlug('clean')
      const conflict = world.bySlug('conflict')
      const noReview = world.bySlug('no-review')
      evidence.fixtureHydration = [
        await assertWorkspaceFixtureHydrates(prisma, world.workspaceId, clean.projectId, 'after-seed'),
        await assertWorkspaceFixtureHydrates(prisma, world.workspaceId, conflict.projectId, 'after-seed'),
        await assertWorkspaceFixtureHydrates(prisma, world.workspaceId, noReview.projectId, 'after-seed'),
      ]
      evidence.materialisation = {
        path: 'POST color-pipeline-compilations + POST lut-selection (enqueue) + test driver of the real worker factory with diagnostics enabled',
        seeded: 'source recording artifact/manifest/probe rows and the compiled base version only',
        source: {
          codec: proxy.probe.codec,
          audioCodec: proxy.probe.audioCodec,
          audioSampleRate: proxy.probe.audioSampleRate,
          decodedFrames: proxy.probe.decodedFrames,
          seconds: proxy.seconds,
          fps: proxy.fps,
          byteSize: proxy.byteSize,
        },
      }

      const username = `editor-ui-${suffix}`
      const password = `Editor-${suffix}-secure-passphrase`
      const port = await freePort()
      const baseUrl = `http://127.0.0.1:${port}`
      // Acceptance evidence cannot mix a server build from one checkout with
      // the worker factory imported from another revision.
      const appRoot = process.env.APOLLO_EDITOR_RELIABILITY_APP_ROOT ?? process.cwd()
      assert.equal(
        resolve(appRoot),
        resolve(process.cwd()),
        'acceptance E2E requires the server build and worker factory from the same checkout',
      )
      evidence.appRoot = appRoot
      server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
        cwd: appRoot,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: 'production',
          APOLLO_AUTH_MODE: 'bootstrap',
          APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true',
          APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
          APOLLO_UI_USERNAME: username,
          APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(password, `editor-salt-${suffix}`),
          APOLLO_UI_SESSION_SECRET: `editor-session-${suffix}-at-least-32-bytes-long`,
          APOLLO_UI_API_CLIENT_ID: world.issued.client.id,
          APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
          APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      server.stdout.on('data', (chunk) => {
        serverLogs += String(chunk)
      })
      server.stderr.on('data', (chunk) => {
        serverLogs += String(chunk)
      })
      await waitForServer(baseUrl, server)

      // The proxy is materialised by the product, through the published route
      // and the test driver of the real worker factory. Nothing below writes an operation row.
      const workerEnvironment = {
        V2_DATABASE_URL: process.env.V2_DATABASE_URL,
        APOLLO_API_ENVIRONMENT: 'production',
        APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        // The render worker seals its recipe parameters before it writes a
        // manifest; without a key it refuses to start rather than storing them
        // in the clear. This key is generated here, never read from a file.
        APOLLO_PROTECTED_PAYLOAD_KEY_ID: `editor-reliability-${suffix}`,
        APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64url'),
      }
      // A real rendered proxy is a prerequisite of this acceptance journey.
      // Source-master bytes cannot stand in for a proxy or make the positive
      // playback/annotation checks optional.
      evidence.materialisation.renderAttempts = []
      const immutableBases = new Map()
      for (const project of [clean, conflict]) {
        const baseVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({
          where: { id: project.versionId },
          include: { editPlanSnapshot: true },
        })
        const serializedBaseVersion = serializePrismaRow(baseVersion)
        assert.notEqual(
          serializePrismaRow({ ...baseVersion, createdAt: new Date(baseVersion.createdAt.getTime() + 1) }),
          serializedBaseVersion,
          'the immutable-row comparison is insensitive to a changed timestamp',
        )
        immutableBases.set(project.projectId, {
          version: serializedBaseVersion,
          editPlanSnapshot: serializePrismaRow(baseVersion.editPlanSnapshot),
        })
      }
      for (const project of [clean, conflict]) {
        try {
          await materialiseProxy({
            prisma,
            baseUrl,
            token: world.issued.token,
            workspaceId: world.workspaceId,
            project,
            workerEnvironment,
            serverLogs: () => serverLogs,
          })
          const baseVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({
            where: { id: project.versionId },
            include: { editPlanSnapshot: true },
          })
          const currentProject = await prisma.v2Project.findUniqueOrThrow({
            where: { id: project.projectId },
            include: { currentVersion: { include: { editPlanSnapshot: true } } },
          })
          const captured = immutableBases.get(project.projectId)
          assert.equal(serializePrismaRow(baseVersion), captured.version, `${project.slug} LUT selection mutated its base version`)
          assert.equal(serializePrismaRow(baseVersion.editPlanSnapshot), captured.editPlanSnapshot, `${project.slug} LUT selection mutated its base EditPlan snapshot`)
          assert.notEqual(currentProject.currentVersion.editPlanSnapshotId, baseVersion.editPlanSnapshotId, `${project.slug} LUT selection reused its base EditPlan snapshot`)
          assert.equal(
            JSON.parse(currentProject.currentVersion.editPlanSnapshot.contentJson).projectVersionId,
            currentProject.currentVersion.id,
            `${project.slug} LUT result EditPlan names another version`,
          )
          evidence.materialisation.renderAttempts.push({
            project: project.slug,
            status: 'succeeded',
            operationId: project.proxyOperationId,
            elapsedMs: project.timeToFirstProxyMs,
          })
        } catch (error) {
          const row = await prisma.v2PublicOperation.findFirst({
            where: { workspaceId: world.workspaceId, projectId: project.projectId, type: 'project-proxy-render' },
            orderBy: { createdAt: 'desc' },
            select: { id: true, status: true, phase: true, attempt: true, errorCode: true, errorMessage: true },
          })
          evidence.materialisation.renderAttempts.push({
            project: project.slug,
            status: 'failed',
            operation: row,
            failure: redactDiagnostic(error),
            serverLogTail: redactDiagnostic(serverLogs.slice(-12_000)),
          })
          throw new Error(
            `required proxy render failed for ${project.slug}: ${JSON.stringify(row)}; ` +
              redactDiagnostic(error),
            { cause: error },
          )
        }
      }
      const renderExecuted = evidence.materialisation.renderAttempts.every(
        (attempt) => attempt.status === 'succeeded',
      )
      assert.equal(renderExecuted, true, 'both projects must have a real rendered proxy')
      assert.equal(clean.proxyHash, conflict.proxyHash, 'identical measured inputs did not produce identical proxy bytes')
      assert.notEqual(clean.proxyArtifactId, conflict.proxyArtifactId, 'equal bytes collapsed two project artifact identities')
      assert.notEqual(clean.proxyManifestId, conflict.proxyManifestId, 'equal bytes collapsed two project manifest identities')
      for (const project of [clean, conflict]) {
        assert.equal(project.proxyManifest.artifactId, project.proxyArtifactId, `${project.slug} manifest names another artifact`)
        assert.equal(project.proxyManifest.recipeId, 'editorial-proxy', `${project.slug} used an unexpected recipe`)
        assert.equal(project.proxyVersionProjectId, project.projectId, `${project.slug} output names another project's version`)
        assert.deepEqual(
          project.proxyLineage.map((edge) => edge.sourceArtifactId),
          [project.sourceArtifactId],
          `${project.slug} lineage resolved equal bytes to another project's source`,
        )
      }
      evidence.equalBytesIsolation = {
        sha256: clean.proxyHash,
        clean: { artifactId: clean.proxyArtifactId, manifestId: clean.proxyManifestId, lineage: clean.proxyLineage },
        conflict: { artifactId: conflict.proxyArtifactId, manifestId: conflict.proxyManifestId, lineage: conflict.proxyLineage },
      }
      const replayCountsBefore = {
        snapshots: await prisma.v2ProjectSnapshot.count({ where: { workspaceId: world.workspaceId, projectId: clean.projectId } }),
        versions: await prisma.v2ProjectVersion.count({ where: { workspaceId: world.workspaceId, projectId: clean.projectId } }),
      }
      evidence.enqueueReplay = await replayProxyEnqueue({
        prisma, baseUrl, token: world.issued.token, workspaceId: world.workspaceId, project: clean,
      })
      assert.ok([200, 201].includes(evidence.enqueueReplay.status), 'proxy enqueue replay was refused')
      assert.equal(evidence.enqueueReplay.operationId, clean.proxyOperationId, 'enqueue replay changed operation identity')
      assert.equal(evidence.enqueueReplay.operations, 1, 'enqueue replay created another render operation')
      const replayCountsAfter = {
        snapshots: await prisma.v2ProjectSnapshot.count({ where: { workspaceId: world.workspaceId, projectId: clean.projectId } }),
        versions: await prisma.v2ProjectVersion.count({ where: { workspaceId: world.workspaceId, projectId: clean.projectId } }),
      }
      assert.deepEqual(replayCountsAfter, replayCountsBefore, 'LUT replay created another snapshot or project version')
      evidence.enqueueReplay.snapshotAndVersionCounts = { before: replayCountsBefore, after: replayCountsAfter }
      evidence.fixtureHydration.push(
        await assertWorkspaceFixtureHydrates(prisma, world.workspaceId, clean.projectId, 'after-render'),
        await assertWorkspaceFixtureHydrates(prisma, world.workspaceId, conflict.projectId, 'after-render'),
      )
      evidence.fixtureHydration.push(
        await assertTimelineFixtureHydrates(prisma, world.workspaceId, clean.projectId, 'after-render'),
        await assertTimelineFixtureHydrates(prisma, world.workspaceId, conflict.projectId, 'after-render'),
      )
      evidence.materialisation.note = 'elapsedMs is the wall clock of enqueue + one real-factory test-driver pass, not the product metric timeToFirstProxyMs'

      // Prove the clean project is readable before the browser opens. A 409 is
      // a hard fixture/product failure, never a condition this journey repairs.
      const bearer = `Bearer ${world.issued.token}`
      const probeWorkspace = async (label) => {
        const response = await fetch(
          `${baseUrl}/v1/projects/${encodeURIComponent(clean.projectId)}/workspace`,
          { headers: { authorization: bearer } },
        )
        const body = await response.json().catch(() => ({}))
        return {
          label,
          status: response.status,
          code: body?.error?.code ?? null,
          message: body?.error?.message ?? null,
          requestId: body?.error?.requestId ?? null,
        }
      }
      evidence.workspaceProbe = [await probeWorkspace('after-materialisation')]
      console.log(`editor-reliability WORKSPACE_PROBE ${JSON.stringify(evidence.workspaceProbe[0])}`)
      assert.equal(
        evidence.workspaceProbe[0].status,
        200,
        `the seeded clean project must hydrate before the browser opens: ${JSON.stringify(evidence.workspaceProbe[0])}`,
      )

      // Before a single page opens, identify incomplete credential audit. For
      // tables with actorKind, only external rows require those credential
      // fields; internal rows legitimately leave them null.
      evidence.auditCensus = await auditCensus({ prisma, workspaceId: world.workspaceId })
      console.log(`editor-reliability AUDIT_CENSUS ${JSON.stringify(evidence.auditCensus)}`)

      const executablePath = [
        process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
      ].find((candidate) => candidate && existsSync(candidate))
      assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to a Chromium executable')
      const { chromium } = await import('playwright-core')
      browser = await chromium.launch({ executablePath, headless: true })
      const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
      context.setDefaultTimeout(25_000)
      context.setDefaultNavigationTimeout(30_000)
      const page = await context.newPage()
      const jsErrors = []
      page.on('pageerror', (error) => jsErrors.push(error.message))

      const tokens = [
        [clean.projectId, '{projectId}'],
        [conflict.projectId, '{projectId}'],
        [noReview.projectId, '{projectId}'],
        [clean.versionId, '{versionId}'],
        [conflict.versionId, '{versionId}'],
        [clean.proxyArtifactId, '{artifactId}'],
        [conflict.proxyArtifactId, '{artifactId}'],
        [clean.sourceArtifactId, '{artifactId}'],
        [conflict.sourceArtifactId, '{artifactId}'],
        [world.workspaceId, '{workspaceId}'],
      ]
      const recorder = createRecorder(baseUrl, tokens)
      recorder.attach(page)

      await page.goto(`${baseUrl}/login?next=${encodeURIComponent('/')}`)
      await page.locator('input[name="username"]').fill(username)
      await page.locator('input[name="password"]').fill(password)
      await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 })

      // ---------------------------------------------------------------- STEP 1
      const opens = []
      const openWindowStart = Date.now()
      for (const label of ['open-1', 'open-2']) {
        recorder.start(label)
        await openProjectCard(page, baseUrl, clean.name)
        const settled = await waitForEditorSettle(page)
        const inventory = await recorder.stop()
        inventory.settledOn = settled
        inventory.readLedger = await readLedger(page)
        inventory.gets = inventory.entries.filter((entry) => entry.method === 'GET').length
        inventory.distinctEndpoints = new Set(
          inventory.entries.filter((entry) => entry.method === 'GET').map((entry) => entry.path),
        ).size
        inventory.refusals = inventory.entries.filter(
          (entry) => typeof entry.status === 'number' && [401, 403, 409, 429].includes(entry.status),
        )
        opens.push(inventory)
        evidence.phases.push(inventory)
      }
      const sameMinute = Date.now() - openWindowStart < 60_000
      evidence.baseline = {
        bothOpensWithinOneMinute: sameMinute,
        elapsedMs: Date.now() - openWindowStart,
        perOpen: opens.map((entry) => ({
          label: entry.label,
          settledOn: entry.settledOn,
          gets: entry.gets,
          distinctEndpoints: entry.distinctEndpoints,
          duplicates: entry.duplicates,
          readLedger: entry.readLedger,
          refusals: entry.refusals.map((refusal) => ({
            path: refusal.path,
            status: refusal.status,
            code: refusal.code ?? null,
            requestId: refusal.requestId ?? null,
          })),
        })),
        combinedGetsInWindow: opens.reduce((total, entry) => total + entry.gets, 0),
        anomalyFloor: 20,
      }
      record('browser-real', 'page-open-read-cost', evidence.baseline)
      assert.deepEqual(opens.flatMap((entry) => entry.refusals), [], 'clean editor opens contained refused API reads')
      assert.equal(sameMinute, true, 'the two measured opens did not occur inside one governance window')
      assert.ok(
        opens.every((entry) => entry.settledOn === 'project-preview'),
        `the editor did not mount its preview on both opens: ${opens.map((entry) => entry.settledOn).join(', ')}`,
      )
      // Written and printed HERE, not only at the end: a later assertion that
      // fails must not take the measurement down with it.
      await writeFile(
        join(evidenceDir, 'page-open-inventory.json'),
        `${JSON.stringify({ suffix, baseline: evidence.baseline, phases: evidence.phases }, null, 2)}\n`,
        'utf8',
      )
      console.log(`editor-reliability BASELINE ${JSON.stringify(evidence.baseline)}`)
      await page.screenshot({ path: join(evidenceDir, 'open-2-editor.png'), fullPage: false })

      // ---------------------------------------------------------------- STEP 2
      const playback = { strength: 'browser-real' }
      const preview = page.getByTestId('project-preview')
      const previewPresent = (await preview.count()) > 0
      playback.previewPresent = previewPresent
      assert.equal(previewPresent, true, 'project-preview did not mount; playback was not executed')
      if (previewPresent) {
        await preview.first().scrollIntoViewIfNeeded().catch(() => {})
        playback.ready = await preview.first().evaluate(async (video) => {
          for (let attempt = 0; attempt < 120 && video.readyState < 2; attempt += 1)
            await new Promise((resolve) => setTimeout(resolve, 250))
          return {
            readyState: video.readyState,
            duration: Number.isFinite(video.duration) ? video.duration : null,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            mediaError: video.error ? video.error.code : null,
          }
        })
        playback.play = await preview.first().evaluate(async (video) => {
          video.muted = true
          const before = video.currentTime
          await video.play().catch(() => {})
          await new Promise((resolve) => setTimeout(resolve, 1_100))
          return { paused: video.paused, before, after: video.currentTime }
        })
        playback.pause = await preview.first().evaluate(async (video) => {
          video.pause()
          const first = video.currentTime
          await new Promise((resolve) => setTimeout(resolve, 600))
          return { paused: video.paused, first, second: video.currentTime }
        })
        playback.seek = await preview.first().evaluate(async (video) => {
          const target = 1.5
          const seeked = new Promise((resolve) => {
            video.addEventListener('seeked', () => resolve(true), { once: true })
            setTimeout(() => resolve(false), 5_000)
          })
          video.currentTime = target
          const fired = await seeked
          return { target, fired, currentTime: video.currentTime }
        })
        assert.equal(playback.ready.mediaError, null, 'the preview reported a media error')
        assert.ok(playback.ready.readyState >= 2, `preview never had data: readyState=${playback.ready.readyState}`)
        assert.equal(playback.play.paused, false, 'play() did not leave the preview playing')
        assert.ok(
          playback.play.after > playback.play.before,
          `currentTime did not advance: ${playback.play.before} -> ${playback.play.after}`,
        )
        assert.equal(playback.pause.paused, true, 'pause() did not pause the preview')
        assert.ok(
          Math.abs(playback.pause.second - playback.pause.first) < 0.05,
          `currentTime kept moving while paused: ${playback.pause.first} -> ${playback.pause.second}`,
        )
        assert.equal(playback.seek.fired, true, 'no seeked event after setting currentTime')
        assert.ok(
          Math.abs(playback.seek.currentTime - playback.seek.target) < 0.35,
          `seek landed at ${playback.seek.currentTime}, expected ${playback.seek.target}`,
        )
      }
      record('browser-real', 'playback', playback)

      // Media identity + range, proved at the route and against PostgreSQL.
      const authorization = `Bearer ${world.issued.token}`
      const contentUrl = `${baseUrl}/v1/artifacts/${encodeURIComponent(clean.proxyArtifactId)}/content`
      const rangeResponse = await fetch(contentUrl, { headers: { authorization, range: 'bytes=0-1023' } })
      const rangeBytes = Buffer.from(await rangeResponse.arrayBuffer())
      const fullResponse = await fetch(contentUrl, { headers: { authorization } })
      const fullBytes = Buffer.from(await fullResponse.arrayBuffer())
      const servedPath = join(evidenceDir, 'served-proxy.mp4')
      await writeFile(servedPath, fullBytes)
      const storedArtifact = await prisma.v2MediaArtifact.findUniqueOrThrow({
        where: { id_workspaceId: { id: clean.proxyArtifactId, workspaceId: world.workspaceId } },
        select: { sha256: true, byteSize: true, artifactKey: true },
      })
      const media = {
        rangeStatus: rangeResponse.status,
        contentRange: rangeResponse.headers.get('content-range') ? 'present' : null,
        rangeByteLength: rangeBytes.byteLength,
        fullStatus: fullResponse.status,
        servedSha256MatchesDatabase: sha256Of(fullBytes) === storedArtifact.sha256,
        databaseByteSize: Number(storedArtifact.byteSize),
        servedByteSize: fullBytes.byteLength,
        browserObservedPartial: recorder
          .all()
          .some((entry) => entry.status === 206 && entry.path.includes('/content')),
      }
      assert.equal(media.rangeStatus, 206, 'a Range request did not answer 206')
      assert.equal(media.contentRange, 'present', '206 answered without Content-Range')
      assert.equal(media.servedSha256MatchesDatabase, true, 'served bytes do not match the stored sha256')
      const probed = await execFileAsync(
        proxy.ffprobePath,
        ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
          'stream=codec_name,nb_read_frames,duration,width,height', '-of', 'json', servedPath],
        { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      )
      const probedStream = JSON.parse(probed.stdout).streams?.[0] ?? {}
      media.ffprobe = {
        codec: probedStream.codec_name ?? null,
        frames: Number(probedStream.nb_read_frames ?? 0),
        duration: Number(probedStream.duration ?? 0),
        width: Number(probedStream.width ?? 0),
        height: Number(probedStream.height ?? 0),
      }
      assert.ok(media.ffprobe.frames > 0, 'ffprobe counted zero frames in the served file')
      assert.equal(media.ffprobe.frames, 90, 'the served three-second/30fps proxy did not contain exactly 90 frames')
      assert.ok(Math.abs(media.ffprobe.duration - 3) < 0.05, `proxy duration was ${media.ffprobe.duration}, expected 3s`)
      record('api-real+pg-real', 'media-identity-and-range', media)

      // One valid annotation, created once and replayed once.
      const annotationsUrl = `${baseUrl}/v1/projects/${encodeURIComponent(clean.projectId)}/annotations`
      const idempotencyKey = `editor-reliability-${suffix}-annotation`
      const annotationBody = {
        projectVersionId: clean.proxyVersionId,
        proxyArtifactId: clean.proxyArtifactId,
        proxyHash: clean.proxyHash,
        frame: 30,
        timeRangeMs: [1_000, 1_000],
        screenshotRef: 'data:image/jpeg;base64,/9j/2Q==',
        scope: 'region',
        region: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
        targetIds: [],
        text: 'Manter a legenda abaixo do rosto.',
      }
      const postAnnotation = () =>
        fetch(annotationsUrl, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify(annotationBody),
        })
      const firstResponse = await postAnnotation()
      const firstPayload = await firstResponse.json()
      const annotationExecuted = firstResponse.status === 201
      assert.equal(
        annotationExecuted,
        true,
        `annotation creation was not executed: ${firstResponse.status} ${firstPayload?.error?.code ?? ''}`,
      )
      const replayResponse = await postAnnotation()
      const replayPayload = await replayResponse.json()
      const storedAnnotations = await prisma.v2ReviewAnnotation.findMany({
        where: { workspaceId: world.workspaceId, projectId: clean.projectId },
        select: { id: true, idempotencyKey: true, actorCredentialId: true, actorContextHash: true },
      })
      const annotation = {
        firstStatus: firstResponse.status,
        replayStatus: replayResponse.status,
        replayedFlag: replayPayload?.data?.replayed ?? null,
        sameId: replayPayload?.data?.annotation?.id === firstPayload?.data?.annotation?.id,
        rowsInDatabase: storedAnnotations.length,
        rowsWithCredentialAudit: storedAnnotations.filter(
          (row) => row.actorCredentialId && row.actorContextHash,
        ).length,
      }
      if (annotationExecuted) {
        assert.equal(annotation.replayStatus, 200, 'annotation replay did not return HTTP 200')
        assert.equal(annotation.replayedFlag, true, 'the replay was not reported as a replay')
        assert.equal(annotation.sameId, true, 'the replay produced a different annotation id')
        assert.equal(annotation.rowsInDatabase, 1, 'the replay duplicated the annotation row')
        assert.equal(annotation.rowsWithCredentialAudit, 1, 'the annotation was stored without credential audit')
        record('api-real+pg-real', 'annotation-idempotency', annotation)
      } else {
        // A refused annotation must still leave nothing behind.
        assert.equal(annotation.rowsInDatabase, 0, 'a refused annotation wrote a row anyway')
      }

      // Third open: the same card, now with one annotation behind it.
      recorder.start('open-3-after-annotation')
      await openProjectCard(page, baseUrl, clean.name)
      const thirdSettle = await waitForEditorSettle(page)
      const third = await recorder.stop()
      third.settledOn = thirdSettle
      third.readLedger = await readLedger(page)
      third.gets = third.entries.filter((entry) => entry.method === 'GET').length
      third.distinctEndpoints = new Set(
        third.entries.filter((entry) => entry.method === 'GET').map((entry) => entry.path),
      ).size
      third.refusals = third.entries.filter(
        (entry) => typeof entry.status === 'number' && [401, 403, 409, 429].includes(entry.status),
      )
      evidence.phases.push(third)
      assert.equal(third.settledOn, 'project-preview', 'the editor did not reopen on the persisted annotation')
      record('browser-real', 'reopen-after-annotation', {
        gets: third.gets,
        distinctEndpoints: third.distinctEndpoints,
        duplicates: third.duplicates,
        settledOn: third.settledOn,
        readLedger: third.readLedger,
        refusals: third.refusals.map((entry) => ({ path: entry.path, status: entry.status, code: entry.code ?? null })),
      })
      await page.screenshot({ path: join(evidenceDir, 'clean-editor-after-annotation.png') })

      // ---------------------------------------------------------------- STEP 3
      // PG-real: probe whether PostgreSQL accepts a null credential-audit row.
      const legacyId = randomUUID()
      // This probe establishes only whether PostgreSQL accepts the null-audit
      // shape. The independent hash-tamper scenario below exercises hydration.
      let legacyInsert = { inserted: false, refusedBy: null }
      try {
      await prisma.v2ReviewAnnotation.create({
        data: {
          id: legacyId,
          workspaceId: world.workspaceId,
          projectId: conflict.projectId,
          projectVersionId: conflict.proxyVersionId,
          proxyArtifactId: conflict.proxyArtifactId,
          proxyHash: conflict.proxyHash,
          frame: 10,
          timeStartMs: 333,
          timeEndMs: 333,
          scope: 'region',
          regionX: 0.2,
          regionY: 0.2,
          regionWidth: 0.2,
          regionHeight: 0.2,
          targetIdsJson: JSON.stringify([]),
          applicationScopeJson: JSON.stringify({ kind: 'region', formatIds: ['9:16'], localeIds: ['pt-BR'] }),
          affectedCount: 1,
          screenshotRef: 'data:image/jpeg;base64,/9j/2Q==',
          text: 'Anotacao historica sem auditoria de credencial.',
          authorType: 'human',
          authorId: 'legacy-author',
          authorName: 'Legacy Author',
          actorClientId: null,
          actorCredentialId: null,
          actorEnvironment: null,
          actorAuthenticationKind: null,
          actorContextHash: null,
          status: 'open',
          idempotencyKey: `legacy-${suffix}`,
          requestFingerprint: sha256Of(Buffer.from(`legacy:${legacyId}`)),
          createdAt: world.createdAt,
          updatedAt: world.createdAt,
        },
      })
      legacyInsert.inserted = true
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        legacyInsert.refusedBy = (message.match(/constraint "([^"]+)"/) ?? [])[1] ?? message.slice(0, 200)
      }
      record('pg-real', 'legacy-annotation-insertability', {
        ...legacyInsert,
        meaning: legacyInsert.inserted
          ? 'the legacy shape can still be written, so the 409 is reachable for new rows too'
          : 'PostgreSQL refuses a review annotation with no credential audit; the separate hash-tamper scenario proves the hydrated 409 path',
      })
      assert.equal(legacyInsert.inserted, false, 'PostgreSQL accepted an annotation with null credential audit')

      // Create an otherwise valid annotation through the public API, then
      // corrupt only its context hash inside this disposable fixture. A valid
      // 64-hex value passes the storage CHECK while hydration must detect that
      // it no longer matches the authenticated actor projection.
      const conflictCreate = await fetch(
        `${baseUrl}/v1/projects/${encodeURIComponent(conflict.projectId)}/annotations`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': `editor-reliability-${suffix}-conflict-annotation`,
          },
          body: JSON.stringify({
            ...annotationBody,
            projectVersionId: conflict.proxyVersionId,
            proxyArtifactId: conflict.proxyArtifactId,
            proxyHash: conflict.proxyHash,
            text: 'Anotação válida cuja projeção de auditoria será corrompida.',
          }),
        },
      )
      const conflictCreatePayload = await conflictCreate.json()
      assert.equal(conflictCreate.status, 201, `could not create the conflict fixture through API: ${conflictCreate.status}`)
      const conflictAnnotationId = conflictCreatePayload?.data?.annotation?.id
      assert.ok(conflictAnnotationId, 'conflict annotation API response omitted its id')
      const corruptedActorContextHash = 'e'.repeat(64)
      await prisma.v2ReviewAnnotation.update({
        where: { id: conflictAnnotationId },
        data: { actorContextHash: corruptedActorContextHash },
      })
      const conflictApi = await fetch(
        `${baseUrl}/v1/projects/${encodeURIComponent(conflict.projectId)}/annotations?limit=10`,
        { headers: { authorization } },
      )
      const conflictPayload = await conflictApi.json().catch(() => ({}))
      const versionsBefore = await prisma.v2ProjectVersion.count({
        where: { workspaceId: world.workspaceId, projectId: conflict.projectId },
      })

      recorder.start('open-conflict-project')
      await openProjectCard(page, baseUrl, conflict.name)
      const conflictSettle = await waitForEditorSettle(page)
      const conflictPhase = await recorder.stop()
      conflictPhase.settledOn = conflictSettle
      conflictPhase.gets = conflictPhase.entries.filter((entry) => entry.method === 'GET').length
      evidence.phases.push(conflictPhase)
      await page.screenshot({ path: join(evidenceDir, 'conflict-editor.png') })

      const corruptedRowAfter = await prisma.v2ReviewAnnotation.findUnique({ where: { id: conflictAnnotationId } })
      const conflictBlock = {
        apiStatus: conflictApi.status,
        apiCode: conflictPayload?.error?.code ?? null,
        corruptedRowStillPresent: corruptedRowAfter !== null,
        corruptedHashStillPresent: corruptedRowAfter?.actorContextHash === corruptedActorContextHash,
        annotationRowsOnConflictProject: await prisma.v2ReviewAnnotation.count({
          where: { workspaceId: world.workspaceId, projectId: conflict.projectId },
        }),
        versionsBefore,
        versionsAfter: await prisma.v2ProjectVersion.count({
          where: { workspaceId: world.workspaceId, projectId: conflict.projectId },
        }),
        exportOperations: await prisma.v2PublicOperation.count({
          where: { workspaceId: world.workspaceId, projectId: conflict.projectId, type: { not: 'project-proxy-render' } },
        }),
        ui: await refusalBlock(page),
        readLedger: await readLedger(page),
        proxyGateLabel: (await page.getByTestId('proxy-review-gate').count())
          ? (await page.getByTestId('proxy-review-gate').first().innerText()).slice(0, 200)
          : null,
      }
      assert.equal(conflictApi.status, 409, `the corrupted audit projection did not block the read: ${conflictApi.status}`)
      assert.equal(conflictBlock.apiCode, 'PERSISTENCE_CONFLICT', 'the refusal did not name PERSISTENCE_CONFLICT')
      assert.equal(conflictBlock.corruptedRowStillPresent, true, 'the refusal deleted the row it refused')
      assert.equal(conflictBlock.corruptedHashStillPresent, true, 'the corrupted audit hash was silently rewritten')
      assert.equal(conflictBlock.annotationRowsOnConflictProject, 1, 'the refused read created or removed rows')
      assert.equal(conflictBlock.versionsAfter, versionsBefore, 'a refused read created a project version')
      assert.equal(conflictBlock.exportOperations, 0, 'a refused read created an export/edit operation')
      const editorMounted = conflictPhase.settledOn !== null && !String(conflictPhase.settledOn).startsWith('no-marker')
      assert.equal(editorMounted, true, 'the editor did not mount the real 409 refusal state')
      conflictBlock.uiEvidence = 'browser-real'
      assert.ok(conflictBlock.ui.blockVisible > 0, 'the refusal was not shown as review-unavailable')
      assert.ok(
        (conflictBlock.ui.codeText ?? '').includes('PERSISTENCE_CONFLICT'),
        `review-unavailable-code did not name the code: ${conflictBlock.ui.codeText}`,
      )
      assert.equal(conflictBlock.ui.codeNamesRequestId, true, 'the 409 warning omitted its request id')
      assert.ok(conflictBlock.ui.retryPresent > 0, 'no review-retry was offered on a refused read')
      assert.equal(
        conflictBlock.ui.dependentActions.previewVideoPresent,
        true,
        'the refused review also removed the preview',
      )
      assert.equal(
        conflictBlock.ui.dependentActions.previewIsVideoElement,
        true,
        'project-preview is no longer a <video>',
      )
      for (const id of ['review-save', 'review-patch-apply', 'review-batch-apply', 'review-batch-prepare'])
        assert.equal(
          conflictBlock.ui.dependentActions[id],
          'absent',
          `${id} existed while the review read was refused`,
        )
      const conflictReviewResponse = await fetch(
        `${baseUrl}/v1/projects/${encodeURIComponent(conflict.projectId)}/proxy-reviews?projectVersionId=${encodeURIComponent(conflict.proxyVersionId)}`,
        { headers: { authorization } },
      )
      const conflictReviewPayload = await conflictReviewResponse.json()
      assert.equal(conflictReviewResponse.status, 200, 'annotation 409 also made the independent proxy review unreadable')
      assert.equal(conflictReviewPayload?.data?.review?.finalAllowed, true, 'fixture proxy review is not independently approved')
      assert.ok(/Liberado para alta/i.test(conflictBlock.proxyGateLabel ?? ''), 'approved proxy review disappeared during annotation 409')
      record(
        'pg-real+browser-real',
        'corrupted-audit-context-blocks-review',
        conflictBlock,
      )

      // State-real: media without a proxy review must not read as approved.
      const proxyReviewRows = await prisma.v2ProxyReview.count({
        where: { workspaceId: world.workspaceId, projectId: noReview.projectId },
      })
      assert.equal(proxyReviewRows, 0, 'the dedicated no-review project unexpectedly has a proxy review')
      await openProjectCard(page, baseUrl, noReview.name)
      await waitForEditorSettle(page)
      const gateText = (await page.getByTestId('proxy-review-gate').count())
        ? await page.getByTestId('proxy-review-gate').first().innerText()
        : ''
      const emptyReview = {
        proxyReviewRowsInDatabase: proxyReviewRows,
        gatePresent: gateText.length > 0,
        saysNoReportForThisVersion: /Sem laudo para esta vers/i.test(gateText),
        saysReleasedForHigh: /Liberado para alta/i.test(gateText),
        approvedWordAnywhereOnPage: /\bAprovado\b/i.test(await page.locator('body').innerText()),
      }
      assert.equal(emptyReview.saysReleasedForHigh, false, 'a project with no proxy review reads as released')
      assert.equal(emptyReview.approvedWordAnywhereOnPage, false, 'a project with no proxy review reads as approved')
      assert.equal(emptyReview.gatePresent, true, 'the no-review gate did not render')
      assert.equal(emptyReview.saysNoReportForThisVersion, true, 'the no-review gate did not explicitly name the absent report')
      emptyReview.note = emptyReview.gatePresent
        ? null
        : 'the proxy gate never rendered, so "not approved" here is the absence of the whole page, not a verdict the page took'
      record(
        emptyReview.gatePresent ? 'pg-real+browser-real' : 'pg-real (ui not-executed)',
        'no-proxy-review-is-not-approved',
        emptyReview,
      )
      await page.screenshot({ path: join(evidenceDir, 'empty-review-state.png') })

      // Transport-controlled: stubbed refusals. NOT evidence about governance.
      const annotationsGlob = `**/v1/projects/*/annotations*`
      const stub = { strength: 'transport-stub', note: 'page.route() interception — says nothing about PostgreSQL or governance' }

      await page.route(annotationsGlob, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        await route.fulfill({
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '3' },
          body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'stubbed', requestId: 'stub-429' } }),
        })
      })
      await openProjectCard(page, baseUrl, clean.name)
      await waitForEditorSettle(page)
      stub.rateLimited = await refusalBlock(page)
      stub.rateLimited.readLedger = await readLedger(page)
      assert.ok(stub.rateLimited.blockVisible > 0, '429 did not render the review-unavailable warning')
      assert.ok((stub.rateLimited.codeText ?? '').includes('RATE_LIMITED'), '429 warning omitted RATE_LIMITED')
      assert.ok((stub.rateLimited.codeText ?? '').includes('stub-429'), '429 warning omitted its request id')
      assert.equal(stub.rateLimited.retryPresent > 0, true, '429 warning omitted retry control')
      assert.equal(stub.rateLimited.retryDisabled, true, '429 retry was enabled before Retry-After elapsed')
      assert.equal(stub.rateLimited.retryCountsDown, true, '429 retry did not expose its countdown')
      await page.screenshot({ path: join(evidenceDir, 'stub-429.png') })
      await page.unroute(annotationsGlob)

      let unauthorizedServed = 0
      await page.route(annotationsGlob, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        unauthorizedServed += 1
        await context.clearCookies({ name: 'apollo_session' })
        await route.fulfill({
          status: 401,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: { code: 'AUTH_INVALID', message: 'stubbed', requestId: 'stub-401' } }),
        })
      })
      await openProjectCard(page, baseUrl, clean.name)
      await waitForEditorSettle(page)
      stub.unauthorized = await refusalBlock(page)
      stub.unauthorized.stubbedResponses = unauthorizedServed
      stub.unauthorized.url = page.url()
      assert.ok(unauthorizedServed > 0, 'the controlled 401 transport response was not exercised')
      assert.equal(stub.unauthorized.retryPresent, 0, '401 exposed a retry action after the coordinator closed')
      assert.ok(page.url().includes('/login'), `401 did not close the session: ${page.url()}`)
      await page.unroute(annotationsGlob)

      // Sign in again so the project-switch assertion starts from an accepted session.
      await page.locator('input[name="username"]').fill(username)
      await page.locator('input[name="password"]').fill(password)
      await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 })

      // A late answer that lands after the operator already switched project.
      let slowServed = false
      await page.route(annotationsGlob, async (route) => {
        if (route.request().method() !== 'GET' || slowServed) return route.fallback()
        slowServed = true
        await delay(4_000)
        await route.fallback()
      })
      await openProjectCard(page, baseUrl, clean.name)
      await delay(400)
      await openProjectCard(page, baseUrl, conflict.name)
      await waitForEditorSettle(page)
      await delay(5_000)
      stub.lateAnswerAfterSwitch = {
        urlIsConflictProject: page.url().includes(conflict.projectId),
        // The defect a stale answer causes: the OTHER project's review shown here.
        staleBannerVisible: await page.getByTestId('review-stale-banner').count(),
        readLedger: await readLedger(page),
        ...(await refusalBlock(page)),
      }
      assert.equal(stub.lateAnswerAfterSwitch.urlIsConflictProject, true, 'late response switched back to the prior project')
      assert.equal(stub.lateAnswerAfterSwitch.staleBannerVisible, 0, 'late response installed stale review state')
      await page.unroute(annotationsGlob)
      record('transport-stub', 'stubbed-refusals', stub)

      // Security: a second workspace's reader must not read this project.
      const otherWorkspaceId = `editor-reliability-other-${suffix}`
      const { createWorkspaceRow, issueApiClient } = await import('./helpers/capture-journey.mjs')
      await createWorkspaceRow({
        prisma,
        workspaceId: otherWorkspaceId,
        name: 'Other Workspace',
        createdAt: world.createdAt,
      })
      const otherIssued = await issueApiClient({
        prisma,
        workspaceId: otherWorkspaceId,
        clientId: `editor-reliability-other-client-${suffix}`,
        name: 'Other Workspace Reader',
        createdAt: world.createdAt,
        scopes: ['projects:read', 'artifacts:read'],
      })
      const otherAuthorization = `Bearer ${otherIssued.token}`
      const crossAnnotations = await fetch(`${annotationsUrl}?limit=10`, { headers: { authorization: otherAuthorization } })
      const crossAnnotationsBody = await crossAnnotations.text()
      const crossArtifact = await fetch(contentUrl, { headers: { authorization: otherAuthorization } })
      const crossArtifactBody = await crossArtifact.text()
      const crossWorkspace = {
        annotationsStatus: crossAnnotations.status,
        annotationsCode: (() => {
          try {
            return JSON.parse(crossAnnotationsBody)?.error?.code ?? null
          } catch {
            return null
          }
        })(),
        annotationsLeaksProjectId: crossAnnotationsBody.includes(clean.projectId),
        annotationsLeaksAnnotationText: crossAnnotationsBody.includes('legenda abaixo do rosto'),
        artifactStatus: crossArtifact.status,
        artifactLeaksKey: crossArtifactBody.includes(clean.proxyKey ?? '\u0000'),
        artifactBodyLength: crossArtifactBody.length,
      }
      assert.ok(
        [403, 404].includes(crossWorkspace.annotationsStatus),
        `cross-workspace annotations read returned ${crossWorkspace.annotationsStatus}`,
      )
      assert.ok(
        [403, 404].includes(crossWorkspace.artifactStatus),
        `cross-workspace artifact read returned ${crossWorkspace.artifactStatus}`,
      )
      assert.equal(crossWorkspace.annotationsLeaksProjectId, false, 'the refusal echoed the project id')
      assert.equal(crossWorkspace.annotationsLeaksAnnotationText, false, 'the refusal echoed annotation text')
      assert.equal(crossWorkspace.artifactLeaksKey, false, 'the refusal echoed the artifact key')
      record('api-real', 'cross-workspace-refusal', crossWorkspace)
      await prisma.v2ApiClient.deleteMany({ where: { workspaceId: otherWorkspaceId } })
      await prisma.v2Workspace.deleteMany({ where: { id: otherWorkspaceId } })

      evidence.jsErrors = jsErrors
      assert.deepEqual(jsErrors, [], `browser emitted page errors: ${jsErrors.join(' | ')}`)
      evidence.serverLogTail = serverLogs.slice(-1_200).replace(/Bearer\s+\S+/g, 'Bearer [redacted]')
      evidence.finishedAt = new Date().toISOString()
      const evidencePath = join(evidenceDir, 'editor-reliability-evidence.json')
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

      const [first, second] = evidence.baseline.perOpen
      console.log(
        [
          `editor-reliability suffix=${suffix}`,
          `open1 gets=${first.gets} distinct=${first.distinctEndpoints} dup=${first.duplicates.length}`,
          `open2 gets=${second.gets} distinct=${second.distinctEndpoints} dup=${second.duplicates.length}`,
          `combinedInWindow=${evidence.baseline.combinedGetsInWindow}/floor=20 sameMinute=${sameMinute}`,
          `refusals=${JSON.stringify([...first.refusals, ...second.refusals])}`,
          `range=${media.rangeStatus}/${media.contentRange} ffprobeFrames=${media.ffprobe.frames}`,
          `annotation=${annotation.firstStatus}/${annotation.replayStatus} rows=${annotation.rowsInDatabase}`,
          `conflict=${conflictBlock.apiStatus}/${conflictBlock.apiCode} ui.unavailable=${conflictBlock.ui.blockVisible} ui.retry=${conflictBlock.ui.retryPresent}`,
          `cross=${crossWorkspace.annotationsStatus}/${crossWorkspace.artifactStatus}`,
          `jsErrors=${jsErrors.length} serverPid=${server.pid} evidence=${evidencePath}`,
        ].join(' | '),
      )
    } catch (error) {
      testFailure = error
      evidence.failure = {
        diagnostic: redactDiagnostic(error),
        serverLogTail: redactDiagnostic(typeof serverLogs === 'string' ? serverLogs.slice(-12_000) : ''),
        failedAt: new Date().toISOString(),
      }
      await mkdir(evidenceDir, { recursive: true }).catch(() => {})
      await writeFile(
        join(evidenceDir, 'editor-reliability-failure.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8',
      ).catch(() => {})
      throw error
    } finally {
      if (browser)
        try {
          await browser.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
      try {
        await stopChild(server)
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (world) {
        try {
          await world.cleanup()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        await prisma.$disconnect()
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        if (!process.env.APOLLO_EDITOR_RELIABILITY_KEEP_EVIDENCE) await rm(root, { recursive: true, force: true })
        else console.log(`editor-reliability evidence kept at ${root}`)
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupErrors.length)
        // node prints an AggregateError's own message and NOT its inner ones,
        // so a CI failure here was invisible. The causes go in the message.
        throw new AggregateError(
          testFailure ? [testFailure, ...cleanupErrors] : cleanupErrors,
          `Editor reliability browser E2E cleanup failed: ${cleanupErrors
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join(' | ')}`,
        )
    }
  },
)
