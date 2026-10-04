import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

import { settleOwnedBrowserProcess } from './browser-pid-teardown.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function readPng(baseUrl, path, authorization) {
  const response = await fetch(new URL(path, baseUrl), { headers: { authorization } })
  assert.equal(response.status, 200, `LUT preview ${path} must be readable`)
  assert.equal(response.headers.get('content-type'), 'image/png')
  const bytes = Buffer.from(await response.arrayBuffer())
  const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(decoded.info.width, 512)
  assert.equal(decoded.info.height, 288)
  assert.equal(decoded.info.channels, 3)
  return { bytes, decoded, sha256: digest(bytes) }
}

function changedPixels(left, right) {
  assert.equal(left.decoded.data.length, right.decoded.data.length)
  let count = 0
  for (let offset = 0; offset < left.decoded.data.length; offset += 3) {
    if (Math.abs(left.decoded.data[offset] - right.decoded.data[offset]) > 12 ||
        Math.abs(left.decoded.data[offset + 1] - right.decoded.data[offset + 1]) > 12 ||
        Math.abs(left.decoded.data[offset + 2] - right.decoded.data[offset + 2]) > 12) count += 1
  }
  return count
}

function invertedChannelFraction(left, right) {
  let withinTolerance = 0
  const total = left.decoded.data.length
  for (let offset = 0; offset < total; offset += 1) {
    if (Math.abs(left.decoded.data[offset] + right.decoded.data[offset] - 255) <= 2) withinTolerance += 1
  }
  return withinTolerance / total
}

async function counters(client, workspaceId, projectId) {
  const where = { workspaceId }
  return {
    versions: await client.v2WorkspaceLutVersion.count({ where }),
    defaults: await client.v2WorkspaceLutDefaultVersion.count({ where }),
    statuses: await client.v2WorkspaceLutStatusCommand.count({ where }),
    projectSelections: await client.v2ProjectLutSelection.count({ where: { workspaceId, projectId } }),
    projectVersions: await client.v2ProjectVersion.count({ where: { workspaceId, projectId } }),
    projectCommands: await client.v2EditCommand.count({ where: { workspaceId, projectId } }),
    workspaceProjectVersions: await client.v2ProjectVersion.count({ where }),
    workspaceCommands: await client.v2EditCommand.count({ where }),
  }
}

async function waitForImages(page, paths) {
  await page.getByTestId('lut-comparison-table').waitFor()
  await page.waitForFunction((expectedPaths) => {
    const images = ['lut-compare-a', 'lut-compare-b'].map((id) => document.querySelector(`[data-testid="${id}"] img`))
    return images.every((image, index) => image?.complete && image.naturalWidth === 512 && image.naturalHeight === 288 && (!expectedPaths || image.getAttribute('src') === expectedPaths[index]))
  }, paths)
}

async function readDisplayed(page) {
  return page.evaluate(() => ['a', 'b'].map((label) => {
    const figure = document.querySelector(`[data-testid="lut-compare-${label}"]`)
    const img = figure?.querySelector('img')
    const selector = document.querySelector(`#lut-compare-${label}`)
    return { label, name: figure?.querySelector('figcaption p')?.textContent ?? '', option: selector?.selectedOptions?.[0]?.textContent ?? '', src: img?.getAttribute('src') ?? '', width: img?.naturalWidth ?? 0, height: img?.naturalHeight ?? 0 }
  }))
}

function chromePath() {
  const executable = [
    process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => candidate && existsSync(candidate))
  assert.ok(executable, 'W29 requires a real Chromium executable; no skip is allowed')
  return executable
}

function evidenceDirectory() {
  const configured = process.env.APOLLO_W29_EVIDENCE_DIR
  assert.ok(configured || !process.env.CI, 'CI must set APOLLO_W29_EVIDENCE_DIR')
  const path = resolve(configured || join(tmpdir(), `apollo-w29-${process.pid}`))
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const fromRepo = relative(repoRoot, path)
  assert.ok(fromRepo && (fromRepo.startsWith('..') || isAbsolute(fromRepo)), 'W29 evidence must be outside the repository')
  return path
}

async function boundedClose(label, action, errors) {
  if (!action) return
  let timer
  try {
    await Promise.race([
      action(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000) }),
    ])
  } catch (error) { errors.push(`${label}:${error?.name ?? 'Error'}`) }
  finally { clearTimeout(timer) }
}

export async function proveWorkspaceLutBrowser({ baseUrl, client, workspaceId, projectId, sessionCookieName, sessionCookieValue, authorization, username, originalLut, projectSelectionId }) {
  const evidenceDir = evidenceDirectory()
  await mkdir(evidenceDir, { recursive: true })
  const evidence = { schemaVersion: 'w29-lut-browser-proof/v1', sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null, outcome: 'started', images: [], browser: {}, postflight: {}, counters: {} }
  let browserServer, browser, context, page, browserProcess
  let primaryError
  try {
    const activeSession = await fetch(`${baseUrl}/v1/session`, { headers: { cookie: `${sessionCookieName}=${sessionCookieValue}` } })
    assert.equal(activeSession.status, 200, 'the original POST /v1/session cookie must still be active at W29')
    const activePayload = await activeSession.json()
    assert.equal(activePayload.data.workspaceId, workspaceId)
    assert.equal(activePayload.data.subject, username)
    evidence.session = { status: activeSession.status, workspaceIdMatches: true, subjectMatches: true }
    assert.equal(originalLut.currentVersion.name, 'Coração 🎞️ v2', 'the versioned LUT must round-trip real Unicode before browser rendering')
    assert.equal(originalLut.currentVersion.version, 2)

    // The API baseline runs with exactly one LUT. Import the second only here.
    const contrastCube = 'TITLE "Apollo Contrast"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n1 1 1\n1 1 0\n1 0 1\n1 0 0\n0 1 1\n0 1 0\n0 0 1\n0 0 0\n'
    const secondId = 'public-api-lut-contrast-w29'
    const secondResponse = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/luts`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': 'public-api-lut-w29-contrast-1' },
      body: JSON.stringify({ lutId: secondId, name: 'Contraste W29', owner: 'Apollo E2E', license: { policy: 'owned', name: 'Workspace E2E' }, tags: ['w29'], compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 1, cubeContent: contrastCube }),
    })
    const secondPayload = await secondResponse.json()
    assert.equal(secondResponse.status, 201, JSON.stringify(secondPayload.error ?? {}))
    const secondLut = secondPayload.data.lut
    const originalPng = await readPng(baseUrl, originalLut.currentVersion.preview.path, authorization)
    const secondPng = await readPng(baseUrl, secondLut.currentVersion.preview.path, authorization)
    assert.equal(originalPng.sha256, originalLut.currentVersion.preview.sha256)
    assert.equal(secondPng.sha256, secondLut.currentVersion.preview.sha256)
    assert.notEqual(originalPng.sha256, secondPng.sha256)
    const pixelDelta = changedPixels(originalPng, secondPng)
    assert.ok(pixelDelta > 10_000, `A/B changed only ${pixelDelta} pixels`)
    const inverseFraction = invertedChannelFraction(originalPng, secondPng)
    assert.ok(inverseFraction >= 0.99, `inverse LUT oracle matched only ${(inverseFraction * 100).toFixed(2)}% of channels`)
    await writeFile(join(evidenceDir, 'lut-a-ffmpeg.png'), originalPng.bytes)
    await writeFile(join(evidenceDir, 'lut-b-ffmpeg.png'), secondPng.bytes)
    evidence.images = [
      { label: 'A', lutId: originalLut.id, version: originalLut.currentVersion.version, sha256: originalPng.sha256, width: 512, height: 288 },
      { label: 'B', lutId: secondLut.id, version: secondLut.currentVersion.version, sha256: secondPng.sha256, width: 512, height: 288 },
    ]
    evidence.changedPixels = pixelDelta
    evidence.inverseChannelsWithinTwo = inverseFraction
    const before = await counters(client, workspaceId, projectId)
    evidence.counters.beforeCompare = before

    const { chromium } = await import('playwright-core')
    browserServer = await chromium.launchServer({ executablePath: chromePath(), headless: true })
    browserProcess = browserServer.process()
    assert.ok(browserProcess?.pid, 'W29 browser must have an owned PID')
    evidence.browser.pid = browserProcess.pid
    browser = await chromium.connect(browserServer.wsEndpoint())
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(25_000)
    context.setDefaultNavigationTimeout(30_000)
    await context.addCookies([{ name: sessionCookieName, value: sessionCookieValue, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    page = await context.newPage()
    const requests = []
    const browserPreviewResponses = []
    page.on('request', (request) => { if (new URL(request.url()).origin === baseUrl) requests.push({ method: request.method(), pathname: new URL(request.url()).pathname }) })
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.endsWith('/preview')) {
        browserPreviewResponses.push(response.body()
          .then((body) => ({ pathname: new URL(response.url()).pathname, status: response.status(), sha256: digest(body) }))
          .catch(() => ({ pathname: new URL(response.url()).pathname, status: response.status(), sha256: null })))
      }
    })
    const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 } })
    try {
      const anonymousPage = await anonymous.newPage()
      await anonymousPage.goto(`${baseUrl}/brand`, { waitUntil: 'domcontentloaded' })
      assert.equal(new URL(anonymousPage.url()).pathname, '/login')
      assert.equal(await anonymousPage.getByTestId('lut-library-list').count(), 0)
    } finally { await anonymous.close() }
    await page.goto(`${baseUrl}/brand`, { waitUntil: 'domcontentloaded' })
    await waitForImages(page)
    assert.equal(new URL(page.url()).pathname, '/brand')
    await page.locator('#lut-compare-a').selectOption(originalLut.id)
    await page.locator('#lut-compare-b').selectOption(secondLut.id)
    await waitForImages(page, [originalLut.currentVersion.preview.path, secondLut.currentVersion.preview.path])
    const initial = await readDisplayed(page)
    assert.deepEqual(initial.map((item) => item.name), [originalLut.currentVersion.name, secondLut.currentVersion.name])
    assert.deepEqual(initial.map((item) => item.src), [originalLut.currentVersion.preview.path, secondLut.currentVersion.preview.path])
    assert.ok(initial[0].option.includes(`v${originalLut.currentVersion.version}`))
    assert.ok(initial[1].option.includes(`v${secondLut.currentVersion.version}`))
    const browserImages = await Promise.all(browserPreviewResponses)
    for (const expected of [originalPng, secondPng]) {
      assert.ok(browserImages.some((item) => item.status === 200 && item.sha256 === expected.sha256), 'actual browser image response must match the persisted FFmpeg PNG')
    }
    for (const [index, expected] of [originalPng, secondPng].entries()) {
      const response = await context.request.get(new URL(initial[index].src, baseUrl).toString())
      assert.equal(response.status(), 200)
      assert.equal(digest(await response.body()), expected.sha256, `browser session preview ${index} differs from the FFmpeg PNG`)
    }
    await page.screenshot({ path: join(evidenceDir, 'w29-desktop-a-b.png'), fullPage: true })
    const postHydrationRequestCount = requests.length
    await page.locator('#lut-compare-a').selectOption(secondLut.id)
    await page.locator('#lut-compare-b').selectOption(originalLut.id)
    await waitForImages(page, [secondLut.currentVersion.preview.path, originalLut.currentVersion.preview.path])
    const inverted = await readDisplayed(page)
    assert.deepEqual(inverted.map((item) => item.name), [secondLut.currentVersion.name, originalLut.currentVersion.name])
    assert.deepEqual(inverted.map((item) => item.src), [secondLut.currentVersion.preview.path, originalLut.currentVersion.preview.path])
    assert.equal(requests.slice(postHydrationRequestCount).filter((item) => item.method !== 'GET').length, 0, 'A/B selectors must not mutate API state')
    assert.deepEqual(await counters(client, workspaceId, projectId), before, 'A/B selectors must not mutate PostgreSQL state')
    evidence.counters.afterCompare = await counters(client, workspaceId, projectId)
    evidence.browser.compareMutatingRequests = 0
    evidence.browser.displayed = { initial, inverted }
    await page.screenshot({ path: join(evidenceDir, 'w29-desktop-b-a.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await waitForImages(page, [secondLut.currentVersion.preview.path, originalLut.currentVersion.preview.path])
    await page.screenshot({ path: join(evidenceDir, 'w29-mobile-b-a.png'), fullPage: true })
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert.ok(mobileOverflow <= 1, `W29 mobile overflows by ${mobileOverflow}px`)
    evidence.browser.mobileOverflowPx = mobileOverflow

    // The referenced LUT is retired only after its existing project snapshot is recorded.
    const projectBefore = await client.v2ProjectLutSelection.findUniqueOrThrow({ where: { id: projectSelectionId } })
    const projectVersionBefore = await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: projectBefore.resultVersionId } })
    const originalRowsBefore = await client.v2WorkspaceLutVersion.findMany({ where: { workspaceId, lutId: originalLut.id }, orderBy: { version: 'asc' } })
    assert.deepEqual(originalRowsBefore.map((row) => row.version), [1, 2])
    const originalArticle = page.getByTestId('lut-library-list').locator('article').filter({ hasText: originalLut.currentVersion.name })
    assert.equal(await originalArticle.getByRole('button', { name: 'Retirar' }).count(), 0)
    await originalArticle.getByText('Troque o padrão antes de retirar.').waitFor()
    const oldPreviewPath = `/v1/workspaces/${workspaceId}/luts/${originalLut.id}/versions/1/preview`
    const oldPreviewResponse = await readPng(baseUrl, oldPreviewPath, authorization)
    const oldVersion = await client.v2WorkspaceLutVersion.findFirstOrThrow({ where: { workspaceId, lutId: originalLut.id, version: 1 } })
    assert.equal(oldPreviewResponse.sha256, oldVersion.previewSha256)
    const beforeDefault = await client.v2WorkspaceLutDefault.findUniqueOrThrow({ where: { workspaceId } })
    await page.getByRole('button', { name: 'Usar sem LUT' }).click()
    await page.getByText('Workspace configurado explicitamente sem LUT criativa.').waitFor()
    const noneDefault = await client.v2WorkspaceLutDefault.findUniqueOrThrow({ where: { workspaceId } })
    assert.equal(noneDefault.revision, beforeDefault.revision + 1)
    const noneVersion = await client.v2WorkspaceLutDefaultVersion.findUniqueOrThrow({ where: { id: noneDefault.currentVersionId } })
    assert.equal(noneVersion.mode, 'none')
    await originalArticle.getByRole('button', { name: 'Retirar' }).click()
    await page.getByText('LUT removida das novas seleções. Versões antigas continuam reproduzíveis.').waitFor()
    const inactive = await client.v2WorkspaceLut.findFirstOrThrow({ where: { workspaceId, id: originalLut.id } })
    assert.equal(inactive.status, 'inactive')
    await page.locator('#lut-compare-a option').filter({ hasText: originalLut.currentVersion.name }).waitFor({ state: 'detached' })
    assert.equal(await page.locator('#lut-compare-a option').filter({ hasText: originalLut.currentVersion.name }).count(), 0)
    assert.equal(await page.locator('#lut-compare-b option').filter({ hasText: originalLut.currentVersion.name }).count(), 0)
    assert.deepEqual(await client.v2ProjectLutSelection.findUniqueOrThrow({ where: { id: projectSelectionId } }), projectBefore)
    assert.deepEqual(await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: projectBefore.resultVersionId } }), projectVersionBefore)
    assert.deepEqual(await client.v2WorkspaceLutVersion.findMany({ where: { workspaceId, lutId: originalLut.id }, orderBy: { version: 'asc' } }), originalRowsBefore)
    assert.equal((await readPng(baseUrl, oldPreviewPath, authorization)).sha256, oldPreviewResponse.sha256)
    assert.equal((await readPng(baseUrl, originalLut.currentVersion.preview.path, authorization)).sha256, originalPng.sha256)
    await originalArticle.getByRole('button', { name: 'Reativar' }).click()
    await page.getByText('LUT reativada sem alterar a versão.').waitFor()
    const reactivated = await client.v2WorkspaceLut.findFirstOrThrow({ where: { workspaceId, id: originalLut.id } })
    assert.equal(reactivated.status, 'active')
    assert.equal(reactivated.currentVersionId, inactive.currentVersionId)
    assert.deepEqual(await client.v2WorkspaceLutVersion.findMany({ where: { workspaceId, lutId: originalLut.id }, orderBy: { version: 'asc' } }), originalRowsBefore)
    await originalArticle.getByRole('button', { name: 'Definir padrão' }).click()
    await page.getByText(`${originalLut.currentVersion.name} definida como padrão do workspace.`).waitFor()
    const restoredDefault = await client.v2WorkspaceLutDefault.findUniqueOrThrow({ where: { workspaceId } })
    assert.equal(restoredDefault.revision, noneDefault.revision + 1)
    const restoredVersion = await client.v2WorkspaceLutDefaultVersion.findUniqueOrThrow({ where: { id: restoredDefault.currentVersionId } })
    assert.equal(restoredVersion.lutVersionId, originalLut.currentVersion.id)
    assert.deepEqual(await client.v2ProjectLutSelection.findUniqueOrThrow({ where: { id: projectSelectionId } }), projectBefore)
    assert.deepEqual(await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: projectBefore.resultVersionId } }), projectVersionBefore)
    assert.equal(requests.some((item) => item.method === 'DELETE'), false, 'W29 must never delete a LUT')
    const afterLifecycle = await counters(client, workspaceId, projectId)
    assert.deepEqual(afterLifecycle, { ...before, defaults: before.defaults + 2, statuses: before.statuses + 2 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByTestId('lut-comparison-table').waitFor()
    await page.locator('#lut-compare-a').selectOption(originalLut.id)
    await page.locator('#lut-compare-b').selectOption(secondLut.id)
    await waitForImages(page, [originalLut.currentVersion.preview.path, secondLut.currentVersion.preview.path])
    assert.equal(await page.getByTestId('lut-comparison-table').locator('aside p').nth(1).innerText(), originalLut.currentVersion.name)
    await page.getByTestId('lut-library-list').locator('article').filter({ hasText: originalLut.currentVersion.name }).getByText('Troque o padrão antes de retirar.').waitFor()
    const defaultRead = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/lut-default`, { headers: { cookie: `${sessionCookieName}=${sessionCookieValue}` } })
    assert.equal(defaultRead.status, 200)
    const defaultPayload = await defaultRead.json()
    assert.equal(defaultPayload.data.default.revision, restoredDefault.revision)
    assert.equal(defaultPayload.data.default.current.lut.versionId, originalLut.currentVersion.id)
    assert.equal((await client.v2WorkspaceLutDefault.findUniqueOrThrow({ where: { workspaceId } })).revision, restoredDefault.revision)
    evidence.lifecycle = { retiredLutId: originalLut.id, inactiveRevision: inactive.revision, reactivatedRevision: reactivated.revision, noneDefaultRevision: noneDefault.revision, restoredDefaultRevision: restoredDefault.revision, historicalProjectSelectionHash: projectBefore.selectionHash, historicalPreviewV1Sha256: oldPreviewResponse.sha256, historicalPreviewV2Sha256: originalPng.sha256, versionPreserved: true }
    evidence.counters.afterLifecycle = afterLifecycle
    evidence.outcome = 'passed'
    return evidence
  } catch (error) {
    primaryError = error
    evidence.outcome = 'failed'
    evidence.failure = { name: error?.name ?? 'Error' }
    throw error
  } finally {
    const cleanupErrors = []
    await boundedClose('page', page && (() => page.close()), cleanupErrors)
    await boundedClose('context', context && (() => context.close()), cleanupErrors)
    await boundedClose('browser', browser && (() => browser.close()), cleanupErrors)
    // BrowserServer.close() hangs on the Windows harness (5/5 runs); it is recorded, and the
    // owned browser PID must still be dead (taskkill fallback) or the proof fails below.
    const serverCloseErrors = []
    await boundedClose('browser-server', browserServer && (() => browserServer.close()), serverCloseErrors)
    evidence.postflight.browserServerCloseUnclean = serverCloseErrors.length > 0
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      try { browserProcess.kill('SIGKILL') } catch (error) { cleanupErrors.push(`browser-kill:${error?.name ?? 'Error'}`) }
    }
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      await Promise.race([
        new Promise((done) => browserProcess.once('exit', done)),
        new Promise((done) => setTimeout(done, 5000)),
      ])
    }
    const settled = await settleOwnedBrowserProcess(browserProcess, cleanupErrors)
    evidence.postflight.browserPidAliveAtEnd = settled.aliveAtEnd
    evidence.postflight.browserProcessTerminal = settled.terminal
    if (!evidence.postflight.browserProcessTerminal) cleanupErrors.push('browser-process-not-terminal')
    evidence.postflight.cleanupErrors = cleanupErrors
    try { await writeFile(join(evidenceDir, 'w29-manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'w' }) }
    catch (error) { cleanupErrors.push(`manifest:${error?.name ?? 'Error'}`) }
    if (cleanupErrors.length) throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors.map((item) => new Error(item))] : cleanupErrors.map((item) => new Error(item)),
      'W29 browser proof and/or cleanup failed',
    )
  }
}
