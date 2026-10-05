import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROJECT_EVENT_FEED_POLICY } from '../../../src/v2/ui/project-event-feed-controller.ts'

// W36: the dashboard follows persisted project administration events written by
// OTHER clients. Chromium A keeps `/` open with the real human session; API
// clients B (same workspace) and C (another workspace) mutate over HTTP.
// Nothing here dispatches a DOM event, reloads the page or fakes a provider:
// the only controlled interference is labelled (delayed response, injected 5xx).

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const iso = (ms) => new Date(ms).toISOString()
const FEED_PATH = '/v1/events/feed'
const NAME_PREFIX = 'w36-evento'
const DELAYED_RESPONSE_MS = 12_000

function evidenceDirectory() {
  const configured = process.env.APOLLO_W36_EVIDENCE_DIR
  assert.ok(configured || !process.env.CI, 'CI must set APOLLO_W36_EVIDENCE_DIR')
  const directory = resolve(configured || join(tmpdir(), `apollo-w36-${process.pid}-${randomUUID()}`))
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const fromRepo = relative(root, directory)
  assert.ok(fromRepo && (fromRepo.startsWith('..') || isAbsolute(fromRepo)), 'W36 evidence must be outside the repository')
  return directory
}

function chromePath() {
  const executable = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find((path) => path && existsSync(path))
  assert.ok(executable, 'W36 requires Chromium; no skip is allowed')
  return executable
}

// Chromium's process exit is measured bimodal, 0.2-4 s or 20-33 s, on this class of
// machine, so the browser-server/process budget is 60 s here; it still FAILS
// the proof when the process is not terminal after it.
async function boundedClose(label, action, errors, budgetMs = 5000) {
  if (!action) return
  let timer
  try {
    await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), budgetMs)
    })])
  } catch (error) { errors.push(`${label}:${error?.name ?? 'Error'}`) }
  finally { clearTimeout(timer) }
}

let progressFile
function progress(label) {
  if (progressFile) appendFileSync(progressFile, `${new Date().toISOString()} ${label}
`)
}

function withTimeout(label, promise, timeoutMs) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`W36 timed out waiting for ${label}`)), timeoutMs)
  })]).finally(() => clearTimeout(timer))
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  progress(`wait ${label}`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) assert.fail(`W36 timed out waiting for ${label}`)
    await sleep(40)
  }
}

/** Records every same-origin request/response of one page, without secrets. */
function recordPage(page, baseUrl) {
  const sink = { requests: [], feed: [], projects: [], failed: [], navigations: 0, marked: false }
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && sink.marked) sink.navigations += 1
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== baseUrl) return
    sink.requests.push({
      at: Date.now(), method: request.method(), path: url.pathname,
      query: Object.fromEntries([...url.searchParams.keys()].map((key) => [key, key === 'after' ? 'cursor' : url.searchParams.get(key)])),
      bearer: Boolean(request.headers().authorization),
    })
  })
  page.on('requestfailed', (request) => {
    const url = new URL(request.url())
    if (url.origin !== baseUrl) return
    sink.failed.push({ at: Date.now(), path: url.pathname, error: request.failure()?.errorText ?? '' })
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin !== baseUrl) return
    const at = Date.now()
    if (url.pathname === FEED_PATH) {
      const after = url.searchParams.get('after')
      void response.text().then((text) => {
        let body
        try { body = JSON.parse(text) } catch { body = null }
        sink.feed.push({
          at, status: response.status(), startAt: url.searchParams.get('startAt'),
          hadCursor: Boolean(after), text,
          events: (body?.data?.events ?? []).map((event) => ({
            id: event.id, type: event.type, sequence: event.sequence,
            workspaceId: event.workspaceId, resourceId: event.resource?.id,
          })),
          hasMore: body?.data?.hasMore ?? null, watermark: body?.data?.watermark ?? null,
          cursorHash: body?.data?.nextCursor ? sha256(body.data.nextCursor).slice(0, 16) : null,
        })
      }).catch(() => undefined)
    } else if (url.pathname === '/v1/projects') {
      void response.text().then((text) => {
        let body
        try { body = JSON.parse(text) } catch { body = null }
        sink.projects.push({
          at, status: response.status(), text,
          rows: (body?.data?.projects ?? []).map((project) => ({
            id: project.id, name: project.name, status: project.status,
            state: project.visibleState?.label,
            revision: project.dashboard?.administrationRevision,
          })),
        })
      }).catch(() => undefined)
    }
  })
  return sink
}

async function cards(page) {
  return page.locator('article[data-project-id]').evaluateAll((articles) => articles.map((article) => ({
    id: article.getAttribute('data-project-id'),
    name: article.querySelector('h3')?.textContent?.trim() ?? '',
    state: article.querySelector('[data-state]')?.getAttribute('data-state') ?? '',
  })))
}

async function screenshot(page, directory, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => window.scrollY === 0)
  await page.screenshot({ path: join(directory, name), fullPage: true })
  const bytes = await readFile(join(directory, name))
  assert.ok(bytes.length > 100, `${name} is empty`)
  return { name, sha256: sha256(bytes), bytes: bytes.length }
}

export async function proveDashboardEventFeedBrowser({
  baseUrl, client, workspaceId, otherWorkspaceId,
  sessionCookieName, sessionCookieValue, username,
}) {
  const evidenceDir = evidenceDirectory()
  await mkdir(evidenceDir, { recursive: true })
  progressFile = join(evidenceDir, 'w36-progress.log')
  progress('start')
  const evidence = {
    schemaVersion: 'w36-dashboard-events/v1', runId: randomUUID(),
    sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null,
    outcome: 'started', contract: {
      path: FEED_PATH, method: 'GET', capabilityId: 'apollo.events.feed.list',
      policy: { ...PROJECT_EVENT_FEED_POLICY },
    },
    fixtures: {}, cases: {}, screenshots: [], browser: {}, postflight: {},
    scope: {
      demonstrated: ['project.name.changed', 'project.status.changed'],
      notDemonstrated: [
        'operation status and progress events', 'annotation events',
        'project.duplicated (duplication writes no outbox event)',
        'real-time delivery (polling, latency bounded by the poll interval)',
      ],
    },
  }
  let browserServer, browser, context, faultContext, page, faultPage, browserProcess, primaryError
  let faultRun
  try {
    const { createApiClientService } = await import('../../../src/v2/application/create-api-client.ts')
    const { PrismaApiClientRepository } = await import('../../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { nodeApiCredentialCrypto } = await import('../../../src/v2/infrastructure/security/api-credential.ts')

    const applicationRows = await client.$queryRawUnsafe("select current_setting('application_name') as application_name")
    assert.match(applicationRows[0].application_name, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
    evidence.database = { applicationName: applicationRows[0].application_name }

    const sessionHeaders = { cookie: `${sessionCookieName}=${sessionCookieValue}` }
    const activeSession = await fetch(`${baseUrl}/v1/session`, { headers: sessionHeaders })
    assert.equal(activeSession.status, 200, 'original human POST /v1/session cookie must remain active')
    const sessionPayload = await activeSession.json()
    assert.equal(sessionPayload.data.workspaceId, workspaceId)
    assert.equal(sessionPayload.data.subject, username)

    // Real credentials of API clients B (same workspace) and C (other workspace).
    const issue = (id, workspace) => createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date(),
    })({
      id, credentialId: `${id}-credential`, workspaceId: workspace, name: id,
      environment: 'production', scopes: ['projects:read', 'projects:write'],
    })
    const clientB = await issue('w36-api-client-b', workspaceId)
    const clientC = await issue('w36-api-client-c', otherWorkspaceId)
    const asBearer = (issued) => ({ authorization: `Bearer ${issued.token}` })
    const api = async (issued, method, path, body, idempotencyKey) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...asBearer(issued),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return { status: response.status, body: await response.json() }
    }
    const createProject = async (issued, name) => {
      const response = await api(issued, 'POST', '/v1/projects', {
        name, objective: 'discovery', format: '9:16', locale: 'pt-BR',
        briefing: 'Público: gestores. Oferta: conteúdo. Tom: direto e natural.',
      }, `${name.replaceAll(' ', '-')}-create`)
      assert.equal(response.status, 201, JSON.stringify(response.body))
      return response.body.data.project
    }
    const rename = async (issued, projectId, baseRevision, name, key) => {
      const response = await api(issued, 'POST', `/v1/projects/${projectId}/rename`, { baseRevision, name }, key)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      return { at: Date.now(), data: response.body.data }
    }
    const archive = async (issued, projectId, baseRevision, key) => {
      const response = await api(issued, 'POST', `/v1/projects/${projectId}/archive`, { baseRevision, confirmed: true }, key)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      return { at: Date.now(), data: response.body.data }
    }
    const projectRow = (id) => client.v2Project.findUnique({
      where: { id },
      select: { id: true, workspaceId: true, name: true, status: true, administrationRevision: true },
    })
    const outboxFor = (projectId, sequence) => client.v2PublicEventOutbox.findMany({
      where: { resourceId: projectId, sequence }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })

    const suffix = randomUUID().slice(0, 6)
    const nameOf = (label) => `${NAME_PREFIX}-${suffix} ${label}`
    const project1 = await createProject(clientB, nameOf('alvo um'))
    const project2 = await createProject(clientB, nameOf('alvo dois'))
    const otherProject = await createProject(clientC, nameOf('outro workspace'))
    // History that exists in PostgreSQL BEFORE the browser opens: it must not refetch.
    await rename(clientB, project1.id, 1, nameOf('alvo um historico'), `w36-history-${suffix}`)
    await sleep(300)
    evidence.fixtures = {
      workspaceId, otherWorkspaceId, projectIds: [project1.id, project2.id], otherProjectId: otherProject.id,
      apiClients: { sameWorkspace: 'w36-api-client-b', otherWorkspace: 'w36-api-client-c' },
    }
    const historyOutbox = await client.v2PublicEventOutbox.findMany({
      where: { workspaceId, resourceId: { in: [project1.id, project2.id] } },
    })
    assert.equal(historyOutbox.length >= 3, true, 'PostgreSQL must already hold history events')
    const oracleCards = async () => (await client.v2Project.findMany({
      where: { workspaceId, id: { in: [project1.id, project2.id] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, name: true, status: true, administrationRevision: true },
    }))

    const { chromium } = await import('playwright-core')
    browserServer = await chromium.launchServer({ executablePath: chromePath(), headless: true })
    browserProcess = browserServer.process()
    assert.ok(browserProcess?.pid, 'W36 browser must have an owned PID')
    evidence.browser.pid = browserProcess.pid
    browser = await chromium.connect(browserServer.wsEndpoint())
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(25_000)
    context.setDefaultNavigationTimeout(30_000)
    await context.addCookies([{ name: sessionCookieName, value: sessionCookieValue, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    const browserSession = await context.request.get(`${baseUrl}/v1/session`)
    assert.equal(browserSession.status(), 200, 'browser cookie must be active immediately before W36 navigation')
    evidence.browser.sessionVerifiedBeforeDashboard = true

    const dashboardUrl = `${baseUrl}/?text=${encodeURIComponent(`${NAME_PREFIX}-${suffix}`)}`

    // Labelled controlled interference #2: a PAGE that only ever receives 503 from the feed.
    async function runFaultScenario() {
      // Own context: a second page in the main context could take foreground
      // visibility away from the dashboard under measurement.
      faultContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      faultContext.setDefaultTimeout(25_000)
      faultContext.setDefaultNavigationTimeout(30_000)
      await faultContext.addCookies([{ name: sessionCookieName, value: sessionCookieValue, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
      faultPage = await faultContext.newPage()
      const sink = recordPage(faultPage, baseUrl)
      await faultPage.route((url) => url.pathname === FEED_PATH, (route) => route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'PERSISTENCE_NOT_CONFIGURED', message: 'w36 injected fault' } }),
      }))
      await faultPage.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })
      await faultPage.locator('article[data-project-id]').first().waitFor()
      const limit = PROJECT_EVENT_FEED_POLICY.maxConsecutiveFailures
      await waitFor('bounded retries', () => sink.requests.filter((request) => request.path === FEED_PATH).length >= limit, 120_000)
      const settledAt = Date.now()
      await sleep(PROJECT_EVENT_FEED_POLICY.maxBackoffMs + 2500)
      const feedRequests = sink.requests.filter((request) => request.path === FEED_PATH)
      const gaps = feedRequests.slice(1).map((request, index) => request.at - feedRequests[index].at)
      return {
        label: 'w36-fault-injection: every feed response is a routed 503',
        attempts: feedRequests.length, policyLimit: limit,
        gapsMs: gaps, firstAttemptAt: iso(feedRequests[0].at), lastAttemptAt: iso(feedRequests.at(-1).at),
        quietAfterLimitMs: Date.now() - settledAt,
        requestsAfterLimit: feedRequests.length - limit,
        statuses: sink.feed.map((entry) => entry.status),
        cardsStillRenderedFromProjects: (await cards(faultPage)).length === 2,
      }
    }

    page = await context.newPage()
    const sink = recordPage(page, baseUrl)
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })
    const expectedInitial = (await oracleCards()).map((row) => row.id)
    await waitFor('initial cards', async () => JSON.stringify((await cards(page)).map((card) => card.id)) === JSON.stringify(expectedInitial))
    await waitFor('bootstrap feed response', () => sink.feed.length >= 1)

    progress('case 1')
    // --- Case 1: bootstrap at the head, history never refetches -----------------
    const firstFeedRequest = sink.requests.find((request) => request.path === FEED_PATH)
    assert.equal(firstFeedRequest.query.startAt, 'latest', 'first feed request must start at the head')
    assert.equal('after' in firstFeedRequest.query, false)
    assert.equal(firstFeedRequest.bearer, false, 'the browser uses the human session cookie, not a bearer credential')
    assert.deepEqual(sink.feed[0].events, [], 'bootstrap delivers no history')
    assert.equal(sink.feed[0].status, 200)

    progress('case 2')
    // --- Case 2: idle poll frequency, no refetch without events ----------------
    const idleStart = sink.requests.filter((request) => request.path === FEED_PATH).length
    await waitFor('four idle polls', () => sink.requests.filter((request) => request.path === FEED_PATH).length >= idleStart + 4, 60_000)
    const idleRequests = sink.requests.filter((request) => request.path === FEED_PATH)
    const idleIntervals = idleRequests.slice(1).map((request, index) => request.at - idleRequests[index].at)
    const projectGetsBeforeMutation = sink.requests.filter((request) => request.path === '/v1/projects').length
    assert.equal(projectGetsBeforeMutation, 1, 'history and idle polls must not refetch the dashboard')
    const mean = idleIntervals.reduce((sum, value) => sum + value, 0) / idleIntervals.length
    const spread = Math.sqrt(idleIntervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / idleIntervals.length)
    evidence.cases.idlePolling = {
      intervalsMs: idleIntervals, n: idleIntervals.length, meanMs: Math.round(mean),
      stdDevMs: Math.round(spread), minMs: Math.min(...idleIntervals), maxMs: Math.max(...idleIntervals),
      configuredIntervalMs: PROJECT_EVENT_FEED_POLICY.intervalMs,
      projectGetsDuringIdle: projectGetsBeforeMutation - 1,
    }
    assert.ok(idleIntervals.length >= 4)
    assert.ok(Math.min(...idleIntervals) >= PROJECT_EVENT_FEED_POLICY.intervalMs - 150, `poll faster than configured: ${idleIntervals}`)
    assert.ok(Math.max(...idleIntervals) <= PROJECT_EVENT_FEED_POLICY.intervalMs + 2500, `poll slower than bounded: ${idleIntervals}`)
    evidence.cases.bootstrap = {
      firstRequestQuery: firstFeedRequest.query, bootstrapEvents: 0,
      historyEventsInPostgres: historyOutbox.length, dashboardProjectGets: projectGetsBeforeMutation,
    }

    faultRun = runFaultScenario()
    faultRun.catch(() => undefined)

    // Document identity and observers prove "no reload" and "no skeleton flash".
    await page.evaluate(() => {
      window.__w36Doc = crypto.randomUUID()
      window.__w36Skeleton = 0
      new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches('.animate-pulse') || node.querySelector('.animate-pulse'))) window.__w36Skeleton += 1
        }
      }).observe(document.body, { childList: true, subtree: true })
    })
    sink.marked = true
    const documentIdentity = await page.evaluate(() => window.__w36Doc)
    const navigationEntries = await page.evaluate(() => performance.getEntriesByType('navigation').length)

    progress('case 3')
    // --- Case 3: external rename by API client B -> card updates, no reload ----
    const before1 = await projectRow(project1.id)
    const renamedName = nameOf('alvo um renomeado externamente')
    const mutation1 = await rename(clientB, project1.id, before1.administrationRevision, renamedName, `w36-rename-${suffix}-1`)
    const after1 = await projectRow(project1.id)
    assert.equal(after1.name, renamedName)
    assert.equal(after1.administrationRevision, before1.administrationRevision + 1)
    const command1 = await client.v2ProjectAdministrationCommand.findFirst({
      where: { projectId: project1.id, resultRevision: after1.administrationRevision },
    })
    assert.equal(command1.action, 'rename')
    assert.equal(command1.actorClientId, 'w36-api-client-b')
    const outbox1 = await outboxFor(project1.id, after1.administrationRevision)
    assert.equal(outbox1.length, 1)
    assert.equal(outbox1[0].type, 'project.name.changed')
    assert.equal(outbox1[0].workspaceId, workspaceId)
    assert.equal(command1.eventId, outbox1[0].id)
    const feed1 = await waitFor('feed delivers the rename event', () => sink.feed.find((entry) => entry.events.some((event) => event.id === outbox1[0].id)))
    const refetch1 = await waitFor('dashboard refetch after the event', () => sink.projects.find((entry) => entry.at >= feed1.at &&
      entry.rows.some((row) => row.id === project1.id && row.name === renamedName)))
    await page.waitForFunction(({ id, name }) => document.querySelector(`article[data-project-id="${id}"] h3`)?.textContent?.trim() === name,
      { id: project1.id, name: renamedName })
    const domUpdatedAt = Date.now()
    const refetchedRow = refetch1.rows.find((row) => row.id === project1.id)
    assert.equal(refetchedRow.revision, after1.administrationRevision)
    assert.equal(refetchedRow.status, after1.status)
    assert.equal((await page.evaluate(() => window.__w36Doc)), documentIdentity, 'the document must not have been reloaded')
    evidence.cases.externalRename = {
      projectId: project1.id, actor: 'w36-api-client-b (bearer, same workspace)',
      baseRevision: before1.administrationRevision, resultRevision: after1.administrationRevision,
      nameBefore: before1.name, nameAfter: after1.name,
      postgres: {
        projectRow: after1, command: { id: command1.id, action: command1.action, resultRevision: command1.resultRevision, eventId: command1.eventId },
        outbox: { id: outbox1[0].id, type: outbox1[0].type, sequence: outbox1[0].sequence, createdAt: outbox1[0].createdAt.toISOString() },
      },
      feedEvent: feed1.events.find((event) => event.id === outbox1[0].id),
      feedResponse: { at: iso(feed1.at), status: feed1.status, cursorHash: feed1.cursorHash, watermark: feed1.watermark },
      refetch: { at: iso(refetch1.at), row: refetchedRow },
      timeline: {
        mutationAt: iso(mutation1.at), feedResponseAt: iso(feed1.at), refetchResponseAt: iso(refetch1.at), domUpdatedAt: iso(domUpdatedAt),
        mutationToFeedMs: feed1.at - mutation1.at, mutationToDomMs: domUpdatedAt - mutation1.at,
      },
      cardsAfter: await cards(page),
    }

    progress('case 4')
    // --- Case 4: external archive (status event) --------------------------------
    const before2 = await projectRow(project2.id)
    const mutation2 = await archive(clientB, project2.id, before2.administrationRevision, `w36-archive-${suffix}`)
    const after2 = await projectRow(project2.id)
    assert.equal(after2.status, 'archived')
    const outbox2 = await outboxFor(project2.id, after2.administrationRevision)
    assert.equal(outbox2.length, 1)
    assert.equal(outbox2[0].type, 'project.status.changed')
    const feed2 = await waitFor('feed delivers the archive event', () => sink.feed.find((entry) => entry.events.some((event) => event.id === outbox2[0].id)))
    const refetch2 = await waitFor('dashboard refetch after the archive', () => sink.projects.find((entry) => entry.at >= feed2.at &&
      entry.rows.some((row) => row.id === project2.id && row.state === 'archived')))
    await page.waitForFunction((id) => document.querySelector(`article[data-project-id="${id}"] [data-state]`)?.getAttribute('data-state') === 'archived', project2.id)
    const archivedRow = refetch2.rows.find((row) => row.id === project2.id)
    assert.equal(archivedRow.revision, after2.administrationRevision)
    evidence.cases.externalArchive = {
      projectId: project2.id, baseRevision: before2.administrationRevision, resultRevision: after2.administrationRevision,
      statusBefore: before2.status, statusAfter: after2.status,
      postgres: {
        projectRow: after2,
        outbox: { id: outbox2[0].id, type: outbox2[0].type, sequence: outbox2[0].sequence, createdAt: outbox2[0].createdAt.toISOString() },
      },
      feedEvent: feed2.events.find((event) => event.id === outbox2[0].id), refetchRow: archivedRow,
      timeline: { mutationAt: iso(mutation2.at), feedResponseAt: iso(feed2.at), refetchResponseAt: iso(refetch2.at) },
    }
    const reloadsAndFlashes = {
      navigationsAfterMark: sink.navigations,
      navigationEntries,
      documentIdentityPreserved: (await page.evaluate(() => window.__w36Doc)) === documentIdentity,
      skeletonFlashes: await page.evaluate(() => window.__w36Skeleton),
    }
    assert.equal(reloadsAndFlashes.navigationsAfterMark, 0)
    assert.equal(reloadsAndFlashes.documentIdentityPreserved, true)
    assert.equal(reloadsAndFlashes.skeletonFlashes, 0, 'a background refresh keeps the cards on screen')
    evidence.cases.noReloadNoSyntheticEvent = {
      ...reloadsAndFlashes, syntheticDispatchEvents: 0, pageReloads: 0, explicitNavigationsAfterMark: 0,
      browserMutatingRequests: sink.requests.filter((request) => !['GET', 'HEAD'].includes(request.method)).length,
    }
    assert.equal(evidence.cases.noReloadNoSyntheticEvent.browserMutatingRequests, 0)
    evidence.screenshots.push(await screenshot(page, evidenceDir, 'w36-desktop-updated.png'))
    await page.setViewportSize({ width: 390, height: 844 })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    evidence.browser.mobileOverflowPx = overflow
    evidence.screenshots.push(await screenshot(page, evidenceDir, 'w36-mobile-updated.png'))
    assert.ok(overflow <= 1, `W36 mobile overflows by ${overflow}px`)
    await page.setViewportSize({ width: 1440, height: 1000 })

    progress('case 5')
    // --- Case 5: mutation in ANOTHER workspace -> no invalidation, no data -----
    const otherBefore = await projectRow(otherProject.id)
    assert.equal(otherBefore.workspaceId, otherWorkspaceId)
    const cardsBeforeOther = await cards(page)
    const projectGetsBeforeOther = sink.requests.filter((request) => request.path === '/v1/projects').length
    const otherName = nameOf('outro workspace renomeado')
    const mutationOther = await rename(clientC, otherProject.id, otherBefore.administrationRevision, otherName, `w36-other-${suffix}`)
    const otherAfter = await projectRow(otherProject.id)
    assert.equal(otherAfter.name, otherName)
    const otherOutbox = await outboxFor(otherProject.id, otherAfter.administrationRevision)
    assert.equal(otherOutbox.length, 1)
    assert.equal(otherOutbox[0].workspaceId, otherWorkspaceId)
    // The feed had every chance to deliver it: wait until its own watermark passed the row.
    const passed = await waitFor('feed watermark passes the other-workspace row', () => sink.feed.find((entry) =>
      entry.at >= mutationOther.at && entry.watermark && Date.parse(entry.watermark) > otherOutbox[0].createdAt.getTime()), 30_000)
    await waitFor('one more poll after the watermark', () => sink.feed.filter((entry) => entry.at > passed.at).length >= 1, 15_000)
    await sleep(PROJECT_EVENT_FEED_POLICY.intervalMs)
    const feedAfterOther = sink.feed.filter((entry) => entry.at >= mutationOther.at)
    const projectsAfterOther = sink.projects.filter((entry) => entry.at >= mutationOther.at)
    const requestsAfterOther = sink.requests.filter((request) => request.at >= mutationOther.at && request.path === '/v1/projects')
    assert.ok(feedAfterOther.length >= 2)
    assert.ok(feedAfterOther.every((entry) => entry.status === 200 && entry.events.length === 0))
    assert.equal(requestsAfterOther.length, 0, 'no dashboard refetch for another workspace')
    assert.equal(projectsAfterOther.length, 0)
    const leaked = [...feedAfterOther, ...projectsAfterOther].some((entry) =>
      entry.text.includes(otherProject.id) || entry.text.includes(otherName) || entry.text.includes(otherWorkspaceId))
    assert.equal(leaked, false, 'no byte of the other workspace reaches the browser')
    assert.deepEqual(await cards(page), cardsBeforeOther)
    // Direct authorized read as client B, from the very beginning, never shows it either.
    let after = ''
    const everyEventB = []
    for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
      const response = await api(clientB, 'GET', `${FEED_PATH}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`)
      assert.equal(response.status, 200)
      everyEventB.push(...response.body.data.events)
      after = response.body.data.nextCursor
      if (!response.body.data.hasMore) break
    }
    assert.ok(everyEventB.length >= 3)
    assert.ok(everyEventB.every((event) => event.workspaceId === workspaceId))
    assert.equal(everyEventB.some((event) => event.resource.id === otherProject.id), false)
    evidence.cases.otherWorkspace = {
      mutatedProjectId: otherProject.id, actor: 'w36-api-client-c (bearer, other workspace)',
      postgres: { projectRow: otherAfter, outbox: { id: otherOutbox[0].id, type: otherOutbox[0].type, createdAt: otherOutbox[0].createdAt.toISOString(), workspaceId: otherOutbox[0].workspaceId } },
      watermarkPassedRowAt: passed.watermark,
      feedResponsesAfterMutation: feedAfterOther.length, eventsDelivered: 0,
      dashboardProjectRequestsAfterMutation: 0, projectsResponsesAfterMutation: 0,
      dashboardProjectGetsBefore: projectGetsBeforeOther,
      leakedBytes: false, cardsUnchanged: true,
      clientBReadFromBeginning: { events: everyEventB.length, foreignEvents: 0 },
    }

    progress('case 6')
    // --- Case 6: delayed (controlled) response never replaces a newer one ------
    let armed = null
    const projectsMatcher = (url) => url.pathname === '/v1/projects'
    await page.route(projectsMatcher, async (route) => {
      if (!armed) return route.continue()
      const current = armed
      armed = null
      const response = await route.fetch()
      const body = await response.text()
      current.captured({ at: Date.now(), body })
      await sleep(DELAYED_RESPONSE_MS)
      try {
        await route.fulfill({ response, body })
        current.settled('fulfilled')
      } catch {
        current.settled('abandoned')
      }
    })
    const staleDeferred = {}
    staleDeferred.captured = new Promise((resolve) => { staleDeferred.captureResolve = resolve })
    staleDeferred.settledPromise = new Promise((resolve) => { staleDeferred.settledResolve = resolve })
    armed = { captured: staleDeferred.captureResolve, settled: staleDeferred.settledResolve }
    const before3 = await projectRow(project1.id)
    const olderName = nameOf('resposta atrasada antiga')
    const newerName = nameOf('resposta nova vence')
    const staleMutation1 = await rename(clientB, project1.id, before3.administrationRevision, olderName, `w36-stale-${suffix}-1`)
    const delayedCapture = await withTimeout('the delayed projects request to be intercepted', staleDeferred.captured, 30_000)
    const delayedBody = JSON.parse(delayedCapture.body)
    const delayedRow = delayedBody.data.projects.find((row) => row.id === project1.id)
    assert.equal(delayedRow.name, olderName, 'the delayed response carries the OLDER state')
    const staleMutation2 = await rename(clientB, project1.id, before3.administrationRevision + 1, newerName, `w36-stale-${suffix}-2`)
    const after3 = await projectRow(project1.id)
    assert.equal(after3.name, newerName)
    await page.waitForFunction(({ id, name }) => document.querySelector(`article[data-project-id="${id}"] h3`)?.textContent?.trim() === name,
      { id: project1.id, name: newerName })
    const newerShownAt = Date.now()
    const releaseAt = delayedCapture.at + DELAYED_RESPONSE_MS
    await sleep(Math.max(0, releaseAt - Date.now()) + 1500)
    const outcomeOfDelayed = await Promise.race([staleDeferred.settledPromise, sleep(3000).then(() => 'unsettled')])
    const finalCards = await cards(page)
    assert.equal(finalCards.find((card) => card.id === project1.id).name, newerName, 'the older delayed response must never replace the newer card')
    const newerResponse = sink.projects.find((entry) => entry.rows.some((row) => row.id === project1.id && row.name === newerName))
    assert.ok(newerResponse)
    assert.equal(sink.projects.some((entry) => entry.at > delayedCapture.at && entry.rows.some((row) => row.id === project1.id && row.name === olderName)), false,
      'the older state was never delivered to the page')
    const abortedDelayed = sink.failed.find((entry) => entry.path === '/v1/projects' && entry.at >= delayedCapture.at)
    evidence.cases.delayedResponse = {
      label: 'w36-delayed-response: ONE /v1/projects response held for 12 s by the test via request interception',
      delayedMs: DELAYED_RESPONSE_MS,
      older: { name: olderName, revision: delayedRow.dashboard.administrationRevision, capturedAt: iso(delayedCapture.at), mutationAt: iso(staleMutation1.at) },
      newer: { name: newerName, revision: after3.administrationRevision, mutationAt: iso(staleMutation2.at), shownAt: iso(newerShownAt), responseAt: iso(newerResponse.at) },
      releasedAt: iso(releaseAt), delayedRequestOutcome: outcomeOfDelayed,
      delayedRequestAbortedByClient: abortedDelayed?.error ?? null,
      finalCardName: finalCards.find((card) => card.id === project1.id).name,
      olderStateDeliveredToPage: false,
    }
    await page.unroute(projectsMatcher).catch(() => undefined)

    progress('case 7')
    // --- Case 7: leaving the dashboard stops polling (unmount) ------------------
    const feedCountBeforeLeave = sink.requests.filter((request) => request.path === FEED_PATH).length
    await page.getByTestId('app-shell-navigation').getByRole('link', { name: 'Lotes' }).click()
    await page.waitForURL((url) => url.pathname === '/batches')
    await sleep(400)
    const leftAt = Date.now()
    await sleep(PROJECT_EVENT_FEED_POLICY.intervalMs * 2.5)
    const feedAfterLeave = sink.requests.filter((request) => request.path === FEED_PATH && request.at > leftAt)
    assert.equal(feedAfterLeave.length, 0, 'no feed request may start after the dashboard unmounted')
    const softNavigation = (await page.evaluate(() => window.__w36Doc)) === documentIdentity
    assert.equal(softNavigation, true, 'leaving was a client-side navigation, not a reload')
    evidence.cases.unmount = {
      leftDashboardAt: iso(leftAt), observedMs: Math.round(PROJECT_EVENT_FEED_POLICY.intervalMs * 2.5),
      feedRequestsBeforeLeave: feedCountBeforeLeave, feedRequestsAfterLeave: 0, clientSideNavigation: softNavigation,
    }
    await page.goBack({ waitUntil: 'domcontentloaded' })
    await waitFor('poller restarts at the head after remount', () => sink.requests.some((request) =>
      request.path === FEED_PATH && request.at > leftAt && request.query.startAt === 'latest'), 20_000)
    evidence.cases.unmount.remountRestartsAtHead = true

    progress('case 8')
    // --- Case 8: bounded errors / retries (second page, injected 503) ----------
    evidence.cases.boundedRetries = await faultRun
    const retry = evidence.cases.boundedRetries
    assert.equal(retry.attempts, PROJECT_EVENT_FEED_POLICY.maxConsecutiveFailures)
    assert.equal(retry.requestsAfterLimit, 0)
    assert.ok(retry.statuses.every((status) => status === 503))
    const expectedGaps = [8000, 16000, 30000]
    assert.equal(retry.gapsMs.length, expectedGaps.length)
    retry.gapsMs.forEach((gap, index) => {
      assert.ok(gap >= expectedGaps[index] - 200 && gap <= expectedGaps[index] + 2500, `retry gap ${index} was ${gap}ms, expected about ${expectedGaps[index]}ms`)
    })
    assert.equal(retry.cardsStillRenderedFromProjects, true)

    // Whole-proof sanitization: nothing recorded may contain a credential.
    const serialized = JSON.stringify(evidence)
    for (const secret of [sessionCookieValue, clientB.token, clientC.token]) {
      assert.equal(serialized.includes(secret), false, 'evidence must not contain credentials')
    }
    evidence.requests = {
      mainPage: sink.requests.filter((request) => request.path === FEED_PATH || request.path === '/v1/projects').map((request) => ({
        at: iso(request.at), method: request.method, path: request.path, query: request.query,
      })),
      feedResponses: sink.feed.map((entry) => ({
        at: iso(entry.at), status: entry.status, hadCursor: entry.hadCursor, startAt: entry.startAt,
        events: entry.events, hasMore: entry.hasMore, watermark: entry.watermark, cursorHash: entry.cursorHash,
      })),
    }
    evidence.outcome = 'passed'
    return evidence
  } catch (error) {
    primaryError = error
    evidence.outcome = 'failed'
    evidence.failure = { name: error?.name ?? 'Error', message: String(error?.message ?? '').slice(0, 300) }
    throw error
  } finally {
    const cleanupErrors = []
    if (faultRun) await faultRun.catch(() => undefined)
    await boundedClose('fault-page', faultPage && (() => faultPage.close()), cleanupErrors)
    await boundedClose('fault-context', faultContext && (() => faultContext.close()), cleanupErrors)
    await boundedClose('page', page && (() => page.close()), cleanupErrors)
    await boundedClose('context', context && (() => context.close()), cleanupErrors)
    await boundedClose('browser', browser && (() => browser.close()), cleanupErrors)
    await boundedClose('browser-server', browserServer && (() => browserServer.close()), cleanupErrors, 60_000)
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      try { browserProcess.kill('SIGKILL') } catch (error) { cleanupErrors.push(`browser-kill:${error?.name ?? 'Error'}`) }
    }
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      await Promise.race([new Promise((done) => browserProcess.once('exit', done)), new Promise((done) => setTimeout(done, 60_000))])
    }
    evidence.postflight.browserProcessTerminal = !browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null
    if (!evidence.postflight.browserProcessTerminal) cleanupErrors.push('browser-process-not-terminal')
    evidence.postflight.cleanupErrors = cleanupErrors
    if (cleanupErrors.length) evidence.outcome = 'failed'
    try { await writeFile(join(evidenceDir, 'w36-manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'w' }) }
    catch (error) { cleanupErrors.push(`manifest:${error?.name ?? 'Error'}`) }
    if (cleanupErrors.length) throw new AggregateError(primaryError
      ? [primaryError, ...cleanupErrors.map((item) => new Error(item))]
      : cleanupErrors.map((item) => new Error(item)), 'W36 browser proof and/or cleanup failed')
  }
}
