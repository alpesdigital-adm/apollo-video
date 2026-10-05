import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { closeOwnedBrowser } from './library-browser-proof.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function bounded(action, milliseconds, label) {
  let timer
  try { return await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

/** Consumes the real worker's existing row; never seeds or catalogs an output. */
export async function proveCatalogOutputBrowser({ baseUrl, authorization, username, password, prisma, workspaceId, output, catalogRecord, evidenceDir }) {
  assert.ok(isAbsolute(evidenceDir))
  await mkdir(evidenceDir, { recursive: true })
  const evidence = { schemaVersion: 'catalog-output-browser-proof/v1', sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null, ownerPid: process.pid, outcome: 'started', artifactId: output.artifactId, manifestId: output.manifestId, sha256: output.sha256, recordHash: catalogRecord.recordHash, checks: [], screenshots: [], postflight: {} }
  let server, child, browser, context, primaryError
  try {
    const query = '/v1/media/library?kind=video&rightsStatus=eligible&limit=24'
    const response = await fetch(`${baseUrl}${query}`, { headers: { authorization }, signal: AbortSignal.timeout(15_000), cache: 'no-store' })
    assert.equal(response.status, 200)
    const payload = await response.json()
    const item = payload.data.items.find((candidate) => candidate.id === output.artifactId)
    assert.ok(item, 'Bearer library query must find the automatically cataloged output')
    assert.equal(item.origin.type, 'generated')
    assert.equal(item.source.artifactId, output.artifactId)
    assert.equal(item.rights.snapshotId, catalogRecord.rightsSnapshotId)
    const [artifact, row, entry] = await Promise.all([
      prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: output.artifactId } }),
      prisma.v2AutomaticCatalogRecord.findUniqueOrThrow({ where: { workspaceId_artifactId_manifestId: { workspaceId, artifactId: output.artifactId, manifestId: output.manifestId } } }),
      prisma.v2MediaLibraryEntry.findUniqueOrThrow({ where: { artifactId: output.artifactId } }),
    ])
    assert.equal(artifact.sha256, output.sha256)
    assert.equal(row.recordHash, catalogRecord.recordHash)
    assert.equal(entry.workspaceId, workspaceId)
    assert.equal(entry.originType, 'generated')
    assert.equal(item.label, entry.label)
    evidence.checks.push({ strength: 'bearer-http-real+pg-real', name: 'approved-output-search', id: item.id, label: item.label, rightsSnapshotId: item.rights.snapshotId })
    const login = await fetch(`${baseUrl}/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15_000) })
    assert.equal(login.status, 200, 'Real human session sign-in must succeed')
    const cookie = /apollo_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]
    assert.ok(cookie)
    const { chromium } = await import('playwright-core')
    const executablePath = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path))
    assert.ok(executablePath, 'Catalog proof requires real Chromium')
    server = await chromium.launchServer({ executablePath, headless: true, timeout: 20_000 })
    child = server.process(); assert.ok(child?.pid); evidence.browserPid = child.pid
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 20_000 })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(30_000)
    await context.addCookies([{ name: 'apollo_session', value: cookie, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    await bounded(async () => {
      const page = await context.newPage()
      await page.goto(`${baseUrl}/library`, { waitUntil: 'domcontentloaded' })
      await page.getByLabel('Tipo', { exact: true }).selectOption('video')
      await page.getByLabel('Direitos', { exact: true }).selectOption('eligible')
      const read = page.waitForResponse((candidate) => candidate.url().includes('/v1/media/library?') && candidate.url().includes('kind=video') && candidate.url().includes('rightsStatus=eligible') && candidate.request().method() === 'GET')
      await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
      const humanResponse = await read; assert.equal(humanResponse.status(), 200)
      const humanPayload = await humanResponse.json()
      assert.ok(humanPayload.data.items.some((candidate) => candidate.id === output.artifactId))
      const card = page.locator(`article[data-library-id="${output.artifactId}"]`)
      await card.waitFor({ state: 'visible' })
      assert.equal(await card.locator('h2').innerText(), entry.label)
      await card.getByRole('button', { name: `Ver detalhes de ${entry.label}`, exact: true }).click()
      const detail = page.getByRole('region', { name: 'Detalhes da mídia', exact: true })
      await detail.waitFor({ state: 'visible' })
      assert.ok((await detail.innerText()).includes(output.artifactId))
      assert.ok((await detail.innerText()).includes('Liberado'))
      const name = 'w49-catalog-output-library.png'
      await page.screenshot({ path: join(evidenceDir, name), fullPage: true })
      const bytes = await readFile(join(evidenceDir, name))
      evidence.screenshots.push({ name, sha256: digest(bytes), byteSize: bytes.length })
      evidence.checks.push({ strength: 'human-session-real+http-real+chromium-real+pg-real', name: 'automatic-output-visible-and-filterable', id: output.artifactId, label: entry.label, rightsSnapshotId: catalogRecord.rightsSnapshotId })
    }, 75_000, 'Catalog Chromium proof')
    evidence.outcome = 'passed'
    return evidence
  } catch (error) {
    primaryError = error; evidence.outcome = 'failed'; evidence.failure = { name: error.name, message: error.message }; throw error
  } finally {
    const errors = []
    try {
      evidence.postflight = await closeOwnedBrowser({ context, browser, server, child })
      if (!evidence.postflight.browserTerminal) errors.push(new Error('Owned Chromium is not terminal'))
    } catch (error) {
      evidence.postflight.browserTerminal = false
      errors.push(error)
    }
    evidence.postflight.errors = errors.map((error) => error.message)
    try { await writeFile(join(evidenceDir, 'w49-catalog-output-browser.json'), JSON.stringify(evidence, null, 2)) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...errors], 'Catalog browser proof or cleanup failed', { cause: primaryError })
  }
}
