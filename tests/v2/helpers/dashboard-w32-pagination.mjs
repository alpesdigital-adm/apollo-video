import assert from 'node:assert/strict'

import { PUBLIC_ERROR_CATALOG } from '../../../src/v2/public-api/public-error-catalog.ts'
import {
  EMPTY_FACETS, PAGE_LIMIT, assertSessionActive, awaitProjectsResponse, canonicalParams, cards, cardsOf,
  dashboardControls, databaseCounts, facetsApiParams, facetsUrlSearch, oracleProjects, readApplicationName,
  readControlValues, recordTraffic, runBrowserProof, sanitizeQuery, screenshot, sessionProjects, setControl,
  snapshotRows, waitForCards,
} from './dashboard-list-proof-common.mjs'

export const W32_SCHEMA = 'w32-dashboard-pagination/v1'
export const W32_MANIFEST = 'w32-manifest.json'
export const W32_SCOPE_LOCALE = 'qaa-w32'
export const W32_OWNER_A = 'w32-owner-a'
export const W32_OWNER_B = 'w32-owner-b'
export const W32_SCREENSHOTS = Object.freeze([
  'w32-desktop-first-page.png', 'w32-desktop-after-load-more.png', 'w32-mobile-after-load-more.png',
])

// Ascending createdAt offsets (minutes) of the 27 fixtures, oldest first. The
// two oldest-but-three share an instant, so the 24th and 25th rows of the
// descending listing tie on createdAt exactly where the first page ends; a
// second tie of three rows sits mid-list. Ids are zero-padded so their order
// is identical under any collation.
const OFFSETS = [0, 1, 2, 2, 3, 4, 5, 6, 7, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
const T0 = Date.parse('2026-03-01T10:00:00.000Z')
const pad = (value) => String(value).padStart(2, '0')
export const W32_FIXTURES = Object.freeze(OFFSETS.map((offset, index) => Object.freeze({
  id: `w32-p${pad(index)}`, name: `w32 projeto ${pad(index)}`, status: 'draft', objective: 'discovery',
  format: '9:16', locale: W32_SCOPE_LOCALE, ownerId: index < 3 ? W32_OWNER_B : W32_OWNER_A,
  createdAt: new Date(T0 + offset * 60_000).toISOString(),
})))
assert.equal(W32_FIXTURES.length, PAGE_LIMIT + 3)

const SCOPE = { ...EMPTY_FACETS, locale: W32_SCOPE_LOCALE }
const SCOPE_OWNER_A = { ...SCOPE, ownerId: W32_OWNER_A }
const SCOPE_OWNER_B = { ...SCOPE, ownerId: W32_OWNER_B }
const SCOPE_ZERO = { ...SCOPE, text: 'w32-nenhum-resultado' }
const errorContract = PUBLIC_ERROR_CATALOG.INVALID_ARGUMENT

const isProjectsUrl = (url) => url.pathname === '/v1/projects'
const LOAD_MORE = 'Carregar mais projetos'
const MORE_PAGES = /há mais páginas/
const EMPTY_TEXT = 'Nenhum projeto corresponde a esses filtros.'

export const W32_REQUIRED_UI = Object.freeze([
  'first-page-24-with-next-cursor', 'load-more-completes-27', 'reload-resets-to-first-page',
  'exactly-24-has-no-next-cursor', 'zero-results-without-progress',
  'controlled-filter-change-during-slow-first-page', 'controlled-filter-change-during-slow-load-more',
  'controlled-foreign-cursor-rejected-then-recovery', 'mobile-after-load-more',
])
export const W32_REQUIRED_HTTP = Object.freeze([
  'first-page', 'second-page-from-cursor', 'walk-limit-24', 'walk-limit-5', 'walk-limit-1',
  'owner-a-exactly-24', 'owner-b-three', 'zero-results',
  'cursor-other-filter-owner', 'cursor-other-filter-removed-locale', 'cursor-other-filter-text',
  'cursor-same-filter-accepted', 'cursor-malformed',
])

function decodeCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function assertNoInventedProgress(page, label) {
  assert.equal(await page.locator('[role="progressbar"]').count(), 0, `${label}: no progress bar for projects without operations`)
  const text = await page.locator('body').innerText()
  assert.doesNotMatch(text, /\d\s*%/, `${label}: no invented percentage`)
}

async function assertStableCards(page, expected, milliseconds, label) {
  const deadline = Date.now() + milliseconds
  let samples = 0
  while (Date.now() < deadline) {
    assert.deepEqual(await cards(page), expected, `${label}: cards changed while the stale answer was released`)
    samples += 1
    await new Promise((done) => setTimeout(done, 50))
  }
  return samples
}

async function createFixtures(client, workspaceId, creatorClientId) {
  const existing = await client.v2Project.count({ where: { workspaceId, id: { in: W32_FIXTURES.map((item) => item.id) } } })
  assert.equal(existing, 0, 'W32 fixtures must not pre-exist')
  await client.v2Project.createMany({
    data: W32_FIXTURES.map((item) => ({
      id: item.id, workspaceId, name: item.name, status: item.status, objective: item.objective,
      format: item.format, locale: item.locale, ownerId: item.ownerId,
      createdByType: 'api-client', createdById: creatorClientId,
      createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt),
    })),
  })
}

export async function proveW32Pagination({
  baseUrl, client, workspaceId, creatorClientId, sessionCookieName, sessionCookieValue, username,
}) {
  return runBrowserProof({
    wave: 'w32', runLabel: 'W32', schemaVersion: W32_SCHEMA, envVar: 'APOLLO_W32_EVIDENCE_DIR',
    manifestName: W32_MANIFEST,
    evidence: { workspaceId, fixtures: [], ties: {}, httpCases: [], uiCases: [], requests: [], responses: [] },
    async body({ evidence, evidenceDir, openContext }) {
      const session = { baseUrl, sessionCookieName, sessionCookieValue }
      await assertSessionActive({ baseUrl, workspaceId, sessionCookieName, sessionCookieValue, username })
      evidence.database = { applicationName: await readApplicationName(client) }

      await createFixtures(client, workspaceId, creatorClientId)
      evidence.fixtures = W32_FIXTURES.map(({ id, createdAt, ownerId, locale }) => ({ id, createdAt, ownerId, locale }))
      const allRowsBefore = await snapshotRows(client, workspaceId)
      const before = await databaseCounts(client, workspaceId)
      evidence.counts = { before }
      evidence.projectRowsBefore = allRowsBefore.map(({ id, name, status, createdAt }) => ({ id, name, status, createdAt }))

      // ---- Oracle: the expected sequence comes from createdAt/id in PostgreSQL.
      const scope = await oracleProjects(client, workspaceId, SCOPE)
      assert.deepEqual(scope.map((row) => row.id).sort(), W32_FIXTURES.map((item) => item.id).sort(),
        'the dedicated locale must select exactly the W32 fixtures')
      const scopeIds = scope.map((row) => row.id)
      const ownerA = await oracleProjects(client, workspaceId, SCOPE_OWNER_A)
      const ownerB = await oracleProjects(client, workspaceId, SCOPE_OWNER_B)
      assert.equal(ownerA.length, PAGE_LIMIT, 'owner A must hold exactly one full page')
      assert.equal(ownerB.length, 3)
      // Real createdAt ties, including the one that straddles the page boundary.
      const groups = new Map()
      for (const row of scope) {
        const key = row.createdAt.toISOString()
        groups.set(key, [...(groups.get(key) ?? []), row.id])
      }
      const tieGroups = [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([createdAt, ids]) => ({ createdAt, ids }))
      assert.ok(tieGroups.length >= 2, 'W32 needs real createdAt ties')
      assert.equal(scope[PAGE_LIMIT - 1].createdAt.getTime(), scope[PAGE_LIMIT].createdAt.getTime(), 'the tie must straddle the 24/25 boundary')
      assert.ok(scope[PAGE_LIMIT - 1].id > scope[PAGE_LIMIT].id, 'descending id order inside the tie')
      evidence.ties = { groups: tieGroups, boundary: { positions: [PAGE_LIMIT, PAGE_LIMIT + 1], ids: [scope[PAGE_LIMIT - 1].id, scope[PAGE_LIMIT].id], createdAt: scope[PAGE_LIMIT].createdAt.toISOString() } }
      evidence.expectedSequence = scopeIds

      // ---- HTTP phase before any page is opened.
      const http = (id, params, status, body, extra = {}) => evidence.httpCases.push({
        id, query: sanitizeQuery(new URLSearchParams(params)), status,
        ids: body.data?.projects?.map((project) => project.id) ?? null,
        hasNextCursor: typeof body.data?.nextCursor === 'string', errorCode: body.error?.code, ...extra,
      })
      const scopeParams = facetsApiParams(SCOPE)
      const firstPage = await sessionProjects(session, scopeParams)
      assert.equal(firstPage.status, 200)
      assert.deepEqual(firstPage.body.data.projects.map((project) => project.id), scopeIds.slice(0, PAGE_LIMIT))
      const cursorOne = firstPage.body.data.nextCursor
      assert.ok(cursorOne, 'a full first page of a 27-row result must carry a cursor')
      const decoded = decodeCursor(cursorOne)
      assert.equal(decoded.id, scope[PAGE_LIMIT - 1].id, 'cursor must point at the last row of the page')
      assert.equal(decoded.createdAt, scope[PAGE_LIMIT - 1].createdAt.toISOString())
      http('first-page', scopeParams, firstPage.status, firstPage.body)
      const secondPage = await sessionProjects(session, facetsApiParams(SCOPE, { after: cursorOne }))
      assert.equal(secondPage.status, 200)
      assert.deepEqual(secondPage.body.data.projects.map((project) => project.id), scopeIds.slice(PAGE_LIMIT))
      assert.equal(secondPage.body.data.nextCursor, undefined, 'the last page must not invent a cursor')
      http('second-page-from-cursor', facetsApiParams(SCOPE, { after: cursorOne }), secondPage.status, secondPage.body)

      const walk = async (limit) => {
        const walked = []
        let after
        let pages = 0
        do {
          const params = facetsApiParams(SCOPE, { limit, after })
          const response = await sessionProjects(session, params)
          assert.equal(response.status, 200, `walk ${limit}`)
          walked.push(...response.body.data.projects.map((project) => project.id))
          after = response.body.data.nextCursor
          pages += 1
          assert.ok(pages <= 40, 'walk must terminate')
        } while (after)
        assert.deepEqual(walked, scopeIds, `limit ${limit} walk must reproduce the PostgreSQL order`)
        assert.equal(new Set(walked).size, walked.length, `limit ${limit} walk must not duplicate rows`)
        evidence.httpCases.push({ id: `walk-limit-${limit}`, limit, pages, ids: walked, hasNextCursor: false })
      }
      await walk(24)
      await walk(5)
      await walk(1)

      const exact = await sessionProjects(session, facetsApiParams(SCOPE_OWNER_A))
      assert.equal(exact.status, 200)
      assert.deepEqual(exact.body.data.projects.map((project) => project.id), ownerA.map((row) => row.id))
      assert.equal(exact.body.data.nextCursor, undefined, 'exactly one full page must not carry a cursor')
      http('owner-a-exactly-24', facetsApiParams(SCOPE_OWNER_A), exact.status, exact.body)
      const small = await sessionProjects(session, facetsApiParams(SCOPE_OWNER_B))
      assert.deepEqual(small.body.data.projects.map((project) => project.id), ownerB.map((row) => row.id))
      assert.equal(small.body.data.nextCursor, undefined)
      http('owner-b-three', facetsApiParams(SCOPE_OWNER_B), small.status, small.body)
      const zero = await sessionProjects(session, facetsApiParams(SCOPE_ZERO))
      assert.equal(zero.status, 200)
      assert.deepEqual(zero.body.data.projects, [])
      assert.equal(zero.body.data.nextCursor, undefined)
      http('zero-results', facetsApiParams(SCOPE_ZERO), zero.status, zero.body)

      // A cursor is bound to its exact filter fingerprint (and workspace).
      const rejected = async (id, params) => {
        const response = await sessionProjects(session, params)
        assert.equal(response.status, errorContract.status, `${id}: status`)
        assert.equal(response.body.data, undefined, `${id}: no rows may leak from a mismatched cursor`)
        assert.equal(response.body.error.code, 'INVALID_ARGUMENT', id)
        assert.equal(response.body.error.category, errorContract.category, id)
        assert.equal(response.body.error.message, errorContract.message, id)
        assert.ok(response.body.error.requestId && response.headers.get('apollo-request-id'), id)
        http(id, params, response.status, response.body)
      }
      await rejected('cursor-other-filter-owner', facetsApiParams(SCOPE_OWNER_A, { after: cursorOne }))
      await rejected('cursor-other-filter-removed-locale', facetsApiParams(EMPTY_FACETS, { after: cursorOne }))
      await rejected('cursor-other-filter-text', facetsApiParams({ ...SCOPE, text: 'w32 projeto' }, { after: cursorOne }))
      const accepted = await sessionProjects(session, facetsApiParams(SCOPE, { after: cursorOne }))
      assert.equal(accepted.status, 200, 'the very same cursor is accepted with its own filters')
      http('cursor-same-filter-accepted', facetsApiParams(SCOPE, { after: cursorOne }), accepted.status, accepted.body)
      await rejected('cursor-malformed', facetsApiParams(SCOPE, { after: 'not-a-cursor!' }))
      assert.deepEqual(await databaseCounts(client, workspaceId), before, 'HTTP probing must not mutate PostgreSQL')

      // A cursor of another fingerprint that the browser will be forced to send.
      const foreign = await sessionProjects(session, facetsApiParams(SCOPE_OWNER_A, { limit: 5 }))
      assert.equal(foreign.status, 200)
      const foreignCursor = foreign.body.data.nextCursor
      assert.ok(foreignCursor && foreignCursor !== cursorOne)

      // ---- Browser phase.
      const anonymous = await openContext({ viewport: { width: 390, height: 844 } })
      const anonymousPage = await anonymous.newPage()
      await anonymousPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      assert.equal(new URL(anonymousPage.url()).pathname, '/login')
      await anonymous.close()

      const context = await openContext({ viewport: { width: 1440, height: 1000 } })
      await context.addCookies([{ name: sessionCookieName, value: sessionCookieValue, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
      const page = await context.newPage()
      const traffic = recordTraffic(page, baseUrl)
      const failures = []
      page.on('requestfailed', (request) => {
        const url = new URL(request.url())
        if (url.pathname === '/v1/projects') failures.push({ query: sanitizeQuery(url.searchParams), errorText: request.failure()?.errorText ?? null })
      })
      const controls = dashboardControls(page)
      const trafficStart = traffic.mark()
      const urlSearch = () => new URL(page.url()).search
      const loadMoreButton = () => page.getByRole('button', { name: LOAD_MORE })
      const rows = (list) => list.map((row) => row.id)
      const cardsFor = (list) => cardsOf(list)

      const state = async (id, extra = {}) => evidence.uiCases.push({
        id, url: urlSearch(), cardIds: (await cards(page)).map((card) => card.id), ...extra,
      })
      const open = async (facets, action) => {
        const expected = facets === SCOPE ? scope : facets === SCOPE_OWNER_A ? ownerA : facets === SCOPE_OWNER_B ? ownerB : await oracleProjects(client, workspaceId, facets)
        const first = expected.slice(0, PAGE_LIMIT)
        const answered = awaitProjectsResponse(page, facetsApiParams(facets), rows(first))
        await action()
        const result = await answered
        await waitForCards(page, cardsFor(first))
        await page.waitForFunction((value) => location.search === value, facetsUrlSearch(facets))
        return { expected, first, ...result }
      }

      // 1. First page of 24 + nextCursor + "Carregar mais".
      const firstState = await open(SCOPE, () => page.goto(`${baseUrl}/${facetsUrlSearch(SCOPE)}`, { waitUntil: 'domcontentloaded' }))
      assert.equal(typeof firstState.body.data.nextCursor, 'string')
      assert.equal(firstState.first.length, PAGE_LIMIT)
      await loadMoreButton().waitFor()
      await page.getByText(MORE_PAGES).waitFor()
      await assertNoInventedProgress(page, 'first page')
      evidence.screenshots.push(await screenshot(page, evidenceDir, W32_SCREENSHOTS[0]))
      await state('first-page-24-with-next-cursor', {
        request: sanitizeQuery(new URL(firstState.response.url()).searchParams), status: firstState.response.status(),
        responseIds: firstState.body.data.projects.map((project) => project.id), expectedIds: rows(firstState.first),
        hasNextCursor: true, loadMoreVisible: true, nextCursorMatchesHttp: firstState.body.data.nextCursor === cursorOne,
      })

      // 2. Carregar mais -> the remaining three, no duplicate, no gap.
      const moreParams = facetsApiParams(SCOPE, { after: firstState.body.data.nextCursor })
      const moreAnswered = awaitProjectsResponse(page, moreParams, scopeIds.slice(PAGE_LIMIT))
      await loadMoreButton().click()
      const more = await moreAnswered
      await waitForCards(page, cardsFor(scope))
      await loadMoreButton().waitFor({ state: 'detached' })
      assert.equal(await page.getByText(MORE_PAGES).count(), 0, 'no further pages announced')
      assert.equal(new Set((await cards(page)).map((card) => card.id)).size, W32_FIXTURES.length)
      await assertNoInventedProgress(page, 'after load more')
      evidence.screenshots.push(await screenshot(page, evidenceDir, W32_SCREENSHOTS[1]))
      await state('load-more-completes-27', {
        request: sanitizeQuery(new URL(more.response.url()).searchParams), status: more.response.status(),
        responseIds: more.body.data.projects.map((project) => project.id), expectedIds: scopeIds.slice(PAGE_LIMIT),
        expectedSequence: scopeIds, hasNextCursor: false, loadMoreVisible: false,
      })

      // 3. Reload: filters persist, pagination does not; order is still the oracle's.
      const reloaded = await open(SCOPE, () => page.reload({ waitUntil: 'domcontentloaded' }))
      await loadMoreButton().waitFor()
      await state('reload-resets-to-first-page', {
        request: sanitizeQuery(new URL(reloaded.response.url()).searchParams), status: reloaded.response.status(),
        responseIds: reloaded.body.data.projects.map((project) => project.id), expectedIds: rows(reloaded.first),
        hasNextCursor: typeof reloaded.body.data.nextCursor === 'string', loadMoreVisible: true,
      })

      // 4. Exactly one full page: no cursor and no button.
      const exactState = await open(SCOPE_OWNER_A, () => setControl(page, 'ownerId', W32_OWNER_A))
      assert.equal(exactState.body.data.nextCursor, undefined)
      assert.equal(await loadMoreButton().count(), 0)
      assert.equal(await page.getByText(MORE_PAGES).count(), 0)
      await assertNoInventedProgress(page, 'exactly one page')
      await state('exactly-24-has-no-next-cursor', {
        request: sanitizeQuery(new URL(exactState.response.url()).searchParams), status: exactState.response.status(),
        responseIds: exactState.body.data.projects.map((project) => project.id), expectedIds: rows(exactState.first),
        hasNextCursor: false, loadMoreVisible: false,
      })

      // 5. Zero results: no rows, no button, no progress.
      const zeroUi = { ...SCOPE_OWNER_A, text: SCOPE_ZERO.text }
      const zeroState = await open(zeroUi, () => setControl(page, 'text', zeroUi.text))
      await page.getByText(EMPTY_TEXT).waitFor()
      assert.equal(await loadMoreButton().count(), 0)
      assert.equal(await page.getByText(MORE_PAGES).count(), 0)
      await assertNoInventedProgress(page, 'zero results')
      assert.deepEqual(await readControlValues(page), { ...EMPTY_FACETS, ...zeroUi })
      await state('zero-results-without-progress', {
        request: sanitizeQuery(new URL(zeroState.response.url()).searchParams), status: zeroState.response.status(),
        responseIds: [], expectedIds: [], hasNextCursor: false, loadMoreVisible: false,
      })

      // 6. CONTROLLED race: the first-page answer of the previous filter is held
      //    by the test (Playwright route), the filter changes, then the stale
      //    answer is released. This is a controlled interleaving, not a natural race.
      await open(SCOPE, () => page.goto(`${baseUrl}/${facetsUrlSearch(SCOPE)}`, { waitUntil: 'domcontentloaded' }))
      {
        const held = { seen: deferred(), release: deferred(), query: null, fulfilled: null }
        await page.route(isProjectsUrl, async (route) => {
          const url = new URL(route.request().url())
          if (url.searchParams.get('ownerId') !== W32_OWNER_B) { await route.continue(); return }
          held.query = sanitizeQuery(url.searchParams)
          held.seen.resolve()
          let upstream = null
          try { upstream = await route.fetch() } catch { upstream = null }
          await held.release.promise
          try { if (upstream) { await route.fulfill({ response: upstream }); held.fulfilled = true } else held.fulfilled = false }
          catch { held.fulfilled = false }
        })
        const failuresBefore = failures.length
        try {
          await setControl(page, 'ownerId', W32_OWNER_B)
          await held.seen.promise
          const newer = awaitProjectsResponse(page, facetsApiParams(SCOPE_OWNER_A), rows(ownerA))
          await setControl(page, 'ownerId', W32_OWNER_A)
          const answered = await newer
          await waitForCards(page, cardsFor(ownerA))
          held.release.resolve()
          const samples = await assertStableCards(page, cardsFor(ownerA), 1200, 'slow first page')
          assert.equal(new URL(page.url()).search, facetsUrlSearch(SCOPE_OWNER_A))
          assert.equal((await readControlValues(page)).ownerId, W32_OWNER_A)
          assert.ok(!(await cards(page)).some((card) => rows(ownerB).includes(card.id)), 'the stale owner-B rows must never render')
          await state('controlled-filter-change-during-slow-first-page', {
            controlled: true, staleFilter: { ownerId: W32_OWNER_B }, staleRequest: held.query,
            staleRequestFailures: failures.slice(failuresBefore), staleAnswerReleased: true, staleAnswerFulfilled: held.fulfilled,
            staleExpectedIds: rows(ownerB), request: sanitizeQuery(new URL(answered.response.url()).searchParams),
            status: answered.response.status(), responseIds: answered.body.data.projects.map((project) => project.id),
            expectedIds: rows(ownerA), stableSamples: samples,
          })
        } finally {
          held.release.resolve()
          await page.unroute(isProjectsUrl).catch(() => {})
        }
      }

      // 7. CONTROLLED race: "Carregar mais" is pending, the filter changes, the
      //    stale second page is released afterwards and must not be appended.
      await open(SCOPE, () => page.goto(`${baseUrl}/${facetsUrlSearch(SCOPE)}`, { waitUntil: 'domcontentloaded' }))
      {
        const held = { seen: deferred(), release: deferred(), query: null, fulfilled: null }
        const handler = async (route) => {
          const url = new URL(route.request().url())
          if (!url.searchParams.has('after')) { await route.continue(); return }
          held.query = sanitizeQuery(url.searchParams)
          held.seen.resolve()
          let upstream = null
          try { upstream = await route.fetch() } catch { upstream = null }
          await held.release.promise
          try { if (upstream) { await route.fulfill({ response: upstream }); held.fulfilled = true } else held.fulfilled = false }
          catch { held.fulfilled = false }
        }
        await page.route(isProjectsUrl, handler)
        const failuresBefore = failures.length
        try {
          await loadMoreButton().click()
          await held.seen.promise
          await page.getByRole('button', { name: 'Carregando…' }).waitFor()
          const newer = awaitProjectsResponse(page, facetsApiParams(SCOPE_OWNER_A), rows(ownerA))
          await setControl(page, 'ownerId', W32_OWNER_A)
          const answered = await newer
          await waitForCards(page, cardsFor(ownerA))
          held.release.resolve()
          const samples = await assertStableCards(page, cardsFor(ownerA), 1200, 'slow load more')
          const staleRows = scopeIds.slice(PAGE_LIMIT)
          assert.ok(!(await cards(page)).some((card) => staleRows.includes(card.id)), 'the stale second page must never be appended')
          await state('controlled-filter-change-during-slow-load-more', {
            controlled: true, staleRequest: held.query, staleRequestFailures: failures.slice(failuresBefore),
            staleAnswerReleased: true, staleAnswerFulfilled: held.fulfilled, staleExpectedIds: staleRows,
            request: sanitizeQuery(new URL(answered.response.url()).searchParams), status: answered.response.status(),
            responseIds: answered.body.data.projects.map((project) => project.id), expectedIds: rows(ownerA), stableSamples: samples,
          })
        } finally {
          held.release.resolve()
          await page.unroute(isProjectsUrl).catch(() => {})
        }
      }

      // 8. CONTROLLED: the browser is made to send a cursor of another filter
      //    fingerprint; the contract rejects it, the UI keeps its rows and a
      //    legitimate "Carregar mais" still works afterwards.
      const afterForeign = await open(SCOPE, () => page.goto(`${baseUrl}/${facetsUrlSearch(SCOPE)}`, { waitUntil: 'domcontentloaded' }))
      {
        const rewritten = { queries: [] }
        const handler = async (route) => {
          const url = new URL(route.request().url())
          if (!url.searchParams.has('after')) { await route.continue(); return }
          url.searchParams.set('after', foreignCursor)
          rewritten.queries.push(sanitizeQuery(url.searchParams))
          await route.continue({ url: url.toString() })
        }
        await page.route(isProjectsUrl, handler)
        try {
          const rejectedAnswer = page.waitForResponse((response) => {
            const url = new URL(response.url())
            return url.pathname === '/v1/projects' && url.searchParams.get('after') === foreignCursor
          })
          await loadMoreButton().click()
          const response = await rejectedAnswer
          const body = await response.json()
          assert.equal(response.status(), errorContract.status)
          assert.equal(body.error.code, 'INVALID_ARGUMENT')
          assert.equal(body.data, undefined)
          await page.getByText(errorContract.message, { exact: true }).waitFor()
          assert.deepEqual(await cards(page), cardsFor(afterForeign.first), 'a rejected cursor must not change the rows')
          await loadMoreButton().waitFor()
          await page.unroute(isProjectsUrl, handler)
          const recoveredAnswer = awaitProjectsResponse(page, facetsApiParams(SCOPE, { after: afterForeign.body.data.nextCursor }), scopeIds.slice(PAGE_LIMIT))
          await loadMoreButton().click()
          const recovered = await recoveredAnswer
          await waitForCards(page, cardsFor(scope))
          await state('controlled-foreign-cursor-rejected-then-recovery', {
            controlled: true, rewrittenRequests: rewritten.queries, rejectedStatus: response.status(), rejectedCode: body.error.code,
            noticeShown: errorContract.message, cardsKeptDuringRejection: rows(afterForeign.first),
            request: sanitizeQuery(new URL(recovered.response.url()).searchParams), status: recovered.response.status(),
            responseIds: recovered.body.data.projects.map((project) => project.id), expectedIds: scopeIds.slice(PAGE_LIMIT),
          })
        } finally {
          await page.unroute(isProjectsUrl, handler).catch(() => {})
        }
      }

      // 9. Mobile, same list after "Carregar mais".
      await page.setViewportSize({ width: 390, height: 844 })
      const mobileFirst = await open(SCOPE, () => page.goto(`${baseUrl}/${facetsUrlSearch(SCOPE)}`, { waitUntil: 'domcontentloaded' }))
      const mobileMore = awaitProjectsResponse(page, facetsApiParams(SCOPE, { after: mobileFirst.body.data.nextCursor }), scopeIds.slice(PAGE_LIMIT))
      await loadMoreButton().click()
      const mobileAnswer = await mobileMore
      await waitForCards(page, cardsFor(scope))
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      evidence.browser.mobileOverflowPx = overflow
      evidence.screenshots.push(await screenshot(page, evidenceDir, W32_SCREENSHOTS[2]))
      assert.ok(overflow <= 1, `W32 mobile overflows by ${overflow}px`)
      await state('mobile-after-load-more', {
        request: sanitizeQuery(new URL(mobileAnswer.response.url()).searchParams), status: mobileAnswer.response.status(),
        responseIds: mobileAnswer.body.data.projects.map((project) => project.id), expectedIds: scopeIds.slice(PAGE_LIMIT),
        hasNextCursor: false,
      })

      // ---- Read-only guarantees.
      assert.equal(traffic.mutating(trafficStart).length, 0, 'pagination must not mutate HTTP state')
      evidence.browser.mutatingRequests = 0
      evidence.requests = traffic.projectGets(trafficStart)
      assert.ok(evidence.requests.every((request) => request.method === 'GET'))
      evidence.responses = (await traffic.responses()).filter((item) => item.status === 200 || item.status === errorContract.status)
      assert.ok(evidence.responses.some((item) => item.status === errorContract.status && item.errorCode === 'INVALID_ARGUMENT'))
      evidence.counts.after = await databaseCounts(client, workspaceId)
      assert.deepEqual(evidence.counts.after, before, 'pagination must not mutate PostgreSQL counters')
      const allRowsAfter = await snapshotRows(client, workspaceId)
      assert.deepEqual(allRowsAfter, allRowsBefore, 'pagination must not change any persisted project')
      evidence.projectRowsAfter = allRowsAfter.map(({ id, name, status, createdAt }) => ({ id, name, status, createdAt }))
      evidence.canonicalScopeQuery = canonicalParams(scopeParams)
    },
  })
}
