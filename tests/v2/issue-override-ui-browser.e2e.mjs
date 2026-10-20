import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { artifactPath } from './helpers/capture-journey.mjs'
import { apiClient, chromeExecutable, startServer } from './helpers/issue-override-runtime.mjs'
import { PIXEL_TOLERANCE, bandRows, changedClusters, decodeFrame, sha256Hex } from './helpers/issue-override-proof.mjs'
import { CUES, runProxyWorkerOnce, seedIssueOverrideWorld } from './helpers/issue-override-world.mjs'

/**
 * W68 browser proof (supervised harness; also a CI step). A real Chromium drives the editor against `next start`, PostgreSQL and the production
 * proxy-render worker, on ONE project with TWO outputs (9:16 and 16:9) over one real recording drawn by a generator.
 *
 * Per output: a caption issue chip is opened and its evidence read, an override Command is applied from the chip, the proxy of THAT output
 * only is rendered again, the critic runs again on the new pixels, and the new frames are measured against the old ones; a reset returns the
 * decoded frame to the inherited one. For 16:9 a hard CAPTION_PLACEMENT_MISMATCH (a two-line caption in a wide band) is fixed by a shorter
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

test('W68 issue -> override -> recompile -> critic again, in a real browser, for 9:16 and 16:9', { skip: !enabled, timeout: 3_000_000 }, async () => {
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const db = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
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
    const world = await seedIssueOverrideWorld({ db, artifactRoot, suffix, ffmpegPath })
    const username = `w68-ui-${suffix}`, password = `W68-${suffix}-secure-passphrase`
    const environmentFor = (clientId) => ({
      APOLLO_API_ENVIRONMENT: 'production', APOLLO_AUTH_MODE: 'bootstrap', APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true', APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
      APOLLO_UI_USERNAME: username, APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(password, `w68-salt-${suffix}`),
      APOLLO_UI_SESSION_SECRET: `w68-session-${suffix}-at-least-32-bytes-long`, APOLLO_UI_API_CLIENT_ID: clientId,
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
    })
    const server = await startServer({ appRoot: process.cwd(), environment: environmentFor(world.owner.clientId) })
    servers.push(server)
    const workerEnvironment = { ...process.env, ...environmentFor(world.owner.clientId), V2_DATABASE_URL: process.env.V2_DATABASE_URL }
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
    assert.equal(wide.review.status, 'blocked', 'the wide baseline is blocked by a real pixel mismatch (a two-line caption does not fit the wide band)')
    assert.ok(issuesOf(wide.review).some((issue) => issue.code === 'CAPTION_PLACEMENT_MISMATCH' && issue.severity === 'hard' && issue.elementIds.includes('subtitle:cue-1')))
    assert.equal(tall.review.status, 'warning-ack-required')
    assert.equal(await decisionCount(), 0)

    // What must not move: the previous Version (its row and its EditPlan snapshot) and the OTHER output's renders, reviews and approvals.
    const immutableFacts = async (versionId, siblingVariantId) => {
      const version = await db.v2ProjectVersion.findUniqueOrThrow({ where: { id: versionId }, include: { editPlanSnapshot: true } })
      const siblingOperations = await db.v2ProjectProxyRenderOperation.findMany({ where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, outputVariantId: siblingVariantId }, orderBy: { operationId: 'asc' } })
      const siblingArtifacts = await db.v2MediaArtifact.findMany({ where: { id: { in: siblingOperations.map((operation) => operation.outputArtifactId) }, workspaceId: world.owner.workspaceId }, orderBy: { id: 'asc' } })
      const siblingReviews = await db.v2ProxyReview.findMany({ where: { workspaceId: world.owner.workspaceId, projectId: world.projectId, proxyArtifactId: { in: siblingArtifacts.map((artifact) => artifact.id) } }, orderBy: { id: 'asc' } })
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
    const openOutput = async (entry) => {
      await page.goto(`${server.baseUrl}${projectUrl}`)
      await page.getByTestId(`output-option-${entry.variantId}`).click()
      await page.locator(`[data-testid="issue-override-panel"][data-variant-id="${entry.variantId}"]`).waitFor()
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
    const waitRecompiled = async (label) => {
      await page.getByTestId('issue-applied').waitFor()
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
      await strangerPage.getByTestId('project-not-found').waitFor({ timeout: 60_000 })
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
      assert.ok(refused.status >= 400, `acknowledging a blocked review is refused (${refused.status} ${serialize(refused.body).slice(0, 200)})`)
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
      assert.equal(await proxyOf(afterFix.id, tall.variantId), null, 'the vertical output was not rendered')
      assert.equal(await immutableFacts(beforeFix.id, tall.variantId), beforeFixFacts, 'the previous Version and the vertical output are untouched')
      assert.equal(await immutableFacts(before.id, tall.variantId), beforeFacts, 'the Version before the other writer is untouched too')
      const fixedReview = await reviewOf(entry.variantId, afterFix.id)
      assert.ok(!issuesOf(fixedReview).some((issue) => issue.code === 'CAPTION_PLACEMENT_MISMATCH'), 'a NEW critic run on NEW pixels no longer reports the hard mismatch')
      assert.notEqual(fixedReview.status, 'blocked')
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
    await db.$disconnect().catch(() => undefined)
    const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
    await disconnectV2PostgresClient().catch(() => undefined)
  }
})
