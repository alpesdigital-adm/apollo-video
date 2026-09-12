import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { assertIsolatedDatabase, sha256Of } from './helpers/capture-journey.mjs'
import {
  encodeSharedProxy,
  attachSourceAsEditingProxy,
  auditCensus,
  materialiseProxy,
  seedEditorReliabilityWorld,
  summarizeInventory,
  tokenizePath,
} from './helpers/editor-reliability-world.mjs'

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
  const exited = new Promise((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
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
  const inFlight = new Map()
  const maxConcurrent = new Map()
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
      inFlight.clear()
      maxConcurrent.clear()
    },
    stop() {
      active = false
      const taken = entries.filter((entry) => entry.phase === label)
      const duplicates = [...maxConcurrent.entries()]
        .filter(([, value]) => value > 1)
        .map(([key, value]) => ({ path: key, maxConcurrent: value }))
      return { label, entries: taken, summary: summarizeInventory(taken), duplicates }
    },
    attach(page) {
      page.on('request', (request) => {
        if (!active || !inScope(request.url())) return
        const key = `${request.method()} ${keyOf(request.url())}`
        const next = (inFlight.get(key) ?? 0) + 1
        inFlight.set(key, next)
        maxConcurrent.set(key, Math.max(maxConcurrent.get(key) ?? 0, next))
      })
      page.on('requestfinished', (request) => {
        if (!active || !inScope(request.url())) return
        const key = `${request.method()} ${keyOf(request.url())}`
        inFlight.set(key, Math.max(0, (inFlight.get(key) ?? 1) - 1))
      })
      page.on('requestfailed', (request) => {
        if (!active || !inScope(request.url())) return
        const key = `${request.method()} ${keyOf(request.url())}`
        inFlight.set(key, Math.max(0, (inFlight.get(key) ?? 1) - 1))
        entries.push({
          phase: label,
          method: request.method(),
          path: keyOf(request.url()),
          status: 'request-failed',
          code: request.failure()?.errorText ?? null,
          at: Date.now(),
        })
      })
      page.on('response', (response) => {
        if (!active || !inScope(response.url())) return
        const entry = {
          phase: label,
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

    let world, proxy, browser, server, testFailure
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
        ],
      })
      const clean = world.bySlug('clean')
      const conflict = world.bySlug('conflict')
      evidence.materialisation = {
        path: 'POST /v1/projects/{id}/proxy-renders over HTTP + scripts/run-v2-render-worker-once.mjs (the real driver)',
        seeded: 'source recording artifact/manifest/probe rows and the compiled base version only',
        source: { codec: proxy.probe.codec, seconds: proxy.seconds, fps: proxy.fps, byteSize: proxy.byteSize },
      }

      const username = `editor-ui-${suffix}`
      const password = `Editor-${suffix}-secure-passphrase`
      const port = await freePort()
      const baseUrl = `http://127.0.0.1:${port}`
      let serverLogs = ''
      // The build under measurement. Default: this worktree. When
      // APOLLO_EDITOR_RELIABILITY_APP_ROOT names another checkout, the same
      // fixture, database and browser are pointed at THAT build instead — which
      // is the only way a "before" and an "after" are comparable at all.
      const appRoot = process.env.APOLLO_EDITOR_RELIABILITY_APP_ROOT ?? process.cwd()
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
      // and the real `--once` driver. Nothing below writes an operation row.
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
      // The render is ATTEMPTED, never faked. If it does not complete, the
      // attempt's outcome is recorded verbatim and the journey continues on the
      // source master, which carries no claim about rendering whatsoever.
      evidence.materialisation.renderAttempts = []
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
            status: 'not-executed',
            operation: row,
            failure: String(error instanceof Error ? error.message : error).slice(0, 600),
          })
          await attachSourceAsEditingProxy({ prisma, workspaceId: world.workspaceId, project })
        }
      }
      evidence.materialisation.mediaOrigin = {
        clean: clean.mediaOrigin ?? 'rendered-proxy',
        conflict: conflict.mediaOrigin ?? 'rendered-proxy',
      }
      const renderExecuted = evidence.materialisation.renderAttempts.every(
        (attempt) => attempt.status === 'succeeded',
      )
      evidence.materialisation.note = renderExecuted
        ? 'elapsedMs is the wall clock of enqueue + one driver pass in this harness, not the product metric timeToFirstProxyMs'
        : 'the proxy render did not complete; every finding below is labelled source-master-fallback and says nothing about rendering'

      // Before a single page opens: which rows in this workspace carry
      // credential audit and are missing part of it. Every one of them is a row
      // some read will refuse with PERSISTENCE_CONFLICT, and knowing which
      // table it is separates a fixture defect from a product one.
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
        const inventory = recorder.stop()
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
      // Without a rendered proxy there is no proxy for the review session to
      // bind an annotation to, and the route says so. That is recorded as
      // not-executed rather than asserted away, and rather than taking the
      // negatives — which do not need a proxy — down with it.
      const annotationExecuted = firstResponse.status === 201
      if (!annotationExecuted)
        record('api-real', 'annotation-idempotency', {
          status: 'not-executed',
          firstStatus: firstResponse.status,
          code: firstPayload?.error?.code ?? null,
          requestId: firstPayload?.error?.requestId ?? null,
          mediaOrigin: clean.mediaOrigin ?? 'rendered-proxy',
          reason:
            clean.mediaOrigin === 'source-master-fallback'
              ? 'no rendered proxy: the review session has nothing to bind an annotation to'
              : 'the annotations route refused an otherwise valid annotation',
        })
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
      const third = recorder.stop()
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
      // PG-real: a legacy annotation with no credential audit blocks the read.
      const legacyId = randomUUID()
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
      const conflictPhase = recorder.stop()
      conflictPhase.settledOn = conflictSettle
      conflictPhase.gets = conflictPhase.entries.filter((entry) => entry.method === 'GET').length
      evidence.phases.push(conflictPhase)
      await page.screenshot({ path: join(evidenceDir, 'conflict-editor.png') })

      const legacyRowAfter = await prisma.v2ReviewAnnotation.findUnique({ where: { id: legacyId } })
      const conflictBlock = {
        apiStatus: conflictApi.status,
        apiCode: conflictPayload?.error?.code ?? null,
        legacyRowStillPresent: legacyRowAfter !== null,
        legacyRowStillWithoutAudit:
          legacyRowAfter !== null && legacyRowAfter.actorCredentialId === null && legacyRowAfter.actorContextHash === null,
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
      assert.equal(conflictApi.status, 409, `the legacy annotation did not block the read: ${conflictApi.status}`)
      assert.equal(conflictBlock.apiCode, 'PERSISTENCE_CONFLICT', 'the refusal did not name PERSISTENCE_CONFLICT')
      assert.equal(conflictBlock.legacyRowStillPresent, true, 'the refusal deleted the row it refused')
      assert.equal(conflictBlock.legacyRowStillWithoutAudit, true, 'the row was rewritten instead of refused')
      assert.equal(conflictBlock.annotationRowsOnConflictProject, 1, 'the refused read created or removed rows')
      assert.equal(conflictBlock.versionsAfter, versionsBefore, 'a refused read created a project version')
      assert.equal(conflictBlock.exportOperations, 0, 'a refused read created an export/edit operation')
      assert.ok(conflictBlock.ui.blockVisible > 0, 'the refusal was not shown as review-unavailable')
      assert.ok(
        (conflictBlock.ui.codeText ?? '').includes('PERSISTENCE_CONFLICT'),
        `review-unavailable-code did not name the code: ${conflictBlock.ui.codeText}`,
      )
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
        assert.notEqual(
          conflictBlock.ui.dependentActions[id],
          'enabled',
          `${id} stayed enabled while the review read was refused`,
        )
      assert.ok(
        /Laudo indispon|Sem laudo para esta vers/i.test(conflictBlock.proxyGateLabel ?? ''),
        `unexpected proxy gate label: ${conflictBlock.proxyGateLabel}`,
      )
      record('pg-real+browser-real', 'legacy-audit-conflict-blocks-review', conflictBlock)

      // State-real: media without a proxy review must not read as approved.
      const proxyReviewRows = (await prisma.v2ProxyReview?.count({
        where: { workspaceId: world.workspaceId, projectId: clean.projectId },
      }).catch(() => null)) ?? null
      await openProjectCard(page, baseUrl, clean.name)
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
      record('pg-real+browser-real', 'no-proxy-review-is-not-approved', emptyReview)
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
      await page.screenshot({ path: join(evidenceDir, 'stub-429.png') })
      await page.unroute(annotationsGlob)

      await page.route(annotationsGlob, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        await route.fulfill({
          status: 401,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: { code: 'AUTH_INVALID', message: 'stubbed', requestId: 'stub-401' } }),
        })
      })
      await openProjectCard(page, baseUrl, clean.name)
      await waitForEditorSettle(page)
      stub.unauthorized = await refusalBlock(page)
      await page.unroute(annotationsGlob)

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
          `conflict=${conflictBlock.apiStatus}/${conflictBlock.apiCode} ui.unavailable=${conflictBlock.ui.reviewUnavailableVisible} ui.retry=${conflictBlock.ui.reviewRetryVisible}`,
          `cross=${crossWorkspace.annotationsStatus}/${crossWorkspace.artifactStatus}`,
          `jsErrors=${jsErrors.length} serverPid=${server.pid} evidence=${evidencePath}`,
        ].join(' | '),
      )
    } catch (error) {
      testFailure = error
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
        throw new AggregateError(
          testFailure ? [testFailure, ...cleanupErrors] : cleanupErrors,
          'Editor reliability browser E2E cleanup failed',
        )
    }
  },
)
