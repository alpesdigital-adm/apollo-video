// Shared plumbing for the W31 (combined filters), W32 (pagination) and W33
// (workspace isolation) dashboard list proofs. Everything here is read-only
// with respect to product state: it drives a real Chromium through a real
// `next start` against the supervised PostgreSQL and reads expectations from
// the database, never from the component under test.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export const FACET_KEYS = Object.freeze([
  'text', 'status', 'objective', 'format', 'locale', 'createdFrom', 'createdTo', 'ownerId',
])
export const EMPTY_FACETS = Object.freeze(Object.fromEntries(FACET_KEYS.map((key) => [key, ''])))
export const PAGE_LIMIT = 24

export function evidenceDirectory(envName, wave) {
  const configured = process.env[envName]
  assert.ok(configured || !process.env.CI, `CI must set ${envName}`)
  const directory = resolve(configured || join(tmpdir(), `apollo-${wave}-${process.pid}-${randomUUID()}`))
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const fromRepo = relative(root, directory)
  assert.ok(fromRepo && (fromRepo.startsWith('..') || isAbsolute(fromRepo)), `${wave} evidence must be outside the repository`)
  return directory
}

export function chromePath(wave) {
  const executable = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find((path) => path && existsSync(path))
  assert.ok(executable, `${wave} requires Chromium; no skip is allowed`)
  return executable
}

// Playwright's BrowserServer.close() on Windows can resolve late (it also waits
// for Chromium helper processes to release their stdio pipes); the owned browser
// PID must still be terminal afterwards, which is asserted separately.
const CLOSE_TIMEOUT_MS = 20_000

export async function boundedClose(label, action, errors, timeoutMs = CLOSE_TIMEOUT_MS, steps = []) {
  if (!action) return
  let timer
  const started = Date.now()
  try {
    await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    })])
    steps.push({ label, outcome: 'ok', ms: Date.now() - started })
  } catch (error) {
    errors.push(`${label}:${error?.name ?? 'Error'}`)
    steps.push({ label, outcome: String(error?.message ?? error).slice(0, 160), ms: Date.now() - started })
  } finally { clearTimeout(timer) }
}

export async function databaseCounts(client, workspaceId) {
  const where = { workspaceId }
  return {
    projects: await client.v2Project.count({ where }),
    versions: await client.v2ProjectVersion.count({ where }),
    editCommands: await client.v2EditCommand.count({ where }),
    creationCommands: await client.v2ProjectCreationCommand.count({ where }),
    administrationCommands: await client.v2ProjectAdministrationCommand.count({ where }),
  }
}

export async function readApplicationName(client) {
  const rows = await client.$queryRawUnsafe("select current_setting('application_name') as application_name")
  assert.equal(rows.length, 1)
  assert.match(rows[0].application_name, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
  return rows[0].application_name
}

// ---------------------------------------------------------------- oracle ----

const PROJECT_SELECT = {
  id: true, name: true, status: true, objective: true, format: true, locale: true,
  ownerId: true, createdAt: true, workspaceId: true,
}

export const compareCreatedAtThenId = (left, right) =>
  right.createdAt.getTime() - left.createdAt.getTime() ||
  (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)

export function facetsApiParams(facets, { limit = PAGE_LIMIT, after } = {}) {
  // Independent statement of the effective request the dashboard must send:
  // the UI date inputs are whole UTC days, widened to the inclusive bounds.
  const params = {}
  params.limit = String(limit)
  for (const key of FACET_KEYS) {
    const value = facets[key]
    if (!value) continue
    params[key] = key === 'createdFrom' ? `${value}T00:00:00.000Z`
      : key === 'createdTo' ? `${value}T23:59:59.999Z` : value
  }
  if (after) params.after = after
  return params
}

export function facetsUrlSearch(facets) {
  const params = new URLSearchParams()
  for (const key of FACET_KEYS) if (facets[key]) params.set(key, facets[key])
  const value = params.toString()
  return value ? `?${value}` : ''
}

function matchesFacets(row, facets) {
  if (facets.text && !row.name.toLowerCase().includes(facets.text.toLowerCase())) return false
  for (const key of ['status', 'objective', 'format', 'locale', 'ownerId']) {
    if (facets[key] && row[key] !== facets[key]) return false
  }
  if (facets.createdFrom && row.createdAt.getTime() < Date.parse(`${facets.createdFrom}T00:00:00.000Z`)) return false
  if (facets.createdTo && row.createdAt.getTime() > Date.parse(`${facets.createdTo}T23:59:59.999Z`)) return false
  return true
}

/**
 * Two independent oracles that must agree: a JavaScript evaluation of the
 * facet semantics over every persisted row of the workspace (ordered by
 * createdAt desc, id desc) and a PostgreSQL ORDER BY read. Both are derived
 * from persisted rows; neither calls the product list service or codec.
 */
export async function oracleProjects(client, workspaceId, facets = EMPTY_FACETS) {
  const rows = await client.v2Project.findMany({ where: { workspaceId }, select: PROJECT_SELECT })
  const expected = rows.filter((row) => matchesFacets(row, facets)).sort(compareCreatedAtThenId)
  const pgRows = await client.v2Project.findMany({
    where: {
      workspaceId,
      ...(facets.text ? { name: { contains: facets.text, mode: 'insensitive' } } : {}),
      ...(facets.status ? { status: facets.status } : {}),
      ...(facets.objective ? { objective: facets.objective } : {}),
      ...(facets.format ? { format: facets.format } : {}),
      ...(facets.locale ? { locale: facets.locale } : {}),
      ...(facets.ownerId ? { ownerId: facets.ownerId } : {}),
      ...(facets.createdFrom || facets.createdTo ? { createdAt: {
        ...(facets.createdFrom ? { gte: new Date(`${facets.createdFrom}T00:00:00.000Z`) } : {}),
        ...(facets.createdTo ? { lte: new Date(`${facets.createdTo}T23:59:59.999Z`) } : {}),
      } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  })
  assert.deepEqual(pgRows.map((row) => row.id), expected.map((row) => row.id),
    'JavaScript facet oracle and PostgreSQL ORDER BY disagree')
  return expected
}

export const cardsOf = (rows) => rows.map((row) => ({ id: row.id, name: row.name }))

// -------------------------------------------------------- page utilities ----

export async function cards(page) {
  return page.locator('article[data-project-id]').evaluateAll((articles) => articles.map((article) => ({
    id: article.getAttribute('data-project-id'),
    name: article.querySelector('h3')?.textContent?.trim() ?? '',
  })))
}

export async function waitForCards(page, expected) {
  await page.waitForFunction((rows) => {
    const actual = [...document.querySelectorAll('article[data-project-id]')].map((article) => ({
      id: article.getAttribute('data-project-id'), name: article.querySelector('h3')?.textContent?.trim() ?? '',
    }))
    return JSON.stringify(actual) === JSON.stringify(rows)
  }, expected)
  assert.deepEqual(await cards(page), expected)
}

export async function screenshot(page, directory, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => window.scrollY === 0)
  await page.screenshot({ path: join(directory, name), fullPage: true })
  const bytes = await readFile(join(directory, name))
  assert.ok(bytes.length > 100, `${name} is empty`)
  return { name, sha256: sha256(bytes), bytes: bytes.length }
}

const labelled = (page, pattern, tag) =>
  page.locator('label').filter({ hasText: pattern }).locator(tag)

/** The eight real controls of the dashboard filter bar. */
export function dashboardControls(page) {
  return {
    text: page.getByRole('textbox', { name: 'Buscar projetos' }),
    status: page.getByRole('combobox', { name: 'Filtrar por status' }),
    objective: labelled(page, /^\s*Objetivo/, 'select'),
    format: labelled(page, /^\s*Formato/, 'select'),
    locale: labelled(page, /^\s*Idioma/, 'input'),
    createdFrom: labelled(page, /^\s*Criado a partir de/, 'input'),
    createdTo: labelled(page, /^\s*Criado até/, 'input'),
    ownerId: labelled(page, /^\s*Responsável/, 'input'),
    clear: page.getByRole('button', { name: 'Limpar filtros' }),
  }
}

export async function readControlValues(page) {
  const controls = dashboardControls(page)
  const values = {}
  for (const key of FACET_KEYS) values[key] = await controls[key].inputValue()
  return values
}

export async function setControl(page, key, value) {
  const control = dashboardControls(page)[key]
  if (key === 'status' || key === 'objective' || key === 'format') {
    await control.selectOption(value)
  } else {
    await control.fill(value)
  }
}

export const canonicalQuery = (searchParams) =>
  [...searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`).join('&')

export const canonicalParams = (params) => canonicalQuery(new URLSearchParams(params))

/** Cursors are opaque and carry no secret, but the evidence keeps only a hash. */
export function sanitizeQuery(searchParams) {
  const query = {}
  for (const [key, value] of searchParams.entries()) {
    query[key] = key === 'after' ? `sha256:${sha256(value).slice(0, 16)}` : value
  }
  return query
}

/**
 * Waits for the next `/v1/projects` response whose effective request equals
 * `params` exactly (no extra, no missing key) and asserts its IDs.
 */
export function awaitProjectsResponse(page, params, expectedIds, { status = 200 } = {}) {
  const wanted = canonicalParams(params)
  return page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/v1/projects' && canonicalQuery(url.searchParams) === wanted &&
      response.status() === status
  }).then(async (response) => {
    const body = await response.json()
    if (expectedIds) assert.deepEqual(body.data.projects.map((project) => project.id), expectedIds)
    return { response, body }
  })
}

/** Records every same-origin request and every `/v1/projects` answer. */
export function recordTraffic(page, baseUrl) {
  const requests = []
  const responseProofs = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== baseUrl) return
    requests.push({
      method: request.method(), path: url.pathname,
      ...(url.pathname === '/v1/projects' ? { query: sanitizeQuery(url.searchParams) } : {}),
    })
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin !== baseUrl || url.pathname !== '/v1/projects') return
    responseProofs.push(response.json().then((body) => ({
      status: response.status(), query: sanitizeQuery(url.searchParams),
      ids: body.data?.projects?.map((project) => project.id) ?? null,
      hasNextCursor: typeof body.data?.nextCursor === 'string',
      errorCode: body.error?.code,
    })).catch(() => ({ status: response.status(), query: sanitizeQuery(url.searchParams), ids: null, hasNextCursor: false })))
  })
  return {
    requests,
    mark: () => requests.length,
    since: (mark) => requests.slice(mark),
    mutating: (mark = 0) => requests.slice(mark).filter((request) => !['GET', 'HEAD'].includes(request.method)),
    projectGets: (mark = 0) => requests.slice(mark).filter((request) => request.path === '/v1/projects'),
    responses: () => Promise.all(responseProofs),
  }
}

// ----------------------------------------------------------- the browser ----

/**
 * Runs `body` with a real Chromium (owned PID, bounded cleanup) and writes the
 * sanitized manifest even when the body throws. `body` receives
 * `{ evidence, evidenceDir, browser, openContext }`; contexts opened through
 * `openContext` are closed during cleanup.
 */
export async function runBrowserProof({ wave, schemaVersion, envVar, manifestName, runLabel, evidence: seed, body }) {
  const evidenceDir = evidenceDirectory(envVar, wave)
  await mkdir(evidenceDir, { recursive: true })
  const evidence = {
    schemaVersion, runId: randomUUID(),
    sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null,
    outcome: 'started', screenshots: [], browser: {}, postflight: {}, ...seed,
  }
  let browserServer, browser, browserProcess, primaryError
  const contexts = []
  try {
    const { chromium } = await import('playwright-core')
    browserServer = await chromium.launchServer({ executablePath: chromePath(runLabel), headless: true })
    browserProcess = browserServer.process()
    assert.ok(browserProcess?.pid, `${runLabel} browser must have an owned PID`)
    evidence.browser.pid = browserProcess.pid
    browser = await chromium.connect(browserServer.wsEndpoint())
    const openContext = async (options) => {
      const context = await browser.newContext(options)
      context.setDefaultTimeout(25_000)
      context.setDefaultNavigationTimeout(30_000)
      contexts.push(context)
      return context
    }
    await body({ evidence, evidenceDir, browser, openContext })
    evidence.outcome = 'passed'
    return evidence
  } catch (error) {
    primaryError = error
    evidence.outcome = 'failed'
    evidence.failure = { name: error?.name ?? 'Error' }
    throw error
  } finally {
    const cleanupErrors = []
    const closeSteps = []
    for (const [index, context] of contexts.entries()) {
      await boundedClose(`context-${index}`, () => context.close(), cleanupErrors, CLOSE_TIMEOUT_MS, closeSteps)
    }
    await boundedClose('browser', browser && (() => browser.close()), cleanupErrors, CLOSE_TIMEOUT_MS, closeSteps)
    await boundedClose('browser-server', browserServer && (() => browserServer.close()), cleanupErrors, CLOSE_TIMEOUT_MS, closeSteps)
    evidence.postflight.closeSteps = closeSteps
    evidence.postflight.processAfterClose = browserProcess
      ? { exitCode: browserProcess.exitCode, signalCode: browserProcess.signalCode, killed: browserProcess.killed } : null
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      try { browserProcess.kill('SIGKILL') } catch (error) { cleanupErrors.push(`browser-kill:${error?.name ?? 'Error'}`) }
    }
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      await Promise.race([new Promise((done) => browserProcess.once('exit', done)), new Promise((done) => setTimeout(done, 15_000))])
    }
    const exited = () => !browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null
    const pidAlive = () => {
      try { process.kill(browserProcess.pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
    }
    if (!exited() && pidAlive() && process.platform === 'win32') {
      // The 'exit' event of the Playwright wrapper is not always delivered on Windows;
      // kill the owned tree by PID and judge by the real liveness of the PID.
      try { spawnSync('taskkill', ['/pid', String(browserProcess.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 }) }
      catch (error) { cleanupErrors.push(`browser-taskkill:${error?.name ?? 'Error'}`) }
      for (let attempt = 0; attempt < 50 && pidAlive(); attempt += 1) await new Promise((done) => setTimeout(done, 100))
    }
    evidence.postflight.browserPidAliveAtEnd = Boolean(browserProcess) && pidAlive()
    evidence.postflight.browserProcessTerminal = !browserProcess || exited() || !pidAlive()
    if (!evidence.postflight.browserProcessTerminal) cleanupErrors.push('browser-process-not-terminal')
    evidence.postflight.cleanupErrors = cleanupErrors
    if (cleanupErrors.length) evidence.outcome = 'failed'
    try { await writeFile(join(evidenceDir, manifestName), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'w' }) }
    catch (error) { cleanupErrors.push(`manifest:${error?.name ?? 'Error'}`) }
    if (cleanupErrors.length) throw new AggregateError(primaryError
      ? [primaryError, ...cleanupErrors.map((item) => new Error(item))]
      : cleanupErrors.map((item) => new Error(item)), `${runLabel} browser proof and/or cleanup failed`)
  }
}

/** Real human session check, as the W30 proof does before any navigation. */
export async function assertSessionActive({ baseUrl, workspaceId, sessionCookieName, sessionCookieValue, username }) {
  const response = await fetch(`${baseUrl}/v1/session`, { headers: { cookie: `${sessionCookieName}=${sessionCookieValue}` } })
  assert.equal(response.status, 200, 'the human session cookie must be active')
  const payload = await response.json()
  assert.equal(payload.data.workspaceId, workspaceId)
  if (username) assert.equal(payload.data.subject, username)
  return payload.data
}

/** GET /v1/projects as the human session (the same transport the dashboard uses). */
export async function sessionProjects({ baseUrl, sessionCookieName, sessionCookieValue }, params) {
  const response = await fetch(`${baseUrl}/v1/projects?${new URLSearchParams(params)}`, {
    headers: { cookie: `${sessionCookieName}=${sessionCookieValue}` },
  })
  return { status: response.status, body: await response.json(), headers: response.headers }
}

export async function snapshotRows(client, workspaceId, where = {}) {
  const rows = await client.v2Project.findMany({
    where: { workspaceId, ...where }, orderBy: [{ id: 'asc' }],
    select: { id: true, name: true, status: true, objective: true, format: true, locale: true, ownerId: true, createdAt: true, updatedAt: true },
  })
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }))
}
