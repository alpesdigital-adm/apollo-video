import assert from 'node:assert/strict'

import { PUBLIC_ERROR_CATALOG } from '../../../src/v2/public-api/public-error-catalog.ts'
import {
  EMPTY_FACETS, FACET_KEYS, PAGE_LIMIT, assertSessionActive, awaitProjectsResponse, cards, cardsOf,
  dashboardControls, databaseCounts, facetsApiParams, facetsUrlSearch, oracleProjects,
  readApplicationName, readControlValues, recordTraffic, runBrowserProof, sanitizeQuery,
  screenshot, sessionProjects, setControl, snapshotRows, waitForCards,
} from './dashboard-list-proof-common.mjs'

export const W31_SCHEMA = 'w31-dashboard-combined-filters/v1'
export const W31_MANIFEST = 'w31-manifest.json'

const OWNER_A = 'w31-owner-ana'
const OWNER_B = 'w31-owner-bia'
const DAY = '2026-02-10'

const base = {
  status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', ownerId: OWNER_A,
}
// Each "other-*" fixture differs from the anchor in exactly one facet, so every
// facet is individually load-bearing inside the eight-way conjunction.
export const W31_FIXTURES = Object.freeze([
  { id: 'w31-anchor', name: 'w31-alfa anchor', createdAt: `${DAY}T12:00:00.000Z`, ...base },
  { id: 'w31-edge-start', name: 'w31-alfa edge start', createdAt: `${DAY}T00:00:00.000Z`, ...base },
  { id: 'w31-edge-end', name: 'w31-alfa edge end', createdAt: `${DAY}T23:59:59.999Z`, ...base },
  { id: 'w31-day-before', name: 'w31-alfa day before', createdAt: '2026-02-09T23:59:59.999Z', ...base },
  { id: 'w31-day-after', name: 'w31-alfa day after', createdAt: '2026-02-11T00:00:00.000Z', ...base },
  { id: 'w31-other-owner', name: 'w31-alfa other owner', createdAt: `${DAY}T12:00:00.001Z`, ...base, ownerId: OWNER_B },
  { id: 'w31-other-locale', name: 'w31-alfa other locale', createdAt: `${DAY}T11:00:00.000Z`, ...base, locale: 'en-US' },
  { id: 'w31-other-format', name: 'w31-alfa other format', createdAt: `${DAY}T10:00:00.000Z`, ...base, format: '16:9' },
  { id: 'w31-other-objective', name: 'w31-alfa other objective', createdAt: `${DAY}T09:00:00.000Z`, ...base, objective: 'sale' },
  { id: 'w31-other-status', name: 'w31-alfa other status', createdAt: `${DAY}T08:00:00.000Z`, ...base, status: 'canceled' },
  { id: 'w31-other-text', name: 'w31-zeta other text', createdAt: `${DAY}T13:00:00.000Z`, ...base },
])

const facets = (overrides) => ({ ...EMPTY_FACETS, ...overrides })
const ALL_EIGHT = facets({
  text: 'w31-alfa', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR',
  createdFrom: DAY, createdTo: DAY, ownerId: OWNER_A,
})
const withoutDates = { ...ALL_EIGHT, createdFrom: '', createdTo: '' }

// id -> [facets, exact fixture ids that must appear, in order, or null when the
// case is only compared to the oracle]. Text-scoped cases are exact; the
// individual-facet cases also see the baseline projects and are oracle-only
// plus a membership floor.
export const W31_UI_CASES = Object.freeze([
  ['individual-text', facets({ text: 'w31-alfa' }), ['w31-edge-end'], 10],
  ['individual-status', facets({ status: 'canceled' }), ['w31-other-status'], 1],
  ['individual-objective', facets({ objective: 'sale' }), ['w31-other-objective'], 1],
  ['individual-format', facets({ format: '16:9' }), ['w31-other-format'], 1],
  ['individual-locale', facets({ locale: 'en-US' }), ['w31-other-locale'], 1],
  ['individual-created-from', facets({ createdFrom: DAY }), ['w31-anchor'], 9],
  ['individual-created-to', facets({ createdTo: DAY }), ['w31-anchor'], 9],
  ['individual-owner', facets({ ownerId: OWNER_B }), ['w31-other-owner'], 1],
  ['six-facets-without-dates', withoutDates,
    ['w31-day-after', 'w31-edge-end', 'w31-anchor', 'w31-edge-start', 'w31-day-before'], 5],
  ['dates-only', facets({ createdFrom: DAY, createdTo: DAY }), ['w31-anchor'], 9],
  ['all-eight', ALL_EIGHT, ['w31-edge-end', 'w31-anchor', 'w31-edge-start'], 3],
  ['zero-owner-and-locale-conflict', { ...ALL_EIGHT, ownerId: OWNER_B, locale: 'en-US' }, [], 0],
  ['zero-day-without-projects', { ...ALL_EIGHT, createdFrom: '2026-02-12', createdTo: '2026-02-12' }, [], 0],
  ['zero-individual-owner', facets({ ownerId: 'w31-owner-nobody' }), [], 0],
])
export const W31_PERSISTENCE_STEPS = Object.freeze([
  'all-eight-reload', 'all-eight-session-fallback', 'explicit-url-over-session',
  'explicit-url-updated-session-fallback', 'explicit-url-all-eight',
  'url-invalid-values-dropped', 'url-invalid-values-session-fallback',
  'url-reversed-range-drops-created-to', 'ui-created-from-after-created-to-clears-created-to',
  'mobile-all-eight',
])
export const W31_REQUIRED_UI_CASES = Object.freeze(W31_UI_CASES.map(([id]) => id))
export const W31_REQUIRED_INVALID = Object.freeze([
  'status', 'objective-pattern', 'format', 'locale', 'owner-id', 'created-from', 'created-to',
  'range-reversed', 'text-length', 'limit-zero', 'limit-over', 'cursor-malformed',
  'unknown-parameter', 'repeated-parameter',
])
export const W31_SCREENSHOTS = Object.freeze(['w31-desktop-all-eight.png', 'w31-mobile-all-eight.png'])

async function createFixtures(client, workspaceId, creatorClientId) {
  const existing = await client.v2Project.count({ where: { workspaceId, id: { in: W31_FIXTURES.map((item) => item.id) } } })
  assert.equal(existing, 0, 'W31 fixtures must not pre-exist')
  await client.v2Project.createMany({
    data: W31_FIXTURES.map((item) => ({
      id: item.id, workspaceId, name: item.name, status: item.status, objective: item.objective,
      format: item.format, locale: item.locale, ownerId: item.ownerId,
      createdByType: 'api-client', createdById: creatorClientId,
      createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt),
    })),
  })
}

function assertFixtureMembership(id, expectedRows, mustContain, minimum) {
  const ids = expectedRows.map((row) => row.id)
  if (minimum === 0) {
    assert.deepEqual(ids, [], `${id}: the oracle must be empty`)
    return
  }
  assert.ok(ids.length >= minimum, `${id}: oracle has ${ids.length} rows, expected at least ${minimum}`)
  for (const fixtureId of mustContain) assert.ok(ids.includes(fixtureId), `${id}: oracle must contain ${fixtureId}`)
  // Scoped (text or full conjunction) cases are exact, in createdAt/id order.
  if (['six-facets-without-dates', 'all-eight'].includes(id)) assert.deepEqual(ids, mustContain, `${id}: exact oracle`)
}

const errorContract = PUBLIC_ERROR_CATALOG.INVALID_ARGUMENT

export async function proveW31CombinedFilters({
  baseUrl, client, workspaceId, creatorClientId, sessionCookieName, sessionCookieValue, username,
}) {
  return runBrowserProof({
    wave: 'w31', runLabel: 'W31', schemaVersion: W31_SCHEMA, envVar: 'APOLLO_W31_EVIDENCE_DIR',
    manifestName: W31_MANIFEST,
    evidence: { workspaceId, fixtures: [], apiCases: [], invalidCases: [], boundaryCases: [], uiCases: [], persistence: [], requests: [], responses: [] },
    async body({ evidence, evidenceDir, openContext }) {
      const session = { baseUrl, sessionCookieName, sessionCookieValue }
      await assertSessionActive({ baseUrl, workspaceId, sessionCookieName, sessionCookieValue, username })
      evidence.database = { applicationName: await readApplicationName(client) }

      // Fixtures are created only now, after every W29/W30 assertion has run.
      await createFixtures(client, workspaceId, creatorClientId)
      evidence.fixtures = W31_FIXTURES.map(({ id, name, status, objective, format, locale, ownerId, createdAt }) =>
        ({ id, name, status, objective, format, locale, ownerId, createdAt }))
      const persisted = await snapshotRows(client, workspaceId, { id: { in: W31_FIXTURES.map((item) => item.id) } })
      assert.equal(persisted.length, W31_FIXTURES.length)
      for (const fixture of W31_FIXTURES) {
        const row = persisted.find((item) => item.id === fixture.id)
        assert.equal(row.createdAt, fixture.createdAt, `${fixture.id} createdAt must persist exactly`)
        for (const key of ['name', 'status', 'objective', 'format', 'locale', 'ownerId']) assert.equal(row[key], fixture[key])
      }
      const allRowsBefore = await snapshotRows(client, workspaceId)
      const before = await databaseCounts(client, workspaceId)
      evidence.counts = { before }
      evidence.projectRowsBefore = allRowsBefore.map(({ id, name, status, createdAt }) => ({ id, name, status, createdAt }))

      // ---- HTTP phase, before any page is opened: API answers == oracle.
      for (const [id, caseFacets, mustContain, minimum] of W31_UI_CASES) {
        const expectedRows = await oracleProjects(client, workspaceId, caseFacets)
        assertFixtureMembership(id, expectedRows, mustContain, minimum)
        const params = facetsApiParams(caseFacets)
        const { status, body } = await sessionProjects(session, params)
        assert.equal(status, 200, `${id}: API status`)
        const expectedIds = expectedRows.slice(0, PAGE_LIMIT).map((row) => row.id)
        assert.deepEqual(body.data.projects.map((project) => project.id), expectedIds, `${id}: API ids differ from PostgreSQL`)
        for (const project of body.data.projects) {
          const row = expectedRows.find((item) => item.id === project.id)
          assert.equal(project.name, row.name)
          assert.equal(project.status, row.status)
          assert.equal(project.objective ?? null, row.objective)
          assert.equal(project.format ?? null, row.format)
          assert.equal(project.locale ?? null, row.locale)
          assert.equal(project.ownerId ?? null, row.ownerId)
          assert.equal(project.createdAt, row.createdAt.toISOString())
        }
        evidence.apiCases.push({ id, query: sanitizeQuery(new URLSearchParams(params)), status, ids: expectedIds, oracleIds: expectedIds, total: expectedRows.length })
      }

      // Inclusive UTC boundaries, asserted against the API with the exact
      // millisecond limits the codec produces.
      const boundary = async (id, extra, expectedIds) => {
        const params = { limit: String(PAGE_LIMIT), text: 'w31-alfa', status: 'draft', ownerId: OWNER_A, locale: 'pt-BR', objective: 'discovery', format: '9:16', ...extra }
        const { status, body } = await sessionProjects(session, params)
        assert.equal(status, 200, id)
        assert.deepEqual(body.data.projects.map((project) => project.id), expectedIds, id)
        evidence.boundaryCases.push({ id, query: sanitizeQuery(new URLSearchParams(params)), status, ids: expectedIds })
      }
      await boundary('created-from-inclusive-start', { createdFrom: `${DAY}T00:00:00.000Z`, createdTo: `${DAY}T00:00:00.000Z` }, ['w31-edge-start'])
      await boundary('created-from-excludes-one-ms-earlier', { createdFrom: `${DAY}T00:00:00.001Z`, createdTo: `${DAY}T00:00:00.001Z` }, [])
      await boundary('created-to-inclusive-end', { createdFrom: `${DAY}T23:59:59.999Z`, createdTo: `${DAY}T23:59:59.999Z` }, ['w31-edge-end'])
      await boundary('created-to-excludes-one-ms-later', { createdFrom: `${DAY}T23:59:59.998Z`, createdTo: `${DAY}T23:59:59.998Z` }, [])
      await boundary('day-bounds-from-codec', { createdFrom: `${DAY}T00:00:00.000Z`, createdTo: `${DAY}T23:59:59.999Z` }, ['w31-edge-end', 'w31-anchor', 'w31-edge-start'])

      // Contract rejections (HTTP 422 INVALID_ARGUMENT from the public catalog).
      const invalid = [
        ['status', { status: 'processing' }],
        ['objective-pattern', { objective: 'Not An Objective!' }],
        ['format', { format: '3:2' }],
        ['locale', { locale: 'pt_BR' }],
        ['owner-id', { ownerId: '../owner' }],
        ['created-from', { createdFrom: 'yesterday' }],
        ['created-to', { createdTo: '2026-13-45' }],
        ['range-reversed', { createdFrom: '2026-02-11T00:00:00.000Z', createdTo: '2026-02-10T23:59:59.999Z' }],
        ['text-length', { text: 'x'.repeat(121) }],
        ['limit-zero', { limit: '0' }],
        ['limit-over', { limit: '101' }],
        ['cursor-malformed', { after: 'not-a-cursor!' }],
        ['unknown-parameter', { campaign: 'x' }],
      ]
      for (const [id, params] of invalid) {
        const { status, body, headers } = await sessionProjects(session, params)
        assert.equal(status, errorContract.status, `${id}: status`)
        assert.equal(body.data, undefined, `${id}: must not return data`)
        assert.equal(body.error.code, 'INVALID_ARGUMENT', id)
        assert.equal(body.error.category, errorContract.category, id)
        assert.equal(body.error.message, errorContract.message, id)
        assert.equal(body.error.retryable, errorContract.retryable, id)
        assert.ok(body.error.requestId && headers.get('apollo-request-id'), `${id}: request id`)
        evidence.invalidCases.push({ id, query: sanitizeQuery(new URLSearchParams(params)), status, code: body.error.code })
      }
      {
        const repeated = await fetch(`${baseUrl}/v1/projects?status=draft&status=draft`, { headers: { cookie: `${sessionCookieName}=${sessionCookieValue}` } })
        const body = await repeated.json()
        assert.equal(repeated.status, errorContract.status)
        assert.equal(body.error.code, 'INVALID_ARGUMENT')
        evidence.invalidCases.push({ id: 'repeated-parameter', query: { status: ['draft', 'draft'] }, status: repeated.status, code: body.error.code })
      }
      // The API only checks the shape of objective; an unknown but well-formed
      // value is a legitimate empty answer, while the UI codec drops it.
      {
        const { status, body } = await sessionProjects(session, { limit: String(PAGE_LIMIT), objective: 'w31-unknown-objective' })
        assert.equal(status, 200)
        assert.deepEqual(body.data.projects, [])
        evidence.apiAcceptsWellFormedUnknownObjective = true
      }
      assert.deepEqual(await databaseCounts(client, workspaceId), before, 'API probing must not mutate PostgreSQL')

      // ---- Browser phase.
      const anonymous = await openContext({ viewport: { width: 390, height: 844 } })
      const anonymousPage = await anonymous.newPage()
      await anonymousPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      assert.equal(new URL(anonymousPage.url()).pathname, '/login', 'anonymous dashboard must redirect')
      assert.deepEqual(await cards(anonymousPage), [])
      await anonymous.close()

      const context = await openContext({ viewport: { width: 1440, height: 1000 } })
      await context.addCookies([{ name: sessionCookieName, value: sessionCookieValue, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
      const page = await context.newPage()
      const traffic = recordTraffic(page, baseUrl)
      const controls = dashboardControls(page)
      const sessionRead = await context.request.get(`${baseUrl}/v1/session`)
      assert.equal(sessionRead.status(), 200, 'browser cookie must be active before navigation')
      assert.equal((await sessionRead.json()).data.workspaceId, workspaceId)
      evidence.browser.sessionVerifiedBeforeDashboard = true

      const expectedFor = async (caseFacets) => {
        const rows = (await oracleProjects(client, workspaceId, caseFacets)).slice(0, PAGE_LIMIT)
        return { rows, ids: rows.map((row) => row.id), cards: cardsOf(rows) }
      }
      const trafficStart = traffic.mark()
      const unfiltered = await expectedFor(EMPTY_FACETS)
      const first = awaitProjectsResponse(page, facetsApiParams(EMPTY_FACETS), unfiltered.ids)
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      await first
      await waitForCards(page, unfiltered.cards)

      const urlSearch = () => new URL(page.url()).search
      const waitForUrlSearch = (expected) => page.waitForFunction((value) => location.search === value, expected)
      const assertControls = async (expectedFacets, label) => {
        assert.deepEqual(await readControlValues(page), expectedFacets, `${label}: control values`)
      }
      const clearFilters = async () => {
        if (!(await controls.clear.isEnabled())) return
        const cleared = awaitProjectsResponse(page, facetsApiParams(EMPTY_FACETS), unfiltered.ids)
        await controls.clear.click()
        await cleared
        await waitForCards(page, unfiltered.cards)
        await waitForUrlSearch('')
        await assertControls(EMPTY_FACETS, 'cleared')
      }
      const record = async (id, caseFacets, expected, { response, body }, extra = {}) => ({
        id, facets: caseFacets, url: urlSearch(), request: sanitizeQuery(new URL(response.url()).searchParams),
        status: response.status(), responseIds: body.data.projects.map((project) => project.id),
        cardIds: (await cards(page)).map((card) => card.id), expectedIds: expected.ids, ...extra,
      })

      // Every case is driven through the real controls of a freshly cleared form.
      for (const [id, caseFacets] of W31_UI_CASES) {
        await clearFilters()
        const expected = await expectedFor(caseFacets)
        const answered = awaitProjectsResponse(page, facetsApiParams(caseFacets), expected.ids)
        for (const key of FACET_KEYS) if (caseFacets[key]) await setControl(page, key, caseFacets[key])
        const result = await answered
        await waitForCards(page, expected.cards)
        await waitForUrlSearch(facetsUrlSearch(caseFacets))
        await assertControls(caseFacets, id)
        if (expected.ids.length === 0) await page.getByText('Nenhum projeto corresponde a esses filtros.').waitFor()
        evidence.uiCases.push(await record(id, caseFacets, expected, result))
      }

      // ---- Persistence of the complete set: reload, session fallback, explicit URL.
      const persistence = async (id, caseFacets, action, extra = {}) => {
        const expected = await expectedFor(caseFacets)
        const answered = awaitProjectsResponse(page, facetsApiParams(caseFacets), expected.ids)
        await action()
        const result = await answered
        await waitForCards(page, expected.cards)
        await waitForUrlSearch(facetsUrlSearch(caseFacets))
        await assertControls(caseFacets, id)
        if (expected.ids.length === 0) await page.getByText('Nenhum projeto corresponde a esses filtros.').waitFor()
        evidence.persistence.push(await record(id, caseFacets, expected, result, extra))
      }
      await clearFilters()
      const allEightUrl = `${baseUrl}/${facetsUrlSearch(ALL_EIGHT)}`
      await persistence('explicit-url-all-eight', ALL_EIGHT, () => page.goto(allEightUrl, { waitUntil: 'domcontentloaded' }))
      evidence.screenshots.push(await screenshot(page, evidenceDir, W31_SCREENSHOTS[0]))
      await persistence('all-eight-reload', ALL_EIGHT, () => page.reload({ waitUntil: 'domcontentloaded' }))
      await persistence('all-eight-session-fallback', ALL_EIGHT, () => page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' }))
      await persistence('explicit-url-over-session', withoutDates,
        () => page.goto(`${baseUrl}/${facetsUrlSearch(withoutDates)}`, { waitUntil: 'domcontentloaded' }))
      await persistence('explicit-url-updated-session-fallback', withoutDates, () => page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' }))

      // Invalid values in an explicit URL are dropped by the codec; the valid
      // facet survives and the address is rewritten to its canonical form.
      const invalidUrl = '?text=w31-alfa&status=bogus&objective=nope&format=3%3A2&locale=pt_BR&createdFrom=2026-02-31&createdTo=garbage&ownerId=..%2Fx'
      const textOnly = facets({ text: 'w31-alfa' })
      await persistence('url-invalid-values-dropped', textOnly,
        () => page.goto(`${baseUrl}/${invalidUrl}`, { waitUntil: 'domcontentloaded' }), { requestedSearch: invalidUrl })
      await persistence('url-invalid-values-session-fallback', textOnly, () => page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' }))
      const reversed = facets({ text: 'w31-alfa', createdFrom: '2026-02-12' })
      await persistence('url-reversed-range-drops-created-to', reversed,
        () => page.goto(`${baseUrl}/?text=w31-alfa&createdFrom=2026-02-12&createdTo=2026-02-10`, { waitUntil: 'domcontentloaded' }),
        { requestedSearch: '?text=w31-alfa&createdFrom=2026-02-12&createdTo=2026-02-10' })
      // Real controls: moving "from" past "to" clears "to" instead of sending a reversed range.
      await page.goto(allEightUrl, { waitUntil: 'domcontentloaded' })
      await waitForCards(page, (await expectedFor(ALL_EIGHT)).cards)
      await persistence('ui-created-from-after-created-to-clears-created-to', { ...ALL_EIGHT, createdFrom: '2026-02-12', createdTo: '' },
        () => setControl(page, 'createdFrom', '2026-02-12'))

      // ---- Mobile.
      await page.setViewportSize({ width: 390, height: 844 })
      await persistence('mobile-all-eight', ALL_EIGHT, () => page.goto(allEightUrl, { waitUntil: 'domcontentloaded' }))
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      evidence.browser.mobileOverflowPx = overflow
      evidence.screenshots.push(await screenshot(page, evidenceDir, W31_SCREENSHOTS[1]))
      assert.ok(overflow <= 1, `W31 mobile overflows by ${overflow}px`)

      // ---- Read-only guarantees.
      assert.equal(traffic.mutating(trafficStart).length, 0, 'filters must not mutate HTTP state')
      evidence.browser.mutatingRequests = 0
      evidence.requests = traffic.projectGets(trafficStart)
      assert.ok(evidence.requests.length >= W31_UI_CASES.length, 'browser must issue real project GETs for every case')
      assert.ok(evidence.requests.every((request) => request.method === 'GET'))
      evidence.responses = (await traffic.responses()).filter((item) => item.status === 200 && item.ids !== null)
      assert.ok(evidence.responses.length >= W31_UI_CASES.length)
      evidence.counts.after = await databaseCounts(client, workspaceId)
      assert.deepEqual(evidence.counts.after, before, 'filters must not mutate PostgreSQL counters')
      const allRowsAfter = await snapshotRows(client, workspaceId)
      assert.deepEqual(allRowsAfter, allRowsBefore, 'filters must not change any persisted project')
      evidence.projectRowsAfter = allRowsAfter.map(({ id, name, status, createdAt }) => ({ id, name, status, createdAt }))
    },
  })
}
