import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Headless Chrome on the loaded workstation exits bimodally (0.2-4 s or 20-33 s); same 60 s budget as W29/W30.
const BROWSER_CLOSE_BUDGET_MS = 60_000

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Stable JSON used only to compare two reads of the same persisted rows. */
export function plain(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)))
}

export function evidenceDirectory(wave) {
  const variable = `APOLLO_W${wave}_EVIDENCE_DIR`
  const configured = process.env[variable]
  assert.ok(configured || !process.env.CI, `CI must set ${variable}`)
  const directory = resolve(configured || join(tmpdir(), `apollo-w${wave}-${process.pid}-${randomUUID()}`))
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const fromRepo = relative(root, directory)
  assert.ok(fromRepo && (fromRepo.startsWith('..') || isAbsolute(fromRepo)), `W${wave} evidence must be outside the repository`)
  return directory
}

function chromePath(wave) {
  const executable = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find((path) => path && existsSync(path))
  assert.ok(executable, `W${wave} requires Chromium; no skip is allowed`)
  return executable
}

export async function boundedClose(label, action, errors) {
  if (!action) return
  let timer
  try {
    await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), BROWSER_CLOSE_BUDGET_MS)
    })])
  } catch (error) { errors.push(`${label}:${error?.name ?? 'Error'}`) }
  finally { clearTimeout(timer) }
}

/**
 * One wave proof: owned Chromium, bounded cleanup, sanitized manifest.
 * `execute` receives helpers to open pages; the manifest is written in `finally`
 * so a failed proof still leaves its (outcome: failed) evidence.
 */
export async function runWaveProof({ wave, schemaVersion, initial, baseUrl, sessionCookieName, sessionCookieValue, execute }) {
  const evidenceDir = evidenceDirectory(wave)
  await mkdir(evidenceDir, { recursive: true })
  const evidence = {
    schemaVersion, wave: `w${wave}`, runId: randomUUID(),
    sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null,
    outcome: 'started', ...initial, cases: [], screenshots: [], browser: {}, postflight: {},
  }
  const state = { contexts: [] }
  let primaryError
  async function launch() {
    const { chromium } = await import('playwright-core')
    state.browserServer = await chromium.launchServer({ executablePath: chromePath(wave), headless: true })
    state.browserProcess = state.browserServer.process()
    assert.ok(state.browserProcess?.pid, `W${wave} browser must have an owned PID`)
    evidence.browser.pid = state.browserProcess.pid
    state.browser = await chromium.connect(state.browserServer.wsEndpoint())
    return state.browser
  }
  async function newSessionPage({ viewport = { width: 1440, height: 1000 }, authenticated = true } = {}) {
    assert.ok(state.browser, 'launch the browser first')
    const context = await state.browser.newContext({ viewport })
    context.setDefaultTimeout(25_000)
    context.setDefaultNavigationTimeout(30_000)
    state.contexts.push(context)
    if (authenticated) {
      await context.addCookies([{ name: sessionCookieName, value: sessionCookieValue, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    }
    const page = await context.newPage()
    return { context, page }
  }
  try {
    await execute({ evidence, evidenceDir, launch, newSessionPage })
    evidence.outcome = 'passed'
    return evidence
  } catch (error) {
    primaryError = error
    evidence.outcome = 'failed'
    evidence.failure = { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 600) }
    throw error
  } finally {
    const cleanupErrors = []
    for (const [index, context] of state.contexts.entries()) {
      await boundedClose(`context-${index}`, () => context.close(), cleanupErrors)
    }
    await boundedClose('browser', state.browser && (() => state.browser.close()), cleanupErrors)
    // Terminate the owned PID, wait for it within the budget, then let the server object finish.
    // A browser still alive afterwards, or a server close that fails, remains a cleanup error.
    const browserProcess = state.browserProcess
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      const exited = new Promise((done) => browserProcess.once('exit', done))
      try { browserProcess.kill('SIGKILL') } catch (error) { cleanupErrors.push(`browser-kill:${error?.name ?? 'Error'}`) }
      await Promise.race([exited, new Promise((done) => setTimeout(done, BROWSER_CLOSE_BUDGET_MS))])
    }
    await boundedClose('browser-server', state.browserServer && (() => state.browserServer.close()), cleanupErrors)
    evidence.postflight.browserProcessTerminal = !browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null
    if (!evidence.postflight.browserProcessTerminal) cleanupErrors.push('browser-process-not-terminal')
    evidence.postflight.cleanupErrors = cleanupErrors
    if (cleanupErrors.length) evidence.outcome = 'failed'
    try { await writeFile(join(evidenceDir, `w${wave}-manifest.json`), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'w' }) }
    catch (error) { cleanupErrors.push(`manifest:${error?.name ?? 'Error'}`) }
    if (cleanupErrors.length) throw new AggregateError(primaryError
      ? [primaryError, ...cleanupErrors.map((item) => new Error(item))]
      : cleanupErrors.map((item) => new Error(item)), `W${wave} browser proof and/or cleanup failed`)
  }
}

export async function recordApplicationName(client, evidence) {
  const rows = await client.$queryRawUnsafe("select current_setting('application_name') as application_name")
  assert.equal(rows.length, 1)
  assert.match(rows[0].application_name, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
  evidence.database = { applicationName: rows[0].application_name }
}

export async function screenshot(page, directory, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => window.scrollY === 0)
  await page.screenshot({ path: join(directory, name), fullPage: true })
  const bytes = await readFile(join(directory, name))
  assert.ok(bytes.length > 100, `${name} is empty`)
  return { name, sha256: sha256(bytes), bytes: bytes.length }
}

/** Minimal HTTP client for the public API; never returns or stores credentials. */
export async function apiCall(baseUrl, { method = 'GET', path, authorization, cookie, origin = false, headers = {}, body, rawBody }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin: baseUrl, 'sec-fetch-site': 'same-origin' } : {}),
      ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(rawBody !== undefined ? { body: rawBody } : {}),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* binary or empty body */ }
  return { status: response.status, json, text, headers: response.headers }
}

export async function createProjectViaApi({ baseUrl, authorization, name, key, briefing }) {
  const response = await apiCall(baseUrl, {
    method: 'POST', path: '/v1/projects', authorization,
    headers: { 'idempotency-key': key },
    body: {
      name, objective: 'discovery', format: '9:16', locale: 'pt-BR',
      briefing: briefing ?? 'Público: gestores. Oferta: conteúdo. Tom: direto e natural.',
    },
  })
  assert.equal(response.status, 201, JSON.stringify(response.json))
  return { project: response.json.data.project, version: response.json.data.version }
}

const ADMINISTRATION_EVENT_TYPES = ['project.name.changed', 'project.status.changed']

/** Independent PostgreSQL read of everything a project administration/duplication action may touch. */
export async function projectOracle(client, workspaceId, projectId) {
  const project = await client.v2Project.findUnique({ where: { id: projectId } })
  assert.ok(project, `project ${projectId} must exist in PostgreSQL`)
  assert.equal(project.workspaceId, workspaceId)
  const [versions, snapshots, administrationCommands, editCommandCount, creationCommand, mediaAssets, events] = await Promise.all([
    client.v2ProjectVersion.findMany({ where: { projectId }, orderBy: { sequence: 'asc' } }),
    client.v2ProjectSnapshot.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    client.v2ProjectAdministrationCommand.findMany({ where: { projectId }, orderBy: { resultRevision: 'asc' } }),
    client.v2EditCommand.count({ where: { projectId } }),
    client.v2ProjectCreationCommand.findUnique({ where: { projectId_workspaceId: { projectId, workspaceId } } }),
    client.v2ProjectMediaAsset.findMany({ where: { projectId }, orderBy: [{ role: 'asc' }, { artifactId: 'asc' }] }),
    client.v2PublicEventOutbox.findMany({
      where: { workspaceId, resourceType: 'project', resourceId: projectId, type: { in: ADMINISTRATION_EVENT_TYPES } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    }),
  ])
  return plain({ project, versions, snapshots, administrationCommands, editCommandCount, creationCommand, mediaAssets, events })
}

export function oracleDigest(oracle, keys = ['project', 'versions', 'snapshots', 'mediaAssets']) {
  return sha256(JSON.stringify(keys.map((key) => oracle[key])))
}

export function projectRowSummary(project) {
  return {
    id: project.id, name: project.name, status: project.status,
    archivedFromStatus: project.archivedFromStatus, administrationRevision: project.administrationRevision,
    currentVersionId: project.currentVersionId, duplicatedFromProjectId: project.duplicatedFromProjectId,
  }
}

export function commandSummary(command) {
  return {
    id: command.id, action: command.action,
    baseRevision: command.baseRevision, resultRevision: command.resultRevision,
    beforeName: command.beforeName, afterName: command.afterName,
    beforeStatus: command.beforeStatus, afterStatus: command.afterStatus,
    beforeArchivedFromStatus: command.beforeArchivedFromStatus, afterArchivedFromStatus: command.afterArchivedFromStatus,
    confirmation: command.confirmation, actorClientId: command.actorClientId,
    actorAuthenticationKind: command.actorAuthenticationKind, hasDelegatedUser: Boolean(command.delegatedUserId),
    workspaceRole: command.workspaceRole, idempotencyKeySha256: sha256(command.idempotencyKey),
    commandHash: command.commandHash,
  }
}

/** Records every same-origin request and response of a page; keeps raw keys in memory only. */
export function trackBrowserTraffic(page, baseUrl) {
  const requests = []
  const responses = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== baseUrl) return
    requests.push({
      index: requests.length, method: request.method(), path: url.pathname, search: url.search,
      idempotencyKey: request.headers()['idempotency-key'] ?? null, postData: request.postData() ?? null,
    })
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin !== baseUrl) return
    const method = response.request().method()
    const wantsBody = method !== 'GET' || url.pathname === '/v1/projects'
    responses.push({
      method, path: url.pathname, search: url.search, status: response.status(),
      body: wantsBody ? response.json().catch(() => null) : Promise.resolve(null),
    })
  })
  const mutating = () => requests.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  return { requests, responses, mutating }
}

export function listPathMatches(response, text) {
  const url = new URL(response.url())
  return url.pathname === '/v1/projects' && response.request().method() === 'GET' &&
    (url.searchParams.get('text') ?? '') === text && response.status() === 200
}

export function dashboardUrl(baseUrl, text) {
  return `${baseUrl}/?${new URLSearchParams({ text })}`
}

export async function cardSnapshot(page, projectId) {
  const article = page.locator(`article[data-project-id="${projectId}"]`)
  return article.evaluate((node) => {
    const buttons = {}
    for (const button of node.querySelectorAll('button')) buttons[button.textContent.trim()] = !button.disabled
    const stateNode = node.querySelector('[data-state]')
    const versionDt = [...node.querySelectorAll('dt')].find((item) => item.textContent.trim() === 'Versão')
    return {
      name: node.querySelector('h3')?.textContent?.trim() ?? '',
      state: stateNode?.getAttribute('data-state') ?? null,
      stateText: stateNode?.textContent?.trim() ?? null,
      version: versionDt?.nextElementSibling?.textContent?.trim() ?? null,
      enabledButtons: buttons,
    }
  })
}

export async function cardIds(page) {
  return page.locator('article[data-project-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-project-id')))
}

export async function waitForCardName(page, projectId, name) {
  await page.waitForFunction(({ id, expected }) => {
    const node = document.querySelector(`article[data-project-id="${id}"]`)
    return node?.querySelector('h3')?.textContent?.trim() === expected
  }, { id: projectId, expected: name })
}

export async function waitForCardState(page, projectId, state) {
  await page.waitForFunction(({ id, expected }) => {
    const node = document.querySelector(`article[data-project-id="${id}"]`)
    return node?.querySelector('[data-state]')?.getAttribute('data-state') === expected
  }, { id: projectId, expected: state })
}

export async function waitForCardSet(page, ids) {
  const expected = [...ids].sort()
  await page.waitForFunction((wanted) => {
    const actual = [...document.querySelectorAll('article[data-project-id]')].map((node) => node.getAttribute('data-project-id')).sort()
    return JSON.stringify(actual) === JSON.stringify(wanted)
  }, expected)
}

export async function waitForSettled(page) {
  await page.waitForFunction(() => document.querySelectorAll('.animate-pulse').length === 0 && document.querySelectorAll('article[data-project-id]').length > 0)
}

export async function summaryCounters(page) {
  return page.locator('section[aria-label="Resumo dos projetos"] article').evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => {
    const paragraphs = node.querySelectorAll('p')
    return [paragraphs[1]?.textContent?.trim() ?? '', Number(paragraphs[0]?.textContent?.trim())]
  })))
}

/**
 * Holds one browser request before it leaves the page, then forwards it
 * unchanged to the real Next server and PostgreSQL. While it is held nothing is
 * persisted and no project event exists, so any card change would be optimistic.
 */
export async function holdRequest(page, pattern) {
  let release
  const gate = new Promise((resolveGate) => { release = resolveGate })
  let markHeld
  const held = new Promise((resolveHeld) => { markHeld = resolveHeld })
  const handler = async (route) => {
    markHeld(route.request().method())
    await gate
    await route.continue()
  }
  await page.route(pattern, handler)
  return { held, release, dispose: () => page.unroute(pattern, handler) }
}

export function sanitizedRequest(request) {
  let body = null
  try { body = request.postData === null ? null : JSON.parse(request.postData) } catch { body = '[unparseable]' }
  return {
    method: request.method, path: request.path, body,
    idempotencyKeySha256: request.idempotencyKey ? sha256(request.idempotencyKey) : null,
  }
}

export function pushCase(evidence, item) {
  evidence.cases.push(item)
  return item
}

/** Records the observed error envelope of an API refusal and asserts the route contract. */
export function assertRefusal(result, { status, code, category }) {
  assert.equal(result.status, status, `expected ${status}, got ${result.status}: ${result.text.slice(0, 300)}`)
  assert.equal(result.json?.error?.code, code, result.text.slice(0, 300))
  if (category) assert.equal(result.json.error.category, category)
  assert.equal(typeof result.json.error.requestId, 'string')
  return { status: result.status, code: result.json.error.code, category: result.json.error.category, retryable: result.json.error.retryable }
}
