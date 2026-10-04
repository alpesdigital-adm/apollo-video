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
  return { sourceCommit: context.sourceCommit, ciRunId: context.ciRunId, runId: manifest.runId }
}

const VERIFIERS = { w31: verifyW31Evidence }

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
