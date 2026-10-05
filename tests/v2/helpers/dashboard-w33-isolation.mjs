import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { PUBLIC_ERROR_CATALOG } from '../../../src/v2/public-api/public-error-catalog.ts'
import {
  EMPTY_FACETS, awaitProjectsResponse, cards, cardsOf, databaseCounts,
  facetsApiParams, facetsUrlSearch, oracleProjects, readApplicationName, recordTraffic, runBrowserProof,
  sanitizeQuery, screenshot, setControl, snapshotRows, waitForCards,
} from './dashboard-list-proof-common.mjs'

export const W33_SCHEMA = 'w33-dashboard-workspace-isolation/v1'
export const W33_MANIFEST = 'w33-manifest.json'
export const W33_LOCALE = 'qaa-w33'
export const W33_SCREENSHOTS = Object.freeze([
  'w33-desktop-workspace-a.png', 'w33-desktop-workspace-b.png', 'w33-mobile-workspace-b.png',
])
export const W33_OWNER_A = 'w33-owner-a'
export const W33_OWNER_B = 'w33-owner-b'

const same = (index, hour) => `2026-04-01T${String(hour).padStart(2, '0')}:${index}:00.000Z`
// Interleaved timestamps (and one instant shared by the two workspaces) so that
// any accidental mixing of workspaces would reorder or duplicate rows.
export const W33_FIXTURES_A = Object.freeze([
  { id: 'w33-a-1', name: 'w33 alfa um', createdAt: same('00', 10) },
  { id: 'w33-a-2', name: 'w33 alfa dois', createdAt: same('00', 11) },
  { id: 'w33-a-3', name: 'w33 compartilhado', createdAt: same('00', 12) },
  { id: 'w33-a-4', name: 'w33 alfa quatro', createdAt: same('00', 13) },
].map((item) => ({ ...item, objective: 'discovery', format: '9:16', locale: W33_LOCALE, ownerId: W33_OWNER_A, status: 'draft' })))
export const W33_FIXTURES_B = Object.freeze([
  { id: 'w33-b-1', name: 'w33 beta um', createdAt: same('30', 10) },
  { id: 'w33-b-2', name: 'w33 beta dois', createdAt: same('30', 11) },
  { id: 'w33-b-3', name: 'w33 compartilhado', createdAt: same('00', 12) },
  { id: 'w33-b-4', name: 'w33 beta quatro', createdAt: same('30', 12) },
  { id: 'w33-b-5', name: 'w33 beta cinco', createdAt: same('30', 13) },
].map((item) => ({ ...item, objective: 'sale', format: '16:9', locale: W33_LOCALE, ownerId: W33_OWNER_B, status: 'draft' })))

const SCOPE = { ...EMPTY_FACETS, locale: W33_LOCALE }
const SHARED = { ...SCOPE, text: 'w33 compartilhado' }
const SCOPE_WITH_OWNER_B = { ...SCOPE, ownerId: W33_OWNER_B }
const BETA_TEXT = { ...SCOPE, text: 'beta' }
const ALFA_TEXT = { ...SCOPE, text: 'alfa' }
const INVALID = PUBLIC_ERROR_CATALOG.INVALID_ARGUMENT
const UNAUTHENTICATED = PUBLIC_ERROR_CATALOG.AUTH_INVALID
const MISSING_SCOPE = PUBLIC_ERROR_CATALOG.AUTH_SCOPE_REQUIRED
const NOT_FOUND = PUBLIC_ERROR_CATALOG.PROJECT_NOT_FOUND
const EMPTY_STATE = 'Nenhum projeto corresponde a esses filtros.'

export const W33_REQUIRED_HTTP = Object.freeze([
  'a-session-scope', 'a-bearer-scope', 'b-session-scope', 'b-bearer-scope', 'a-shared-name', 'b-shared-name',
  'a-zero-owner-only-in-b', 'a-zero-text-only-in-b', 'b-zero-text-only-in-a',
  'a-cursor-under-a', 'a-cursor-under-b-session', 'a-cursor-under-b-bearer', 'b-cursor-under-a-session',
  'a-cursor-other-filter-under-a', 'a-cursor-other-text-under-a', 'forged-cursor-with-b-pointer-under-a',
  'project-own-a-session', 'project-b-under-a-session', 'project-own-b-session', 'project-a-under-b-session',
])
export const W33_REQUIRED_AUTH = Object.freeze([
  'anonymous', 'expired-session', 'revoked-session', 'unknown-session-token', 'malformed-bearer',
  'bearer-without-projects-read',
])
export const W33_REQUIRED_PAGES = Object.freeze(['anonymous-page', 'expired-session-page', 'revoked-session-page'])
export const W33_REQUIRED_UI = Object.freeze([
  'workspace-a-cards', 'workspace-b-cards', 'workspace-a-zero-by-isolation', 'workspace-b-zero-by-isolation',
  'workspace-a-shared-name', 'workspace-b-shared-name', 'session-revoked-during-use-redirects-to-login',
  'mobile-workspace-b',
])

function decodeCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
}

function forgeCursor({ workspaceId, filters, pointer }) {
  // Mirrors the documented fingerprint (workspace + exact filters) but points at
  // a row of the other workspace: a leak would be visible as a foreign id.
  const queryHash = createHash('sha256').update(JSON.stringify({ workspaceId, filters })).digest('hex')
  return Buffer.from(JSON.stringify({ v: 1, createdAt: pointer.createdAt, id: pointer.id, queryHash }), 'utf8').toString('base64url')
}

async function insertFixtures(client, workspaceId, creatorClientId, fixtures) {
  const existing = await client.v2Project.count({ where: { id: { in: fixtures.map((item) => item.id) } } })
  assert.equal(existing, 0, 'W33 fixtures must not pre-exist')
  await client.v2Project.createMany({
    data: fixtures.map((item) => ({
      id: item.id, workspaceId, name: item.name, status: item.status, objective: item.objective,
      format: item.format, locale: item.locale, ownerId: item.ownerId,
      createdByType: 'api-client', createdById: creatorClientId,
      createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt),
    })),
  })
}

export async function proveW33Isolation({
  baseUrl, client, workspaceA, workspaceB, clientA, clientB, memberA, memberB,
  cookieName, sessionA, bearerA, issueSession, createBearer, usernameA,
}) {
  return runBrowserProof({
    wave: 'w33', runLabel: 'W33', schemaVersion: W33_SCHEMA, envVar: 'APOLLO_W33_EVIDENCE_DIR',
    manifestName: W33_MANIFEST,
    evidence: {
      workspaces: { a: workspaceA, b: workspaceB }, fixtures: { a: [], b: [] },
      httpCases: [], authCases: [], pageCases: [], uiCases: [], requests: [], responses: [],
    },
    async body({ evidence, evidenceDir, openContext }) {
      evidence.database = { applicationName: await readApplicationName(client) }
      // Credentials per workspace. The human login throttle is already exhausted by
      // the earlier journey, so B's session (and the expired/revoked ones) are
      // durable v2UiSession rows issued through the application's own session
      // primitives; sessionA is the original POST /v1/session login of workspace A.
      const sessionB = await issueSession({ workspaceId: workspaceB, clientId: clientB, memberId: memberB, state: 'active' })
      const bearerB = await createBearer({ workspaceId: workspaceB, clientId: 'w33-b-reader', scopes: ['projects:read'] })
      const bearerWithoutProjects = await createBearer({ workspaceId: workspaceA, clientId: 'w33-a-no-projects', scopes: ['artifacts:read'] })
      const expiredSession = await issueSession({ workspaceId: workspaceA, clientId: clientA, memberId: memberA, state: 'expired' })
      const revokedSession = await issueSession({ workspaceId: workspaceA, clientId: clientA, memberId: memberA, state: 'revoked' })
      const midUseSession = await issueSession({ workspaceId: workspaceA, clientId: clientA, memberId: memberA, state: 'active' })
      const unknownSession = await issueSession({ workspaceId: workspaceA, clientId: clientA, memberId: memberA, state: 'unissued' })
      const actors = {
        'a-session': { cookie: `${cookieName}=${sessionA}` },
        'a-bearer': { authorization: bearerA },
        'b-session': { cookie: `${cookieName}=${sessionB}` },
        'b-bearer': { authorization: bearerB },
        anonymous: {},
        'expired-session': { cookie: `${cookieName}=${expiredSession}` },
        'revoked-session': { cookie: `${cookieName}=${revokedSession}` },
        'unknown-session-token': { cookie: `${cookieName}=${unknownSession}` },
        'malformed-bearer': { authorization: 'Bearer not-a-valid-credential' },
        'bearer-without-projects-read': { authorization: bearerWithoutProjects },
      }
      const call = async (actor, path, params = {}) => {
        const response = await fetch(`${baseUrl}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`, { headers: actors[actor] })
        return { status: response.status, body: await response.json(), headers: response.headers }
      }
      const whoami = async (actor) => (await call(actor, '/v1/session')).body.data
      assert.equal((await whoami('a-session')).workspaceId, workspaceA)
      assert.equal((await whoami('a-session')).subject, usernameA)
      assert.equal((await whoami('b-session')).workspaceId, workspaceB)
      assert.equal((await whoami('b-session')).memberId, memberB)

      // ---- Fixtures: distinct identities in A and B, created after the baselines.
      await insertFixtures(client, workspaceA, clientA, W33_FIXTURES_A)
      await insertFixtures(client, workspaceB, clientB, W33_FIXTURES_B)
      evidence.fixtures = {
        a: W33_FIXTURES_A.map(({ id, name, createdAt, ownerId }) => ({ id, name, createdAt, ownerId })),
        b: W33_FIXTURES_B.map(({ id, name, createdAt, ownerId }) => ({ id, name, createdAt, ownerId })),
      }
      const rowsBeforeA = await snapshotRows(client, workspaceA)
      const rowsBeforeB = await snapshotRows(client, workspaceB)
      const before = { a: await databaseCounts(client, workspaceA), b: await databaseCounts(client, workspaceB) }
      evidence.counts = { before }
      evidence.projectRowsBefore = { a: rowsBeforeA.map(({ id, status }) => ({ id, status })), b: rowsBeforeB.map(({ id, status }) => ({ id, status })) }
      const oracleA = await oracleProjects(client, workspaceA, SCOPE)
      const oracleB = await oracleProjects(client, workspaceB, SCOPE)
      assert.deepEqual(oracleA.map((row) => row.id), ['w33-a-4', 'w33-a-3', 'w33-a-2', 'w33-a-1'])
      assert.deepEqual(oracleB.map((row) => row.id), ['w33-b-5', 'w33-b-4', 'w33-b-3', 'w33-b-2', 'w33-b-1'])
      const idsA = oracleA.map((row) => row.id)
      const idsB = oracleB.map((row) => row.id)
      assert.equal(oracleA.find((row) => row.id === 'w33-a-3').createdAt.getTime(), oracleB.find((row) => row.id === 'w33-b-3').createdAt.getTime(),
        'the shared-name projects must tie on createdAt across workspaces')
      assert.ok(oracleA.every((row) => row.workspaceId === workspaceA) && oracleB.every((row) => row.workspaceId === workspaceB))

      // ---- HTTP phase.
      const record = (id, actor, path, params, result, extra = {}) => evidence.httpCases.push({
        id, actor, path, query: sanitizeQuery(new URLSearchParams(params)), status: result.status,
        ids: result.body.data?.projects?.map((project) => project.id) ?? null,
        errorCode: result.body.error?.code, ...extra,
      })
      const okList = async (id, actor, facets, expectedIds, foreignIds, extraParams = {}) => {
        const params = { ...facetsApiParams(facets), ...extraParams }
        const result = await call(actor, '/v1/projects', params)
        assert.equal(result.status, 200, id)
        assert.deepEqual(result.body.data.projects.map((project) => project.id), expectedIds, `${id}: ids`)
        const text = JSON.stringify(result.body)
        for (const foreign of foreignIds) assert.equal(text.includes(foreign), false, `${id}: leaked ${foreign}`)
        const wanted = actor.startsWith('a-') ? workspaceA : workspaceB
        assert.ok(result.body.data.projects.every((project) => project.workspaceId === wanted), `${id}: workspace ids`)
        record(id, actor, '/v1/projects', params, result)
        return result
      }
      const listA = (id, actor, facets, expected) => okList(id, actor, facets, expected, [...idsB, 'w33 beta', workspaceB])
      const listB = (id, actor, facets, expected) => okList(id, actor, facets, expected, [...idsA, 'w33 alfa', workspaceA])
      await listA('a-session-scope', 'a-session', SCOPE, idsA)
      await listA('a-bearer-scope', 'a-bearer', SCOPE, idsA)
      await listB('b-session-scope', 'b-session', SCOPE, idsB)
      await listB('b-bearer-scope', 'b-bearer', SCOPE, idsB)
      await listA('a-shared-name', 'a-session', SHARED, ['w33-a-3'])
      await listB('b-shared-name', 'b-session', SHARED, ['w33-b-3'])
      // Legitimate zero results: the value exists, but in the other workspace.
      assert.deepEqual((await oracleProjects(client, workspaceB, SCOPE_WITH_OWNER_B)).map((row) => row.id), idsB)
      assert.deepEqual((await oracleProjects(client, workspaceB, BETA_TEXT)).length, 4)
      assert.deepEqual((await oracleProjects(client, workspaceA, ALFA_TEXT)).length, 3)
      assert.deepEqual(await oracleProjects(client, workspaceA, SCOPE_WITH_OWNER_B), [])
      await listA('a-zero-owner-only-in-b', 'a-session', SCOPE_WITH_OWNER_B, [])
      await listA('a-zero-text-only-in-b', 'a-session', BETA_TEXT, [])
      await listB('b-zero-text-only-in-a', 'b-session', ALFA_TEXT, [])

      // Cursors: bound to workspace and exact filters; a mismatch is a contract error, never a 200.
      const rejected = async (id, actor, params, extra = {}) => {
        const result = await call(actor, '/v1/projects', params)
        assert.equal(result.status, INVALID.status, `${id}: must be rejected, got ${result.status}`)
        assert.equal(result.body.data, undefined, `${id}: nothing may be returned`)
        assert.equal(result.body.error.code, 'INVALID_ARGUMENT', id)
        assert.equal(result.body.error.category, INVALID.category, id)
        assert.equal(result.body.error.message, INVALID.message, id)
        assert.ok(result.body.error.requestId && result.headers.get('apollo-request-id'), id)
        record(id, actor, '/v1/projects', params, result, extra)
      }
      const pageA = await call('a-session', '/v1/projects', facetsApiParams(SCOPE, { limit: 2 }))
      const pageB = await call('b-session', '/v1/projects', facetsApiParams(SCOPE, { limit: 2 }))
      const cursorA = pageA.body.data.nextCursor
      const cursorB = pageB.body.data.nextCursor
      assert.ok(cursorA && cursorB && cursorA !== cursorB)
      assert.deepEqual(pageA.body.data.projects.map((project) => project.id), idsA.slice(0, 2))
      assert.deepEqual(pageB.body.data.projects.map((project) => project.id), idsB.slice(0, 2))
      const withCursor = (facets, after) => facetsApiParams(facets, { limit: 2, after })
      const control = await call('a-session', '/v1/projects', withCursor(SCOPE, cursorA))
      assert.equal(control.status, 200, 'the cursor must work under its own workspace and filters')
      assert.deepEqual(control.body.data.projects.map((project) => project.id), idsA.slice(2, 4))
      record('a-cursor-under-a', 'a-session', '/v1/projects', withCursor(SCOPE, cursorA), control)
      await rejected('a-cursor-under-b-session', 'b-session', withCursor(SCOPE, cursorA))
      await rejected('a-cursor-under-b-bearer', 'b-bearer', withCursor(SCOPE, cursorA))
      await rejected('b-cursor-under-a-session', 'a-session', withCursor(SCOPE, cursorB))
      await rejected('a-cursor-other-filter-under-a', 'a-session', withCursor(SCOPE_WITH_OWNER_B, cursorA))
      await rejected('a-cursor-other-text-under-a', 'a-session', withCursor({ ...SCOPE, text: 'w33' }, cursorA))
      // A forged cursor that carries A's fingerprint but points at B's newest row is
      // accepted as shape, yet the repository stays inside A: only A rows may appear.
      const pointer = decodeCursor(cursorB)
      const forged = forgeCursor({
        workspaceId: workspaceA, filters: { locale: W33_LOCALE }, pointer: { id: pointer.id, createdAt: pointer.createdAt },
      })
      const forgedResult = await call('a-session', '/v1/projects', withCursor(SCOPE, forged))
      assert.equal(forgedResult.status, 200)
      assert.ok(forgedResult.body.data.projects.every((project) => idsA.includes(project.id)), 'a forged foreign pointer must never surface B rows')
      assert.equal(JSON.stringify(forgedResult.body).includes(workspaceB), false)
      record('forged-cursor-with-b-pointer-under-a', 'a-session', '/v1/projects', withCursor(SCOPE, forged), forgedResult)

      // Direct reads of a project of the other workspace.
      const own = await call('a-session', `/v1/projects/${W33_FIXTURES_A[0].id}`)
      assert.equal(own.status, 200)
      record('project-own-a-session', 'a-session', `/v1/projects/${W33_FIXTURES_A[0].id}`, {}, own)
      const crossAB = await call('a-session', `/v1/projects/${W33_FIXTURES_B[0].id}`)
      assert.equal(crossAB.status, NOT_FOUND.status)
      assert.equal(crossAB.body.error.code, 'PROJECT_NOT_FOUND')
      record('project-b-under-a-session', 'a-session', `/v1/projects/${W33_FIXTURES_B[0].id}`, {}, crossAB)
      const ownB = await call('b-session', `/v1/projects/${W33_FIXTURES_B[0].id}`)
      assert.equal(ownB.status, 200)
      record('project-own-b-session', 'b-session', `/v1/projects/${W33_FIXTURES_B[0].id}`, {}, ownB)
      const crossBA = await call('b-session', `/v1/projects/${W33_FIXTURES_A[0].id}`)
      assert.equal(crossBA.status, NOT_FOUND.status)
      assert.equal(crossBA.body.error.code, 'PROJECT_NOT_FOUND')
      record('project-a-under-b-session', 'b-session', `/v1/projects/${W33_FIXTURES_A[0].id}`, {}, crossBA)

      // Anonymous / expired / revoked / unknown / malformed / under-scoped, with the route's real codes.
      for (const id of W33_REQUIRED_AUTH) {
        const result = await call(id, '/v1/projects', facetsApiParams(SCOPE))
        const expected = id === 'bearer-without-projects-read' ? MISSING_SCOPE : UNAUTHENTICATED
        assert.equal(result.status, expected.status, `${id}: status`)
        assert.equal(result.body.data, undefined, `${id}: no rows`)
        assert.equal(result.body.error.code, expected.code, id)
        assert.equal(result.body.error.category, expected.category, id)
        assert.ok(result.body.error.requestId, id)
        evidence.authCases.push({ id, status: result.status, code: result.body.error.code, category: result.body.error.category })
      }
      for (const [id, cookie] of [['expired-session-page', expiredSession], ['revoked-session-page', revokedSession]]) {
        const response = await fetch(`${baseUrl}/`, { headers: { cookie: `${cookieName}=${cookie}` } })
        const landed = new URL(response.url)
        assert.equal(landed.pathname, '/login', `${id}: must land on /login`)
        assert.equal(landed.searchParams.get('next'), '/')
        evidence.pageCases.push({ id, status: response.status, landedPath: landed.pathname, next: landed.searchParams.get('next') })
      }
      assert.deepEqual({ a: await databaseCounts(client, workspaceA), b: await databaseCounts(client, workspaceB) }, before, 'HTTP probing must not mutate PostgreSQL')

      // ---- Browser phase: one context per workspace, each with its own session.
      const anonymousContext = await openContext({ viewport: { width: 390, height: 844 } })
      const anonymousPage = await anonymousContext.newPage()
      await anonymousPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      const anonymousLanding = new URL(anonymousPage.url())
      assert.equal(anonymousLanding.pathname, '/login')
      assert.equal(anonymousLanding.searchParams.get('next'), '/')
      assert.deepEqual(await cards(anonymousPage), [])
      evidence.pageCases.push({ id: 'anonymous-page', status: 200, landedPath: anonymousLanding.pathname, next: anonymousLanding.searchParams.get('next') })
      await anonymousContext.close()

      const open = async (cookie, viewport) => {
        const context = await openContext({ viewport })
        await context.addCookies([{ name: cookieName, value: cookie, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
        const page = await context.newPage()
        return { context, page, traffic: recordTraffic(page, baseUrl) }
      }
      const a = await open(sessionA, { width: 1440, height: 1000 })
      const b = await open(sessionB, { width: 1440, height: 1000 })
      const sessions = [a, b]
      const urlSearch = (page) => new URL(page.url()).search
      const uiRecord = async (id, who, facets, expectedRows, answer, extra = {}) => evidence.uiCases.push({
        id, workspace: who === a ? 'a' : 'b', facets, url: urlSearch(who.page),
        request: sanitizeQuery(new URL(answer.response.url()).searchParams), status: answer.response.status(),
        responseIds: answer.body.data.projects.map((project) => project.id), cardIds: (await cards(who.page)).map((card) => card.id),
        expectedIds: expectedRows.map((row) => row.id), ...extra,
      })
      const load = async (who, facets, expectedRows, id, extra = {}) => {
        const answered = awaitProjectsResponse(who.page, facetsApiParams(facets), expectedRows.map((row) => row.id))
        await who.page.goto(`${baseUrl}/${facetsUrlSearch(facets)}`, { waitUntil: 'domcontentloaded' })
        const answer = await answered
        await waitForCards(who.page, cardsOf(expectedRows))
        await uiRecord(id, who, facets, expectedRows, answer, extra)
        return answer
      }
      const filter = async (who, facets, key, expectedRows, id, extra = {}) => {
        const answered = awaitProjectsResponse(who.page, facetsApiParams(facets), expectedRows.map((row) => row.id))
        await setControl(who.page, key, facets[key])
        const answer = await answered
        await waitForCards(who.page, cardsOf(expectedRows))
        await who.page.waitForFunction((value) => location.search === value, facetsUrlSearch(facets))
        await uiRecord(id, who, facets, expectedRows, answer, extra)
      }
      const assertNoForeignText = async (who, foreignNames, label) => {
        const text = await who.page.locator('body').innerText()
        for (const name of foreignNames) assert.equal(text.includes(name), false, `${label}: the page shows "${name}"`)
      }

      await load(a, SCOPE, oracleA, 'workspace-a-cards')
      await assertNoForeignText(a, ['w33 beta'], 'workspace A')
      evidence.screenshots.push(await screenshot(a.page, evidenceDir, W33_SCREENSHOTS[0]))
      await load(b, SCOPE, oracleB, 'workspace-b-cards')
      await assertNoForeignText(b, ['w33 alfa'], 'workspace B')
      evidence.screenshots.push(await screenshot(b.page, evidenceDir, W33_SCREENSHOTS[1]))

      // Zero by isolation: the text exists in the other workspace, so the empty state is not "no data".
      await filter(a, BETA_TEXT, 'text', [], 'workspace-a-zero-by-isolation', { existsInOtherWorkspace: (await oracleProjects(client, workspaceB, BETA_TEXT)).length })
      await a.page.getByText(EMPTY_STATE).waitFor()
      await filter(b, ALFA_TEXT, 'text', [], 'workspace-b-zero-by-isolation', { existsInOtherWorkspace: (await oracleProjects(client, workspaceA, ALFA_TEXT)).length })
      await b.page.getByText(EMPTY_STATE).waitFor()
      // The same visible name in both workspaces resolves to each workspace's own project.
      const sharedA = await oracleProjects(client, workspaceA, SHARED)
      const sharedB = await oracleProjects(client, workspaceB, SHARED)
      await filter(a, SHARED, 'text', sharedA, 'workspace-a-shared-name')
      await filter(b, SHARED, 'text', sharedB, 'workspace-b-shared-name')
      assert.deepEqual((await cards(a.page)).map((card) => card.id), ['w33-a-3'])
      assert.deepEqual((await cards(b.page)).map((card) => card.id), ['w33-b-3'])

      // A session revoked while the dashboard is open: the next list request is a 401
      // and the UI leaves for /login instead of showing stale rows.
      const mid = await open(midUseSession, { width: 1440, height: 1000 })
      sessions.push(mid)
      await load(mid, SCOPE, oracleA, 'session-revoked-during-use-prelude')
      evidence.uiCases.pop()
      const revokedAt = new Date()
      await client.v2UiSession.updateMany({
        where: { nonceHash: createHash('sha256').update(midUseSession).digest('hex'), workspaceId: workspaceA },
        data: { revokedAt },
      })
      let unauthorizedResponse = null
      await mid.page.route((url) => url.pathname === '/v1/projects', async (route) => {
        const upstream = await route.fetch()
        unauthorizedResponse = { status: upstream.status(), body: await upstream.json() }
        await route.fulfill({ response: upstream })
      })
      await setControl(mid.page, 'text', 'w33')
      await mid.page.waitForFunction(() => location.pathname === '/login')
      assert.equal(unauthorizedResponse?.status, UNAUTHENTICATED.status)
      assert.equal(unauthorizedResponse.body.error.code, 'AUTH_INVALID')
      assert.deepEqual(await cards(mid.page), [])
      evidence.uiCases.push({
        id: 'session-revoked-during-use-redirects-to-login', workspace: 'a', status: unauthorizedResponse.status,
        errorCode: 'AUTH_INVALID', landedPath: new URL(mid.page.url()).pathname, cardIds: [],
      })

      // Mobile, workspace B.
      await b.page.setViewportSize({ width: 390, height: 844 })
      await load(b, SCOPE, oracleB, 'mobile-workspace-b')
      const overflow = await b.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      evidence.browser.mobileOverflowPx = overflow
      await assertNoForeignText(b, ['w33 alfa'], 'workspace B mobile')
      evidence.screenshots.push(await screenshot(b.page, evidenceDir, W33_SCREENSHOTS[2]))
      assert.ok(overflow <= 1, `W33 mobile overflows by ${overflow}px`)

      // ---- Read-only guarantees across every browser page.
      for (const session of sessions) assert.equal(session.traffic.mutating().length, 0, 'isolation reads must not mutate HTTP state')
      evidence.browser.mutatingRequests = 0
      evidence.requests = sessions.flatMap((session, index) => session.traffic.projectGets().map((request) => ({ ...request, context: ['a', 'b', 'a-mid-use'][index] })))
      assert.ok(evidence.requests.every((request) => request.method === 'GET'))
      evidence.responses = (await Promise.all(sessions.map((session) => session.traffic.responses()))).flat()
      assert.ok(evidence.responses.some((item) => item.status === UNAUTHENTICATED.status))
      const after = { a: await databaseCounts(client, workspaceA), b: await databaseCounts(client, workspaceB) }
      evidence.counts.after = after
      assert.deepEqual(after, before, 'isolation reads must not mutate PostgreSQL counters')
      const rowsAfterA = await snapshotRows(client, workspaceA)
      const rowsAfterB = await snapshotRows(client, workspaceB)
      assert.deepEqual(rowsAfterA, rowsBeforeA)
      assert.deepEqual(rowsAfterB, rowsBeforeB)
      evidence.projectRowsAfter = { a: rowsAfterA.map(({ id, status }) => ({ id, status })), b: rowsAfterB.map(({ id, status }) => ({ id, status })) }
    },
  })
}
