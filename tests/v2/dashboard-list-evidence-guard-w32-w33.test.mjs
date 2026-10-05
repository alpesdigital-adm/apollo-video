import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyDashboardListEvidence } from './helpers/dashboard-list-evidence-guard.mjs'

const commit = 'a'.repeat(40)
const binding = { sourceCommit: commit, ciRunId: '1234', applicationName: 'apollo-video-e2e-w29-ci' }
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function shots(directory, names) {
  const bytes = Buffer.alloc(160, 5)
  return names.map((name) => {
    writeFileSync(join(directory, name), bytes)
    return { name, sha256: sha(bytes), bytes: bytes.length }
  })
}

const baseManifest = (schemaVersion, screenshots) => ({
  schemaVersion, outcome: 'passed', sourceCommit: commit, ciRunId: '1234',
  runId: '22222222-2222-4222-8222-222222222222', database: { applicationName: 'apollo-video-e2e-w29-ci' },
  browser: { pid: 321, mutatingRequests: 0, mobileOverflowPx: 0 },
  postflight: { browserProcessTerminal: true, browserPidAliveAtEnd: false, cleanupErrors: [] },
  screenshots,
})

const rejecter = (wave, directory, name, manifest) => (change) => {
  const snapshot = JSON.stringify(manifest)
  change(manifest)
  writeFileSync(join(directory, name), JSON.stringify(manifest))
  assert.throws(() => verifyDashboardListEvidence(wave, directory, binding))
  const restored = JSON.parse(snapshot)
  for (const key of Object.keys(manifest)) if (!(key in restored)) delete manifest[key]
  Object.assign(manifest, restored)
  writeFileSync(join(directory, name), JSON.stringify(manifest))
}

test('W32 CI guard binds the 27-row sequence, the boundary tie, the stale answers and the foreign cursor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-w32-guard-'))
  try {
    const sequence = Array.from({ length: 27 }, (_, index) => `w32-p${String(26 - index).padStart(2, '0')}`)
    const first = sequence.slice(0, 24)
    const rest = sequence.slice(24)
    const counts = { projects: 40, versions: 2, editCommands: 0, creationCommands: 2, administrationCommands: 0 }
    const rows = [{ id: 'a', name: 'a', status: 'draft', createdAt: '2026-10-04T00:00:00.000Z' }]
    const ui = (id, extra) => ({ id, status: 200, request: { limit: '24' }, responseIds: first, expectedIds: first, cardIds: first, ...extra })
    const stale = (id, staleExpectedIds) => ui(id, {
      controlled: true, staleAnswerReleased: true, stableSamples: 20, staleExpectedIds, staleRequest: { limit: '24' },
    })
    const manifest = {
      ...baseManifest('w32-dashboard-pagination/v1', shots(directory, ['w32-desktop-first-page.png', 'w32-desktop-after-load-more.png', 'w32-mobile-after-load-more.png'])),
      counts: { before: counts, after: counts }, projectRowsBefore: rows, projectRowsAfter: rows,
      expectedSequence: sequence, fixtures: sequence.map((id) => ({ id })),
      ties: { groups: [{ ids: ['x', 'y', 'z'] }, { ids: [sequence[23], sequence[24]] }], boundary: { positions: [24, 25], ids: [sequence[23], sequence[24]] } },
      httpCases: [
        { id: 'first-page', status: 200, ids: first, hasNextCursor: true },
        { id: 'second-page-from-cursor', status: 200, ids: rest, hasNextCursor: false },
        { id: 'walk-limit-24', ids: sequence, pages: 2 }, { id: 'walk-limit-5', ids: sequence, pages: 6 },
        { id: 'walk-limit-1', ids: sequence, pages: 27 },
        { id: 'owner-a-exactly-24', status: 200, ids: first, hasNextCursor: false },
        { id: 'owner-b-three', status: 200, ids: rest, hasNextCursor: false },
        { id: 'zero-results', status: 200, ids: [], hasNextCursor: false },
        ...['cursor-other-filter-owner', 'cursor-other-filter-removed-locale', 'cursor-other-filter-text']
          .map((id) => ({ id, status: 422, ids: null, errorCode: 'INVALID_ARGUMENT' })),
        { id: 'cursor-same-filter-accepted', status: 200, ids: rest },
        { id: 'cursor-malformed', status: 422, ids: null, errorCode: 'INVALID_ARGUMENT' },
      ],
      uiCases: [
        ui('first-page-24-with-next-cursor', { request: { limit: '24', locale: 'qaa-w32' }, hasNextCursor: true, loadMoreVisible: true, nextCursorMatchesHttp: true }),
        ui('load-more-completes-27', { request: { limit: '24', locale: 'qaa-w32', after: 'sha256:0123456789abcdef' }, responseIds: rest, expectedIds: rest, cardIds: sequence, loadMoreVisible: false }),
        ui('reload-resets-to-first-page'),
        ui('exactly-24-has-no-next-cursor', { hasNextCursor: false, loadMoreVisible: false }),
        ui('zero-results-without-progress', { responseIds: [], expectedIds: [], cardIds: [], loadMoreVisible: false }),
        stale('controlled-filter-change-during-slow-first-page', ['w32-p02', 'w32-p01', 'w32-p00']),
        stale('controlled-filter-change-during-slow-load-more', rest),
        ui('controlled-foreign-cursor-rejected-then-recovery', { controlled: true, rejectedStatus: 422, rejectedCode: 'INVALID_ARGUMENT', cardsKeptDuringRejection: first, responseIds: rest, expectedIds: rest, cardIds: sequence }),
        ui('mobile-after-load-more', { responseIds: rest, expectedIds: rest, cardIds: sequence }),
      ],
      requests: Array.from({ length: 12 }, () => ({ method: 'GET', path: '/v1/projects' })),
      responses: [{ status: 200 }, { status: 422, errorCode: 'INVALID_ARGUMENT' }],
    }
    writeFileSync(join(directory, 'w32-manifest.json'), JSON.stringify(manifest))
    assert.deepEqual(verifyDashboardListEvidence('w32', directory, binding), { ...binding, runId: manifest.runId })
    const reject = rejecter('w32', directory, 'w32-manifest.json', manifest)
    reject((value) => { value.ties.boundary.ids = ['w32-p20', 'w32-p19'] })
    reject((value) => { value.expectedSequence = [...sequence].reverse() })
    reject((value) => { value.uiCases[1].cardIds = first })
    reject((value) => { value.uiCases[5].cardIds = [...first.slice(0, 23), 'w32-p02'] })
    reject((value) => { value.uiCases[5].controlled = false })
    reject((value) => { value.uiCases[6].stableSamples = 1 })
    reject((value) => { value.uiCases[7].rejectedStatus = 200 })
    reject((value) => { value.httpCases[8].status = 200 })
    reject((value) => { value.httpCases[5].hasNextCursor = true })
    reject((value) => { value.responses = [{ status: 200 }] })
    reject((value) => { value.browser.mutatingRequests = 1 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('W33 CI guard binds per-workspace ids, exact cursor errors, auth codes and the zero-by-isolation proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-w33-guard-'))
  try {
    const idsA = ['w33-a-4', 'w33-a-3', 'w33-a-2', 'w33-a-1']
    const idsB = ['w33-b-5', 'w33-b-4', 'w33-b-3', 'w33-b-2', 'w33-b-1']
    const counts = (projects) => ({ projects, versions: 0, editCommands: 0, creationCommands: 0, administrationCommands: 0 })
    const http = (id, actor, status, ids, errorCode) => ({ id, actor, status, ids, ...(errorCode ? { errorCode } : {}) })
    const ui = (id, workspace, ids, extra) => ({ id, workspace, status: 200, responseIds: ids, cardIds: ids, expectedIds: ids, ...extra })
    const manifest = {
      ...baseManifest('w33-dashboard-workspace-isolation/v1', shots(directory, ['w33-desktop-workspace-a.png', 'w33-desktop-workspace-b.png', 'w33-mobile-workspace-b.png'])),
      workspaces: { a: 'workspace-a', b: 'workspace-b' },
      fixtures: { a: Array.from({ length: 4 }, (_, index) => ({ id: `a${index}` })), b: Array.from({ length: 5 }, (_, index) => ({ id: `b${index}` })) },
      counts: { before: { a: counts(44), b: counts(5) }, after: { a: counts(44), b: counts(5) } },
      projectRowsBefore: { a: [{ id: 'x' }], b: [{ id: 'y' }] }, projectRowsAfter: { a: [{ id: 'x' }], b: [{ id: 'y' }] },
      httpCases: [
        http('a-session-scope', 'a-session', 200, idsA), http('a-bearer-scope', 'a-bearer', 200, idsA),
        http('b-session-scope', 'b-session', 200, idsB), http('b-bearer-scope', 'b-bearer', 200, idsB),
        http('a-shared-name', 'a-session', 200, ['w33-a-3']), http('b-shared-name', 'b-session', 200, ['w33-b-3']),
        http('a-zero-owner-only-in-b', 'a-session', 200, []), http('a-zero-text-only-in-b', 'a-session', 200, []),
        http('b-zero-text-only-in-a', 'b-session', 200, []), http('a-cursor-under-a', 'a-session', 200, ['w33-a-2', 'w33-a-1']),
        http('a-cursor-under-b-session', 'b-session', 422, null, 'INVALID_ARGUMENT'),
        http('a-cursor-under-b-bearer', 'b-bearer', 422, null, 'INVALID_ARGUMENT'),
        http('b-cursor-under-a-session', 'a-session', 422, null, 'INVALID_ARGUMENT'),
        http('a-cursor-other-filter-under-a', 'a-session', 422, null, 'INVALID_ARGUMENT'),
        http('a-cursor-other-text-under-a', 'a-session', 422, null, 'INVALID_ARGUMENT'),
        http('forged-cursor-with-b-pointer-under-a', 'a-session', 200, ['w33-a-3', 'w33-a-2']),
        http('project-own-a-session', 'a-session', 200, null), http('project-b-under-a-session', 'a-session', 404, null, 'PROJECT_NOT_FOUND'),
        http('project-own-b-session', 'b-session', 200, null), http('project-a-under-b-session', 'b-session', 404, null, 'PROJECT_NOT_FOUND'),
      ],
      authCases: [
        ['anonymous', 401, 'AUTH_INVALID'], ['expired-session', 401, 'AUTH_INVALID'], ['revoked-session', 401, 'AUTH_INVALID'],
        ['unknown-session-token', 401, 'AUTH_INVALID'], ['malformed-bearer', 401, 'AUTH_INVALID'],
        ['bearer-without-projects-read', 403, 'AUTH_SCOPE_REQUIRED'],
      ].map(([id, status, code]) => ({ id, status, code, category: 'auth' })),
      pageCases: ['anonymous-page', 'expired-session-page', 'revoked-session-page'].map((id) => ({ id, status: 200, landedPath: '/login', next: '/' })),
      uiCases: [
        ui('workspace-a-cards', 'a', idsA), ui('workspace-b-cards', 'b', idsB),
        ui('workspace-a-zero-by-isolation', 'a', [], { existsInOtherWorkspace: 4 }),
        ui('workspace-b-zero-by-isolation', 'b', [], { existsInOtherWorkspace: 3 }),
        ui('workspace-a-shared-name', 'a', ['w33-a-3']), ui('workspace-b-shared-name', 'b', ['w33-b-3']),
        { id: 'session-revoked-during-use-redirects-to-login', workspace: 'a', status: 401, errorCode: 'AUTH_INVALID', landedPath: '/login', cardIds: [] },
        ui('mobile-workspace-b', 'b', idsB),
      ],
      requests: Array.from({ length: 9 }, () => ({ method: 'GET', path: '/v1/projects' })),
      responses: [{ status: 200 }, { status: 401 }],
    }
    writeFileSync(join(directory, 'w33-manifest.json'), JSON.stringify(manifest))
    assert.deepEqual(verifyDashboardListEvidence('w33', directory, binding), { ...binding, runId: manifest.runId })
    const reject = rejecter('w33', directory, 'w33-manifest.json', manifest)
    reject((value) => { value.httpCases[10].status = 200 })
    reject((value) => { value.httpCases[10].ids = [] })
    reject((value) => { value.httpCases[11].actor = 'a-bearer' })
    reject((value) => { value.httpCases[15].ids = ['w33-b-5'] })
    reject((value) => { value.httpCases[0].ids = [...idsA, 'w33-b-1'] })
    reject((value) => { value.httpCases[17].status = 200 })
    reject((value) => { value.authCases[5].status = 401 })
    reject((value) => { value.authCases.pop() })
    reject((value) => { value.pageCases[0].landedPath = '/' })
    reject((value) => { value.uiCases[0].cardIds = [...idsA, 'w33-b-1'] })
    reject((value) => { value.uiCases[2].existsInOtherWorkspace = 0 })
    reject((value) => { value.uiCases[6].landedPath = '/' })
    reject((value) => { value.counts.after.b.projects += 1 })
    reject((value) => { value.leak = 'Bearer abcdefghijkl' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
