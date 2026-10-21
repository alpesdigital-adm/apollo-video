import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { artifactPath } from './helpers/capture-journey.mjs'
import { apiClient, chromeExecutable, startServer } from './helpers/issue-override-runtime.mjs'
import { PIXEL_TOLERANCE, bandRows, changedClusters, decodeFrame, occupiedBands, sha256Hex } from './helpers/issue-override-proof.mjs'
import { CUES, SCENE, runProxyWorkerOnce, seedIssueOverrideWorld } from './helpers/issue-override-world.mjs'

/**
 * W68 browser proof (supervised harness; also a CI step). A real Chromium drives the editor against `next start`, PostgreSQL and the production
 * proxy-render worker, on ONE project with TWO outputs (9:16 and 16:9) over one real recording drawn by a generator.
 *
 * Per output: a caption issue chip is opened and its evidence read, an override Command is applied from the chip, the proxy of THAT output
 * only is rendered again, the critic runs again on the new pixels, and the new frames are measured against the old ones; a reset returns the
 * decoded frame to the inherited one. For 16:9 a hard CAPTION_PLACEMENT_MISMATCH (a text exception too long for the two lines of the wide band, seeded by the world) is fixed by a shorter
 * text; for 9:16 a manual reframe is set and reset. Negatives: expired session (draft kept), another workspace's URL, stale base, replay,
 * cancel during the recompile, an attempt to acknowledge a block, and the proof that nothing was accepted by clicking.
 */
const enabled = process.env.APOLLO_ISSUE_OVERRIDE_UI_E2E === '1'
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const evidence = { steps: [] }
const note = (label, value = {}) => { evidence.steps.push({ label, at: new Date().toISOString(), ...value }); console.log(`W68-EVIDENCE ${JSON.stringify({ label, ...value })}`) }
const serialize = (value) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))

async function waitFor(label, probe, { timeoutMs = 240_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try { last = await probe(); if (last) return last } catch (error) { last = error }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : serialize(last)}`)
    await delay(intervalMs)
  }
}

test('W68 issue -> override -> recompile -> critic again, in a real browser, for 9:16 and 16:9', { skip: !enabled, timeout: 1_650_000 }, async () => {
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  // The database role of the supervised harness allows 12 connections; the CI database allows far more, and a pool of 5 per process is what it
  // configures. This journey runs the test, the render worker and TWO servers (the owner's and the stranger's) against one database, so each gets a
  // small pool of its own: the journey is sequential and never needs more than a couple of connections at a time.
  const harnessUrl = process.env.V2_DATABASE_URL
  const poolOf = (limit) => { const url = new URL(harnessUrl); url.searchParams.set('connection_limit', String(limit)); return url.toString() }
  const serverPool = poolOf(2)
  // The in-process repositories (the render worker pass the journey drives) hold one process-wide client: it gets the same small pool.
  process.env.V2_DATABASE_URL = poolOf(3)
  const db = new PrismaClient({ datasources: { db: { url: poolOf(2) } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-w68-'))
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const evidenceDir = process.env.APOLLO_ISSUE_OVERRIDE_EVIDENCE_DIR ? join(process.env.APOLLO_ISSUE_OVERRIDE_EVIDENCE_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`) : join(root, 'evidence')
  await mkdir(evidenceDir, { recursive: true })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const ffmpegPath = process.env.FFMPEG_BIN ?? (await import('node:module')).createRequire(import.meta.url)('ffmpeg-static')
  const servers = []
  let browser
  let pump
  let failure
  try {
    /* ------------------------------------------------------------------ world, servers, baseline renders ------------------------------------------------- */
    const world = await seedIssueOverrideWorld({ db, artifactRoot, suffix, ffmpegPath, wideOverflow: true })
    const username = `w68-ui-${suffix}`, password = `W68-${suffix}-secure-passphrase`
    const environmentFor = (clientId) => ({
      APOLLO_API_ENVIRONMENT: 'production', APOLLO_AUTH_MODE: 'bootstrap', APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true', APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
      APOLLO_UI_USERNAME: username, APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(password, `w68-salt-${suffix}`),
      APOLLO_UI_SESSION_SECRET: `w68-session-${suffix}-at-least-32-bytes-long`, APOLLO_UI_API_CLIENT_ID: clientId,
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', V2_DATABASE_URL: serverPool,
      // This journey verifies every step through the API while the editor polls: dozens of reads a minute from one client, a burst that the
      // request-anomaly alarm (default floor 20, 3x baseline) is built to stop. The alarm is the product's; its floor is raised here, for this
      // server only, and the rate limit itself (10000 a minute) is untouched. editor-reliability-browser.e2e.mjs is the suite that keeps the defaults.
      APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '100000',
    })
    const server = await startServer({ appRoot: process.cwd(), environment: environmentFor(world.owner.clientId) })
    servers.push(server)
    // The render worker seals its recipe parameters before it writes a manifest, and refuses to start without a key. Generated here, never read from a file.
    const workerEnvironment = {
      ...process.env, ...environmentFor(world.owner.clientId),
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: process.env.APOLLO_PROTECTED_PAYLOAD_KEY_ID ?? `w68-${suffix}`,
      APOLLO_PROTECTED_PAYLOAD_KEY: process.env.APOLLO_PROTECTED_PAYLOAD_KEY ?? Buffer.alloc(32, 7).toString('base64url'),
    }
    const api = apiClient(server.baseUrl, world.owner.token)
    const strangerApi = apiClient(server.baseUrl, world.stranger.token)
    const projectPath = `/v1/projects/${world.projectId}`
    const workerFailures = []
    let paused = false
    let stopped = false
    const pumpLoop = (async () => {
      while (!stopped) {
        if (paused) { await delay(300); continue }
        const outcome = await runProxyWorkerOnce({ environment: workerEnvironment, workspaceId: world.owner.workspaceId, onFailure: (item) => workerFailures.push(String(item.error?.stack ?? item.error).slice(0, 600)) })
          .catch((error) => ({ status: 'driver-error', error: String(error).slice(0, 300) }))
        if (!outcome) await delay(600)
      }
    })()
    pump = { pause: () => { paused = true }, resume: () => { paused = false }, stop: async () => { stopped = true; await pumpLoop } }

    const VARIANTS = [
      { key: '9x16', variantId: world.verticalVariantId, format: '9:16' },
      { key: '16x9', variantId: world.wideVariantId, format: '16:9' },
    ]
    const siblingOf = (variantId) => VARIANTS.find((entry) => entry.variantId !== variantId)
    const head = async () => {
      const project = await db.v2Project.findUniqueOrThrow({ where: { id: world.projectId } })
      return db.v2ProjectVersion.findUniqueOrThrow({ where: { id: project.currentVersionId } })
    }
    const proxyOf = async (versionId, variantId) => {
      const operation = await db.v2ProjectProxyRenderOperation.findFirst({
        where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, projectVersionId: versionId, outputVariantId: variantId, operation: { status: 'succeeded' } },
        orderBy: { createdAt: 'desc' },
      })
      if (!operation) return null
      const artifact = await db.v2MediaArtifact.findUniqueOrThrow({ where: { id_workspaceId: { id: operation.outputArtifactId, workspaceId: world.owner.workspaceId } } })
      const bytes = await readFile(artifactPath(artifactRoot, artifact.artifactKey))
      assert.equal(sha256Hex(bytes), artifact.sha256, 'the stored proxy bytes are the bytes its artifact row names')
      return { operationId: operation.operationId, artifactId: artifact.id, sha256: artifact.sha256, path: artifactPath(artifactRoot, artifact.artifactKey), versionId }
    }
    const reviewOf = async (variantId, versionId) => {
      const response = await api('GET', `${projectPath}/proxy-reviews?variantId=${encodeURIComponent(variantId)}${versionId ? `&projectVersionId=${versionId}` : ''}`)
      assert.equal(response.status, 200, serialize(response.body))
      return response.data.review
    }
    const issuesOf = (review) => [...review.technicalIssues, ...review.criticIssues]
    const frameAt = async (proxy, index) => decodeFrame(ffmpegPath, proxy.path, index)
    const shoot = async (name, frames) => {
      for (const [label, frame] of Object.entries(frames)) await writeFile(join(evidenceDir, `w68-${name}-${label}-${frame.sha256.slice(0, 10)}.png`), frame.png)
    }
    const decisionCount = () => db.v2ProxyReviewDecision.count({ where: { workspaceId: world.owner.workspaceId } })

    // The reframe plan of each output (decided by the server over the sealed face windows), then the first render of each output.
    const baseline = {}
    for (const entry of VARIANTS) {
      const plan = await api('POST', `${projectPath}/reframe-plans`, { body: { baseVersionId: world.headVersionId, variantId: entry.variantId } })
      assert.equal(plan.status, 200, serialize(plan.body))
      const enqueued = await api('POST', `${projectPath}/proxy-renders`, { body: { variantId: entry.variantId }, key: `w68-${suffix}-${entry.key}-first` })
      assert.equal(enqueued.status, 202, serialize(enqueued.body))
      const operationId = enqueued.data.operation.id
      await waitFor(`first render of ${entry.key}`, async () => (await db.v2PublicOperation.findUnique({ where: { id: operationId } }))?.status === 'succeeded')
      const proxy = await proxyOf(world.headVersionId, entry.variantId)
      const review = await reviewOf(entry.variantId, world.headVersionId)
      baseline[entry.key] = { ...entry, proxy, review, planRecordHash: plan.data.plan?.recordHash }
      note(`baseline-${entry.key}`, { proxy: proxy.sha256, reviewStatus: review.status, reviewHash: review.reviewHash, issues: issuesOf(review).map((issue) => [issue.code, issue.severity, issue.elementIds?.[0] ?? null]) })
    }
    assert.equal(workerFailures.length, 0, workerFailures.join('\n'))
    const wide = baseline['16x9'], tall = baseline['9x16']
    assert.equal(wide.review.status, 'blocked', 'the wide baseline is blocked by a real pixel mismatch (the seeded text does not fit the two lines of the wide band)')
    assert.ok(issuesOf(wide.review).some((issue) => issue.code === 'CAPTION_PLACEMENT_MISMATCH' && issue.severity === 'hard' && issue.elementIds.includes('subtitle:cue-1')))
    assert.equal(tall.review.status, 'warning-ack-required')
    assert.equal(await decisionCount(), 0)

    // What must not move: the previous Version (its row and its EditPlan snapshot) and the OTHER output's renders, reviews and approvals.
    const immutableFacts = async (versionId, siblingVariantId) => {
      const version = await db.v2ProjectVersion.findUniqueOrThrow({ where: { id: versionId }, include: { editPlanSnapshot: true } })
      // What existed AT that Version: a render carried to a later Version (the untouched output keeps its render) is a new fact about the later Version, not a change of this one.
      const siblingOperations = await db.v2ProjectProxyRenderOperation.findMany({ where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, outputVariantId: siblingVariantId, version: { sequence: { lte: version.sequence } } }, orderBy: { operationId: 'asc' } })
      const siblingArtifacts = await db.v2MediaArtifact.findMany({ where: { id: { in: siblingOperations.map((operation) => operation.outputArtifactId) }, workspaceId: world.owner.workspaceId }, orderBy: { id: 'asc' } })
      const siblingReviews = await db.v2ProxyReview.findMany({ where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, proxyArtifactId: { in: siblingArtifacts.map((artifact) => artifact.id) }, projectVersion: { sequence: { lte: version.sequence } } }, orderBy: { id: 'asc' } })
      return serialize({ version, siblingOperations: siblingOperations.map((operation) => operation.operationId), siblingArtifacts: siblingArtifacts.map((artifact) => [artifact.id, artifact.sha256]), siblingReviews: siblingReviews.map((review) => [review.id, review.reviewHash, review.revision, review.warningsAcknowledged]), decisions: await decisionCount() })
    }
    const cueMid = (cue) => Math.floor((cue.startFrame + cue.endFrame) / 2)
    const CUE1 = CUES[0]
    const clustersWithin = (clusters, rows) => clusters.every(([top, bottom]) => top >= rows.top - PIXEL_TOLERANCE.bandSlackRows && bottom <= rows.bottom + PIXEL_TOLERANCE.bandSlackRows)

    /* ------------------------------------------------------------------ browser ------------------------------------------------------------------------ */
    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true })
    const context = await browser.newContext({ viewport: { width: 1500, height: 1500 } })
    context.setDefaultTimeout(60_000)
    const page = await context.newPage()
    const jsErrors = []
    page.on('pageerror', (error) => jsErrors.push(error.message))
    const login = async (targetPage, baseUrl, next) => {
      await targetPage.goto(`${baseUrl}/login?next=${encodeURIComponent(next)}`)
      await targetPage.locator('input[name="username"]').fill(username)
      await targetPage.locator('input[name="password"]').fill(password)
      await targetPage.getByRole('button', { name: 'Entrar no Apollo' }).click()
      await targetPage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 })
    }
    const projectUrl = `/projects/${world.projectId}`
    await login(page, server.baseUrl, projectUrl)
    const panel = page.getByTestId('issue-override-panel')
    const openOutput = async (entry, { mayBeUnrendered = false } = {}) => {
      await page.goto(`${server.baseUrl}${projectUrl}`)
      await page.getByTestId(`output-option-${entry.variantId}`).click()
      await page.locator(`[data-testid="issue-override-panel"][data-variant-id="${entry.variantId}"]`).waitFor()
      if (mayBeUnrendered) await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined)
      await page.locator(mayBeUnrendered ? '[data-testid="issue-chip"], [data-testid="issue-none"], [data-testid="issue-render-current"]' : '[data-testid="issue-chip"], [data-testid="issue-none"]').first().waitFor({ timeout: 60_000 }).catch(async (error) => {
        await page.screenshot({ path: join(evidenceDir, 'w68-diagnostic-open-output.png'), fullPage: true }).catch(() => undefined)
        throw new Error(`the panel never showed a chip, an empty verdict or a render action: ${(await panel.innerText().catch(() => '')).slice(0, 600)} / ${error}`)
      })
    }
    const chipFor = (code, cue) => page.locator(`[data-testid="issue-chip"][data-issue-code="${code}"]${cue ? `[data-cue-id="${cue}"]` : ''}`).first()
    const chipCodes = async () => page.locator('[data-testid="issue-chip"]').evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('data-issue-code'), node.getAttribute('data-severity'), node.getAttribute('data-cue-id')]))
    const selectChip = async (code, cue) => {
      await chipFor(code, cue).waitFor()
      await chipFor(code, cue).click()
      await page.getByTestId('issue-detail').waitFor()
    }
    const sameChips = async (review) => {
      const shown = await chipCodes()
      const expected = issuesOf(review).map((issue) => [issue.code, issue.severity === 'hard' ? 'block' : 'review', issue.elementIds?.find((id) => id.startsWith('subtitle:'))?.slice(9) ?? ''])
      assert.deepEqual(shown.map((row) => serialize(row)).sort(), expected.map((row) => serialize(row)).sort(), 'every issue of the persisted review is a chip: none hidden, none invented')
    }
    // Every Command the editor sends ends in a NEW result block (its own command id); the block of the previous Command is never mistaken for it.
    let lastApplied = null
    const waitRecompiled = async (label) => {
      const id = await waitFor(`${label}: a new result is shown`, async () => {
        const shown = await page.locator('[data-testid="issue-applied"]').getAttribute('data-command-id', { timeout: 500 }).catch(() => null)
        return shown && shown !== lastApplied ? shown : null
      }, { timeoutMs: 120_000 }).catch(async (error) => {
        await page.screenshot({ path: join(evidenceDir, `w68-diagnostic-${label.replaceAll(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }).catch(() => undefined)
        throw new Error(`${error.message} :: panel says: ${(await panel.innerText().catch(() => '')).slice(0, 1500)}`)
      })
      lastApplied = id
      await page.locator('[data-testid="issue-recompile-status"][data-operation-status="succeeded"]').waitFor({ timeout: 300_000 })
      await waitFor(`${label}: the new review is shown`, async () => /depois: .* · laudo [0-9a-f]{12}/.test(await page.getByTestId('issue-comparison-after').innerText()), { timeoutMs: 120_000 })
    }

    /* ---- cross-workspace URL (a second server whose UI session belongs to the stranger's workspace) ------------------------------------------------ */
    {
      const other = await startServer({ appRoot: process.cwd(), environment: environmentFor(world.stranger.clientId) })
      servers.push(other)
      const strangerContext = await browser.newContext({ viewport: { width: 1200, height: 900 } })
      const strangerPage = await strangerContext.newPage()
      await login(strangerPage, other.baseUrl, '/')
      await strangerPage.goto(`${other.baseUrl}${projectUrl}`)
      await strangerPage.getByTestId('project-not-found').waitFor({ timeout: 60_000 }).catch(async (error) => {
        // Name what the page showed instead: a timeout alone says nothing about which of the editor's states it was in.
        const seen = await strangerPage.evaluate(() => ({ url: location.pathname, testids: [...document.querySelectorAll('[data-testid]')].map((node) => node.getAttribute('data-testid')).slice(0, 12), text: document.body.innerText.slice(0, 400) })).catch(() => null)
        await strangerPage.screenshot({ path: join(evidenceDir, 'w68-diagnostic-stranger-page.png'), fullPage: true }).catch(() => undefined)
        throw new Error(`${error.message} :: the stranger's page showed ${serialize(seen)} :: its server said ${other.logs.text.slice(-2500)}`)
      })
      assert.equal(await strangerPage.getByTestId('issue-override-panel').count(), 0, 'another workspace sees no panel')
      assert.ok(!(await strangerPage.getByTestId('project-not-found').innerText()).includes(world.projectId), 'the page does not echo the project it refused')
      const probes = {
        segments: await strangerApi('GET', `${projectPath}/subtitle-segments?variantId=${encodeURIComponent(world.wideVariantId)}`),
        override: await strangerApi('POST', `${projectPath}/subtitle-segment-overrides`, { key: `w68-${suffix}-stranger-1`, body: { baseVersionId: world.headVersionId, baseHash: world.headVersionHash, variantId: world.wideVariantId, segmentId: 'cue-1', action: 'reset' } }),
        reframe: await strangerApi('GET', `${projectPath}/reframe-plans?variantId=${encodeURIComponent(world.wideVariantId)}`),
        proxy: await strangerApi('POST', `${projectPath}/proxy-renders`, { key: `w68-${suffix}-stranger-2`, body: { variantId: world.wideVariantId } }),
      }
      for (const [name, response] of Object.entries(probes)) assert.equal(response.status, 404, `${name}: another workspace's project is not found (${serialize(response.body)})`)
      note('cross-workspace', { ui: 'project-not-found', api: Object.fromEntries(Object.entries(probes).map(([name, response]) => [name, response.status])) })
      await strangerContext.close()
      await other.stop()
      servers.splice(servers.indexOf(other), 1)
    }

    /* ================================================================== 16:9 =================================================================== */
    {
      const entry = VARIANTS[1]
      await openOutput(entry)
      await sameChips(wide.review)
      const baselineChips = await chipCodes()
      assert.ok(baselineChips.some(([code, severity, cue]) => code === 'CAPTION_PLACEMENT_MISMATCH' && severity === 'block' && cue === 'cue-1'), 'the hard mismatch is a block chip')
      assert.equal(await page.getByTestId('proxy-review-acknowledge').count(), 0, 'a blocked review offers no acknowledge button')
      assert.equal(await page.getByTestId('issue-count-block').innerText(), String(baselineChips.filter(([, severity]) => severity === 'block').length))

      // --- evidence is open and complete; selecting a chip seeks the preview to its range
      await selectChip('CAPTION_PLACEMENT_MISMATCH', 'cue-1')
      const evidenceText = await page.getByTestId('issue-evidence').innerText()
      assert.equal(await page.getByTestId('issue-evidence').evaluate((node) => node.open), true, 'the evidence panel is open, not collapsed')
      assert.ok(evidenceText.includes(wide.review.reviewHash) && evidenceText.includes(wide.review.inputHash) && evidenceText.includes(wide.proxy.sha256) && evidenceText.includes(wide.proxy.artifactId))
      const mismatch = issuesOf(wide.review).find((issue) => issue.code === 'CAPTION_PLACEMENT_MISMATCH' && issue.elementIds.includes('subtitle:cue-1'))
      for (const id of [...mismatch.evidenceIds, ...mismatch.elementIds]) assert.ok(evidenceText.includes(id), `the evidence panel lists ${id}`)
      await waitFor('the preview seeks to the chip range', async () => {
        const time = await page.getByTestId('project-preview').evaluate((video) => video.currentTime)
        return Math.abs(time - mismatch.evidenceRange.startFrame / 30) < 0.25
      }, { timeoutMs: 30_000 })
      // an attempt to acknowledge a block is refused by the server; the UI never offered it
      const refused = await api('POST', `${projectPath}/proxy-reviews`, { key: `w68-${suffix}-ack-block`, body: { action: 'acknowledge-warnings', proxyReviewId: wide.review.id, projectVersionId: world.headVersionId, baseRevision: wide.review.reviewHash, expectedRevision: wide.review.revision } })
      assert.equal(refused.status, 428, `acknowledging a blocked review is refused as a precondition (${serialize(refused.body).slice(0, 200)})`)
      assert.equal(refused.error?.code, 'PRECONDITION_REQUIRED', 'with the published code')
      assert.equal(await decisionCount(), 0)
      note('wide-evidence-and-ack-refusal', { chips: baselineChips.length, ackStatus: refused.status, ackError: refused.error?.code })
      await panel.screenshot({ path: join(evidenceDir, `w68-16x9-1-before-panel-${wide.review.reviewHash.slice(0, 10)}.png`) })

      // --- the hard issue is fixed by a shorter text. Stale base first: someone else commits between the read and the click.
      const before = await head()
      const beforeFacts = await immutableFacts(before.id, tall.variantId)
      const oldFrame = await frameAt(wide.proxy, cueMid(CUE1)), reference = await frameAt(wide.proxy, 5)
      const clustersBeforeText = changedClusters(reference, oldFrame)
      const bottom = bandRows('16:9', 'bottom')
      assert.ok(clustersBeforeText.length >= 1 && !clustersWithin(clustersBeforeText, bottom), `the BASELINE caption overflows the bottom band on the decoded pixels, as the critic said: ${serialize(clustersBeforeText)} vs ${serialize(bottom)}`)
      await page.getByTestId('caption-form').waitFor()
      await page.getByTestId('caption-text').fill('Primeira legenda')
      const other = await api('POST', `${projectPath}/subtitle-segment-overrides`, { key: `w68-${suffix}-other-writer`, body: { baseVersionId: before.id, baseHash: before.baseHash, variantId: entry.variantId, segmentId: 'cue-3', action: 'set', dimensions: [{ kind: 'text', text: 'Terceira legenda.' }] } })
      assert.equal(other.status, 201, serialize(other.body))
      const versionsBefore = await db.v2ProjectVersion.count({ where: { projectId: world.projectId } })
      await page.getByTestId('caption-apply').click()
      await page.locator('[data-testid="issue-command-failure"][data-failure-kind="stale-base"]').waitFor()
      assert.equal(await db.v2ProjectVersion.count({ where: { projectId: world.projectId } }), versionsBefore, 'a refused stale Command writes nothing')
      assert.equal(await page.locator('[data-testid="issue-applied"]').count(), 0)
      note('wide-stale-base', { failure: (await page.getByTestId('issue-command-failure').innerText()).slice(0, 300) })
      await page.getByTestId('issue-conflict-refetch').click()
      await waitFor('the editor reads the newer Version', async () => (await panel.innerText()).includes(`V${other.data.version.sequence}`), { timeoutMs: 60_000 })
      await selectChip('CAPTION_PLACEMENT_MISMATCH', 'cue-1')
      await page.getByTestId('caption-form').waitFor()
      assert.equal(await page.getByTestId('caption-text').inputValue(), 'Primeira legenda', 'the draft survived the conflict')
      const beforeFix = await head()
      assert.equal(beforeFix.id, other.data.version.id)
      const beforeFixFacts = await immutableFacts(beforeFix.id, tall.variantId)
      await page.getByTestId('caption-apply').click()
      await waitRecompiled('wide text fix')
      const afterFix = await head()
      assert.equal(afterFix.sequence, beforeFix.sequence + 1)
      assert.equal((await db.v2EditCommand.findUniqueOrThrow({ where: { id: afterFix.commandId } })).type, 'apply-subtitle-segment-override')
      const fixProxy = await proxyOf(afterFix.id, entry.variantId)
      assert.ok(fixProxy, 'the output was rendered again')
      const tallCarriedOp = await db.v2ProjectProxyRenderOperation.findFirst({ where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, projectVersionId: afterFix.id, outputVariantId: tall.variantId } })
      assert.ok(tallCarriedOp?.reusedFromOperationId, 'the vertical output was not rendered again: its render was CARRIED to the new Version, recorded as taken from the operation that had it')
      assert.equal(tallCarriedOp.outputArtifactId, tall.proxy.artifactId, 'the artifact of its first render')
      assert.equal((await proxyOf(afterFix.id, tall.variantId)).sha256, tall.proxy.sha256, 'and it is the very same MP4')
      assert.equal(await immutableFacts(beforeFix.id, tall.variantId), beforeFixFacts, 'the previous Version and the vertical output are untouched')
      assert.equal(await immutableFacts(before.id, tall.variantId), beforeFacts, 'the Version before the other writer is untouched too')
      const fixedReview = await reviewOf(entry.variantId, afterFix.id)
      assert.ok(!issuesOf(fixedReview).some((issue) => issue.code === 'CAPTION_PLACEMENT_MISMATCH'), 'a NEW critic run on NEW pixels no longer reports the hard mismatch')
      assert.notEqual(fixedReview.status, 'blocked')
      // The approval of a proxy names the set of exceptions it was drawn with (the final export refuses another set); the baseline render was drawn with none.
      assert.match(fixedReview.formatQuality.subtitleOverridesHash ?? '', /^[a-f0-9]{64}$/, 'the review of a render with an exception names the set')
      assert.match(wide.review.formatQuality.subtitleOverridesHash ?? '', /^[a-f0-9]{64}$/, 'the baseline render was drawn with the over-long text exception the world seeded')
      assert.notEqual(fixedReview.formatQuality.subtitleOverridesHash, wide.review.formatQuality.subtitleOverridesHash, 'and the fix is another set of exceptions')
      assert.equal(tall.review.formatQuality.subtitleOverridesHash, undefined, 'the untouched output was drawn with none')
      const fixedFrame = await frameAt(fixProxy, cueMid(CUE1)), fixedReference = await frameAt(fixProxy, 5)
      const clustersAfterText = changedClusters(fixedReference, fixedFrame)
      assert.ok(clustersAfterText.length >= 1 && clustersWithin(clustersAfterText, bottom), `the fixed caption sits inside the bottom band on the decoded pixels: ${serialize(clustersAfterText)} vs ${serialize(bottom)}`)
      await sameChips(fixedReview)
      const rows = await page.locator('[data-testid="issue-comparison-row"]').evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('data-delta'), node.textContent]))
      assert.ok(rows.some(([delta, text]) => delta === 'not-reported-now' && text.includes('CAPTION_PLACEMENT_MISMATCH')), 'the comparison says the mismatch is no longer reported, after a new render')
      assert.equal(await decisionCount(), 0, 'nothing was accepted by any click')
      await shoot('16x9-2-text-fix', { 'cue-1-before': oldFrame, 'cue-1-after': fixedFrame })
      await panel.screenshot({ path: join(evidenceDir, `w68-16x9-2-after-text-fix-panel-${fixProxy.sha256.slice(0, 10)}.png`) })
      note('wide-text-fix', { beforeProxy: wide.proxy.sha256, afterProxy: fixProxy.sha256, clustersBefore: clustersBeforeText, clustersAfter: clustersAfterText, reviewStatus: fixedReview.status, cue: 'cue-1' })
    }
    /* ================================================== shared helpers of the remaining scenarios ================================================== */
    const range = (from, to) => Array.from({ length: to - from }, (_, index) => from + index)
    const planAt = async (variantId, versionId) => {
      const response = await api('GET', `${projectPath}/reframe-plans?variantId=${encodeURIComponent(variantId)}&projectVersionId=${versionId}`)
      assert.equal(response.status, 200, serialize(response.body))
      return response.data.plan
    }
    const plansOf = async (versionId) => ({ wide: (await planAt(world.wideVariantId, versionId))?.recordHash ?? null, tall: (await planAt(world.verticalVariantId, versionId))?.recordHash ?? null })
    const cropAt = (plan, frame) => {
      const keyframes = plan.renderPlan.ranges.find((candidate) => candidate.startFrame <= frame && frame < candidate.endFrame).keyframes
      let previous = keyframes[0], next
      for (const keyframe of keyframes) { if (keyframe.frame <= frame) previous = keyframe; else { next = keyframe; break } }
      if (!next) return previous.crop
      const ratio = (frame - previous.frame) / (next.frame - previous.frame)
      return { ...previous.crop, x: previous.crop.x + (next.crop.x - previous.crop.x) * ratio }
    }
    const snapshot = async (entry) => {
      const version = await head()
      return { beforeVersion: version, beforeFacts: await immutableFacts(version.id, siblingOf(entry.variantId).variantId), beforePlans: await plansOf(version.id) }
    }
    const afterCommand = async ({ entry, beforeVersion, beforeFacts, beforePlans, label, type, rendered = true }) => {
      const sibling = siblingOf(entry.variantId)
      const current = await head()
      assert.equal(current.sequence, beforeVersion.sequence + 1, `${label}: exactly one new Version`)
      assert.equal(current.parentVersionId, beforeVersion.id)
      const command = await db.v2EditCommand.findUniqueOrThrow({ where: { id: current.commandId } })
      assert.equal(command.type, type, `${label}: the Command type`)
      assert.deepEqual(JSON.parse(command.scopeJson).outputVariantIds, [entry.variantId], `${label}: the Command names the output it is for`)
      const operations = await db.v2ProjectProxyRenderOperation.findMany({ where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, projectVersionId: current.id } })
      const fresh = operations.filter((operation) => operation.reusedFromOperationId === null)
      assert.ok(fresh.every((operation) => operation.outputVariantId === entry.variantId) && (!rendered || fresh.length >= 1), `${label}: every render made for the new Version is for ${entry.key} only`)
      const siblingOperation = operations.find((operation) => operation.outputVariantId === sibling.variantId)
      assert.ok(siblingOperation === undefined || siblingOperation.reusedFromOperationId !== null, `${label}: the other output was never rendered again (at most its render was carried)`)
      assert.equal(await immutableFacts(beforeVersion.id, sibling.variantId), beforeFacts, `${label}: the previous Version and the other output's renders, reviews and approvals are untouched`)
      if (type === 'apply-subtitle-segment-override') assert.deepEqual(await plansOf(current.id), beforePlans, `${label}: both outputs keep the very same reframe plan record on the new Version`)
      assert.equal(await decisionCount(), 0, `${label}: nothing was accepted`)
      return current
    }
    const fillForm = async ({ anchor, text, visible }) => {
      await page.getByTestId('caption-form').waitFor()
      if (anchor !== undefined) await page.getByTestId('caption-anchor').selectOption(anchor)
      if (text !== undefined) await page.getByTestId('caption-text').fill(text)
      if (visible !== undefined) await page.getByTestId('caption-visible').setChecked(visible)
    }
    const segmentStates = async (variantId) => (await api('GET', `${projectPath}/subtitle-segments?variantId=${encodeURIComponent(variantId)}`)).data.segments.map((segment) => [segment.segmentId, segment.state])
    const CUE2 = CUES[1]
    const mid2 = cueMid(CUE2)

    /* ============================ 16:9 : unsafe pin (with a replay), reset, safe pin (protected), reset, hide ============================ */
    {
      const entry = VARIANTS[1]
      const occupied = occupiedBands({ scene: SCENE, format: '16:9', frames: range(CUE2.startFrame, CUE2.endFrame) })
      const unsafe = occupied.find((anchor) => anchor !== 'bottom')
      const safe = ['lower-third', 'top', 'upper-third', 'center'].find((anchor) => !occupied.includes(anchor))
      assert.ok(unsafe && safe, `the generator's face occupies some band and leaves another free: ${occupied.join(',')}`)
      await openOutput(entry)
      const current = await head()
      const currentProxy = await proxyOf(current.id, entry.variantId)
      const reference = await frameAt(currentProxy, mid2), early = await frameAt(currentProxy, 5), late = await frameAt(currentProxy, 120)
      const bottom = bandRows('16:9', 'bottom')

      // ---- unsafe pin: the band is occupied by the generator's face -> the plan refuses to draw it; the answer is lost once -> replay
      let snap = await snapshot(entry)
      await selectChip('FACE_PIXEL_CHECK_UNAVAILABLE', 'cue-2')
      await fillForm({ anchor: unsafe })
      let posts = 0
      await page.route('**/v1/projects/*/subtitle-segment-overrides', async (route) => {
        if (route.request().method() !== 'POST') { await route.continue(); return }
        posts += 1
        if (posts === 1) { await route.fetch(); await route.abort('failed') } else await route.continue()
      })
      await page.getByTestId('caption-apply').click()
      await page.locator('[data-testid="issue-command-failure"][data-failure-kind="unavailable"]').waitFor()
      const createdByFirst = await head()
      assert.equal(createdByFirst.sequence, snap.beforeVersion.sequence + 1, 'the first request reached the server and committed even though the browser never saw the answer')
      await page.getByTestId('caption-apply').click()
      await page.getByTestId('issue-applied').waitFor()
      await page.unroute('**/v1/projects/*/subtitle-segment-overrides')
      assert.match(await page.getByTestId('issue-applied-version').innerText(), /repetição da mesma chave/)
      assert.equal((await head()).id, createdByFirst.id, 'the replay is the same Version: no second one was created')
      assert.equal(posts, 2)
      await waitRecompiled('unsafe pin')
      await afterCommand({ entry, ...snap, label: 'wide unsafe pin', type: 'apply-subtitle-segment-override' })
      const unsafeProxy = await proxyOf(createdByFirst.id, entry.variantId)
      const unsafeReview = await reviewOf(entry.variantId, createdByFirst.id)
      const refusal = issuesOf(unsafeReview).find((issue) => issue.code === 'NO_SAFE_SUBTITLE_REGION' && issue.elementIds.includes('subtitle:cue-2'))
      assert.ok(refusal, `the occupied band is refused with its reason: ${serialize(issuesOf(unsafeReview).map((issue) => issue.code))}`)
      assert.ok(refusal.evidenceIds.length > 0 && refusal.evidenceRange.startFrame === CUE2.startFrame)
      const unsafeFrame = await frameAt(unsafeProxy, mid2)
      const vanished = changedClusters(reference, unsafeFrame)
      assert.equal(vanished.length, 1, `only the old caption changed (it is gone): ${serialize(vanished)}`)
      assert.ok(clustersWithin(vanished, bottom), 'and it was in the bottom band')
      await sameChips(unsafeReview)
      await shoot('16x9-3-unsafe-pin', { 'cue-2-before': reference, 'cue-2-after': unsafeFrame })
      await panel.screenshot({ path: join(evidenceDir, `w68-16x9-3-unsafe-pin-panel-${unsafeProxy.sha256.slice(0, 10)}.png`) })
      note('wide-unsafe-pin', { occupied, unsafe, replayedPosts: posts, version: createdByFirst.id, issue: refusal.code, vanished })

      // ---- reset: back to the inherited level; the decoded frames are the inherited ones again
      snap = await snapshot(entry)
      await selectChip('NO_SAFE_SUBTITLE_REGION', 'cue-2')
      await page.getByTestId('caption-form').waitFor()
      await page.getByTestId('caption-reset').click()
      await waitRecompiled('reset after unsafe pin')
      const resetVersion = await afterCommand({ entry, ...snap, label: 'wide reset', type: 'apply-subtitle-segment-override' })
      const resetProxy = await proxyOf(resetVersion.id, entry.variantId)
      const resetReview = await reviewOf(entry.variantId, resetVersion.id)
      assert.ok(!issuesOf(resetReview).some((issue) => issue.code === 'NO_SAFE_SUBTITLE_REGION'))
      assert.equal((await frameAt(resetProxy, mid2)).sha256, reference.sha256, 'the decoded frame of cue-2 is exactly the inherited one')
      assert.equal((await frameAt(resetProxy, 5)).sha256, early.sha256)
      assert.equal((await frameAt(resetProxy, 120)).sha256, late.sha256)
      const resetState = (await api('GET', `${projectPath}/subtitle-segments?variantId=${encodeURIComponent(entry.variantId)}`)).data.segments.find((segment) => segment.segmentId === 'cue-2')
      assert.equal(resetState.state, 'inherited')
      assert.equal(resetState.override.action, 'reset')
      note('wide-reset', { frame: reference.sha256, proxyBefore: currentProxy.sha256, proxyAfter: resetProxy.sha256 })

      // ---- safe pin: the caption moves to a band the evidence certifies, measured on the pixels; protected; then reset
      snap = await snapshot(entry)
      await openOutput(entry)
      await selectChip('FACE_PIXEL_CHECK_UNAVAILABLE', 'cue-2')
      await fillForm({ anchor: safe })
      await page.getByTestId('caption-protected').setChecked(true)
      await page.getByTestId('caption-apply').click()
      await waitRecompiled('safe pin')
      const safeVersion = await afterCommand({ entry, ...snap, label: 'wide safe pin', type: 'apply-subtitle-segment-override' })
      const safeProxy = await proxyOf(safeVersion.id, entry.variantId)
      const safeReview = await reviewOf(entry.variantId, safeVersion.id)
      assert.ok(!issuesOf(safeReview).some((issue) => issue.code === 'NO_SAFE_SUBTITLE_REGION'))
      const safeFrame = await frameAt(safeProxy, mid2)
      const moved = changedClusters(reference, safeFrame)
      const target = bandRows('16:9', safe)
      assert.equal(moved.length, 2, `the old caption vanished and a new one appeared: ${serialize(moved)}`)
      assert.ok(moved.some((cluster) => clustersWithin([cluster], bottom)) && moved.some((cluster) => clustersWithin([cluster], target)), `one cluster in the bottom band, one in ${safe}: ${serialize({ moved, bottom, target })}`)
      const activeList = await page.getByTestId('active-exceptions').innerText()
      assert.ok(/legenda cue-2/.test(activeList) && /protegida/.test(activeList), `the active exception is listed: ${activeList}`)
      const protectedRow = (await api('GET', `${projectPath}/subtitle-segment-overrides?variantId=${encodeURIComponent(entry.variantId)}&segmentId=cue-2`)).data.result
      assert.equal(protectedRow.subtitleOverride.protected, true, 'the exception is protected')
      assert.equal(protectedRow.subtitleOverride.commandId, safeVersion.commandId, 'the exception is the one the Command of this very Version created')
      assert.equal(protectedRow.subtitleOverride.resultVersionId, safeVersion.id)
      await shoot('16x9-5-safe-pin', { 'cue-2-before': reference, 'cue-2-after': safeFrame })
      await panel.screenshot({ path: join(evidenceDir, `w68-16x9-5-safe-pin-panel-${safeProxy.sha256.slice(0, 10)}.png`) })
      note('wide-safe-pin', { safe, moved, override: protectedRow.subtitleOverride.overrideHash })
      snap = await snapshot(entry)
      await selectChip('FACE_PIXEL_CHECK_UNAVAILABLE', 'cue-2')
      await page.getByTestId('caption-form').waitFor()
      await page.getByTestId('caption-reset').click()
      await waitRecompiled('reset after safe pin')
      const reset2 = await afterCommand({ entry, ...snap, label: 'wide second reset', type: 'apply-subtitle-segment-override' })
      assert.equal((await frameAt(await proxyOf(reset2.id, entry.variantId), mid2)).sha256, reference.sha256, 'reset returns the inherited geometry, pixel for pixel')

      // ---- hide cue-3: its chip goes away because the NEW critic no longer sees a caption to certify, not because anyone clicked it
      snap = await snapshot(entry)
      await selectChip('FACE_PERCEPTION_UNAVAILABLE', 'cue-3')
      await fillForm({ visible: false })
      await page.getByTestId('caption-apply').click()
      await waitRecompiled('hide cue-3')
      const hiddenVersion = await afterCommand({ entry, ...snap, label: 'wide hide', type: 'apply-subtitle-segment-override' })
      const hiddenReview = await reviewOf(entry.variantId, hiddenVersion.id)
      assert.ok(!issuesOf(hiddenReview).some((issue) => issue.elementIds.includes('subtitle:cue-3')))
      assert.equal(await page.locator('[data-testid="issue-chip"][data-cue-id="cue-3"]').count(), 0)
      assert.ok((await page.locator('[data-testid="issue-comparison-row"][data-delta="not-reported-now"]').count()) >= 1)
      assert.deepEqual((await segmentStates(entry.variantId)).find(([id]) => id === 'cue-3'), ['cue-3', 'overridden'])
      note('wide-hide', { review: hiddenReview.status })
    }

    /* ====== 9:16 : render the current Version, pin with an expired session, reframe set/reset, hide + cancel the recompile ====== */
    {
      const entry = VARIANTS[0]
      await openOutput(entry)
      const current = await head()
      // The vertical output was never touched by anything done to the wide one: its render was carried to the current Version, so there is nothing to render
      // and the editor does not offer it.
      assert.equal(await page.getByTestId('issue-render-current').count(), 0, 'the vertical output needs no render of the current Version')
      const carriedTall = await db.v2ProjectProxyRenderOperation.findFirst({ where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, projectVersionId: current.id, outputVariantId: entry.variantId } })
      assert.ok(carriedTall?.reusedFromOperationId && carriedTall.outputArtifactId === tall.proxy.artifactId, 'and its render of the current Version is the carried one: the artifact of its first render')
      const wideFacts = await immutableFacts(current.id, siblingOf(entry.variantId).variantId)
      assert.equal(await immutableFacts(current.id, siblingOf(entry.variantId).variantId), wideFacts, 'looking at the vertical output touched nothing of the wide one')
      const tallNow = await proxyOf(current.id, entry.variantId)
      await waitFor('the vertical review reaches the editor', async () => (await page.locator('[data-testid="issue-chip"]').count()) > 0, { timeoutMs: 120_000 })
      const tallReview = await reviewOf(entry.variantId, current.id)
      await sameChips(tallReview)
      // W70 readiness (R1): the carried render is labelled in the review panel as an automatic carry from the earlier Version, and since nothing
      // was approved on the vertical output, the carry says it approved nothing and a person is still asked to decide.
      assert.deepEqual(Object.keys(tallReview.carriedFrom ?? {}).sort(), ['decisionId', 'renderContentHash', 'reviewHash', 'reviewId', 'versionId'], 'the public review names where the render was carried from')
      assert.equal(tallReview.carriedFrom.decisionId, null, 'no approval existed to re-bind')
      await waitFor('the carry is labelled in the review panel', async () => (await page.getByTestId('proxy-review-carried').count()) > 0, { timeoutMs: 60_000 })
      const carriedHeadline = await page.getByTestId('proxy-review-carried-headline').innerText()
      assert.equal(carriedHeadline, `Render herdado automaticamente da versão ${tallReview.carriedFrom.versionId} — conteúdo idêntico`)
      assert.equal(await page.getByTestId('proxy-review-carried').getAttribute('data-carried-kind'), 'render-carried')
      assert.equal(await page.getByTestId('proxy-review-acknowledge').count(), 1, 'the inheritance approved nothing: a person is still asked to acknowledge the warnings')
      // the vertical pixels are what they were at its first render: nothing done to the wide output reached them
      const probeFrames = [5, 25, 70, 120]
      for (const frame of probeFrames) assert.equal((await frameAt(tallNow, frame)).sha256, (await frameAt(tall.proxy, frame)).sha256, `vertical frame ${frame} equals the one of its first render`)
      note('tall-unaffected-by-wide', { first: tall.proxy.sha256, again: tallNow.sha256, frames: probeFrames })

      const plan = await planAt(entry.variantId, current.id)
      const window = cropAt(plan, mid2)
      const occupied = occupiedBands({ scene: SCENE, format: '9:16', frames: range(CUE2.startFrame, CUE2.endFrame), window: { x: window.x, width: window.width } })
      const safe = ['top', 'upper-third', 'center', 'lower-third'].find((anchor) => !occupied.includes(anchor))
      assert.ok(safe, `a free band exists on the vertical output: ${occupied.join(',')}`)
      const reference = await frameAt(tallNow, mid2), early = await frameAt(tallNow, 5), late = await frameAt(tallNow, 120)

      // ---- safe pin with an EXPIRED SESSION: the draft survives the sign-in
      let snap = await snapshot(entry)
      await selectChip('FACE_PIXEL_CHECK_UNAVAILABLE', 'cue-2')
      await fillForm({ anchor: safe })
      await context.clearCookies({ name: 'apollo_session' })
      const versionsBefore = await db.v2ProjectVersion.count({ where: { projectId: world.projectId } })
      await page.getByTestId('caption-apply').click()
      await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 30_000 })
      assert.ok(decodeURIComponent(new URL(page.url()).searchParams.get('next') ?? '').includes(`/projects/${world.projectId}`), 'the sign-in returns to this project')
      assert.equal(await db.v2ProjectVersion.count({ where: { projectId: world.projectId } }), versionsBefore, 'an expired session writes nothing')
      const stored = await page.evaluate(() => Object.entries(window.localStorage).filter(([key]) => key.startsWith('apollo:v2:issue-draft:')).map(([, value]) => JSON.parse(value)))
      assert.ok(stored.some((draft) => draft.segmentId === 'cue-2' && draft.form.anchor === safe), 'the draft is in the browser storage')
      await login(page, server.baseUrl, projectUrl)
      await openOutput(entry)
      await selectChip('FACE_PIXEL_CHECK_UNAVAILABLE', 'cue-2')
      await page.getByTestId('caption-form').waitFor()
      assert.equal(await page.getByTestId('caption-anchor').inputValue(), safe, 'the draft came back after the sign-in')
      note('tall-session-expired', { redirectedTo: 'login?next=project', draftRestored: safe })
      await page.getByTestId('caption-apply').click()
      await waitRecompiled('tall safe pin')
      const pinned = await afterCommand({ entry, ...snap, label: 'tall safe pin', type: 'apply-subtitle-segment-override' })
      const pinnedProxy = await proxyOf(pinned.id, entry.variantId)
      const pinnedFrame = await frameAt(pinnedProxy, mid2)
      const bottom = bandRows('9:16', 'bottom'), target = bandRows('9:16', safe)
      const movedTall = changedClusters(reference, pinnedFrame)
      assert.equal(movedTall.length, 2, `the old caption vanished and a new one appeared: ${serialize(movedTall)}`)
      assert.ok(movedTall.some((cluster) => clustersWithin([cluster], bottom)) && movedTall.some((cluster) => clustersWithin([cluster], target)), serialize({ movedTall, bottom, target }))
      await sameChips(await reviewOf(entry.variantId, pinned.id))
      await shoot('9x16-2-safe-pin', { 'cue-2-before': reference, 'cue-2-after': pinnedFrame })
      await panel.screenshot({ path: join(evidenceDir, `w68-9x16-2-safe-pin-panel-${pinnedProxy.sha256.slice(0, 10)}.png`) })
      snap = await snapshot(entry)
      await selectChip('FACE_PIXEL_CHECK_UNAVAILABLE', 'cue-2')
      await page.getByTestId('caption-form').waitFor()
      await page.getByTestId('caption-reset').click()
      await waitRecompiled('tall reset')
      const tallReset = await afterCommand({ entry, ...snap, label: 'tall reset', type: 'apply-subtitle-segment-override' })
      const tallResetProxy = await proxyOf(tallReset.id, entry.variantId)
      assert.equal((await frameAt(tallResetProxy, mid2)).sha256, reference.sha256, 'the vertical reset returns the inherited frame, pixel for pixel')
      assert.equal((await frameAt(tallResetProxy, 5)).sha256, early.sha256)
      assert.equal((await frameAt(tallResetProxy, 120)).sha256, late.sha256)

      // ---- reframe: the crop of frames 100-150 (no evidence) is framed by hand, then reset to the automatic level
      const planBefore = await planAt(entry.variantId, tallReset.id)
      const centroid = (frame) => {
        let sum = 0, count = 0
        for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
          const offset = (y * frame.width + x) * 3
          if (frame.data[offset] > 200 && frame.data[offset + 1] < 90 && frame.data[offset + 2] < 90) { sum += x; count += 1 }
        }
        return count > 200 ? sum / count : null
      }
      const subjectFrame = 120
      const subjectBox = SCENE.subjectsAtSource(subjectFrame)[0].box
      const faceCentreX = (subjectBox[0] + subjectBox[2]) / 2
      const autoFrame = await frameAt(tallResetProxy, subjectFrame)
      const autoCentroid = centroid(autoFrame)
      snap = await snapshot(entry)
      await selectChip('REFRAME_PERCEPTION_UNCERTAIN')
      await page.getByTestId('reframe-form').waitFor()
      const cropX = 0.25
      await page.getByTestId('reframe-x').evaluate((input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value))
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }, cropX)
      await page.getByTestId('reframe-apply').click()
      await waitRecompiled('reframe set')
      const framed = await afterCommand({ entry, ...snap, label: 'reframe set', type: 'apply-variant-reframe-override' })
      const framedProxy = await proxyOf(framed.id, entry.variantId)
      const framedPlan = await planAt(entry.variantId, framed.id)
      assert.equal(framedPlan.serverPlanHash, planBefore.serverPlanHash, 'the server plan did not move: only the final plan did')
      assert.notEqual(framedPlan.finalPlanHash, planBefore.finalPlanHash)
      const payload = JSON.parse((await db.v2EditCommand.findUniqueOrThrow({ where: { id: framed.commandId } })).payloadJson)
      assert.ok(Math.abs(payload.crop.x - cropX) < 0.01, `the Command carries the crop the editor chose: ${serialize(payload.crop)}`)
      const framedFrame = await frameAt(framedProxy, subjectFrame)
      const framedCentroid = centroid(framedFrame)
      const expectedX = ((faceCentreX - payload.crop.x) / payload.crop.width) * framedFrame.width
      assert.ok(framedCentroid !== null && Math.abs(framedCentroid - expectedX) < 14, `the subject sits where the chosen crop puts it: measured ${framedCentroid}, specified ${expectedX}`)
      assert.ok(autoCentroid === null || Math.abs(autoCentroid - framedCentroid) > 20, `the manual crop changed the frame: automatic ${autoCentroid}, manual ${framedCentroid}`)
      const framedReview = await reviewOf(entry.variantId, framed.id)
      await sameChips(framedReview)
      await shoot('9x16-3-reframe-set', { 'frame-120-before': autoFrame, 'frame-120-after': framedFrame })
      await panel.screenshot({ path: join(evidenceDir, `w68-9x16-3-reframe-set-panel-${framedProxy.sha256.slice(0, 10)}.png`) })
      note('tall-reframe-set', { cropX: payload.crop.x, expectedX, framedCentroid, autoCentroid, reframeIssuesAfter: issuesOf(framedReview).filter((issue) => issue.code.startsWith('REFRAME_')).map((issue) => [issue.code, issue.evidenceRange]) })
      snap = await snapshot(entry)
      // the reframe issue is gone (the new critic run no longer reports it), but the manual exception is still listed and reversible
      await page.getByTestId('active-reframe-exception').waitFor()
      assert.match(await page.getByTestId('active-reframe-exception').innerText(), /enquadramento manual/)
      await page.getByTestId('active-reframe-reset').click()
      await waitRecompiled('reframe reset')
      const unframed = await afterCommand({ entry, ...snap, label: 'reframe reset', type: 'apply-variant-reframe-override' })
      const unframedPlan = await planAt(entry.variantId, unframed.id)
      assert.equal(unframedPlan.recordHash, planBefore.recordHash, 'a complete reset returns the very record the automatic plan had')
      assert.equal((await frameAt(await proxyOf(unframed.id, entry.variantId), subjectFrame)).sha256, autoFrame.sha256, 'and the decoded frame is the automatic one again')
      note('tall-reframe-reset', { record: unframedPlan.recordHash })

      // ---- hide cue-3, and cancel the recompile while it waits: no partial artifact is promoted
      note('tall-hide-begin')
      snap = await snapshot(entry)
      note('tall-hide-snapshot', { sequence: snap.beforeVersion.sequence })
      await openOutput(entry)
      await selectChip('FACE_PERCEPTION_UNAVAILABLE', 'cue-3')
      await fillForm({ visible: false })
      pump.pause()
      await page.getByTestId('caption-apply').click()
      const hiddenTall = await waitFor('the hide Command is committed', async () => { const version = await head(); return version.sequence === snap.beforeVersion.sequence + 1 ? version : null }, { timeoutMs: 60_000 }).catch(async (error) => {
        await page.screenshot({ path: join(evidenceDir, 'w68-diagnostic-tall-hide.png'), fullPage: true }).catch(() => undefined)
        const seen = await page.evaluate(() => ({ failure: document.querySelector('[data-testid="issue-command-failure"]')?.textContent ?? null, kind: document.querySelector('[data-testid="issue-command-failure"]')?.getAttribute('data-failure-kind') ?? null, text: document.body.innerText.slice(0, 1200) })).catch(() => null)
        throw new Error(`${error.message} :: the editor said ${serialize(seen)} :: head sequence ${(await head()).sequence} (was ${snap.beforeVersion.sequence})`)
      })
      await page.locator(`[data-testid="issue-applied"][data-command-id="${hiddenTall.commandId}"]`).waitFor()
      lastApplied = hiddenTall.commandId
      await afterCommand({ entry, ...snap, label: 'tall hide', type: 'apply-subtitle-segment-override', rendered: false })
      await page.locator('[data-testid="issue-recompile"][data-recompile-phase="queued"]').waitFor()
      await page.getByTestId('issue-recompile-status').waitFor()
      await page.getByTestId('issue-recompile-cancel').click()
      assert.equal(await page.getByTestId('issue-recompile-cancel').innerText(), 'Confirmar o cancelamento', 'cancelling asks for a confirmation')
      await page.getByTestId('issue-recompile-cancel').click()
      await waitFor('the operation is canceled', async () => (await db.v2PublicOperation.findFirst({ where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, type: 'project-proxy-render', status: 'canceled' } })) !== null, { timeoutMs: 60_000 })
      await page.locator('[data-testid="issue-recompile-status"]').filter({ hasText: 'Cancelado' }).waitFor()
      pump.resume()
      await delay(6_000)
      assert.equal(await proxyOf(hiddenTall.id, entry.variantId), null, 'a canceled recompile promoted no artifact')
      // (the wide output's render, which the Command did not touch, was carried to this Version: not a render of its own)
      const canceledOps = await db.v2ProjectProxyRenderOperation.findMany({ where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, projectVersionId: hiddenTall.id, reusedFromOperationId: null } })
      assert.equal(canceledOps.length, 1)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: canceledOps[0].operationId } })).status, 'canceled')
      note('tall-cancel', { operation: canceledOps[0].operationId, artifact: null })
      // a canceled render is not reopened for the same inputs: the way forward is another Version. Reverting the exception creates it and renders it.
      assert.match(await page.locator('[data-testid="issue-recompile-status"]').innerText(), /não é reaberto para as mesmas entradas/)
      assert.equal(await page.getByTestId('issue-recompile-retry').count(), 0, 'no control pretends the canceled render can be run again')
      snap = await snapshot(entry)
      await page.getByTestId('active-subtitle-exception').waitFor()
      await page.getByTestId('active-subtitle-reset').click()
      await waitRecompiled('revert the hidden cue after the cancel')
      const afterCancel = await afterCommand({ entry, ...snap, label: 'after cancel', type: 'apply-subtitle-segment-override' })
      assert.ok(await proxyOf(afterCancel.id, entry.variantId), 'the next Version was rendered')
      assert.equal(await proxyOf(hiddenTall.id, entry.variantId), null, 'and the canceled Version still has no artifact')
      const afterCancelReview = await reviewOf(entry.variantId, afterCancel.id)
      assert.ok(issuesOf(afterCancelReview).some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE' && issue.elementIds.includes('subtitle:cue-3')) || issuesOf(afterCancelReview).some((issue) => issue.elementIds.includes('subtitle:cue-3')), 'the cue is back, so its issue is back')
      note('tall-after-cancel', { version: afterCancel.id, review: afterCancelReview.status })
    }

    /* ======================================= the whole journey: nothing was accepted by clicking ======================================= */
    assert.equal(await decisionCount(), 0, 'no approval row was written by any click')
    assert.equal(await db.v2ProjectFinalExportOperation.count({ where: { workspaceId: world.owner.workspaceId } }), 0)
    assert.deepEqual(jsErrors, [], 'no uncaught page error')
    assert.equal(workerFailures.length, 0, workerFailures.join('\n'))
  } catch (error) {
    failure = error
    throw error
  } finally {
    await pump?.stop().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    for (const server of servers) await server.stop().catch(() => undefined)
    await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify({ ...evidence, failure: failure ? String(failure.stack ?? failure) : null }, null, 2)).catch(() => undefined)
    if (failure) for (const server of servers) await writeFile(join(evidenceDir, 'server-log-tail.txt'), server.logs.text.slice(-20_000)).catch(() => undefined)
    await db.$disconnect().catch(() => undefined)
    const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
    await disconnectV2PostgresClient().catch(() => undefined)
  }
})
