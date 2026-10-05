import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { calculateVersionHash } from '../../../src/v2/application/version-hash.ts'
import { calculateCanonicalHash, stableSerialize } from '../../../src/v2/domain/canonical-hash.ts'
import {
  EMPTY_FACETS, awaitProjectsResponse, canonicalQuery, cardsOf, databaseCounts, facetsApiParams,
  facetsUrlSearch, oracleProjects, readControlValues, setControl, waitForCards,
} from './dashboard-list-proof-common.mjs'
import { seedAnnotations, seedOperation, setProjectStatus } from './dashboard-w34-35-fixtures.mjs'
import {
  apiCall, assertRefusal, cardIds, cardSnapshot, commandSummary, createProjectViaApi,
  holdRequest, listPathMatches, plain, projectOracle, projectRowSummary, pushCase, recordApplicationName,
  runWaveProof, sanitizedRequest, screenshot, sha256, summaryCounters, trackBrowserTraffic,
  waitForCardName, waitForCardSet, waitForCardState, waitForSettled,
} from './dashboard-w37-39-shared.mjs'

const run = promisify(execFile)
const FEED_PATH = '/v1/events/feed'
const SESSION_ROTATE_AFTER_MS = 10 * 60_000
const SESSION_IDENTIFIER_MAX_AGE_MS = 15 * 60_000
// The same isolated artifact root the journey server serves (created by the test, emptied by W39).
const ARTIFACT_ROOT_PREFIX = 'apollo-w39-artifacts-'
const PROCESSING_STATUSES = new Set([
  'ingesting', 'perceiving', 'planning', 'generating', 'reviewing-assets', 'rendering-proxy', 'revising', 'rendering-final',
])

/** The four summary tiles, derived from persisted statuses (an independent statement of the bucket rule). */
export function expectedTiles(statuses) {
  const tiles = { 'Em configuração': 0, 'Em produção': 0, 'Aguardando revisão': 0, Concluídos: 0 }
  for (const status of statuses) {
    if (status === 'draft') tiles['Em configuração'] += 1
    else if (status === 'reviewing-proxy') tiles['Aguardando revisão'] += 1
    else if (status === 'completed') tiles.Concluídos += 1
    else if (PROCESSING_STATUSES.has(status)) tiles['Em produção'] += 1
  }
  return tiles
}

/** A promise that may never settle (a held request nobody sent) must fail the proof instead of hanging it. */
function within(label, promise, timeoutMs = 30_000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs) })]).finally(() => clearTimeout(timer))
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

async function storageInventory(root, keyPrefix) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        const info = await stat(path)
        files.push({ key: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: sha256(bytes), mtimeMs: info.mtimeMs })
      }
    }
  }
  await walk(root)
  return files.filter((file) => file.key.startsWith(keyPrefix)).toSorted((left, right) => left.key.localeCompare(right.key))
}

/**
 * Timing aid for the stale-revision cases (not an error injection): holds the dashboard's next feed poll so the
 * live revision the open dialog reads cannot be refreshed by the other client's event before the browser submits.
 * The 409 itself still comes from the server's real revision. The poll that was already in flight when the route
 * was installed has completed by the time the held one is observed.
 */
async function holdFeedPoll(page) {
  let release
  const gate = new Promise((done) => { release = done })
  let markHeld
  const held = new Promise((done) => { markHeld = done })
  const matches = (url) => url.pathname === FEED_PATH
  const handler = async (route) => { markHeld(true); await gate; await route.continue().catch(() => undefined) }
  await page.route(matches, handler)
  return { held, release, dispose: () => page.unroute(matches, handler) }
}

/** Records the feed answers one page receives (event ids only; no cursor value leaves memory). */
function recordFeed(page, baseUrl) {
  const entries = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin !== baseUrl || url.pathname !== FEED_PATH) return
    const entry = { at: Date.now(), status: response.status(), startAt: url.searchParams.get('startAt'), hadCursor: url.searchParams.has('after'), eventIds: [], eventTypes: [] }
    entries.push(entry)
    response.json().then((body) => {
      entry.eventIds = (body?.data?.events ?? []).map((event) => event.id)
      entry.eventTypes = (body?.data?.events ?? []).map((event) => event.type)
    }).catch(() => undefined)
  })
  return { entries, mark: () => entries.length, since: (mark) => entries.slice(mark) }
}

/**
 * W40 consolidated dashboard journey: one human browser session over data it
 * created, composed from the W31-W39 proofs. Fixture prefix: w40-<run tag>.
 * Expectations come from PostgreSQL rows and the public API, never from the
 * component. Security failures are produced from real persisted state; the only
 * transport interference (two cases) is labelled `controlled: true`.
 */
export async function proveW40ConsolidatedJourney({
  baseUrl, client, workspaceId, otherWorkspaceId, apiClientId, otherApiClientId, otherMemberId,
  authorization, credentialId, sourceArtifactId, readOnlyAuthorization, otherWorkspaceAuthorization,
  sessionCookieName, sessionCookieValue, username,
  issueSession, createBearer, uiSessionNonceHash, artifactRoot, ffmpegPath, artifacts, createMediaArtifactManifest,
}) {
  const startedAt = Date.now()
  const tag = randomUUID().slice(0, 8)
  const prefix = `w40-${tag}`
  const names = {
    open: `${prefix}-aberto`, openByClientB: `${prefix}-aberto-alterado-por-outro-cliente`,
    review: `${prefix}-revisao`, rename: `${prefix}-renomear`, archive: `${prefix}-arquivar`, dup: `${prefix}-duplicar`,
    copy: `${prefix}-duplicar — cópia`,
    renameUi: `${prefix}-renomear-ui`, renameOther: `${prefix}-renomear-outro-cliente`, renameRefused: `${prefix}-renomear-recusado`,
    renameRecovered: `${prefix}-renomear-recuperado`, renameRetry: `${prefix}-renomear-retentativa`, renameLost: `${prefix}-renomear-resposta-perdida`,
    archiveOther: `${prefix}-arquivar-outro-cliente`, attempt: `${prefix}-nao-deve-gravar`,
  }
  const sessionCookieOf = (headers) => headers.get('set-cookie')?.match(new RegExp(`${sessionCookieName}=([^;]+)`))?.[1] ?? null

  // --- session age: measured before anything runs; rotation only through the product's own path ------
  const originalRow = await client.v2UiSession.findUnique({ where: { nonceHash: uiSessionNonceHash(sessionCookieValue) } })
  assert.ok(originalRow, 'the human session row exists')
  const sessionAgeAtStartMs = Date.now() - originalRow.issuedAt.getTime()
  assert.ok(sessionAgeAtStartMs < SESSION_IDENTIFIER_MAX_AGE_MS, `the journey outlived the 15-minute session identifier (${sessionAgeAtStartMs} ms) before W40 started`)
  let liveCookieValue = sessionCookieValue
  const session = {
    ageAtStartMs: sessionAgeAtStartMs, rotateAfterMs: SESSION_ROTATE_AFTER_MS, identifierMaxAgeMs: SESSION_IDENTIFIER_MAX_AGE_MS,
    rotationAtStart: false, rotations: [],
  }
  if (sessionAgeAtStartMs >= SESSION_ROTATE_AFTER_MS) {
    const rotation = await apiCall(baseUrl, { path: '/v1/session', cookie: `${sessionCookieName}=${liveCookieValue}` })
    assert.equal(rotation.status, 200, 'GET /v1/session must keep the session alive')
    const successor = sessionCookieOf(rotation.headers)
    assert.ok(successor, 'a session older than the rotation threshold must be rotated by GET /v1/session')
    liveCookieValue = successor
    session.rotationAtStart = true
  }

  const evidenceResult = await runWaveProof({
    wave: 40, schemaVersion: 'w40-consolidated/v1', baseUrl, sessionCookieName, sessionCookieValue: liveCookieValue,
    initial: { prefix, session, timing: {}, filters: [], navigation: [], actions: {}, fixtures: {} },
    async execute({ evidence, evidenceDir, launch, newSessionPage }) {
      const timing = evidence.timing
      // Plain-text trace next to the manifest (not part of it): shows where a stuck run stopped.
      const step = (label) => { try { appendFileSync(join(evidenceDir, 'w40-progress.log'), `${new Date().toISOString()} ${label}
`) } catch { /* the trace is best effort */ } }
      const phase = async (name, action) => {
        const phaseStart = Date.now()
        step(`phase ${name} start`)
        try { return await action() } finally { timing[name] = Date.now() - phaseStart; step(`phase ${name} end ${timing[name]} ms`) }
      }
      let contextA
      const currentCookie = async () => {
        const jar = await contextA.cookies(baseUrl)
        const value = jar.find((item) => item.name === sessionCookieName)?.value
        assert.ok(value, 'the browser holds the human session cookie')
        return `${sessionCookieName}=${value}`
      }
      /** Real rotation path: GET /v1/session with the cookie the browser holds; a successor goes back into the jar. */
      const refreshSession = async (label) => {
        const before = await currentCookie()
        const answer = await apiCall(baseUrl, { path: '/v1/session', cookie: before })
        assert.equal(answer.status, 200, `${label}: the human session must still be active`)
        const successor = sessionCookieOf(answer.headers)
        if (successor) {
          await contextA.addCookies([{ name: sessionCookieName, value: successor, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
          session.rotations.push({ at: label, ageMs: Date.now() - originalRow.issuedAt.getTime() })
        }
      }

      const who = await apiCall(baseUrl, { path: '/v1/session', cookie: `${sessionCookieName}=${liveCookieValue}` })
      assert.equal(who.status, 200, 'the human POST /v1/session cookie must be active when W40 starts')
      assert.equal(who.json.data.workspaceId, workspaceId)
      assert.equal(who.json.data.subject, username)
      const memberId = who.json.data.memberId
      await recordApplicationName(client, evidence)

      // =============================== fixtures (after every earlier baseline) ===============================
      const audit = { credentialId, environment: 'production', contextHash: 'c'.repeat(64) }
      const clientB = { id: 'w40-api-client-b' }
      clientB.authorization = await createBearer({ workspaceId, clientId: clientB.id, scopes: ['projects:read', 'projects:write'] })
      const create = (key, name) => createProjectViaApi({ baseUrl, authorization, name, key: `${prefix}-create-${key}` })
      const open = await create('open', names.open)
      const review = await create('review', names.review)
      const rename = await create('rename', names.rename)
      const archive = await create('archive', names.archive)
      const dup = await create('dup', names.dup)
      // Controlled PostgreSQL seeds (declared): the awaiting-review state needs a finished proxy operation and
      // one open annotation; the completed status is a non-trivial state to archive from (as in W38).
      const reviewOperationId = `${prefix}-review-op`
      await seedOperation(client, {
        workspaceId, clientId: apiClientId, projectId: review.project.id, id: reviewOperationId, targetId: sourceArtifactId, audit,
        createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 30_000), status: 'succeeded', phase: 'completed', completed: 4,
      })
      await seedAnnotations(client, {
        workspaceId, projectId: review.project.id, versionId: review.version.id, proxyArtifactId: sourceArtifactId,
        clientId: apiClientId, audit, suffix: prefix, status: 'open', count: 1,
      })
      await setProjectStatus(client, review.project.id, 'reviewing-proxy')
      await setProjectStatus(client, archive.project.id, 'completed')
      // The raw master of the duplicate source: real bytes hashed before the application sees them.
      const root = resolve(artifactRoot)
      assert.ok(basename(root).startsWith(ARTIFACT_ROOT_PREFIX) && !relative(resolve(tmpdir()), root).startsWith('..'), 'the artifact root is the temporary root created for this journey')
      const artifactId = `${prefix}-master`
      const artifactKey = `w40/${tag}/master-original.mp4`
      const masterPath = join(root, ...artifactKey.split('/'))
      await mkdir(join(root, 'w40', tag), { recursive: true })
      try {
        await run(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=12',
          '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', '-an',
          '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1', masterPath,
        ])
        const masterBytes = await readFile(masterPath)
        const masterSha256 = sha256(masterBytes)
        assert.ok(masterBytes.length > 1000)
        assert.equal(masterBytes.subarray(4, 8).toString('latin1'), 'ftyp')
        await artifacts.persistOrReplay({
          workspaceId, artifactId, manifestId: `${prefix}-master-manifest`, lineageIds: [],
          manifest: createMediaArtifactManifest({
            artifactKey, artifactSha256: masterSha256, byteSize: masterBytes.length, mediaType: 'video', container: 'mp4',
            recipe: { id: 'ingest-source', version: 'v1', parameters: {} }, probe: { width: 160, height: 120, duration: 1, fps: 12 },
          }),
          createdAt: new Date().toISOString(),
        })
        await client.v2ProjectMediaAsset.create({ data: {
          id: randomUUID(), workspaceId, projectId: dup.project.id, artifactId, role: 'source-master', originalFileName: 'master-original.mp4',
        } })
        const servedBefore = await apiCall(baseUrl, { path: `/v1/artifacts/${artifactId}/content`, authorization })
        assert.equal(servedBefore.status, 200)

        const fixtureOf = { open: open.project.id, review: review.project.id, rename: rename.project.id, archive: archive.project.id, dup: dup.project.id }
        const fixtureIds = Object.values(fixtureOf)
        const oracleBefore = Object.fromEntries(await Promise.all(Object.entries(fixtureOf).map(async ([key, id]) => [key, await projectOracle(client, workspaceId, id)])))
        const statusOf = { open: 'draft', review: 'reviewing-proxy', rename: 'draft', archive: 'completed', dup: 'draft' }
        for (const [key, oracle] of Object.entries(oracleBefore)) {
          assert.equal(oracle.project.status, statusOf[key], `${key}: persisted status`)
          assert.equal(oracle.project.administrationRevision, 1)
          assert.equal(oracle.administrationCommands.length, 0)
          assert.equal(oracle.versions.length, 1)
          assert.equal(oracle.events.length, 0)
        }
        const prefixRows = await client.v2Project.findMany({ where: { workspaceId, name: { contains: prefix, mode: 'insensitive' } }, select: { id: true } })
        assert.deepEqual(new Set(prefixRows.map((row) => row.id)), new Set(fixtureIds), 'PostgreSQL oracle: the prefix scopes exactly the five fixtures')
        const outsideDigest = async (workspace) => sha256(JSON.stringify(plain(await client.v2Project.findMany({
          where: { workspaceId: workspace, NOT: { name: { startsWith: prefix } } }, orderBy: { id: 'asc' },
          select: { id: true, name: true, status: true, administrationRevision: true, archivedFromStatus: true, currentVersionId: true, updatedAt: true },
        }))))
        const outsideBefore = { workspace: await outsideDigest(workspaceId), otherWorkspace: await outsideDigest(otherWorkspaceId) }
        evidence.fixtures = {
          open: { projectId: fixtureOf.open, origin: 'real-api' }, review: { projectId: fixtureOf.review, origin: 'real-api + controlled-pg-seed (reviewing-proxy, succeeded proxy render 4/4, 1 open annotation)' },
          rename: { projectId: fixtureOf.rename, origin: 'real-api' }, archive: { projectId: fixtureOf.archive, origin: 'real-api + controlled-pg-seed (status completed)' },
          dup: { projectId: fixtureOf.dup, origin: 'real-api + real master media (ffmpeg MPEG-4, sha256 of the bytes recorded)', versionId: dup.version.id, versionBaseHash: oracleBefore.dup.versions[0].baseHash, masterSha256, masterBytes: masterBytes.length, artifactId },
          clientB: { clientId: clientB.id, scopes: ['projects:read', 'projects:write'] },
        }
        const apiRows = async (text = prefix) => {
          const result = await apiCall(baseUrl, { path: `/v1/projects?limit=24&text=${encodeURIComponent(text)}`, authorization })
          assert.equal(result.status, 200)
          return Object.fromEntries(result.json.data.projects.map((item) => [item.id, {
            name: item.name, status: item.status, revision: item.dashboard.administrationRevision,
            archivedFromStatus: item.dashboard.archivedFromStatus, state: item.visibleState.label,
          }]))
        }
        const initialApi = await apiRows()
        assert.deepEqual(new Set(Object.keys(initialApi)), new Set(fixtureIds))

        // =============================== browser ===============================
        await launch()
        let page
        ;({ context: contextA, page } = await newSessionPage())
        const traffic = trackBrowserTraffic(page, baseUrl)
        const feed = recordFeed(page, baseUrl)
        page.on('request', (request) => {
          const url = new URL(request.url())
          if (url.origin === baseUrl && url.pathname.startsWith('/v1/') && url.pathname !== FEED_PATH) step(`request ${request.method()} ${url.pathname}`)
        })
        page.on('response', (response) => {
          const url = new URL(response.url())
          if (url.origin === baseUrl && url.pathname.startsWith('/v1/') && url.pathname !== FEED_PATH) step(`response ${response.status()} ${url.pathname}`)
        })
        page.on('requestfailed', (request) => step(`requestfailed ${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ''}`))
        const dialog = page.getByRole('dialog')
        const cardOf = (id) => page.locator(`article[data-project-id="${id}"]`)
        const mutatingMark = () => traffic.mutating().length
        const mutatingSince = (mark) => traffic.mutating().slice(mark)
        const requestCounts = (fromMark = 0) => {
          const slice = traffic.requests.slice(fromMark)
          const counts = {}
          for (const request of slice) {
            const path = request.path.replace(/\/projects\/[^/]+/, '/projects/{id}')
            const key = `${request.method} ${path}`
            counts[key] = (counts[key] ?? 0) + 1
          }
          return counts
        }
        const waitForWorkspace = async (projectId, fromIndex) => {
          const match = await waitFor(`workspace read of ${projectId}`, () => traffic.responses.slice(fromIndex).find((item) => item.method === 'GET' && item.path === `/v1/projects/${projectId}/workspace` && item.status === 200))
          return match.body
        }
        const expectCommands = (oracle, expected, label) => assert.deepEqual(
          oracle.administrationCommands.map((item) => [item.action, item.baseRevision, item.resultRevision, item.actorAuthenticationKind, item.actorClientId === apiClientId ? 'journey-client' : item.actorClientId]),
          expected, `${label}: persisted administration command history`)
        const openDashboard = async (facets, { expectIds } = {}) => {
          const params = facetsApiParams(facets)
          const expected = expectIds ?? (await oracleProjects(client, workspaceId, facets)).map((row) => row.id)
          const response = awaitProjectsResponse(page, params, expected)
          await page.goto(`${baseUrl}/${facetsUrlSearch(facets)}`, { waitUntil: 'domcontentloaded' })
          await response
          return expected
        }
        const textFacets = { ...EMPTY_FACETS, text: prefix }
        const cardSetFor = async (facets) => (await oracleProjects(client, workspaceId, facets))
        const expectedSearch = (facets) => canonicalQuery(new URLSearchParams(facetsUrlSearch(facets)))
        const waitForSearch = (facets) => page.waitForFunction((wanted) => {
          const canonical = [...new URLSearchParams(location.search).entries()].sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1)).map(([key, value]) => `${key}=${value}`).join('&')
          return canonical === wanted
        }, expectedSearch(facets))
        const countersBefore = await databaseCounts(client, workspaceId)

        // ---------------------------------- 1. filters and aggregate ----------------------------------
        await phase('filters-and-aggregate', async () => {
          await refreshSession('filters')
          const mark = mutatingMark()
          const requestMark = traffic.requests.length
          const expectedAll = await openDashboard(textFacets)
          assert.deepEqual(new Set(expectedAll), new Set(fixtureIds))
          await waitForCards(page, cardsOf(await cardSetFor(textFacets)))
          await waitForSettled(page)
          const tiles = await summaryCounters(page)
          const wantedTiles = expectedTiles(Object.values(statusOf))
          assert.deepEqual(tiles, wantedTiles, 'summary tiles equal the persisted statuses of the loaded fixtures')
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-desktop-baseline.png'))
          evidence.aggregate = { facets: { text: prefix }, tiles, expected: wantedTiles, ids: expectedAll }
          const caseDefinitions = [
            { id: 'text-only', facets: textFacets },
            { id: 'status-draft', facets: { ...textFacets, status: 'draft' } },
            { id: 'status-reviewing-proxy', facets: { ...textFacets, status: 'reviewing-proxy' } },
            { id: 'status-completed', facets: { ...textFacets, status: 'completed' } },
            { id: 'status-failed-empty', facets: { ...textFacets, status: 'failed' } },
            { id: 'status-archived-empty', facets: { ...textFacets, status: 'archived' } },
            { id: 'text-only-again', facets: textFacets },
          ]
          for (const item of caseDefinitions.slice(1)) {
            const rows = await cardSetFor(item.facets)
            const params = facetsApiParams(item.facets)
            const response = awaitProjectsResponse(page, params, rows.map((row) => row.id))
            await setControl(page, 'status', item.facets.status)
            const { body } = await response
            if (rows.length) await waitForCards(page, cardsOf(rows))
            else {
              await page.getByText('Nenhum projeto corresponde a esses filtros.').waitFor()
              assert.deepEqual(await cardIds(page), [])
            }
            await waitForSearch(item.facets)
            assert.deepEqual(await readControlValues(page), item.facets)
            const wanted = expectedTiles(rows.map((row) => row.status))
            assert.deepEqual(await summaryCounters(page), wanted, `${item.id}: tiles are the aggregate of the loaded results`)
            evidence.filters.push({ id: item.id, facets: item.facets, request: params, responseIds: body.data.projects.map((project) => project.id), domIds: await cardIds(page), url: expectedSearch(item.facets), tiles: wanted })
          }
          const mutating = mutatingSince(mark)
          assert.equal(mutating.length, 0, 'filters and aggregate read only')
          assert.deepEqual(await databaseCounts(client, workspaceId), countersBefore, 'Projects, Versions and Commands counters are stable while reading')
          evidence.readOnlyPhases = [{ phase: 'filters-and-aggregate', mutatingRequests: 0, requests: requestCounts(requestMark), counters: 'stable' }]
        })

        // ---------------------------------- 2. open, review and come back ----------------------------------
        await phase('open-review-and-return', async () => {
          await refreshSession('navigation')
          const mark = mutatingMark()
          const requestMark = traffic.requests.length
          const countersMark = await databaseCounts(client, workspaceId)
          const round = async ({ id, facets, targetId, targetName, buttonName, buttonExact, expected, screenshotName }) => {
            const rows = await cardSetFor(facets)
            if ((await readControlValues(page)).status !== facets.status) {
              const filtered = awaitProjectsResponse(page, facetsApiParams(facets), rows.map((row) => row.id))
              await setControl(page, 'status', facets.status)
              await filtered
            }
            await waitForCards(page, cardsOf(rows))
            await waitForSearch(facets)
            const from = traffic.responses.length
            await cardOf(targetId).getByRole('button', { name: buttonName, exact: buttonExact }).click()
            await page.waitForURL((url) => url.pathname === `/projects/${targetId}`)
            const landed = new URL(page.url())
            assert.equal(landed.pathname, `/projects/${targetId}`, `${id}: destination path`)
            assert.equal(landed.search, expected.search, `${id}: destination query`)
            const workspace = await waitForWorkspace(targetId, from)
            assert.equal(workspace.data.project.id, targetId)
            assert.equal(workspace.data.project.name, targetName)
            await page.getByText(targetName, { exact: true }).first().waitFor()
            if (screenshotName) evidence.screenshots.push(await screenshot(page, evidenceDir, screenshotName))
            // Back to the dashboard: the filters survive, the cards equal the oracle again.
            const returned = awaitProjectsResponse(page, facetsApiParams(facets), rows.map((row) => row.id))
            await page.goBack({ waitUntil: 'domcontentloaded' })
            await returned
            await waitForCards(page, cardsOf(rows))
            await waitForSearch(facets)
            assert.deepEqual(await readControlValues(page), facets, `${id}: filters restored after coming back`)
            assert.equal(new URL(page.url()).pathname, '/')
            evidence.navigation.push({
              id, button: expected.button, projectId: targetId, destination: { pathname: landed.pathname, search: landed.search },
              workspaceStatus: 200, workspaceProjectName: workspace.data.project.name,
              returned: { search: expectedSearch(facets), controls: facets, ids: rows.map((row) => row.id) },
            })
          }
          const draftFacets = { ...textFacets, status: 'draft' }
          await round({ id: 'open-primary-draft', facets: draftFacets, targetId: fixtureOf.open, targetName: names.open, buttonName: /^Abrir workspace/, buttonExact: false, expected: { button: 'Abrir workspace', search: '' }, screenshotName: 'w40-desktop-editor-open.png' })
          await round({ id: 'open-secondary-draft', facets: draftFacets, targetId: fixtureOf.open, targetName: names.open, buttonName: 'Abrir', buttonExact: true, expected: { button: 'Abrir', search: '' } })
          const reviewFacets = { ...textFacets, status: 'reviewing-proxy' }
          await round({ id: 'review-primary', facets: reviewFacets, targetId: fixtureOf.review, targetName: names.review, buttonName: /^Revisar agora/, buttonExact: false, expected: { button: 'Revisar agora', search: '?mode=review' }, screenshotName: 'w40-desktop-editor-review.png' })
          await round({ id: 'review-secondary', facets: reviewFacets, targetId: fixtureOf.review, targetName: names.review, buttonName: 'Revisar', buttonExact: true, expected: { button: 'Revisar', search: '?mode=review' } })
          // Leave the filters as they were at the start of the journey.
          const rows = await cardSetFor(textFacets)
          const cleared = awaitProjectsResponse(page, facetsApiParams(textFacets), rows.map((row) => row.id))
          await setControl(page, 'status', '')
          await cleared
          await waitForCards(page, cardsOf(rows))
          assert.equal(mutatingSince(mark).length, 0, 'navigation sent no mutating request')
          assert.deepEqual(await databaseCounts(client, workspaceId), countersMark)
          evidence.readOnlyPhases.push({ phase: 'open-review-and-return', mutatingRequests: 0, requests: requestCounts(requestMark), counters: 'stable' })
        })

        // ---------------------------------- 3. a change by another client arrives through the W36 feed ----------------------------------
        await phase('change-by-another-client', async () => {
          await refreshSession('feed')
          await waitForSettled(page)
          const markers = { documentId: await page.evaluate(() => { window.__w40Doc = crypto.randomUUID(); return window.__w40Doc }) }
          const feedMark = feed.mark()
          const requestMark = traffic.requests.length
          const mutMark = mutatingMark()
          // The feed starts at the head when the dashboard mounts: wait for a cursor poll of the mounted page, so the change below is after that head.
          const bootMark = feed.mark()
          await waitFor('a cursor poll of the mounted dashboard', () => feed.since(bootMark).some((entry) => entry.hadCursor && entry.status === 200), 30_000)
          const before = await projectOracle(client, workspaceId, fixtureOf.open)
          const refetched = page.waitForResponse(async (response) => {
            if (!listPathMatches(response, prefix)) return false
            const body = await response.json()
            return body.data.projects.some((item) => item.id === fixtureOf.open && item.name === names.openByClientB)
          })
          const mutation = await apiCall(baseUrl, {
            method: 'POST', path: `/v1/projects/${fixtureOf.open}/rename`, authorization: clientB.authorization,
            headers: { 'idempotency-key': `${prefix}-clientb-rename-open` }, body: { baseRevision: 1, name: names.openByClientB },
          })
          assert.equal(mutation.status, 200, mutation.text)
          const mutationAt = Date.now()
          const after = await projectOracle(client, workspaceId, fixtureOf.open)
          assert.equal(after.project.name, names.openByClientB)
          assert.equal(after.project.administrationRevision, 2)
          expectCommands(after, [['rename', 1, 2, 'bearer', clientB.id]], 'open')
          assert.equal(after.events.length, 1)
          assert.equal(after.events[0].type, 'project.name.changed')
          assert.equal(after.events[0].id, after.administrationCommands[0].eventId)
          const feedEntry = await waitFor('the feed delivers the event written by client B', () => feed.since(feedMark).find((entry) => entry.eventIds.includes(after.events[0].id)), 40_000)
          const refetchResponse = await refetched
          const refetchBody = await refetchResponse.json()
          await waitForCardName(page, fixtureOf.open, names.openByClientB)
          const domAt = Date.now()
          const row = refetchBody.data.projects.find((item) => item.id === fixtureOf.open)
          assert.equal(row.dashboard.administrationRevision, 2)
          assert.equal(row.status, 'draft')
          assert.equal(await page.evaluate(() => window.__w40Doc), markers.documentId, 'the document was not reloaded')
          assert.equal(mutatingSince(mutMark).length, 0, 'the browser sent no mutating request; the change came from another client')
          const counts = requestCounts(requestMark)
          assert.ok((counts[`GET ${FEED_PATH}`] ?? 0) >= 1, 'the feed was polled after the change')
          assert.ok((counts['GET /v1/projects'] ?? 0) >= 1, 'the dashboard refetched in the background')
          assert.deepEqual(Object.fromEntries(Object.entries(counts).filter(([key]) => key.startsWith('POST') || key.startsWith('PATCH') || key.startsWith('DELETE'))), {})
          assert.equal((await cardSnapshot(page, fixtureOf.open)).name, names.openByClientB)
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-desktop-feed-update.png'))
          evidence.feed = {
            actor: { clientId: clientB.id, authentication: 'bearer', scopes: ['projects:read', 'projects:write'] },
            request: { method: 'POST', path: '/v1/projects/{id}/rename', body: { baseRevision: 1, name: names.openByClientB } },
            command: commandSummary(after.administrationCommands[0]),
            event: { id: after.events[0].id, type: after.events[0].type },
            feedResponse: { status: feedEntry.status, hadCursor: feedEntry.hadCursor, containsEventId: true },
            refetch: { status: 200, revision: row.dashboard.administrationRevision, name: row.name },
            card: { name: names.openByClientB, revision: 2 }, documentReloaded: false, browserMutatingRequests: 0,
            requestCountsSinceChange: counts,
            timeline: { mutationToFeedMs: feedEntry.at - mutationAt, mutationToDomMs: domAt - mutationAt },
            persistedBefore: projectRowSummary(before.project), persistedAfter: projectRowSummary(after.project),
          }
        })

        // ---------------------------------- 4. administrative mutations from the cards ----------------------------------
        const actions = evidence.actions
        const browserRequests = []
        const recordBrowserRequests = (mark) => { for (const item of mutatingSince(mark)) browserRequests.push(sanitizedRequest(item)) }

        // 4a. rename: no optimistic update, then stale 409 from another client, then the safe recovery.
        await phase('rename', async () => {
          await refreshSession('rename')
          const target = fixtureOf.rename
          const before = oracleBefore.rename
          const mark = mutatingMark()
          const hold = await holdRequest(page, /\/v1\/projects\/[^/]+\/rename$/)
          await cardOf(target).getByRole('button', { name: 'Renomear', exact: true }).click()
          await dialog.waitFor()
          assert.match(await dialog.innerText(), /revisão administrativa 1\b/)
          await dialog.getByLabel('Nome').fill(names.renameUi)
          await dialog.getByRole('button', { name: 'Salvar nome' }).click()
          assert.equal(await within('the held rename request', hold.held), 'POST')
          const during = await projectOracle(client, workspaceId, target)
          assert.equal(during.project.name, names.rename, 'nothing is persisted while the request is held')
          assert.equal(during.administrationCommands.length, 0)
          assert.equal((await cardSnapshot(page, target)).name, names.rename, 'no optimistic card update')
          await dialog.getByRole('button', { name: /Aplicando/ }).waitFor()
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-desktop-rename-pending.png'))
          const refetch = page.waitForResponse(async (response) => {
            if (!listPathMatches(response, prefix)) return false
            return (await response.json()).data.projects.some((item) => item.id === target && item.name === names.renameUi)
          })
          hold.release()
          await dialog.waitFor({ state: 'hidden' })
          await refetch
          await hold.dispose()
          await waitForCardName(page, target, names.renameUi)
          const posts = mutatingSince(mark)
          assert.equal(posts.length, 1)
          const posted = posts[0]
          assert.equal(posted.path, `/v1/projects/${target}/rename`)
          assert.deepEqual(JSON.parse(posted.postData), { baseRevision: 1, name: names.renameUi })
          const response = traffic.responses.find((item) => item.method === 'POST' && item.path === posted.path)
          assert.equal(response.status, 200)
          const body = await response.body
          assert.equal(body.data.command.resultRevision, 2)
          assert.equal(body.data.replayed, false)
          const after = await projectOracle(client, workspaceId, target)
          expectCommands(after, [['rename', 1, 2, 'ui-session', 'journey-client']], 'rename after the UI rename')
          const command = after.administrationCommands[0]
          assert.equal(command.id, body.data.command.id)
          assert.equal(command.idempotencyKey, posted.idempotencyKey)
          assert.equal(command.delegatedUserId, memberId)
          assert.deepEqual(after.versions, before.versions)
          assert.deepEqual(after.snapshots, before.snapshots)
          assert.equal(after.events.length, 1)
          assert.equal(after.events[0].id, command.eventId)
          const replay = await apiCall(baseUrl, { method: 'POST', path: posted.path, cookie: await currentCookie(), origin: true, headers: { 'idempotency-key': posted.idempotencyKey }, body: { baseRevision: 1, name: names.renameUi } })
          assert.equal(replay.status, 200)
          assert.equal(replay.json.data.replayed, true)
          assert.equal(replay.json.data.command.id, command.id)
          assert.equal((await projectOracle(client, workspaceId, target)).administrationCommands.length, 1, 'replay wrote no second command')
          recordBrowserRequests(mark)
          actions.rename = {
            request: sanitizedRequest(posted), responseStatus: 200, command: commandSummary(command), event: { id: after.events[0].id, type: after.events[0].type },
            pendingCardName: names.rename, confirmedCardName: names.renameUi, projectChangedKeys: ['administrationRevision', 'name', 'updatedAt'], replayStatus: 200,
          }

          // stale: the dialog is open at revision 2, client B renames (revision 3), the browser is refused with 409.
          const staleMark = mutatingMark()
          const feedHold = await holdFeedPoll(page)
          await within('the next feed poll to be held', feedHold.held, 15_000)
          await cardOf(target).getByRole('button', { name: 'Renomear', exact: true }).click()
          await dialog.waitFor()
          assert.match(await dialog.innerText(), /revisão administrativa 2\b/)
          await dialog.getByLabel('Nome').fill(names.renameRefused)
          const other = await apiCall(baseUrl, {
            method: 'POST', path: posted.path, authorization: clientB.authorization,
            headers: { 'idempotency-key': `${prefix}-clientb-rename-target` }, body: { baseRevision: 2, name: names.renameOther },
          })
          assert.equal(other.status, 200, other.text)
          assert.equal(other.json.data.administration.revision, 3)
          const stale = page.waitForResponse((item) => item.url().endsWith(posted.path) && item.request().method() === 'POST')
          await dialog.getByRole('button', { name: 'Salvar nome' }).click()
          const staleResponse = await stale
          assert.equal(staleResponse.status(), 409)
          const staleBody = await staleResponse.json()
          assert.equal(staleBody.error.code, 'VERSION_CONFLICT')
          assert.equal(staleBody.error.category, 'conflict')
          await dialog.getByRole('alert').waitFor()
          const alertText = (await dialog.getByRole('alert').innerText()).trim()
          assert.ok(alertText.length > 0)
          await dialog.getByText(/revisão administrativa 3\b/).waitFor()
          await waitForCardName(page, target, names.renameOther)
          const afterStale = await projectOracle(client, workspaceId, target)
          assert.equal(afterStale.project.name, names.renameOther)
          assert.equal(afterStale.project.administrationRevision, 3)
          expectCommands(afterStale, [['rename', 1, 2, 'ui-session', 'journey-client'], ['rename', 2, 3, 'bearer', clientB.id]], 'rename after the stale attempt')
          assert.notEqual((await cardSnapshot(page, target)).name, names.renameRefused, 'the card never showed the refused name')
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-desktop-rename-conflict.png'))
          pushCase(evidence, {
            id: 'stale-rename-409', request: { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'human session (browser)', baseRevision: 2 },
            expected: { status: 409, code: 'VERSION_CONFLICT', persistedName: names.renameOther, browserCommandsWritten: 0, errorVisibleInDialog: true },
            observed: { status: 409, code: staleBody.error.code, category: staleBody.error.category, persistedName: afterStale.project.name, persistedRevision: 3, browserCommandsWritten: 0, errorVisibleInDialog: true, dialogRevisionAfterRefetch: 3, cardName: names.renameOther },
            realState: 'another client changed the revision before the browser submitted',
            timingAid: 'the dashboard feed poll was held until the refused request returned, so the live revision could not be refreshed early',
            persistedUnchanged: true, card: { name: names.renameOther, persistedName: afterStale.project.name, persistedRevision: 3 },
          })
          feedHold.release()
          await feedHold.dispose()
          // safe retry: the dialog now carries the live revision and a new key.
          await dialog.getByLabel('Nome').fill(names.renameRecovered)
          await dialog.getByRole('button', { name: 'Salvar nome' }).click()
          await dialog.waitFor({ state: 'hidden' })
          await waitForCardName(page, target, names.renameRecovered)
          const afterRecovery = await projectOracle(client, workspaceId, target)
          expectCommands(afterRecovery, [['rename', 1, 2, 'ui-session', 'journey-client'], ['rename', 2, 3, 'bearer', clientB.id], ['rename', 3, 4, 'ui-session', 'journey-client']], 'rename after the recovery')
          assert.deepEqual(afterRecovery.administrationCommands.slice(0, 2), afterStale.administrationCommands, 'earlier history untouched')
          const browserPosts = mutatingSince(staleMark)
          assert.deepEqual(browserPosts.map((item) => JSON.parse(item.postData).baseRevision), [2, 3])
          assert.equal(new Set(browserPosts.map((item) => item.idempotencyKey)).size, 2, 'the recovery uses a new key')
          recordBrowserRequests(staleMark)
          pushCase(evidence, { id: 'recovery-after-409', expected: { status: 200, baseRevision: 3, resultRevision: 4 }, observed: { status: 200, baseRevision: 3, resultRevision: 4, cardName: names.renameRecovered } })
        })

        // 4b. archive and restore from a completed project: cancel, stale 409, confirm, restore.
        await phase('archive-and-restore', async () => {
          await refreshSession('archive')
          const target = fixtureOf.archive
          const before = oracleBefore.archive
          const mark = mutatingMark()
          const countersBeforeArchive = await summaryCounters(page)
          assert.equal(countersBeforeArchive.Concluídos, 1)
          assert.equal((await cardSnapshot(page, target)).state, 'completed')
          // cancel: zero POST, zero command.
          await cardOf(target).getByRole('button', { name: 'Arquivar', exact: true }).click()
          await dialog.waitFor()
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-desktop-archive-dialog.png'))
          await dialog.getByRole('button', { name: 'Cancelar' }).click()
          await dialog.waitFor({ state: 'hidden' })
          assert.equal(mutatingSince(mark).length, 0)
          assert.deepEqual((await projectOracle(client, workspaceId, target)).administrationCommands, [])
          // stale: client B renames while the dialog is open at revision 1.
          const feedHold = await holdFeedPoll(page)
          await within('the next feed poll to be held', feedHold.held, 15_000)
          await cardOf(target).getByRole('button', { name: 'Arquivar', exact: true }).click()
          await dialog.waitFor()
          assert.match(await dialog.innerText(), /revisão administrativa 1\b/)
          const other = await apiCall(baseUrl, {
            method: 'POST', path: `/v1/projects/${target}/rename`, authorization: clientB.authorization,
            headers: { 'idempotency-key': `${prefix}-clientb-rename-archive` }, body: { baseRevision: 1, name: names.archiveOther },
          })
          assert.equal(other.status, 200, other.text)
          const stale = page.waitForResponse((item) => item.url().endsWith(`/v1/projects/${target}/archive`) && item.request().method() === 'POST')
          await dialog.getByRole('button', { name: 'Confirmar arquivamento' }).click()
          const staleResponse = await stale
          assert.equal(staleResponse.status(), 409)
          const staleBody = await staleResponse.json()
          assert.equal(staleBody.error.code, 'VERSION_CONFLICT')
          await dialog.getByRole('alert').waitFor()
          await dialog.getByText(/revisão administrativa 2\b/).waitFor()
          const afterStale = await projectOracle(client, workspaceId, target)
          assert.equal(afterStale.project.status, 'completed', 'the refused archive did not archive')
          assert.equal(afterStale.project.archivedFromStatus, null)
          expectCommands(afterStale, [['rename', 1, 2, 'bearer', clientB.id]], 'archive fixture after the stale attempt')
          assert.equal((await cardSnapshot(page, target)).state, 'completed')
          pushCase(evidence, {
            id: 'stale-archive-409', request: { method: 'POST', path: '/v1/projects/{id}/archive', auth: 'human session (browser)', baseRevision: 1 },
            expected: { status: 409, code: 'VERSION_CONFLICT', persistedStatus: 'completed', browserCommandsWritten: 0, errorVisibleInDialog: true },
            observed: { status: 409, code: staleBody.error.code, category: staleBody.error.category, persistedStatus: 'completed', browserCommandsWritten: 0, errorVisibleInDialog: true, dialogRevisionAfterRefetch: 2, cardState: 'completed' },
            realState: 'another client renamed the project before the browser confirmed',
            timingAid: 'the dashboard feed poll was held until the refused request returned, so the live revision could not be refreshed early',
            persistedUnchanged: true, card: { state: 'completed', persistedStatus: afterStale.project.status, persistedRevision: afterStale.project.administrationRevision },
          })
          feedHold.release()
          await feedHold.dispose()
          // confirm on the live revision.
          const refetchArchived = page.waitForResponse(async (response) => listPathMatches(response, prefix) && (await response.json()).data.projects.some((item) => item.id === target && item.status === 'archived'))
          await dialog.getByRole('button', { name: 'Confirmar arquivamento' }).click()
          await dialog.waitFor({ state: 'hidden' })
          await refetchArchived
          await waitForCardState(page, target, 'archived')
          const afterArchive = await projectOracle(client, workspaceId, target)
          assert.equal(afterArchive.project.status, 'archived')
          assert.equal(afterArchive.project.archivedFromStatus, 'completed')
          assert.equal(afterArchive.project.administrationRevision, 3)
          assert.equal(afterArchive.project.currentVersionId, before.project.currentVersionId)
          expectCommands(afterArchive, [['rename', 1, 2, 'bearer', clientB.id], ['archive', 2, 3, 'ui-session', 'journey-client']], 'archive fixture after the archive')
          const archiveCommand = afterArchive.administrationCommands[1]
          assert.equal(archiveCommand.confirmation, 'explicit')
          assert.equal(archiveCommand.beforeStatus, 'completed')
          assert.equal(archiveCommand.afterArchivedFromStatus, 'completed')
          assert.deepEqual(afterArchive.versions, before.versions)
          assert.deepEqual(afterArchive.snapshots, before.snapshots)
          assert.equal(afterArchive.events.length, 2)
          assert.equal(afterArchive.events[1].id, archiveCommand.eventId)
          const archivedCard = await cardSnapshot(page, target)
          assert.equal(archivedCard.enabledButtons.Restaurar, true)
          assert.equal(archivedCard.enabledButtons.Arquivar, false)
          assert.equal((await summaryCounters(page)).Concluídos, 0, 'the completed counter drops while archived')
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-desktop-archived.png'))
          // restore: exact previous status, monotonic revision, history intact.
          const refetchRestored = page.waitForResponse(async (response) => listPathMatches(response, prefix) && (await response.json()).data.projects.some((item) => item.id === target && item.status === 'completed'))
          await cardOf(target).getByRole('button', { name: 'Restaurar', exact: true }).click()
          await refetchRestored
          await waitForCardState(page, target, 'completed')
          const afterRestore = await projectOracle(client, workspaceId, target)
          assert.equal(afterRestore.project.status, 'completed')
          assert.equal(afterRestore.project.archivedFromStatus, null)
          assert.equal(afterRestore.project.administrationRevision, 4)
          expectCommands(afterRestore, [['rename', 1, 2, 'bearer', clientB.id], ['archive', 2, 3, 'ui-session', 'journey-client'], ['restore', 3, 4, 'ui-session', 'journey-client']], 'archive fixture after the restore')
          const restoreCommand = afterRestore.administrationCommands[2]
          assert.equal(restoreCommand.beforeArchivedFromStatus, 'completed')
          assert.equal(restoreCommand.afterStatus, 'completed')
          assert.deepEqual(afterRestore.administrationCommands.slice(0, 2), afterArchive.administrationCommands, 'earlier history untouched')
          assert.deepEqual(afterRestore.versions, before.versions)
          assert.deepEqual(afterRestore.snapshots, before.snapshots)
          assert.equal((await summaryCounters(page)).Concluídos, 1, 'the completed counter returns after the restore')
          const posts = mutatingSince(mark)
          assert.deepEqual(posts.map((item) => `${item.method} ${item.path.replace(target, '{id}')}`), ['POST /v1/projects/{id}/archive', 'POST /v1/projects/{id}/archive', 'POST /v1/projects/{id}/restore'])
          assert.deepEqual(posts.map((item) => JSON.parse(item.postData)), [{ baseRevision: 1, confirmed: true }, { baseRevision: 2, confirmed: true }, { baseRevision: 3 }])
          recordBrowserRequests(mark)
          actions.archive = {
            cancelledMutatingRequests: 0, archive: { command: commandSummary(archiveCommand), cardState: 'archived', counterConcluidos: 0 },
            restore: { command: commandSummary(restoreCommand), cardState: 'completed', counterConcluidos: 1 },
            previousStatus: 'completed', versionsIdentical: true, snapshotsIdentical: true,
            finalProject: projectRowSummary(afterRestore.project),
          }
        })

        // 4c. duplicate from the card: new identity, copy-on-write, lineage, a Command on the copy, stale base.
        await phase('duplicate', async () => {
          await refreshSession('duplicate')
          const sourceId = fixtureOf.dup
          const before = oracleBefore.dup
          const sourceVersion = before.versions[0]
          const storageBefore = await storageInventory(root, `w40/${tag}/`)
          assert.deepEqual(storageBefore.map((file) => [file.key, file.bytes, file.sha256]), [[artifactKey, masterBytes.length, masterSha256]])
          const artifactRow = await client.v2MediaArtifact.findUnique({ where: { id: artifactId } })
          assert.equal(artifactRow.sha256, masterSha256)
          const workspaceArtifactsBefore = await client.v2MediaArtifact.count({ where: { workspaceId } })
          const projectsBefore = await client.v2Project.count({ where: { workspaceId } })
          const mark = mutatingMark()
          const responseMark = traffic.responses.length
          const duplicated = page.waitForResponse((item) => item.url().endsWith(`/v1/projects/${sourceId}/duplicates`) && item.request().method() === 'POST')
          await cardOf(sourceId).getByRole('button', { name: 'Duplicar', exact: true }).click()
          const duplicateResponse = await duplicated
          assert.equal(duplicateResponse.status(), 201)
          const duplicatedBody = await duplicateResponse.json()
          const copyId = duplicatedBody.data.project.id
          const copyVersionId = duplicatedBody.data.version.id
          assert.notEqual(copyId, sourceId)
          await page.waitForURL(`**/projects/${copyId}`)
          const destination = await waitForWorkspace(copyId, responseMark)
          assert.equal(destination.data.project.name, names.copy)
          assert.deepEqual(destination.data.media.map((item) => [item.artifactId, item.role, item.sha256]), [[artifactId, 'source-master', masterSha256]])
          await page.getByText(names.copy, { exact: true }).first().waitFor()
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-desktop-duplicate-destination.png'))
          const posts = mutatingSince(mark)
          assert.equal(posts.length, 1)
          const posted = posts[0]
          assert.deepEqual(JSON.parse(posted.postData), { expectedVersionId: sourceVersion.id, expectedVersionHash: sourceVersion.baseHash, name: names.copy })
          assert.deepEqual(duplicatedBody.data.sharedArtifactIds, [artifactId])
          assert.equal(duplicatedBody.data.copiedBytes, 0)
          assert.equal(duplicatedBody.data.replayed, false)
          const sourceAfter = await projectOracle(client, workspaceId, sourceId)
          const copyAfter = await projectOracle(client, workspaceId, copyId)
          assert.deepEqual(sourceAfter.project, before.project, 'the source row is untouched')
          assert.deepEqual(sourceAfter.versions, before.versions)
          assert.deepEqual(sourceAfter.snapshots, before.snapshots)
          assert.equal(copyAfter.project.name, names.copy)
          assert.equal(copyAfter.project.status, 'draft')
          assert.equal(copyAfter.project.duplicatedFromProjectId, sourceId)
          assert.equal(copyAfter.project.currentVersionId, copyVersionId)
          assert.equal(copyAfter.project.administrationRevision, 1)
          assert.equal(copyAfter.versions.length, 1)
          const copyVersion = copyAfter.versions[0]
          assert.equal(copyVersion.forkedFromProjectId, sourceId)
          assert.equal(copyVersion.forkedFromVersionId, sourceVersion.id)
          assert.equal(copyVersion.parentVersionId, null)
          assert.notEqual(copyVersion.baseHash, sourceVersion.baseHash, 'the copy version binds its own identity')
          const refs = (version) => ({
            brief: version.briefSnapshotId, ...(version.treatmentSnapshotId ? { treatment: version.treatmentSnapshotId } : {}),
            ...(version.storySnapshotId ? { story: version.storySnapshotId } : {}), editPlan: version.editPlanSnapshotId, policies: version.policiesSnapshotId,
          })
          assert.equal(copyVersion.baseHash, calculateVersionHash({ projectId: copyId, sequence: 1, forkedFromProjectId: sourceId, forkedFromVersionId: sourceVersion.id, snapshotRefs: refs(sourceVersion) }), 'the hash follows the duplication contract')
          const referenced = new Set(Object.values(refs(sourceVersion)))
          const snapshotPairs = []
          for (const original of before.snapshots.filter((row) => referenced.has(row.id))) {
            const copySnapshot = copyAfter.snapshots.find((row) => row.kind === original.kind)
            assert.ok(copySnapshot, `the copy has a ${original.kind} snapshot`)
            assert.notEqual(copySnapshot.id, original.id)
            assert.equal(copySnapshot.projectId, copyId)
            const parsed = JSON.parse(copySnapshot.contentJson)
            assert.equal(copySnapshot.contentJson, stableSerialize(parsed))
            assert.equal(copySnapshot.contentHash, calculateCanonicalHash(parsed), 'the stored hash is the canonical hash of the stored content')
            const rebound = original.kind === 'edit-plan'
            if (rebound) {
              assert.equal(parsed.projectVersionId, copyVersionId)
              assert.notEqual(copySnapshot.contentHash, original.contentHash)
            } else {
              assert.equal(copySnapshot.contentJson, original.contentJson)
              assert.equal(copySnapshot.contentHash, original.contentHash)
            }
            snapshotPairs.push({ kind: original.kind, rebound, contentHash: original.contentHash, copyContentHash: copySnapshot.contentHash })
          }
          assert.equal(copyAfter.creationCommand.action, 'duplicate')
          assert.equal(copyAfter.creationCommand.sourceProjectId, sourceId)
          assert.equal(copyAfter.creationCommand.sourceVersionId, sourceVersion.id)
          assert.equal(copyAfter.creationCommand.actorAuthenticationKind, 'ui-session')
          assert.equal(copyAfter.creationCommand.actorDelegatedUserId, memberId)
          const refsAfter = await client.v2ProjectMediaAsset.findMany({ where: { workspaceId, artifactId } })
          assert.equal(refsAfter.length, 2)
          assert.deepEqual(new Set(refsAfter.map((row) => row.projectId)), new Set([sourceId, copyId]))
          assert.equal(await client.v2MediaArtifact.count({ where: { workspaceId } }), workspaceArtifactsBefore, 'no artifact was created')
          assert.deepEqual(plain(await client.v2MediaArtifact.findUnique({ where: { id: artifactId } })), plain(artifactRow), 'the immutable artifact row is unchanged')
          const storageAfter = await storageInventory(root, `w40/${tag}/`)
          assert.deepEqual(storageAfter, storageBefore, 'no object was written, rewritten or copied')
          assert.equal(await client.v2Project.count({ where: { workspaceId } }), projectsBefore + 1)
          assert.equal(copyAfter.administrationCommands.length, 0)
          // The dashboard lists both cards; the copy follows the source's configuration.
          const listed = awaitProjectsResponse(page, facetsApiParams(textFacets), (await oracleProjects(client, workspaceId, textFacets)).map((row) => row.id))
          await page.goto(`${baseUrl}/${facetsUrlSearch(textFacets)}`, { waitUntil: 'domcontentloaded' })
          await listed
          await waitForCardSet(page, [...fixtureIds, copyId])
          await waitForSettled(page)
          assert.equal((await cardSnapshot(page, copyId)).name, names.copy)
          assert.equal((await cardSnapshot(page, copyId)).state, 'draft')
          assert.deepEqual(await summaryCounters(page), expectedTiles([...Object.values(statusOf), 'draft']), 'the aggregate counts the copy')
          // A Command on the copy moves only the copy.
          const command = await apiCall(baseUrl, {
            method: 'POST', path: `/v1/projects/${copyId}/lut-selection`, authorization, headers: { 'idempotency-key': `${prefix}-copy-lut-none` },
            body: { baseVersionId: copyVersionId, baseHash: copyVersion.baseHash, selection: { mode: 'none' } },
          })
          assert.equal(command.status, 201, command.text)
          const copyMoved = await projectOracle(client, workspaceId, copyId)
          const sourceMoved = await projectOracle(client, workspaceId, sourceId)
          assert.equal(copyMoved.versions.length, 2)
          assert.equal(copyMoved.editCommandCount, 1)
          assert.equal(copyMoved.versions[1].parentVersionId, copyVersionId)
          assert.deepEqual(copyMoved.versions[0], copyAfter.versions[0], 'the copy first version is immutable')
          assert.deepEqual(sourceMoved.project, before.project)
          assert.deepEqual(sourceMoved.versions, before.versions)
          assert.deepEqual(sourceMoved.snapshots, before.snapshots)
          assert.equal(sourceMoved.editCommandCount, 0)
          assert.deepEqual(await storageInventory(root, `w40/${tag}/`), storageBefore)
          const reload = awaitProjectsResponse(page, facetsApiParams(textFacets), (await oracleProjects(client, workspaceId, textFacets)).map((row) => row.id))
          await page.reload({ waitUntil: 'domcontentloaded' })
          await reload
          await waitForCardSet(page, [...fixtureIds, copyId])
          await waitForSettled(page)
          assert.equal((await cardSnapshot(page, copyId)).version, 'v2')
          assert.equal((await cardSnapshot(page, sourceId)).version, 'v1')
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-desktop-duplicate-dashboard.png'))
          // Stale base: the copy moved to v2, so duplicating it from v1 is refused with the live version.
          const staleDuplicate = await apiCall(baseUrl, {
            method: 'POST', path: `/v1/projects/${copyId}/duplicates`, authorization, headers: { 'idempotency-key': `${prefix}-stale-copy-v1` },
            body: { expectedVersionId: copyVersionId, expectedVersionHash: copyVersion.baseHash, name: `${prefix}-nao-deve-gravar-copia` },
          })
          const staleObserved = assertRefusal(staleDuplicate, { status: 409, code: 'VERSION_CONFLICT', category: 'conflict' })
          assert.equal(staleDuplicate.json.error.details?.currentVersionId, copyMoved.versions[1].id)
          assert.equal(await client.v2Project.count({ where: { workspaceId } }), projectsBefore + 1, 'the refused duplication created nothing')
          pushCase(evidence, { id: 'stale-duplicate-409', request: { method: 'POST', path: '/v1/projects/{copyId}/duplicates', auth: 'bearer projects:write' }, expected: { status: 409, code: 'VERSION_CONFLICT' }, observed: { ...staleObserved, currentVersionCarried: true }, persistedUnchanged: true, card: { name: names.copy, version: (await cardSnapshot(page, copyId)).version }, realState: 'the copy really is at version 2' })
          const replay = await apiCall(baseUrl, { method: 'POST', path: `/v1/projects/${sourceId}/duplicates`, cookie: await currentCookie(), origin: true, headers: { 'idempotency-key': posted.idempotencyKey }, body: JSON.parse(posted.postData) })
          assert.equal(replay.status, 200, replay.text)
          assert.equal(replay.json.data.replayed, true)
          assert.equal(replay.json.data.project.id, copyId)
          assert.equal(replay.json.data.version.id, copyVersionId)
          assert.equal(replay.json.data.copiedBytes, 0)
          assert.equal(await client.v2Project.count({ where: { workspaceId } }), projectsBefore + 1, 'the replay after the copy moved created nothing')
          recordBrowserRequests(mark)
          actions.duplicate = {
            request: sanitizedRequest(posted), responseStatus: 201, replayAfterCommandStatus: 200,
            copy: { projectId: copyId, versionId: copyVersionId, project: projectRowSummary(copyAfter.project) },
            lineage: { duplicatedFromProjectId: sourceId, forkedFromProjectId: copyVersion.forkedFromProjectId, forkedFromVersionId: copyVersion.forkedFromVersionId, parentVersionId: copyVersion.parentVersionId },
            versionHash: { source: sourceVersion.baseHash, copy: copyVersion.baseHash, differs: true, followsContractFormula: true },
            snapshots: snapshotPairs,
            creationCommand: { action: copyAfter.creationCommand.action, actorAuthenticationKind: copyAfter.creationCommand.actorAuthenticationKind, hasDelegatedUser: true },
            sharedArtifactIds: duplicatedBody.data.sharedArtifactIds, copiedBytes: duplicatedBody.data.copiedBytes,
            objectCounts: { projectReferences: refsAfter.length, workspaceMediaArtifacts: workspaceArtifactsBefore, storageObjects: storageAfter.length },
            storage: storageAfter.map(({ key, bytes, sha256: hash }) => ({ key, bytes, sha256: hash })),
            master: { sha256: masterSha256, bytes: masterBytes.length, unchanged: true },
            destination: { urlPath: `/projects/${copyId}`, workspaceStatus: 200, mediaArtifactIds: destination.data.media.map((item) => item.artifactId) },
            commandOnCopy: { type: 'set-project-lut-selection', copyVersionSequenceAfter: 2, copyEditCommands: copyMoved.editCommandCount, sourceEditCommands: sourceMoved.editCommandCount, cards: { source: 'v1', copy: 'v2' } },
            sourceUnchanged: true,
          }
          evidence.fixtures.copy = { projectId: copyId, versionId: copyVersionId }
        })

        // ---------------------------------- 5. security and transport failures from real state ----------------------------------
        const sensitive = { target: fixtureOf.rename }
        const stateOf = async () => {
          const oracle = await projectOracle(client, workspaceId, sensitive.target)
          return {
            project: oracleDigestOf(oracle.project), commands: oracle.administrationCommands.length, events: oracle.events.length,
            projectsA: await client.v2Project.count({ where: { workspaceId } }), projectsB: await client.v2Project.count({ where: { workspaceId: otherWorkspaceId } }),
            creationCommands: await client.v2ProjectCreationCommand.count({ where: { workspaceId } }),
          }
        }
        const oracleDigestOf = (value) => sha256(JSON.stringify(value))
        const assertCardMatchesPersisted = async (projectId) => {
          const row = await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })
          await waitForCardName(page, projectId, row.name)
          const card = await cardSnapshot(page, projectId)
          assert.equal(card.name, row.name)
          return { name: card.name, state: card.state, persistedName: row.name, persistedRevision: row.administrationRevision }
        }

        // 5a. controlled transport failures on the rename dialog (labelled; they never replace 401/403/404/409).
        await phase('transport-controlled', async () => {
          await refreshSession('transport')
          const target = fixtureOf.rename
          const route = `/v1/projects/${target}/rename`
          const pattern = new RegExp(`/v1/projects/${target}/rename$`)
          // Mobile viewport: the error is part of the mobile evidence.
          await page.setViewportSize({ width: 390, height: 844 })
          const mark = mutatingMark()
          const attempts = []
          let mode = 'abort-before-send'
          let consumed = false
          const handler = async (routed) => {
            const request = routed.request()
            if (consumed) { await routed.continue(); return }
            consumed = true
            step(`transport: route handler, mode ${mode}`)
            const attempt = { mode, idempotencyKey: request.headers()['idempotency-key'] ?? null, postData: request.postData() }
            attempts.push(attempt)
            if (mode === 'commit-then-lose-response') {
              const committed = await apiCall(baseUrl, { method: 'POST', path: route, cookie: await currentCookie(), origin: true, headers: { 'idempotency-key': attempt.idempotencyKey }, body: JSON.parse(attempt.postData) })
              attempt.committedStatus = committed.status
            }
            await routed.abort('failed')
          }
          await page.route(pattern, handler)
          try {
            const beforeFirst = await projectOracle(client, workspaceId, target)
            assert.equal(beforeFirst.project.administrationRevision, 4)
            // T1: the request never leaves the browser.
            await cardOf(target).getByRole('button', { name: 'Renomear', exact: true }).click()
            await dialog.waitFor()
            await dialog.getByLabel('Nome').fill(names.renameRetry)
            await dialog.getByRole('button', { name: 'Salvar nome' }).click()
            await dialog.getByRole('alert').waitFor()
            const transportMessage = (await dialog.getByRole('alert').innerText()).trim()
            assert.ok(transportMessage.length > 0, 'the transport failure is shown to the person')
            const afterFailure = await projectOracle(client, workspaceId, target)
            assert.deepEqual(afterFailure.administrationCommands, beforeFirst.administrationCommands, 'nothing was written')
            assert.equal(afterFailure.project.name, names.renameRecovered)
            assert.equal((await cardSnapshot(page, target)).name, names.renameRecovered, 'no false optimistic state')
            evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-mobile-error-transport.png'))
            // Safe retry: same intent, same revision, same key; the second request goes through.
            step('transport: retry click')
            await dialog.getByRole('button', { name: 'Salvar nome' }).click()
            step('transport: waiting for the dialog to close')
            await dialog.waitFor({ state: 'hidden' })
            step('transport: dialog closed')
            await waitForCardName(page, target, names.renameRetry)
            step('transport: card renamed after the retry')
            const afterRetry = await projectOracle(client, workspaceId, target)
            expectCommands(afterRetry, [['rename', 1, 2, 'ui-session', 'journey-client'], ['rename', 2, 3, 'bearer', clientB.id], ['rename', 3, 4, 'ui-session', 'journey-client'], ['rename', 4, 5, 'ui-session', 'journey-client']], 'rename after the safe retry')
            const retryPosts = mutatingSince(mark)
            assert.equal(retryPosts.length, 2)
            assert.equal(retryPosts[0].idempotencyKey, retryPosts[1].idempotencyKey, 'the retry reuses the idempotency key of the failed attempt')
            assert.equal(afterRetry.administrationCommands[3].idempotencyKey, retryPosts[1].idempotencyKey)
            pushCase(evidence, {
              id: 'transport-failure-before-send', controlled: true, mechanism: 'Playwright route.abort on the first rename POST; the request never reaches the server',
              expected: { errorShown: true, commandsWritten: 0, retryReusesKey: true, finalRevision: 5 },
              observed: { errorShown: true, message: transportMessage, commandsWrittenByFailedAttempt: 0, cardNameAfterFailure: names.renameRecovered, retryReusesKey: true, finalRevision: 5, cardNameAfterRetry: names.renameRetry },
              persistedUnchanged: true,
            })
            // T2: the server commits but the response is lost.
            step('transport: T2 start')
            mode = 'commit-then-lose-response'
            consumed = false
            const mark2 = mutatingMark()
            await cardOf(target).getByRole('button', { name: 'Renomear', exact: true }).click()
            await dialog.waitFor()
            await dialog.getByLabel('Nome').fill(names.renameLost)
            await dialog.getByRole('button', { name: 'Salvar nome' }).click()
            await dialog.getByRole('alert').waitFor()
            const lostMessage = (await dialog.getByRole('alert').innerText()).trim()
            assert.ok(lostMessage.length > 0)
            const lostAttempt = attempts[1]
            assert.equal(lostAttempt.committedStatus, 200)
            await waitForCardName(page, target, names.renameLost)
            const afterLost = await projectOracle(client, workspaceId, target)
            expectCommands(afterLost, [['rename', 1, 2, 'ui-session', 'journey-client'], ['rename', 2, 3, 'bearer', clientB.id], ['rename', 3, 4, 'ui-session', 'journey-client'], ['rename', 4, 5, 'ui-session', 'journey-client'], ['rename', 5, 6, 'ui-session', 'journey-client']], 'rename after the lost response')
            assert.equal(afterLost.project.name, names.renameLost)
            const replay = await apiCall(baseUrl, { method: 'POST', path: route, cookie: await currentCookie(), origin: true, headers: { 'idempotency-key': lostAttempt.idempotencyKey }, body: JSON.parse(lostAttempt.postData) })
            assert.equal(replay.status, 200)
            assert.equal(replay.json.data.replayed, true)
            assert.equal((await projectOracle(client, workspaceId, target)).administrationCommands.length, 5, 'the replay of the lost response wrote no new command')
            assert.equal(mutatingSince(mark2).length, 1)
            await dialog.getByRole('button', { name: 'Cancelar' }).click()
            await dialog.waitFor({ state: 'hidden' })
            pushCase(evidence, {
              id: 'transport-response-lost-after-commit', controlled: true, mechanism: 'the same key and body are committed through the human session, then the browser request is aborted so the response is lost',
              expected: { errorShown: true, cardEqualsPersisted: true, replayStatus: 200, replayed: true, commands: 5 },
              observed: { errorShown: true, message: lostMessage, cardName: names.renameLost, persistedName: afterLost.project.name, replayStatus: 200, replayed: true, commands: 5 },
              persistedUnchanged: false,
            })
          } finally {
            await page.unroute(pattern, handler)
            await page.setViewportSize({ width: 1440, height: 1000 })
          }
          recordBrowserRequests(mark)
        })

        // 5b. 401 from real session state.
        await phase('security-401-403-404', async () => {
          await refreshSession('security')
          const target = fixtureOf.rename
          const route = `/v1/projects/${target}/rename`
          const baselineState = await stateOf()
          const targetBefore = await projectOracle(client, workspaceId, target)
          const body = (revision = targetBefore.project.administrationRevision) => ({ baseRevision: revision, name: names.attempt })
          const refusal = async (id, request, expect, call, { duplicate = false } = {}) => {
            const result = await apiCall(baseUrl, { ...call, method: 'POST', path: duplicate ? `/v1/projects/${target}/duplicates` : (call.path ?? route) })
            const observed = assertRefusal(result, expect)
            assert.equal(result.text.includes(names.renameLost), false, 'a refusal never discloses the project name')
            assert.deepEqual(await stateOf(), baselineState, `${id} must change nothing`)
            const card = await assertCardMatchesPersisted(target)
            pushCase(evidence, { id, request, expected: expect, observed, persistedUnchanged: true, card, realState: request.realState })
          }
          const idem = (id) => ({ 'idempotency-key': `${prefix}-refusal-${id}` })
          // --- 401: a session revoked while it is in use, bound to a pending rename in a second browser context
          {
            const liveSession = await issueSession({ workspaceId, clientId: apiClientId, memberId, state: 'active' })
            const { context: contextB, page: pageB } = await newSessionPage({ cookieValue: liveSession })
            const trafficB = trackBrowserTraffic(pageB, baseUrl)
            try {
              step('401: second session opens the dashboard')
              await pageB.goto(`${baseUrl}/${facetsUrlSearch(textFacets)}`, { waitUntil: 'domcontentloaded' })
              await waitForCardName(pageB, fixtureOf.open, names.openByClientB)
              step('401: second session sees the card')
              const cardBefore = await cardSnapshot(pageB, fixtureOf.open)
              const openBefore = await projectOracle(client, workspaceId, fixtureOf.open)
              const holdB = await holdRequest(pageB, /\/v1\/projects\/[^/]+\/rename$/)
              await pageB.locator(`article[data-project-id="${fixtureOf.open}"]`).getByRole('button', { name: 'Renomear', exact: true }).click()
              const dialogB = pageB.getByRole('dialog')
              await dialogB.waitFor()
              await dialogB.getByLabel('Nome').fill(names.attempt)
              step('401: saving the rename')
              await dialogB.getByRole('button', { name: 'Salvar nome' }).click()
              assert.equal(await within('the held rename request of the second session', holdB.held), 'POST')
              step('401: request held, revoking the session')
              await client.v2UiSession.update({ where: { nonceHash: uiSessionNonceHash(liveSession) }, data: { revokedAt: new Date() } })
              const answered = pageB.waitForResponse((item) => item.url().endsWith(`/v1/projects/${fixtureOf.open}/rename`) && item.request().method() === 'POST')
              holdB.release()
              const answer = await answered
              assert.equal(answer.status(), 401)
              // The page navigates to /login on a 401, after which the browser no longer serves this body; the
              // server's answer for the very same session state is read again below, outside the browser.
              const browserBody = await within('the 401 body', answer.json().catch(() => null), 5_000).catch(() => null)
              const sameState = await apiCall(baseUrl, {
                method: 'POST', path: `/v1/projects/${fixtureOf.open}/rename`, cookie: `${sessionCookieName}=${liveSession}`, origin: true,
                headers: { 'idempotency-key': `${prefix}-revoked-probe` }, body: { baseRevision: openBefore.project.administrationRevision, name: names.attempt },
              })
              const answerBody = browserBody ?? sameState.json
              assertRefusal(sameState, { status: 401, code: 'AUTH_INVALID', category: 'auth' })
              assert.equal(answerBody.error.code, 'AUTH_INVALID')
              assert.equal(answerBody.error.category, 'auth')
              await pageB.waitForURL((url) => url.pathname === '/login')
              await holdB.dispose()
              const openAfter = await projectOracle(client, workspaceId, fixtureOf.open)
              assert.deepEqual(openAfter.administrationCommands, openBefore.administrationCommands, 'the refused rename wrote nothing')
              assert.equal(openAfter.project.name, names.openByClientB)
              assert.equal(trafficB.mutating().length, 1)
              evidence.screenshots.push(await screenshot(pageB, evidenceDir, 'w40-desktop-error-401-login.png'))
              const cardAfterOnA = await assertCardMatchesPersisted(fixtureOf.open)
              pushCase(evidence, {
                id: 'revoked-session-in-use-401', request: { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'human session revoked while the dialog was pending', realState: 'v2UiSession.revokedAt set while the request was held' },
                expected: { status: 401, code: 'AUTH_INVALID', landing: '/login' },
                observed: { status: 401, code: answerBody.error.code, category: answerBody.error.category, landing: new URL(pageB.url()).pathname, browserMutatingRequests: 1, bodyReadInBrowser: browserBody !== null },
                persistedUnchanged: true, card: { beforeRequest: cardBefore.name, stillOnAnotherSession: cardAfterOnA.name, persistedName: openAfter.project.name },
              })
            } finally {
              await contextB.close().catch(() => undefined)
            }
          }
          // --- 401: an expired session, for the API and for the page
          {
            const expiredSession = await issueSession({ workspaceId, clientId: apiClientId, memberId, state: 'expired' })
            await refusal('expired-session-401', { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'human session past its expiry', realState: 'v2UiSession.expiresAt and idleExpiresAt in the past' },
              { status: 401, code: 'AUTH_INVALID', category: 'auth' }, { cookie: `${sessionCookieName}=${expiredSession}`, origin: true, headers: idem('expired'), body: body() })
            const { context: contextE, page: pageE } = await newSessionPage({ cookieValue: expiredSession })
            try {
              await pageE.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
              await pageE.waitForURL((url) => url.pathname === '/login')
              const landed = new URL(pageE.url())
              assert.equal(landed.pathname, '/login')
              assert.equal(await pageE.locator('article[data-project-id]').count(), 0, 'an expired session sees no project card')
              pushCase(evidence, { id: 'expired-session-page-redirect', request: { method: 'GET', path: '/', auth: 'human session past its expiry' }, expected: { landing: '/login' }, observed: { landing: landed.pathname, search: landed.search, cards: 0 }, persistedUnchanged: true })
            } finally { await contextE.close().catch(() => undefined) }
          }
          await refusal('anonymous-401', { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'none' }, { status: 401, code: 'AUTH_INVALID', category: 'auth' }, { headers: idem('anonymous'), body: body() })
          // --- 403: credentials without projects:write on the three administrative routes
          const writeBody = { expectedVersionId: targetBefore.versions.at(-1).id, expectedVersionHash: targetBefore.versions.at(-1).baseHash, name: `${prefix}-nao-deve-duplicar` }
          await refusal('scope-rename-403', { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'bearer projects:read' }, { status: 403, code: 'AUTH_SCOPE_REQUIRED', category: 'auth' }, { authorization: readOnlyAuthorization, headers: idem('scope-rename'), body: body() })
          await refusal('scope-archive-403', { method: 'POST', path: '/v1/projects/{id}/archive', auth: 'bearer projects:read' }, { status: 403, code: 'AUTH_SCOPE_REQUIRED', category: 'auth' }, { path: `/v1/projects/${target}/archive`, authorization: readOnlyAuthorization, headers: idem('scope-archive'), body: { baseRevision: targetBefore.project.administrationRevision, confirmed: true } })
          await refusal('scope-duplicate-403', { method: 'POST', path: '/v1/projects/{id}/duplicates', auth: 'bearer projects:read' }, { status: 403, code: 'AUTH_SCOPE_REQUIRED', category: 'auth' }, { authorization: readOnlyAuthorization, headers: idem('scope-duplicate'), body: writeBody }, { duplicate: true })
          // --- 404: other workspace (credential and human session) and nonexistent resource
          await refusal('foreign-credential-rename-404', { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'bearer projects:write of another workspace' }, { status: 404, code: 'PROJECT_NOT_FOUND' }, { authorization: otherWorkspaceAuthorization, headers: idem('foreign-rename'), body: body() })
          await refusal('foreign-credential-archive-404', { method: 'POST', path: '/v1/projects/{id}/archive', auth: 'bearer projects:write of another workspace' }, { status: 404, code: 'PROJECT_NOT_FOUND' }, { path: `/v1/projects/${target}/archive`, authorization: otherWorkspaceAuthorization, headers: idem('foreign-archive'), body: { baseRevision: targetBefore.project.administrationRevision, confirmed: true } })
          await refusal('foreign-credential-duplicate-404', { method: 'POST', path: '/v1/projects/{id}/duplicates', auth: 'bearer projects:write of another workspace' }, { status: 404, code: 'PROJECT_NOT_FOUND' }, { authorization: otherWorkspaceAuthorization, headers: idem('foreign-duplicate'), body: writeBody }, { duplicate: true })
          {
            const foreignHuman = await issueSession({ workspaceId: otherWorkspaceId, clientId: otherApiClientId, memberId: otherMemberId, state: 'active' })
            await refusal('foreign-human-session-rename-404', { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'human session of another workspace', realState: 'a real durable session whose workspace is not the project workspace' }, { status: 404, code: 'PROJECT_NOT_FOUND' }, { cookie: `${sessionCookieName}=${foreignHuman}`, origin: true, headers: idem('foreign-human'), body: body() })
          }
          {
            const missing = await apiCall(baseUrl, { method: 'POST', path: `/v1/projects/${prefix}-does-not-exist/rename`, authorization, headers: idem('missing'), body: { baseRevision: 1, name: names.attempt } })
            const observed = assertRefusal(missing, { status: 404, code: 'PROJECT_NOT_FOUND' })
            assert.deepEqual(await stateOf(), baselineState)
            pushCase(evidence, { id: 'nonexistent-project-404', request: { method: 'POST', path: '/v1/projects/{unknown}/rename', auth: 'bearer projects:write' }, expected: { status: 404, code: 'PROJECT_NOT_FOUND' }, observed, persistedUnchanged: true, card: await assertCardMatchesPersisted(target) })
          }
          // --- 404 through the browser: another tab switches the workspace, the stale card is refused
          {
            const switchSession = await issueSession({ workspaceId, clientId: apiClientId, memberId, state: 'active' })
            const { context: contextC, page: pageC } = await newSessionPage({ cookieValue: switchSession })
            const trafficC = trackBrowserTraffic(pageC, baseUrl)
            try {
              await pageC.goto(`${baseUrl}/${facetsUrlSearch(textFacets)}`, { waitUntil: 'domcontentloaded' })
              await waitForCardName(pageC, target, names.renameLost)
              const dialogC = pageC.getByRole('dialog')
              await pageC.locator(`article[data-project-id="${target}"]`).getByRole('button', { name: 'Renomear', exact: true }).click()
              await dialogC.waitFor()
              await dialogC.getByLabel('Nome').fill(names.attempt)
              const switched = await apiCall(baseUrl, { method: 'POST', path: '/v1/session/workspace', cookie: `${sessionCookieName}=${switchSession}`, origin: true, body: { workspaceId: otherWorkspaceId } })
              assert.equal(switched.status, 200, switched.text)
              assert.equal(switched.json.data.workspaceId, otherWorkspaceId)
              assert.equal(switched.json.data.rotated, true)
              const switchedCookie = sessionCookieOf(switched.headers)
              assert.ok(switchedCookie)
              await contextC.addCookies([{ name: sessionCookieName, value: switchedCookie, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
              const answered = pageC.waitForResponse((item) => item.url().endsWith(route) && item.request().method() === 'POST')
              await dialogC.getByRole('button', { name: 'Salvar nome' }).click()
              const answer = await answered
              assert.equal(answer.status(), 404)
              const answerBody = await answer.json()
              assert.equal(answerBody.error.code, 'PROJECT_NOT_FOUND')
              await dialogC.getByRole('alert').waitFor()
              const alertText = (await dialogC.getByRole('alert').innerText()).trim()
              assert.ok(alertText.length > 0)
              assert.deepEqual(await stateOf(), baselineState, 'the refused rename wrote nothing')
              assert.equal(trafficC.mutating().length, 1)
              evidence.screenshots.push(await screenshot(pageC, evidenceDir, 'w40-desktop-error-404.png'))
              pushCase(evidence, {
                id: 'workspace-switched-in-another-tab-404', request: { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'human session switched to another workspace by POST /v1/session/workspace', realState: 'the member switched workspace in another tab while this card was open' },
                expected: { status: 404, code: 'PROJECT_NOT_FOUND', errorVisibleInDialog: true },
                observed: { status: 404, code: answerBody.error.code, errorVisibleInDialog: true, browserMutatingRequests: 1 },
                persistedUnchanged: true, card: await assertCardMatchesPersisted(target),
              })
            } finally { await contextC.close().catch(() => undefined) }
          }
          // --- 409 for the other two routes, from real revisions
          await refusal('stale-rename-api-409', { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'bearer projects:write', baseRevision: 1 }, { status: 409, code: 'VERSION_CONFLICT', category: 'conflict' }, { authorization, headers: idem('stale-rename'), body: { baseRevision: 1, name: names.attempt } })
          await refusal('stale-archive-api-409', { method: 'POST', path: '/v1/projects/{id}/archive', auth: 'bearer projects:write', baseRevision: 1 }, { status: 409, code: 'VERSION_CONFLICT', category: 'conflict' }, { path: `/v1/projects/${target}/archive`, authorization, headers: idem('stale-archive'), body: { baseRevision: 1, confirmed: true } })
          assert.deepEqual(await stateOf(), baselineState)
        })

        // ---------------------------------- 6. reconciliation, mobile and final state ----------------------------------
        await phase('reconcile-and-mobile', async () => {
          await refreshSession('reconcile')
          const copyId = evidence.fixtures.copy.projectId
          const final = {}
          for (const [key, id] of Object.entries({ ...fixtureOf, copy: copyId })) final[key] = await projectOracle(client, workspaceId, id)
          expectCommands(final.open, [['rename', 1, 2, 'bearer', clientB.id]], 'open final')
          expectCommands(final.review, [], 'review final')
          expectCommands(final.rename, [['rename', 1, 2, 'ui-session', 'journey-client'], ['rename', 2, 3, 'bearer', clientB.id], ['rename', 3, 4, 'ui-session', 'journey-client'], ['rename', 4, 5, 'ui-session', 'journey-client'], ['rename', 5, 6, 'ui-session', 'journey-client']], 'rename final')
          expectCommands(final.archive, [['rename', 1, 2, 'bearer', clientB.id], ['archive', 2, 3, 'ui-session', 'journey-client'], ['restore', 3, 4, 'ui-session', 'journey-client']], 'archive final')
          expectCommands(final.dup, [], 'dup final')
          expectCommands(final.copy, [], 'copy final')
          assert.equal(final.review.project.status, 'reviewing-proxy')
          assert.equal(final.archive.project.status, 'completed')
          assert.equal(final.archive.project.archivedFromStatus, null)
          const finalApi = await apiRows()
          assert.deepEqual(new Set(Object.keys(finalApi)), new Set([...fixtureIds, copyId]))
          for (const [key, oracle] of Object.entries(final)) {
            const row = finalApi[oracle.project.id]
            assert.equal(row.name, oracle.project.name, `${key}: API name equals PostgreSQL`)
            assert.equal(row.status, oracle.project.status)
            assert.equal(row.revision, oracle.project.administrationRevision)
          }
          const outsideAfter = { workspace: await outsideDigest(workspaceId), otherWorkspace: await outsideDigest(otherWorkspaceId) }
          assert.deepEqual(outsideAfter, outsideBefore, 'no project outside the W40 prefix, in either workspace, was touched')
          // The dashboard (desktop) equals the oracle after every error was produced.
          const rows = await oracleProjects(client, workspaceId, textFacets)
          const listed = awaitProjectsResponse(page, facetsApiParams(textFacets), rows.map((row) => row.id))
          await page.goto(`${baseUrl}/${facetsUrlSearch(textFacets)}`, { waitUntil: 'domcontentloaded' })
          await listed
          await waitForCards(page, cardsOf(rows))
          await waitForSettled(page)
          assert.deepEqual(await summaryCounters(page), expectedTiles(rows.map((row) => row.status)))
          // Mobile: the same dashboard, one column, no horizontal overflow; an open dialog stays inside the viewport.
          await page.setViewportSize({ width: 390, height: 844 })
          await waitForCardName(page, copyId, names.copy)
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
          evidence.browser.mobileOverflowPx = overflow
          assert.ok(overflow <= 1, `W40 mobile overflows by ${overflow}px`)
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-mobile-actions.png'))
          await cardOf(fixtureOf.archive).getByRole('button', { name: 'Arquivar', exact: true }).click()
          await dialog.waitFor()
          const box = await dialog.locator('form').boundingBox()
          assert.ok(box && box.x >= 0 && box.x + box.width <= 390 + 1, 'the dialog fits the mobile viewport')
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w40-mobile-archive-dialog.png'))
          await dialog.getByRole('button', { name: 'Cancelar' }).click()
          await dialog.waitFor({ state: 'hidden' })
          await page.setViewportSize({ width: 1440, height: 1000 })
          evidence.final = {
            outsidePrefixUnchanged: true,
            projects: Object.fromEntries(Object.entries(final).map(([key, oracle]) => [key, {
              project: projectRowSummary(oracle.project),
              commands: oracle.administrationCommands.map(commandSummary),
              events: oracle.events.map((event) => ({ id: event.id, type: event.type })),
              versions: oracle.versions.length, editCommands: oracle.editCommandCount,
            }])),
            tiles: expectedTiles(rows.map((row) => row.status)),
          }
        })

        evidence.browser.mutatingRequests = browserRequests.length
        evidence.browser.requests = browserRequests
        evidence.browser.requestCounts = requestCounts()
        evidence.browser.feedPolls = feed.entries.length
        const allBrowserMutations = traffic.mutating().map((item) => `${item.method} ${item.path.replace(/\/projects\/[^/]+/, '/projects/{id}')}`)
        assert.deepEqual(allBrowserMutations, browserRequests.map((item) => `${item.method} ${item.path.replace(/\/projects\/[^/]+/, '/projects/{id}')}`), 'every mutating request of the human browser is accounted for')
        evidence.session.rotationsDuringJourney = session.rotations.length
        evidence.session.elapsedAtEndMs = Date.now() - originalRow.issuedAt.getTime()
        evidence.session.finalCookieDiffersFromOriginal = (await currentCookie()) !== `${sessionCookieName}=${sessionCookieValue}`
        liveCookieValue = (await currentCookie()).slice(sessionCookieName.length + 1)
      } finally {
        await rm(join(root, 'w40', tag), { recursive: true, force: true })
        await rmdir(join(root, 'w40')).catch(() => undefined)
        const leftovers = await readdir(root).catch(() => [])
        if (leftovers.length === 0) await rm(root, { recursive: true, force: true })
        evidence.postflight.storageCleanup = leftovers.length === 0 ? 'artifact-root-removed' : 'fixture-directory-removed'
      }
    },
  })
  return { ...evidenceResult, sessionCookieValue: liveCookieValue, durationMs: Date.now() - startedAt }
}
