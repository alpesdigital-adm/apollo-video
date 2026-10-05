import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const screenshotNames = ['w36-desktop-updated.png', 'w36-mobile-updated.png']
const proofSource = resolve(dirname(fileURLToPath(import.meta.url)), 'dashboard-w36-events-proof.mjs')

/**
 * Rejects evidence in which the card update could have come from anything but
 * the chain  external mutation -> persisted outbox row -> feed response carrying
 * that very event id -> dashboard GET -> DOM, and rejects proof code that could
 * fake the chain with a reload or a synthetic DOM event.
 */
export function verifyW36Evidence(directory, { sourceCommit, ciRunId, applicationName }, { source = readFileSync(proofSource, 'utf8') } = {}) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/)
  assert.match(ciRunId, /^\d+$/)
  assert.match(applicationName, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
  for (const forbidden of [/dispatchEvent/, /apollo:project-updated/, /\.reload\(/, /new (?:CustomEvent|Event)\(/]) {
    assert.doesNotMatch(source, forbidden, `proof code must not use ${forbidden}`)
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'w36-manifest.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 'w36-dashboard-events/v1')
  assert.equal(manifest.outcome, 'passed')
  assert.equal(manifest.sourceCommit, sourceCommit)
  assert.equal(manifest.ciRunId, ciRunId)
  assert.equal(manifest.database?.applicationName, applicationName)
  assert.match(manifest.runId, /^[a-f0-9-]{36}$/)
  assert.equal(manifest.browser?.pid > 0, true)
  assert.equal(manifest.browser?.sessionVerifiedBeforeDashboard, true)
  assert.equal(manifest.browser?.mobileOverflowPx <= 1, true)
  assert.equal(manifest.postflight?.browserProcessTerminal, true)
  assert.deepEqual(manifest.postflight?.cleanupErrors, [])
  assert.deepEqual(manifest.contract, {
    path: '/v1/events/feed', method: 'GET', capabilityId: 'apollo.events.feed.list',
    policy: manifest.contract.policy,
  })
  const policy = manifest.contract.policy
  assert.equal(policy.intervalMs >= 1000, true, 'poll interval must be sane')
  assert.equal(policy.maxConsecutiveFailures >= 1 && policy.maxConsecutiveFailures <= 10, true)
  assert.equal(policy.maxBackoffMs >= policy.intervalMs, true)
  assert.ok(manifest.scope?.notDemonstrated?.some((item) => /operation/.test(item)), 'the manifest must record that operations/progress are not demonstrated')

  const { cases } = manifest
  assert.deepEqual(Object.keys(cases).toSorted(), [
    'bootstrap', 'boundedRetries', 'delayedResponse', 'externalArchive', 'externalRename',
    'idlePolling', 'noReloadNoSyntheticEvent', 'otherWorkspace', 'unmount',
  ])

  assert.equal(cases.bootstrap.firstRequestQuery.startAt, 'latest')
  assert.equal('after' in cases.bootstrap.firstRequestQuery, false)
  assert.equal(cases.bootstrap.bootstrapEvents, 0)
  assert.equal(cases.bootstrap.dashboardProjectGets, 1)
  assert.ok(cases.bootstrap.historyEventsInPostgres >= 3)

  const idle = cases.idlePolling
  assert.ok(idle.n >= 4 && idle.intervalsMs.length === idle.n)
  assert.ok(idle.minMs >= policy.intervalMs - 150 && idle.maxMs <= policy.intervalMs + 2500)
  assert.equal(idle.projectGetsDuringIdle, 0)

  for (const key of ['externalRename', 'externalArchive']) {
    const item = cases[key]
    assert.ok(item.resultRevision === item.baseRevision + 1, `${key} must advance the revision by one`)
    assert.equal(item.postgres.outbox.id, item.feedEvent.id,
      `${key}: the feed event must be the persisted outbox row`)
  }
  const rename = cases.externalRename
  assert.equal(rename.postgres.command.action, 'rename')
  assert.equal(rename.postgres.command.eventId, rename.postgres.outbox.id)
  assert.equal(rename.postgres.outbox.type, 'project.name.changed')
  assert.equal(rename.feedEvent.type, 'project.name.changed')
  assert.equal(rename.feedEvent.sequence, rename.resultRevision)
  assert.equal(rename.feedEvent.resourceId, rename.projectId)
  assert.equal(rename.refetch.row.revision, rename.resultRevision)
  assert.equal(rename.refetch.row.name, rename.nameAfter)
  assert.notEqual(rename.nameBefore, rename.nameAfter)
  const timeline = [
    rename.timeline.mutationAt, rename.timeline.feedResponseAt,
    rename.timeline.refetchResponseAt, rename.timeline.domUpdatedAt,
  ].map(Date.parse)
  assert.ok(timeline.every(Number.isFinite))
  assert.deepEqual(timeline, [...timeline].toSorted((a, b) => a - b), 'chain must be ordered: mutation, feed, refetch, DOM')
  assert.ok(Date.parse(rename.timeline.feedResponseAt) > Date.parse(rename.postgres.outbox.createdAt), 'the feed delivered the row after it was persisted')
  assert.ok(rename.timeline.mutationToDomMs > 0 && rename.timeline.mutationToDomMs <= policy.intervalMs * 3 + 5000)
  const archive = cases.externalArchive
  assert.equal(archive.postgres.outbox.type, 'project.status.changed')
  assert.equal(archive.feedEvent.type, 'project.status.changed')
  assert.equal(archive.feedEvent.sequence, archive.resultRevision)
  assert.equal(archive.feedEvent.resourceId, archive.projectId)
  assert.equal(archive.statusAfter, 'archived')
  assert.equal(archive.refetchRow.state, 'archived')
  assert.equal(archive.refetchRow.revision, archive.resultRevision)
  assert.ok(Date.parse(archive.timeline.feedResponseAt) <= Date.parse(archive.timeline.refetchResponseAt))

  const quiet = cases.noReloadNoSyntheticEvent
  assert.equal(quiet.navigationsAfterMark, 0)
  assert.equal(quiet.documentIdentityPreserved, true)
  assert.equal(quiet.syntheticDispatchEvents, 0)
  assert.equal(quiet.pageReloads, 0)
  assert.equal(quiet.explicitNavigationsAfterMark, 0)
  assert.equal(quiet.browserMutatingRequests, 0)
  assert.equal(quiet.skeletonFlashes, 0)

  const other = cases.otherWorkspace
  assert.notEqual(other.postgres.outbox.workspaceId, manifest.fixtures.workspaceId)
  assert.equal(other.postgres.outbox.workspaceId, manifest.fixtures.otherWorkspaceId)
  assert.ok(Date.parse(other.watermarkPassedRowAt) > Date.parse(other.postgres.outbox.createdAt), 'the feed watermark passed the foreign row, so it had every chance to deliver it')
  assert.ok(other.feedResponsesAfterMutation >= 2)
  assert.equal(other.eventsDelivered, 0)
  assert.equal(other.dashboardProjectRequestsAfterMutation, 0)
  assert.equal(other.projectsResponsesAfterMutation, 0)
  assert.equal(other.leakedBytes, false)
  assert.equal(other.cardsUnchanged, true)
  assert.equal(other.clientBReadFromBeginning.foreignEvents, 0)
  assert.ok(manifest.requests.feedResponses.every((entry) => entry.events.every((event) => event.resourceId !== other.mutatedProjectId)))

  const delayed = cases.delayedResponse
  assert.ok(delayed.delayedMs >= 5000)
  assert.ok(delayed.older.revision < delayed.newer.revision)
  assert.notEqual(delayed.older.name, delayed.newer.name)
  assert.equal(delayed.finalCardName, delayed.newer.name)
  assert.equal(delayed.olderStateDeliveredToPage, false)
  assert.ok(Date.parse(delayed.newer.shownAt) < Date.parse(delayed.releasedAt), 'the newer state was on screen before the delayed response was released')

  const unmount = cases.unmount
  assert.equal(unmount.feedRequestsAfterLeave, 0)
  assert.equal(unmount.clientSideNavigation, true)
  assert.ok(unmount.observedMs >= policy.intervalMs * 2)
  assert.equal(unmount.remountRestartsAtHead, true)

  const retries = cases.boundedRetries
  assert.equal(retries.attempts, policy.maxConsecutiveFailures)
  assert.equal(retries.requestsAfterLimit, 0)
  assert.ok(retries.quietAfterLimitMs >= policy.maxBackoffMs)
  assert.ok(retries.statuses.every((status) => status === 503))
  assert.ok(retries.gapsMs.every((gap, index) => index === 0 || gap > retries.gapsMs[index - 1]), 'backoff must grow')
  assert.ok(retries.gapsMs.every((gap) => gap <= policy.maxBackoffMs + 2500), 'backoff must be capped')
  assert.equal(retries.cardsStillRenderedFromProjects, true)

  assert.deepEqual(manifest.screenshots?.map((item) => item.name), screenshotNames)
  for (const shot of manifest.screenshots) {
    assert.match(shot.sha256, /^[a-f0-9]{64}$/)
    const bytes = readFileSync(join(directory, shot.name))
    assert.ok(bytes.length > 100)
    assert.equal(bytes.length, shot.bytes)
    assert.equal(hash(bytes), shot.sha256)
  }
  assert.equal(/Bearer\s+[A-Za-z0-9._~+/-]{16,}|apollo_session[A-Za-z_]*=|authorization"\s*:/i.test(JSON.stringify(manifest)), false, 'manifest must not carry credentials')
  return { sourceCommit, ciRunId, applicationName, runId: manifest.runId }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    verifyW36Evidence(process.argv[2], {
      sourceCommit: process.env.GITHUB_SHA,
      ciRunId: process.env.GITHUB_RUN_ID,
      applicationName: process.env.APOLLO_PUBLIC_API_APP_NAME,
    })
  } catch (error) {
    process.stderr.write(`W36 evidence rejected: ${error?.name ?? 'Error'}: ${String(error?.message ?? '').slice(0, 300)}\n`)
    process.exitCode = 1
  }
}
