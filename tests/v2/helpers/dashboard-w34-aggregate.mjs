import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

import {
  advanceVersionThroughApi, archiveThroughApi, createRealProject, readAggregateOracle,
  seedAnnotations, seedDirectedProject, seedFinalExportChain, seedOperation, setProjectStatus, proveRejectedProgressWithoutTotal,
} from './dashboard-w34-35-fixtures.mjs'
import {
  assertCard, awaitProjectList, closeBrowser, evidenceDirectory, expectedCard,
  launchBrowser, layoutReport, newHumanContext, readCards, readTiles, screenshot,
  trackRequests, writeManifest,
} from './dashboard-w34-35-browser.mjs'

export const W34_PREFIX = 'w34-'
export const W34_SCHEMA = 'w34-dashboard-aggregate/v2'
export const W34_MANIFEST = 'w34-manifest.json'
export const W34_SCREENSHOTS = ['w34-desktop-aggregate.png', 'w34-mobile-aggregate.png']
// The fixture names are fixed so the guard can pin the expected aggregate.
export const W34_FIXTURES = ['w34-bare', 'w34-versioned', 'w34-complete', 'w34-failed-op', 'w34-archived']

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

/**
 * W34: the persisted aggregate behind every dashboard card. Fixtures are
 * created after the baseline assertions; expectations come from PostgreSQL and
 * the API, never from the component.
 */
export async function proveDashboardAggregate({
  baseUrl, client, workspaceId, apiClientId, authorization, credentialId,
  sessionCookieName, sessionCookieValue, username, sourceArtifactId,
}) {
  const evidenceDir = evidenceDirectory('APOLLO_W34_EVIDENCE_DIR', 'w34')
  await mkdir(evidenceDir, { recursive: true })
  const evidence = {
    schemaVersion: W34_SCHEMA, runId: randomUUID(),
    sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null,
    outcome: 'started', filter: { text: W34_PREFIX }, fixtures: [], tiles: {}, screenshots: [],
    requests: {}, browser: {}, postflight: {},
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

    const baselineProjects = await client.v2Project.count({ where: { workspaceId } })
    const now = Date.now()
    const at = (secondsAgo) => new Date(now - secondsAgo * 1000)
    const make = (name) => createRealProject({
      baseUrl, authorization, name, key: `${name}-create`,
    })
    const fixtures = {}

    // 1. bare: every optional relation is genuinely absent.
    const bare = await make('w34-bare')
    fixtures['w34-bare'] = {
      projectId: bare.project.id,
      origins: {
        project: origin('real-api', 'POST /v1/projects'),
        currentVersion: origin('real-api', 'POST /v1/projects (sequence 1)'),
        latestOperation: origin('absent', 'no public operation exists'),
        openReviewIssues: origin('absent', 'no annotation exists'),
        outputs: origin('absent', 'no final export exists'),
        administration: origin('real-api', 'default revision 1'),
      },
    }

    // 2. versioned: a real second version, a newer running operation over an
    //    older succeeded one, open annotations on the current version only.
    const versioned = await make('w34-versioned')
    const versionedV2 = await advanceVersionThroughApi({
      baseUrl, authorization, projectId: versioned.project.id, version: versioned.version,
      key: 'w34-versioned-lut-none',
    })
    await seedOperation(client, {
      workspaceId, clientId: apiClientId, projectId: versioned.project.id,
      id: 'w34-versioned-op-old', status: 'succeeded', phase: 'completed', completed: 4,
      createdAt: at(90), updatedAt: at(80), targetId: sourceArtifactId, audit,
    })
    await seedOperation(client, {
      workspaceId, clientId: apiClientId, projectId: versioned.project.id,
      id: 'w34-versioned-op-new', status: 'running', phase: 'rendering', completed: 1,
      createdAt: at(60), updatedAt: at(50), targetId: sourceArtifactId, audit,
    })
    const annotationBase = {
      workspaceId, projectId: versioned.project.id, proxyArtifactId: sourceArtifactId,
      clientId: apiClientId, audit, suffix: 'w34-versioned',
    }
    await seedAnnotations(client, { ...annotationBase, versionId: versionedV2.id, status: 'open', count: 2 })
    await seedAnnotations(client, { ...annotationBase, versionId: versionedV2.id, status: 'applied', count: 1 })
    await seedAnnotations(client, { ...annotationBase, versionId: versionedV2.id, status: 'dismissed', count: 1 })
    await seedAnnotations(client, { ...annotationBase, versionId: versioned.version.id, status: 'open', count: 1, suffix: 'w34-versioned-old' })
    await setProjectStatus(client, versioned.project.id, 'rendering-proxy')
    fixtures['w34-versioned'] = {
      projectId: versioned.project.id,
      origins: {
        project: origin('real-api', 'POST /v1/projects'),
        currentVersion: origin('real-api', 'POST /v1/projects/{id}/output-variants 9:16 (sequence 2)'),
        latestOperation: origin('controlled-pg-seed', 'two project-proxy-render rows; the newer running one must win'),
        openReviewIssues: origin('controlled-pg-seed', '2 open + 1 applied + 1 dismissed on v2; 1 open on superseded v1'),
        outputs: origin('absent', 'no final export exists'),
        administration: origin('real-api', 'default revision 1'),
        status: origin('controlled-pg-seed', 'rendering-proxy'),
      },
    }

    // 3. complete: outputs only from succeeded exports of the current version.
    const complete = await make('w34-complete')
    const chainBase = {
      workspaceId, clientId: apiClientId, projectId: complete.project.id, audit,
    }
    // 6.0.0: the head that carries outputs needs a REAL Director run, and a Version is born only with its sealed State. Every
    // Version change therefore comes before any export is seeded: creation Version (API), output variant (API, sequence 2), the
    // observed source adopted by a child Command (3), the neutral project LUT selection (4) and the Director's Version (5, head).
    await advanceVersionThroughApi({
      baseUrl, authorization, projectId: complete.project.id, version: complete.version,
      key: 'w34-complete-variant',
    })
    const completeWorld = await seedDirectedProject(client, {
      workspaceId, clientId: apiClientId, credentialId, projectId: complete.project.id, suffix: 'w34-complete',
    })
    const completeV2 = { id: completeWorld.versions.directed, sequence: completeWorld.versions.directedSequence }
    assert.equal(completeV2.sequence, 5)
    // The superseded export hangs off the Version before the Director's (the LUT selection), behind the same Director run.
    await seedFinalExportChain(client, {
      ...chainBase, versionId: completeWorld.versions.lut, directed: completeWorld, suffix: 'w34-complete-v1',
      aspectRatio: '9:16', exports: [{ status: 'succeeded' }],
    })
    const chainV2 = await seedFinalExportChain(client, {
      ...chainBase, versionId: completeV2.id, directed: completeWorld, suffix: 'w34-complete-v2',
      aspectRatio: '16:9',
      exports: [
        { status: 'succeeded', aspectRatio: '16:9' },
        { status: 'failed', aspectRatio: '1:1' },
        { status: 'succeeded', aspectRatio: '9:16' },
      ],
    })
    await seedAnnotations(client, {
      workspaceId, projectId: complete.project.id, versionId: completeV2.id,
      proxyArtifactId: sourceArtifactId, clientId: apiClientId, audit,
      suffix: 'w34-complete', status: 'applied', count: 1,
    })
    await setProjectStatus(client, complete.project.id, 'completed')
    fixtures['w34-complete'] = {
      projectId: complete.project.id,
      origins: {
        project: origin('real-api', 'POST /v1/projects'),
        currentVersion: origin('real-service', 'POST /v1/projects + /output-variants 9:16 (sequence 2), then the observed-source child (3), the LUT selection (4) and runProjectDirectorService (5, head)'),
        latestOperation: origin('controlled-pg-seed', 'newest project-final-export of v5'),
        openReviewIssues: origin('controlled-pg-seed', 'only an applied annotation: zero open'),
        outputs: origin('controlled-pg-seed', 'export on v4 excluded as superseded; v5: succeeded 16:9, failed 1:1 (excluded), succeeded 9:16; all behind the real Director run'),
        administration: origin('real-api', 'default revision 1'),
        status: origin('controlled-pg-seed', 'completed'),
      },
      director: { origin: origin('real-service', 'runProjectDirectorService over the adopted observed source'), ...completeWorld.director },
      expectedOutputArtifacts: chainV2.outputs.filter((item) => item.status === 'succeeded')
        .map((item) => ({ artifactId: item.artifactId, aspectRatio: item.aspectRatio })),
    }

    // 4. failed-op: a failed operation exposes its persisted error code.
    const failedOp = await make('w34-failed-op')
    await seedOperation(client, {
      workspaceId, clientId: apiClientId, projectId: failedOp.project.id,
      id: 'w34-failed-op-op', status: 'failed', phase: 'failed', completed: 2,
      createdAt: at(40), updatedAt: at(30), targetId: sourceArtifactId, audit,
      errorCode: 'render-failed', errorRetryable: true,
    })
    await setProjectStatus(client, failedOp.project.id, 'failed')
    fixtures['w34-failed-op'] = {
      projectId: failedOp.project.id,
      origins: {
        project: origin('real-api', 'POST /v1/projects'),
        currentVersion: origin('real-api', 'POST /v1/projects (sequence 1)'),
        latestOperation: origin('controlled-pg-seed', 'failed project-proxy-render 2/4, render-failed, retryable'),
        openReviewIssues: origin('absent', 'no annotation exists'),
        outputs: origin('absent', 'no final export exists'),
        administration: origin('real-api', 'default revision 1'),
        status: origin('controlled-pg-seed', 'failed'),
      },
    }

    // A partial counter is forbidden in PostgreSQL. Test the exact rejection
    // against the existing canonical positive operation; do not invent a total.
    evidence.progressConstraint = await proveRejectedProgressWithoutTotal(client, {
      workspaceId, projectId: versioned.project.id, operationId: 'w34-versioned-op-new',
    })
    evidence.partialProgressCoverage = {
      origin: 'synthetic-unit-only', source: 'tests/v2/project-dashboard.test.mjs',
      test: 'W34 synthetic port progress without a total never gains a percentage',
      postgresAccepted: false, browserObserved: false,
    }

    // 5. archived: the administrative fence is produced by the real API.
    const archivedProject = await make('w34-archived')
    const archivedResult = await archiveThroughApi({
      baseUrl, authorization, projectId: archivedProject.project.id,
      baseRevision: 1, key: 'w34-archived-archive',
    })
    assert.equal(archivedResult.administration.revision, 2)
    fixtures['w34-archived'] = {
      projectId: archivedProject.project.id,
      origins: {
        project: origin('real-api', 'POST /v1/projects'),
        currentVersion: origin('real-api', 'POST /v1/projects (sequence 1)'),
        latestOperation: origin('absent', 'no public operation exists'),
        openReviewIssues: origin('absent', 'no annotation exists'),
        outputs: origin('absent', 'no final export exists'),
        administration: origin('real-api', 'POST /v1/projects/{id}/archive (revision 2, archivedFromStatus draft)'),
        status: origin('real-api', 'archived by the journey API client'),
      },
    }
    assert.deepEqual(Object.keys(fixtures).sort(), [...W34_FIXTURES].sort())

    // ---- Oracle: PostgreSQL rows, independent of repository/presenter/UI -----
    const oracles = {}
    for (const name of W34_FIXTURES) {
      oracles[name] = await readAggregateOracle(client, { workspaceId, projectId: fixtures[name].projectId })
      assert.equal(oracles[name].project.name, name)
    }
    const pinned = (name) => oracles[name].expected
    assert.equal(pinned('w34-bare').currentVersion.sequence, 1)
    assert.equal(pinned('w34-bare').latestOperation, null)
    assert.equal(pinned('w34-bare').openReviewIssueCount, 0)
    assert.deepEqual(pinned('w34-bare').outputs, [])
    assert.equal(pinned('w34-versioned').currentVersion.sequence, 2)
    assert.equal(pinned('w34-versioned').currentVersion.id, versionedV2.id)
    assert.equal(pinned('w34-versioned').latestOperation.id, 'w34-versioned-op-new')
    assert.deepEqual(pinned('w34-versioned').latestOperation.progress, { completed: 1, total: 4, unit: 'render' })
    assert.equal(pinned('w34-versioned').openReviewIssueCount, 2)
    assert.equal(pinned('w34-complete').currentVersion.id, completeV2.id)
    assert.equal(pinned('w34-complete').openReviewIssueCount, 0)
    assert.deepEqual(pinned('w34-complete').outputs, fixtures['w34-complete'].expectedOutputArtifacts)
    assert.equal(pinned('w34-complete').outputCount, 2)
    assert.equal(pinned('w34-complete').latestOperation.id, 'w34-complete-v2-final-operation-3')
    assert.equal(pinned('w34-complete').latestOperation.status, 'succeeded')
    assert.deepEqual(pinned('w34-failed-op').latestOperation.error, { code: 'render-failed', retryable: true })
    assert.equal(pinned('w34-archived').administrationRevision, 2)
    assert.equal(pinned('w34-archived').archivedFromStatus, 'draft')
    const projectRows = await client.v2Project.findMany({
      where: { workspaceId, name: { startsWith: W34_PREFIX } },
      select: { id: true, createdAt: true },
    })
    assert.equal(projectRows.length, W34_FIXTURES.length)
    const expectedOrder = projectRows
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || (left.id < right.id ? 1 : -1))
      .map((row) => row.id)
    evidence.baselineProjectsBeforeFixtures = baselineProjects

    // ---- API projection ------------------------------------------------------
    const listUrl = `${baseUrl}/v1/projects?limit=24&text=${encodeURIComponent(W34_PREFIX)}`
    const apiResponse = await fetch(listUrl, { headers: sessionHeaders })
    assert.equal(apiResponse.status, 200)
    const apiBody = await apiResponse.json()
    assert.equal('nextCursor' in apiBody.data, false, 'the scoped list fits in one page')
    assert.deepEqual(apiBody.data.projects.map((project) => project.id), expectedOrder)
    const apiById = new Map(apiBody.data.projects.map((project) => [project.id, project]))
    for (const name of W34_FIXTURES) {
      const apiProject = apiById.get(fixtures[name].projectId)
      assert.deepEqual(apiProject.dashboard, oracles[name].expected, `${name}: API aggregate differs from the PostgreSQL rows`)
      assert.equal(apiProject.status, oracles[name].project.status)
      assert.equal(apiProject.name, name)
    }
    const bearerResponse = await fetch(listUrl, { headers: { authorization } })
    assert.deepEqual((await bearerResponse.json()).data.projects.map((project) => project.dashboard),
      apiBody.data.projects.map((project) => project.dashboard), 'bearer and human projections agree')

    // ---- Browser ---------------------------------------------------------------
    const countsBefore = await databaseCounts(client, workspaceId)
    evidence.counts = { before: countsBefore }
    const wants = new Map(W34_FIXTURES.map((name) => [name, expectedCard({
      project: oracles[name].project, expected: oracles[name].expected,
      apiProject: apiById.get(fixtures[name].projectId),
    })]))
    const launched = await launchBrowser('W34')
    Object.assign(handles, launched)
    evidence.browser.pid = launched.browserProcess.pid
    const observed = {}
    for (const [viewportName, viewport, shotName] of [
      ['desktop', { width: 1440, height: 1000 }, W34_SCREENSHOTS[0]],
      ['mobile', { width: 390, height: 844 }, W34_SCREENSHOTS[1]],
    ]) {
      const context = await newHumanContext(launched.browser, {
        baseUrl, cookieName: sessionCookieName, cookieValue: sessionCookieValue, viewport,
      })
      handles.contexts.push(context)
      const page = await context.newPage()
      handles.page = page
      const tracker = trackRequests(page, baseUrl)
      const listResponse = awaitProjectList(page, W34_PREFIX)
      await page.goto(`${baseUrl}/?text=${encodeURIComponent(W34_PREFIX)}`, { waitUntil: 'domcontentloaded' })
      const httpBody = await listResponse
      assert.deepEqual(httpBody.data.projects.map((project) => project.dashboard),
        apiBody.data.projects.map((project) => project.dashboard), `${viewportName}: browser HTTP aggregate`)
      await page.waitForFunction((count) =>
        document.querySelectorAll('article[data-project-id]').length === count, W34_FIXTURES.length)
      const cards = await readCards(page)
      assert.deepEqual(cards.map((card) => card.id), expectedOrder, `${viewportName}: card order`)
      for (const card of cards) {
        const name = W34_FIXTURES.find((item) => fixtures[item].projectId === card.id)
        assertCard(card, wants.get(name))
      }
      // The visible counters are computed from the loaded results only.
      const tiles = await readTiles(page)
      const bucketCounts = { draft: 0, processing: 0, review: 0, completed: 0 }
      for (const want of wants.values()) if (want.bucket in bucketCounts) bucketCounts[want.bucket] += 1
      assert.deepEqual(tiles.map((tile) => tile.value),
        [bucketCounts.draft, bucketCounts.processing, bucketCounts.review, bucketCounts.completed],
        `${viewportName}: tiles reflect only the loaded results`)
      const loadedTotal = tiles.reduce((sum, tile) => sum + tile.value, 0)
      const workspaceTotal = await client.v2Project.count({ where: { workspaceId } })
      assert.ok(workspaceTotal > W34_FIXTURES.length, 'the workspace holds projects beyond the filtered page')
      assert.ok(loadedTotal < workspaceTotal, `${viewportName}: visible counters (${loadedTotal}) must not be the workspace total (${workspaceTotal})`)
      const note = await page.getByText('Contagens dos resultados carregados', { exact: false }).textContent()
      assert.match(note, /Contagens dos resultados carregados\.$/)
      assert.doesNotMatch(note, /há mais páginas/)
      const layout = await layoutReport(page)
      assert.deepEqual(layout.findings, [], `${viewportName}: no card content may leave its card or be clipped`)
      assert.ok(layout.overflowPx <= 1, `${viewportName}: horizontal overflow ${layout.overflowPx}px`)
      assert.equal(layout.cardCount, W34_FIXTURES.length)
      evidence.screenshots.push(await screenshot(page, evidenceDir, shotName))
      observed[viewportName] = { cards, tiles, layout }
      evidence.requests[viewportName] = {
        projectGets: tracker.projectGets().length, mutating: tracker.mutating().length,
        methods: [...new Set(tracker.entries.map((entry) => entry.method))],
        requestCount: tracker.entries.length,
      }
      assert.equal(tracker.mutating().length, 0, `${viewportName}: the read-only dashboard must not mutate`)
      assert.ok(tracker.projectGets().length >= 1)
      await page.close()
      handles.page = undefined
    }
    evidence.tiles = observed.desktop.tiles
    evidence.counts.after = await databaseCounts(client, workspaceId)
    assert.deepEqual(evidence.counts.after, countsBefore, 'the aggregate proof must not change PostgreSQL state')
    for (const name of W34_FIXTURES) {
      const after = await readAggregateOracle(client, { workspaceId, projectId: fixtures[name].projectId })
      assert.deepEqual(after.expected, oracles[name].expected, `${name}: persisted aggregate drifted during the read-only window`)
      evidence.fixtures.push({
        name, projectId: fixtures[name].projectId, origins: fixtures[name].origins,
        ...(fixtures[name].director ? { director: fixtures[name].director } : {}),
        persisted: oracles[name].expected, project: oracles[name].project,
        api: apiById.get(fixtures[name].projectId).dashboard,
        card: { desktop: observed.desktop.cards.find((card) => card.id === fixtures[name].projectId),
          mobile: observed.mobile.cards.find((card) => card.id === fixtures[name].projectId) },
        expectedCard: wants.get(name),
      })
    }
    evidence.expectedOrder = expectedOrder
    evidence.browser.mutatingRequests = 0
    evidence.browser.mobileOverflowPx = observed.mobile.layout.overflowPx
    evidence.browser.desktopOverflowPx = observed.desktop.layout.overflowPx
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
    try { await writeManifest(evidenceDir, W34_MANIFEST, evidence) }
    catch (error) { cleanupErrors.push(`manifest:${error?.name ?? 'Error'}`) }
    if (cleanupErrors.length) throw new AggregateError(primaryError
      ? [primaryError, ...cleanupErrors.map((item) => new Error(item))]
      : cleanupErrors.map((item) => new Error(item)), 'W34 browser proof and/or cleanup failed')
  }
}
