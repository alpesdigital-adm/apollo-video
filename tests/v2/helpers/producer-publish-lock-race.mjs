import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '../../../generated/prisma-v2/index.js'
import { cancelPublicOperationService } from '../../../src/v2/application/cancel-public-operation.ts'
import { createAssetRightsSnapshot } from '../../../src/v2/domain/asset-rights.ts'
import { createProjectVersion } from '../../../src/v2/domain/project-version.ts'
import { calculateVersionHash } from '../../../src/v2/application/version-hash.ts'
import { DomainError } from '../../../src/v2/domain/errors.ts'
import { stableSerialize } from '../../../src/v2/domain/canonical-hash.ts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function isolatedUrl(label) {
  const url = new URL(process.env.V2_DATABASE_URL)
  const prefix = url.searchParams.get('application_name')
  assert.match(prefix ?? '', /^apollo-video-e2e-/)
  assert.ok(label.length < 40)
  url.searchParams.set('application_name', `${prefix.slice(0, 62 - label.length)}-${label}`)
  url.searchParams.set('connection_limit', '1')
  url.searchParams.set('pool_timeout', '10')
  url.searchParams.set('connect_timeout', '10')
  return url.toString()
}

export function expectProducerPublishErrorCode(error, expectedCodes, logUnexpected = true) {
  const serializationOnLockedHead = error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010' && error.meta?.code === '40001' &&
    expectedCodes.includes('P2010:40001')
  const typed = error instanceof DomainError ||
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034')
  const matched = serializationOnLockedHead || (typed && expectedCodes.includes(error?.code))
  if (!matched && logUnexpected) {
    const safe = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
      ? value : 'unavailable'
    console.error(`producer-publish-fence unexpected-rejection name=${safe(error?.name)} ` +
      `code=${safe(error?.code)} metaCode=${safe(error?.meta?.code)} ` +
      `sqlState=${safe(error?.meta?.sqlState)} expected=${expectedCodes.join('/')}`)
  }
  return matched
}

/** A real lock wait, observed through pg_stat_activity, with bounded and owned connections. */
export async function runProducerPublishLockRace({ db, label, lockedTable, lockedId,
  publish, whileLocked, beforeLock, afterWait, beforeRelease, expectedCodes }) {
  assert.ok(['public_operations', 'projects', 'media_artifacts'].includes(lockedTable))
  assert.ok(Array.isArray(expectedCodes) && expectedCodes.length > 0)
  const holder = new PrismaClient({ datasources: { db: { url: isolatedUrl(`${label}-hold`) } } })
  const contender = new PrismaClient({ datasources: { db: { url: isolatedUrl(`${label}-try`) } } })
  const entered = deferred()
  const release = deferred()
  let primaryError
  let held
  let attempted
  try {
    await Promise.all([holder.$connect(), contender.$connect()])
    const [{ pid }] = await contender.$queryRaw`SELECT pg_backend_pid() AS pid`
    if (beforeLock) await beforeLock(db)
    held = holder.$transaction(async (tx) => {
      if (lockedTable === 'public_operations') {
        const rows = await tx.$queryRaw`SELECT "id" FROM "public_operations" WHERE "id" = ${lockedId} FOR UPDATE`
        assert.equal(rows.length, 1)
      } else if (lockedTable === 'projects') {
        const rows = await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${lockedId} FOR UPDATE`
        assert.equal(rows.length, 1)
      } else {
        const rows = await tx.$queryRaw`SELECT "id" FROM "media_artifacts" WHERE "id" = ${lockedId} FOR UPDATE`
        assert.equal(rows.length, 1)
      }
      entered.resolve()
      await release.promise
      if (whileLocked) await whileLocked(tx)
    }, { timeout: 15_000, maxWait: 5_000 })
    await Promise.race([entered.promise, held])
    attempted = Promise.resolve().then(() => publish(contender))
    // Prevent an early rejection becoming unhandled while the lock waiter is observed.
    attempted.catch(() => {})
    const deadline = Date.now() + 6_000
    let observed = false
    while (Date.now() < deadline) {
      const rows = await db.$queryRaw`SELECT wait_event_type AS "waitType" FROM pg_stat_activity WHERE pid = ${pid}`
      if (rows[0]?.waitType === 'Lock') { observed = true; break }
      await new Promise((done) => setTimeout(done, 25))
    }
    assert.equal(observed, true, `${label}: publisher never reached the PostgreSQL lock wait`)
    const [{ lockObservedAt }] = await db.$queryRaw`
      SELECT clock_timestamp() AS "lockObservedAt"`
    const window = afterWait ? await afterWait(db) : null
    console.log(`producer-publish-fence ${label} lockObservedAt=${lockObservedAt.toISOString()} ` +
      (window ? `beforeExpiry=${window.beforeExpiry.toISOString()} ` +
        `afterExpiry=${window.afterExpiry.toISOString()}` : 'headMutation=controlled'))
    if (beforeRelease) await beforeRelease(db)
    release.resolve()
    await held
    await assert.rejects(attempted,
      (error) => expectProducerPublishErrorCode(error, expectedCodes))
  } catch (error) {
    primaryError = error
  } finally {
    release.resolve()
    const work = await Promise.allSettled([held ?? Promise.resolve(), attempted ?? Promise.resolve()])
    const disconnect = await Promise.allSettled([holder.$disconnect(), contender.$disconnect()])
    const failures = [work[0], ...disconnect]
      .filter((item) => item.status === 'rejected').map((item) => item.reason)
    if (primaryError && failures.length) throw new AggregateError([primaryError, ...failures], `${label}: race and cleanup failed`)
    if (primaryError) throw primaryError
    if (failures.length) throw new AggregateError(failures, `${label}: cleanup failed`)
  }
}

export async function waitForDatabaseClock(db, threshold) {
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    const [{ observedAt }] = await db.$queryRaw`SELECT clock_timestamp() AS "observedAt"`
    if (observedAt >= threshold) return observedAt
    await new Promise((done) => setTimeout(done, 25))
  }
  assert.fail(`database clock did not cross ${threshold.toISOString()} within bounded wait`)
}

export async function assertDatabaseClockBefore(db, threshold) {
  const [{ observedAt }] = await db.$queryRaw`SELECT clock_timestamp() AS "observedAt"`
  assert.ok(observedAt < threshold,
    `publisher reached the observed lock only after ${threshold.toISOString()} expired`)
  return observedAt
}

async function assertProducerLeaseLive(db, operationId) {
  const row = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })
  assert.ok(row.leaseExpiresAt instanceof Date)
  const observedAt = await assertDatabaseClockBefore(db, row.leaseExpiresAt)
  return { row, observedAt }
}

export function createFenceRightsSnapshot(world, sequence, expiresAt, label) {
  return createAssetRightsSnapshot({
    id: `rights-${label}`, workspaceId: world.workspaceId,
    artifactId: world.sourceId, sequence,
    draft: { status: 'approved', allowedUses: ['editorial-reuse'],
      prohibitedUses: [], ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      sourceNote: `Controlled publish fence fixture ${label}`,
      consent: { status: 'not-required', allowedUses: [] } },
    createdBy: { type: 'user', id: 'w61-owner' }, createdAt: new Date().toISOString(),
  })
}

export function fenceRightsRow(rights) {
  return {
    id: rights.id, workspaceId: rights.workspaceId, artifactId: rights.artifactId,
    sequence: rights.sequence, schemaVersion: rights.schemaVersion,
    snapshotHash: rights.snapshotHash, owner: null, license: null,
    status: rights.status, allowedUsesJson: stableSerialize(rights.allowedUses),
    prohibitedUsesJson: stableSerialize(rights.prohibitedUses),
    allowedWorkspaceIdsJson: stableSerialize(rights.allowedWorkspaceIds),
    allowedMarketsJson: null, allowedLocalesJson: null,
    allowedSyntheticOperationsJson: null,
    expiresAt: rights.expiresAt ? new Date(rights.expiresAt) : null,
    consentStatus: rights.consent.status,
    consentAllowedUsesJson: stableSerialize(rights.consent.allowedUses),
    consentAllowedMarketsJson: null, consentAllowedLocalesJson: null,
    consentSyntheticOperationsJson: null, consentExpiresAt: null,
    consentDocumentArtifactId: null, sourceNote: rights.sourceNote ?? null,
    createdByType: rights.createdBy.type, createdById: rights.createdBy.id,
    createdAt: new Date(rights.createdAt),
  }
}

export function createFenceChildVersion(world, base, editPlanHash, id) {
  const sequence = base.sequence + 1
  return createProjectVersion({ id, workspaceId: world.workspaceId,
    projectId: world.projectId, sequence, parentVersionId: base.id,
    snapshotRefs: { ...(base.briefSnapshotId ? { brief: base.briefSnapshotId } : {}),
      ...(base.treatmentSnapshotId ? { treatment: base.treatmentSnapshotId } : {}),
      ...(base.storySnapshotId ? { story: base.storySnapshotId } : {}),
      editPlan: base.editPlanSnapshotId, policies: base.policiesSnapshotId },
    baseHash: calculateVersionHash({ projectId: world.projectId, sequence,
      parentVersionId: base.id, previousBaseHash: base.baseHash,
      editPlanHash }), createdBy: base.createdBy, createdAt: new Date().toISOString(),
  })
}

export async function installExpiringRights(db, world, expiresAt, label) {
  const original = await db.v2MediaArtifact.findUniqueOrThrow({ where: { id: world.sourceId } })
  const sequence = original.rightsRevision + 1
  const expiringId = await writeFenceRightsSnapshot(db, world, sequence, expiresAt,
    `${label}-expiring`)
  await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: {
    currentRightsSnapshotId: expiringId, rightsRevision: sequence,
  } })
  return async () => {
    const renewedId = await writeFenceRightsSnapshot(db, world, sequence + 1, null,
      `${label}-renewed`)
    await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: {
      currentRightsSnapshotId: renewedId,
      rightsRevision: sequence + 1,
    } })
  }
}

export async function writeFenceRightsSnapshot(db, world, sequence, expiresAt, label) {
  const rights = createFenceRightsSnapshot(world, sequence, expiresAt, label)
  await db.v2AssetRightsSnapshot.create({ data: fenceRightsRow(rights) })
  return rights.id
}

export async function verifyProducerPublishFences({ db, world, repository, Repository,
  enqueue, cloneEnvelope, cancel, envelopeModel, label, phases }) {
  assert.deepEqual(phases, label === 'ocr'
    ? ['transcribing', 'verifying', 'persisting']
    : ['analyzing', 'verifying', 'persisting'])
  for (const kind of ['lease', 'rights', 'head']) {
    const operationId = await enqueue(`publish-${kind}`)
    const owner = `${label}-${kind}-${world.suffix}`
    let releaseRights
    let childVersionId
    let primaryError
    try {
      const claim = await repository.claimNext({ leaseOwner: owner, now: new Date(), leaseMs: 10_000 })
      assert.equal(claim?.operationId, operationId)
      for (const phase of phases) {
        assert.equal(await repository.advancePhase({ operationId, attempt: claim.attempt,
          leaseOwner: owner, now: new Date(), phase }), true)
      }
      const fenceHash = await repository.currentFenceHash({ operationId,
        attempt: claim.attempt, leaseOwner: owner, now: new Date() })
      const candidate = cloneEnvelope({ operationId, attempt: claim.attempt, fenceHash })
      let lockedTable = 'public_operations', lockedId = operationId
      let whileLocked
      let beforeLock
      let afterWait
      if (kind === 'lease') {
        let expiresAt
        beforeLock = async () => {
          assert.equal(await repository.heartbeat({ operationId, attempt: claim.attempt,
            leaseOwner: owner, now: new Date(), leaseMs: 2_000 }), true)
          const lease = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })
          expiresAt = lease.leaseExpiresAt
          await assertDatabaseClockBefore(db, expiresAt)
        }
        afterWait = async (client) => {
          const beforeExpiry = await assertDatabaseClockBefore(client, expiresAt)
          const afterExpiry = await waitForDatabaseClock(client, expiresAt)
          return { beforeExpiry, afterExpiry }
        }
      } else if (kind === 'rights') {
        let expiresAt
        beforeLock = async () => {
          const [{ now }] = await db.$queryRaw`SELECT clock_timestamp() AS now`
          expiresAt = new Date(now.getTime() + 2_000)
          releaseRights = await installExpiringRights(db, world, expiresAt,
            `${label}-${world.suffix}`)
          await assertDatabaseClockBefore(db, expiresAt)
        }
        afterWait = async (client) => {
          const beforeExpiry = await assertDatabaseClockBefore(client, expiresAt)
          const afterExpiry = await waitForDatabaseClock(client, expiresAt)
          return { beforeExpiry, afterExpiry }
        }
      } else {
        const base = await db.v2ProjectVersion.findUniqueOrThrow({ where: { id: world.versionId } })
        const editPlan = await db.v2ProjectSnapshot.findUniqueOrThrow({
          where: { id: base.editPlanSnapshotId },
        })
        childVersionId = `${label}-head-${randomUUID()}`
        const child = createFenceChildVersion(world, base, editPlan.contentHash,
          childVersionId)
        await db.v2ProjectVersion.create({ data: {
          id: child.id, workspaceId: child.workspaceId, projectId: child.projectId,
          sequence: child.sequence, parentVersionId: child.parentVersionId,
          briefSnapshotId: child.snapshotRefs.brief ?? null,
          treatmentSnapshotId: child.snapshotRefs.treatment ?? null,
          storySnapshotId: child.snapshotRefs.story ?? null,
          editPlanSnapshotId: child.snapshotRefs.editPlan,
          policiesSnapshotId: child.snapshotRefs.policies,
          baseHash: child.baseHash, createdBy: child.createdBy,
          createdAt: new Date(child.createdAt),
        } })
        lockedTable = 'projects'; lockedId = world.projectId
        whileLocked = (tx) => tx.v2Project.update({ where: { id: world.projectId },
          data: { currentVersionId: childVersionId } })
      }
      await runProducerPublishLockRace({ db, label: `${label}-${kind}`, lockedTable,
        lockedId, whileLocked, beforeLock, afterWait,
        expectedCodes: kind === 'lease' ? ['PERSISTENCE_CONFLICT']
          : kind === 'rights' ? ['ASSET_RIGHTS_BLOCKED']
            : ['PERSISTENCE_CONFLICT', 'P2034', 'P2010:40001'],
        beforeRelease: kind === 'head'
          ? (client) => assertProducerLeaseLive(client, operationId) : undefined,
        publish: (client) => new Repository(client).publish({
          envelope: candidate, leaseOwner: owner, now: new Date(),
        }) })
      if (kind === 'rights' || kind === 'head') {
        const { observedAt } = await assertProducerLeaseLive(db, operationId)
        console.log(`producer-publish-fence ${label}-${kind} liveLeaseAt=${observedAt.toISOString()}`)
      }
      if (kind === 'head') {
        const head = await db.v2Project.findUniqueOrThrow({ where: { id: world.projectId } })
        assert.equal(head.currentVersionId, childVersionId)
      }
      assert.equal(await db[envelopeModel].count({ where: { operationId } }), 0)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })).status,
        'running')
      assert.equal(await db.v2PublicEventOutbox.count({ where: { workspaceId: world.workspaceId,
        resourceId: operationId, type: 'operation.succeeded' } }), 0)
    } catch (error) {
      primaryError = error
    } finally {
      const cleanupErrors = []
      if (childVersionId) {
        try { await db.v2Project.update({ where: { id: world.projectId },
          data: { currentVersionId: world.versionId } }) }
        catch (error) { cleanupErrors.push(error) }
      }
      if (releaseRights) {
        try { await releaseRights() }
        catch (error) { cleanupErrors.push(error) }
      }
      try { await cancel(operationId, kind) }
      catch (error) { cleanupErrors.push(error) }
      if (primaryError && cleanupErrors.length) {
        throw new AggregateError([primaryError, ...cleanupErrors], `${label}-${kind}: race and cleanup failed`)
      }
      if (primaryError) throw primaryError
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors,
        `${label}-${kind}: cleanup failed`)
    }
  }
}

export async function cancelProducerFenceCase(db, operations, world, actor, operationId, label) {
  const row = await db.v2PublicOperation.findUnique({ where: { id: operationId } })
  if (!row || !['queued', 'running', 'waiting', 'retrying'].includes(row.status)) return
  const at = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1,
    (row.nextAttemptAt?.getTime() ?? 0) + 1))
  const cancel = cancelPublicOperationService({ operations, clock: () => at,
    createId: () => `${label}-${randomUUID()}` })
  const stopped = await cancel({ workspaceId: world.workspaceId, operationId, actor })
  assert.equal(stopped.status, 'canceled')
}
