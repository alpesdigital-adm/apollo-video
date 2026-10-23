import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createApiClientAdministrationService,
  rotateApiCredentialService,
} from '../../src/v2/application/administer-api-clients.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaApiClientRepository } from '../../src/v2/infrastructure/prisma/api-client-repository.ts'
import { PrismaContaminationReportRepository } from '../../src/v2/infrastructure/prisma/contamination-report-repository.ts'
import { PrismaEvidenceSegmentRepository } from '../../src/v2/infrastructure/prisma/evidence-segment-repository.ts'
import { PrismaMusicAnalysisRunRepository } from '../../src/v2/infrastructure/prisma/music-analysis-run-repository.ts'
import { PrismaPerceptionTimelineRepository } from '../../src/v2/infrastructure/prisma/perception-timeline-repository.ts'
import { PrismaReviewPatchBatchRepository } from '../../src/v2/infrastructure/prisma/review-patch-batch-repository.ts'
import { PrismaReviewPatchRepository } from '../../src/v2/infrastructure/prisma/review-patch-repository.ts'
import { PrismaSpeechSegmentCatalogRepository } from '../../src/v2/infrastructure/prisma/speech-segment-catalog-repository.ts'
import {
  DEFAULT_IDEMPOTENCY_WINNER_WAIT,
  awaitCommittedIdempotencyWinner,
  configureIdempotencyWinnerWait,
  pauseBeforeLostRaceRetry,
  reconcileAfterConflict,
  retryAfterLostRace,
} from '../../src/v2/infrastructure/prisma/idempotency-record-persistence.ts'
import { nodeApiCredentialCrypto } from '../../src/v2/infrastructure/security/api-credential.ts'

// -------------------------------------------------------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------------------------------------------------------

function p2034() {
  return Object.assign(new Error('could not serialize access due to read/write dependencies'), { code: 'P2034' })
}
function p2002() {
  return Object.assign(new Error('unique constraint failed'), { code: 'P2002' })
}
function recordingWait(delays = [1, 2, 3, 4]) {
  const sleeps = []
  return { delaysMs: delays, async sleep(milliseconds) { sleeps.push(milliseconds) }, sleeps }
}

test('reconcileAfterConflict waits for the winner after P2034 and reads once after P2002', async () => {
  const wait = recordingWait()
  let reads = 0
  const late = await reconcileAfterConflict(p2034(), async () => (++reads > 2 ? 'winner' : null), wait)
  assert.equal(late, 'winner')
  assert.deepEqual(wait.sleeps, [1, 2])

  const single = recordingWait()
  reads = 0
  const none = await reconcileAfterConflict(p2002(), async () => { reads += 1; return null }, single)
  assert.equal(none, null)
  assert.equal(reads, 1, 'a unique violation already waited for the winner inside PostgreSQL')
  assert.deepEqual(single.sleeps, [])
})

test('pauseBeforeLostRaceRetry and retryAfterLostRace spend a bounded budget', async () => {
  const wait = recordingWait([5, 6])
  assert.equal(await pauseBeforeLostRaceRetry(1, wait), true)
  assert.equal(await pauseBeforeLostRaceRetry(2, wait), true)
  assert.equal(await pauseBeforeLostRaceRetry(3, wait), false)
  assert.deepEqual(wait.sleeps, [5, 6])

  let calls = 0
  const result = await retryAfterLostRace(async () => { if (++calls < 3) throw p2034(); return 'ok' }, undefined, recordingWait([1, 1, 1]))
  assert.equal(result, 'ok')
  assert.equal(calls, 3)

  calls = 0
  await assert.rejects(
    retryAfterLostRace(async () => { calls += 1; throw p2034() }, undefined, recordingWait([1, 1])),
    (error) => error.code === 'P2034',
  )
  assert.equal(calls, 3, 'first attempt plus one per delay')

  calls = 0
  await assert.rejects(
    retryAfterLostRace(async () => { calls += 1; throw new Error('not a race') }, undefined, recordingWait([1, 1])),
    /not a race/,
  )
  assert.equal(calls, 1)
})

test('configureIdempotencyWinnerWait injects the default wait of every repository and restores it', async () => {
  const wait = recordingWait([7])
  const restore = configureIdempotencyWinnerWait(wait)
  try {
    assert.equal(await awaitCommittedIdempotencyWinner(async () => null), null)
    assert.deepEqual(wait.sleeps, [7])
  } finally {
    restore()
  }
  const after = recordingWait([9])
  const restoreAfter = configureIdempotencyWinnerWait(after)
  restoreAfter()
  assert.deepEqual(after.sleeps, [])
})

// -------------------------------------------------------------------------------------------------------------------
// Contamination report: the loser exhausts three Serializable attempts while the winner is still in flight
// -------------------------------------------------------------------------------------------------------------------

function contaminationRecord(requestFingerprint = 'a'.repeat(64)) {
  return {
    idempotencyKey: 'contamination-race-1',
    requestFingerprint,
    authenticationAudit: { contextHash: 'c'.repeat(64) },
    report: {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      createdByClientId: 'client-1',
    },
  }
}

// `invisibleReads` empty reads of the winner's row before it becomes visible; `error` is what each attempt throws.
function contaminationRace({ invisibleReads, winnerFingerprint = 'a'.repeat(64), error = p2034 }) {
  let attempts = 0
  let reads = 0
  const prisma = {
    async $transaction() { attempts += 1; throw error() },
  }
  const repository = new PrismaContaminationReportRepository(prisma)
  const winner = { report: { id: 'report-winner' }, requestFingerprint: winnerFingerprint }
  repository.findCreateReplay = async () => (++reads > invisibleReads ? winner : null)
  return { repository, attempts: () => attempts, reads: () => reads, winner }
}

test('contamination report: a P2034 loser replays the late-committed winner of the same request', async () => {
  const wait = recordingWait()
  const restore = configureIdempotencyWinnerWait(wait)
  try {
    const race = contaminationRace({ invisibleReads: 2 })
    const result = await race.repository.create(contaminationRecord())
    assert.equal(result.replayed, true)
    assert.equal(result.report.id, 'report-winner')
    assert.equal(race.attempts(), 3)
    assert.deepEqual(wait.sleeps, [1, 2])
  } finally {
    restore()
  }
})

test('contamination report: a P2034 loser reports IDEMPOTENCY_PAYLOAD_MISMATCH against a different late winner', async () => {
  const wait = recordingWait()
  const restore = configureIdempotencyWinnerWait(wait)
  try {
    const race = contaminationRace({ invisibleReads: 2, winnerFingerprint: 'b'.repeat(64) })
    await assert.rejects(
      race.repository.create(contaminationRecord()),
      (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    assert.equal(race.attempts(), 3)
  } finally {
    restore()
  }
})

test('contamination report: PERSISTENCE_CONFLICT only when no winner ever commits, after the bounded wait', async () => {
  const wait = recordingWait()
  const restore = configureIdempotencyWinnerWait(wait)
  try {
    const race = contaminationRace({ invisibleReads: Number.MAX_SAFE_INTEGER })
    await assert.rejects(
      race.repository.create(contaminationRecord()),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(race.attempts(), 3)
    assert.deepEqual(wait.sleeps, [1, 2, 3, 4])
    assert.equal(race.reads(), 5)
  } finally {
    restore()
  }
})

test('contamination report: a unique violation reads the winner once, without waiting', async () => {
  const wait = recordingWait()
  const restore = configureIdempotencyWinnerWait(wait)
  try {
    const race = contaminationRace({ invisibleReads: 0, error: p2002 })
    const result = await race.repository.create(contaminationRecord())
    assert.equal(result.replayed, true)
    assert.deepEqual(wait.sleeps, [])
  } finally {
    restore()
  }
})

// -------------------------------------------------------------------------------------------------------------------
// API client administration: create and rotate lose the race on the idempotency record
// -------------------------------------------------------------------------------------------------------------------

function actor() {
  const auditContext = createExternalAuditContext({
    clientId: 'admin-client', credentialId: 'admin-credential',
    workspaceId: 'workspace-1', environment: 'sandbox',
  })
  return {
    ...auditContext,
    scopes: new Set(['clients:admin', 'projects:read']),
    authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
    workspaceAccessStatus: 'active', auditContext,
  }
}

async function administrationBundles() {
  let captured
  const source = {
    async listByWorkspace() { return [] },
    async createOrReplay(bundle) { captured = { ...captured, create: bundle }; return { client: bundle.client, credential: bundle.credential, command: bundle.command, replayed: false } },
    async rotateOrReplay(bundle) {
      captured = { ...captured, rotate: bundle }
      return { client: { ...bundle.client }, credential: bundle.credential, command: bundle.command, replayed: false }
    },
    async revokeCredential() { throw new Error('not used') },
  }
  let counter = 0
  const dependencies = {
    repository: source,
    credentialCrypto: nodeApiCredentialCrypto,
    clock: () => new Date('2026-07-12T23:45:00.000Z'),
    createId: (kind) => `${kind}-${++counter}`,
  }
  await createApiClientAdministrationService(dependencies)({
    actor: actor(), workspaceId: 'workspace-1', name: 'Race Agent', scopes: ['projects:read'], idempotencyKey: 'create-race-1',
  })
  const different = captured.create
  await createApiClientAdministrationService({ ...dependencies, createId: (kind) => `${kind}-b-${++counter}` })({
    actor: actor(), workspaceId: 'workspace-1', name: 'Other Agent', scopes: ['projects:read'], idempotencyKey: 'create-race-1',
  })
  const divergent = captured.create
  await createApiClientAdministrationService({ ...dependencies, createId: (kind) => `${kind}-c-${++counter}` })({
    actor: actor(), workspaceId: 'workspace-1', name: 'Race Agent', scopes: ['projects:read'], idempotencyKey: 'create-race-1',
  })
  return { winner: different, same: captured.create, divergent }
}

// A fake database with only what the winner reconciliation reads. `winnerRows` are the committed rows of the winner;
// the idempotency record becomes visible after `invisibleReads` empty reads.
function administrationWorld({ winnerBundle, action, invisibleReads }) {
  let reads = 0
  const clientRow = {
    id: winnerBundle.client.id,
    workspaceId: winnerBundle.client.workspaceId,
    name: winnerBundle.client.name,
    status: winnerBundle.client.status,
    type: winnerBundle.client.type,
    allowedEnvironmentsJson: JSON.stringify(winnerBundle.client.allowedEnvironments),
    scopeGrantsJson: JSON.stringify(winnerBundle.client.scopeGrants),
    createdBy: winnerBundle.client.createdBy,
    createdAt: new Date(winnerBundle.client.createdAt),
    lastUsedAt: null,
  }
  const credentialRow = {
    id: winnerBundle.credential.id,
    workspaceId: winnerBundle.credential.workspaceId,
    clientId: winnerBundle.credential.clientId,
    status: winnerBundle.credential.status,
    createdAt: new Date(winnerBundle.credential.createdAt),
    expiresAt: null, lastUsedAt: null, revokedAt: null,
  }
  const command = winnerBundle.command
  const commandRow = {
    id: command.id, workspaceId: command.workspaceId, action: command.action,
    targetClientId: command.targetClientId, targetCredentialId: command.targetCredentialId,
    actorClientId: command.audit.clientId, actorCredentialId: command.audit.credentialId,
    actorEnvironment: command.audit.environment, actorAuthenticationKind: command.audit.authenticationKind,
    actorContextHash: command.audit.contextHash,
    delegatedUserId: command.audit.delegatedUserId ?? null, delegatedIdentityId: command.audit.delegatedIdentityId ?? null,
    workspaceRole: command.audit.workspaceRole ?? null,
    idempotencyKey: command.idempotencyKey, requestFingerprint: command.requestFingerprint,
    occurredAt: new Date(command.occurredAt),
  }
  const record = {
    id: winnerBundle.idempotency.id,
    workspaceId: winnerBundle.idempotency.workspaceId,
    clientId: winnerBundle.idempotency.actorClientId,
    key: winnerBundle.idempotency.key,
    requestFingerprint: winnerBundle.idempotency.requestFingerprint,
    status: 'completed',
    responseStatus: 201,
    responseJson: JSON.stringify({ operation: action, clientId: clientRow.id, credentialId: credentialRow.id }),
    expiresAt: new Date(winnerBundle.idempotency.expiresAt),
    createdAt: new Date(winnerBundle.idempotency.createdAt),
  }
  let attempts = 0
  const client = {
    async $transaction() { attempts += 1; throw p2034() },
    v2IdempotencyRecord: { async findUnique() { reads += 1; return reads > invisibleReads ? record : null } },
    v2ApiClient: { async findUnique() { return clientRow } },
    v2ApiCredential: { async findUnique() { return credentialRow } },
    v2ApiAdministrationCommand: { async findUnique() { return commandRow } },
  }
  return { client, attempts: () => attempts, reads: () => reads }
}

test('api client create: the P2034 loser replays or reports a mismatch against the late-committed winner', async (context) => {
  const { winner, same, divergent } = await administrationBundles()
  assert.equal(winner.idempotency.requestFingerprint, same.idempotency.requestFingerprint)
  assert.notEqual(winner.idempotency.requestFingerprint, divergent.idempotency.requestFingerprint)

  await context.test('same request: replay', async () => {
    const wait = recordingWait()
    const world = administrationWorld({ winnerBundle: winner, action: 'api-client.create', invisibleReads: 2 })
    const repository = new PrismaApiClientRepository(world.client, wait)
    const result = await repository.createOrReplay(same)
    assert.equal(result.replayed, true)
    assert.equal(result.client.id, winner.client.id)
    assert.equal(world.attempts(), 3)
    assert.deepEqual(wait.sleeps, [1, 2])
  })

  await context.test('different request: IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
    const wait = recordingWait()
    const world = administrationWorld({ winnerBundle: winner, action: 'api-client.create', invisibleReads: 2 })
    const repository = new PrismaApiClientRepository(world.client, wait)
    await assert.rejects(
      repository.createOrReplay(divergent),
      (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    assert.equal(world.attempts(), 3)
  })

  await context.test('no winner ever commits: PERSISTENCE_CONFLICT after the bounded wait', async () => {
    const wait = recordingWait()
    const world = administrationWorld({ winnerBundle: winner, action: 'api-client.create', invisibleReads: Number.MAX_SAFE_INTEGER })
    const repository = new PrismaApiClientRepository(world.client, wait)
    await assert.rejects(
      repository.createOrReplay(same),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(world.attempts(), 3)
    assert.deepEqual(wait.sleeps, [1, 2, 3, 4])
    assert.equal(world.reads(), 5)
  })
})

test('api credential rotate: the P2034 loser replays or reports a mismatch against the late-committed winner', async (context) => {
  let captured
  let counter = 0
  const source = {
    async listByWorkspace() { return [] },
    async createOrReplay() { throw new Error('not used') },
    async rotateOrReplay(bundle) {
      captured = bundle
      return { client: { id: bundle.targetClientId, workspaceId: bundle.workspaceId, name: 'Target', type: 'service-account', status: 'active', allowedEnvironments: ['sandbox'], scopeGrants: ['projects:read'], createdBy: 'admin-client', createdAt: bundle.credential.createdAt }, credential: bundle.credential, command: bundle.command, replayed: false }
    },
    async revokeCredential() { throw new Error('not used') },
  }
  const execute = (suffix, overlapSeconds) => rotateApiCredentialService({
    repository: source,
    credentialCrypto: nodeApiCredentialCrypto,
    clock: () => new Date('2026-07-12T23:45:00.000Z'),
    createId: (kind) => `${kind}-${suffix}-${++counter}`,
  })({
    actor: actor(), workspaceId: 'workspace-1', targetClientId: 'target-client', idempotencyKey: 'rotate-race-1', overlapSeconds,
  })
  await execute('w', 30)
  const winner = { ...captured, client: { id: 'target-client', workspaceId: 'workspace-1', name: 'Target', type: 'service-account', status: 'active', allowedEnvironments: ['sandbox'], scopeGrants: ['projects:read'], createdBy: 'admin-client', createdAt: '2026-07-12T20:00:00.000Z' } }
  await execute('l', 30)
  const same = captured
  await execute('d', 60)
  const divergent = captured
  assert.equal(winner.idempotency.requestFingerprint, same.idempotency.requestFingerprint)
  assert.notEqual(winner.idempotency.requestFingerprint, divergent.idempotency.requestFingerprint)

  await context.test('same request: replay', async () => {
    const wait = recordingWait()
    const world = administrationWorld({ winnerBundle: winner, action: 'api-credential.rotate', invisibleReads: 2 })
    const repository = new PrismaApiClientRepository(world.client, wait)
    const result = await repository.rotateOrReplay(same)
    assert.equal(result.replayed, true)
    assert.equal(world.attempts(), 3)
    assert.deepEqual(wait.sleeps, [1, 2])
  })

  await context.test('different request: IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
    const wait = recordingWait()
    const world = administrationWorld({ winnerBundle: winner, action: 'api-credential.rotate', invisibleReads: 2 })
    const repository = new PrismaApiClientRepository(world.client, wait)
    await assert.rejects(
      repository.rotateOrReplay(divergent),
      (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
  })

  await context.test('no winner ever commits: PERSISTENCE_CONFLICT after the bounded wait', async () => {
    const wait = recordingWait()
    const world = administrationWorld({ winnerBundle: winner, action: 'api-credential.rotate', invisibleReads: Number.MAX_SAFE_INTEGER })
    const repository = new PrismaApiClientRepository(world.client, wait)
    await assert.rejects(
      repository.rotateOrReplay(same),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.deepEqual(wait.sleeps, [1, 2, 3, 4])
  })
})

// -------------------------------------------------------------------------------------------------------------------
// Production budget: pinned so a change of schedule or attempt count is a deliberate edit of this test
// -------------------------------------------------------------------------------------------------------------------

test('the production lost-race schedule is 25..800 ms, 1.575 s in total, seven attempts for the pause loops', async () => {
  assert.deepEqual([...DEFAULT_IDEMPOTENCY_WINNER_WAIT.delaysMs], [25, 50, 100, 200, 400, 800])
  assert.equal(DEFAULT_IDEMPOTENCY_WINNER_WAIT.delaysMs.reduce((total, ms) => total + ms, 0), 1575)
  const spent = []
  const wait = { delaysMs: DEFAULT_IDEMPOTENCY_WINNER_WAIT.delaysMs, async sleep(ms) { spent.push(ms) } }
  let attempts = 1
  while (await pauseBeforeLostRaceRetry(attempts, wait)) attempts += 1
  assert.equal(attempts, 7)
  assert.deepEqual(spent, [25, 50, 100, 200, 400, 800])
  // The winner wait reads once, then once after each delay: seven reads in the same 1.575 s.
  let reads = 0
  assert.equal(await awaitCommittedIdempotencyWinner(async () => { reads += 1; return null }, { delaysMs: wait.delaysMs, async sleep() {} }), null)
  assert.equal(reads, 7)
})

// -------------------------------------------------------------------------------------------------------------------
// Catalogs whose exhausted-P2034 throw used to sit before the reconcile block (evidence segment, speech segment catalog)
// -------------------------------------------------------------------------------------------------------------------

const catalogRecord = () => ({
  workspaceId: 'workspace-1', projectId: 'project-1', idempotencyKey: 'race-1', requestFingerprint: 'a'.repeat(64),
  authenticationAudit: { contextHash: 'c'.repeat(64) },
})

for (const [label, Repository] of [
  ['evidence segment', PrismaEvidenceSegmentRepository],
  ['speech segment catalog', PrismaSpeechSegmentCatalogRepository],
]) {
  test(`${label}: an exhausted P2034 loser meets the late-committed winner (replay, mismatch, none)`, async () => {
    for (const [name, invisibleReads, winnerFingerprint, expected] of [
      ['replay', 2, 'a'.repeat(64), 'replayed'],
      ['mismatch', 2, 'b'.repeat(64), 'IDEMPOTENCY_PAYLOAD_MISMATCH'],
      ['none', Number.MAX_SAFE_INTEGER, 'a'.repeat(64), 'PERSISTENCE_CONFLICT'],
    ]) {
      const wait = recordingWait()
      const restore = configureIdempotencyWinnerWait(wait)
      try {
        let attempts = 0
        let reads = 0
        const repository = new Repository({ async $transaction() { attempts += 1; throw p2034() } })
        repository.findIdempotent = async () => (++reads > invisibleReads ? { requestFingerprint: winnerFingerprint, id: 'winner' } : null)
        const result = await repository.persist(catalogRecord()).then((value) => value, (error) => error)
        if (expected === 'replayed') {
          assert.equal(result.replayed, true, name)
        } else {
          assert.ok(result instanceof DomainError, `${name}: ${String(result?.message)}`)
          assert.equal(result.code, expected, name)
        }
        assert.equal(attempts, 3, name)
        assert.deepEqual(wait.sleeps, name === 'none' ? [1, 2, 3, 4] : [1, 2], name)
      } finally {
        restore()
      }
    }
  })
}

// -------------------------------------------------------------------------------------------------------------------
// Review patch and review batch: a lost-race loser is a replay; another payload is a mismatch, not a conflict
// -------------------------------------------------------------------------------------------------------------------

function reviewCommit(type) {
  return {
    bundle: {
      origin: {
        kind: 'child-command',
        command: { type, id: 'command-1', baseVersionId: 'version-0' },
        audit: { contextHash: 'c'.repeat(64) },
        requestFingerprint: 'f'.repeat(64),
      },
      version: { commandId: 'command-1', parentVersionId: 'version-0', workspaceId: 'workspace-1', projectId: 'project-1' },
    },
    proposalId: 'proposal-1',
    batchId: 'batch-1',
    applyIdempotencyKey: 'apply-1',
    applyRequestFingerprint: 'a'.repeat(64),
    event: {}, comparison: {}, impact: {},
  }
}

for (const [label, Repository, commandType] of [
  ['review patch', PrismaReviewPatchRepository, 'apply-review-patch'],
  ['review batch', PrismaReviewPatchBatchRepository, 'apply-review-patch-batch'],
]) {
  test(`${label}: a P2034 loser is a replay (replayed: true) and reads the winner through the bounded wait`, async () => {
    const wait = recordingWait()
    const restore = configureIdempotencyWinnerWait(wait)
    try {
      let transactions = 0
      let reads = 0
      const optionsSeen = []
      const repository = new Repository({ async $transaction() { transactions += 1; throw p2034() } })
      repository.readAppliedResult = async (_input, options) => {
        reads += 1
        optionsSeen.push(options)
        // three pre-checks (one per Serializable attempt), then the reconcile reads: two empty, the third sees the winner
        return reads > 5 ? { applied: true } : null
      }
      const result = await repository.commitOrReplay(reviewCommit(commandType))
      assert.equal(result.replayed, true)
      assert.equal(transactions, 3)
      assert.deepEqual(wait.sleeps, [1, 2])
      assert.deepEqual(optionsSeen.slice(0, 3).map((options) => options?.rejectFingerprintMismatch), [undefined, undefined, undefined], 'the sequential pre-check keeps returning null on a fingerprint mismatch')
      assert.deepEqual(optionsSeen.slice(3).map((options) => options?.rejectFingerprintMismatch), [true, true, true])
    } finally {
      restore()
    }
  })

  test(`${label}: readAppliedResult throws IDEMPOTENCY_PAYLOAD_MISMATCH against another payload only when asked`, async () => {
    const row = {
      id: 'x', status: 'applied', applyIdempotencyKey: 'apply-1', applyRequestFingerprint: 'b'.repeat(64),
      resultVersion: { command: {} }, comparisonJson: '{}',
    }
    const client = { v2ReviewPatchProposal: { async findFirst() { return row } }, v2ReviewPatchBatch: { async findFirst() { return row } } }
    const repository = new Repository(client)
    const input = {
      workspaceId: 'workspace-1', projectId: 'project-1', proposalId: 'proposal-1', batchId: 'batch-1',
      applyIdempotencyKey: 'apply-1', applyRequestFingerprint: 'a'.repeat(64), actorContextHash: 'c'.repeat(64),
    }
    assert.equal(await repository.readAppliedResult(input), null)
    await assert.rejects(
      repository.readAppliedResult(input, { rejectFingerprintMismatch: true }),
      (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    assert.equal(await repository.readAppliedResult({ ...input, applyIdempotencyKey: 'other' }, { rejectFingerprintMismatch: true }), null)
  })
}

// -------------------------------------------------------------------------------------------------------------------
// Pause loops and whole-transaction retries
// -------------------------------------------------------------------------------------------------------------------

test('perception timeline (pause loop): the loser keeps retrying through the schedule and ends on the winner', async () => {
  const wait = recordingWait()
  const restore = configureIdempotencyWinnerWait(wait)
  try {
    let attempts = 0
    const repository = new PrismaPerceptionTimelineRepository({
      async $transaction() { attempts += 1; if (attempts <= 4) throw p2034(); return { timeline: { id: 'winner' }, replayed: true } },
    })
    const result = await repository.persist({ workspaceId: 'w', projectId: 'p', idempotencyKey: 'k' })
    assert.equal(result.replayed, true)
    assert.equal(attempts, 5, 'more than the former three immediate attempts')
    assert.deepEqual(wait.sleeps, [1, 2, 3, 4])
  } finally {
    restore()
  }
})

test('perception timeline (pause loop): PERSISTENCE_CONFLICT only after the whole schedule', async () => {
  const wait = recordingWait()
  const restore = configureIdempotencyWinnerWait(wait)
  try {
    let attempts = 0
    const repository = new PrismaPerceptionTimelineRepository({ async $transaction() { attempts += 1; throw p2034() } })
    await assert.rejects(
      repository.persist({ workspaceId: 'w', projectId: 'p', idempotencyKey: 'k' }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(attempts, 5, 'the first attempt plus one per delay')
    assert.deepEqual(wait.sleeps, [1, 2, 3, 4])
  } finally {
    restore()
  }
})

test('music analysis run (whole-transaction retry): a lost race re-runs the transaction and meets the committed winner', async () => {
  const wait = recordingWait()
  const restore = configureIdempotencyWinnerWait(wait)
  try {
    let attempts = 0
    const repository = new PrismaMusicAnalysisRunRepository({
      async $transaction() { attempts += 1; if (attempts < 3) throw p2002(); return { run: { id: 'winner' }, replayed: true } },
    })
    const result = await repository.create({})
    assert.equal(result.replayed, true)
    assert.equal(attempts, 3)
    assert.deepEqual(wait.sleeps, [1, 2])
  } finally {
    restore()
  }
})

test('music analysis run (whole-transaction retry): PERSISTENCE_CONFLICT only after the schedule is spent', async () => {
  const wait = recordingWait()
  const restore = configureIdempotencyWinnerWait(wait)
  try {
    let attempts = 0
    const repository = new PrismaMusicAnalysisRunRepository({ async $transaction() { attempts += 1; throw p2034() } })
    await assert.rejects(
      repository.create({}),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(attempts, 5)
  } finally {
    restore()
  }
})
