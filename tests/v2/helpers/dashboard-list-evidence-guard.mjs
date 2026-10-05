// CI/local guard for the W31/W32/W33 dashboard list manifests. It re-reads the
// sanitized manifest and the screenshots and fails on any missing case, any
// answer that differs from the database oracle, or any secret-looking value.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const FACETS = ['text', 'status', 'objective', 'format', 'locale', 'createdFrom', 'createdTo', 'ownerId']

function loadManifest(directory, name, schemaVersion, { sourceCommit, ciRunId, applicationName }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/)
  assert.match(ciRunId, /^\d+$/)
  assert.match(applicationName, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
  const text = readFileSync(join(directory, name), 'utf8')
  assert.doesNotMatch(text, /apollo_session|authorization|bearer\s|set-cookie/i, 'manifest must not carry credentials')
  const manifest = JSON.parse(text)
  assert.equal(manifest.schemaVersion, schemaVersion)
  assert.equal(manifest.outcome, 'passed')
  assert.equal(manifest.sourceCommit, sourceCommit)
  assert.equal(manifest.ciRunId, ciRunId)
  assert.equal(manifest.database?.applicationName, applicationName)
  assert.match(manifest.runId, /^[a-f0-9-]{36}$/)
  assert.equal(manifest.browser?.pid > 0, true)
  assert.equal(manifest.postflight?.browserProcessTerminal, true)
  assert.equal(manifest.postflight?.browserPidAliveAtEnd, false)
  assert.deepEqual(manifest.postflight?.cleanupErrors, [])
  assert.equal(manifest.browser?.mutatingRequests, 0)
  return manifest
}

function assertScreenshots(directory, manifest, names) {
  assert.deepEqual(manifest.screenshots?.map((item) => item.name), names)
  for (const shot of manifest.screenshots) {
    assert.match(shot.sha256, /^[a-f0-9]{64}$/)
    const bytes = readFileSync(join(directory, shot.name))
    assert.ok(bytes.length > 100)
    assert.equal(bytes.length, shot.bytes)
    assert.equal(hash(bytes), shot.sha256)
  }
}

function assertCounters(manifest) {
  assert.deepEqual(manifest.counts?.after, manifest.counts?.before)
  for (const key of ['projects', 'versions', 'editCommands', 'creationCommands', 'administrationCommands']) {
    assert.equal(Number.isInteger(manifest.counts.before[key]), true)
  }
  assert.deepEqual(manifest.projectRowsBefore, manifest.projectRowsAfter)
}

function expectedRequest(facets) {
  const request = { limit: '24' }
  for (const key of FACETS) {
    const value = facets[key]
    if (!value) continue
    request[key] = key === 'createdFrom' ? `${value}T00:00:00.000Z`
      : key === 'createdTo' ? `${value}T23:59:59.999Z` : value
  }
  return request
}

function expectedUrl(facets) {
  const params = new URLSearchParams()
  for (const key of FACETS) if (facets[key]) params.set(key, facets[key])
  const value = params.toString()
  return value ? `?${value}` : ''
}

function assertBoundCase(entry) {
  assert.equal(entry.status, 200, `${entry.id}: status`)
  assert.deepEqual(entry.request, expectedRequest(entry.facets), `${entry.id}: effective request`)
  assert.equal(entry.url, expectedUrl(entry.facets), `${entry.id}: canonical URL`)
  assert.deepEqual(entry.responseIds, entry.expectedIds, `${entry.id}: response ids vs PostgreSQL oracle`)
  assert.deepEqual(entry.cardIds, entry.expectedIds, `${entry.id}: cards vs PostgreSQL oracle`)
}

const W31_CASES = [
  ['individual-text', null], ['individual-status', ['w31-other-status']],
  ['individual-objective', ['w31-other-objective']], ['individual-format', ['w31-other-format']],
  ['individual-locale', ['w31-other-locale']], ['individual-created-from', null],
  ['individual-created-to', null], ['individual-owner', ['w31-other-owner']],
  ['six-facets-without-dates', ['w31-day-after', 'w31-edge-end', 'w31-anchor', 'w31-edge-start', 'w31-day-before']],
  ['dates-only', null], ['all-eight', ['w31-edge-end', 'w31-anchor', 'w31-edge-start']],
  ['zero-owner-and-locale-conflict', []], ['zero-day-without-projects', []], ['zero-individual-owner', []],
]
const W31_PERSISTENCE = [
  'explicit-url-all-eight', 'all-eight-reload', 'all-eight-session-fallback', 'explicit-url-over-session',
  'explicit-url-updated-session-fallback', 'url-invalid-values-dropped', 'url-invalid-values-session-fallback',
  'url-reversed-range-drops-created-to', 'ui-created-from-after-created-to-clears-created-to', 'mobile-all-eight',
]
const W31_INVALID = [
  'status', 'objective-pattern', 'format', 'locale', 'owner-id', 'created-from', 'created-to',
  'range-reversed', 'text-length', 'limit-zero', 'limit-over', 'cursor-malformed', 'unknown-parameter',
  'repeated-parameter',
]

export function verifyW31Evidence(directory, context) {
  const manifest = loadManifest(directory, 'w31-manifest.json', 'w31-dashboard-combined-filters/v1', context)
  assert.equal(manifest.browser?.mobileOverflowPx <= 1, true)
  assertCounters(manifest)
  assert.equal(manifest.fixtures?.length, 11)
  assert.ok(manifest.fixtures.every((fixture) => fixture.id.startsWith('w31-')))
  assert.deepEqual(manifest.uiCases?.map((item) => item.id), W31_CASES.map(([id]) => id))
  for (const [index, [id, exact]] of W31_CASES.entries()) {
    const entry = manifest.uiCases[index]
    assertBoundCase(entry)
    if (exact) assert.deepEqual(entry.expectedIds, exact, `${id}: exact fixture sequence`)
    else assert.ok(entry.expectedIds.length >= 9 || id === 'individual-text', `${id}: non-trivial answer`)
  }
  const all = manifest.uiCases.find((item) => item.id === 'all-eight')
  assert.deepEqual(Object.keys(all.request).sort(), ['createdFrom', 'createdTo', 'format', 'limit', 'locale', 'objective', 'ownerId', 'status', 'text'])
  assert.equal(all.request.createdFrom, '2026-02-10T00:00:00.000Z')
  assert.equal(all.request.createdTo, '2026-02-10T23:59:59.999Z')
  assert.deepEqual(manifest.persistence?.map((item) => item.id), W31_PERSISTENCE)
  for (const entry of manifest.persistence) assertBoundCase(entry)
  assert.deepEqual(manifest.persistence[5].request, { limit: '24', text: 'w31-alfa' })
  assert.equal(manifest.persistence[5].url, '?text=w31-alfa')
  assert.deepEqual(manifest.persistence[7].request, { limit: '24', text: 'w31-alfa', createdFrom: '2026-02-12T00:00:00.000Z' })
  assert.deepEqual(manifest.apiCases?.map((item) => item.id), W31_CASES.map(([id]) => id))
  for (const item of manifest.apiCases) {
    assert.equal(item.status, 200)
    assert.deepEqual(item.ids, item.oracleIds)
  }
  assert.deepEqual(manifest.boundaryCases?.map((item) => [item.id, item.ids]), [
    ['created-from-inclusive-start', ['w31-edge-start']],
    ['created-from-excludes-one-ms-earlier', []],
    ['created-to-inclusive-end', ['w31-edge-end']],
    ['created-to-excludes-one-ms-later', []],
    ['day-bounds-from-codec', ['w31-edge-end', 'w31-anchor', 'w31-edge-start']],
  ])
  assert.deepEqual(manifest.invalidCases?.map((item) => item.id).sort(), [...W31_INVALID].sort())
  assert.ok(manifest.invalidCases.every((item) => item.status === 422 && item.code === 'INVALID_ARGUMENT'))
  assert.equal(manifest.apiAcceptsWellFormedUnknownObjective, true)
  assert.ok(Array.isArray(manifest.requests) && manifest.requests.length >= 14)
  assert.ok(manifest.requests.every((request) => request.method === 'GET' && request.path === '/v1/projects'))
  assert.ok(Array.isArray(manifest.responses) && manifest.responses.length >= 14)
  assert.ok(manifest.responses.every((response) => response.status === 200))
  assertScreenshots(directory, manifest, ['w31-desktop-all-eight.png', 'w31-mobile-all-eight.png'])
  return { sourceCommit: context.sourceCommit, ciRunId: context.ciRunId, applicationName: context.applicationName, runId: manifest.runId }
}

const W32_UI = [
  'first-page-24-with-next-cursor', 'load-more-completes-27', 'reload-resets-to-first-page',
  'exactly-24-has-no-next-cursor', 'zero-results-without-progress',
  'controlled-filter-change-during-slow-first-page', 'controlled-filter-change-during-slow-load-more',
  'controlled-foreign-cursor-rejected-then-recovery', 'mobile-after-load-more',
]
const W32_HTTP = [
  'first-page', 'second-page-from-cursor', 'walk-limit-24', 'walk-limit-5', 'walk-limit-1',
  'owner-a-exactly-24', 'owner-b-three', 'zero-results', 'cursor-other-filter-owner',
  'cursor-other-filter-removed-locale', 'cursor-other-filter-text', 'cursor-same-filter-accepted', 'cursor-malformed',
]

export function verifyW32Evidence(directory, context) {
  const manifest = loadManifest(directory, 'w32-manifest.json', 'w32-dashboard-pagination/v1', context)
  assert.equal(manifest.browser?.mobileOverflowPx <= 1, true)
  assertCounters(manifest)
  const sequence = manifest.expectedSequence
  assert.equal(sequence?.length, 27)
  assert.equal(new Set(sequence).size, 27)
  assert.deepEqual([...sequence].sort(), Array.from({ length: 27 }, (_, index) => `w32-p${String(index).padStart(2, '0')}`))
  assert.equal(manifest.fixtures?.length, 27)
  // Real createdAt ties, one of them across the 24/25 page boundary.
  assert.ok(manifest.ties?.groups?.length >= 2 && manifest.ties.groups.every((group) => group.ids.length >= 2))
  assert.deepEqual(manifest.ties.boundary.positions, [24, 25])
  assert.deepEqual(manifest.ties.boundary.ids, [sequence[23], sequence[24]])
  const first = sequence.slice(0, 24)
  const rest = sequence.slice(24)
  assert.deepEqual(manifest.httpCases?.map((item) => item.id), W32_HTTP)
  const http = Object.fromEntries(manifest.httpCases.map((item) => [item.id, item]))
  assert.deepEqual(http['first-page'].ids, first)
  assert.equal(http['first-page'].hasNextCursor, true)
  assert.deepEqual(http['second-page-from-cursor'].ids, rest)
  assert.equal(http['second-page-from-cursor'].hasNextCursor, false)
  for (const id of ['walk-limit-24', 'walk-limit-5', 'walk-limit-1']) assert.deepEqual(http[id].ids, sequence, id)
  assert.equal(http['walk-limit-5'].pages, 6)
  assert.equal(http['owner-a-exactly-24'].ids.length, 24)
  assert.equal(http['owner-a-exactly-24'].hasNextCursor, false)
  assert.equal(http['owner-b-three'].ids.length, 3)
  assert.deepEqual(http['zero-results'].ids, [])
  assert.deepEqual(http['cursor-same-filter-accepted'].ids, rest)
  for (const id of ['cursor-other-filter-owner', 'cursor-other-filter-removed-locale', 'cursor-other-filter-text', 'cursor-malformed']) {
    assert.equal(http[id].status, 422, id)
    assert.equal(http[id].errorCode, 'INVALID_ARGUMENT', id)
    assert.equal(http[id].ids, null, id)
  }
  assert.deepEqual(manifest.uiCases?.map((item) => item.id), W32_UI)
  const ui = Object.fromEntries(manifest.uiCases.map((item) => [item.id, item]))
  for (const entry of manifest.uiCases) {
    assert.equal(entry.status, 200, `${entry.id}: status`)
    assert.deepEqual(entry.responseIds, entry.expectedIds, `${entry.id}: response vs oracle`)
    assert.equal(entry.request.limit, '24')
  }
  const firstPage = ui['first-page-24-with-next-cursor']
  assert.deepEqual(firstPage.cardIds, first)
  assert.equal(firstPage.hasNextCursor, true)
  assert.equal(firstPage.loadMoreVisible, true)
  assert.equal(firstPage.nextCursorMatchesHttp, true)
  assert.deepEqual(firstPage.request, { limit: '24', locale: 'qaa-w32' })
  const more = ui['load-more-completes-27']
  assert.deepEqual(more.cardIds, sequence)
  assert.deepEqual(more.responseIds, rest)
  assert.match(more.request.after, /^sha256:[a-f0-9]{16}$/)
  assert.equal(more.loadMoreVisible, false)
  assert.deepEqual(ui['reload-resets-to-first-page'].cardIds, first)
  assert.equal(ui['exactly-24-has-no-next-cursor'].cardIds.length, 24)
  assert.equal(ui['exactly-24-has-no-next-cursor'].hasNextCursor, false)
  assert.equal(ui['exactly-24-has-no-next-cursor'].loadMoreVisible, false)
  assert.deepEqual(ui['zero-results-without-progress'].cardIds, [])
  assert.equal(ui['zero-results-without-progress'].loadMoreVisible, false)
  for (const id of ['controlled-filter-change-during-slow-first-page', 'controlled-filter-change-during-slow-load-more']) {
    const entry = ui[id]
    assert.equal(entry.controlled, true, `${id}: must be labelled controlled`)
    assert.equal(entry.staleAnswerReleased, true)
    assert.deepEqual(entry.cardIds, entry.expectedIds, `${id}: the newer filter owns the cards`)
    assert.ok(entry.stableSamples >= 10, `${id}: cards sampled while the stale answer was released`)
    assert.ok(entry.staleExpectedIds.length > 0 && entry.staleExpectedIds.every((stale) => !entry.cardIds.includes(stale)), `${id}: stale rows rendered`)
    assert.ok(entry.staleRequest && entry.staleRequest.limit === '24')
  }
  const foreign = ui['controlled-foreign-cursor-rejected-then-recovery']
  assert.equal(foreign.controlled, true)
  assert.equal(foreign.rejectedStatus, 422)
  assert.equal(foreign.rejectedCode, 'INVALID_ARGUMENT')
  assert.deepEqual(foreign.cardsKeptDuringRejection, first)
  assert.deepEqual(foreign.responseIds, rest)
  assert.deepEqual(ui['mobile-after-load-more'].responseIds, rest)
  assert.ok(manifest.requests.length >= 10 && manifest.requests.every((request) => request.method === 'GET' && request.path === '/v1/projects'))
  assert.ok(manifest.responses.some((response) => response.status === 422 && response.errorCode === 'INVALID_ARGUMENT'))
  assertScreenshots(directory, manifest, ['w32-desktop-first-page.png', 'w32-desktop-after-load-more.png', 'w32-mobile-after-load-more.png'])
  return { sourceCommit: context.sourceCommit, ciRunId: context.ciRunId, applicationName: context.applicationName, runId: manifest.runId }
}

const W33_HTTP = [
  'a-session-scope', 'a-bearer-scope', 'b-session-scope', 'b-bearer-scope', 'a-shared-name', 'b-shared-name',
  'a-zero-owner-only-in-b', 'a-zero-text-only-in-b', 'b-zero-text-only-in-a', 'a-cursor-under-a',
  'a-cursor-under-b-session', 'a-cursor-under-b-bearer', 'b-cursor-under-a-session', 'a-cursor-other-filter-under-a',
  'a-cursor-other-text-under-a', 'forged-cursor-with-b-pointer-under-a', 'project-own-a-session',
  'project-b-under-a-session', 'project-own-b-session', 'project-a-under-b-session',
]
const W33_UI = [
  'workspace-a-cards', 'workspace-b-cards', 'workspace-a-zero-by-isolation', 'workspace-b-zero-by-isolation',
  'workspace-a-shared-name', 'workspace-b-shared-name', 'session-revoked-during-use-redirects-to-login', 'mobile-workspace-b',
]

export function verifyW33Evidence(directory, context) {
  const manifest = loadManifest(directory, 'w33-manifest.json', 'w33-dashboard-workspace-isolation/v1', context)
  assert.equal(manifest.browser?.mobileOverflowPx <= 1, true)
  for (const workspace of ['a', 'b']) {
    assert.deepEqual(manifest.counts?.after?.[workspace], manifest.counts?.before?.[workspace], `workspace ${workspace} counters`)
    assert.deepEqual(manifest.projectRowsBefore?.[workspace], manifest.projectRowsAfter?.[workspace])
  }
  assert.notEqual(manifest.workspaces.a, manifest.workspaces.b)
  const idsA = ['w33-a-4', 'w33-a-3', 'w33-a-2', 'w33-a-1']
  const idsB = ['w33-b-5', 'w33-b-4', 'w33-b-3', 'w33-b-2', 'w33-b-1']
  assert.equal(manifest.fixtures?.a?.length, 4)
  assert.equal(manifest.fixtures?.b?.length, 5)
  assert.deepEqual(manifest.httpCases?.map((item) => item.id), W33_HTTP)
  const http = Object.fromEntries(manifest.httpCases.map((item) => [item.id, item]))
  for (const [id, expected] of [
    ['a-session-scope', idsA], ['a-bearer-scope', idsA], ['b-session-scope', idsB], ['b-bearer-scope', idsB],
    ['a-shared-name', ['w33-a-3']], ['b-shared-name', ['w33-b-3']],
    ['a-zero-owner-only-in-b', []], ['a-zero-text-only-in-b', []], ['b-zero-text-only-in-a', []],
    ['a-cursor-under-a', ['w33-a-2', 'w33-a-1']],
  ]) {
    assert.equal(http[id].status, 200, id)
    assert.deepEqual(http[id].ids, expected, id)
  }
  assert.ok(http['a-session-scope'].ids.every((id) => !idsB.includes(id)))
  assert.ok(http['forged-cursor-with-b-pointer-under-a'].ids.every((id) => idsA.includes(id)), 'forged cursor must not surface B')
  for (const id of ['a-cursor-under-b-session', 'a-cursor-under-b-bearer', 'b-cursor-under-a-session', 'a-cursor-other-filter-under-a', 'a-cursor-other-text-under-a']) {
    assert.equal(http[id].status, 422, `${id}: a mismatched cursor must be a contract error, never a 200`)
    assert.equal(http[id].errorCode, 'INVALID_ARGUMENT', id)
    assert.equal(http[id].ids, null, id)
  }
  assert.equal(http['a-cursor-under-b-session'].actor, 'b-session')
  assert.equal(http['a-cursor-under-b-bearer'].actor, 'b-bearer')
  for (const id of ['project-b-under-a-session', 'project-a-under-b-session']) {
    assert.equal(http[id].status, 404, id)
    assert.equal(http[id].errorCode, 'PROJECT_NOT_FOUND', id)
  }
  assert.equal(http['project-own-a-session'].status, 200)
  assert.equal(http['project-own-b-session'].status, 200)
  assert.deepEqual(manifest.authCases?.map((item) => [item.id, item.status, item.code]), [
    ['anonymous', 401, 'AUTH_INVALID'], ['expired-session', 401, 'AUTH_INVALID'], ['revoked-session', 401, 'AUTH_INVALID'],
    ['unknown-session-token', 401, 'AUTH_INVALID'], ['malformed-bearer', 401, 'AUTH_INVALID'],
    ['bearer-without-projects-read', 403, 'AUTH_SCOPE_REQUIRED'],
  ])
  assert.deepEqual(manifest.pageCases?.map((item) => item.id).sort(), ['anonymous-page', 'expired-session-page', 'revoked-session-page'])
  assert.ok(manifest.pageCases.every((item) => item.landedPath === '/login' && item.next === '/'))
  assert.deepEqual(manifest.uiCases?.map((item) => item.id), W33_UI)
  const ui = Object.fromEntries(manifest.uiCases.map((item) => [item.id, item]))
  for (const id of W33_UI.filter((item) => item !== 'session-revoked-during-use-redirects-to-login')) {
    const entry = ui[id]
    assert.equal(entry.status, 200, id)
    assert.deepEqual(entry.responseIds, entry.expectedIds, `${id}: response vs PostgreSQL oracle`)
    assert.deepEqual(entry.cardIds, entry.expectedIds, `${id}: cards vs PostgreSQL oracle`)
  }
  assert.deepEqual(ui['workspace-a-cards'].cardIds, idsA)
  assert.deepEqual(ui['workspace-b-cards'].cardIds, idsB)
  assert.deepEqual(ui['mobile-workspace-b'].cardIds, idsB)
  assert.ok(ui['workspace-a-zero-by-isolation'].existsInOtherWorkspace > 0 && ui['workspace-b-zero-by-isolation'].existsInOtherWorkspace > 0)
  assert.deepEqual(ui['workspace-a-shared-name'].cardIds, ['w33-a-3'])
  assert.deepEqual(ui['workspace-b-shared-name'].cardIds, ['w33-b-3'])
  assert.equal(ui['session-revoked-during-use-redirects-to-login'].status, 401)
  assert.equal(ui['session-revoked-during-use-redirects-to-login'].landedPath, '/login')
  assert.ok(manifest.requests.length >= 8 && manifest.requests.every((request) => request.method === 'GET' && request.path === '/v1/projects'))
  assert.ok(manifest.responses.some((response) => response.status === 401))
  assertScreenshots(directory, manifest, ['w33-desktop-workspace-a.png', 'w33-desktop-workspace-b.png', 'w33-mobile-workspace-b.png'])
  return { sourceCommit: context.sourceCommit, ciRunId: context.ciRunId, applicationName: context.applicationName, runId: manifest.runId }
}

const VERIFIERS = { w31: verifyW31Evidence, w32: verifyW32Evidence, w33: verifyW33Evidence }

export function verifyDashboardListEvidence(wave, directory, context) {
  const verify = VERIFIERS[wave]
  assert.ok(verify, `unknown dashboard list wave ${wave}`)
  return verify(directory, context)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    verifyDashboardListEvidence(process.argv[2], process.argv[3], {
      sourceCommit: process.env.GITHUB_SHA,
      ciRunId: process.env.GITHUB_RUN_ID,
      applicationName: process.env.APOLLO_PUBLIC_API_APP_NAME,
    })
  } catch (error) {
    process.stderr.write(`${process.argv[2]} evidence rejected: ${error?.name ?? 'Error'}: ${error?.message ?? ''}\n`)
    process.exitCode = 1
  }
}
