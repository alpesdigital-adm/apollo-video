import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function readManifest(directory, wave, schemaVersion, { sourceCommit, ciRunId, applicationName }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/)
  assert.match(ciRunId, /^\d+$/)
  assert.match(applicationName, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
  const text = readFileSync(join(directory, `w${wave}-manifest.json`), 'utf8')
  assert.equal(/Bearer\s|apollo_v2\./.test(text), false, 'the manifest must not carry a Bearer token or API credential')
  const manifest = JSON.parse(text)
  assert.equal(manifest.schemaVersion, schemaVersion)
  assert.equal(manifest.wave, `w${wave}`)
  assert.equal(manifest.outcome, 'passed')
  assert.equal(manifest.sourceCommit, sourceCommit)
  assert.equal(manifest.ciRunId, ciRunId)
  assert.equal(manifest.database?.applicationName, applicationName)
  assert.match(manifest.runId, /^[a-f0-9-]{36}$/)
  assert.equal(manifest.browser?.pid > 0, true)
  assert.equal(manifest.postflight?.browserProcessTerminal, true)
  assert.deepEqual(manifest.postflight?.cleanupErrors, [])
  return manifest
}

function verifyScreenshots(directory, manifest, names) {
  assert.deepEqual(manifest.screenshots?.map((item) => item.name), names)
  for (const shot of manifest.screenshots) {
    assert.match(shot.sha256, /^[a-f0-9]{64}$/)
    const bytes = readFileSync(join(directory, shot.name))
    assert.ok(bytes.length > 100)
    assert.equal(bytes.length, shot.bytes)
    assert.equal(hash(bytes), shot.sha256)
  }
}

function verifyCases(manifest, requiredIds) {
  const ids = manifest.cases.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length, 'case ids must be unique')
  for (const id of requiredIds) assert.ok(ids.includes(id), `missing required case ${id}`)
  for (const item of manifest.cases) {
    if (item.expected?.status !== undefined && item.observed?.status !== undefined) {
      assert.equal(item.observed.status, item.expected.status, `${item.id} status`)
    }
    if (item.expected?.code !== undefined) assert.equal(item.observed?.code, item.expected.code, `${item.id} code`)
  }
}

export function verifyW37Evidence(directory, context) {
  const manifest = readManifest(directory, 37, 'w37-rename-from-card/v1', context)
  assert.match(manifest.prefix, /^w37-[a-f0-9]{8}$/)
  assert.equal(manifest.browser.mutatingRequests, 3)
  assert.deepEqual(manifest.browser.requests.map((item) => item.method), ['POST', 'POST', 'POST'])
  assert.ok(manifest.browser.requests.every((item) => item.path === `/v1/projects/${manifest.fixture.projectId}/rename`))
  assert.deepEqual(manifest.browser.requests.map((item) => item.body.baseRevision), [1, 2, 3])
  assert.equal(new Set(manifest.browser.requests.map((item) => item.idempotencyKeySha256)).size, 3, 'every browser attempt uses its own idempotency key')
  assert.equal(manifest.browser.mobileOverflowPx <= 1, true)
  assert.equal(manifest.fixture.project.administrationRevision, 1)
  assert.equal(manifest.fixture.project.status, 'draft')
  assert.ok(manifest.fixture.snapshots.length >= 3)
  assert.equal(manifest.rename.responseStatus, 200)
  assert.equal(manifest.rename.refetchObserved, true)
  assert.equal(manifest.rename.pendingCardName === manifest.rename.confirmedCardName, false)
  assert.equal(manifest.rename.command.action, 'rename')
  assert.equal(manifest.rename.command.baseRevision, 1)
  assert.equal(manifest.rename.command.resultRevision, 2)
  assert.equal(manifest.rename.command.actorAuthenticationKind, 'ui-session')
  assert.equal(manifest.rename.command.hasDelegatedUser, true)
  assert.equal(manifest.rename.command.confirmation, 'not-required')
  assert.equal(manifest.rename.command.idempotencyKeySha256, manifest.rename.request.idempotencyKeySha256)
  assert.deepEqual(manifest.rename.projectChangedKeys, ['administrationRevision', 'name'])
  assert.equal(manifest.rename.versionsUnchanged, true)
  assert.equal(manifest.rename.snapshotsUnchanged, true)
  assert.deepEqual(manifest.rename.eventTypes, ['project.name.changed'])
  verifyCases(manifest, [
    'abandoned-dialog', 'idempotent-replay', 'idempotency-payload-mismatch', 'stale-base-revision-other-client',
    'recovery-after-conflict', 'anonymous', 'invalid-bearer', 'session-without-origin', 'session-foreign-origin',
    'insufficient-scope-read-only', 'other-workspace-isolation', 'missing-idempotency-key', 'unsupported-field',
    'unchanged-name', 'unknown-project',
  ])
  const byId = Object.fromEntries(manifest.cases.map((item) => [item.id, item]))
  assert.equal(byId['stale-base-revision-other-client'].observed.errorVisibleInDialog, true)
  assert.equal(byId['stale-base-revision-other-client'].observed.extraCommands, 0)
  assert.equal(byId['idempotent-replay'].observed.commands, 1)
  for (const id of ['anonymous', 'invalid-bearer', 'session-without-origin', 'session-foreign-origin',
    'insufficient-scope-read-only', 'other-workspace-isolation', 'missing-idempotency-key', 'unsupported-field',
    'unchanged-name', 'unknown-project']) {
    assert.equal(byId[id].persistedUnchanged, true, `${id} must leave the project untouched`)
  }
  assert.deepEqual(manifest.final.commands.map((item) => [item.action, item.baseRevision, item.resultRevision]), [
    ['rename', 1, 2], ['rename', 2, 3], ['rename', 3, 4],
  ])
  verifyScreenshots(directory, manifest, [
    'w37-desktop-before.png', 'w37-desktop-pending.png', 'w37-desktop-after.png',
    'w37-mobile-after.png', 'w37-desktop-conflict-error.png',
  ])
  return { runId: manifest.runId }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const verifiers = { w37: verifyW37Evidence }
  try {
    const verify = verifiers[process.argv[2]]
    assert.ok(verify, 'usage: dashboard-w37-39-evidence-guard.mjs w37|w38|w39 <evidence-dir>')
    verify(process.argv[3], {
      sourceCommit: process.env.GITHUB_SHA,
      ciRunId: process.env.GITHUB_RUN_ID,
      applicationName: process.env.APOLLO_PUBLIC_API_APP_NAME,
    })
  } catch (error) {
    process.stderr.write(`${process.argv[2]?.toUpperCase()} evidence rejected: ${error?.name ?? 'Error'} ${String(error?.message ?? '').slice(0, 300)}\n`)
    process.exitCode = 1
  }
}
