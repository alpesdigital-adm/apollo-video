import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const FIXTURES = ['w34-bare', 'w34-versioned', 'w34-complete', 'w34-failed-op', 'w34-unmeasured', 'w34-archived']
const SCREENSHOTS = ['w34-desktop-aggregate.png', 'w34-mobile-aggregate.png']
const ORIGINS = new Set(['real-api', 'controlled-pg-seed', 'absent'])
const RELATIONS = ['project', 'currentVersion', 'latestOperation', 'openReviewIssues', 'outputs', 'administration']

export function verifyW34Evidence(directory, { sourceCommit, ciRunId, applicationName }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/)
  assert.match(ciRunId, /^\d+$/)
  assert.match(applicationName, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
  const manifest = JSON.parse(readFileSync(join(directory, 'w34-manifest.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 'w34-dashboard-aggregate/v1')
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
  assert.equal(manifest.browser?.desktopOverflowPx <= 1, true)
  assert.deepEqual(manifest.filter, { text: 'w34-' })
  for (const viewport of ['desktop', 'mobile']) {
    assert.equal(manifest.requests?.[viewport]?.mutating, 0)
    assert.ok(manifest.requests?.[viewport]?.projectGets >= 1)
  }
  assert.deepEqual(manifest.counts?.after, manifest.counts?.before)
  for (const key of ['projects', 'versions', 'editCommands', 'creationCommands', 'administrationCommands', 'publicOperations', 'reviewAnnotations', 'finalExportOperations']) {
    assert.equal(Number.isInteger(manifest.counts.before[key]), true)
  }
  assert.deepEqual(manifest.fixtures?.map((item) => item.name).sort(), [...FIXTURES].sort())
  assert.deepEqual(manifest.tiles?.map((tile) => tile.value), [1, 2, 0, 1])
  assert.deepEqual(manifest.tiles.map((tile) => tile.label), ['Em configuração', 'Em produção', 'Aguardando revisão', 'Concluídos'])
  assert.deepEqual(manifest.expectedOrder?.slice().sort(), manifest.fixtures.map((item) => item.projectId).sort())
  const byName = Object.fromEntries(manifest.fixtures.map((item) => [item.name, item]))
  for (const fixture of manifest.fixtures) {
    assert.deepEqual(fixture.api, fixture.persisted, `${fixture.name}: API projection must equal the PostgreSQL rows`)
    assert.equal(fixture.persisted.schemaVersion, 'project-dashboard-summary/v2')
    for (const relation of RELATIONS) {
      assert.ok(ORIGINS.has(fixture.origins?.[relation]?.origin), `${fixture.name}.${relation}: origin must be labelled`)
    }
    for (const viewport of ['desktop', 'mobile']) {
      const card = fixture.card?.[viewport]
      assert.equal(card?.id, fixture.projectId)
      assert.equal(card.name, fixture.name)
      assert.equal(card.state, fixture.expectedCard.state)
      assert.equal(card.badgeText, fixture.expectedCard.badgeText)
      assert.deepEqual(card.facts, fixture.expectedCard.facts)
      assert.equal(card.phase, fixture.expectedCard.phase)
      assert.equal(card.measure, fixture.expectedCard.measure)
      assert.equal(card.error, fixture.expectedCard.error)
    }
    assert.equal(fixture.expectedCard.facts['Pendências'], String(fixture.persisted.openReviewIssueCount))
    assert.equal(fixture.expectedCard.facts.Outputs, String(fixture.persisted.outputCount))
    assert.equal(fixture.expectedCard.facts['Versão'], fixture.persisted.currentVersion ? `v${fixture.persisted.currentVersion.sequence}` : '—')
  }
  const kinds = new Set(manifest.fixtures.flatMap((item) => RELATIONS.map((relation) => item.origins[relation].origin)))
  assert.ok(kinds.has('real-api') && kinds.has('controlled-pg-seed') && kinds.has('absent'), 'real, seeded and absent relations must all be present')

  const bare = byName['w34-bare'].persisted
  assert.equal(bare.currentVersion.sequence, 1)
  assert.equal(bare.latestOperation, null)
  assert.equal(bare.openReviewIssueCount, 0)
  assert.deepEqual(bare.outputs, [])
  assert.equal(bare.outputCount, 0)
  assert.equal(bare.administrationRevision, 1)
  assert.equal(bare.archivedFromStatus, null)
  assert.equal(byName['w34-bare'].expectedCard.phase, 'Nenhuma operação iniciada')

  const versioned = byName['w34-versioned'].persisted
  assert.equal(versioned.currentVersion.sequence, 2)
  assert.equal(versioned.latestOperation.id, 'w34-versioned-op-new')
  assert.equal(versioned.latestOperation.status, 'running')
  assert.deepEqual(versioned.latestOperation.progress, { completed: 1, total: 4, unit: 'render' })
  assert.equal(versioned.openReviewIssueCount, 2)
  assert.deepEqual(versioned.outputs, [])

  const complete = byName['w34-complete'].persisted
  assert.equal(complete.currentVersion.sequence, 2)
  assert.equal(complete.latestOperation.status, 'succeeded')
  assert.equal(complete.openReviewIssueCount, 0)
  assert.equal(complete.outputCount, 2)
  assert.deepEqual(complete.outputs.map((output) => output.aspectRatio), ['16:9', '9:16'])
  assert.equal(new Set(complete.outputs.map((output) => output.artifactId)).size, 2)

  const failed = byName['w34-failed-op'].persisted
  assert.equal(failed.latestOperation.status, 'failed')
  assert.deepEqual(failed.latestOperation.error, { code: 'render-failed', retryable: true })
  assert.equal(byName['w34-failed-op'].expectedCard.error, 'render-failed · recuperável')

  const unmeasured = byName['w34-unmeasured']
  assert.deepEqual(unmeasured.persisted.latestOperation.progress, { completed: 1 })
  assert.equal(unmeasured.expectedCard.measure, 'sem total medido')
  assert.equal(unmeasured.card.desktop.bar, null)
  assert.equal(unmeasured.card.mobile.bar, null)
  assert.deepEqual(unmeasured.card.desktop.percentTexts, [])
  assert.equal(unmeasured.origins.latestOperation.origin, 'controlled-pg-seed')

  const archived = byName['w34-archived'].persisted
  assert.equal(archived.administrationRevision, 2)
  assert.equal(archived.archivedFromStatus, 'draft')
  assert.equal(byName['w34-archived'].origins.administration.origin, 'real-api')

  assert.deepEqual(manifest.screenshots?.map((item) => item.name), SCREENSHOTS)
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
    verifyW34Evidence(process.argv[2], {
      sourceCommit: process.env.GITHUB_SHA,
      ciRunId: process.env.GITHUB_RUN_ID,
      applicationName: process.env.APOLLO_PUBLIC_API_APP_NAME,
    })
  } catch (error) {
    process.stderr.write(`W34 evidence rejected: ${error?.name ?? 'Error'}\n`)
    process.exitCode = 1
  }
}
