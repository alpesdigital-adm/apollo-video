import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function evidenceDirectory() {
  const configured = process.env.APOLLO_W30_EVIDENCE_DIR
  assert.ok(configured || !process.env.CI, 'CI must set APOLLO_W30_EVIDENCE_DIR')
  const directory = resolve(configured || join(tmpdir(), `apollo-w30-${process.pid}-${randomUUID()}`))
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const fromRepo = relative(root, directory)
  assert.ok(fromRepo && (fromRepo.startsWith('..') || isAbsolute(fromRepo)), 'W30 evidence must be outside the repository')
  return directory
}

function chromePath() {
  const executable = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find((path) => path && existsSync(path))
  assert.ok(executable, 'W30 requires Chromium; no skip is allowed')
  return executable
}

async function boundedClose(label, action, errors) {
  if (!action) return
  let timer
  try {
    await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 30000)
    })])
  } catch (error) { errors.push(`${label}:${error?.name ?? 'Error'}`) }
  finally { clearTimeout(timer) }
}

async function databaseCounts(client, workspaceId) {
  const where = { workspaceId }
  return {
    projects: await client.v2Project.count({ where }),
    versions: await client.v2ProjectVersion.count({ where }),
    editCommands: await client.v2EditCommand.count({ where }),
    creationCommands: await client.v2ProjectCreationCommand.count({ where }),
    administrationCommands: await client.v2ProjectAdministrationCommand.count({ where }),
  }
}

async function cards(page) {
  return page.locator('article[data-project-id]').evaluateAll((articles) => articles.map((article) => ({
    id: article.getAttribute('data-project-id'),
    name: article.querySelector('h3')?.textContent?.trim() ?? '',
  })))
}

async function waitForCards(page, expected) {
  await page.waitForFunction((rows) => {
    const actual = [...document.querySelectorAll('article[data-project-id]')].map((article) => ({
      id: article.getAttribute('data-project-id'), name: article.querySelector('h3')?.textContent?.trim() ?? '',
    }))
    return JSON.stringify(actual) === JSON.stringify(rows)
  }, expected)
  assert.deepEqual(await cards(page), expected)
}

async function screenshot(page, directory, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => window.scrollY === 0)
  await page.screenshot({ path: join(directory, name), fullPage: true })
  const bytes = await readFile(join(directory, name))
  assert.ok(bytes.length > 100, `${name} is empty`)
  return { name, sha256: sha256(bytes), bytes: bytes.length }
}

function awaitProjectResponse(page, text, status, expected) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/v1/projects' && url.searchParams.get('text') === (text || null) &&
      url.searchParams.get('status') === (status || null) && response.status() === 200
  }).then(async (response) => {
    const body = await response.json()
    assert.deepEqual(body.data.projects.map((project) => ({ id: project.id, name: project.name })), expected)
    return response
  })
}

export async function proveProjectDashboardBrowser({ baseUrl, client, workspaceId, projectIds, sessionCookieName, sessionCookieValue, username }) {
  const evidenceDir = evidenceDirectory()
  await mkdir(evidenceDir, { recursive: true })
  const evidence = {
    schemaVersion: 'w30-dashboard-browser-proof/v1', runId: randomUUID(),
    sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null,
    outcome: 'started', projectIds, screenshots: [], transitions: [], requests: [],
    browser: {}, postflight: {},
  }
  let browserServer, browser, context, page, browserProcess, primaryError
  try {
    assert.equal(projectIds.length, 2)
    assert.equal(new Set(projectIds).size, 2)
    const activeSession = await fetch(`${baseUrl}/v1/session`, { headers: { cookie: `${sessionCookieName}=${sessionCookieValue}` } })
    assert.equal(activeSession.status, 200, 'original human POST /v1/session cookie must remain active')
    const sessionPayload = await activeSession.json()
    assert.equal(sessionPayload.data.workspaceId, workspaceId)
    assert.equal(sessionPayload.data.subject, username)
    const rows = await client.v2Project.findMany({ where: { workspaceId, id: { in: projectIds } }, select: { id: true, name: true, status: true } })
    const applicationRows = await client.$queryRawUnsafe("select current_setting('application_name') as application_name")
    assert.equal(applicationRows.length, 1)
    assert.match(applicationRows[0].application_name, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
    evidence.database = { applicationName: applicationRows[0].application_name }
    assert.equal(rows.length, 2)
    assert.ok(rows.every((row) => row.status === 'draft'), 'W30 baseline requires two draft projects')
    const renamed = rows.find((row) => row.name === 'Projeto renomeado')
    const delegated = rows.find((row) => row.name === 'UI delegated audit project')
    assert.ok(renamed && delegated, 'W30 expected projects must exist independently in PostgreSQL')
    rows.sort((left, right) => left.id.localeCompare(right.id))
    evidence.expected = rows
    const sessionHeaders = { cookie: `${sessionCookieName}=${sessionCookieValue}` }
    async function apiRows(search) {
      const response = await fetch(`${baseUrl}/v1/projects?limit=24${search ? `&${search}` : ''}`, { headers: sessionHeaders })
      assert.equal(response.status, 200)
      const body = await response.json()
      return body.data.projects.map((project) => ({ id: project.id, name: project.name }))
    }
    const allRows = await apiRows('')
    assert.deepEqual(new Set(allRows.map((row) => row.id)), new Set(projectIds))
    for (const row of allRows) assert.equal(rows.find((item) => item.id === row.id)?.name, row.name)
    const renamedRows = await apiRows(new URLSearchParams({ text: renamed.name, status: 'draft' }))
    const delegatedRows = await apiRows(new URLSearchParams({ text: delegated.name, status: 'draft' }))
    assert.deepEqual(renamedRows, [{ id: renamed.id, name: renamed.name }])
    assert.deepEqual(delegatedRows, [{ id: delegated.id, name: delegated.name }])
    const before = await databaseCounts(client, workspaceId)
    evidence.counts = { before }
    evidence.projectRowsBefore = rows

    const { chromium } = await import('playwright-core')
    browserServer = await chromium.launchServer({ executablePath: chromePath(), headless: true })
    browserProcess = browserServer.process()
    assert.ok(browserProcess?.pid, 'W30 browser must have an owned PID')
    evidence.browser.pid = browserProcess.pid
    browser = await chromium.connect(browserServer.wsEndpoint())
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(25_000)
    context.setDefaultNavigationTimeout(30_000)
    await context.addCookies([{ name: sessionCookieName, value: sessionCookieValue, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 } })
    try {
      const anonymousPage = await anonymous.newPage()
      await anonymousPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      assert.equal(new URL(anonymousPage.url()).pathname, '/login', 'anonymous dashboard must redirect')
      assert.deepEqual(await cards(anonymousPage), [])
    } finally {
      const anonymousCloseErrors = []
      await boundedClose('anonymous-context', () => anonymous.close(), anonymousCloseErrors)
      assert.deepEqual(anonymousCloseErrors, [], 'anonymous browser context must close')
    }
    page = await context.newPage()
    const requests = []
    const responseProofs = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.origin !== baseUrl) return
      requests.push({ method: request.method(), path: url.pathname,
        filters: url.pathname === '/v1/projects' ? Object.fromEntries(['text', 'status'].map((key) => [key, url.searchParams.get(key)])) : undefined })
    })
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (url.origin !== baseUrl || url.pathname !== '/v1/projects') return
      responseProofs.push(response.json().then((body) => ({
        status: response.status(), text: url.searchParams.get('text') ?? '',
        filterStatus: url.searchParams.get('status') ?? '',
        cards: body.data?.projects?.map((project) => ({ id: project.id, name: project.name })) ?? null,
      })).catch(() => ({ status: response.status(), text: url.searchParams.get('text') ?? '', filterStatus: url.searchParams.get('status') ?? '', cards: null })))
    })
    const browserSession = await context.request.get(`${baseUrl}/v1/session`)
    assert.equal(browserSession.status(), 200, 'browser cookie must be active immediately before W30 navigation')
    const browserSessionPayload = await browserSession.json()
    assert.equal(browserSessionPayload.data.workspaceId, workspaceId)
    assert.equal(browserSessionPayload.data.subject, username)
    evidence.browser.sessionReadStatus = browserSession.status()
    evidence.browser.sessionVerifiedBeforeDashboard = true
    const expectedBoth = allRows
    const initialListResponse = awaitProjectResponse(page, '', '', allRows)
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
    await initialListResponse
    await waitForCards(page, expectedBoth)
    const readOnlyStart = requests.length
    const desktopText = page.getByRole('textbox', { name: 'Buscar projetos' })
    const status = page.getByRole('combobox', { name: 'Filtrar por status' })
    const firstFilteredResponse = awaitProjectResponse(page, renamed.name, 'draft', renamedRows)
    await desktopText.fill(renamed.name)
    await status.selectOption('draft')
    await firstFilteredResponse
    await waitForCards(page, renamedRows)
    await page.waitForFunction((name) => {
      const query = new URLSearchParams(location.search)
      return query.get('text') === name && query.get('status') === 'draft'
    }, renamed.name)
    const statusExcludesResponse = awaitProjectResponse(page, renamed.name, 'completed', [])
    await status.selectOption('completed')
    await statusExcludesResponse
    await page.getByText('Nenhum projeto corresponde a esses filtros.').waitFor()
    assert.deepEqual(await cards(page), [])
    assert.equal(new URL(page.url()).searchParams.get('status'), 'completed')
    evidence.transitions.push({ step: 'status-excludes', cards: [], search: new URL(page.url()).search })
    const statusRestoredResponse = awaitProjectResponse(page, renamed.name, 'draft', renamedRows)
    await status.selectOption('draft')
    await statusRestoredResponse
    await waitForCards(page, renamedRows)
    evidence.transitions.push({ step: 'ui-text-status', cards: await cards(page), search: new URL(page.url()).search })
    evidence.screenshots.push(await screenshot(page, evidenceDir, 'w30-desktop-filtered.png'))

    const reloadResponse = awaitProjectResponse(page, renamed.name, 'draft', renamedRows)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await reloadResponse
    await waitForCards(page, renamedRows)
    assert.equal(await desktopText.inputValue(), renamed.name)
    assert.equal(await status.inputValue(), 'draft')
    evidence.transitions.push({ step: 'reload', cards: await cards(page), search: new URL(page.url()).search })

    // No URL filter key: the real UI-created session value restores the same filters.
    const sessionFallbackResponse = awaitProjectResponse(page, renamed.name, 'draft', renamedRows)
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
    await sessionFallbackResponse
    await waitForCards(page, renamedRows)
    assert.equal(await desktopText.inputValue(), renamed.name)
    assert.equal(await status.inputValue(), 'draft')
    assert.equal(new URL(page.url()).searchParams.get('status'), 'draft')
    evidence.transitions.push({ step: 'session-fallback', cards: await cards(page), search: new URL(page.url()).search })

    // Explicit URL wins over the divergent value created by the controls above.
    const delegatedSearch = new URLSearchParams({ text: delegated.name, status: 'draft' }).toString()
    const precedenceResponse = awaitProjectResponse(page, delegated.name, 'draft', delegatedRows)
    await page.goto(`${baseUrl}/?${delegatedSearch}`, { waitUntil: 'domcontentloaded' })
    await precedenceResponse
    await waitForCards(page, delegatedRows)
    assert.equal(await desktopText.inputValue(), delegated.name)
    assert.equal(await status.inputValue(), 'draft')
    evidence.transitions.push({ step: 'url-precedence', cards: await cards(page), search: new URL(page.url()).search })

    // A second bare navigation proves that the explicit URL replaced the
    // previously UI-created session value rather than only rendering once.
    const updatedFallbackResponse = awaitProjectResponse(page, delegated.name, 'draft', delegatedRows)
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
    await updatedFallbackResponse
    await waitForCards(page, delegatedRows)
    assert.equal(await desktopText.inputValue(), delegated.name)
    assert.equal(await status.inputValue(), 'draft')
    assert.equal(new URL(page.url()).searchParams.get('status'), 'draft')
    evidence.transitions.push({ step: 'updated-session-fallback', cards: await cards(page), search: new URL(page.url()).search })
    const historySetupResponse = awaitProjectResponse(page, delegated.name, 'draft', delegatedRows)
    await page.goto(`${baseUrl}/?${delegatedSearch}`, { waitUntil: 'domcontentloaded' })
    await historySetupResponse
    await waitForCards(page, delegatedRows)

    // pushState creates a real same-document history entry; browser Back/Forward
    // dispatch native popstate. Neither storage nor PopStateEvent is fabricated.
    await page.evaluate((search) => {
      window.__w30DocumentIdentity = crypto.randomUUID()
      window.__w30PopCount = 0
      window.addEventListener('popstate', () => { window.__w30PopCount += 1 })
      history.pushState({ w30: true }, '', `/?${search}`)
    }, new URLSearchParams({ text: renamed.name, status: 'draft' }).toString())
    const historyRenamedResponse = awaitProjectResponse(page, renamed.name, 'draft', renamedRows)
    await desktopText.fill(renamed.name)
    await historyRenamedResponse
    await waitForCards(page, renamedRows)
    const backResponse = awaitProjectResponse(page, delegated.name, 'draft', delegatedRows)
    await page.goBack({ waitUntil: 'domcontentloaded' })
    await backResponse
    await waitForCards(page, delegatedRows)
    const documentIdentity = await page.evaluate(() => window.__w30DocumentIdentity)
    assert.ok(documentIdentity, 'Back must preserve the same document')
    assert.equal(await page.evaluate(() => window.__w30PopCount), 1)
    const forwardResponse = awaitProjectResponse(page, renamed.name, 'draft', renamedRows)
    await page.goForward({ waitUntil: 'domcontentloaded' })
    await forwardResponse
    await waitForCards(page, renamedRows)
    assert.equal(await page.evaluate(() => window.__w30DocumentIdentity), documentIdentity)
    assert.equal(await page.evaluate(() => window.__w30PopCount), 2)
    evidence.transitions.push({ step: 'native-popstate-back-forward', sameDocument: true, popCount: 2, cards: await cards(page), search: new URL(page.url()).search })

    const zeroText = 'W30 nenhuma correspondência 9a2f'
    const zeroResponse = awaitProjectResponse(page, zeroText, 'draft', [])
    await desktopText.fill(zeroText)
    await zeroResponse
    await page.getByText('Nenhum projeto corresponde a esses filtros.').waitFor()
    assert.deepEqual(await cards(page), [])
    evidence.transitions.push({ step: 'zero-results', cards: [], search: new URL(page.url()).search })
    const clearedResponse = awaitProjectResponse(page, '', '', allRows)
    await page.getByRole('button', { name: 'Limpar filtros' }).click()
    await clearedResponse
    await waitForCards(page, expectedBoth)
    assert.equal(await desktopText.inputValue(), '')
    assert.equal(await status.inputValue(), '')
    assert.equal(new URL(page.url()).search, '')
    evidence.transitions.push({ step: 'clear', cards: await cards(page), search: new URL(page.url()).search })

    await page.setViewportSize({ width: 390, height: 844 })
    const mobileText = page.getByRole('textbox', { name: 'Buscar projetos', exact: false })
    const mobileResponse = awaitProjectResponse(page, delegated.name, '', delegatedRows)
    await mobileText.fill(delegated.name)
    await mobileResponse
    await waitForCards(page, delegatedRows)
    evidence.transitions.push({ step: 'mobile-text', cards: await cards(page), search: new URL(page.url()).search })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    evidence.browser.mobileOverflowPx = overflow
    evidence.screenshots.push(await screenshot(page, evidenceDir, 'w30-mobile-filtered.png'))
    assert.ok(overflow <= 1, `W30 mobile overflows by ${overflow}px`)

    evidence.requests = requests.slice(readOnlyStart).filter((request) => request.path === '/v1/projects')
    assert.ok(evidence.requests.length >= 5, 'browser must make real project GETs for the transitions')
    assert.equal(requests.slice(readOnlyStart).filter((request) => !['GET', 'HEAD'].includes(request.method)).length, 0, 'filters must not mutate HTTP state')
    evidence.counts.after = await databaseCounts(client, workspaceId)
    assert.deepEqual(evidence.counts.after, before, 'filters must not mutate PostgreSQL state')
    evidence.projectRowsAfter = await client.v2Project.findMany({ where: { workspaceId, id: { in: projectIds } }, select: { id: true, name: true, status: true } })
    evidence.projectRowsAfter.sort((left, right) => left.id.localeCompare(right.id))
    assert.deepEqual(evidence.projectRowsAfter, rows)
    const responses = await Promise.all(responseProofs)
    evidence.responses = responses.filter((item) => item.status === 200 && item.cards !== null)
    const requiredResponses = [
      { text: renamed.name, filterStatus: 'draft', cards: renamedRows },
      { text: renamed.name, filterStatus: 'completed', cards: [] },
      { text: delegated.name, filterStatus: 'draft', cards: delegatedRows },
      { text: '', filterStatus: '', cards: allRows },
    ]
    for (const expected of requiredResponses) {
      assert.ok(evidence.responses.some((actual) => actual.text === expected.text && actual.filterStatus === expected.filterStatus && JSON.stringify(actual.cards) === JSON.stringify(expected.cards)), `missing real HTTP response for ${expected.filterStatus}/${expected.text}`)
    }
    assert.ok(evidence.responses.every((item) => item.cards.every((row) => rows.some((expected) => expected.id === row.id && expected.name === row.name))), 'HTTP project IDs/names differ from PostgreSQL')
    evidence.browser.mutatingRequests = 0
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
    await boundedClose('browser-server', browserServer && (() => browserServer.close()), cleanupErrors)
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      try { browserProcess.kill('SIGKILL') } catch (error) { cleanupErrors.push(`browser-kill:${error?.name ?? 'Error'}`) }
    }
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      await Promise.race([new Promise((done) => browserProcess.once('exit', done)), new Promise((done) => setTimeout(done, 5000))])
    }
    evidence.postflight.browserProcessTerminal = !browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null
    if (!evidence.postflight.browserProcessTerminal) cleanupErrors.push('browser-process-not-terminal')
    evidence.postflight.cleanupErrors = cleanupErrors
    if (cleanupErrors.length) evidence.outcome = 'failed'
    try { await writeFile(join(evidenceDir, 'w30-manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'w' }) }
    catch (error) { cleanupErrors.push(`manifest:${error?.name ?? 'Error'}`) }
    if (cleanupErrors.length) throw new AggregateError(primaryError
      ? [primaryError, ...cleanupErrors.map((item) => new Error(item))]
      : cleanupErrors.map((item) => new Error(item)), 'W30 browser proof and/or cleanup failed')
  }
}
