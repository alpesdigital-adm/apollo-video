import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyW30Evidence } from './helpers/project-dashboard-evidence-guard.mjs'

const commit = 'a'.repeat(40)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const rows = [
  { id: 'project-a', name: 'Projeto renomeado', status: 'draft' },
  { id: 'project-b', name: 'UI delegated audit project', status: 'draft' },
]
const card = (row) => ({ id: row.id, name: row.name })
const both = rows.map(card)
const first = [card(rows[0])]
const second = [card(rows[1])]

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-w30-guard-'))
  const bytes = Buffer.alloc(160, 9)
  const screenshots = ['w30-desktop-filtered.png', 'w30-mobile-filtered.png'].map((name) => {
    writeFileSync(join(directory, name), bytes)
    return { name, sha256: sha(bytes), bytes: bytes.length }
  })
  const transitions = [
    { step: 'status-excludes', cards: [] },
    { step: 'ui-text-status', cards: first },
    { step: 'reload', cards: first },
    { step: 'session-fallback', cards: first },
    { step: 'url-precedence', cards: second },
    { step: 'updated-session-fallback', cards: second },
    { step: 'native-popstate-back-forward', cards: first, sameDocument: true, popCount: 2 },
    { step: 'zero-results', cards: [] },
    { step: 'clear', cards: both, search: '' },
    { step: 'mobile-text', cards: second },
  ]
  const counts = { projects: 2, versions: 2, editCommands: 0, creationCommands: 2, administrationCommands: 1 }
  const manifest = {
    schemaVersion: 'w30-dashboard-browser-proof/v1', outcome: 'passed',
    sourceCommit: commit, ciRunId: '1234', runId: '11111111-1111-4111-8111-111111111111',
    database: { applicationName: 'apollo-video-e2e-w29-ci' },
    projectIds: rows.map((row) => row.id), expected: rows,
    projectRowsBefore: rows, projectRowsAfter: rows,
    browser: { pid: 123, mutatingRequests: 0, mobileOverflowPx: 0 },
    postflight: { browserProcessTerminal: true, cleanupErrors: [] },
    counts: { before: counts, after: counts }, transitions,
    requests: Array.from({ length: 5 }, () => ({ method: 'GET', path: '/v1/projects', filters: { text: rows[0].name, status: 'draft' } })),
    responses: [
      { status: 200, text: rows[0].name, filterStatus: 'draft', cards: first },
      { status: 200, text: rows[0].name, filterStatus: 'completed', cards: [] },
      { status: 200, text: rows[1].name, filterStatus: 'draft', cards: second },
      { status: 200, text: '', filterStatus: '', cards: both },
      { status: 200, text: '', filterStatus: '', cards: both },
    ], screenshots,
  }
  const save = () => writeFileSync(join(directory, 'w30-manifest.json'), JSON.stringify(manifest))
  save()
  return { directory, manifest, save }
}

test('W30 CI guard accepts bound evidence and rejects tampered visual, history and mutation proof', () => {
  const { directory, manifest, save } = fixture()
  try {
    const binding = { sourceCommit: commit, ciRunId: '1234', applicationName: 'apollo-video-e2e-w29-ci' }
    assert.deepEqual(verifyW30Evidence(directory, binding), { ...binding, runId: manifest.runId })
    assert.throws(() => verifyW30Evidence(directory, { ...binding, sourceCommit: 'b'.repeat(40) }))
    assert.throws(() => verifyW30Evidence(directory, { ...binding, applicationName: 'apollo-video-e2e-other' }))
    writeFileSync(join(directory, 'w30-mobile-filtered.png'), Buffer.alloc(160, 8))
    assert.throws(() => verifyW30Evidence(directory, binding))
    writeFileSync(join(directory, 'w30-mobile-filtered.png'), Buffer.alloc(160, 9))
    manifest.transitions[6].sameDocument = false
    save()
    assert.throws(() => verifyW30Evidence(directory, binding))
    manifest.transitions[6].sameDocument = true
    manifest.browser.mutatingRequests = 1
    save()
    assert.throws(() => verifyW30Evidence(directory, binding))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
