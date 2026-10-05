import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const proofSource = resolve(dirname(fileURLToPath(import.meta.url)), 'dashboard-w40-consolidated.mjs')

const SIBLING_SCHEMAS = Object.freeze({
  29: 'w29-lut-browser-proof/v1', 30: 'w30-dashboard-browser-proof/v1', 31: 'w31-dashboard-combined-filters/v1',
  32: 'w32-dashboard-pagination/v1', 33: 'w33-dashboard-workspace-isolation/v1', 34: 'w34-dashboard-aggregate/v1',
  35: 'w35-dashboard-states/v1', 36: 'w36-dashboard-events/v1', 37: 'w37-rename-from-card/v1',
  38: 'w38-archive-restore/v1', 39: 'w39-duplicate-copy-on-write/v1',
})
const PHASES = [
  'filters-and-aggregate', 'open-review-and-return', 'change-by-another-client', 'rename', 'archive-and-restore',
  'duplicate', 'transport-controlled', 'security-401-403-404', 'reconcile-and-mobile',
]
const SCREENSHOTS = [
  'w40-desktop-baseline.png', 'w40-desktop-editor-open.png', 'w40-desktop-editor-review.png', 'w40-desktop-feed-update.png',
  'w40-desktop-rename-pending.png', 'w40-desktop-rename-conflict.png', 'w40-desktop-archive-dialog.png', 'w40-desktop-archived.png',
  'w40-desktop-duplicate-destination.png', 'w40-desktop-duplicate-dashboard.png', 'w40-mobile-error-transport.png',
  'w40-desktop-error-401-login.png', 'w40-desktop-error-404.png', 'w40-mobile-actions.png', 'w40-mobile-archive-dialog.png',
]
// Every refusal the journey must have produced, with the exact status/code of its route.
const REFUSALS = Object.freeze({
  'revoked-session-in-use-401': [401, 'AUTH_INVALID'], 'expired-session-401': [401, 'AUTH_INVALID'], 'anonymous-401': [401, 'AUTH_INVALID'],
  'scope-rename-403': [403, 'AUTH_SCOPE_REQUIRED'], 'scope-archive-403': [403, 'AUTH_SCOPE_REQUIRED'], 'scope-duplicate-403': [403, 'AUTH_SCOPE_REQUIRED'],
  'foreign-credential-rename-404': [404, 'PROJECT_NOT_FOUND'], 'foreign-credential-archive-404': [404, 'PROJECT_NOT_FOUND'],
  'foreign-credential-duplicate-404': [404, 'PROJECT_NOT_FOUND'], 'foreign-human-session-rename-404': [404, 'PROJECT_NOT_FOUND'],
  'nonexistent-project-404': [404, 'PROJECT_NOT_FOUND'], 'workspace-switched-in-another-tab-404': [404, 'PROJECT_NOT_FOUND'],
  'stale-rename-409': [409, 'VERSION_CONFLICT'], 'stale-archive-409': [409, 'VERSION_CONFLICT'], 'stale-duplicate-409': [409, 'VERSION_CONFLICT'],
  'stale-rename-api-409': [409, 'VERSION_CONFLICT'], 'stale-archive-api-409': [409, 'VERSION_CONFLICT'],
})
const CONTROLLED = ['transport-failure-before-send', 'transport-response-lost-after-commit']

function readManifest(directory, wave, schemaVersion, { sourceCommit, ciRunId }) {
  const text = readFileSync(join(directory, `w${wave}-manifest.json`), 'utf8')
  assert.equal(/Bearer\s|apollo_v2\.|apollo_session|set-cookie/.test(text), false, `w${wave}: the manifest must not carry a cookie, token or Bearer value`)
  const manifest = JSON.parse(text)
  assert.equal(manifest.schemaVersion, schemaVersion)
  assert.equal(manifest.outcome, 'passed', `w${wave} outcome`)
  assert.equal(manifest.sourceCommit, sourceCommit, `w${wave} must come from the same commit`)
  assert.equal(manifest.ciRunId, ciRunId, `w${wave} must come from the same CI run`)
  return manifest
}

const generic = (path) => path.replace(/\/projects\/[^/]+/, '/projects/{id}')

/** The guards of W29-W39 each validated their own manifest; here only that they exist, passed and share this commit and run. */
export function verifyJourneyManifests(directories, context) {
  for (const [wave, schemaVersion] of Object.entries(SIBLING_SCHEMAS)) {
    assert.ok(directories[wave], `the evidence directory of W${wave} must be provided`)
    const manifest = readManifest(directories[wave], wave, schemaVersion, context)
    assert.deepEqual(manifest.postflight?.cleanupErrors, [], `w${wave} cleanup errors`)
  }
}

export function verifyW40Evidence(directory, context, { siblings, source = readFileSync(proofSource, 'utf8') } = {}) {
  assert.match(context.sourceCommit, /^[a-f0-9]{40}$/)
  assert.match(context.ciRunId, /^\d+$/)
  assert.match(context.applicationName, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
  for (const forbidden of [/dispatchEvent/, /apollo:project-updated/, /new (?:CustomEvent|Event)\(/]) {
    assert.doesNotMatch(source, forbidden, `proof code must not use ${forbidden}`)
  }
  const manifest = readManifest(directory, 40, 'w40-consolidated/v1', context)
  assert.equal(manifest.wave, 'w40')
  assert.equal(manifest.database?.applicationName, context.applicationName)
  assert.match(manifest.runId, /^[a-f0-9-]{36}$/)
  assert.match(manifest.prefix, /^w40-[a-f0-9]{8}$/)
  assert.equal(manifest.browser?.pid > 0, true)
  assert.equal(manifest.postflight?.browserProcessTerminal, true)
  assert.deepEqual(manifest.postflight?.cleanupErrors, [])
  assert.match(manifest.postflight.storageCleanup, /^(artifact-root-removed|fixture-directory-removed)$/)
  if (siblings) verifyJourneyManifests(siblings, context)

  // session age: measured, and rotation only ever through the product's rotation threshold
  const { session } = manifest
  assert.equal(session.rotateAfterMs, 600_000)
  assert.equal(session.identifierMaxAgeMs, 900_000)
  assert.ok(Number.isFinite(session.ageAtStartMs) && session.ageAtStartMs >= 0 && session.ageAtStartMs < session.identifierMaxAgeMs)
  if (session.rotationAtStart) assert.ok(session.ageAtStartMs >= session.rotateAfterMs, 'a rotation at the start needs a session past the threshold')
  for (const rotation of session.rotations) assert.ok(rotation.ageMs >= session.rotateAfterMs, 'a rotation before the product threshold would be a forged extension')
  assert.equal(session.rotationsDuringJourney, session.rotations.length)
  if (!session.rotationAtStart && session.rotations.length === 0) assert.ok(session.elapsedAtEndMs < session.identifierMaxAgeMs, 'without rotation the journey must end inside the identifier lifetime')

  for (const phase of PHASES) assert.ok(manifest.timing?.[phase] >= 0, `missing timing of ${phase}`)

  // fixtures and provenance
  for (const key of ['open', 'review', 'rename', 'archive', 'dup', 'copy']) assert.ok(manifest.fixtures?.[key]?.projectId, `missing fixture ${key}`)
  assert.equal(new Set(['open', 'review', 'rename', 'archive', 'dup', 'copy'].map((key) => manifest.fixtures[key].projectId)).size, 6)
  assert.match(manifest.fixtures.dup.masterSha256, /^[a-f0-9]{64}$/)
  assert.ok(manifest.fixtures.dup.masterBytes > 1000)
  assert.ok(manifest.fixtures.review.origin.includes('controlled-pg-seed'), 'the seeded review state must be declared')
  assert.ok(manifest.fixtures.archive.origin.includes('controlled-pg-seed'), 'the seeded completed status must be declared')

  // filters and aggregate
  const filters = Object.fromEntries(manifest.filters.map((item) => [item.id, item]))
  for (const id of ['status-draft', 'status-reviewing-proxy', 'status-completed', 'status-failed-empty', 'status-archived-empty', 'text-only-again']) assert.ok(filters[id], `missing filter case ${id}`)
  for (const item of manifest.filters) {
    assert.equal(item.request.limit, '24')
    assert.equal(item.request.text, manifest.prefix)
    assert.deepEqual(item.domIds, item.responseIds, `${item.id}: cards equal the response`)
    assert.equal(item.facets.text, manifest.prefix)
  }
  assert.equal(filters['status-draft'].responseIds.length, 3)
  assert.equal(filters['status-reviewing-proxy'].responseIds.length, 1)
  assert.equal(filters['status-completed'].responseIds.length, 1)
  assert.deepEqual(filters['status-failed-empty'].responseIds, [])
  assert.deepEqual(filters['status-archived-empty'].responseIds, [])
  assert.equal(filters['text-only-again'].responseIds.length, 5)
  assert.deepEqual(manifest.aggregate.tiles, manifest.aggregate.expected)
  assert.deepEqual(manifest.aggregate.tiles, { 'Em configuração': 3, 'Em produção': 0, 'Aguardando revisão': 1, Concluídos: 1 })
  assert.equal(manifest.aggregate.ids.length, 5)

  // open / review / return: the review destination is the corrected one
  const nav = Object.fromEntries(manifest.navigation.map((item) => [item.id, item]))
  assert.deepEqual(Object.keys(nav).toSorted(), ['open-primary-draft', 'open-secondary-draft', 'review-primary', 'review-secondary'])
  for (const [id, search] of [['open-primary-draft', ''], ['open-secondary-draft', ''], ['review-primary', '?mode=review'], ['review-secondary', '?mode=review']]) {
    assert.equal(nav[id].destination.pathname, `/projects/${nav[id].projectId}`)
    assert.equal(nav[id].destination.search, search, `${id}: destination query`)
    assert.equal(nav[id].workspaceStatus, 200)
    assert.deepEqual(nav[id].returned.controls.text, manifest.prefix)
    assert.equal(nav[id].returned.search, `status=${nav[id].returned.controls.status}&text=${manifest.prefix}`, `${id}: the canonical URL query after coming back`)
  }
  assert.equal(nav['review-primary'].projectId, manifest.fixtures.review.projectId)
  assert.equal(nav['open-primary-draft'].projectId, manifest.fixtures.open.projectId)
  assert.equal(nav['open-primary-draft'].returned.controls.status, 'draft')
  assert.equal(nav['review-primary'].returned.controls.status, 'reviewing-proxy')
  assert.deepEqual(manifest.readOnlyPhases.map((item) => item.phase), ['filters-and-aggregate', 'open-review-and-return'])
  for (const item of manifest.readOnlyPhases) {
    assert.equal(item.mutatingRequests, 0)
    assert.equal(item.counters, 'stable')
    assert.ok(Object.keys(item.requests).every((key) => key.startsWith('GET ')), `${item.phase}: only GET requests`)
  }

  // another client through the W36 feed
  const { feed } = manifest
  assert.equal(feed.actor.authentication, 'bearer')
  assert.equal(feed.command.action, 'rename')
  assert.equal(feed.command.baseRevision, 1)
  assert.equal(feed.command.resultRevision, 2)
  assert.equal(feed.command.actorAuthenticationKind, 'bearer')
  assert.equal(feed.command.actorClientId, feed.actor.clientId)
  assert.equal(feed.event.type, 'project.name.changed')
  assert.equal(feed.feedResponse.status, 200)
  assert.equal(feed.feedResponse.containsEventId, true)
  assert.equal(feed.documentReloaded, false)
  assert.equal(feed.browserMutatingRequests, 0)
  assert.equal(feed.refetch.revision, 2)
  assert.equal(feed.card.revision, 2)
  assert.equal(feed.card.name, feed.refetch.name)
  assert.ok(feed.requestCountsSinceChange['GET /v1/events/feed'] >= 1)
  assert.ok(feed.requestCountsSinceChange['GET /v1/projects'] >= 1)
  assert.ok(Object.keys(feed.requestCountsSinceChange).every((key) => key.startsWith('GET ')))
  assert.ok(feed.timeline.mutationToDomMs >= feed.timeline.mutationToFeedMs, 'the DOM changed after the feed delivered the event')

  // administrative actions, bound to PostgreSQL
  const { rename, archive, duplicate } = manifest.actions
  assert.equal(rename.command.action, 'rename')
  assert.equal(rename.command.actorAuthenticationKind, 'ui-session')
  assert.equal(rename.command.hasDelegatedUser, true)
  assert.equal(rename.command.idempotencyKeySha256, rename.request.idempotencyKeySha256)
  assert.notEqual(rename.pendingCardName, rename.confirmedCardName)
  assert.equal(rename.replayStatus, 200)
  assert.deepEqual(rename.projectChangedKeys, ['administrationRevision', 'name', 'updatedAt'])
  assert.equal(archive.cancelledMutatingRequests, 0)
  assert.equal(archive.previousStatus, 'completed')
  assert.equal(archive.archive.command.action, 'archive')
  assert.equal(archive.archive.command.beforeStatus, 'completed')
  assert.equal(archive.archive.command.afterStatus, 'archived')
  assert.equal(archive.archive.command.afterArchivedFromStatus, 'completed')
  assert.equal(archive.archive.command.confirmation, 'explicit')
  assert.equal(archive.archive.cardState, 'archived')
  assert.equal(archive.restore.command.action, 'restore')
  assert.equal(archive.restore.command.beforeArchivedFromStatus, 'completed')
  assert.equal(archive.restore.command.afterStatus, 'completed')
  assert.equal(archive.restore.command.afterArchivedFromStatus, null)
  assert.equal(archive.restore.command.resultRevision, archive.archive.command.resultRevision + 1)
  assert.equal(archive.restore.cardState, 'completed')
  assert.equal(archive.archive.counterConcluidos, 0)
  assert.equal(archive.restore.counterConcluidos, 1)
  assert.equal(archive.versionsIdentical, true)
  assert.equal(archive.snapshotsIdentical, true)
  assert.equal(archive.finalProject.status, 'completed')
  assert.equal(archive.finalProject.archivedFromStatus, null)
  assert.equal(duplicate.responseStatus, 201)
  assert.equal(duplicate.replayAfterCommandStatus, 200)
  assert.match(duplicate.request.path, /^\/v1\/projects\/[^/]+\/duplicates$/)
  assert.deepEqual(Object.keys(duplicate.request.body).toSorted(), ['expectedVersionHash', 'expectedVersionId', 'name'])
  assert.equal(duplicate.request.body.expectedVersionHash, manifest.fixtures.dup.versionBaseHash)
  assert.equal(duplicate.request.body.expectedVersionId, manifest.fixtures.dup.versionId)
  assert.equal(duplicate.copy.projectId, manifest.fixtures.copy.projectId)
  assert.notEqual(duplicate.copy.projectId, manifest.fixtures.dup.projectId)
  assert.equal(duplicate.lineage.duplicatedFromProjectId, manifest.fixtures.dup.projectId)
  assert.equal(duplicate.lineage.forkedFromProjectId, manifest.fixtures.dup.projectId)
  assert.equal(duplicate.lineage.forkedFromVersionId, manifest.fixtures.dup.versionId)
  assert.equal(duplicate.lineage.parentVersionId, null)
  assert.equal(duplicate.versionHash.differs, true)
  assert.equal(duplicate.versionHash.followsContractFormula, true)
  assert.notEqual(duplicate.versionHash.copy, duplicate.versionHash.source)
  assert.ok(duplicate.snapshots.length >= 3)
  for (const pair of duplicate.snapshots) {
    assert.equal(pair.rebound, pair.kind === 'edit-plan', 'only the EditPlan is version-bound')
    if (pair.rebound) assert.notEqual(pair.copyContentHash, pair.contentHash)
    else assert.equal(pair.copyContentHash, pair.contentHash)
  }
  assert.equal(duplicate.creationCommand.action, 'duplicate')
  assert.equal(duplicate.creationCommand.actorAuthenticationKind, 'ui-session')
  assert.deepEqual(duplicate.sharedArtifactIds, [manifest.fixtures.dup.artifactId])
  assert.equal(duplicate.copiedBytes, 0)
  assert.equal(duplicate.objectCounts.projectReferences, 2)
  assert.equal(duplicate.objectCounts.storageObjects, 1)
  assert.deepEqual(duplicate.storage, [{ key: duplicate.storage[0].key, bytes: manifest.fixtures.dup.masterBytes, sha256: manifest.fixtures.dup.masterSha256 }])
  assert.equal(duplicate.master.sha256, manifest.fixtures.dup.masterSha256)
  assert.equal(duplicate.master.unchanged, true)
  assert.equal(duplicate.destination.urlPath, `/projects/${duplicate.copy.projectId}`)
  assert.equal(duplicate.destination.workspaceStatus, 200)
  assert.deepEqual(duplicate.destination.mediaArtifactIds, [manifest.fixtures.dup.artifactId])
  assert.equal(duplicate.commandOnCopy.copyEditCommands, 1)
  assert.equal(duplicate.commandOnCopy.sourceEditCommands, 0)
  assert.deepEqual(duplicate.commandOnCopy.cards, { source: 'v1', copy: 'v2' })
  assert.equal(duplicate.sourceUnchanged, true)

  // cases: every refusal binds request, response, card and persisted state; 401/403/404/409 are never interchangeable
  const ids = manifest.cases.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length, 'case ids must be unique')
  const byId = Object.fromEntries(manifest.cases.map((item) => [item.id, item]))
  for (const [id, [status, code]] of Object.entries(REFUSALS)) {
    const item = byId[id]
    assert.ok(item, `missing case ${id}`)
    assert.equal(item.expected.status, status, `${id}: expected status`)
    assert.equal(item.observed.status, status, `${id}: observed status`)
    assert.equal(item.expected.code, code, `${id}: expected code`)
    assert.equal(item.observed.code, code, `${id}: observed code`)
    assert.notEqual(item.controlled, true, `${id} is a real-state refusal, not a controlled one`)
    assert.equal(item.persistedUnchanged, true, `${id} must leave the persisted state untouched`)
    assert.ok(item.card && typeof item.card === 'object', `${id} must bind the card`)
    assert.ok(item.request?.method && item.request?.path, `${id} must bind the request`)
  }
  for (const id of ['recovery-after-409', 'expired-session-page-redirect']) assert.ok(byId[id], `missing case ${id}`)
  assert.equal(byId['recovery-after-409'].observed.status, 200)
  assert.equal(byId['expired-session-page-redirect'].observed.landing, '/login')
  assert.equal(byId['revoked-session-in-use-401'].observed.landing, '/login')
  for (const id of ['stale-rename-409', 'stale-archive-409']) assert.match(byId[id].timingAid, /feed poll was held/, `${id} must disclose its timing aid`)
  assert.equal(byId['stale-rename-409'].observed.errorVisibleInDialog, true)
  assert.equal(byId['stale-rename-409'].observed.browserCommandsWritten, 0)
  assert.equal(byId['stale-archive-409'].observed.errorVisibleInDialog, true)
  assert.equal(byId['stale-archive-409'].observed.persistedStatus, 'completed')
  assert.equal(byId['workspace-switched-in-another-tab-404'].observed.errorVisibleInDialog, true)
  assert.deepEqual(byId['session-rotation-real-path']?.observed, { rotated: true, successorStatus: 200, previousTokenStatus: 401, previousTokenCode: 'AUTH_INVALID', previousRowRevoked: true }, 'the product rotation path must have been exercised')
  const controlled = manifest.cases.filter((item) => item.controlled === true).map((item) => item.id).toSorted()
  assert.deepEqual(controlled, [...CONTROLLED].toSorted(), 'only the two transport interferences may be controlled, and they are labelled')
  const lost = byId['transport-response-lost-after-commit']
  const before = byId['transport-failure-before-send']
  assert.equal(before.observed.errorShown, true)
  assert.equal(before.observed.commandsWrittenByFailedAttempt, 0)
  assert.equal(before.observed.retryReusesKey, true)
  assert.equal(before.observed.cardNameAfterFailure !== before.observed.cardNameAfterRetry, true, 'the card did not move before the retry succeeded')
  assert.equal(lost.observed.errorShown, true)
  assert.equal(lost.observed.cardName, lost.observed.persistedName, 'the card equals the persisted state after the lost response')
  assert.equal(lost.observed.replayed, true)
  assert.equal(lost.observed.commands, 5)

  // the human browser's own mutating requests, exactly
  const { requests } = manifest.browser
  assert.equal(manifest.browser.mutatingRequests, 10)
  assert.equal(requests.length, 10)
  assert.deepEqual(requests.map((item) => `${item.method} ${generic(item.path)}`), [
    'POST /v1/projects/{id}/rename', 'POST /v1/projects/{id}/rename', 'POST /v1/projects/{id}/rename',
    'POST /v1/projects/{id}/archive', 'POST /v1/projects/{id}/archive', 'POST /v1/projects/{id}/restore',
    'POST /v1/projects/{id}/duplicates',
    'POST /v1/projects/{id}/rename', 'POST /v1/projects/{id}/rename', 'POST /v1/projects/{id}/rename',
  ])
  const keys = requests.map((item) => item.idempotencyKeySha256)
  assert.ok(keys.every((key) => /^[a-f0-9]{64}$/.test(key)))
  assert.equal(keys[7], keys[8], 'the retry of the failed attempt reuses its idempotency key')
  assert.equal(new Set(keys).size, keys.length - 1, 'every other attempt uses its own key')
  assert.equal(manifest.browser.mobileOverflowPx <= 1, true)
  assert.ok(manifest.browser.feedPolls >= 1)

  // reconciliation
  assert.equal(manifest.final.outsidePrefixUnchanged, true)
  const finalCommands = (key) => manifest.final.projects[key].commands.map((item) => [item.action, item.baseRevision, item.resultRevision])
  assert.deepEqual(finalCommands('open'), [['rename', 1, 2]])
  assert.deepEqual(finalCommands('review'), [])
  assert.deepEqual(finalCommands('rename'), [['rename', 1, 2], ['rename', 2, 3], ['rename', 3, 4], ['rename', 4, 5], ['rename', 5, 6]])
  assert.deepEqual(finalCommands('archive'), [['rename', 1, 2], ['archive', 2, 3], ['restore', 3, 4]])
  assert.deepEqual(finalCommands('dup'), [])
  assert.deepEqual(finalCommands('copy'), [])
  assert.equal(manifest.final.projects.review.project.status, 'reviewing-proxy')
  assert.equal(manifest.final.projects.archive.project.status, 'completed')
  assert.equal(manifest.final.projects.copy.versions, 2)
  assert.equal(manifest.final.projects.copy.editCommands, 1)

  assert.deepEqual(manifest.screenshots?.map((item) => item.name), SCREENSHOTS)
  for (const shot of manifest.screenshots) {
    assert.match(shot.sha256, /^[a-f0-9]{64}$/)
    const bytes = readFileSync(join(directory, shot.name))
    assert.ok(bytes.length > 100)
    assert.equal(bytes.length, shot.bytes)
    assert.equal(hash(bytes), shot.sha256)
  }
  return { runId: manifest.runId }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    assert.ok(process.argv[2], 'usage: dashboard-w40-evidence-guard.mjs <w40-evidence-dir>')
    const siblings = Object.fromEntries(Object.keys(SIBLING_SCHEMAS).map((wave) => [wave, process.env[`APOLLO_W${wave}_EVIDENCE_DIR`]]))
    verifyW40Evidence(process.argv[2], {
      sourceCommit: process.env.GITHUB_SHA,
      ciRunId: process.env.GITHUB_RUN_ID,
      applicationName: process.env.APOLLO_PUBLIC_API_APP_NAME,
    }, { siblings })
  } catch (error) {
    process.stderr.write(`W40 evidence rejected: ${error?.name ?? 'Error'} ${String(error?.message ?? '').slice(0, 300)}\n`)
    process.exitCode = 1
  }
}
