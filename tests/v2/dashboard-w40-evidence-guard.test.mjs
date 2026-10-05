import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyJourneyManifests, verifyW40Evidence } from './helpers/dashboard-w40-evidence-guard.mjs'

const commit = 'a'.repeat(40)
const context = { sourceCommit: commit, ciRunId: '4321', applicationName: 'apollo-video-e2e-w29-ci' }
const SIBLINGS = {
  29: 'w29-lut-browser-proof/v1', 30: 'w30-dashboard-browser-proof/v1', 31: 'w31-dashboard-combined-filters/v1',
  32: 'w32-dashboard-pagination/v1', 33: 'w33-dashboard-workspace-isolation/v1', 34: 'w34-dashboard-aggregate/v1',
  35: 'w35-dashboard-states/v1', 36: 'w36-dashboard-events/v1', 37: 'w37-rename-from-card/v1',
  38: 'w38-archive-restore/v1', 39: 'w39-duplicate-copy-on-write/v1',
}
const SCREENSHOTS = [
  'w40-desktop-baseline.png', 'w40-desktop-editor-open.png', 'w40-desktop-editor-review.png', 'w40-desktop-feed-update.png',
  'w40-desktop-rename-pending.png', 'w40-desktop-rename-conflict.png', 'w40-desktop-archive-dialog.png', 'w40-desktop-archived.png',
  'w40-desktop-duplicate-destination.png', 'w40-desktop-duplicate-dashboard.png', 'w40-mobile-error-transport.png',
  'w40-desktop-error-401-login.png', 'w40-desktop-error-404.png', 'w40-mobile-actions.png', 'w40-mobile-archive-dialog.png',
]
const hex = (character, length = 64) => character.repeat(length)
const clone = (value) => JSON.parse(JSON.stringify(value))
const prefix = 'w40-abcdef12'
const ids = { open: 'p-open', review: 'p-review', rename: 'p-rename', archive: 'p-archive', dup: 'p-dup', copy: 'p-copy' }

const command = (action, base, result, extra = {}) => ({
  id: `c-${action}-${base}`, action, baseRevision: base, resultRevision: result, beforeName: null, afterName: null,
  beforeStatus: 'draft', afterStatus: 'draft', beforeArchivedFromStatus: null, afterArchivedFromStatus: null,
  confirmation: 'not-required', actorClientId: 'client', actorAuthenticationKind: 'ui-session', hasDelegatedUser: true,
  workspaceRole: 'administrator', idempotencyKeySha256: hex('1'), commandHash: hex('2'), ...extra,
})
const refusal = (id, status, code, extra = {}) => ({
  id, request: { method: 'POST', path: '/v1/projects/{id}/rename', auth: 'x' },
  expected: { status, code }, observed: { status, code }, persistedUnchanged: true, card: { name: 'n' }, ...extra,
})

function manifest() {
  const requests = [
    ['rename', 1, 'a'], ['rename', 2, 'b'], ['rename', 3, 'c'], ['archive', 1, 'd'], ['archive', 2, 'e'], ['restore', 3, 'f'],
    ['duplicates', null, '0'], ['rename', 4, '5'], ['rename', 4, '5'], ['rename', 5, '6'],
  ].map(([action, base, key]) => ({ method: 'POST', path: `/v1/projects/p/${action}`, body: base ? { baseRevision: base } : {}, idempotencyKeySha256: hex(key) }))
  const filterCase = (id, status, count) => ({
    id, facets: { text: prefix, status }, request: { limit: '24', text: prefix, ...(status ? { status } : {}) },
    responseIds: Array.from({ length: count }, (_, index) => `id-${id}-${index}`), domIds: Array.from({ length: count }, (_, index) => `id-${id}-${index}`), tiles: {},
  })
  const nav = (id, projectId, search, status) => ({
    id, button: 'b', projectId, destination: { pathname: `/projects/${projectId}`, search }, workspaceStatus: 200, workspaceProjectName: 'n',
    returned: { search: `status=${status}&text=${prefix}`, controls: { text: prefix, status }, ids: [] },
  })
  const finalProject = (key, status, commands) => ({
    project: { id: ids[key], status, archivedFromStatus: null }, commands: commands.map(([action, base, result]) => command(action, base, result)),
    events: [], versions: key === 'copy' ? 2 : 1, editCommands: key === 'copy' ? 1 : 0,
  })
  return {
    schemaVersion: 'w40-consolidated/v1', wave: 'w40', runId: '11111111-1111-4111-8111-111111111111', sourceCommit: commit, ciRunId: '4321',
    outcome: 'passed', prefix, database: { applicationName: context.applicationName },
    session: { ageAtStartMs: 200_000, rotateAfterMs: 600_000, identifierMaxAgeMs: 900_000, rotationAtStart: false, rotations: [], rotationsDuringJourney: 0, elapsedAtEndMs: 500_000, finalCookieDiffersFromOriginal: false },
    timing: Object.fromEntries(['filters-and-aggregate', 'open-review-and-return', 'change-by-another-client', 'rename', 'archive-and-restore', 'duplicate', 'transport-controlled', 'security-401-403-404', 'reconcile-and-mobile'].map((name) => [name, 1000])),
    fixtures: {
      open: { projectId: ids.open, origin: 'real-api' },
      review: { projectId: ids.review, origin: 'real-api + controlled-pg-seed (reviewing-proxy)' },
      rename: { projectId: ids.rename, origin: 'real-api' },
      archive: { projectId: ids.archive, origin: 'real-api + controlled-pg-seed (status completed)' },
      dup: { projectId: ids.dup, origin: 'real-api + real master', versionId: 'v-dup', versionBaseHash: hex('3'), masterSha256: hex('4'), masterBytes: 8976, artifactId: 'art-master' },
      copy: { projectId: ids.copy, versionId: 'v-copy' },
      clientB: { clientId: 'w40-api-client-b' },
    },
    filters: [
      filterCase('status-draft', 'draft', 3), filterCase('status-reviewing-proxy', 'reviewing-proxy', 1), filterCase('status-completed', 'completed', 1),
      filterCase('status-failed-empty', 'failed', 0), filterCase('status-archived-empty', 'archived', 0), filterCase('text-only-again', '', 5),
    ],
    aggregate: { facets: { text: prefix }, tiles: { 'Em configuração': 3, 'Em produção': 0, 'Aguardando revisão': 1, Concluídos: 1 }, expected: { 'Em configuração': 3, 'Em produção': 0, 'Aguardando revisão': 1, Concluídos: 1 }, ids: ['1', '2', '3', '4', '5'] },
    navigation: [
      nav('open-primary-draft', ids.open, '', 'draft'), nav('open-secondary-draft', ids.open, '', 'draft'),
      nav('review-primary', ids.review, '?mode=review', 'reviewing-proxy'), nav('review-secondary', ids.review, '?mode=review', 'reviewing-proxy'),
    ],
    readOnlyPhases: [
      { phase: 'filters-and-aggregate', mutatingRequests: 0, requests: { 'GET /v1/projects': 7 }, counters: 'stable' },
      { phase: 'open-review-and-return', mutatingRequests: 0, requests: { 'GET /v1/projects': 9, 'GET /v1/projects/{id}/workspace': 4 }, counters: 'stable' },
    ],
    feed: {
      actor: { clientId: 'w40-api-client-b', authentication: 'bearer' }, command: command('rename', 1, 2, { actorClientId: 'w40-api-client-b', actorAuthenticationKind: 'bearer' }),
      event: { id: 'evt', type: 'project.name.changed' }, feedResponse: { status: 200, hadCursor: true, containsEventId: true },
      refetch: { status: 200, revision: 2, name: 'x' }, card: { name: 'x', revision: 2 }, documentReloaded: false, browserMutatingRequests: 0,
      requestCountsSinceChange: { 'GET /v1/events/feed': 2, 'GET /v1/projects': 1 }, timeline: { mutationToFeedMs: 3500, mutationToDomMs: 4000 },
    },
    actions: {
      rename: { request: { method: 'POST', path: '/v1/projects/p/rename', idempotencyKeySha256: hex('1') }, command: command('rename', 1, 2), pendingCardName: 'old', confirmedCardName: 'new', projectChangedKeys: ['administrationRevision', 'name', 'updatedAt'], replayStatus: 200 },
      archive: {
        cancelledMutatingRequests: 0, previousStatus: 'completed',
        archive: { command: command('archive', 2, 3, { beforeStatus: 'completed', afterStatus: 'archived', afterArchivedFromStatus: 'completed', confirmation: 'explicit' }), cardState: 'archived', counterConcluidos: 0 },
        restore: { command: command('restore', 3, 4, { beforeStatus: 'archived', beforeArchivedFromStatus: 'completed', afterStatus: 'completed' }), cardState: 'completed', counterConcluidos: 1 },
        versionsIdentical: true, snapshotsIdentical: true, finalProject: { status: 'completed', archivedFromStatus: null },
      },
      duplicate: {
        request: { method: 'POST', path: '/v1/projects/p-dup/duplicates', body: { expectedVersionId: 'v-dup', expectedVersionHash: hex('3'), name: 'n' }, idempotencyKeySha256: hex('0') },
        responseStatus: 201, replayAfterCommandStatus: 200, copy: { projectId: ids.copy, versionId: 'v-copy' },
        lineage: { duplicatedFromProjectId: ids.dup, forkedFromProjectId: ids.dup, forkedFromVersionId: 'v-dup', parentVersionId: null },
        versionHash: { source: hex('3'), copy: hex('5'), differs: true, followsContractFormula: true },
        snapshots: [
          { kind: 'brief', rebound: false, contentHash: hex('6'), copyContentHash: hex('6') },
          { kind: 'edit-plan', rebound: true, contentHash: hex('7'), copyContentHash: hex('8') },
          { kind: 'policies', rebound: false, contentHash: hex('9'), copyContentHash: hex('9') },
        ],
        creationCommand: { action: 'duplicate', actorAuthenticationKind: 'ui-session', hasDelegatedUser: true },
        sharedArtifactIds: ['art-master'], copiedBytes: 0, objectCounts: { projectReferences: 2, workspaceMediaArtifacts: 9, storageObjects: 1 },
        storage: [{ key: 'w40/x/master-original.mp4', bytes: 8976, sha256: hex('4') }], master: { sha256: hex('4'), bytes: 8976, unchanged: true },
        destination: { urlPath: `/projects/${ids.copy}`, workspaceStatus: 200, mediaArtifactIds: ['art-master'] },
        commandOnCopy: { type: 'set-project-lut-selection', copyVersionSequenceAfter: 2, copyEditCommands: 1, sourceEditCommands: 0, cards: { source: 'v1', copy: 'v2' } },
        sourceUnchanged: true,
      },
    },
    cases: [
      refusal('revoked-session-in-use-401', 401, 'AUTH_INVALID', { observed: { status: 401, code: 'AUTH_INVALID', landing: '/login' } }),
      refusal('expired-session-401', 401, 'AUTH_INVALID'), refusal('anonymous-401', 401, 'AUTH_INVALID'),
      refusal('scope-rename-403', 403, 'AUTH_SCOPE_REQUIRED'), refusal('scope-archive-403', 403, 'AUTH_SCOPE_REQUIRED'), refusal('scope-duplicate-403', 403, 'AUTH_SCOPE_REQUIRED'),
      refusal('foreign-credential-rename-404', 404, 'PROJECT_NOT_FOUND'), refusal('foreign-credential-archive-404', 404, 'PROJECT_NOT_FOUND'),
      refusal('foreign-credential-duplicate-404', 404, 'PROJECT_NOT_FOUND'), refusal('foreign-human-session-rename-404', 404, 'PROJECT_NOT_FOUND'),
      refusal('nonexistent-project-404', 404, 'PROJECT_NOT_FOUND'),
      refusal('workspace-switched-in-another-tab-404', 404, 'PROJECT_NOT_FOUND', { observed: { status: 404, code: 'PROJECT_NOT_FOUND', errorVisibleInDialog: true } }),
      refusal('stale-rename-409', 409, 'VERSION_CONFLICT', { timingAid: 'the dashboard feed poll was held until the refused request returned', observed: { status: 409, code: 'VERSION_CONFLICT', errorVisibleInDialog: true, browserCommandsWritten: 0 } }),
      refusal('stale-archive-409', 409, 'VERSION_CONFLICT', { timingAid: 'the dashboard feed poll was held until the refused request returned', observed: { status: 409, code: 'VERSION_CONFLICT', errorVisibleInDialog: true, persistedStatus: 'completed' } }),
      refusal('stale-duplicate-409', 409, 'VERSION_CONFLICT'), refusal('stale-rename-api-409', 409, 'VERSION_CONFLICT'), refusal('stale-archive-api-409', 409, 'VERSION_CONFLICT'),
      { id: 'session-rotation-real-path', expected: {}, observed: { rotated: true, successorStatus: 200, previousTokenStatus: 401, previousTokenCode: 'AUTH_INVALID', previousRowRevoked: true } },
      { id: 'recovery-after-409', expected: { status: 200 }, observed: { status: 200 } },
      { id: 'expired-session-page-redirect', expected: { landing: '/login' }, observed: { landing: '/login' } },
      { id: 'transport-failure-before-send', controlled: true, expected: {}, observed: { errorShown: true, commandsWrittenByFailedAttempt: 0, retryReusesKey: true, cardNameAfterFailure: 'a', cardNameAfterRetry: 'b' } },
      { id: 'transport-response-lost-after-commit', controlled: true, expected: {}, observed: { errorShown: true, cardName: 'z', persistedName: 'z', replayed: true, commands: 5 } },
    ],
    browser: { pid: 321, mutatingRequests: 10, requests, mobileOverflowPx: 0, feedPolls: 40, requestCounts: {} },
    final: {
      outsidePrefixUnchanged: true,
      projects: {
        open: finalProject('open', 'draft', [['rename', 1, 2]]), review: finalProject('review', 'reviewing-proxy', []),
        rename: finalProject('rename', 'draft', [['rename', 1, 2], ['rename', 2, 3], ['rename', 3, 4], ['rename', 4, 5], ['rename', 5, 6]]),
        archive: finalProject('archive', 'completed', [['rename', 1, 2], ['archive', 2, 3], ['restore', 3, 4]]),
        dup: finalProject('dup', 'draft', []), copy: finalProject('copy', 'draft', []),
      },
    },
    screenshots: [], postflight: { browserProcessTerminal: true, cleanupErrors: [], storageCleanup: 'artifact-root-removed' },
  }
}

function write(directory, value, { shots = true } = {}) {
  mkdirSync(directory, { recursive: true })
  if (shots) {
    value.screenshots = SCREENSHOTS.map((name, index) => {
      const bytes = Buffer.from(`${name}-${index}-`.repeat(40))
      writeFileSync(join(directory, name), bytes)
      return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    })
  }
  writeFileSync(join(directory, 'w40-manifest.json'), JSON.stringify(value))
}

function world(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'w40-guard-'))
  const directory = join(root, 'w40')
  const value = manifest()
  const siblings = {}
  for (const [wave, schemaVersion] of Object.entries(SIBLINGS)) {
    siblings[wave] = join(root, `w${wave}`)
    mkdirSync(siblings[wave], { recursive: true })
    writeFileSync(join(siblings[wave], `w${wave}-manifest.json`), JSON.stringify({ schemaVersion, outcome: 'passed', sourceCommit: commit, ciRunId: '4321', postflight: { cleanupErrors: [] } }))
  }
  mutate?.(value, { root, siblings })
  write(directory, value)
  return { root, directory, siblings, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('W40 guard accepts a coherent manifest bound to the commit, the run and the W29-W39 manifests', () => {
  const { directory, siblings, cleanup } = world()
  try { assert.match(verifyW40Evidence(directory, context, { siblings }).runId, /^[a-f0-9-]{36}$/) } finally { cleanup() }
})

test('W40 guard rejects drift in destinations, errors, controlled labels, requests and reconciliation', () => {
  const byId = (value, id) => value.cases.find((item) => item.id === id)
  const mutations = {
    'review primary without review mode': (m) => { m.navigation.find((item) => item.id === 'review-primary').destination.search = '' },
    'open primary with review mode': (m) => { m.navigation.find((item) => item.id === 'open-primary-draft').destination.search = '?mode=review' },
    'filters lost after coming back': (m) => { m.navigation[0].returned.controls.status = '' },
    'cards differ from the response': (m) => { m.filters[0].domIds = ['other'] },
    'empty filter with ids': (m) => { m.filters.find((item) => item.id === 'status-failed-empty').responseIds = ['x'] },
    'aggregate drift': (m) => { m.aggregate.tiles.Concluídos = 2 },
    'read-only phase with a mutation': (m) => { m.readOnlyPhases[0].mutatingRequests = 1 },
    'read-only phase with a POST': (m) => { m.readOnlyPhases[1].requests['POST /v1/projects/{id}/rename'] = 1 },
    'counters changed': (m) => { m.readOnlyPhases[1].counters = 'changed' },
    'feed update by reload': (m) => { m.feed.documentReloaded = true },
    'feed event missing': (m) => { m.feed.feedResponse.containsEventId = false },
    'feed with browser mutation': (m) => { m.feed.browserMutatingRequests = 1 },
    'feed without refetch': (m) => { delete m.feed.requestCountsSinceChange['GET /v1/projects'] },
    'feed actor not a Bearer client': (m) => { m.feed.command.actorAuthenticationKind = 'ui-session' },
    'rename without pending proof': (m) => { m.actions.rename.pendingCardName = m.actions.rename.confirmedCardName },
    'archive previous status lost': (m) => { m.actions.archive.restore.command.afterStatus = 'draft' },
    'archive without cancel proof': (m) => { m.actions.archive.cancelledMutatingRequests = 1 },
    'duplicate copied bytes': (m) => { m.actions.duplicate.copiedBytes = 8976 },
    'duplicate with a second storage object': (m) => { m.actions.duplicate.objectCounts.storageObjects = 2 },
    'duplicate lineage broken': (m) => { m.actions.duplicate.lineage.forkedFromProjectId = 'other' },
    'duplicate hash equal to the source': (m) => { m.actions.duplicate.versionHash.copy = m.actions.duplicate.versionHash.source },
    'master hash changed': (m) => { m.actions.duplicate.master.sha256 = hex('0') },
    'edit plan not rebound': (m) => { m.actions.duplicate.snapshots[1].rebound = false },
    '403 reported as 404': (m) => { byId(m, 'scope-rename-403').observed.status = 404 },
    '404 accepted as 403': (m) => { byId(m, 'foreign-credential-rename-404').observed = { status: 403, code: 'AUTH_SCOPE_REQUIRED' } },
    '401 code swapped': (m) => { byId(m, 'anonymous-401').observed.code = 'AUTH_SCOPE_REQUIRED' },
    '409 missing': (m) => { m.cases = m.cases.filter((item) => item.id !== 'stale-rename-409') },
    'refusal without card binding': (m) => { delete byId(m, 'scope-archive-403').card },
    'refusal that changed state': (m) => { byId(m, 'foreign-credential-archive-404').persistedUnchanged = false },
    'real refusal labelled controlled': (m) => { byId(m, 'stale-rename-409').controlled = true },
    'stale case without its timing aid disclosed': (m) => { delete byId(m, 'stale-archive-409').timingAid },
    'rotation not exercised': (m) => { byId(m, 'session-rotation-real-path').observed.previousTokenStatus = 200 },
    'controlled case unlabelled': (m) => { delete byId(m, 'transport-failure-before-send').controlled },
    'transport retry changed the key': (m) => { m.browser.requests[8].idempotencyKeySha256 = hex('9') },
    'transport card moved before the retry': (m) => { byId(m, 'transport-failure-before-send').observed.cardNameAfterFailure = 'b' },
    'lost response replay missing': (m) => { byId(m, 'transport-response-lost-after-commit').observed.replayed = false },
    'revoked session did not land on login': (m) => { byId(m, 'revoked-session-in-use-401').observed.landing = '/' },
    'browser sent an unlisted mutation': (m) => { m.browser.requests.push(m.browser.requests[0]); m.browser.mutatingRequests = 11 },
    'rotation before the product threshold': (m) => { m.session.rotations = [{ at: 'x', ageMs: 5000 }]; m.session.rotationsDuringJourney = 1 },
    'session outlived its identifier without rotation': (m) => { m.session.elapsedAtEndMs = 1_000_000 },
    'final history wrong': (m) => { m.final.projects.rename.commands.pop() },
    'outside rows touched': (m) => { m.final.outsidePrefixUnchanged = false },
    'review fixture seed hidden': (m) => { m.fixtures.review.origin = 'real-api' },
    'cleanup error': (m) => { m.postflight.cleanupErrors = ['browser-server:Error'] },
    'wrong commit': (m) => { m.sourceCommit = 'b'.repeat(40) },
    'wrong schema': (m) => { m.schemaVersion = 'w40-consolidated/v0' },
    'failed outcome': (m) => { m.outcome = 'failed' },
    'bearer value in the manifest': (m) => { m.leak = 'Bearer apollo_v2.token' },
    'cookie value in the manifest': (m) => { m.leak = 'apollo_session=abc' },
    'missing screenshot entry': () => undefined,
  }
  for (const [name, mutate] of Object.entries(mutations)) {
    const { directory, siblings, cleanup } = world((value) => {
      mutate(value)
    })
    try {
      if (name === 'missing screenshot entry') {
        const value = JSON.parse(readFileSync(join(directory, 'w40-manifest.json'), 'utf8'))
        value.screenshots.pop()
        writeFileSync(join(directory, 'w40-manifest.json'), JSON.stringify(value))
      }
      assert.throws(() => verifyW40Evidence(directory, context, { siblings }), undefined, `must reject: ${name}`)
    } finally { cleanup() }
  }
})

test('W40 guard rejects a sibling manifest from another commit, another run or a failed wave, and a tampered screenshot', () => {
  for (const mutate of [
    (siblings) => { const path = join(siblings[31], 'w31-manifest.json'); writeFileSync(path, JSON.stringify({ schemaVersion: SIBLINGS[31], outcome: 'passed', sourceCommit: 'c'.repeat(40), ciRunId: '4321', postflight: { cleanupErrors: [] } })) },
    (siblings) => { const path = join(siblings[36], 'w36-manifest.json'); writeFileSync(path, JSON.stringify({ schemaVersion: SIBLINGS[36], outcome: 'passed', sourceCommit: commit, ciRunId: '1', postflight: { cleanupErrors: [] } })) },
    (siblings) => { const path = join(siblings[39], 'w39-manifest.json'); writeFileSync(path, JSON.stringify({ schemaVersion: SIBLINGS[39], outcome: 'failed', sourceCommit: commit, ciRunId: '4321', postflight: { cleanupErrors: [] } })) },
    (siblings) => { rmSync(join(siblings[29], 'w29-manifest.json')) },
  ]) {
    const { siblings, cleanup } = world()
    try {
      mutate(siblings)
      assert.throws(() => verifyJourneyManifests(siblings, context))
    } finally { cleanup() }
  }
  const { directory, siblings, cleanup } = world()
  try {
    writeFileSync(join(directory, 'w40-desktop-baseline.png'), Buffer.from('tampered'.repeat(40)))
    assert.throws(() => verifyW40Evidence(directory, context, { siblings }))
  } finally { cleanup() }
})

test('W40 guard rejects proof code that could fake the feed chain with a synthetic event', () => {
  const { directory, siblings, cleanup } = world()
  try {
    assert.throws(() => verifyW40Evidence(directory, context, { siblings, source: "page.evaluate(() => window.dispatchEvent(new Event('x')))" }))
    assert.doesNotThrow(() => verifyW40Evidence(directory, context, { siblings }))
  } finally { cleanup() }
})
