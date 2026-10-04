import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const requiredSteps = [
  'status-excludes', 'ui-text-status', 'reload', 'session-fallback',
  'url-precedence', 'updated-session-fallback',
  'native-popstate-back-forward', 'zero-results', 'clear', 'mobile-text',
]
const screenshotNames = ['w30-desktop-filtered.png', 'w30-mobile-filtered.png']

export function verifyW30Evidence(directory, { sourceCommit, ciRunId, applicationName }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/)
  assert.match(ciRunId, /^\d+$/)
  assert.match(applicationName, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
  const manifest = JSON.parse(readFileSync(join(directory, 'w30-manifest.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 'w30-dashboard-browser-proof/v1')
  assert.equal(manifest.outcome, 'passed')
  assert.equal(manifest.sourceCommit, sourceCommit)
  assert.equal(manifest.ciRunId, ciRunId)
  assert.equal(manifest.database?.applicationName, applicationName)
  assert.match(manifest.runId, /^[a-f0-9-]{36}$/)
  assert.equal(manifest.browser?.pid > 0, true)
  assert.equal(manifest.postflight?.browserProcessTerminal, true)
  assert.deepEqual(manifest.postflight?.cleanupErrors, [])
  assert.equal(manifest.browser?.mutatingRequests, 0)
  assert.equal(manifest.browser?.mobileOverflowPx <= 1, true)
  assert.equal(manifest.expected?.length, 2)
  assert.deepEqual(new Set(manifest.projectIds), new Set(manifest.expected.map((item) => item.id)))
  assert.ok(manifest.expected.every((item) => item.status === 'draft' && typeof item.name === 'string' && item.name.length))
  assert.equal(manifest.projectRowsBefore?.length, 2)
  assert.deepEqual(manifest.projectRowsBefore, manifest.expected)
  assert.deepEqual(manifest.projectRowsBefore, manifest.projectRowsAfter)
  assert.deepEqual(manifest.counts?.after, manifest.counts?.before)
  for (const key of ['projects', 'versions', 'editCommands', 'creationCommands', 'administrationCommands']) {
    assert.equal(Number.isInteger(manifest.counts.before[key]), true)
  }
  assert.deepEqual(manifest.transitions?.map((item) => item.step), requiredSteps)
  const history = manifest.transitions[6]
  assert.equal(history.sameDocument, true)
  assert.equal(history.popCount, 2)
  assert.deepEqual(manifest.transitions[0].cards, [])
  assert.deepEqual(manifest.transitions[7].cards, [])
  assert.equal(manifest.transitions[8].search, '')
  assert.deepEqual(manifest.transitions[1].cards.map((item) => item.id), [manifest.expected.find((item) => item.name === 'Projeto renomeado')?.id])
  assert.deepEqual(manifest.transitions[4].cards, manifest.transitions[5].cards)
  assert.ok(Array.isArray(manifest.requests) && manifest.requests.length >= 5)
  assert.ok(manifest.requests.every((request) => request.method === 'GET' && request.path === '/v1/projects'))
  assert.ok(manifest.requests.some((request) => request.filters?.text && request.filters?.status === 'draft'))
  assert.ok(Array.isArray(manifest.responses) && manifest.responses.length >= 5)
  assert.ok(manifest.responses.every((response) => response.status === 200 && response.cards.every((card) => manifest.expected.some((expected) => expected.id === card.id && expected.name === card.name))))
  assert.ok(manifest.responses.some((response) => response.filterStatus === 'completed' && response.cards.length === 0))
  assert.deepEqual(manifest.screenshots?.map((item) => item.name), screenshotNames)
  for (const shot of manifest.screenshots) {
    assert.match(shot.sha256, /^[a-f0-9]{64}$/)
    const bytes = readFileSync(join(directory, shot.name))
    assert.ok(bytes.length > 100)
    assert.equal(bytes.length, shot.bytes)
    assert.equal(hash(bytes), shot.sha256)
  }
  return { sourceCommit, ciRunId, applicationName, runId: manifest.runId }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    verifyW30Evidence(process.argv[2], {
      sourceCommit: process.env.GITHUB_SHA,
      ciRunId: process.env.GITHUB_RUN_ID,
      applicationName: process.env.APOLLO_PUBLIC_API_APP_NAME,
    })
  } catch (error) {
    process.stderr.write(`W30 evidence rejected: ${error?.name ?? 'Error'}\n`)
    process.exitCode = 1
  }
}
