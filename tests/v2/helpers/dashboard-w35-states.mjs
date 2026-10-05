import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

import {
  W35_EMPTY_WORKSPACE_ID, archiveThroughApi, createRealProject, readAggregateOracle,
  seedAnnotations, seedFinalExportChain, seedOperation, setProjectStatus,
} from './dashboard-w34-35-fixtures.mjs'
import {
  ARCHIVABLE, assertCard, awaitProjectList, closeBrowser, evidenceDirectory,
  expectedCard, launchBrowser, layoutReport, newHumanContext, readCards, readTiles,
  screenshot, trackRequests, writeManifest,
} from './dashboard-w34-35-browser.mjs'

const { createApiClientService } = await import('../../../src/v2/application/create-api-client.ts')
const { PrismaApiClientRepository } = await import('../../../src/v2/infrastructure/prisma/api-client-repository.ts')
const { nodeApiCredentialCrypto } = await import('../../../src/v2/infrastructure/security/api-credential.ts')
const { PrismaWorkspaceRepository } = await import('../../../src/v2/infrastructure/prisma/workspace-repository.ts')
const { createWorkspace } = await import('../../../src/v2/domain/workspace.ts')

export const W35_PREFIX = 'w35-'
export const W35_SCHEMA = 'w35-dashboard-states/v1'
export const W35_MANIFEST = 'w35-manifest.json'
export const W35_SCREENSHOTS = [
  'w35-desktop-states.png', 'w35-mobile-states.png',
  'w35-desktop-empty.png', 'w35-mobile-empty.png',
]
export const W35_FIXTURES = [
  'w35-draft', 'w35-queued', 'w35-processing-25', 'w35-processing-75', 'w35-unmeasured',
  'w35-review', 'w35-failed', 'w35-completed', 'w35-archived',
]

async function databaseCounts(client, workspaceId) {
  const where = { workspaceId }
  return {
    projects: await client.v2Project.count({ where }),
    versions: await client.v2ProjectVersion.count({ where }),
    editCommands: await client.v2EditCommand.count({ where }),
    creationCommands: await client.v2ProjectCreationCommand.count({ where }),
    administrationCommands: await client.v2ProjectAdministrationCommand.count({ where }),
    publicOperations: await client.v2PublicOperation.count({ where }),
    reviewAnnotations: await client.v2ReviewAnnotation.count({ where }),
    finalExportOperations: await client.v2ProjectFinalExportOperation.count({ where }),
  }
}

const origin = (kind, detail) => ({ origin: kind, detail })
const cookieOf = (response, cookieName) => response.headers.get('set-cookie')
  ?.match(new RegExp(`${cookieName}=([^;]+)`))?.[1]

/**
 * A real human session inside a workspace that holds zero projects: a second
 * POST /v1/session (the login throttle row of the earlier throttle fixture is
 * reset first), then the real POST /v1/session/workspace switch. Returns the
 * session cookie of the empty workspace.
 */
async function enterEmptyWorkspace({
  baseUrl, client, workspaceId, sessionCookieName, uiThrottleKey, username, password,
}) {
  const member = await client.v2WorkspaceMember.findFirst({
    where: { workspaceId, status: 'active', identity: { issuer: 'urn:apollo:bootstrap', status: 'active' } },
  })
  assert.ok(member, 'the human member of the journey workspace exists')
  const createdAt = new Date('2026-07-12T16:00:00.000Z')
  await new PrismaWorkspaceRepository(client).create(createWorkspace({
    id: W35_EMPTY_WORKSPACE_ID, slug: W35_EMPTY_WORKSPACE_ID,
    name: 'W35 empty workspace', status: 'active', createdAt: createdAt.toISOString(),
  }))
  const uiClientId = 'w35-empty-ui-client-v2'
  await createApiClientService({
    repository: new PrismaApiClientRepository(client),
    credentialCrypto: nodeApiCredentialCrypto,
    clock: () => createdAt,
  })({
    id: uiClientId, workspaceId: W35_EMPTY_WORKSPACE_ID, name: 'W35 empty workspace UI client',
    environment: 'production', scopes: ['artifacts:read', 'projects:read', 'projects:write'],
  })
  await client.v2WorkspaceUiPrincipal.create({ data: {
    workspaceId: W35_EMPTY_WORKSPACE_ID, clientId: uiClientId, createdAt, updatedAt: createdAt,
  } })
  await client.v2WorkspaceMember.create({ data: {
    id: '00000000-0000-4000-8000-000000000935', workspaceId: W35_EMPTY_WORKSPACE_ID,
    identityId: member.identityId, role: 'director', status: 'active', createdAt, updatedAt: createdAt,
  } })
  assert.equal(await client.v2Project.count({ where: { workspaceId: W35_EMPTY_WORKSPACE_ID } }), 0)

  // The earlier fixtures deliberately exhausted the login throttle; reset only
  // that row so a genuine second human login is possible.
  await client.v2UiLoginThrottle.deleteMany({ where: { keyHash: uiThrottleKey } })
  const login = await fetch(`${baseUrl}/v1/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, next: '/' }),
  })
  const loginBody = await login.json()
  assert.equal(login.status, 200, JSON.stringify(loginBody))
  assert.equal(loginBody.data.workspaceId, workspaceId)
  const firstCookie = cookieOf(login, sessionCookieName)
  assert.ok(firstCookie)
  const switched = await fetch(`${baseUrl}/v1/session/workspace`, {
    method: 'POST',
    headers: {
      cookie: `${sessionCookieName}=${firstCookie}`, 'content-type': 'application/json',
      origin: baseUrl, 'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ workspaceId: W35_EMPTY_WORKSPACE_ID }),
  })
  const switchedBody = await switched.json()
  assert.equal(switched.status, 200, JSON.stringify(switchedBody))
  assert.equal(switchedBody.data.workspaceId, W35_EMPTY_WORKSPACE_ID)
  const emptyCookie = cookieOf(switched, sessionCookieName)
  assert.ok(emptyCookie)
  return emptyCookie
}

/**
 * W35: every visible state of a dashboard card, from persisted V2 data, plus
 * the real empty state. States are read from PostgreSQL and the API first and
 * only then compared with what the browser shows.
 */
export async function proveDashboardStates({
  baseUrl, client, workspaceId, apiClientId, authorization, credentialId,
  sessionCookieName, sessionCookieValue, username, password, uiThrottleKey,
  sourceArtifactId, sourceManifestId,
}) {
  const evidenceDir = evidenceDirectory('APOLLO_W35_EVIDENCE_DIR', 'w35')
  await mkdir(evidenceDir, { recursive: true })
  const evidence = {
    schemaVersion: W35_SCHEMA, runId: randomUUID(),
    sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null,
    outcome: 'started', filter: { text: W35_PREFIX }, states: [], tiles: {}, screenshots: [],
    requests: {}, browser: {}, postflight: {}, empty: {}, gaps: [],
  }
  const handles = { contexts: [] }
  let primaryError
  try {
    const audit = { credentialId, environment: 'production', contextHash: 'c'.repeat(64) }
    const sessionHeaders = { cookie: `${sessionCookieName}=${sessionCookieValue}` }
    const session = await fetch(`${baseUrl}/v1/session`, { headers: sessionHeaders })
    assert.equal(session.status, 200, 'the human session must be active')
    const sessionBody = await session.json()
    assert.equal(sessionBody.data.workspaceId, workspaceId)
    assert.equal(sessionBody.data.subject, username)
    const applicationRows = await client.$queryRawUnsafe("select current_setting('application_name') as application_name")
    assert.match(applicationRows[0].application_name, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
    evidence.database = { applicationName: applicationRows[0].application_name }

    const now = Date.now()
    const at = (secondsAgo) => new Date(now - secondsAgo * 1000)
    const make = (name) => createRealProject({ baseUrl, authorization, name, key: `${name}-create` })
    const operationOf = (projectId, id, overrides) => seedOperation(client, {
      workspaceId, clientId: apiClientId, projectId, id, targetId: sourceArtifactId, audit,
      createdAt: at(60), updatedAt: at(30), ...overrides,
    })
    const fixtures = {}
    const record = (name, project, statusOrigin, operationOrigin, extra = {}) => {
      fixtures[name] = {
        projectId: project.project.id,
        origins: {
          project: origin('real-api', 'POST /v1/projects'),
          status: statusOrigin,
          latestOperation: operationOrigin,
          worker: origin('absent', 'no worker or provider executed this state'),
        },
        ...extra,
      }
    }
    const SEED_STATUS = (status) => origin('controlled-pg-seed', `projects.status = ${status}`)
    const ABSENT_OPERATION = origin('absent', 'no public operation exists')

    // draft: only the real API created it.
    const draft = await make('w35-draft')
    record('w35-draft', draft, origin('real-api', 'default draft status from POST /v1/projects'), ABSENT_OPERATION)

    // queued: a queued operation measured at 0 of 4.
    const queued = await make('w35-queued')
    await operationOf(queued.project.id, 'w35-queued-op', { status: 'queued', phase: 'queued', completed: 0, createdAt: at(20), updatedAt: at(10) })
    await setProjectStatus(client, queued.project.id, 'rendering-proxy')
    record('w35-queued', queued, SEED_STATUS('rendering-proxy'), origin('controlled-pg-seed', 'queued project-proxy-render 0/4'))

    // processing, measured.
    const processing25 = await make('w35-processing-25')
    await operationOf(processing25.project.id, 'w35-processing-25-op', { status: 'running', phase: 'rendering', completed: 1 })
    await setProjectStatus(client, processing25.project.id, 'rendering-proxy')
    record('w35-processing-25', processing25, SEED_STATUS('rendering-proxy'), origin('controlled-pg-seed', 'running project-proxy-render 1/4'))
    const processing75 = await make('w35-processing-75')
    await operationOf(processing75.project.id, 'w35-processing-75-op', { type: 'project-final-export', status: 'running', phase: 'persisting', completed: 3 })
    await setProjectStatus(client, processing75.project.id, 'rendering-final')
    record('w35-processing-75', processing75, SEED_STATUS('rendering-final'), origin('controlled-pg-seed', 'running project-final-export 3/4'))

    // processing, unmeasured: counter without a total (PostgreSQL accepts the
    // shape; product code never writes it).
    const unmeasured = await make('w35-unmeasured')
    await client.v2PublicOperation.create({ data: {
      id: 'w35-unmeasured-op', workspaceId, projectId: unmeasured.project.id, clientId: apiClientId,
      type: 'project-proxy-render', status: 'running', phase: 'rendering',
      targetType: 'media-artifact', targetId: sourceArtifactId,
      progressCompleted: 1, progressTotal: null, progressUnit: null,
      cancelable: true, retryable: false, attempt: 1, maxAttempts: 3,
      idempotencyKey: 'w35-unmeasured-op-key', requestFingerprint: 'f'.repeat(64),
      actorCredentialId: audit.credentialId, actorEnvironment: 'production',
      actorAuthenticationKind: 'bearer', actorContextHash: audit.contextHash,
      createdAt: at(60), updatedAt: at(30), startedAt: at(59),
      leaseOwner: 'w35-controlled-seed', heartbeatAt: at(30), leaseExpiresAt: new Date(now + 300_000),
    } })
    await setProjectStatus(client, unmeasured.project.id, 'rendering-proxy')
    record('w35-unmeasured', unmeasured, SEED_STATUS('rendering-proxy'),
      origin('controlled-pg-seed', 'running project-proxy-render, counter 1, NULL total and unit; shape accepted by PostgreSQL, never written by product code'))

    // awaiting review: a finished proxy and one open annotation.
    const review = await make('w35-review')
    await operationOf(review.project.id, 'w35-review-op', { status: 'succeeded', phase: 'completed', completed: 4 })
    await seedAnnotations(client, {
      workspaceId, projectId: review.project.id, versionId: review.version.id,
      proxyArtifactId: sourceArtifactId, clientId: apiClientId, audit, suffix: 'w35-review',
      status: 'open', count: 1,
    })
    await setProjectStatus(client, review.project.id, 'reviewing-proxy')
    record('w35-review', review, SEED_STATUS('reviewing-proxy'), origin('controlled-pg-seed', 'succeeded project-proxy-render 4/4 and 1 open annotation'))

    // failed: persisted error code, retryable.
    const failed = await make('w35-failed')
    await operationOf(failed.project.id, 'w35-failed-op', {
      status: 'failed', phase: 'failed', completed: 2, errorCode: 'render-failed', errorRetryable: true,
    })
    await setProjectStatus(client, failed.project.id, 'failed')
    record('w35-failed', failed, SEED_STATUS('failed'), origin('controlled-pg-seed', 'failed project-proxy-render 2/4, render-failed, retryable'))

    // completed: a succeeded final export is the output.
    const completed = await make('w35-completed')
    const chain = await seedFinalExportChain(client, {
      workspaceId, clientId: apiClientId, projectId: completed.project.id,
      versionId: completed.version.id, sourceArtifactId, sourceManifestId, audit,
      suffix: 'w35-completed', aspectRatio: '9:16', exports: [{ status: 'succeeded' }],
    })
    await setProjectStatus(client, completed.project.id, 'completed')
    record('w35-completed', completed, SEED_STATUS('completed'),
      origin('controlled-pg-seed', 'succeeded project-final-export 4/4 behind a proxy review and director run'),
      { outputOperationId: chain.outputs[0].operationId })

    // archived: produced by the real archive API as the journey API client.
    const archivedProject = await make('w35-archived')
    await archiveThroughApi({
      baseUrl, authorization, projectId: archivedProject.project.id, baseRevision: 1,
      key: 'w35-archived-archive',
    })
    record('w35-archived', archivedProject, origin('real-api', 'POST /v1/projects/{id}/archive (journey API client, runtime path)'), ABSENT_OPERATION)
    assert.deepEqual(Object.keys(fixtures).sort(), [...W35_FIXTURES].sort())

    // ---- Oracle, then API --------------------------------------------------------
    const oracles = {}
    for (const name of W35_FIXTURES) {
      oracles[name] = await readAggregateOracle(client, { workspaceId, projectId: fixtures[name].projectId })
      assert.equal(oracles[name].project.name, name)
    }
    const statusByName = {
      'w35-draft': 'draft', 'w35-queued': 'rendering-proxy', 'w35-processing-25': 'rendering-proxy',
      'w35-processing-75': 'rendering-final', 'w35-unmeasured': 'rendering-proxy',
      'w35-review': 'reviewing-proxy', 'w35-failed': 'failed', 'w35-completed': 'completed',
      'w35-archived': 'archived',
    }
    for (const name of W35_FIXTURES) assert.equal(oracles[name].project.status, statusByName[name], `${name}: persisted status`)
    const progressOf = (name) => oracles[name].expected.latestOperation?.progress
    assert.equal(oracles['w35-draft'].expected.latestOperation, null)
    assert.deepEqual(progressOf('w35-queued'), { completed: 0, total: 4, unit: 'render' })
    assert.deepEqual(progressOf('w35-processing-25'), { completed: 1, total: 4, unit: 'render' })
    assert.deepEqual(progressOf('w35-processing-75'), { completed: 3, total: 4, unit: 'render' })
    assert.deepEqual(progressOf('w35-unmeasured'), { completed: 1 })
    assert.deepEqual(progressOf('w35-review'), { completed: 4, total: 4, unit: 'render' })
    assert.deepEqual(progressOf('w35-failed'), { completed: 2, total: 4, unit: 'render' })
    assert.deepEqual(oracles['w35-failed'].expected.latestOperation.error, { code: 'render-failed', retryable: true })
    assert.equal(oracles['w35-review'].expected.openReviewIssueCount, 1)
    assert.equal(oracles['w35-completed'].expected.outputCount, 1)
    assert.equal(oracles['w35-archived'].expected.archivedFromStatus, 'draft')
    assert.equal(oracles['w35-archived'].expected.administrationRevision, 2)
    const projectRows = await client.v2Project.findMany({
      where: { workspaceId, name: { startsWith: W35_PREFIX } }, select: { id: true, createdAt: true },
    })
    assert.equal(projectRows.length, W35_FIXTURES.length)
    const expectedOrder = projectRows
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || (left.id < right.id ? 1 : -1))
      .map((row) => row.id)
    const listUrl = `${baseUrl}/v1/projects?limit=24&text=${encodeURIComponent(W35_PREFIX)}`
    const apiResponse = await fetch(listUrl, { headers: sessionHeaders })
    assert.equal(apiResponse.status, 200)
    const apiBody = await apiResponse.json()
    assert.equal('nextCursor' in apiBody.data, false)
    assert.deepEqual(apiBody.data.projects.map((project) => project.id), expectedOrder)
    const apiById = new Map(apiBody.data.projects.map((project) => [project.id, project]))
    for (const name of W35_FIXTURES) {
      const apiProject = apiById.get(fixtures[name].projectId)
      assert.deepEqual(apiProject.dashboard, oracles[name].expected, `${name}: API aggregate differs from PostgreSQL`)
      assert.equal(apiProject.status, statusByName[name])
      assert.equal(apiProject.visibleState.schemaVersion, 'visible-state/v1')
      assert.equal(apiProject.visibleState.label, expectedCard({
        project: oracles[name].project, expected: oracles[name].expected, apiProject,
      }).state)
    }
    const wants = new Map(W35_FIXTURES.map((name) => [name, expectedCard({
      project: oracles[name].project, expected: oracles[name].expected,
      apiProject: apiById.get(fixtures[name].projectId),
    })]))

    // ---- Browser: states on desktop, destinations, mobile ----------------------
    const countsBefore = await databaseCounts(client, workspaceId)
    evidence.counts = { before: countsBefore }
    const launched = await launchBrowser('W35')
    Object.assign(handles, launched)
    evidence.browser.pid = launched.browserProcess.pid
    const dashboardUrl = `${baseUrl}/?text=${encodeURIComponent(W35_PREFIX)}`
    const allMutating = []
    const observed = {}
    const destinations = {}
    for (const [viewportName, viewport, shotName] of [
      ['desktop', { width: 1440, height: 1000 }, W35_SCREENSHOTS[0]],
      ['mobile', { width: 390, height: 844 }, W35_SCREENSHOTS[1]],
    ]) {
      const context = await newHumanContext(launched.browser, {
        baseUrl, cookieName: sessionCookieName, cookieValue: sessionCookieValue, viewport,
      })
      handles.contexts.push(context)
      const page = await context.newPage()
      handles.page = page
      const tracker = trackRequests(page, baseUrl)
      const load = async () => {
        const listResponse = awaitProjectList(page, W35_PREFIX)
        await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })
        const body = await listResponse
        await page.waitForFunction((count) =>
          document.querySelectorAll('article[data-project-id]').length === count, W35_FIXTURES.length)
        return body
      }
      const httpBody = await load()
      assert.deepEqual(httpBody.data.projects.map((project) => project.dashboard),
        apiBody.data.projects.map((project) => project.dashboard), `${viewportName}: browser HTTP aggregate`)
      const cards = await readCards(page)
      assert.deepEqual(cards.map((card) => card.id), expectedOrder, `${viewportName}: card order`)
      for (const card of cards) {
        const name = W35_FIXTURES.find((item) => fixtures[item].projectId === card.id)
        assertCard(card, wants.get(name))
        // Administrative buttons mirror the persisted state; nothing is clicked.
        const project = oracles[name].project
        const button = (label) => card.buttons.find((item) => item.text === label)
        assert.equal(button('Duplicar').disabled, project.currentVersionId === null, `${name}: Duplicar`)
        assert.equal(button('Renomear').disabled, false, `${name}: Renomear`)
        assert.equal(button('Arquivar').disabled, !ARCHIVABLE.has(project.status), `${name}: Arquivar`)
        assert.equal(button('Restaurar').disabled,
          !(project.status === 'archived' && oracles[name].expected.archivedFromStatus), `${name}: Restaurar`)
      }
      // "sem total medido" appears exactly where the persisted counter has no total.
      for (const card of cards) {
        const name = W35_FIXTURES.find((item) => fixtures[item].projectId === card.id)
        const unmeasuredHere = name === 'w35-unmeasured'
        assert.equal(card.measure === 'sem total medido', unmeasuredHere, `${name}: sem total medido`)
        if (unmeasuredHere) {
          assert.equal(card.bar, null)
          assert.deepEqual(card.percentTexts, [])
          assert.equal(card.phase, 'Renderizando')
        }
      }
      const tiles = await readTiles(page)
      const bucketCounts = { draft: 0, processing: 0, review: 0, completed: 0 }
      for (const want of wants.values()) if (want.bucket in bucketCounts) bucketCounts[want.bucket] += 1
      assert.deepEqual(tiles.map((tile) => tile.value),
        [bucketCounts.draft, bucketCounts.processing, bucketCounts.review, bucketCounts.completed], `${viewportName}: tiles`)
      const layout = await layoutReport(page)
      assert.deepEqual(layout.findings, [], `${viewportName}: no card content may leave its card or be clipped`)
      assert.ok(layout.overflowPx <= 1, `${viewportName}: horizontal overflow ${layout.overflowPx}px`)
      assert.equal(layout.cardCount, W35_FIXTURES.length)
      evidence.screenshots.push(await screenshot(page, evidenceDir, shotName))
      observed[viewportName] = { cards, tiles, layout }

      if (viewportName === 'desktop') {
        // Primary action destination per state: a real click that only navigates.
        for (const name of W35_FIXTURES) {
          const id = fixtures[name].projectId
          const want = wants.get(name)
          await page.locator(`article[data-project-id="${id}"] button`, { hasText: want.primaryButton }).click()
          await page.waitForURL((url) => url.pathname === `/projects/${id}`)
          await page.waitForLoadState('domcontentloaded')
          await page.waitForTimeout(500)
          const landed = new URL(page.url())
          assert.equal(landed.pathname, `/projects/${id}`, `${name}: primary destination`)
          // W40: the primary action of the awaiting-review state now opens review mode; every other state opens the plain workspace.
          const expectedSearch = name === 'w35-review' ? '?mode=review' : ''
          assert.equal(landed.search, expectedSearch, `${name}: primary destination ${expectedSearch ? 'opens review mode' : 'carries no mode'}`)
          destinations[name] = { primary: { button: want.primaryButton, pathname: landed.pathname, search: landed.search } }
          if (name === 'w35-review') {
            await load()
            await page.locator(`article[data-project-id="${id}"] button`, { hasText: /^Revisar$/ }).click()
            await page.waitForURL((url) => url.pathname === `/projects/${id}` && url.searchParams.get('mode') === 'review')
            destinations[name].review = { button: 'Revisar', pathname: `/projects/${id}`, search: '?mode=review' }
          }
          await load()
        }
        assert.deepEqual(Object.keys(destinations).sort(), [...W35_FIXTURES].sort())
      }
      evidence.requests[viewportName] = {
        projectGets: tracker.projectGets().length, mutating: tracker.mutating().length,
        methods: [...new Set(tracker.entries.map((entry) => entry.method))],
        requestCount: tracker.entries.length,
      }
      allMutating.push(...tracker.mutating())
      assert.equal(tracker.mutating().length, 0, `${viewportName}: state proof must not mutate`)
      await page.close()
      handles.page = undefined
    }
    evidence.tiles = observed.desktop.tiles
    evidence.counts.after = await databaseCounts(client, workspaceId)
    assert.deepEqual(evidence.counts.after, countsBefore, 'the state proof must not change PostgreSQL state')
    for (const name of W35_FIXTURES) {
      const after = await readAggregateOracle(client, { workspaceId, projectId: fixtures[name].projectId })
      assert.deepEqual(after, oracles[name], `${name}: persisted state drifted during the read-only window`)
      evidence.states.push({
        name, projectId: fixtures[name].projectId, status: statusByName[name],
        origins: fixtures[name].origins, persisted: oracles[name].expected,
        api: apiById.get(fixtures[name].projectId).dashboard,
        visibleState: apiById.get(fixtures[name].projectId).visibleState,
        expectedCard: wants.get(name), destination: destinations[name],
        card: { desktop: observed.desktop.cards.find((card) => card.id === fixtures[name].projectId),
          mobile: observed.mobile.cards.find((card) => card.id === fixtures[name].projectId) },
      })
    }
    evidence.expectedOrder = expectedOrder
    evidence.browser.mutatingRequests = allMutating.length
    evidence.browser.mobileOverflowPx = observed.mobile.layout.overflowPx
    evidence.browser.desktopOverflowPx = observed.desktop.layout.overflowPx

    // ---- Real empty state ----------------------------------------------------------
    const emptyCookie = await enterEmptyWorkspace({
      baseUrl, client, workspaceId, sessionCookieName, uiThrottleKey, username, password,
    })
    const emptyApi = await fetch(`${baseUrl}/v1/projects?limit=24`, { headers: { cookie: `${sessionCookieName}=${emptyCookie}` } })
    assert.equal(emptyApi.status, 200)
    const emptyBody = await emptyApi.json()
    assert.deepEqual(emptyBody.data.projects, [])
    assert.equal('nextCursor' in emptyBody.data, false)
    const emptyRows = await client.v2Project.count({ where: { workspaceId: W35_EMPTY_WORKSPACE_ID } })
    assert.equal(emptyRows, 0)
    evidence.empty = { workspaceId: W35_EMPTY_WORKSPACE_ID, persistedProjects: emptyRows, apiProjects: 0, origin: origin('real-api', 'POST /v1/session then POST /v1/session/workspace into a workspace with no project row') }
    for (const [viewportName, viewport, shotName] of [
      ['desktop', { width: 1440, height: 1000 }, W35_SCREENSHOTS[2]],
      ['mobile', { width: 390, height: 844 }, W35_SCREENSHOTS[3]],
    ]) {
      const context = await newHumanContext(launched.browser, {
        baseUrl, cookieName: sessionCookieName, cookieValue: emptyCookie, viewport,
      })
      handles.contexts.push(context)
      const page = await context.newPage()
      handles.page = page
      const tracker = trackRequests(page, baseUrl)
      const listResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/projects' && response.request().method() === 'GET')
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      const emptyHttp = await (await listResponse).json()
      assert.deepEqual(emptyHttp.data.projects, [])
      await page.getByRole('heading', { name: 'Nenhuma produção ainda' }).waitFor()
      await page.getByRole('button', { name: 'Criar primeiro projeto' }).waitFor()
      assert.equal(await page.locator('article[data-project-id]').count(), 0)
      assert.equal(await page.getByText('Nenhum projeto corresponde a esses filtros.').count(), 0, 'the real empty state is not the filtered-empty message')
      const tiles = await readTiles(page)
      assert.deepEqual(tiles.map((tile) => tile.value), [0, 0, 0, 0])
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      assert.ok(overflow <= 1, `${viewportName} empty: horizontal overflow ${overflow}px`)
      const box = await page.getByRole('heading', { name: 'Nenhuma produção ainda' }).boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1, `${viewportName} empty: heading inside the viewport`)
      evidence.screenshots.push(await screenshot(page, evidenceDir, shotName))
      evidence.empty[viewportName] = { overflowPx: overflow, tiles: tiles.map((tile) => tile.value) }
      assert.equal(tracker.mutating().length, 0)
      allMutating.push(...tracker.mutating())
      await page.close()
      handles.page = undefined
    }
    evidence.browser.mutatingRequests = allMutating.length
    evidence.gaps = [
      'No state came from a real worker or provider: operation and status rows are controlled PostgreSQL seeds, so state TRANSITIONS are not proven here.',
      'The unmeasured progress shape (counter without total) is accepted by PostgreSQL but never written by product code; it is a seed.',
    ]
    evidence.outcome = 'passed'
    return evidence
  } catch (error) {
    primaryError = error
    evidence.outcome = 'failed'
    evidence.failure = { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 600) }
    throw error
  } finally {
    const cleanupErrors = []
    evidence.postflight.browserProcessTerminal = await closeBrowser(handles, cleanupErrors)
    evidence.postflight.cleanupErrors = cleanupErrors
    if (cleanupErrors.length) evidence.outcome = 'failed'
    try { await writeManifest(evidenceDir, W35_MANIFEST, evidence) }
    catch (error) { cleanupErrors.push(`manifest:${error?.name ?? 'Error'}`) }
    if (cleanupErrors.length) throw new AggregateError(primaryError
      ? [primaryError, ...cleanupErrors.map((item) => new Error(item))]
      : cleanupErrors.map((item) => new Error(item)), 'W35 browser proof and/or cleanup failed')
  }
}
