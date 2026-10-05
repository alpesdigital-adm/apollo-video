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
  const evidence = { schemaVersion: 'w36-pipeline-feed/v1', sourceCommit: process.env.GITHUB_SHA ?? null,
    workspaceId, startedAt: new Date().toISOString(), feed: [], projects: [], cases: [], screenshots: [], navigationCount: 0 }
  let marked = false
  const onNavigation = (frame) => { if (marked && frame === page.mainFrame()) evidence.navigationCount += 1 }
  const onResponse = (response) => {
    const url = new URL(response.url())
    if (url.origin !== baseUrl || !['/v1/events/feed', '/v1/projects'].includes(url.pathname)) return
    void response.json().then((body) => {
      const at = Date.now()
      if (url.pathname === '/v1/events/feed') evidence.feed.push({ at, status: response.status(),
        hadCursor: url.searchParams.has('after'), hasMore: body.data?.hasMore,
        events: (body.data?.events ?? []).map((event) => ({ id: event.id, type: event.type, workspaceId: event.workspaceId,
          resource: event.resource, projectId: event.data?.projectId, phase: event.data?.phase, progress: event.data?.progress })) })
      else evidence.projects.push({ at, status: response.status(), projects: body.data?.projects ?? [] })
    }).catch(() => undefined)
  }
  page.on('response', onResponse)
  page.on('framenavigated', onNavigation)
  await page.goto(baseUrl)
  await until('dashboard cursor bootstrap', () => evidence.feed.some((entry) => entry.status === 200))
  marked = true
  await mkdir(evidenceDir, { recursive: true })
  return {
    async observe({ stage, projectId, operationId, annotationId, expectedEventTypes = [], expectedState }) {
      const resourceId = annotationId ?? operationId ?? projectId
      const start = Date.now()
      const rows = await client.v2PublicEventOutbox.findMany({ where: { workspaceId, resourceId,
        ...(expectedEventTypes.length ? { type: { in: expectedEventTypes } } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      assert.ok(rows.length, `${stage}: runtime published an outbox event`)
      const ids = new Set(rows.map((row) => row.id))
      const observed = await until(`${stage}: persisted events arrive over HTTP`, () => {
        const delivered = evidence.feed.flatMap((entry) => entry.events)
        return rows.every((row) => delivered.some((event) => event.id === row.id)) && delivered
      })
      for (const event of observed.filter((event) => ids.has(event.id))) {
        assert.equal(event.workspaceId, workspaceId)
        assert.equal(event.resource.id, resourceId)
        if (operationId || annotationId) assert.equal(event.projectId, projectId)
      }
      const feedAt = Math.max(...evidence.feed.filter((entry) => entry.events.some((event) => ids.has(event.id))).map((entry) => entry.at))
      const refetch = await until(`${stage}: dashboard refetches authoritative API`, () =>
        evidence.projects.findLast((entry) => entry.status === 200 && entry.at >= feedAt && entry.projects.some((project) => project.id === projectId)))
      const projected = refetch.projects.find((project) => project.id === projectId)
      if (expectedState) assert.equal(projected.visibleState.label, expectedState)
      await until(`${stage}: card matches API`, async () => {
        const card = page.locator(`article[data-project-id="${projectId}"]`)
        return await card.count() === 1 && await card.locator('[data-state]').getAttribute('data-state') === projected.visibleState.label
      })
      const name = `w36-${String(evidence.cases.length + 1).padStart(2, '0')}.png`
      await page.screenshot({ path: join(evidenceDir, name), fullPage: true })
      const bytes = await readFile(join(evidenceDir, name))
      evidence.screenshots.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') })
      evidence.cases.push({ stage, projectId, resourceId, eventIds: [...ids], eventTypes: rows.map((row) => row.type),
        startedAt: start, feedAt, refetchAt: refetch.at, latencyMs: Date.now() - start,
        state: projected.visibleState.label, progress: projected.dashboard.latestOperation?.progress ?? null })
    },
    async finish() {
      assert.equal(evidence.navigationCount, 0, 'dashboard updates without reload/navigation')
      assert.ok(evidence.cases.some((entry) => entry.eventTypes.includes('operation.status.changed')))
      assert.ok(evidence.cases.some((entry) => entry.eventTypes.includes('operation.progress.changed')))
      assert.ok(evidence.cases.some((entry) => entry.eventTypes.includes('annotation.created')))
      assert.ok(evidence.cases.some((entry) => entry.eventTypes.includes('project.created')))
      assert.ok(evidence.feed.every((entry) => entry.events.every((event) => event.workspaceId === workspaceId)))
      evidence.outcome = 'passed'
      await writeFile(join(evidenceDir, 'w36-pipeline-feed.json'), JSON.stringify(evidence, null, 2))
      page.off('response', onResponse)
      page.off('framenavigated', onNavigation)
      return evidence
    },
  }
}
