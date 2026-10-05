import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export async function ownedBrowserProcesses(pid) {
  if (!pid) return []
  if (process.platform !== 'win32') { try { process.kill(pid, 0); return [{ pid }] } catch (error) { if (error.code === 'ESRCH') return []; throw error } }
  const script = `$all = @(Get-CimInstance Win32_Process); $owned = @(${Number(pid)}); do { $next = @($all | Where-Object { $owned -contains $_.ParentProcessId -and $owned -notcontains $_.ProcessId } | ForEach-Object ProcessId); $owned += $next } while ($next.Count); ConvertTo-Json -Compress -InputObject @($all | Where-Object { $owned -contains $_.ProcessId } | ForEach-Object { $entry=$_; $live=Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue; if ($live -and -not $live.HasExited -and ($live.ProcessName + '.exe') -eq $entry.Name -and [Math]::Abs(($live.StartTime.ToUniversalTime() - $entry.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 100) { @{ pid=$entry.ProcessId; created=$live.StartTime.ToUniversalTime().ToString('o') } } })`
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 })
  return JSON.parse(stdout)
}
export async function closeOwnedBrowser({ context, browser, server, child }) {
  const observed = await ownedBrowserProcesses(child?.pid)
  const warnings = []
  for (const [name, target] of [['context', context], ['browser', browser], ['browser-server', server]]) {
    if (!target) continue
    let timer
    try { await Promise.race([name === 'browser-server' ? target.kill() : target.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} cleanup timeout`)), 5000) })]) }
    catch (error) { warnings.push(error.message) } finally { clearTimeout(timer) }
  }
  let remaining = []
  for (const identity of observed) {
    const current = await ownedBrowserProcesses(identity.pid)
    if (!current.some((item) => item.pid === identity.pid && item.created === identity.created)) continue
    if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(identity.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }).catch((error) => warnings.push(error.message))
    else process.kill(identity.pid, 'SIGKILL')
  }
  for (const identity of observed) {
    const current = await ownedBrowserProcesses(identity.pid)
    remaining.push(...current.filter((item) => item.pid === identity.pid && item.created === identity.created))
  }
  return { browserTerminal: remaining.length === 0, observed, remaining, warnings }
}
export async function proveLibraryBrowser({ baseUrl, cookie, prisma, workspaceId, projectId, sourceArtifactId, evidenceDir }) {
  const { chromium } = await import('playwright-core')
  const executablePath = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path))
  assert.ok(executablePath, 'Library proof requires real Chromium')
  const evidence = { schemaVersion: 'library-browser-proof/v1', sourceCommit: process.env.GITHUB_SHA, ciRunId: process.env.GITHUB_RUN_ID ?? null, outcome: 'started', screenshots: [], checks: [], postflight: {} }
  let server, browser, context, child, primaryError
  try {
    server = await chromium.launchServer({ executablePath, headless: true }); child = server.process(); assert.ok(child?.pid)
    browser = await chromium.connect(server.wsEndpoint()); context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(20_000)
    await context.addCookies([{ name: 'apollo_session', value: cookie, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    const ids = () => page.locator('article[data-library-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-library-id')))
    const api = async (query = '') => { const response = await context.request.get(`${baseUrl}/v1/media/library?limit=24${query}`); const payload = await response.json(); assert.equal(response.status(), 200, `Library oracle: ${JSON.stringify(payload.error ?? {})}`); return payload.data }
    const waitIds = async (expected) => {
      await page.waitForFunction((expectedIds) => JSON.stringify([...document.querySelectorAll('article[data-library-id]')].map((card) => card.getAttribute('data-library-id'))) === JSON.stringify(expectedIds), expected)
      assert.deepEqual(await ids(), expected)
    }
    const snap = async (name) => { await page.screenshot({ path: join(evidenceDir, name), fullPage: true }); const bytes = await readFile(join(evidenceDir, name)); evidence.screenshots.push({ name, bytes: bytes.length, sha256: digest(bytes) }) }
    const first = await api(); assert.equal(first.items.length, 24); assert.ok(first.nextCursor)
    await page.goto(`${baseUrl}/library`, { waitUntil: 'domcontentloaded' }); await waitIds(first.items.map((item) => item.id))
    const second = await api(`&after=${encodeURIComponent(first.nextCursor)}`)
    await page.getByRole('button', { name: 'Carregar mais' }).click(); await waitIds([...first.items, ...second.items].map((item) => item.id))
    assert.equal(new Set(await ids()).size, (await ids()).length)
    evidence.checks.push({ strength: 'http-real+browser-real', name: 'mixed-pagination', ids: await ids() }); await snap('library-paginated.png')
    await page.setViewportSize({ width: 390, height: 844 }); await snap('library-mobile.png'); await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByLabel('Tipo', { exact: true }).selectOption('video')
    await page.getByLabel('Pessoa', { exact: true }).fill('ÁGATA'); await page.getByLabel('Tema', { exact: true }).fill('IMERSÃO')
    await page.getByLabel('Direitos', { exact: true }).selectOption('eligible'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    const conjunction = await api('&kind=video&person=%C3%81GATA&topic=IMERS%C3%83O&rightsStatus=eligible')
    assert.ok(conjunction.items.some((item) => item.id === sourceArtifactId)); await waitIds(conjunction.items.map((item) => item.id))
    evidence.checks.push({ strength: 'http-real+browser-real', name: 'filter-conjunction', ids: await ids(), query: { person: 'ÁGATA', topic: 'IMERSÃO', rightsStatus: 'eligible' } })
    await page.getByLabel('Pessoa', { exact: true }).fill(''); await page.getByLabel('Tema', { exact: true }).fill('')
    await page.getByLabel('Tipo', { exact: true }).selectOption('')
    for (const rightsStatus of ['expired', 'restricted', 'review']) {
      await page.getByLabel('Direitos', { exact: true }).selectOption(rightsStatus); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
      const expected = await api(`&rightsStatus=${rightsStatus}`); await waitIds(expected.items.map((item) => item.id))
      assert.ok(expected.items.length)
      assert.equal(await page.getByRole('button', { name: 'Inserir no projeto', exact: true }).count(), 0)
      evidence.checks.push({ strength: 'http-real+browser-real', name: `rights-${rightsStatus}`, ids: await ids(), reasons: expected.items.map((item) => item.rights.reasonCodes) })
    }
    await page.getByLabel('Direitos', { exact: true }).selectOption('')
    await page.getByLabel('Tipo', { exact: true }).selectOption('video'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    const videos = await api('&kind=video'); await waitIds(videos.items.map((item) => item.id))
    const source = videos.items.find((item) => item.id === sourceArtifactId); assert.ok(source)
    await page.getByRole('button', { name: `Ver detalhes de ${source.label}`, exact: true }).click()
    const details = page.getByRole('region', { name: 'Detalhes da mídia' }); await details.waitFor()
    await page.getByAltText('Miniatura da mídia').waitFor(); await page.getByAltText('Forma de onda da mídia').waitFor()
    assert.equal(await page.getByAltText('Miniatura da mídia').evaluate((image) => image.naturalWidth), 320)
    assert.equal(await page.getByAltText('Forma de onda da mídia').evaluate((image) => image.naturalWidth), 640)
    await snap('library-real-previews.png')
    const countBefore = await prisma.v2MediaArtifact.count({ where: { workspaceId } })
    await details.getByLabel('Nome', { exact: true }).fill('Segmento criado no navegador')
    await details.getByLabel('Início (ms)', { exact: true }).fill('500'); await details.getByLabel('Fim (ms)', { exact: true }).fill('1500')
    await details.getByRole('button', { name: 'Criar sem recortar o original' }).click()
    await page.getByText('Segmento virtual criado. O arquivo original permanece intacto.', { exact: true }).waitFor()
    const segment = await prisma.v2MediaSegment.findFirstOrThrow({ where: { workspaceId, label: 'Segmento criado no navegador' } })
    assert.equal(segment.startMs, 500); assert.equal(segment.endMs, 1500); assert.equal(segment.physicalObjectKey, null)
    assert.equal(await prisma.v2MediaArtifact.count({ where: { workspaceId } }), countBefore)
    await page.getByLabel('Tipo', { exact: true }).selectOption('segment'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    const segments = await api('&kind=segment'); await waitIds(segments.items.map((item) => item.id))
    const card = page.locator(`article[data-library-id="${segment.id}"]`)
    // This item may be on page two under a tied timestamp; use the real cursor.
    if (!(await card.count())) { await page.getByRole('button', { name: 'Carregar mais' }).click(); await card.waitFor() }
    await page.getByRole('combobox', { name: /Projeto de destino/ }).selectOption(projectId)
    const beforeVersion = (await prisma.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId
    const attachResponse = page.waitForResponse((response) => response.url().includes('/media-library-attachments') && response.request().method() === 'POST')
    await card.getByRole('button', { name: 'Inserir no projeto', exact: true }).click()
    const attached = await attachResponse
    const attachmentPayload = await attached.json()
    assert.equal(attached.status(), 201, JSON.stringify(attachmentPayload))
    assert.deepEqual(attachmentPayload.data.selection, { kind: 'segment', segmentId: segment.id })
    assert.equal(attachmentPayload.data.segmentHash, segment.segmentHash)
    assert.deepEqual(attachmentPayload.data.semanticRange, { startMs: 500, endMs: 1500 })
    assert.ok(attachmentPayload.data.sourceTimeMapping)
    assert.equal(attachmentPayload.data.bytesDuplicated, false)
    await page.getByText('Mídia inserida no projeto por referência, sem copiar o arquivo.', { exact: true }).waitFor()
    assert.notEqual((await prisma.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId, beforeVersion)
    evidence.checks.push({ strength: 'pg-real+browser-real', name: 'create-and-attach-virtual-segment', segmentId: segment.id }); await snap('library-segment-selected.png')
    // Controlled transport only: delay an older response across a newer filter.
    await page.route('**/v1/media/library?*', async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('kind') === 'image') { const response = await route.fetch(); await new Promise((done) => setTimeout(done, 800)); await route.fulfill({ response }).catch(() => undefined) }
      else await route.continue()
    })
    await page.getByLabel('Tipo', { exact: true }).selectOption('image'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await page.getByLabel('Tipo', { exact: true }).selectOption('video'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await waitIds(videos.items.map((item) => item.id)); await page.waitForTimeout(1000); await waitIds(videos.items.map((item) => item.id))
    await page.unroute('**/v1/media/library?*')
    evidence.checks.push({ strength: 'controlled-transport', name: 'stale-response-refused' })
    let failOnce = true
    await page.route('**/v1/media/library?*', async (route) => { if (failOnce) { failOnce = false; await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Limite controlado do teste' } }) }) } else await route.continue() })
    await page.getByLabel('Tipo', { exact: true }).selectOption('audio'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
    const audio = await api('&kind=audio'); await waitIds(audio.items.map((item) => item.id)); await page.unroute('**/v1/media/library?*')
    evidence.checks.push({ strength: 'controlled-transport', name: '429-and-retry' })
    // This expanded journey sends an artificial burst. Let its real 60-second
    // governance window drain before the independent authorization cases.
    const cooldownStarted = Date.now()
    await new Promise((done) => setTimeout(done, 61_000))
    evidence.governanceCooldownMs = Date.now() - cooldownStarted
    await page.route('**/v1/media/library/*/previews/*', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Preview sem autorização controlada' } }) }))
    await page.getByLabel('Tipo', { exact: true }).selectOption('video'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await waitIds(videos.items.map((item) => item.id))
    await page.getByRole('button', { name: `Ver detalhes de ${source.label}`, exact: true }).click()
    await page.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor()
    assert.deepEqual(await ids(), []); assert.equal(await page.getByRole('region', { name: 'Detalhes da mídia' }).count(), 0)
    assert.equal(await page.getByRole('combobox', { name: /Projeto de destino/ }).locator('option').count(), 1)
    await page.unroute('**/v1/media/library/*/previews/*')
    evidence.checks.push({ strength: 'controlled-transport', name: 'preview-403-clears-all-private-state' })
    // A private read begun before an auth failure must never restore its data.
    await page.route('**/v1/projects?*', async (route) => { const response = await route.fetch(); await new Promise((done) => setTimeout(done, 600)); await route.fulfill({ response }).catch(() => undefined) })
    await page.route('**/v1/media/library?*', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Sessão controlada' } }) }))
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor()
    await page.waitForTimeout(900); assert.deepEqual(await ids(), [])
    assert.equal(await page.getByRole('combobox', { name: /Projeto de destino/ }).locator('option').count(), 1)
    await page.unroute('**/v1/projects?*'); await page.unroute('**/v1/media/library?*')
    evidence.checks.push({ strength: 'controlled-transport', name: 'delayed-projects-cannot-survive-library-401' })
    await page.route('**/v1/projects?*', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Sessão controlada' } }) }))
    await page.route('**/v1/media/library?*', async (route) => { const response = await route.fetch(); await new Promise((done) => setTimeout(done, 600)); await route.fulfill({ response }).catch(() => undefined) })
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor()
    await page.waitForTimeout(900); assert.deepEqual(await ids(), [])
    await page.unroute('**/v1/projects?*'); await page.unroute('**/v1/media/library?*')
    evidence.checks.push({ strength: 'controlled-transport', name: 'delayed-library-cannot-survive-projects-401' })
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitIds((await api()).items.map((item) => item.id))
    // Revocation at the source closes both preview routes, including direct IDs.
    await prisma.v2MediaArtifact.update({ where: { id: sourceArtifactId }, data: { currentRightsSnapshotId: null } })
    for (const path of [`/v1/media/library/${sourceArtifactId}/previews/thumbnail`, `/v1/artifacts/${source.preview.thumbnail.artifactId}/content`]) {
      const denied = await context.request.get(`${baseUrl}${path}`)
      assert.equal(denied.status(), 422); assert.equal((await denied.json()).error.code, 'ASSET_RIGHTS_BLOCKED')
    }
    evidence.checks.push({ strength: 'controlled-pg-revocation+http-real', name: 'preview-and-direct-content-revalidate-source-rights' })
    // Revocation is real PostgreSQL; the response comes from the real server.
    await prisma.v2UiSession.updateMany({ where: { workspaceId }, data: { revokedAt: new Date() } })
    await page.getByLabel('Tipo', { exact: true }).selectOption('video'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await page.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor(); assert.deepEqual(await ids(), [])
    assert.equal((await context.request.get(`${baseUrl}/v1/media/library`)).status(), 401)
    evidence.checks.push({ strength: 'pg-real+http-real+browser-real', name: 'revoked-session-clears-library' })
    evidence.outcome = 'passed'; return evidence
  } catch (error) {
    primaryError = error
    evidence.outcome = 'failed'
    evidence.failure = { name: error.name, message: error.message }
    throw error
  } finally {
    evidence.postflight = await closeOwnedBrowser({ context, browser, server, child })
    await writeFile(join(evidenceDir, 'library-browser.json'), JSON.stringify(evidence, null, 2))
    if (!evidence.postflight.browserTerminal) throw new AggregateError([...(primaryError ? [primaryError] : []), new Error('Owned Chromium is not terminal')], 'Library browser proof or cleanup failed')
  }
}
