import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(label, check, budget = 30000) {
  const end = Date.now() + budget
  while (Date.now() < end) {
    const result = await check()
    if (result) return result
    await delay(50)
  }
  assert.fail(`W36 timed out: ${label}`)
}

/** Observe the real worker journey from a separate, already authenticated dashboard. */
export async function createDashboardPipelineObserver({ page, client, baseUrl, workspaceId, evidenceDir }) {
  const evidence = { schemaVersion: 'w36-pipeline-feed/v1', sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null,
    workspaceId, startedAt: new Date().toISOString(), feed: [], projects: [], cases: [], screenshots: [], navigationCount: 0,
    requests: [], failedRequests: [], checkpoints: [], outcome: 'started' }
  await mkdir(evidenceDir, { recursive: true })
  async function checkpoint(reason, error) {
    const visibilityState = await page.evaluate(() => document.visibilityState).catch(() => 'unavailable')
    const expectedIds = evidence.currentCase?.eventIds ?? []
    const deliveredIds = new Set(evidence.feed.flatMap((entry) => entry.events.map((event) => event.id)))
    evidence.checkpoints.push({ at: Date.now(), reason, visibilityState,
      queryCounts: { feed: evidence.requests.filter((entry) => entry.path === '/v1/events/feed').length,
        projects: evidence.requests.filter((entry) => entry.path === '/v1/projects').length },
      missingEventIds: expectedIds.filter((id) => !deliveredIds.has(id)),
      ...(error ? { error: String(error.message ?? error) } : {}) })
    await writeFile(join(evidenceDir, 'w36-pipeline-feed.json'), JSON.stringify(evidence, null, 2))
    return visibilityState
  }
  async function waitFor(label, check, budget) {
    try { return await until(label, check, budget) }
    catch (error) { await checkpoint(`timeout:${label}`, error); throw error }
  }
  let marked = false
  const onNavigation = (frame) => { if (marked && frame === page.mainFrame()) evidence.navigationCount += 1 }
  const onResponse = (response) => {
    const url = new URL(response.url())
    if (url.origin !== baseUrl || !['/v1/events/feed', '/v1/projects'].includes(url.pathname)) return
    const at = Date.now()
    void response.json().then((body) => {
      if (url.pathname === '/v1/events/feed') evidence.feed.push({ at, status: response.status(),
        errorCode: body.error?.code ?? null,
        hadCursor: url.searchParams.has('after'), hasMore: body.data?.hasMore,
        events: (body.data?.events ?? []).map((event) => ({ id: event.id, type: event.type, workspaceId: event.workspaceId,
          resource: event.resource, projectId: event.data?.projectId, phase: event.data?.phase, progress: event.data?.progress })) })
      else evidence.projects.push({ at, status: response.status(), errorCode: body.error?.code ?? null, projects: body.data?.projects ?? [] })
    }).catch(() => {
      if (url.pathname === '/v1/events/feed') evidence.feed.push({ at, status: response.status(), errorCode: 'BODY_PARSE_FAILED', events: [] })
    })
  }
  const onRequest = (request) => {
    const url = new URL(request.url())
    if (url.origin === baseUrl && ['/v1/events/feed', '/v1/projects'].includes(url.pathname))
      evidence.requests.push({ at: Date.now(), path: url.pathname, hadCursor: url.searchParams.has('after') })
  }
  const onRequestFailed = (request) => {
    const url = new URL(request.url())
    if (url.origin === baseUrl && ['/v1/events/feed', '/v1/projects'].includes(url.pathname))
      evidence.failedRequests.push({ at: Date.now(), path: url.pathname, error: request.failure()?.errorText ?? 'unknown' })
  }
  page.on('response', onResponse)
  page.on('request', onRequest)
  page.on('requestfailed', onRequestFailed)
  page.on('framenavigated', onNavigation)
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await waitFor('dashboard cursor bootstrap', () => evidence.feed.some((entry) => entry.status === 200))
  marked = true
  await checkpoint('bootstrap')
  return {
    async observe({ stage, projectId, operationId, annotationId, expectedEventTypes = [], expectedState }) {
      const resourceId = annotationId ?? operationId ?? projectId
      const start = Date.now()
      evidence.currentCase = { stage, projectId, resourceId, startedAt: start, eventIds: [] }
      try {
      const visibilityBefore = await checkpoint(`observe-start:${stage}`)
      if (visibilityBefore === 'hidden') {
        // A real user returning to this dashboard restores the production
        // visibility policy. The other proof page may have taken foreground.
        await page.bringToFront()
        await waitFor(`${stage}: dashboard visible`, async () => await page.evaluate(() => document.visibilityState) === 'visible')
        await checkpoint(`foreground-restored:${stage}`)
      }
      const rows = await client.v2PublicEventOutbox.findMany({ where: { workspaceId, resourceId,
        ...(expectedEventTypes.length ? { type: { in: expectedEventTypes } } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      assert.ok(rows.length, `${stage}: runtime published an outbox event`)
      const ids = new Set(rows.map((row) => row.id))
      evidence.currentCase.eventIds = [...ids]
      await checkpoint(`outbox-read:${stage}`)
      const observed = await waitFor(`${stage}: persisted events arrive over HTTP`, () => {
        const delivered = evidence.feed.flatMap((entry) => entry.events)
        return rows.every((row) => delivered.some((event) => event.id === row.id)) && delivered
      })
      for (const event of observed.filter((event) => ids.has(event.id))) {
        assert.equal(event.workspaceId, workspaceId)
        assert.equal(event.resource.id, resourceId)
        if (operationId || annotationId) assert.equal(event.projectId, projectId)
      }
      const feedAt = Math.max(...evidence.feed.filter((entry) => entry.events.some((event) => ids.has(event.id))).map((entry) => entry.at))
      const refetch = await waitFor(`${stage}: dashboard refetches authoritative API`, () =>
        evidence.projects.findLast((entry) => entry.status === 200 && entry.at >= feedAt && entry.projects.some((project) => project.id === projectId)))
      const projected = refetch.projects.find((project) => project.id === projectId)
      if (expectedState) assert.equal(projected.visibleState.label, expectedState)
      if (operationId && !annotationId) {
        const persisted = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })
        const projection = projected.dashboard.latestOperation
        assert.equal(persisted.workspaceId, workspaceId)
        assert.equal(persisted.projectId, projectId)
        assert.equal(projection.id, operationId, `${stage}: API identifies the actual worker operation`)
        assert.equal(projection.status, persisted.status)
        assert.equal(projection.phase, persisted.phase)
        assert.deepEqual(projection.progress ?? null, persisted.progressCompleted === null ? null : {
          completed: persisted.progressCompleted,
          ...(persisted.progressTotal === null ? {} : { total: persisted.progressTotal }),
          ...(persisted.progressUnit === null ? {} : { unit: persisted.progressUnit }),
        }, `${stage}: API progress equals committed worker state`)
      }
      await waitFor(`${stage}: card matches API`, async () => {
        const card = page.locator(`article[data-project-id="${projectId}"]`)
        return await card.count() === 1 && await card.locator('[data-state]').getAttribute('data-state') === projected.visibleState.label
      })
      const card = page.locator(`article[data-project-id="${projectId}"]`)
      const progress = projected.dashboard.latestOperation?.progress
      if (progress?.total) {
        const percentage = Math.min(100, Math.floor(progress.completed * 100 / progress.total))
        await waitFor(`${stage}: measured progress matches API`, async () =>
          await card.getByRole('progressbar').getAttribute('aria-valuenow') === String(percentage))
        assert.equal(await card.getByRole('progressbar').getAttribute('aria-valuemax'), '100')
      } else {
        assert.equal(await card.getByRole('progressbar').count(), 0, 'no percentage without a persisted total')
      }
      const name = `w36-${String(evidence.cases.length + 1).padStart(2, '0')}.png`
      await page.screenshot({ path: join(evidenceDir, name), fullPage: true })
      const bytes = await readFile(join(evidenceDir, name))
      evidence.screenshots.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') })
      evidence.cases.push({ stage, projectId, resourceId, eventIds: [...ids], eventTypes: rows.map((row) => row.type),
        persistedRows: rows.map((row) => ({ id: row.id, type: row.type, workspaceId: row.workspaceId,
          createdAt: row.createdAt.toISOString(), occurredAt: row.occurredAt.toISOString() })),
        startedAt: start, feedAt, refetchAt: refetch.at, latencyMs: Date.now() - start,
        state: projected.visibleState.label, progress: projected.dashboard.latestOperation?.progress ?? null })
      evidence.currentCase = null
      await checkpoint(`observe-passed:${stage}`)
      } catch (error) {
        evidence.outcome = 'failed'
        await checkpoint(`observe-failed:${stage}`, error)
        throw error
      }
    },
    async finish() {
      assert.equal(evidence.navigationCount, 0, 'dashboard updates without reload/navigation')
      assert.ok(evidence.cases.some((entry) => entry.eventTypes.includes('operation.status.changed')))
      assert.ok(evidence.cases.some((entry) => entry.eventTypes.includes('operation.progress.changed')))
      assert.ok(evidence.cases.some((entry) => entry.eventTypes.includes('annotation.created')))
      assert.ok(evidence.cases.some((entry) => entry.eventTypes.includes('annotation.resolved')))
      assert.ok(evidence.cases.some((entry) => entry.eventTypes.includes('project.created')))
      const deliveredTypes = new Set(evidence.feed.flatMap((entry) => entry.events.map((event) => event.type)))
      for (const type of ['operation.status.changed', 'operation.progress.changed', 'operation.succeeded', 'operation.failed', 'annotation.created', 'annotation.resolved', 'project.created'])
        assert.ok(deliveredTypes.has(type), `${type} must arrive from the runtime outbox over HTTP`)
      assert.ok(evidence.feed.every((entry) => entry.events.every((event) => event.workspaceId === workspaceId)))
      evidence.outcome = 'passed'
      await writeFile(join(evidenceDir, 'w36-pipeline-feed.json'), JSON.stringify(evidence, null, 2))
      page.off('response', onResponse)
      page.off('request', onRequest)
      page.off('requestfailed', onRequestFailed)
      page.off('framenavigated', onNavigation)
      return evidence
    },
  }
}
