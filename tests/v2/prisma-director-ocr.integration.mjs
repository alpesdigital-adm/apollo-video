import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { enqueuePerceptionProducerRunService } from '../../src/v2/application/enqueue-perception-producer-run.ts'
import { putPerceptionTimelineService } from '../../src/v2/application/perception-timelines.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { enqueueProjectDirectorRunService } from '../../src/v2/application/enqueue-project-director-run.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { PERCEPTION_KINDS } from '../../src/v2/domain/perception-timeline.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createEvidenceBoundBriefCompiler } from '../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'
import { createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { advancePublicOperationPhase, cancelPublicOperation, createQueuedPublicOperation, startPublicOperationAttempt, succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION, FFMPEG_EDITORIAL_RENDERER_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { calculateProxyReviewHash, evaluateRenderedProxy } from '../../src/v2/application/render-workflow.ts'
import { PrismaDirectorRunRepository } from '../../src/v2/infrastructure/prisma/director-run-repository.ts'
import { PrismaPerceptionProducerRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaPerceptionTimelineRepository } from '../../src/v2/infrastructure/prisma/perception-timeline-repository.ts'
import { hydratePublicOperationRecord, PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { applyManualEditService } from '../../src/v2/application/manual-edit.ts'
import { projectProxyRenderInputHash } from '../../src/v2/application/project-render-sources.ts'
import { PrismaManualEditRepository } from '../../src/v2/infrastructure/prisma/manual-edit-repository.ts'
import { queryProxySourceProject, hydrateProxySource } from '../../src/v2/infrastructure/prisma/proxy-source-authority.ts'
import { buildRenderElementMap, renderElementMapHash } from '../../src/v2/domain/review-system.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
import { PrismaAutomaticCatalogRepository } from '../../src/v2/infrastructure/prisma/automatic-catalog-repository.ts'
import { externalActorAuditData } from '../../src/v2/infrastructure/prisma/external-actor-audit.ts'
import { expectedOcrTimeline } from '../../src/v2/domain/projected-ocr-timeline.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { commitSealedChild, persistRecording, planPlayingRecordings } from './helpers/pg-output-world.mjs'
import { seedDirectorOcrWorld } from './helpers/s3c-director-ocr-world.mjs'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { createDirectedAudioTimelineHash } from '../../src/v2/domain/director-run.ts'
import { materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { renderableCompileVersionId } from '../../src/v2/application/compile-renderable-plan-version.ts'
import { renderablePlanSnapshotOf } from '../../src/v2/application/renderable-edit-plan.ts'
import { PrismaRenderablePlanSnapshotRepository } from '../../src/v2/infrastructure/prisma/renderable-plan-snapshot-repository.ts'

const exec = promisify(execFile)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Controlled repository-gate fixture. It models a leased worker at the persistence
// phase using domain transitions; no FFmpeg render is claimed by this row.
function controlledRunningProxyOperation({ id, workspaceId, projectId, clientId,
  artifactId, manifestId, now }) {
  const at = (offset) => new Date(now + offset).toISOString()
  const queued = createQueuedPublicOperation({ id, workspaceId, projectId, clientId,
    type: 'project-proxy-render', target: { type: 'media-artifact', id: artifactId, manifestId },
    createdAt: at(-4_000) })
  const started = startPublicOperationAttempt(queued, at(-3_000))
  const rendering = advancePublicOperationPhase(started, 'rendering', at(-2_500))
  const verifying = advancePublicOperationPhase(rendering, 'verifying', at(-2_000))
  const persisting = advancePublicOperationPhase(verifying, 'persisting', at(-1_500))
  return persisting
}

function assertControlledProxyRowHydrates(operationData, detailData, auditHash) {
  const hydrated = hydratePublicOperationRecord({
    ...operationData, projectProxyRender: { ...detailData,
      renderablePlanHash: null, renderablePlanId: null, renderableOrigin: null,
      renderableSourceId: null, renderableSourceHash: null,
      renderableVariantId: null, renderableFormat: null,
      reusedFromOperationId: null, reuseCommandId: null,
      reuseImpactHash: null, reuseBaseVersionId: null, ...detailData },
    artifactRender: null, mediaIngest: null, syntheticProductionRender: null,
    projectFinalExport: null, sourceCleanupPlan: null, longFormIndexWorkflow: null,
    projectDirectorRun: null, perceptionProducerOperation: null,
    temporalProducerOperation: null, faceProducerOperation: null,
    resultJson: null, errorCode: null, errorMessage: null, errorRetryable: null,
    completedAt: null, nextAttemptAt: null, deadLetteredAt: null, traceId: null,
    delegatedUserId: null, delegatedIdentityId: null, workspaceRole: null,
  })
  assert.equal(hydrated.context.kind, 'project-proxy-render')
  assert.equal(hydrated.authenticationAudit.contextHash, auditHash)
}

// The controller holds the operation row until both independent clients are
// observed waiting on PostgreSQL's lock. The short polling interval observes
// the latch; it does not choose which contender wins. Every path releases the
// transaction and disconnects the clients in the caller's finally block.
async function raceAtOperationLock({ controller, operationId, attachName,
  cancelName, attach, cancel, orderedFirst }) {
  let readyResolve, readyReject, waitingResolve, waitingReject, firstResolve, firstReject, release
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const waiting = new Promise((resolve, reject) => { waitingResolve = resolve; waitingReject = reject })
  const firstWaiting = orderedFirst && new Promise((resolve, reject) => {
    firstResolve = resolve; firstReject = reject
  })
  firstWaiting?.catch(() => {})
  const released = new Promise((resolve) => { release = resolve })
  const latch = controller.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`SELECT id FROM public_operations
      WHERE id = ${operationId} FOR UPDATE`
    assert.equal(locked.length, 1, 'the latch must lock its exact operation row')
    readyResolve()
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      await tx.$queryRaw`SELECT pg_stat_clear_snapshot() IS NULL AS cleared`
      const rows = await tx.$queryRaw`SELECT application_name AS name,
        wait_event_type AS "waitType" FROM pg_stat_activity
        WHERE application_name IN (${attachName}, ${cancelName})`
      const blocked = new Set(rows.filter((row) => row.waitType === 'Lock').map((row) => row.name))
      if (orderedFirst && blocked.has(orderedFirst === 'cancel' ? cancelName : attachName)) {
        firstResolve()
      }
      if (blocked.has(attachName) && blocked.has(cancelName)) {
        waitingResolve()
        await released
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('W65 lock latch did not observe both contenders before its deadline')
  }, { timeout: 8_000 }).catch((error) => {
    readyReject(error)
    waitingReject(error)
    firstReject?.(error)
    throw error
  })
  try { await ready } catch (error) { await latch.catch(() => {}); throw error }
  const settled = (promise) => promise.then((value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }))
  let attachResult, cancelResult
  let latchError = null
  try {
    if (orderedFirst === 'cancel') {
      cancelResult = settled(cancel())
      await firstWaiting
      attachResult = settled(attach())
    } else if (orderedFirst === 'attach') {
      attachResult = settled(attach())
      await firstWaiting
      cancelResult = settled(cancel())
    } else {
      attachResult = settled(attach())
      cancelResult = settled(cancel())
    }
    await waiting
  } catch (error) { latchError = error } finally { release() }
  try { await latch } catch (error) { latchError ??= error }
  const [attached, canceled] = await Promise.all([attachResult, cancelResult])
  if (latchError) throw latchError
  return { attach: attached, cancel: canceled }
}

function isolatedDbEndpoint(suffix, databaseUrl = process.env.V2_DATABASE_URL) {
  const url = new URL(databaseUrl)
  const runName = url.searchParams.get('application_name')
  assert.ok(runName?.startsWith('apollo-video-e2e-'),
    'the race must remain inside the supervised E2E application_name')
  const applicationName = `${runName}-${suffix}`
  assert.ok(Buffer.byteLength(applicationName, 'utf8') <= 63,
    'PostgreSQL must retain the full run identity and race contender name')
  url.searchParams.set('application_name', applicationName)
  url.searchParams.set('connection_limit', '1')
  return { url: url.toString(), applicationName }
}

function orderedRaceEndpoint(role, scenario, fixtureId, databaseUrl = process.env.V2_DATABASE_URL) {
  // Explicit contender names leave room for the entire supervised run identity;
  // no slice/hash/truncation of that identity or of the eight-character fixture ID.
  const roles = { latch: 'lat', attach: 'att', control: 'ctl' }
  const scenarios = { 'cancel-first': 'cf', takeover: 'to' }
  assert.ok(typeof role === 'string' && Object.hasOwn(roles, role), 'W65 race role is not in the closed contender enum')
  assert.ok(typeof scenario === 'string' && Object.hasOwn(scenarios, scenario), 'W65 race scenario is not in the closed contender enum')
  assert.ok(typeof fixtureId === 'string' && /^[a-f0-9]{8}$/.test(fixtureId), 'W65 race fixture identity must contain exactly eight hexadecimal characters')
  return isolatedDbEndpoint(`${roles[role]}-${scenarios[scenario]}-${fixtureId}`, databaseUrl)
}

function inlineRightsEndpoint(role, rightsChange, fixtureId, databaseUrl = process.env.V2_DATABASE_URL) {
  const roles = { latch: 'il', admit: 'ia' }
  const scenarios = { revoke: 'rv', expiry: 'ex' }
  assert.ok(typeof role === 'string' && Object.hasOwn(roles, role), 'W65 inline role is not in the closed contender enum')
  assert.ok(typeof rightsChange === 'string' && Object.hasOwn(scenarios, rightsChange), 'W65 inline rights change is not in the closed contender enum')
  assert.ok(typeof fixtureId === 'string' && /^[a-f0-9]{8}$/.test(fixtureId), 'W65 inline fixture identity must contain exactly eight hexadecimal characters')
  return isolatedDbEndpoint(`${roles[role]}-${scenarios[rightsChange]}-${fixtureId}`, databaseUrl)
}

test('W65 ordered race names preserve the full CI run and fixture identities with six distinct bounded contenders', () => {
  const runName = 'apollo-video-e2e-perception-38384233934'
  const url = new URL('postgresql://test:test@127.0.0.1:5432/apollo_v2_e2e?schema=public&connection_limit=2&pool_timeout=10&connect_timeout=10')
  url.searchParams.set('application_name', runName)
  const names = []
  for (const [scenario, scenarioCode] of [['cancel-first', 'cf'], ['takeover', 'to']]) {
    for (const [role, roleCode] of [['latch', 'lat'], ['attach', 'att'], ['control', 'ctl']]) {
      const endpoint = orderedRaceEndpoint(role, scenario, 'deadbeef', url.toString())
      assert.equal(endpoint.applicationName, `${runName}-${roleCode}-${scenarioCode}-deadbeef`)
      assert.ok(Buffer.byteLength(endpoint.applicationName, 'utf8') <= 63)
      const actual = new URL(endpoint.url)
      assert.equal(actual.searchParams.get('application_name'), endpoint.applicationName)
      assert.equal(actual.searchParams.get('connection_limit'), '1')
      assert.equal(actual.searchParams.get('schema'), 'public')
      assert.equal(actual.searchParams.get('pool_timeout'), '10')
      assert.equal(actual.searchParams.get('connect_timeout'), '10')
      assert.equal(actual.host, url.host); assert.equal(actual.pathname, url.pathname)
      names.push(endpoint.applicationName)
    }
  }
  assert.equal(new Set(names).size, 6)
  const boundaryRun = 'apollo-video-e2e-perception-1234567890123456789'
  url.searchParams.set('application_name', boundaryRun)
  const boundary = orderedRaceEndpoint('control', 'cancel-first', 'deadbeef', url.toString())
  assert.equal(boundary.applicationName, `${boundaryRun}-ctl-cf-deadbeef`)
  assert.equal(Buffer.byteLength(boundary.applicationName, 'utf8'), 63)
})

test('W65 ordered race names fail closed for unknown contenders, invalid fixtures and oversized UTF-8 run identities', () => {
  const url = new URL('postgresql://test:test@127.0.0.1:5432/apollo_v2_e2e?application_name=apollo-video-e2e-perception-38384233934')
  for (const role of ['unknown', 'constructor', '', null]) {
    assert.throws(() => orderedRaceEndpoint(role, 'cancel-first', 'deadbeef', url.toString()), /closed contender enum/)
  }
  for (const scenario of ['unknown', 'constructor', '', null]) {
    assert.throws(() => orderedRaceEndpoint('latch', scenario, 'deadbeef', url.toString()), /closed contender enum/)
  }
  for (const fixtureId of ['deadbee', 'deadbeeff', 'DEADBEEF', 'dead-beef', '', null]) {
    assert.throws(() => orderedRaceEndpoint('latch', 'cancel-first', fixtureId, url.toString()), /exactly eight hexadecimal/)
  }
  for (const runName of ['apollo-video-e2e-perception-12345678901234567890', `apollo-video-e2e-${'é'.repeat(20)}`]) {
    url.searchParams.set('application_name', runName)
    assert.throws(() => orderedRaceEndpoint('control', 'cancel-first', 'deadbeef', url.toString()), /PostgreSQL must retain the full run identity/)
  }
  url.searchParams.set('application_name', 'production')
  assert.throws(() => orderedRaceEndpoint('latch', 'cancel-first', 'deadbeef', url.toString()), /supervised E2E/)
  url.searchParams.delete('application_name')
  assert.throws(() => orderedRaceEndpoint('latch', 'cancel-first', 'deadbeef', url.toString()), /supervised E2E/)
})

test('W65 inline rights names preserve complete run and fixture identities with distinct latch/admission contenders', () => {
  const runName = 'apollo-video-e2e-perception-38384233934'
  const url = new URL('postgresql://test:test@127.0.0.1:5432/apollo_v2_e2e?schema=public&connection_limit=2&pool_timeout=10&connect_timeout=10')
  url.searchParams.set('application_name', runName)
  const names = []
  for (const [rightsChange, scenarioCode] of [['revoke', 'rv'], ['expiry', 'ex']]) {
    for (const [role, roleCode] of [['latch', 'il'], ['admit', 'ia']]) {
      const endpoint = inlineRightsEndpoint(role, rightsChange, 'deadbeef', url.toString())
      assert.equal(endpoint.applicationName, `${runName}-${roleCode}-${scenarioCode}-deadbeef`)
      assert.ok(Buffer.byteLength(endpoint.applicationName, 'utf8') <= 63)
      const actual = new URL(endpoint.url)
      assert.equal(actual.searchParams.get('application_name'), endpoint.applicationName)
      assert.equal(actual.searchParams.get('connection_limit'), '1')
      assert.equal(actual.searchParams.get('schema'), 'public')
      assert.equal(actual.searchParams.get('pool_timeout'), '10')
      assert.equal(actual.searchParams.get('connect_timeout'), '10')
      names.push(endpoint.applicationName)
    }
  }
  assert.equal(new Set(names).size, 4)
  for (const scenario of ['cancel-first', 'takeover']) for (const role of ['latch', 'attach', 'control']) {
    names.push(orderedRaceEndpoint(role, scenario, 'deadbeef', url.toString()).applicationName)
  }
  assert.equal(new Set(names).size, 10, 'Inline and ordered contenders must not collide')
  const boundaryRun = 'apollo-video-e2e-perception-12345678901234567890'
  url.searchParams.set('application_name', boundaryRun)
  const boundary = inlineRightsEndpoint('admit', 'expiry', 'deadbeef', url.toString())
  assert.equal(boundary.applicationName, `${boundaryRun}-ia-ex-deadbeef`)
  assert.equal(Buffer.byteLength(boundary.applicationName, 'utf8'), 63)
})

test('W65 inline rights names reject unsupported roles/changes and invalid or oversized identities without truncation', () => {
  const url = new URL('postgresql://test:test@127.0.0.1:5432/apollo_v2_e2e?application_name=apollo-video-e2e-perception-38384233934')
  for (const role of ['control', 'unknown', 'constructor', null]) {
    assert.throws(() => inlineRightsEndpoint(role, 'revoke', 'deadbeef', url.toString()), /closed contender enum/)
  }
  for (const rightsChange of ['allow', 'unknown', 'constructor', null]) {
    assert.throws(() => inlineRightsEndpoint('admit', rightsChange, 'deadbeef', url.toString()), /closed contender enum/)
  }
  for (const fixtureId of ['deadbee', 'deadbeeff', 'DEADBEEF', 'dead-beef', null]) {
    assert.throws(() => inlineRightsEndpoint('admit', 'expiry', fixtureId, url.toString()), /exactly eight hexadecimal/)
  }
  for (const runName of ['apollo-video-e2e-perception-123456789012345678901', `apollo-video-e2e-${'é'.repeat(20)}`]) {
    url.searchParams.set('application_name', runName)
    assert.throws(() => inlineRightsEndpoint('admit', 'expiry', 'deadbeef', url.toString()), /PostgreSQL must retain the full run identity/)
  }
})

// Real PG authority tests; no renderer/approval claim. Probe transactions abort
// deliberately after resolution, preserving the surrounding editorial fixture.
async function canonicalDirectorSnapshotOwnerPG({ db, workspaceId, projectId, actor }) {
  const director = new PrismaDirectorRunRepository(db)
  const context = await director.readContext({ workspaceId, projectId })
  assert.ok(context)
  const audit = createApiAccessAuditContext({ ...actor.auditContext, authenticationKind: 'bearer' })
  const original = await db.v2ProjectSnapshot.findUniqueOrThrow({
    where: { id: context.currentVersion.snapshotRefs.brief },
  })
  const asSnapshot = (row) => ({ schemaVersion: 1, id: row.id, workspaceId: row.workspaceId, projectId: row.projectId,
    kind: row.kind, contentSchemaVersion: row.schemaVersion, contentJson: row.contentJson,
    contentHash: row.contentHash, createdAt: row.createdAt.toISOString() })
  const scopeFor = (label) => ({ workspaceId, projectId, baseVersionId: context.currentVersion.id,
    baseHash: context.currentVersion.baseHash, resultVersionId: `canonical-version-${randomUUID()}`,
    idempotencyKey: `canonical-${label}-${randomUUID()}`,
    requestFingerprint: calculateVersionHash({ kind: 'controlled-canonical-snapshot-probe', label, projectId }),
    actorContextHash: audit.contextHash })
  const baseline = async () => ({
    project: await db.v2Project.findUniqueOrThrow({ where: { id: projectId } }),
    versions: await db.v2ProjectVersion.count({ where: { projectId } }),
    commands: await db.v2EditCommand.count({ where: { projectId } }),
    snapshots: await db.v2ProjectSnapshot.count({ where: { projectId } }),
    runs: await db.v2DirectorRun.count({ where: { projectId } }),
    operations: await db.v2PublicOperation.count({ where: { workspaceId } }),
    outbox: await db.v2PublicEventOutbox.count({ where: { workspaceId } }),
  })
  const before = await baseline()
  const sentinel = new Error('controlled-resolution-rollback')
  const candidate = { ...asSnapshot(original), id: `canonical-candidate-${randomUUID()}`, createdAt: new Date().toISOString() }
  await assert.rejects(director.commitWithCanonicalSnapshots(scopeFor('reuse'), async (resolve) => {
    const rows = await resolve([candidate])
    assert.deepEqual(rows, [asSnapshot(original)])
    throw sentinel
  }), (error) => error === sentinel)
  assert.deepEqual(await baseline(), before)
  assert.deepEqual(await db.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: original.id } }), original)

  for (const [label, mutate] of [
    ['schema', (row) => { row.contentSchemaVersion += 1 }],
    ['invalid schema', (row) => { row.contentSchemaVersion = 0 }],
    ['malformed JSON', (row) => { row.contentJson = '{' }],
    ['JSON/hash', (row) => { row.contentJson = stableSerialize({ schemaVersion: 1, tampered: true }) }],
    ['resealed ID collision', (row) => { row.contentJson = stableSerialize({ schemaVersion: 1, tampered: true })
      row.contentHash = calculateCanonicalHash(JSON.parse(row.contentJson)) }],
    ['workspace', (row) => { row.workspaceId = 'workspace-outside-owner' }],
    ['project', (row) => { row.projectId = 'project-outside-owner' }],
  ]) {
    const wrong = structuredClone(asSnapshot(original)); mutate(wrong)
    await assert.rejects(director.commitWithCanonicalSnapshots(scopeFor(label), async (resolve) => {
      await resolve([wrong]); throw sentinel
    }), (error) => error.code === 'PERSISTENCE_CONFLICT', label)
    assert.deepEqual(await baseline(), before, label)
  }

  const holdEndpoint = isolatedDbEndpoint('cH'), readerEndpoint = isolatedDbEndpoint('cR')
  const holder = new PrismaClient({ datasources: { db: { url: holdEndpoint.url } } })
  const reader = new PrismaClient({ datasources: { db: { url: readerEndpoint.url } } })
  let release, readyResolve, readyReject, latch, reading, primary
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const released = new Promise((resolve) => { release = resolve })
  try {
    latch = holder.$transaction(async (tx) => {
      // project_snapshots is append-only (BEFORE UPDATE trigger project_snapshots_w66_dependency_guard): a stored row can no longer be
      // rewritten under the reader, so the schema tamper this latch used to commit is unreachable. What stays observable is the wait:
      // the canonical reader locks the row FOR SHARE, so it queues behind a writer that holds it FOR UPDATE, and then resolves it.
      await tx.$queryRaw`SELECT id FROM project_snapshots WHERE id = ${original.id} FOR UPDATE`
      readyResolve()
      const deadline = Date.now() + 5000
      let waited = false
      while (Date.now() < deadline) {
        await tx.$queryRaw`SELECT pg_stat_clear_snapshot() IS NULL AS cleared`
        const rows = await tx.$queryRaw`SELECT wait_event_type AS "waitType" FROM pg_stat_activity
          WHERE application_name = ${readerEndpoint.applicationName}`
        waited = rows.some((row) => row.waitType === 'Lock')
        if (waited) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.ok(waited, 'canonical snapshot reader must wait on the real locked row')
      release()
    }, { timeout: 8000 }).catch((error) => { readyReject(error); release(); throw error })
    latch.catch(() => {})
    await ready
    reading = new PrismaDirectorRunRepository(reader).commitWithCanonicalSnapshots(scopeFor('concurrent-tamper'), async (resolve) => {
      await resolve([candidate]); throw sentinel
    }).then((value) => ({ value }), (error) => ({ error }))
    await released
    await latch
    const result = await reading
    assert.equal(result.error, sentinel, 'after the real row-lock wait the reader resolves the intact canonical row')
    assert.deepEqual(await baseline(), before)
  } catch (error) { primary = error; throw error } finally {
    release()
    await Promise.allSettled([latch, reading].filter(Boolean))
    const errors = []
    const closed = await Promise.allSettled([holder.$disconnect(), reader.$disconnect()])
    errors.push(...closed.filter((result) => result.status === 'rejected').map((result) => result.reason))
    if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors, 'Canonical snapshot latch cleanup failed')
  }
  assert.deepEqual(await db.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: original.id } }), original)

  // Two real callers plan from the same head with different candidate UUIDs.
  // The project lock serializes ownership: winner reuses the row, loser is stale.
  const endpoints = [isolatedDbEndpoint('cA'), isolatedDbEndpoint('cB'), isolatedDbEndpoint('cL')]
  const clients = endpoints.map((endpoint) => new PrismaClient({ datasources: { db: { url: endpoint.url } } }))
  let unlock, raceReadyResolve, raceReadyReject, raceLatch, contenders, raceError
  const raceReady = new Promise((resolve, reject) => { raceReadyResolve = resolve; raceReadyReject = reject })
  const unlockPromise = new Promise((resolve) => { unlock = resolve })
  const compilerCalls = [0, 0], allocated = [[], []]
  const keys = [`canonical-race-A-${randomUUID()}`, `canonical-race-B-${randomUUID()}`]
  try {
    raceLatch = clients[2].$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`
      assert.equal(locked.length, 1)
      raceReadyResolve()
      const deadline = Date.now() + 5000
      let waited = false
      while (Date.now() < deadline) {
        await tx.$queryRaw`SELECT pg_stat_clear_snapshot() IS NULL AS cleared`
        const rows = await tx.$queryRaw`SELECT application_name AS name, wait_event_type AS "waitType"
          FROM pg_stat_activity WHERE application_name IN (${endpoints[0].applicationName}, ${endpoints[1].applicationName})`
        waited = new Set(rows.filter((row) => row.waitType === 'Lock').map((row) => row.name)).size === 2
        if (waited) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.ok(waited, 'both canonical callers must be observed at the real project lock')
      unlock()
    }, { timeout: 8000 }).catch((error) => { raceReadyReject(error); unlock(); throw error })
    raceLatch.catch(() => {})
    await raceReady
    contenders = clients.slice(0, 2).map((client, index) => {
      const compiler = createEvidenceBoundBriefCompiler()
      const service = runProjectDirectorService({ repository: new PrismaDirectorRunRepository(client),
        clock: () => new Date(), createEventId: randomUUID,
        createId: (kind) => { const id = `${kind}-canonical-${randomUUID()}`; allocated[index].push({ kind, id }); return id },
        compileBrief: async (input) => { compilerCalls[index] += 1; return compiler(input) },
      })
      return service({ workspaceId, projectId, baseVersionId: context.currentVersion.id,
        baseHash: context.currentVersion.baseHash, actor, idempotency: { key: keys[index] },
        reason: 'Keep the existing discovery direction and reuse canonical immutable snapshots.' })
        .then((value) => ({ value }), (error) => ({ error }))
    })
    await unlockPromise
    await raceLatch
    const results = await Promise.all(contenders)
    assert.equal(results.filter((result) => result.value).length, 1)
    const winnerIndex = results.findIndex((result) => result.value), loserIndex = 1 - winnerIndex
    const winner = results[winnerIndex].value
    assert.equal(results[loserIndex].error?.code, 'VERSION_CONFLICT', 'stale retry cannot recompute the planner or commit another head')
    assert.deepEqual(compilerCalls, [1, 1])
    assert.notEqual(allocated[0].find((id) => id.kind === 'project-snapshot').id,
      allocated[1].find((id) => id.kind === 'project-snapshot').id)
    assert.equal(winner.version.snapshotRefs.brief, original.id)
    assert.equal(winner.command.payload.snapshotRefs.brief, original.id)
    assert.equal(winner.run.qualityReport.status, 'review-required')
    assert.equal(winner.run.qualityReport.faceSafety.status, 'unknown')
    assert.equal(await db.v2EditCommand.count({ where: { projectId, idempotencyKey: keys[loserIndex] } }), 0)
    assert.equal(await db.v2ProjectVersion.count({ where: { id: allocated[loserIndex].find((id) => id.kind === 'project-version').id } }), 0)
    assert.equal(await db.v2ProjectSnapshot.count({ where: { projectId, kind: original.kind, contentHash: original.contentHash } }), 1)
    assert.deepEqual(await db.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: original.id } }), original)
    console.log(JSON.stringify({ scope: 'canonical-director-snapshot-PG', concurrentCallers: 2,
      succeeded: 1, stale: 1, canonicalBriefId: original.id, originalCreatedAtPreserved: true,
      compilerCalls, physicalRenderObserved: false, approvalTransferred: false }))
  } catch (error) { raceError = error; throw error } finally {
    unlock()
    await Promise.allSettled([raceLatch, ...(contenders ?? [])].filter(Boolean))
    const closed = await Promise.allSettled(clients.map((client) => client.$disconnect()))
    const errors = closed.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (errors.length) throw new AggregateError(raceError ? [raceError, ...errors] : errors, 'Canonical caller cleanup failed')
  }
  // Admission after a real project-lock wait must use current PostgreSQL time.
  // The queued operation predates this TX; only new Director effects must stay zero.
  const leaseContext = await director.readContext({ workspaceId, projectId })
  const operations = new PrismaPublicOperationRepository(db)
  const queued = await enqueueProjectDirectorRunService({ directorRuns: director, operations,
    createId: (kind) => `${kind}-canonical-lease-${randomUUID()}`, clock: () => new Date(),
  })({ workspaceId, projectId, baseVersionId: leaseContext.currentVersion.id,
    baseHash: leaseContext.currentVersion.baseHash, actor,
    idempotencyKey: `canonical-lease-${randomUUID()}` })
  const claimedAt = new Date(), leaseUntil = new Date(claimedAt.getTime() + 1500)
  const leaseOwner = `canonical-worker-${randomUUID()}`
  const claimed = await operations.claimNext({ type: 'project-director-run', leaseOwner,
    now: claimedAt.toISOString(), leaseUntil: leaseUntil.toISOString() })
  assert.equal(claimed.operation.id, queued.operation.id)
  const leaseScope = { ...scopeFor('expired-lease'), baseVersionId: leaseContext.currentVersion.id,
    baseHash: leaseContext.currentVersion.baseHash, resultVersionId: claimed.operation.target.id,
    operationFence: { operationId: claimed.operation.id, leaseOwner,
      attempt: claimed.lease.attempt, now: claimedAt.toISOString() } }
  const leaseBefore = await baseline()
  const leaseEndpoints = [isolatedDbEndpoint('cE'), isolatedDbEndpoint('cF')]
  const leaseClients = leaseEndpoints.map((endpoint) => new PrismaClient({ datasources: { db: { url: endpoint.url } } }))
  let leaseUnlock, leaseReadyResolve, leaseReadyReject, leaseLatch, leaseAdmission, leasePrimary
  let prepared = 0
  const leaseReady = new Promise((resolve, reject) => { leaseReadyResolve = resolve; leaseReadyReject = reject })
  const leaseReleased = new Promise((resolve) => { leaseUnlock = resolve })
  try {
    leaseLatch = leaseClients[0].$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`
      assert.equal(locked.length, 1)
      leaseReadyResolve()
      const deadline = Date.now() + 5000
      let waited = false, expired = false, liveWaitObserved = false
      while (Date.now() < deadline) {
        await tx.$queryRaw`SELECT pg_stat_clear_snapshot() IS NULL AS cleared`
        const rows = await tx.$queryRaw`SELECT wait_event_type AS "waitType" FROM pg_stat_activity
          WHERE application_name = ${leaseEndpoints[1].applicationName}`
        waited ||= rows.some((row) => row.waitType === 'Lock')
        const [clock] = await tx.$queryRaw`SELECT clock_timestamp() AS now`
        expired = clock.now.getTime() >= leaseUntil.getTime()
        liveWaitObserved ||= waited && !expired
        if (waited && expired) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.ok(waited, 'Director admission must actually wait on the project lock')
      assert.ok(liveWaitObserved, 'the lease must be live when the SQL wait is first observed')
      assert.ok(expired, 'lease expiration must be observed on the database clock before release')
      leaseUnlock()
    }, { timeout: 8000 }).catch((error) => { leaseReadyReject(error); leaseUnlock(); throw error })
    leaseLatch.catch(() => {})
    await leaseReady
    leaseAdmission = new PrismaDirectorRunRepository(leaseClients[1]).commitWithCanonicalSnapshots(leaseScope, async () => {
      prepared += 1
      throw sentinel
    }).then((value) => ({ value }), (error) => ({ error }))
    await leaseReleased
    await leaseLatch
    const result = await leaseAdmission
    assert.equal(result.error?.code, 'PERSISTENCE_CONFLICT')
    assert.equal(prepared, 0, 'expired lease cannot resolve snapshots or reseal a bundle')
    assert.deepEqual(await baseline(), leaseBefore, 'queue/claim remain; no new Director TX effects')
    console.log(JSON.stringify({ scope: 'canonical-director-lease-PG', realProjectLockWait: true,
      expirationObservedByPG: true, preparedCallbacks: prepared, errorCode: result.error.code,
      precedingQueuedOperationPreserved: true, newDirectorEffects: 0 }))
  } catch (error) { leasePrimary = error; throw error } finally {
    leaseUnlock()
    await Promise.allSettled([leaseLatch, leaseAdmission].filter(Boolean))
    const closed = await Promise.allSettled(leaseClients.map((client) => client.$disconnect()))
    const errors = closed.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (errors.length) throw new AggregateError(leasePrimary ? [leasePrimary, ...errors] : errors, 'Canonical lease cleanup failed')
  }
}

test('W65 controlled proxy fixture hydrates through the production operation parser before PostgreSQL', () => {
  const workspaceId = 'w65-offline-workspace', projectId = 'w65-offline-project'
  const clientId = 'w65-offline-client', artifactId = 'w65-offline-artifact'
  const operationId = 'w65-offline-operation', manifestId = 'w65-offline-manifest'
  const operation = controlledRunningProxyOperation({ id: operationId, workspaceId,
    projectId, clientId, artifactId, manifestId, now: Date.now() })
  const audit = createApiAccessAuditContext({ clientId, workspaceId,
    credentialId: 'w65-offline-credential', environment: 'production', authenticationKind: 'bearer' })
  assertControlledProxyRowHydrates({ id: operationId, workspaceId, projectId, clientId,
    ...externalActorAuditData(audit, workspaceId, clientId),
    type: operation.type, status: operation.status, phase: operation.phase,
    targetType: operation.target.type, targetId: operation.target.id,
    progressCompleted: operation.progress.completed, progressTotal: operation.progress.total,
    progressUnit: operation.progress.unit, cancelable: operation.cancelable,
    retryable: operation.retryable, attempt: operation.attempt, maxAttempts: operation.maxAttempts,
    createdAt: new Date(operation.createdAt), startedAt: new Date(operation.startedAt),
    updatedAt: new Date(operation.updatedAt), leaseOwner: 'w65-offline-worker',
    heartbeatAt: new Date(operation.updatedAt), leaseExpiresAt: new Date(Date.now() + 120_000),
  }, { operationId, workspaceId, projectId, projectVersionId: 'w65-offline-version',
    editPlanSnapshotId: 'w65-offline-edit', sourceArtifactId: 'w65-offline-source',
    sourceManifestId: 'w65-offline-source-manifest', outputArtifactId: artifactId,
    outputManifestId: manifestId, originalFileName: 'controlled.mp4',
    inputHash: 'a'.repeat(64), colorPipelineBindingsJson: stableSerialize([{
      sourceArtifactId: 'w65-offline-source', sourceManifestId: 'w65-offline-source-manifest',
      compilationId: 'w65-offline-color', compilationHash: 'b'.repeat(64),
      pipelineHash: 'c'.repeat(64),
    }]) }, audit.contextHash)
})

async function stopRunner(child) {
  if (!child) return
  if (!Number.isSafeInteger(child.pid)) return
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once('close', resolve))
    child.kill('SIGTERM')
    const graceful = await Promise.race([closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000))])
    if (!graceful) {
      child.kill('SIGKILL')
      assert.equal(await Promise.race([closed.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]), true,
      'OCR runner did not terminate')
    }
  }
  assert.throws(() => process.kill(child.pid, 0), /ESRCH|not found/i)
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Select-Object -ExpandProperty ProcessId`],
    { windowsHide: true, timeout: 10_000 })
    assert.equal(stdout.trim(), '', 'OCR runner descendants remain after shutdown')
  }
}

test('W64 PostgreSQL Director consumes a sealed OCR run, persists scoped refs and keeps face review required',
  { skip: !process.env.V2_DATABASE_URL || !process.env.APOLLO_OCR_FFMPEG ||
      !process.env.APOLLO_OCR_FFPROBE || !process.env.APOLLO_OCR_TESSERACT ||
      !process.env.APOLLO_OCR_TESSDATA,
    timeout: 180_000 }, async () => {
    const db = new PrismaClient({ datasources: { db: {
      url: isolatedDbEndpoint('main').url,
    } } })
    const root = await mkdtemp(join(tmpdir(), 'apollo-w64-director-ocr-'))
    let runner
    let cleanupScope
    let primaryError
    try {
      const suffix = randomUUID().slice(0, 8)
      const workspaceId = `w61-admission-${suffix}`
      const artifactKey = `${workspaceId}/source.mp4`
      const artifactPath = join(root, artifactKey)
      await mkdir(join(root, workspaceId), { recursive: true })
      const imagePath = join(root, 'text.png')
      const { default: sharp } = await import('sharp')
      await sharp(Buffer.from('<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="white"/><text x="50" y="200" font-size="100" font-family="Arial" font-weight="bold" fill="black">APOLLO</text></svg>'))
        .png().toFile(imagePath)
      await exec(process.env.APOLLO_OCR_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
        '-loop', '1', '-framerate', '30', '-t', '4', '-i', imagePath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', artifactPath],
      { windowsHide: true, timeout: 30_000 })
      const bytes = await readFile(artifactPath)
      // The world is sealed by the product's writers: the project's one output is the explicit 9:16 variant (the format every
      // consumer below reads from the sealed entry), the recording is ingested and granted, and the Version that plays the plan and
      // the transcript below is committed as a child Command - a sealed Version's rows are never rewritten.
      const world = await seedDirectorOcrWorld(db, { suffix, artifactKey,
        sourceSha256: sha(bytes), byteSize: BigInt(bytes.length) })
      cleanupScope = { workspaceId, clientId: world.clientId, suffix }
      const manifestId = `w64-manifest-${suffix}`
      await db.v2MediaArtifactManifest.create({ data: { id: manifestId,
        workspaceId, artifactId: world.sourceId, schemaVersion: 'media-artifact-manifest/v2',
        manifestHash: sha(Buffer.from(`manifest-${suffix}`)), recipeId: 'w64-controlled-source',
        recipeVersion: '1.0.0', parametersHash: sha(Buffer.from(`parameters-${suffix}`)),
        manifestJson: stableSerialize({ artifact: { artifactKey },
          probe: { width: 640, height: 360, duration: 4, fps: 30 } }) } })
      const transcriptId = `w64-transcript-${suffix}`
      const transcript = createMediaTranscript({ language: 'pt-BR',
        text: 'Bem vindo ao Apollo', provider: 'groq', model: 'whisper-large-v3',
        words: [
          { word: 'Bem', start: 0.2, end: 0.5 },
          { word: 'vindo', start: 0.5, end: 0.9 },
          { word: 'ao', start: 0.9, end: 1.1 },
          { word: 'Apollo', start: 1.1, end: 1.7 },
        ],
        segments: [{ id: 0, start: 0.2, end: 1.7, text: 'Bem vindo ao Apollo' }] })
      await db.v2MediaTranscript.create({ data: { id: transcriptId, workspaceId,
        projectId: world.projectId, sourceArtifactId: world.sourceId, sourceManifestId: manifestId,
        schemaVersion: transcript.schemaVersion, language: transcript.language,
        provider: transcript.provider, model: transcript.model, providerVersion: 'controlled-v1',
        transcriptHash: transcript.transcriptHash, transcriptJson: stableSerialize(transcript) } })
      const inputPlanOf = (playing) => ({ ...playing, sources: [{ id: world.sourceId, artifactId: world.sourceId,
        kind: 'video', durationSeconds: 4 }], overlayTracks: [], subtitleTracks: [],
      audioTracks: [], effectTracks: [], markers: [], transitions: [], protectedElements: [],
      localeVariantRefs: [], formatVariantRefs: [], lineageRefs: [world.sourceId],
      editorial: { commandType: 'remove-spoken-content', exclusions: [],
        retainedSourceRanges: [{ sourceStartSeconds: 0, sourceEndSeconds: 4 }] },
      subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
      retimedTranscript: { sourceTranscriptId: transcriptId, sourceTranscriptHash: transcript.transcriptHash,
        words: [
          { text: 'Bem', sourceStartSeconds: 0.2, sourceEndSeconds: 0.5,
            timelineStartFrame: 6, timelineEndFrame: 15 },
          { text: 'vindo', sourceStartSeconds: 0.5, sourceEndSeconds: 0.9,
            timelineStartFrame: 15, timelineEndFrame: 27 },
          { text: 'ao', sourceStartSeconds: 0.9, sourceEndSeconds: 1.1,
            timelineStartFrame: 27, timelineEndFrame: 33 },
          { text: 'Apollo', sourceStartSeconds: 1.1, sourceEndSeconds: 1.7,
            timelineStartFrame: 33, timelineEndFrame: 51 },
        ] }, createdAt: new Date().toISOString() })
      // The Version that plays the recording with this transcript is a real child Command that adopts the recording's ingest
      // receipt (the stored brief and policies stay what project creation sealed: they are not part of what this suite proves).
      const inputHead = await commitSealedChild(db, { workspaceId, projectId: world.projectId, actor: world.actor,
        suffix: `w64-${suffix}-input`, adopt: [world.sourceId],
        mutatePlan: (parentPlan) => inputPlanOf(planPlayingRecordings([world.recording])(parentPlan)) })
      world.head = inputHead
      world.versionId = inputHead.version.id
      world.editId = inputHead.editPlanSnapshot.id
      const actorContext = createExternalAuditContext({ clientId: world.clientId,
        credentialId: `w64-credential-${suffix}`, workspaceId, environment: 'production' })
      const actor = { ...actorContext, scopes: new Set(['projects:write']),
        authenticationKind: 'bearer', clientKillSwitchEngaged: false,
        workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
        workspaceAccessStatus: 'active', auditContext: actorContext }
      const manuallyPut = await putPerceptionTimelineService({
        repository: new PrismaPerceptionTimelineRepository(db), clock: () => new Date(),
        createId: () => `w64-manual-perception-${suffix}`,
      })({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
        baseRevision: null, durationMs: 4000, actor,
        observations: [{ id: 'caller-ocr-1', kind: 'ocr', startMs: 0, endMs: 500,
          value: { text: 'Caller claim' },
          provenance: { source: 'caller', model: 'caller', version: 'v1', confidence: 0.99 } }],
        coverage: PERCEPTION_KINDS.map((kind) => ({ kind,
          ranges: kind === 'ocr' ? [[0, 500]] : [] })),
        idempotencyKey: `w64-manual-${suffix}` })
      assert.equal(manuallyPut.timeline.origin.trust, 'unverified')
      const director = new PrismaDirectorRunRepository(db)
      assert.equal((await director.readContext({ workspaceId, projectId: world.projectId })).ocrEnvelope,
        undefined, 'no server envelope must remain absent')
      const operations = new PrismaPublicOperationRepository(db)
      const queued = await enqueuePerceptionProducerRunService({
        context: new PrismaPerceptionProducerRequestContextRepository(db), operations,
        createOperationId: () => `w64-operation-${randomUUID()}`,
      })({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
        sourceArtifactId: world.sourceId, sampleIntervalFrames: 60, actor,
        idempotencyKey: `w64-ocr-${suffix}` })
      const env = { ...process.env, APOLLO_V2_ARTIFACT_ROOT: root,
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        APOLLO_V2_OCR_FFMPEG_BIN: process.env.APOLLO_OCR_FFMPEG,
        APOLLO_V2_OCR_FFPROBE_BIN: process.env.APOLLO_OCR_FFPROBE,
        APOLLO_V2_OCR_TESSERACT_BIN: process.env.APOLLO_OCR_TESSERACT,
        APOLLO_V2_OCR_TESSDATA_DIR: process.env.APOLLO_OCR_TESSDATA,
        APOLLO_V2_OCR_TESSDATA_LICENSE: join(process.env.APOLLO_OCR_TESSDATA, 'LICENSE'),
        APOLLO_V2_OCR_LANGUAGES: 'eng', APOLLO_V2_OCR_POLL_MS: '100' }
      runner = spawn(process.execPath, ['--import', 'tsx',
        'scripts/run-v2-perception-producer-worker.mjs'], { cwd: process.cwd(), env,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const runnerState = { spawnError: null, closed: false }
      runner.once('error', (error) => { runnerState.spawnError = error })
      runner.once('close', () => { runnerState.closed = true })
      assert.ok(Number.isSafeInteger(runner.pid) && runner.pid > 0)
      let diagnostic = ''
      runner.stdout.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-4000) })
      runner.stderr.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-4000) })
      const deadline = Date.now() + 105_000
      let completed
      while (Date.now() < deadline) {
        if (runnerState.spawnError) throw runnerState.spawnError
        completed = await operations.findById(workspaceId, queued.operation.id)
        if (['succeeded', 'failed'].includes(completed?.operation.status)) break
        if (runnerState.closed || runner.exitCode !== null || runner.signalCode !== null) {
          throw new Error(`OCR runner stopped before terminal operation: ${diagnostic}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert.equal(completed?.operation.status, 'succeeded', diagnostic)
      const context = await director.readContext({ workspaceId, projectId: world.projectId })
      assert.equal(context.ocrEnvelope?.authority, 'server-produced')
      assert.equal(context.ocrEnvelope?.faceSafety, 'unknown')
      assert.equal(context.ocrEnvelope?.projectVersionId, world.versionId)
      const envelopeId = context.ocrEnvelope.id
      const envelopeHash = context.ocrEnvelope.envelopeHash
      const row = await db.v2PerceptionProducerEnvelope.findUniqueOrThrow({ where: { id: envelopeId } })
      await db.v2PerceptionProducerEnvelope.update({ where: { id: envelopeId },
        data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(director.readContext({ workspaceId, projectId: world.projectId }),
        /integrity|hash/i)
      await db.v2PerceptionProducerEnvelope.update({ where: { id: envelopeId },
        data: { envelopeHash } })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
      await assert.rejects(director.readContext({ workspaceId, projectId: world.projectId }),
        /rights|blocked/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: world.rightsId, rightsRevision: 3 } })
      const counters = new Map()
      const run = runProjectDirectorService({ repository: director,
        clock: () => new Date(), createEventId: randomUUID,
        createId: (kind) => `${kind}-${suffix}-${counters.set(kind, (counters.get(kind) ?? 0) + 1).get(kind)}`,
        compileBrief: createEvidenceBoundBriefCompiler() })
      const request = { workspaceId, projectId: world.projectId,
        baseVersionId: world.versionId, baseHash: world.head.version.baseHash, actor,
        idempotency: { key: `w64-director-${suffix}` },
        reason: 'Plan source OCR as untrusted content with explicit review.' }
      const directed = await run(request)
      assert.equal(directed.run.perception.schemaVersion, 2)
      assert.equal(directed.run.perception.inputVersionId, world.versionId)
      assert.equal(directed.run.perception.ocrEvidence.envelopeId, envelopeId)
      assert.equal(directed.run.perception.ocrEvidence.envelopeHash, envelopeHash)
      assert.ok(directed.run.decisions.some((decision) => decision.evidenceRefs.includes(envelopeId)))
      assert.equal(directed.run.qualityReport.status, 'review-required')
      assert.equal(directed.run.qualityReport.faceSafety.status, 'unknown')
      assert.equal(directed.run.qualityReport.hardChecks.subtitlesFaceSafe, false)
      const proxy = new PrismaProjectProxyRenderRepository(db)
      const proxySource = await proxy.readCurrentSource({ workspaceId, projectId: world.projectId })
      assert.equal(proxySource?.trustedOcr?.envelopeId, envelopeId,
        'Result version may read only its Director input envelope with the same source map')
      assert.equal(proxySource.trustedOcr.inputVersionId, world.versionId)
      assert.equal(proxySource.trustedOcr.timeline.timelineHash,
        expectedOcrTimeline(context.ocrEnvelope, directed.run.editPlan.fps,
          directed.run.editPlan.durationFrames).timelineHash)
      await db.v2PerceptionProducerEnvelope.update({ where: { id: envelopeId },
        data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(proxy.readCurrentSource({ workspaceId, projectId: world.projectId }),
        /integrity|hash/i)
      await db.v2PerceptionProducerEnvelope.update({ where: { id: envelopeId },
        data: { envelopeHash } })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 4 } })
      await assert.rejects(proxy.readCurrentSource({ workspaceId, projectId: world.projectId }),
        /rights|blocked/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: world.rightsId, rightsRevision: 5 } })
      const directedEdit = await db.v2ProjectSnapshot.findUniqueOrThrow({
        where: { id: directed.version.snapshotRefs.editPlan } })
      // Real PG rows exercise both source resolvers. The master retains the normal
      // ingest grant (editing/rendering/etc.), with no library editorial-reuse.
      const ingestUses = ['distribution', 'editing', 'rendering', 'transcription']
      const rightsTemplate = await db.v2AssetRightsSnapshot.findUniqueOrThrow({ where: { id: world.rightsId } })
      let rightsSequence = 10
      async function installRights(artifactId, overrides = {}) {
        const { rightsWorkspaceId = workspaceId, ...draft } = overrides
        const sequence = rightsSequence++
        const snapshot = createAssetRightsSnapshot({ id: `proxy-rights-${suffix}-${sequence}`,
          workspaceId: rightsWorkspaceId, artifactId, sequence,
          draft: { status: 'approved', allowedUses: ingestUses, prohibitedUses: [], sourceNote: `controlled revision ${sequence}`,
            consent: { status: 'not-required', allowedUses: [] }, ...draft },
          createdBy: { type: 'user', id: 'w61-owner' }, createdAt: new Date().toISOString() })
        await db.v2AssetRightsSnapshot.create({ data: { ...rightsTemplate, id: snapshot.id,
          workspaceId: snapshot.workspaceId, artifactId, sequence, snapshotHash: snapshot.snapshotHash,
          status: snapshot.status, allowedUsesJson: stableSerialize(snapshot.allowedUses),
          prohibitedUsesJson: stableSerialize(snapshot.prohibitedUses),
          allowedWorkspaceIdsJson: stableSerialize(snapshot.allowedWorkspaceIds),
          allowedLocalesJson: snapshot.allowedLocales ? stableSerialize(snapshot.allowedLocales) : null,
          expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
          consentStatus: snapshot.consent.status, consentAllowedUsesJson: stableSerialize(snapshot.consent.allowedUses),
          consentExpiresAt: snapshot.consent.expiresAt ? new Date(snapshot.consent.expiresAt) : null,
          sourceNote: snapshot.sourceNote, createdAt: new Date(snapshot.createdAt) } })
        await db.v2MediaArtifact.update({ where: { id: artifactId },
          data: { currentRightsSnapshotId: snapshot.id, rightsRevision: { increment: 1 } } })
        return snapshot
      }
      // A renderable plan is born with a Version of its own (compile-renderable-plan): the child of the head it is compiled on, whose
      // id the plan must carry. The compile moves the head to that Version.
      const compileRenderable = async (baseVersionId, planTemplate, sourceId, sourceHash) => {
        const origin = 'react-playback'
        // The row's historical authority: the plan names its derivation (`<origin>:<source id>:<source hash>`) in its lineage.
        const plan = { ...planTemplate, projectVersionId: renderableCompileVersionId({
          workspaceId, projectId: world.projectId, origin, sourceId, sourceHash, baseVersionId }),
        lineageRefs: [...(planTemplate.lineageRefs ?? []), `${origin}:${sourceId}:${sourceHash}`] }
        const snapshot = renderablePlanSnapshotOf({ workspaceId, projectId: world.projectId,
          origin, sourceId, sourceHash, sourceVersion: null, plan })
        const { snapshot: stored } = await new PrismaRenderablePlanSnapshotRepository(db).persist({ snapshot,
          createdAt: new Date().toISOString(), baseVersionId,
          author: { type: 'api-client', id: world.clientId }, audit: materializeActorAuditContext(actor) })
        const version = await db.v2ProjectVersion.findUniqueOrThrow({ where: { id: plan.projectVersionId } })
        return { plan, snapshot, stored, version }
      }
      // A result whose time map is not the one its OCR evidence was bound to must carry no source-frame coordinates. The Version's
      // plan snapshot cannot be rewritten (project_snapshots is append-only: trigger project_snapshots_w66_dependency_guard), so the
      // contradiction is stored instead: a perception snapshot sealed over the same evidence but another time map is inserted beside
      // the original and the Director run - a mutable pointer row - is pointed at it. Plan and evidence then disagree exactly as when
      // the plan was the side that changed; the reader's predicate (hash of the plan's time map != the evidence's) is the same.
      const directedRunRow = await db.v2DirectorRun.findUniqueOrThrow({ where: { id: directed.run.id } })
      const originalPerception = await db.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: directedRunRow.perceptionSnapshotId } })
      const anotherTimeMap = JSON.parse(originalPerception.contentJson)
      assert.ok(anotherTimeMap.ocrEvidence, 'the Director perception snapshot carries the OCR evidence the time map is bound to')
      anotherTimeMap.ocrEvidence = { ...anotherTimeMap.ocrEvidence, timeMapHash: calculateCanonicalHash(`another-time-map-${suffix}`) }
      const anotherTimeMapSnapshot = await db.v2ProjectSnapshot.create({ data: { id: `w64-other-time-map-${suffix}`,
        workspaceId, projectId: world.projectId, kind: originalPerception.kind, schemaVersion: originalPerception.schemaVersion,
        contentJson: stableSerialize(anotherTimeMap), contentHash: calculateCanonicalHash(anotherTimeMap),
        createdAt: originalPerception.createdAt } })
      const pointRunAt = (perceptionSnapshotId) => db.v2DirectorRun.update({ where: { id: directed.run.id },
        data: { perceptionSnapshotId } })
      await pointRunAt(anotherTimeMapSnapshot.id)
      try {
        assert.equal((await proxy.readCurrentSource({ workspaceId, projectId: world.projectId })).trustedOcr,
          undefined, 'A changed result time map cannot carry source-frame OCR coordinates')
      } finally { await pointRunAt(originalPerception.id) }
      // Controlled repository attachment: the receipt is bound to a sealed recipe, not a
      // fabricated facial approval or a claim that this output was actually rendered.
      const ocrReceipt = { envelopeId, envelopeHash, inputVersionId: world.versionId,
        timeMapHash: proxySource.trustedOcr.timeMapHash,
        timelineHash: proxySource.trustedOcr.timeline.timelineHash,
        sourceArtifactId: world.sourceId, sourceManifestId: manifestId,
        sourceSha256: world.sourceSha256, editPlanHash: directedEdit.contentHash }
      const outputArtifactId = `w65-proxy-output-${suffix}`
      const outputManifestId = `w65-proxy-manifest-${suffix}`
      const proxyOperationId = `w65-proxy-operation-${suffix}`
      const inputHash = sha(Buffer.from(`w65-proxy-input-${suffix}`))
      const recipeParameters = { ocrReceipt, inputHash, format: '9:16',
        projectVersionId: directed.version.id, editPlanSnapshotId: directedEdit.id }
      const outputManifest = createMediaArtifactManifestV2({
        artifactKey: `${workspaceId}/controlled-proxy.mp4`, artifactSha256: 'd'.repeat(64),
        byteSize: 1024, mediaType: 'video', container: 'mp4',
        recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
          parameters: recipeParameters },
        sources: [{ artifactKey, sha256: world.sourceSha256, role: 'source-master',
          execution: { tool: { id: 'ffmpeg', version: 'static', digest: 'f'.repeat(64) } } }],
      })
      await db.v2MediaArtifact.create({ data: { id: outputArtifactId, workspaceId,
        artifactKey: `${workspaceId}/controlled-proxy.mp4`, sha256: 'd'.repeat(64),
        byteSize: 1024n, mediaType: 'video', container: 'mp4', status: 'available' } })
       await db.v2MediaArtifactManifest.create({ data: { id: outputManifestId, workspaceId,
         artifactId: outputArtifactId, schemaVersion: outputManifest.schemaVersion,
         manifestHash: outputManifest.manifestHash, recipeId: outputManifest.recipe.id,
         recipeVersion: outputManifest.recipe.version,
         parametersHash: outputManifest.recipe.parametersHash,
         manifestJson: stableSerialize(outputManifest) } })
       const controlledOperation = controlledRunningProxyOperation({
         id: proxyOperationId, workspaceId, projectId: world.projectId,
         clientId: world.clientId, artifactId: outputArtifactId,
         manifestId: outputManifestId, now: Date.now(),
       })
       const proxyAudit = createApiAccessAuditContext({ clientId: world.clientId,
         credentialId: `w65-proxy-credential-${suffix}`, workspaceId,
         environment: 'production', authenticationKind: 'bearer' })
       const operationData = { id: proxyOperationId, workspaceId,
         projectId: world.projectId, clientId: world.clientId,
         ...externalActorAuditData(proxyAudit, workspaceId, world.clientId),
         type: controlledOperation.type, status: controlledOperation.status,
         phase: controlledOperation.phase,
         targetType: 'media-artifact', targetId: outputArtifactId,
         progressCompleted: controlledOperation.progress.completed,
         progressTotal: controlledOperation.progress.total,
         progressUnit: controlledOperation.progress.unit,
         cancelable: controlledOperation.cancelable, retryable: controlledOperation.retryable,
         attempt: controlledOperation.attempt, maxAttempts: controlledOperation.maxAttempts,
         resultJson: null,
         idempotencyKey: `w65-proxy-attach-${suffix}`, requestFingerprint: inputHash,
         createdAt: new Date(controlledOperation.createdAt),
         startedAt: new Date(controlledOperation.startedAt),
         completedAt: null,
         leaseOwner: 'w65-controlled-worker',
         leaseExpiresAt: new Date(Date.now() + 120_000),
         heartbeatAt: new Date(controlledOperation.updatedAt),
         updatedAt: new Date(controlledOperation.updatedAt) }
      const detailData = { operationId: proxyOperationId,
        workspaceId, projectId: world.projectId, projectVersionId: directed.version.id,
        editPlanSnapshotId: directedEdit.id, sourceArtifactId: world.sourceId,
        sourceManifestId: manifestId, colorPipelineBindingsJson: stableSerialize([{
          sourceArtifactId: world.sourceId, sourceManifestId: manifestId,
          compilationId: `w65-controlled-color-${suffix}`,
          compilationHash: 'b'.repeat(64), pipelineHash: 'c'.repeat(64),
        }]), inputHash,
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4' }
      // Exercise the production row hydrator before opening PostgreSQL: the
      // controlled fixture must satisfy the same actor/context/phase invariants.
      assertControlledProxyRowHydrates(operationData, detailData, proxyAudit.contextHash)
      await db.v2PublicOperation.create({ data: operationData })
      await db.v2ProjectProxyRenderOperation.create({ data: detailData })
      const reviewTime = new Date().toISOString()
      const controlledReview = evaluateRenderedProxy({
        projectVersionId: directed.version.id, proxyArtifactId: outputArtifactId,
        proxyManifestId: outputManifestId, proxySha256: 'd'.repeat(64), inputHash,
        format: '9:16', sourceSha256: world.sourceSha256,
        editPlanHash: directedEdit.contentHash,
        expectedDurationMs: Math.round(directed.run.editPlan.durationFrames /
          directed.run.editPlan.fps * 1000),
        uploadReceivedAt: new Date(Date.now() - 60_000).toISOString(),
        renderCompletedAt: reviewTime,
        probe: { width: 540, height: 960,
          duration: directed.run.editPlan.durationFrames / directed.run.editPlan.fps,
          fps: directed.run.editPlan.fps, codec: 'h264', container: 'mp4' },
        map: { schemaVersion: 'render-element-map/v1', proxyHash: 'd'.repeat(64),
          fps: directed.run.editPlan.fps,
          durationFrames: directed.run.editPlan.durationFrames,
          canvas: { width: 540, height: 960 }, elements: [] },
        criticIssues: [{ code: 'FACE_PERCEPTION_UNAVAILABLE', severity: 'hard',
          category: 'integrity', message: 'Controlled face evidence remains unknown',
          correctable: false }],
      })
      assert.equal(controlledReview.status, 'blocked')
      const attach = (receipt = ocrReceipt, parameters = recipeParameters) => proxy.attachCompletedOutput({
        workspaceId, operationId: proxyOperationId, projectId: world.projectId,
        projectVersionId: directed.version.id, variantId: '9:16', format: '9:16',
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4',
        createdAt: reviewTime, recipeParameters: parameters, ocrReceipt: receipt,
        lease: { owner: 'w65-controlled-worker', attempt: controlledOperation.attempt,
          now: new Date().toISOString() }, review: controlledReview })
      const canceledId = `w65-canceled-proxy-${suffix}`
      const canceledQueued = createQueuedPublicOperation({ id: canceledId, workspaceId,
        projectId: world.projectId, clientId: world.clientId,
        type: 'project-proxy-render', target: { type: 'media-artifact',
          id: outputArtifactId, manifestId: outputManifestId },
        createdAt: new Date(Date.now() - 2_000).toISOString() })
      const canceled = cancelPublicOperation(canceledQueued, new Date(Date.now() - 1_000).toISOString())
      await db.v2PublicOperation.create({ data: { id: canceledId, workspaceId,
        projectId: world.projectId, clientId: world.clientId,
        ...externalActorAuditData(proxyAudit, workspaceId, world.clientId),
        type: canceled.type, status: canceled.status, phase: canceled.phase,
        targetType: 'media-artifact', targetId: outputArtifactId,
        progressCompleted: canceled.progress.completed, progressTotal: canceled.progress.total,
        progressUnit: canceled.progress.unit, cancelable: canceled.cancelable,
        retryable: canceled.retryable, attempt: canceled.attempt, maxAttempts: canceled.maxAttempts,
        idempotencyKey: `w65-canceled-${suffix}`, requestFingerprint: sha(Buffer.from(canceledId)),
        createdAt: new Date(canceled.createdAt), updatedAt: new Date(canceled.updatedAt),
        completedAt: new Date(canceled.completedAt) } })
      await assert.rejects(proxy.attachCompletedOutput({
        workspaceId, operationId: canceledId, projectId: world.projectId,
        projectVersionId: directed.version.id, variantId: '9:16', format: '9:16', outputArtifactId,
        outputManifestId, originalFileName: 'controlled-proxy.mp4', createdAt: reviewTime,
        recipeParameters, ocrReceipt, lease: { owner: 'w65-controlled-worker',
          attempt: controlledOperation.attempt, now: new Date().toISOString() },
        review: controlledReview,
      }), /lease/i)
      await assert.rejects(attach(null), /receipt|recipe/i)
      await assert.rejects(attach({ ...ocrReceipt, envelopeHash: '0'.repeat(64) }), /receipt|recipe/i)
      await db.v2MediaArtifact.update({ where: { id: outputArtifactId },
        data: { sha256: 'e'.repeat(64) } })
      await assert.rejects(attach(), /receipt|recipe/i)
      await db.v2MediaArtifact.update({ where: { id: outputArtifactId },
        data: { sha256: 'd'.repeat(64) } })
      await db.v2Project.update({ where: { id: world.projectId },
        data: { currentVersionId: world.versionId } })
      await assert.rejects(attach(), /current|version/i)
      await db.v2Project.update({ where: { id: world.projectId },
        data: { currentVersionId: directed.version.id } })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 6 } })
      await assert.rejects(attach(), /rights|blocked/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: world.rightsId, rightsRevision: 7 } })
      await pointRunAt(anotherTimeMapSnapshot.id)
      try { await assert.rejects(attach(), /changed|evidence|time.map/i) } finally { await pointRunAt(originalPerception.id) }
      await db.v2PublicOperation.update({ where: { id: proxyOperationId },
        data: { leaseOwner: 'w65-takeover-worker' } })
      await assert.rejects(attach(), /lease/i)
      await db.v2PublicOperation.update({ where: { id: proxyOperationId },
        data: { leaseOwner: 'w65-controlled-worker' } })
      await assert.rejects(proxy.attachCompletedOutput({
        workspaceId, operationId: proxyOperationId, projectId: world.projectId,
        projectVersionId: directed.version.id, variantId: '9:16', format: '9:16',
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4',
        createdAt: reviewTime, recipeParameters, ocrReceipt,
        lease: { owner: 'w65-controlled-worker', attempt: controlledOperation.attempt + 1,
          now: new Date().toISOString() }, review: controlledReview,
      }), /lease/i)
      const inspect = PrismaAutomaticCatalogRepository.prototype.inspect
      PrismaAutomaticCatalogRepository.prototype.inspect = async () => {
        throw new Error('W65_CONTROLLED_CATALOG_ROLLBACK')
      }
      try { await assert.rejects(attach(), /W65_CONTROLLED_CATALOG_ROLLBACK/) }
      finally { PrismaAutomaticCatalogRepository.prototype.inspect = inspect }
      assert.equal(await db.v2ProjectMediaAsset.count({ where: { projectId: world.projectId,
        artifactId: outputArtifactId, role: 'editorial-proxy' } }), 0)
      assert.equal(await db.v2ProxyReview.count({ where: { operationId: proxyOperationId } }), 0)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({
        where: { id: proxyOperationId } })).status, 'running')
      await attach()
      assert.ok(await db.v2ProjectMediaAsset.findFirst({ where: { workspaceId,
        projectId: world.projectId, artifactId: outputArtifactId, role: 'editorial-proxy' } }))
      const finalized = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: proxyOperationId } })
      assert.equal(finalized.status, 'succeeded')
      assert.equal(finalized.phase, 'completed')
      assert.equal(finalized.attempt, controlledOperation.attempt)
      assert.equal((await db.v2ProxyReview.findUniqueOrThrow({
        where: { operationId: proxyOperationId } })).status, 'blocked')
      const catalogBeforeReplay = await db.v2AutomaticCatalogRecord.count({
        where: { workspaceId, artifactId: outputArtifactId } })
      await attach()
      assert.equal(await db.v2ProjectMediaAsset.count({ where: { projectId: world.projectId,
        artifactId: outputArtifactId, role: 'editorial-proxy' } }), 1)
      assert.equal(await db.v2AutomaticCatalogRecord.count({
        where: { workspaceId, artifactId: outputArtifactId } }), catalogBeforeReplay)
      await assert.rejects(proxy.attachCompletedOutput({
        workspaceId, operationId: proxyOperationId, projectId: world.projectId,
        projectVersionId: world.versionId, variantId: '9:16', format: '9:16',
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4',
        createdAt: reviewTime, recipeParameters, ocrReceipt,
        lease: { owner: 'w65-controlled-worker', attempt: controlledOperation.attempt,
          now: new Date().toISOString() }, review: controlledReview,
      }), /replay identity/i)
      const stored = await db.v2ProjectSnapshot.findUniqueOrThrow({
        where: { id: directed.command.payload.snapshotRefs.perception } })
      assert.equal(stored.schemaVersion, 2)
      assert.equal(calculateCanonicalHash(JSON.parse(stored.contentJson)), stored.contentHash)
      assert.equal((await run(request)).replayed, true)
      // A stored perception snapshot whose hash is not its content's: stored beside the original (the original's hash is immutable)
      // and pointed at by the run, which the replay must refuse.
      const forgedHash = await db.v2ProjectSnapshot.create({ data: { id: `w64-forged-hash-${suffix}`,
        workspaceId, projectId: world.projectId, kind: stored.kind, schemaVersion: stored.schemaVersion,
        contentJson: stored.contentJson, contentHash: 'f'.repeat(64), createdAt: stored.createdAt } })
      await pointRunAt(forgedHash.id)
      try { await assert.rejects(run(request), /hash|snapshot|invalid/i) } finally { await pointRunAt(stored.id) }
      assert.equal(row.projectVersionId, directed.version.parentVersionId)
      assert.equal((await director.readContext({ workspaceId, projectId: world.projectId })).ocrEnvelope,
        undefined, 'OCR from parent version must not flow to a later version')

      await stopRunner(runner)
      runner = undefined

      // Two real PostgreSQL clients contend for the same operation row after a
      // controlled render checkpoint. A third one holds an explicit row lock
      // until both contenders are observed waiting; no timer chooses a winner.
      // This is a persistence race proof, not an additional rendered MP4.
      const raceId = `w65-race-operation-${suffix}`
      const raceArtifactId = `w65-race-output-${suffix}`
      const raceManifestId = `w65-race-manifest-${suffix}`
      const raceInputHash = sha(Buffer.from(raceId))
      const raceKey = `${workspaceId}/controlled-race-proxy.mp4`
      const raceParameters = { ...recipeParameters, inputHash: raceInputHash }
      const raceManifest = createMediaArtifactManifestV2({
        artifactKey: raceKey, artifactSha256: 'd'.repeat(64), byteSize: 1024,
        mediaType: 'video', container: 'mp4',
        recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
          parameters: raceParameters },
        sources: [{ artifactKey, sha256: world.sourceSha256, role: 'source-master',
          execution: { tool: { id: 'ffmpeg', version: 'static', digest: 'f'.repeat(64) } } }],
      })
      await db.v2MediaArtifact.create({ data: { id: raceArtifactId, workspaceId,
        artifactKey: raceKey, sha256: 'd'.repeat(64), byteSize: 1024n,
        mediaType: 'video', container: 'mp4', status: 'available' } })
      await db.v2MediaArtifactManifest.create({ data: { id: raceManifestId,
        workspaceId, artifactId: raceArtifactId,
        schemaVersion: raceManifest.schemaVersion,
        manifestHash: raceManifest.manifestHash,
        recipeId: raceManifest.recipe.id,
        recipeVersion: raceManifest.recipe.version,
        parametersHash: raceManifest.recipe.parametersHash,
        manifestJson: stableSerialize(raceManifest) } })
      const raceOperation = controlledRunningProxyOperation({ id: raceId,
        workspaceId, projectId: world.projectId, clientId: world.clientId,
        artifactId: raceArtifactId, manifestId: raceManifestId, now: Date.now() })
      const raceOperationData = { ...operationData, id: raceId, targetId: raceArtifactId,
        status: raceOperation.status, phase: raceOperation.phase,
        progressCompleted: raceOperation.progress.completed,
        progressTotal: raceOperation.progress.total,
        progressUnit: raceOperation.progress.unit,
        cancelable: raceOperation.cancelable, retryable: raceOperation.retryable,
        attempt: raceOperation.attempt, maxAttempts: raceOperation.maxAttempts,
        idempotencyKey: `w65-race-${suffix}`, requestFingerprint: raceInputHash,
        createdAt: new Date(raceOperation.createdAt),
        startedAt: new Date(raceOperation.startedAt),
        updatedAt: new Date(raceOperation.updatedAt),
        heartbeatAt: new Date(raceOperation.updatedAt),
        leaseExpiresAt: new Date(Date.now() + 120_000) }
      const raceDetailData = { ...detailData, operationId: raceId,
        inputHash: raceInputHash, outputArtifactId: raceArtifactId,
        outputManifestId: raceManifestId, originalFileName: 'controlled-race-proxy.mp4' }
      assertControlledProxyRowHydrates(raceOperationData, raceDetailData,
        proxyAudit.contextHash)
      await db.v2PublicOperation.create({ data: raceOperationData })
      await db.v2ProjectProxyRenderOperation.create({ data: raceDetailData })
      await db.v2Project.update({ where: { id: world.projectId },
        data: { status: 'rendering-proxy' } })
      const raceReviewBase = { ...controlledReview }
      delete raceReviewBase.reviewHash
      const raceReviewTime = new Date().toISOString()
      const raceReviewBody = { ...raceReviewBase, proxyArtifactId: raceArtifactId,
        proxyManifestId: raceManifestId, inputHash: raceInputHash,
        renderCompletedAt: raceReviewTime,
        timeToFirstProxyMs: Date.parse(raceReviewTime) -
          Date.parse(raceReviewBase.uploadReceivedAt) }
      const raceReview = Object.freeze({ ...raceReviewBody,
        reviewHash: calculateProxyReviewHash(raceReviewBody) })
      const attachEndpoint = isolatedDbEndpoint(`attach-${suffix}`)
      const cancelEndpoint = isolatedDbEndpoint(`cancel-${suffix}`)
      const latchEndpoint = isolatedDbEndpoint(`latch-${suffix}`)
      const attachName = attachEndpoint.applicationName
      const cancelName = cancelEndpoint.applicationName
      const controller = new PrismaClient({ datasources: { db: {
        url: latchEndpoint.url } } })
      const attachClient = new PrismaClient({ datasources: { db: {
        url: attachEndpoint.url } } })
      const cancelClient = new PrismaClient({ datasources: { db: {
        url: cancelEndpoint.url } } })
      let raceFailure
      try {
        await Promise.all([controller.$connect(), attachClient.$connect(),
          cancelClient.$connect()])
        await Promise.all([controller.$queryRaw`SELECT 1`,
          attachClient.$queryRaw`SELECT 1`, cancelClient.$queryRaw`SELECT 1`])
        const raced = await raceAtOperationLock({ controller, operationId: raceId,
          attachName, cancelName,
          attach: () => new PrismaProjectProxyRenderRepository(attachClient).attachCompletedOutput({
            workspaceId, operationId: raceId, projectId: world.projectId,
            projectVersionId: directed.version.id, variantId: '9:16', format: '9:16',
            outputArtifactId: raceArtifactId, outputManifestId: raceManifestId,
            originalFileName: 'controlled-race-proxy.mp4',
            createdAt: raceReviewTime, recipeParameters: raceParameters,
            ocrReceipt, lease: { owner: 'w65-controlled-worker',
              attempt: raceOperation.attempt, now: new Date().toISOString() },
            review: raceReview,
          }),
          cancel: () => new PrismaPublicOperationRepository(cancelClient).cancel({
            workspaceId, operationId: raceId,
            commandId: `w65-race-cancel-${suffix}`,
            authenticationAudit: proxyAudit, canceledAt: new Date().toISOString(),
          }),
        })
        const raceFinal = await db.v2PublicOperation.findUniqueOrThrow({
          where: { id: raceId } })
        const raceLinks = await db.v2ProjectMediaAsset.count({ where: {
          workspaceId, projectId: world.projectId, artifactId: raceArtifactId,
          role: 'editorial-proxy' } })
        const raceReviews = await db.v2ProxyReview.count({ where: {
          workspaceId, operationId: raceId } })
        if (raceFinal.status === 'succeeded') {
          assert.equal(raced.attach.status, 'fulfilled')
          assert.equal(raced.cancel.status, 'fulfilled')
          assert.equal(raced.cancel.value.operation.status, 'succeeded')
          assert.equal(raceLinks, 1)
          assert.equal(raceReviews, 1)
        } else {
          assert.equal(raceFinal.status, 'canceled')
          assert.equal(raced.attach.status, 'rejected')
          assert.equal(raced.cancel.status, 'fulfilled')
          assert.equal(raced.cancel.value.operation.status, 'canceled')
          assert.equal(raceLinks, 0)
          assert.equal(raceReviews, 0)
        }
        assert.ok(['succeeded', 'canceled'].includes(raceFinal.status))
        console.log(`W65 controlled PostgreSQL attach/cancel winner: ${raceFinal.status}`)
      } catch (error) {
        raceFailure = error
        throw error
      } finally {
        const disconnected = await Promise.allSettled([controller.$disconnect(),
          attachClient.$disconnect(), cancelClient.$disconnect()])
        const failures = disconnected.filter((result) => result.status === 'rejected')
          .map((result) => result.reason)
        if (failures.length) throw new AggregateError(
          raceFailure ? [raceFailure, ...failures] : failures,
          'W65 PostgreSQL race clients did not disconnect cleanly',
        )
      }

      // Two further controlled rows exercise an observed cancel-first lock queue
      // and an actual expired-lease reclaim. They use the same sealed source and
      // review shape; each output has a distinct artifact/manifest/operation.
      const expiryCompiled = await compileRenderable(directed.version.id, { ...JSON.parse(directedEdit.contentJson),
        id: `proxy-expiry-plan-${suffix}`, formatVariantRefs: ['9:16'] },
      `controlled-expiry-playback-${suffix}`, sha(Buffer.from(`expiry-${suffix}`)))
      const expiryPlan = expiryCompiled.plan, expirySnapshot = expiryCompiled.snapshot, expiryVersion = expiryCompiled.version
      assert.equal(expiryVersion.parentVersionId, directed.version.id)
      // The compile moved the head to the Version that holds the plan. The project-mode rows below are authorized against the
      // Director result, so the head goes back to it (a pointer only: no Version is created before the manual Commands, which
      // continue from the expiry Version - a Version's sequence is unique in a project, so the head only moves forward from there).
      await db.v2Project.update({ where: { id: world.projectId }, data: { currentVersionId: directed.version.id } })

      async function seedOrderedRace(label, expiredLease = false, snapshotMode = false) {
        const id = `w65-${label}-operation-${suffix}`
        const artifactId = `w65-${label}-output-${suffix}`
        const manifestId = `w65-${label}-manifest-${suffix}`
        const key = `${workspaceId}/controlled-${label}-proxy.mp4`
        const hash = sha(Buffer.from(id))
        const parameters = { ...recipeParameters, inputHash: hash,
          ...(snapshotMode ? { ocrReceipt: null, projectVersionId: expiryVersion.id,
            editPlanSnapshotId: expiryVersion.editPlanSnapshotId } : {}) }
        const manifest = createMediaArtifactManifestV2({
          artifactKey: key, artifactSha256: 'd'.repeat(64), byteSize: 1024,
          mediaType: 'video', container: 'mp4',
          recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
            parameters },
          sources: [{ artifactKey, sha256: world.sourceSha256, role: 'source-master',
            execution: { tool: { id: 'ffmpeg', version: 'static', digest: 'f'.repeat(64) } } }],
        })
        await db.v2MediaArtifact.create({ data: { id: artifactId, workspaceId,
          artifactKey: key, sha256: 'd'.repeat(64), byteSize: 1024n,
          mediaType: 'video', container: 'mp4', status: 'available' } })
        await db.v2MediaArtifactManifest.create({ data: { id: manifestId,
          workspaceId, artifactId, schemaVersion: manifest.schemaVersion,
          manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id,
          recipeVersion: manifest.recipe.version,
          parametersHash: manifest.recipe.parametersHash,
          manifestJson: stableSerialize(manifest) } })
        const running = controlledRunningProxyOperation({ id, workspaceId,
          projectId: world.projectId, clientId: world.clientId,
          artifactId, manifestId, now: Date.now() })
        const publicRow = { ...raceOperationData, id, targetId: artifactId,
          requestFingerprint: hash, idempotencyKey: `w65-${label}-${suffix}`,
          createdAt: new Date(running.createdAt), startedAt: new Date(running.startedAt),
          updatedAt: new Date(running.updatedAt), heartbeatAt: new Date(running.updatedAt),
          leaseExpiresAt: new Date(Date.now() + (expiredLease ? -500 : 120_000)) }
        const detailRow = { ...raceDetailData, operationId: id, inputHash: hash,
          outputArtifactId: artifactId, outputManifestId: manifestId,
          originalFileName: `controlled-${label}-proxy.mp4`,
          ...(snapshotMode ? { projectVersionId: expiryVersion.id, editPlanSnapshotId: expiryVersion.editPlanSnapshotId,
            renderablePlanId: expiryPlan.id, renderablePlanHash: expirySnapshot.planHash,
            renderableOrigin: expirySnapshot.origin, renderableSourceId: expirySnapshot.sourceId,
            renderableSourceHash: expirySnapshot.sourceHash, renderableVariantId: '9:16', renderableFormat: '9:16' } : {}) }
        assertControlledProxyRowHydrates(publicRow, detailRow, proxyAudit.contextHash)
        await db.v2PublicOperation.create({ data: publicRow })
        await db.v2ProjectProxyRenderOperation.create({ data: detailRow })
        await db.v2Project.update({ where: { id: world.projectId },
          data: { status: 'rendering-proxy' } })
        const finishedAt = new Date().toISOString()
        const base = { ...controlledReview }
        delete base.reviewHash
        const reviewBody = { ...base, proxyArtifactId: artifactId,
          proxyManifestId: manifestId, inputHash: hash,
          ...(snapshotMode ? { projectVersionId: expiryVersion.id, editPlanHash: expirySnapshot.planHash } : {}),
          renderCompletedAt: finishedAt,
          timeToFirstProxyMs: Date.parse(finishedAt) - Date.parse(base.uploadReceivedAt) }
        const review = Object.freeze({ ...reviewBody,
          reviewHash: calculateProxyReviewHash(reviewBody) })
        return { id, artifactId, manifestId, parameters, review, running,
          attach: (client) => new PrismaProjectProxyRenderRepository(client)[snapshotMode
            ? 'attachCompletedSnapshotOutput' : 'attachCompletedOutput']({
            workspaceId, operationId: id, projectId: world.projectId,
            projectVersionId: snapshotMode ? expiryVersion.id : directed.version.id, variantId: '9:16', ...(snapshotMode ? {} : { format: '9:16' }),
            outputArtifactId: artifactId, outputManifestId: manifestId,
            originalFileName: `controlled-${label}-proxy.mp4`,
            createdAt: finishedAt, recipeParameters: parameters,
            ocrReceipt: snapshotMode ? null : ocrReceipt, lease: { owner: 'w65-controlled-worker',
              attempt: running.attempt, now: new Date().toISOString() }, review,
          }) }
      }

      // Observe an actual SQL lock wait, then the database clock crossing the
      // rights deadline. No sleeping heuristic substitutes for either observation.
      for (const [snapshotMode, rightsChange] of [[false, 'expiry'], [true, 'expiry'], [false, 'revoke'], [true, 'revoke']]) {
        const label = `${snapshotMode ? 'snapshot' : 'project'}-rights-${rightsChange}`
        const candidate = await seedOrderedRace(label, false, snapshotMode)
        const latchEndpoint = isolatedDbEndpoint(`latch-exp-${Number(snapshotMode)}-${suffix}`)
        const attachEndpoint = isolatedDbEndpoint(`attach-exp-${Number(snapshotMode)}-${suffix}`)
        const latchClient = new PrismaClient({ datasources: { db: { url: latchEndpoint.url } } })
        const workerClient = new PrismaClient({ datasources: { db: { url: attachEndpoint.url } } })
        let latchFailure, attachResult, latch
        let readyResolve, readyReject, gatesResolve, gatesReject, release
        const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
        const gates = new Promise((resolve, reject) => { gatesResolve = resolve; gatesReject = reject })
        gates.catch(() => {})
        const released = new Promise((resolve) => { release = resolve })
        try {
          await Promise.all([latchClient.$connect(), workerClient.$connect()])
          const [clock] = await db.$queryRaw`SELECT clock_timestamp() AS now`
          const expiring = await installRights(world.sourceId, rightsChange === 'expiry' ? {
            expiresAt: new Date(clock.now.getTime() + 2_000).toISOString() } : {})
          const before = snapshotMode
            ? await proxy.readRenderableSnapshotSource({ workspaceId, projectId: world.projectId,
              planId: expiryPlan.id, planHash: expirySnapshot.planHash, format: '9:16' })
            : await proxy.readCurrentSource({ workspaceId, projectId: world.projectId })
          assert.ok(before, 'rights must allow hydration before the observed wait')
          latch = latchClient.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM public_operations WHERE id = ${candidate.id} FOR UPDATE`
            readyResolve()
            const deadline = Date.now() + 5_000
            let sawWait = false, rightsChanged = false
            while (Date.now() < deadline) {
              await tx.$queryRaw`SELECT pg_stat_clear_snapshot() IS NULL AS cleared`
              const waiting = await tx.$queryRaw`SELECT wait_event_type AS "waitType" FROM pg_stat_activity
                WHERE application_name = ${attachEndpoint.applicationName}`
              sawWait ||= waiting.some((row) => row.waitType === 'Lock')
              if (rightsChange === 'expiry') {
                const [observed] = await tx.$queryRaw`SELECT clock_timestamp() AS now`
                rightsChanged = observed.now.getTime() >= Date.parse(expiring.expiresAt)
              } else if (sawWait && !rightsChanged) {
                const revoked = await installRights(world.sourceId, { status: 'revoked' })
                const current = await db.v2MediaArtifact.findUniqueOrThrow({ where: { id: world.sourceId } })
                rightsChanged = current.currentRightsSnapshotId === revoked.id
              }
              if (sawWait && rightsChanged) break
              await new Promise((resolve) => setTimeout(resolve, 25))
            }
            assert.ok(sawWait, 'worker must be observed waiting on PostgreSQL')
            assert.ok(rightsChanged, 'rights expiry/revocation must be observed before releasing worker')
            gatesResolve()
            await released
          }, { timeout: 8_000 }).catch((error) => { readyReject(error); gatesReject(error); throw error })
          latch.catch(() => {})
          await ready
          attachResult = candidate.attach(workerClient).then((value) => ({ value }), (error) => ({ error }))
          await gates
          release()
          await latch
          const outcome = await attachResult
          const safeDiagnosticText = (value) => value === undefined || value === null ? null : String(value)
            .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted database URL]')
            .replace(/[\r\n\t]+/g, ' ').slice(0, 800)
          const outcomeDiagnostic = JSON.stringify({ label,
            path: snapshotMode ? 'snapshot' : 'project', rightsChange,
            unexpectedPublication: !outcome.error, error: outcome.error ? {
              name: safeDiagnosticText(outcome.error.name), code: safeDiagnosticText(outcome.error.code),
              message: safeDiagnosticText(outcome.error.message),
              meta: { code: safeDiagnosticText(outcome.error.meta?.code) },
            } : null })
          assert.ok(outcome.error, outcomeDiagnostic)
          assert.equal(outcome.error.code, 'ASSET_RIGHTS_BLOCKED', outcomeDiagnostic)
          assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: candidate.id } })).status, 'running')
          assert.equal(await db.v2ProjectMediaAsset.count({ where: { artifactId: candidate.artifactId, role: 'editorial-proxy' } }), 0)
          assert.equal(await db.v2ProxyReview.count({ where: { operationId: candidate.id } }), 0)
          assert.equal(await db.v2AutomaticCatalogRecord.count({ where: { artifactId: candidate.artifactId } }), 0)
        } catch (error) { latchFailure = error; throw error } finally {
          release()
          await Promise.allSettled([latch, attachResult].filter(Boolean))
          const failures = []
          try {
            await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: world.rightsId } })
          } catch (error) { failures.push(error) } finally {
            const disconnected = await Promise.allSettled([latchClient.$disconnect(), workerClient.$disconnect()])
            failures.push(...disconnected.filter((r) => r.status === 'rejected').map((r) => r.reason))
          }
          if (failures.length) throw new AggregateError(latchFailure ? [latchFailure, ...failures] : failures,
            'Rights PostgreSQL latch cleanup did not complete cleanly')
        }
      }

      for (const scenario of ['cancel-first', 'takeover']) {
        const candidate = await seedOrderedRace(scenario, scenario === 'takeover')
        const latchEndpoint = orderedRaceEndpoint('latch', scenario, suffix)
        const attachEndpoint = orderedRaceEndpoint('attach', scenario, suffix)
        const controlEndpoint = orderedRaceEndpoint('control', scenario, suffix)
        const latchClient = new PrismaClient({ datasources: { db: { url: latchEndpoint.url } } })
        const oldWorker = new PrismaClient({ datasources: { db: { url: attachEndpoint.url } } })
        const controllerClient = new PrismaClient({ datasources: { db: { url: controlEndpoint.url } } })
        let scenarioFailure
        try {
          await Promise.all([latchClient.$connect(), oldWorker.$connect(),
            controllerClient.$connect()])
          await Promise.all([latchClient.$queryRaw`SELECT 1`,
            oldWorker.$queryRaw`SELECT 1`, controllerClient.$queryRaw`SELECT 1`])
          const outcome = await raceAtOperationLock({ controller: latchClient,
            operationId: candidate.id, attachName: attachEndpoint.applicationName,
            cancelName: controlEndpoint.applicationName, orderedFirst: 'cancel',
            attach: () => candidate.attach(oldWorker),
            cancel: scenario === 'cancel-first'
              ? () => new PrismaPublicOperationRepository(controllerClient).cancel({
                workspaceId, operationId: candidate.id,
                commandId: `w65-cancel-first-${suffix}`,
                authenticationAudit: proxyAudit, canceledAt: new Date().toISOString(),
              })
              : () => new PrismaPublicOperationRepository(controllerClient).claimNext({
                workspaceId, operationId: candidate.id, type: 'project-proxy-render',
                leaseOwner: `w65-new-worker-${suffix}`, now: new Date().toISOString(),
                leaseUntil: new Date(Date.now() + 120_000).toISOString(),
              }),
          })
          const final = await db.v2PublicOperation.findUniqueOrThrow({
            where: { id: candidate.id } })
          assert.equal(outcome.cancel.status, 'fulfilled')
          assert.equal(outcome.attach.status, 'rejected')
          if (scenario === 'cancel-first') {
            assert.equal(final.status, 'canceled')
            assert.equal(outcome.cancel.value.operation.status, 'canceled')
          } else {
            assert.equal(final.status, 'running')
            assert.equal(final.attempt, candidate.running.attempt + 1)
            assert.equal(final.leaseOwner, `w65-new-worker-${suffix}`)
            assert.equal(outcome.cancel.value.operation.attempt, final.attempt)
          }
          assert.equal(await db.v2ProjectMediaAsset.count({ where: {
            workspaceId, projectId: world.projectId, artifactId: candidate.artifactId,
            role: 'editorial-proxy' } }), 0)
          assert.equal(await db.v2ProxyReview.count({ where: {
            workspaceId, operationId: candidate.id } }), 0)
          assert.equal(await db.v2AutomaticCatalogRecord.count({ where: {
            workspaceId, artifactId: candidate.artifactId } }), 0)
          console.log(`W65 observed PostgreSQL ${scenario}: ${final.status}, attempt ${final.attempt}`)
        } catch (error) { scenarioFailure = error; throw error } finally {
          const disconnected = await Promise.allSettled([latchClient.$disconnect(),
            oldWorker.$disconnect(), controllerClient.$disconnect()])
          const failures = disconnected.filter((result) => result.status === 'rejected')
            .map((result) => result.reason)
          if (failures.length) throw new AggregateError(
            scenarioFailure ? [scenarioFailure, ...failures] : failures,
            `W65 ${scenario} PostgreSQL clients did not disconnect cleanly`)
        }
      }

      // Inline reuse completes without a worker. Its rights fence is a separate
      // transaction from the already committed manual Command/Version below.
      await db.v2Project.update({ where: { id: world.projectId }, data: { currentVersionId: expiryVersion.id } })
      const manualRepository = new PrismaManualEditRepository(db)
      for (const rightsChange of ['allow', 'revoke', 'expiry']) {
        await installRights(world.sourceId)
        const previousContext = await manualRepository.readContext({ workspaceId, projectId: world.projectId })
        assert.ok(previousContext)
        const ownBaseClip = previousContext.editPlan.videoTracks.find((track) => track.kind === 'base-video').clips[0].id
        // A real selection Command allocates this fixture's own immutable base.
        // Its input hash is unchanged semantics under a NEW version identity, never salted to evade uniqueness.
        const ownBase = await applyManualEditService({ repository: manualRepository, clock: () => new Date(),
          createId: (kind) => kind + '-' + randomUUID(), createEventId: randomUUID })({
          workspaceId, projectId: world.projectId, baseVersionId: previousContext.version.id,
          baseHash: previousContext.version.baseHash, expectedRevision: previousContext.version.sequence,
          action: 'apply', variantId: '9:16', targetId: ownBaseClip, operation: { kind: 'select', clipId: ownBaseClip },
          actor, idempotencyKey: 'inline-owned-base-command-' + rightsChange + '-' + suffix })
        const baseContext = await manualRepository.readContext({ workspaceId, projectId: world.projectId })
        assert.equal(baseContext?.version.id, ownBase.version.id)
        assert.equal(await db.v2ProjectProxyRenderOperation.count({ where: { workspaceId, projectVersionId: ownBase.version.id } }), 0)
        assert.ok(baseContext)
        const baseSource = hydrateProxySource(await queryProxySourceProject(db, {
          workspaceId, projectId: world.projectId, projectVersionId: baseContext.version.id,
          editPlanSnapshotId: baseContext.version.snapshotRefs.editPlan }))
        assert.ok(baseSource)
        const id = 'inline-base-' + rightsChange + '-' + suffix
        const artifactId = id + '-output', manifestId = id + '-manifest'
        const key = workspaceId + '/metadata-only-' + id + '.mp4'
        const proxyHash = sha(Buffer.from('metadata-only:' + id))
        const bindings = JSON.parse(detailData.colorPipelineBindingsJson)
        const baseInputHash = projectProxyRenderInputHash({ source: baseSource, colorPipelineBindings: bindings })
        assert.equal(await db.v2ProjectProxyRenderOperation.count({ where: { workspaceId,
          projectVersionId: baseContext.version.id, inputHash: baseInputHash } }), 0,
        'the owned base has no existing canonical detail; content/input hashes are not salted')
        const rendererDigest = sha(Buffer.from('apollo-v2-ffmpeg-editorial/' + FFMPEG_EDITORIAL_RENDERER_VERSION))
        const manifest = createMediaArtifactManifestV2({
          artifactKey: key, artifactSha256: proxyHash, byteSize: 1024, mediaType: 'video', container: 'mp4',
          recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
            parameters: { inputHash: baseInputHash, fixtureScope: 'metadata-only-inline-rights-fence' } },
          sources: baseSource.renderSources.map((source) => ({ artifactKey: source.artifactKey,
            sha256: source.sha256, role: source.role,
            execution: { tool: { id: 'ffmpeg', version: 'declared-controlled', digest: rendererDigest } } })),
        })
        const map = buildRenderElementMap({ proxyHash, fps: baseSource.editPlan.fps,
          durationFrames: baseSource.editPlan.durationFrames, canvas: { width: 540, height: 960 },
          source: { width: 640, height: 360 },
          clips: baseSource.editPlan.videoTracks.filter((track) => track.kind === 'base-video').flatMap((track) => track.clips),
          subtitleCues: [], ctaOverlays: [] })
        const now = new Date().toISOString()
        const baseCompleted = succeedPublicOperation(controlledRunningProxyOperation({ id, workspaceId,
          projectId: world.projectId, clientId: world.clientId, artifactId, manifestId, now: Date.now() }), now)
        await db.v2MediaArtifact.create({ data: { id: artifactId, workspaceId, artifactKey: key,
          sha256: proxyHash, byteSize: 1024n, mediaType: 'video', container: 'mp4', status: 'available' } })
        await db.v2MediaArtifactManifest.create({ data: { id: manifestId, workspaceId, artifactId,
          schemaVersion: manifest.schemaVersion, manifestHash: manifest.manifestHash,
          recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version,
          parametersHash: manifest.recipe.parametersHash, manifestJson: stableSerialize(manifest) } })
        await db.v2PublicOperation.create({ data: { ...operationData, id, status: baseCompleted.status,
          phase: baseCompleted.phase, targetId: artifactId, progressCompleted: baseCompleted.progress.completed,
          progressTotal: baseCompleted.progress.total, progressUnit: baseCompleted.progress.unit,
          cancelable: baseCompleted.cancelable, retryable: baseCompleted.retryable,
          resultJson: stableSerialize(baseCompleted.result), idempotencyKey: id, requestFingerprint: baseInputHash,
          createdAt: new Date(baseCompleted.createdAt), startedAt: new Date(baseCompleted.startedAt),
          updatedAt: new Date(baseCompleted.updatedAt), completedAt: new Date(baseCompleted.completedAt),
          leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null } })
        await db.v2ProjectProxyRenderOperation.create({ data: { ...detailData, operationId: id,
          projectVersionId: baseContext.version.id, editPlanSnapshotId: baseContext.version.snapshotRefs.editPlan,
          inputHash: baseInputHash, outputArtifactId: artifactId, outputManifestId: manifestId } })
        await db.v2RenderElementMap.create({ data: { id: randomUUID(), workspaceId, projectId: world.projectId,
          projectVersionId: baseContext.version.id, proxyArtifactId: artifactId, schemaVersion: map.schemaVersion,
          proxyHash, mapHash: renderElementMapHash(map), fps: map.fps, durationFrames: map.durationFrames,
          canvasWidth: map.canvas.width, canvasHeight: map.canvas.height,
          elementsJson: JSON.stringify(map.elements), createdAt: new Date(now) } })
        const clipId = baseSource.editPlan.videoTracks.find((track) => track.kind === 'base-video').clips[0].id
        const child = await applyManualEditService({ repository: manualRepository, clock: () => new Date(),
          createId: (kind) => kind + '-' + randomUUID(), createEventId: randomUUID })({
          workspaceId, projectId: world.projectId, baseVersionId: baseContext.version.id,
          baseHash: baseContext.version.baseHash, expectedRevision: baseContext.version.sequence,
          action: 'apply', variantId: '9:16', targetId: clipId, operation: { kind: 'select', clipId },
          actor, idempotencyKey: 'inline-command-' + rightsChange + '-' + suffix })
        assert.equal(child.impact.renderSemanticsChanged, false)
        assert.deepEqual(child.impact.minimalRenders, [])
        assert.deepEqual(child.impact.affectedVariantIds, [])
        assert.deepEqual(child.impact.affectedArtifacts, [])
        const candidateId = 'inline-child-' + rightsChange + '-' + suffix
        const candidateTime = new Date().toISOString()
        const candidateOperation = succeedPublicOperation(advancePublicOperationPhase(startPublicOperationAttempt(
          createQueuedPublicOperation({ id: candidateId, workspaceId, projectId: world.projectId, clientId: world.clientId,
            type: 'project-proxy-render', target: { type: 'media-artifact', id: artifactId, manifestId },
            createdAt: candidateTime }), candidateTime), 'persisting', candidateTime), candidateTime)
        const candidateInput = { operation: candidateOperation, authenticationAudit: proxyAudit,
          idempotencyKey: candidateId, requestFingerprint: sha(Buffer.from(candidateId)),
          context: { kind: 'project-proxy-reuse', projectId: world.projectId,
            projectVersionId: child.version.id, editPlanSnapshotId: child.version.snapshotRefs.editPlan,
            commandId: child.command.id, impactHash: child.impact.impactHash,
            baseVersionId: baseContext.version.id, reusedFromOperationId: id,
            sourceArtifactId: baseSource.sourceArtifactId, sourceManifestId: baseSource.sourceManifestId,
            inputHash: projectProxyRenderInputHash({ source: hydrateProxySource(await queryProxySourceProject(db, {
              workspaceId, projectId: world.projectId, projectVersionId: child.version.id,
              editPlanSnapshotId: child.version.snapshotRefs.editPlan })), colorPipelineBindings: [] }),
            outputArtifactId: artifactId, outputManifestId: manifestId, originalFileName: 'metadata-only-inline.mp4' } }
        const baseline = async () => ({
          project: await db.v2Project.findUniqueOrThrow({ where: { id: world.projectId },
            select: { currentVersionId: true, status: true } }),
          operations: await db.v2PublicOperation.count({ where: { workspaceId } }),
          details: await db.v2ProjectProxyRenderOperation.count({ where: { workspaceId } }),
          maps: await db.v2RenderElementMap.count({ where: { workspaceId } }),
          outbox: await db.v2PublicEventOutbox.count({ where: { workspaceId } }),
        })
        const before = await baseline()
        assert.equal(before.project.currentVersionId, child.version.id)
        if (rightsChange === 'allow') {
          const admitted = await new PrismaPublicOperationRepository(db).createOrReplay(candidateInput)
          assert.equal(admitted.operation.status, 'succeeded')
          const copied = await db.v2RenderElementMap.findFirstOrThrow({ where: { workspaceId,
            projectVersionId: child.version.id, proxyArtifactId: artifactId } })
          assert.equal(copied.mapHash, renderElementMapHash(map))
          assert.equal(copied.elementsJson, JSON.stringify(map.elements))
          const after = await baseline()
          assert.equal((await new PrismaPublicOperationRepository(db).createOrReplay(candidateInput)).replayed, true)
          assert.deepEqual(await baseline(), after, 'inline replay cannot duplicate operations or maps')
          assert.equal(await db.v2ProxyReview.count({ where: { workspaceId, operationId: candidateId } }), 0,
            'inline reuse cannot copy a critic decision or approval')
          console.log(JSON.stringify({ scope: 'inline-rights-TX-only', rightsChange, physicalRenderObserved: false,
            fixtureOutputs: 'controlled-metadata-only', replayObserved: true, approvalTransferred: false }))
          continue
        }
        const latchEndpoint = inlineRightsEndpoint('latch', rightsChange, suffix)
        const inlineEndpoint = inlineRightsEndpoint('admit', rightsChange, suffix)
        const latchClient = new PrismaClient({ datasources: { db: { url: latchEndpoint.url } } })
        const inlineClient = new PrismaClient({ datasources: { db: { url: inlineEndpoint.url } } })
        let resolveReady, rejectReady, release, latch, admission, failure
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
        const released = new Promise((resolve) => { release = resolve })
        try {
          await Promise.all([latchClient.$connect(), inlineClient.$connect()])
          const [clock] = await db.$queryRaw`SELECT clock_timestamp() AS now`
          const grant = await installRights(world.sourceId, rightsChange === 'expiry'
            ? { expiresAt: new Date(clock.now.getTime() + 2000).toISOString() } : {})
          latch = latchClient.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM public_operations WHERE id = ${id} FOR UPDATE`
            resolveReady()
            const deadline = Date.now() + 5000
            let waited = false, changed = false
            while (Date.now() < deadline) {
              await tx.$queryRaw`SELECT pg_stat_clear_snapshot() IS NULL AS cleared`
              const rows = await tx.$queryRaw`SELECT wait_event_type AS "waitType" FROM pg_stat_activity
                WHERE application_name = ${inlineEndpoint.applicationName}`
              waited ||= rows.some((row) => row.waitType === 'Lock')
              if (rightsChange === 'expiry') {
                const [at] = await tx.$queryRaw`SELECT clock_timestamp() AS now`
                changed = at.now.getTime() >= Date.parse(grant.expiresAt)
              } else if (waited && !changed) {
                const revoked = await installRights(world.sourceId, { status: 'revoked' })
                changed = (await db.v2MediaArtifact.findUniqueOrThrow({ where: { id: world.sourceId } }))
                  .currentRightsSnapshotId === revoked.id
              }
              if (waited && changed) break
              await new Promise((resolve) => setTimeout(resolve, 25))
            }
            assert.ok(waited, 'inline admission must be observed at a real SQL lock wait')
            assert.ok(changed, 'rights change must commit/be observed before inline release')
            release()
          }, { timeout: 8000 }).catch((error) => { rejectReady(error); release(); throw error })
          latch.catch(() => {})
          await ready
          admission = new PrismaPublicOperationRepository(inlineClient).createOrReplay(candidateInput)
            .then((value) => ({ value }), (error) => ({ error }))
          await released
          await latch
          const outcome = await admission
          const messageBytes = typeof outcome.error?.message === 'string' ? Buffer.from(outcome.error.message) : null
          const diagnostic = JSON.stringify({ scope: 'inline-rights-TX-only', rightsChange,
            unexpectedPublication: !outcome.error, name: outcome.error?.name ?? null, code: outcome.error?.code ?? null,
            sqlState: outcome.error?.meta?.code ?? null, messageSha256: messageBytes ? sha(messageBytes) : null,
            messageBytes: messageBytes?.length ?? 0 })
          assert.ok(outcome.error, diagnostic)
          assert.equal(outcome.error.code, 'ASSET_RIGHTS_BLOCKED', diagnostic)
          assert.deepEqual(await baseline(), before, 'only inline TX writes roll back; committed child head/status stay unchanged')
          assert.ok(await db.v2ProjectVersion.findUnique({ where: { id: child.version.id } }))
          assert.ok(await db.v2EditCommand.findUnique({ where: { id: child.command.id } }),
            'the earlier Command transaction remains committed after enqueue denial')
          console.log(JSON.stringify({ scope: 'inline-rights-TX-only', rightsChange, errorCode: outcome.error.code,
            priorCommandAndVersionPreserved: true, newInlineEffects: 0, physicalRenderObserved: false }))
        } catch (error) { failure = error; throw error } finally {
          release()
          await Promise.allSettled([latch, admission].filter(Boolean))
          const failures = []
          try { await db.v2MediaArtifact.update({ where: { id: world.sourceId },
            data: { currentRightsSnapshotId: world.rightsId } }) } catch (error) { failures.push(error) }
          const disconnected = await Promise.allSettled([latchClient.$disconnect(), inlineClient.$disconnect()])
          failures.push(...disconnected.filter((result) => result.status === 'rejected').map((result) => result.reason))
          if (failures.length) throw new AggregateError(failure ? [failure, ...failures] : failures,
            'Inline rights latch cleanup failed')
        }
      }

      await canonicalDirectorSnapshotOwnerPG({ db, workspaceId, projectId: world.projectId, actor })

      // ---- Rights of every referenced source, through both resolvers ----------------------------------------------------
      // The Director's plan cannot be rewritten to reference a second source (a Version's plan snapshot is append-only), so the plan
      // that does is carried by Versions born with it, on top of the final head: a child Command that adopts the second recording's
      // ingest receipt (the project resolver reads it), and the compile-renderable-plan child that is born with the renderable plan
      // (the snapshot resolver reads it). The rights are then changed under both, exactly as before: rights pointers are mutable.
      const second = await persistRecording(db, { workspaceId, projectId: world.projectId, actor: world.actor,
        slug: `w61-rights-second-${suffix}`, durationFrames: 120 })
      const secondId = second.names.sourceArtifactId
      const secondLinkId = (await db.v2ProjectMediaAsset.findFirstOrThrow({
        where: { projectId: world.projectId, artifactId: secondId, role: 'source-master' } })).id
      await db.v2ProjectMediaAsset.update({ where: { id: secondLinkId }, data: { role: 'selected-insert' } })
      const ambiguousLinkId = randomUUID()
      const withSecondAudio = (plan) => {
        const next = structuredClone(plan)
        next.formatVariantRefs = ['9:16']
        const clips = next.videoTracks.find((t) => t.kind === 'base-video').clips
        clips[0].audioSourceArtifactId = secondId
        next.audioTimelineHash = createDirectedAudioTimelineHash({ fps: next.fps, clips, musicTracks: next.audioTracks })
        return next
      }
      const rightsHead = await commitSealedChild(db, { workspaceId, projectId: world.projectId, actor: world.actor,
        suffix: `w64-${suffix}-rights-plan`, adopt: [secondId], mutatePlan: withSecondAudio })
      const rightsCompiled = await compileRenderable(rightsHead.version.id, {
        ...JSON.parse(rightsHead.editPlanSnapshot.contentJson), id: `proxy-rights-plan-${suffix}` },
      `controlled-rights-playback-${suffix}`, sha(Buffer.from(secondId)))
      const rightsPlan = rightsCompiled.plan, rightsSnapshot = rightsCompiled.snapshot
      const snapshotRequest = { workspaceId, projectId: world.projectId, planId: rightsPlan.id,
        planHash: rightsSnapshot.planHash, format: '9:16' }
      const readRightsSnapshot = () => proxy.readRenderableSnapshotSource(snapshotRequest)
      const readRightsProject = () => proxy.readImmutableSource({ workspaceId, projectId: world.projectId,
        projectVersionId: rightsHead.version.id, editPlanSnapshotId: rightsHead.editPlanSnapshot.id,
        sourceArtifactId: world.sourceId, sourceManifestId: manifestId })
      try {
        assert.ok(!JSON.parse(rightsTemplate.allowedUsesJson).includes('editorial-reuse'),
          'master fixture must match ingest rather than silently add library reuse')
        for (const [role, mediaType, use, outputRole] of [
          ['source-master', 'video', 'rendering', 'source-master'],
          ['source-audio', 'audio', 'rendering', 'source-master'],
          ['selected-insert', 'video', 'editorial-reuse', 'selected-insert'],
        ]) {
          await db.v2ProjectMediaAsset.update({ where: { id: secondLinkId }, data: { role } })
          await db.v2MediaArtifact.update({ where: { id: secondId }, data: { mediaType } })
          await installRights(secondId, { allowedUses: [use] })
          for (const read of [readRightsProject, readRightsSnapshot]) {
            assert.equal((await read()).renderSources.find((s) => s.artifactId === secondId).role, outputRole)
          }
          await installRights(secondId, { allowedUses: [use === 'rendering' ? 'editorial-reuse' : 'rendering'] })
          for (const read of [readRightsProject, readRightsSnapshot]) await assert.rejects(read(), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
        }
        await installRights(secondId, { allowedUses: ['editorial-reuse'] })
        for (const draft of [{ status: 'revoked' }, { status: 'expired' },
          { expiresAt: '2020-01-01T00:00:00Z' }, { allowedUses: ['editing'], prohibitedUses: ['rendering'] },
          { allowedLocales: ['en-US'] },
          { consent: { status: 'revoked', allowedUses: [] } }]) {
          await installRights(world.sourceId, draft)
          for (const read of [readRightsProject, readRightsSnapshot]) await assert.rejects(read(), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
        }
        await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: world.rightsId } })
        assert.equal(await proxy.readCurrentSource({ workspaceId: world.otherWorkspaceId, projectId: world.projectId }), null)
        assert.equal(await proxy.readRenderableSnapshotSource({ ...snapshotRequest, workspaceId: world.otherWorkspaceId }), null)
        await db.v2ProjectMediaAsset.create({ data: { id: ambiguousLinkId,
          workspaceId, projectId: world.projectId, artifactId: secondId,
          role: 'source-master', originalFileName: 'ambiguous-second.mp4' } })
        for (const read of [readRightsProject, readRightsSnapshot]) await assert.rejects(read(), (error) =>
          error.code === 'PERSISTENCE_CONFLICT' && /unambiguous/i.test(error.message))
        await db.v2ProjectMediaAsset.delete({ where: { id: ambiguousLinkId } })
        // editing-proxy is permitted by the DB role CHECK but cannot authorize
        // a referenced render source; exercise the reader rather than SQL 23514.
        await db.v2ProjectMediaAsset.update({ where: { id: secondLinkId }, data: { role: 'editing-proxy' } })
        for (const read of [readRightsProject, readRightsSnapshot]) await assert.rejects(read(), (error) =>
          error.code === 'PERSISTENCE_CONFLICT' && /unsupported/i.test(error.message))
      } finally {
        await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: world.rightsId } })
      }

    } catch (error) { primaryError = error } finally {
      const cleanupErrors = []
      try { await stopRunner(runner) } catch (error) { cleanupErrors.push(error) }
      if (cleanupScope) {
        const activeStatuses = ['queued', 'running', 'waiting', 'retrying']
        try {
          const audit = createApiAccessAuditContext({ clientId: cleanupScope.clientId,
            credentialId: `w64-credential-${cleanupScope.suffix}`,
            workspaceId: cleanupScope.workspaceId, environment: 'production',
            authenticationKind: 'bearer' })
          const pending = await db.v2PublicOperation.findMany({
            where: { workspaceId: cleanupScope.workspaceId,
              status: { in: activeStatuses } },
            select: { id: true, updatedAt: true, nextAttemptAt: true } })
          const operations = new PrismaPublicOperationRepository(db)
          for (const row of pending) {
            const canceledAt = new Date(Math.max(Date.now(),
              row.updatedAt.getTime(), row.nextAttemptAt?.getTime() ?? 0))
            await operations.cancel({ workspaceId: cleanupScope.workspaceId,
              operationId: row.id, commandId: `w64-cleanup-${randomUUID()}`,
              authenticationAudit: audit, canceledAt: canceledAt.toISOString() })
          }
        } catch (error) { cleanupErrors.push(error) }
        try {
          assert.equal(await db.v2PublicOperation.count({ where: {
            workspaceId: cleanupScope.workspaceId,
            status: { in: activeStatuses },
          } }), 0, 'the private workspace must have no active operations after cleanup')
        } catch (error) { cleanupErrors.push(error) }
      }
      try { await db.$disconnect() } catch (error) { cleanupErrors.push(error) }
      try {
        const scratch = await realpath(root)
        const parent = await realpath(tmpdir())
        assert.ok(scratch.startsWith(join(parent, 'apollo-w64-director-ocr-')),
          'Scratch path must stay within the owned temporary directory')
        await rm(scratch, { recursive: true, force: true })
      } catch (error) { cleanupErrors.push(error) }
      if (primaryError && cleanupErrors.length) throw new AggregateError(
        [primaryError, ...cleanupErrors], 'W65 test and cleanup both failed')
      if (primaryError) throw primaryError
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'W65 cleanup failed')
    }
  })
