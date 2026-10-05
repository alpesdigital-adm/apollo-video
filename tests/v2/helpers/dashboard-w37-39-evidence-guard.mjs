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
  assert.deepEqual(manifest.rename.projectChangedKeys, ['administrationRevision', 'name', 'updatedAt'])
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

export function verifyW38Evidence(directory, context) {
  const manifest = readManifest(directory, 38, 'w38-archive-restore/v1', context)
  assert.match(manifest.prefix, /^w38-[a-f0-9]{8}$/)
  assert.deepEqual(manifest.fixtures.map((item) => [item.key, item.previousStatus]), [
    ['completed', 'completed'], ['failed', 'failed'], ['canceled', 'canceled'], ['legacy', 'archived'],
  ])
  assert.equal(manifest.browser.mutatingRequests, 9)
  assert.equal(manifest.browser.requests.length, 9)
  assert.ok(manifest.browser.requests.every((item) => item.method === 'POST' && /\/(archive|restore)$/.test(item.path)))
  assert.equal(manifest.browser.requests.filter((item) => item.path.endsWith('/archive') && item.body.confirmed === true).length, manifest.browser.requests.filter((item) => item.path.endsWith('/archive')).length)
  assert.equal(new Set(manifest.browser.requests.map((item) => item.idempotencyKeySha256)).size, 9)
  assert.equal(manifest.browser.mobileOverflowPx <= 1, true)
  assert.deepEqual(manifest.cycles.map((item) => item.previousStatus), ['completed', 'failed', 'canceled'])
  for (const cycle of manifest.cycles) {
    assert.deepEqual(cycle.cancelledSteps, { mutatingRequests: 0, commands: 0, revisions: 0 })
    assert.equal(cycle.archive.command.action, 'archive')
    assert.equal(cycle.archive.command.beforeStatus, cycle.previousStatus)
    assert.equal(cycle.archive.command.afterStatus, 'archived')
    assert.equal(cycle.archive.command.afterArchivedFromStatus, cycle.previousStatus)
    assert.equal(cycle.archive.command.confirmation, 'explicit')
    assert.equal(cycle.archive.command.actorAuthenticationKind, 'ui-session')
    assert.equal(cycle.archive.cardState, 'archived')
    assert.equal(cycle.restore.command.action, 'restore')
    assert.equal(cycle.restore.command.beforeStatus, 'archived')
    assert.equal(cycle.restore.command.beforeArchivedFromStatus, cycle.previousStatus)
    assert.equal(cycle.restore.command.afterStatus, cycle.previousStatus)
    assert.equal(cycle.restore.command.afterArchivedFromStatus, null)
    assert.equal(cycle.restore.command.resultRevision, cycle.archive.command.resultRevision + 1)
    assert.equal(cycle.restore.cardState === 'archived', false)
    assert.equal(cycle.versionsIdentical, true)
    assert.equal(cycle.snapshotsIdentical, true)
    assert.equal(cycle.finalProject.status, cycle.previousStatus)
    assert.equal(cycle.finalProject.archivedFromStatus, null)
  }
  assert.equal(manifest.legacy.uiRestoreEnabled, false)
  assert.equal(manifest.legacy.uiClickSentRequests, 0)
  assert.equal(manifest.legacy.project.status, 'archived')
  assert.equal(manifest.legacy.project.archivedFromStatus, null)
  assert.equal(manifest.legacy.commands, 0)
  assert.equal(manifest.legacy.projectsBefore, manifest.legacy.projectsAfter)
  verifyCases(manifest, [
    'stale-base-revision-archive', 'recovery-second-cycle', 'legacy-restore-fails-closed', 'legacy-archive-refused',
    'idempotent-replay-archive-and-restore', 'idempotency-payload-mismatch', 'archive-insufficient-scope',
    'restore-insufficient-scope', 'archive-other-workspace', 'restore-other-workspace', 'archive-anonymous',
    'archive-session-without-origin', 'archive-unconfirmed', 'archive-confirmation-missing',
    'archive-stale-base-revision', 'restore-not-archived',
  ])
  const byId = Object.fromEntries(manifest.cases.map((item) => [item.id, item]))
  assert.equal(byId['stale-base-revision-archive'].observed.errorVisibleInDialog, true)
  assert.equal(byId['stale-base-revision-archive'].observed.statusAfter, 'completed')
  assert.deepEqual(byId['recovery-second-cycle'].observed.revisions, [2, 3, 4, 5, 6])
  assert.equal(byId['idempotent-replay-archive-and-restore'].observed.commands, 5)
  for (const item of manifest.cases) {
    if (item.request) assert.equal(item.persistedUnchanged, true, `${item.id} must leave the project untouched`)
  }
  const completed = manifest.final.projects.find((item) => item.key === 'completed')
  assert.deepEqual(completed.commands.map((item) => [item.action, item.baseRevision, item.resultRevision]), [
    ['archive', 1, 2], ['restore', 2, 3], ['rename', 3, 4], ['archive', 4, 5], ['restore', 5, 6],
  ])
  const legacy = manifest.final.projects.find((item) => item.key === 'legacy')
  assert.equal(legacy.project.status, 'archived')
  assert.equal(legacy.commands.length, 0)
  verifyScreenshots(directory, manifest, [
    'w38-desktop-before.png', 'w38-desktop-archive-dialog.png', 'w38-desktop-after-cancel.png', 'w38-desktop-archived.png',
    'w38-desktop-archived-filter.png', 'w38-desktop-restored.png', 'w38-desktop-conflict-error.png', 'w38-mobile-restored.png',
  ])
  return { runId: manifest.runId }
}

export function verifyW39Evidence(directory, context) {
  const manifest = readManifest(directory, 39, 'w39-duplicate-copy-on-write/v1', context)
  assert.match(manifest.prefix, /^w39-[a-f0-9]{8}$/)
  assert.equal(manifest.browser.mutatingRequests, 1)
  assert.equal(manifest.browser.requests.length, 1)
  assert.equal(manifest.browser.mobileOverflowPx <= 1, true)
  const before = manifest.before
  assert.match(before.master.sha256, /^[a-f0-9]{64}$/)
  assert.equal(before.master.servedSha256, before.master.sha256)
  assert.ok(before.master.bytes > 1000)
  assert.equal(before.objectCounts.projectReferences, 1)
  assert.equal(before.objectCounts.storageObjects, 1)
  assert.deepEqual(before.storage, [{ key: before.master.artifactKey, bytes: before.master.bytes, sha256: before.master.sha256 }])
  const dup = manifest.duplicate
  assert.equal(dup.responseStatus, 201)
  assert.equal(dup.request.method, 'POST')
  assert.match(dup.request.path, /^\/v1\/projects\/[^/]+\/duplicates$/)
  assert.deepEqual(Object.keys(dup.request.body).toSorted(), ['expectedVersionHash', 'expectedVersionId', 'name'])
  assert.equal(dup.request.body.expectedVersionHash, before.source.versionBaseHash)
  assert.equal(dup.request.body.expectedVersionId, before.source.versionId)
  assert.notEqual(dup.copy.projectId, before.source.project.id)
  assert.notEqual(dup.copy.versionId, before.source.versionId)
  assert.equal(dup.copy.project.duplicatedFromProjectId, before.source.project.id)
  assert.equal(dup.lineage.forkedFromProjectId, before.source.project.id)
  assert.equal(dup.lineage.forkedFromVersionId, before.source.versionId)
  assert.equal(dup.lineage.parentVersionId, null)
  assert.equal(dup.versionHash.differs, true)
  assert.equal(dup.versionHash.followsContractFormula, true)
  assert.notEqual(dup.versionHash.copy, dup.versionHash.source)
  assert.equal(dup.versionHash.source, before.source.versionBaseHash)
  assert.ok(dup.snapshots.length >= 3)
  for (const pair of dup.snapshots) {
    assert.notEqual(pair.copyId, pair.sourceId)
    assert.equal(pair.rebound, pair.kind === 'edit-plan', 'only the EditPlan is version-bound')
    assert.equal(pair.equalContent, !pair.rebound)
    if (pair.rebound) assert.notEqual(pair.copyContentHash, pair.contentHash)
    else assert.equal(pair.copyContentHash, pair.contentHash)
    assert.ok(before.source.snapshots.some((item) => item.id === pair.sourceId && item.contentHash === pair.contentHash))
  }
  assert.deepEqual(dup.sharedArtifactIds, [before.master.artifactId])
  assert.equal(dup.copiedBytes, 0)
  assert.equal(dup.objectCounts.projectReferences, 2)
  assert.equal(dup.objectCounts.storageObjects, before.objectCounts.storageObjects)
  assert.equal(dup.objectCounts.workspaceMediaArtifacts, before.objectCounts.workspaceMediaArtifacts)
  assert.equal(dup.objectCounts.manifests, before.objectCounts.manifests)
  assert.deepEqual(dup.storage, before.storage, 'the stored master is byte-for-byte the same single object')
  assert.equal(dup.servedSha256After, before.master.sha256)
  assert.equal(dup.artifactRowUnchanged, true)
  assert.equal(dup.sourceUnchanged, true)
  assert.equal(dup.destination.urlPath, `/projects/${dup.copy.projectId}`)
  assert.equal(dup.destination.workspaceStatus, 200)
  assert.deepEqual(dup.destination.mediaArtifactIds, [before.master.artifactId])
  assert.equal(manifest.command.type, 'set-project-lut-selection')
  assert.equal(manifest.command.copyEditCommands, 1)
  assert.equal(manifest.command.copyVersionSequenceAfter, 2)
  assert.equal(manifest.command.sourceEditCommands, 0)
  assert.equal(manifest.command.sourceVersionId, before.source.versionId)
  assert.equal(manifest.command.sourceVersionBaseHashBefore, manifest.command.sourceVersionBaseHashAfter)
  assert.equal(manifest.command.sourceSnapshotHashesUnchanged, true)
  assert.equal(manifest.command.cards.source, 'v1')
  assert.equal(manifest.command.cards.copy, `v${manifest.command.copyVersionSequenceAfter}`)
  assert.equal('knownDefects' in manifest, false, 'W39 must not carry known defects')
  verifyCases(manifest, [
    'idempotent-replay', 'idempotent-replay-after-copy-command', 'idempotency-payload-mismatch', 'stale-version-hash', 'stale-version-after-command-on-copy',
    'injected-payload', 'foreign-workspace', 'insufficient-scope-read-only', 'anonymous', 'session-without-origin',
    'foreign-workspace-cannot-read-shared-master',
  ])
  for (const item of manifest.cases) {
    if (item.request) assert.equal(item.persistedUnchanged, true, `${item.id} must change nothing`)
  }
  assert.equal(manifest.final.projects, 1)
  assert.equal(manifest.final.references, 2)
  assert.equal(manifest.final.storageObjects, 1)
  assert.equal(manifest.final.masterSha256Unchanged, true)
  assert.match(manifest.postflight.storageCleanup, /^(artifact-root-removed|fixture-directory-removed)$/)
  verifyScreenshots(directory, manifest, [
    'w39-desktop-source-before.png', 'w39-desktop-destination-copy.png', 'w39-mobile-destination-copy.png',
    'w39-desktop-source-and-copy.png', 'w39-desktop-after-command.png', 'w39-mobile-source-and-copy.png',
  ])
  return { runId: manifest.runId }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const verifiers = { w37: verifyW37Evidence, w38: verifyW38Evidence, w39: verifyW39Evidence }
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
