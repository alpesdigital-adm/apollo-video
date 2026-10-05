import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyW36Evidence } from './helpers/dashboard-w36-evidence-guard.mjs'

const commit = 'b'.repeat(40)
const app = 'apollo-video-e2e-w36-ci'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const t = (offsetMs) => new Date(Date.parse('2026-10-04T12:00:00.000Z') + offsetMs).toISOString()
const proofSource = readFileSync(new URL('./helpers/dashboard-w36-events-proof.mjs', import.meta.url), 'utf8')

function fixture(mutate) {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-w36-guard-'))
  const bytes = Buffer.alloc(160, 7)
  const screenshots = ['w36-desktop-updated.png', 'w36-mobile-updated.png'].map((name) => {
    writeFileSync(join(directory, name), bytes)
    return { name, sha256: sha(bytes), bytes: bytes.length }
  })
  const policy = { intervalMs: 4000, maxBackoffMs: 30000, maxConsecutiveFailures: 4, continuationDelayMs: 250, pageLimit: 50 }
  const manifest = {
    schemaVersion: 'w36-dashboard-events/v1', outcome: 'passed', sourceCommit: commit, ciRunId: '4321',
    runId: '22222222-2222-4222-8222-222222222222', database: { applicationName: app },
    browser: { pid: 77, sessionVerifiedBeforeDashboard: true, mobileOverflowPx: 0 },
    postflight: { browserProcessTerminal: true, cleanupErrors: [] },
    contract: { path: '/v1/events/feed', method: 'GET', capabilityId: 'apollo.events.feed.list', policy },
    scope: { demonstrated: ['project.name.changed'], notDemonstrated: ['operation status and progress events'] },
    fixtures: { workspaceId: 'ws-a', otherWorkspaceId: 'ws-b' },
    cases: {
      bootstrap: { firstRequestQuery: { startAt: 'latest', limit: '50' }, bootstrapEvents: 0, historyEventsInPostgres: 3, dashboardProjectGets: 1 },
      idlePolling: { intervalsMs: [4100, 4090, 4120, 4110], n: 4, minMs: 4090, maxMs: 4120, projectGetsDuringIdle: 0 },
      externalRename: {
        projectId: 'p1', baseRevision: 2, resultRevision: 3, nameBefore: 'a', nameAfter: 'b',
        postgres: { command: { action: 'rename', eventId: 'e1' }, outbox: { id: 'e1', type: 'project.name.changed', createdAt: t(0) } },
        feedEvent: { id: 'e1', type: 'project.name.changed', sequence: 3, resourceId: 'p1' },
        refetch: { row: { revision: 3, name: 'b' } },
        timeline: { mutationAt: t(10), feedResponseAt: t(2500), refetchResponseAt: t(2800), domUpdatedAt: t(2900), mutationToDomMs: 2890 },
      },
      externalArchive: {
        projectId: 'p2', baseRevision: 1, resultRevision: 2, statusAfter: 'archived',
        postgres: { outbox: { id: 'e2', type: 'project.status.changed' } },
        feedEvent: { id: 'e2', type: 'project.status.changed', sequence: 2, resourceId: 'p2' },
        refetchRow: { state: 'archived', revision: 2 },
        timeline: { feedResponseAt: t(9000), refetchResponseAt: t(9300) },
      },
      noReloadNoSyntheticEvent: {
        navigationsAfterMark: 0, documentIdentityPreserved: true, syntheticDispatchEvents: 0, pageReloads: 0,
        explicitNavigationsAfterMark: 0, browserMutatingRequests: 0, skeletonFlashes: 0,
      },
      otherWorkspace: {
        mutatedProjectId: 'po', postgres: { outbox: { workspaceId: 'ws-b', createdAt: t(20000) } },
        watermarkPassedRowAt: t(20100), feedResponsesAfterMutation: 3, eventsDelivered: 0,
        dashboardProjectRequestsAfterMutation: 0, projectsResponsesAfterMutation: 0, leakedBytes: false,
        cardsUnchanged: true, clientBReadFromBeginning: { events: 5, foreignEvents: 0 },
      },
      delayedResponse: {
        delayedMs: 12000, older: { revision: 4, name: 'old' }, newer: { revision: 5, name: 'new', shownAt: t(30000) },
        releasedAt: t(40000), finalCardName: 'new', olderStateDeliveredToPage: false,
      },
      unmount: { feedRequestsAfterLeave: 0, clientSideNavigation: true, observedMs: 10000, remountRestartsAtHead: true },
      boundedRetries: {
        attempts: 4, requestsAfterLimit: 0, quietAfterLimitMs: 32500, statuses: [503, 503, 503, 503],
        gapsMs: [8010, 16020, 30040], cardsStillRenderedFromProjects: true,
      },
    },
    screenshots,
    requests: { feedResponses: [{ events: [{ id: 'e1', resourceId: 'p1' }] }] },
  }
  mutate?.(manifest, directory)
  writeFileSync(join(directory, 'w36-manifest.json'), JSON.stringify(manifest))
  return directory
}

const verify = (directory, source = proofSource) =>
  verifyW36Evidence(directory, { sourceCommit: commit, ciRunId: '4321', applicationName: app }, { source })

test('F1.001 W36 guard accepts a complete external-event chain', () => {
  assert.equal(verify(fixture()).runId, '22222222-2222-4222-8222-222222222222')
})

test('F1.001 W36 guard rejects updates that could come from reload or a synthetic event', () => {
  assert.throws(() => verify(fixture((m) => { m.cases.noReloadNoSyntheticEvent.navigationsAfterMark = 1 })))
  assert.throws(() => verify(fixture((m) => { m.cases.noReloadNoSyntheticEvent.documentIdentityPreserved = false })))
  assert.throws(() => verify(fixture((m) => { m.cases.noReloadNoSyntheticEvent.syntheticDispatchEvents = 1 })))
  assert.throws(() => verify(fixture(), `${proofSource}\nwindow.dispatchEvent(new Event('x'))`), /dispatchEvent/)
  assert.throws(() => verify(fixture(), `${proofSource}\nawait page.reload()`), /reload/)
  assert.throws(() => verify(fixture(), `${proofSource}\n'apollo:project-updated'`), /apollo:project-updated/)
})

test('F1.001 W36 guard binds the card update to the persisted event and an ordered chain', () => {
  assert.throws(() => verify(fixture((m) => { m.cases.externalRename.feedEvent.id = 'other' })))
  assert.throws(() => verify(fixture((m) => { m.cases.externalRename.refetch.row.revision = 2 })))
  assert.throws(() => verify(fixture((m) => { m.cases.externalRename.timeline.refetchResponseAt = t(100) })))
  assert.throws(() => verify(fixture((m) => { m.cases.externalRename.timeline.feedResponseAt = t(-5) })))
  assert.throws(() => verify(fixture((m) => { m.cases.externalArchive.feedEvent.type = 'project.name.changed' })))
})

test('F1.001 W36 guard rejects any foreign-workspace invalidation, leak or unbounded behaviour', () => {
  assert.throws(() => verify(fixture((m) => { m.cases.otherWorkspace.dashboardProjectRequestsAfterMutation = 1 })))
  assert.throws(() => verify(fixture((m) => { m.cases.otherWorkspace.leakedBytes = true })))
  assert.throws(() => verify(fixture((m) => { m.cases.otherWorkspace.watermarkPassedRowAt = t(19000) })))
  assert.throws(() => verify(fixture((m) => { m.requests.feedResponses[0].events[0].resourceId = 'po' })))
  assert.throws(() => verify(fixture((m) => { m.cases.unmount.feedRequestsAfterLeave = 1 })))
  assert.throws(() => verify(fixture((m) => { m.cases.delayedResponse.olderStateDeliveredToPage = true })))
  assert.throws(() => verify(fixture((m) => { m.cases.delayedResponse.finalCardName = 'old' })))
  assert.throws(() => verify(fixture((m) => { m.cases.boundedRetries.requestsAfterLimit = 1 })))
  assert.throws(() => verify(fixture((m) => { m.cases.boundedRetries.gapsMs = [8000, 8000, 8000] })))
  assert.throws(() => verify(fixture((m) => { m.cases.idlePolling.minMs = 500 })))
  assert.throws(() => verify(fixture((m) => { m.contract.policy.intervalMs = 100 })))
})

test('F1.001 W36 guard rejects fake provenance, wrong scope claims, secrets and tampered screenshots', () => {
  assert.throws(() => verify(fixture((m) => { m.sourceCommit = 'c'.repeat(40) })))
  assert.throws(() => verify(fixture((m) => { m.outcome = 'failed' })))
  assert.throws(() => verify(fixture((m) => { m.postflight.cleanupErrors = ['x'] })))
  assert.throws(() => verify(fixture((m) => { m.scope.notDemonstrated = [] })))
  assert.throws(() => verify(fixture((m) => { m.leak = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' })))
  assert.throws(() => verify(fixture((m, directory) => { writeFileSync(join(directory, m.screenshots[0].name), Buffer.alloc(160, 8)) })))
  assert.throws(() => verify(fixture((m) => { delete m.cases.delayedResponse })))
})
