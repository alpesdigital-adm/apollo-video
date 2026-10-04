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
const EMPTY = { text: '', status: '', objective: '', format: '', locale: '', createdFrom: '', createdTo: '', ownerId: '' }
const f = (overrides) => ({ ...EMPTY, ...overrides })
const request = (facets) => {
  const value = { limit: '24' }
  for (const [key, item] of Object.entries(facets)) {
    if (!item) continue
    value[key] = key === 'createdFrom' ? `${item}T00:00:00.000Z` : key === 'createdTo' ? `${item}T23:59:59.999Z` : item
  }
  return value
}
const url = (facets) => {
  const params = new URLSearchParams()
  for (const [key, item] of Object.entries(facets)) if (item) params.set(key, item)
  return params.size ? `?${params}` : ''
}
const entry = (id, facets, ids) => ({ id, facets, url: url(facets), request: request(facets), status: 200, responseIds: ids, cardIds: ids, expectedIds: ids })

const DAY = '2026-02-10'
const ALL = f({ text: 'w31-alfa', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdFrom: DAY, createdTo: DAY, ownerId: 'w31-owner-ana' })
const SIX = { ...ALL, createdFrom: '', createdTo: '' }
const many = Array.from({ length: 10 }, (_, index) => `w31-bulk-${index}`)
const sixIds = ['w31-day-after', 'w31-edge-end', 'w31-anchor', 'w31-edge-start', 'w31-day-before']
const allIds = ['w31-edge-end', 'w31-anchor', 'w31-edge-start']

function w31Manifest(directory) {
  const bytes = Buffer.alloc(160, 7)
  const screenshots = ['w31-desktop-all-eight.png', 'w31-mobile-all-eight.png'].map((name) => {
    writeFileSync(join(directory, name), bytes)
    return { name, sha256: sha(bytes), bytes: bytes.length }
  })
  const uiCases = [
    entry('individual-text', f({ text: 'w31-alfa' }), many),
    entry('individual-status', f({ status: 'canceled' }), ['w31-other-status']),
    entry('individual-objective', f({ objective: 'sale' }), ['w31-other-objective']),
    entry('individual-format', f({ format: '16:9' }), ['w31-other-format']),
    entry('individual-locale', f({ locale: 'en-US' }), ['w31-other-locale']),
    entry('individual-created-from', f({ createdFrom: DAY }), many),
    entry('individual-created-to', f({ createdTo: DAY }), many),
    entry('individual-owner', f({ ownerId: 'w31-owner-bia' }), ['w31-other-owner']),
    entry('six-facets-without-dates', SIX, sixIds),
    entry('dates-only', f({ createdFrom: DAY, createdTo: DAY }), many),
    entry('all-eight', ALL, allIds),
    entry('zero-owner-and-locale-conflict', { ...ALL, ownerId: 'w31-owner-bia', locale: 'en-US' }, []),
    entry('zero-day-without-projects', { ...ALL, createdFrom: '2026-02-12', createdTo: '2026-02-12' }, []),
    entry('zero-individual-owner', f({ ownerId: 'w31-owner-nobody' }), []),
  ]
  const persistence = [
    entry('explicit-url-all-eight', ALL, allIds), entry('all-eight-reload', ALL, allIds),
    entry('all-eight-session-fallback', ALL, allIds), entry('explicit-url-over-session', SIX, sixIds),
    entry('explicit-url-updated-session-fallback', SIX, sixIds),
    entry('url-invalid-values-dropped', f({ text: 'w31-alfa' }), many),
    entry('url-invalid-values-session-fallback', f({ text: 'w31-alfa' }), many),
    entry('url-reversed-range-drops-created-to', f({ text: 'w31-alfa', createdFrom: '2026-02-12' }), []),
    entry('ui-created-from-after-created-to-clears-created-to', { ...ALL, createdFrom: '2026-02-12', createdTo: '' }, []),
    entry('mobile-all-eight', ALL, allIds),
  ]
  const counts = { projects: 13, versions: 2, editCommands: 0, creationCommands: 2, administrationCommands: 1 }
  const rows = [{ id: 'project-a', name: 'a', status: 'draft', createdAt: '2026-10-04T00:00:00.000Z' }]
  return {
    schemaVersion: 'w31-dashboard-combined-filters/v1', outcome: 'passed',
    sourceCommit: commit, ciRunId: '1234', runId: '11111111-1111-4111-8111-111111111111',
    database: { applicationName: 'apollo-video-e2e-w29-ci' },
    browser: { pid: 321, mutatingRequests: 0, mobileOverflowPx: 0 },
    postflight: { browserProcessTerminal: true, browserPidAliveAtEnd: false, cleanupErrors: [] },
    counts: { before: counts, after: counts }, projectRowsBefore: rows, projectRowsAfter: rows,
    fixtures: Array.from({ length: 11 }, (_, index) => ({ id: `w31-fixture-${index}` })),
    uiCases, persistence,
    apiCases: uiCases.map((item) => ({ id: item.id, status: 200, ids: item.expectedIds, oracleIds: item.expectedIds })),
    boundaryCases: [
      { id: 'created-from-inclusive-start', ids: ['w31-edge-start'] },
      { id: 'created-from-excludes-one-ms-earlier', ids: [] },
      { id: 'created-to-inclusive-end', ids: ['w31-edge-end'] },
      { id: 'created-to-excludes-one-ms-later', ids: [] },
      { id: 'day-bounds-from-codec', ids: allIds },
    ],
    invalidCases: ['status', 'objective-pattern', 'format', 'locale', 'owner-id', 'created-from', 'created-to',
      'range-reversed', 'text-length', 'limit-zero', 'limit-over', 'cursor-malformed', 'unknown-parameter',
      'repeated-parameter'].map((id) => ({ id, status: 422, code: 'INVALID_ARGUMENT' })),
    apiAcceptsWellFormedUnknownObjective: true,
    requests: Array.from({ length: 14 }, () => ({ method: 'GET', path: '/v1/projects' })),
    responses: Array.from({ length: 14 }, () => ({ status: 200 })), screenshots,
  }
}

test('W31 CI guard accepts bound evidence and rejects any tampered binding, case or screenshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-w31-guard-'))
  try {
    const manifest = w31Manifest(directory)
    const save = () => writeFileSync(join(directory, 'w31-manifest.json'), JSON.stringify(manifest))
    save()
    assert.deepEqual(verifyDashboardListEvidence('w31', directory, binding), { ...binding, runId: manifest.runId })
    assert.throws(() => verifyDashboardListEvidence('w31', directory, { ...binding, sourceCommit: 'b'.repeat(40) }))
    assert.throws(() => verifyDashboardListEvidence('w31', directory, { ...binding, applicationName: 'apollo-video-e2e-other' }))
    assert.throws(() => verifyDashboardListEvidence('w99', directory, binding), /unknown dashboard list wave/)

    const mutate = (change) => {
      const snapshot = JSON.stringify(manifest)
      change(manifest)
      save()
      assert.throws(() => verifyDashboardListEvidence('w31', directory, binding))
      const restored = JSON.parse(snapshot)
      for (const key of Object.keys(manifest)) if (!(key in restored)) delete manifest[key]
      Object.assign(manifest, restored)
      save()
    }
    mutate((value) => { value.uiCases.pop() })
    mutate((value) => { value.uiCases[10].cardIds = ['w31-anchor'] })
    mutate((value) => { value.uiCases[10].responseIds = ['w31-anchor'] })
    mutate((value) => { value.uiCases[10].request.createdTo = '2026-02-10T00:00:00.000Z' })
    mutate((value) => { value.uiCases[10].url = '?text=w31-alfa' })
    mutate((value) => { value.persistence[5].request = { limit: '24', text: 'w31-alfa', status: 'bogus' } })
    mutate((value) => { value.boundaryCases[0].ids = [] })
    mutate((value) => { value.invalidCases[0].status = 200 })
    mutate((value) => { value.browser.mutatingRequests = 1 })
    mutate((value) => { value.browser.mobileOverflowPx = 12 })
    mutate((value) => { value.counts.after.projects += 1 })
    mutate((value) => { value.requests[0].method = 'POST' })
    mutate((value) => { value.fixtures.pop() })
    mutate((value) => { value.postflight.cleanupErrors = ['browser-process-not-terminal'] })
    mutate((value) => { value.postflight.browserPidAliveAtEnd = true })
    mutate((value) => { value.leak = 'apollo_session=abc' })
    writeFileSync(join(directory, 'w31-mobile-all-eight.png'), Buffer.alloc(160, 8))
    assert.throws(() => verifyDashboardListEvidence('w31', directory, binding))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
