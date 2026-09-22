import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithProviderJobLease } from '../../src/v2/application/with-provider-job-lease.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createProviderJob, transitionProviderJob } from '../../src/v2/domain/provider-job.ts'
import { createSyntheticPresenterProfileSnapshot } from '../../src/v2/domain/synthetic-production.ts'
import { PrismaProviderJobRepository } from '../../src/v2/infrastructure/prisma/provider-job-repository.ts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function claim(expiresAt = '2029-01-01T00:00:30.000Z') {
  return Object.freeze({
    job: Object.freeze({
      id: 'provider-job-lease-one',
      workspaceId: 'workspace-provider',
      projectId: 'project-provider',
      status: 'evaluating',
      jobHash: 'a'.repeat(64),
    }),
    requestFingerprint: 'b'.repeat(64),
    lease: Object.freeze({ owner: 'worker-one', token: 'lease-token-one', expiresAt }),
  })
}

const hash = (character) => character.repeat(64)
const at = (second) => `2029-01-01T00:00:${String(second).padStart(2, '0')}.000Z`

function evaluatingJob() {
  const authorizationBody = {
    id: 'provider-authorization-lease',
    profileSnapshotId: 'presenter-lease:v1',
    profileSnapshotHash: hash('a'),
    artifactDecisions: [{
      artifactId: 'audio-lease', rightsSnapshotId: 'rights-audio-lease',
      rightsSnapshotHash: hash('b'), validUntil: '2030-01-01T00:00:00.000Z',
    }],
    evaluatedAt: at(0),
    expiresAt: '2030-01-01T00:00:00.000Z',
  }
  let job = createProviderJob({
    id: 'provider-job-lease-approval', workspaceId: 'workspace-provider', projectId: 'project-provider',
    originProjectVersionId: 'version-provider', operation: 'audio-avatar', adapterId: 'controlled-avatar',
    adapterVersion: 'version-1', idempotencyKey: 'provider-lease-approval-key', createdAt: at(0),
    authorization: { ...authorizationBody, authorizationHash: calculateCanonicalHash(authorizationBody) },
    providerInput: {
      criticBinding: {
        planId: 'plan-lease', blockId: 'block-lease', scriptText: 'Texto autorizado.',
        scriptHash: hash('c'), profileSnapshotId: 'presenter-lease:v1',
        use: 'ads', market: 'BRA', locale: 'pt-BR',
      },
    },
  })
  job = transitionProviderJob(job, { status: 'estimated', occurredAt: at(1), estimate: { currency: 'USD', costMinorUnits: 1, estimatedLatencyMs: 1 } })
  job = transitionProviderJob(job, { status: 'submitting', occurredAt: at(2) })
  job = transitionProviderJob(job, { status: 'submitted', occurredAt: at(3), providerJobId: 'provider-ref-lease' })
  job = transitionProviderJob(job, { status: 'retrieving', occurredAt: at(4), providerStatus: 'completed' })
  return transitionProviderJob(job, {
    status: 'evaluating', occurredAt: at(5),
    resultArtifact: { artifactId: 'result-lease', artifactSha256: hash('d'), mediaType: 'video', byteSize: 123 },
  })
}

function approvalGuardRepository({ revoked = false, rightsDrift = false, headSwap = false } = {}) {
  const current = evaluatingJob()
  const next = transitionProviderJob(current, { status: 'approved', occurredAt: at(8), criticResultHash: hash('e') })
  const writes = []
  const profile = createSyntheticPresenterProfileSnapshot({
    id: 'presenter-lease', version: 2, actorIdentityId: 'identity-lease',
    avatar: { adapterId: 'controlled-avatar', adapterVersion: 'version-1', identityRef: 'avatar-lease' },
    voice: { id: 'voice-lease', version: 1, adapterId: 'controlled-tts', adapterVersion: 'version-1' },
    defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
    consent: {
      id: 'consent-lease', evidenceArtifactId: 'consent-evidence-lease', evidenceSha256: hash('9'),
      granted: true, allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
      allowedOperations: ['audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      ...(revoked ? { revokedAt: at(7) } : {}),
    },
  })
  const audit = createApiAccessAuditContext({
    clientId: 'client-lease', credentialId: 'credential-lease', workspaceId: current.workspaceId,
    environment: 'production', authenticationKind: 'bearer',
  })
  const transaction = {
    v2ProviderJob: {
      async findUnique() {
        return {
          id: current.id, workspaceId: current.workspaceId, projectId: current.projectId,
          jobHash: current.jobHash, status: current.status,
          leaseOwner: 'worker-approval', leaseToken: 'lease-approval',
          leaseExpiresAt: new Date(at(20)),
        }
      },
      async update(input) { writes.push(input); throw new Error('approval guard allowed a write') },
    },
    v2Project: { async findFirst() { return { id: current.projectId } } },
    v2TransformationBrief: { async findFirst() { return { id: 'brief-lease' } } },
    v2TransformationProviderSelection: { async findFirst() { return { id: 'selection-lease' } } },
    v2SyntheticPresenterProfile: {
      async findFirst(input) {
        if (input.select?.profileId) return { profileId: 'presenter-lease' }
        return { id: 'presenter-lease:v1' }
      },
    },
    v2SyntheticPresenterProfileHead: {
      async findUnique() {
        return {
          currentVersion: headSwap ? 3 : 2,
          currentSnapshotId: headSwap ? 'other-presenter:v2' : 'presenter-lease:v2',
          currentSnapshot: {
            id: 'presenter-lease:v2', workspaceId: current.workspaceId, profileId: profile.id,
            version: profile.version, schemaVersion: 'synthetic-presenter-profile/v1', status: profile.status,
            actorIdentityId: profile.actorIdentityId, defaultLocale: profile.defaultLocale,
            disclosure: profile.disclosure, consentSnapshotHash: profile.consent.snapshotHash,
            profileJson: stableSerialize(profile), profileHash: profile.snapshotHash,
            requestFingerprint: hash('7'), idempotencyKey: 'profile-lease-key',
            createdByClientId: audit.clientId, actorCredentialId: audit.credentialId,
            actorEnvironment: audit.environment, actorAuthenticationKind: audit.authenticationKind,
            actorContextHash: audit.contextHash, delegatedUserId: null, delegatedIdentityId: null,
            workspaceRole: null, createdAt: new Date(at(6)),
          },
        }
      },
    },
    v2MediaArtifact: {
      async findMany() {
        return [{
          id: 'audio-lease',
          currentRightsSnapshotId: rightsDrift ? 'rights-revoked' : 'rights-audio-lease',
          currentRightsSnapshot: { id: 'rights-audio-lease', snapshotHash: hash('b') },
        }]
      },
      async findFirst() { return { id: 'result-lease' } },
    },
    v2ProviderJobTransition: {
      async count() { return 1 },
      async create(input) { writes.push(input) },
    },
  }
  const repository = new PrismaProviderJobRepository({
    async $transaction(callback) { return callback(transaction) },
  })
  return {
    repository, writes,
    input: {
      current: Object.freeze({
        job: current, requestFingerprint: hash('f'), transportState: null,
        lease: Object.freeze({ owner: 'worker-approval', token: 'lease-approval', expiresAt: at(20) }),
      }),
      next, occurredAt: new Date(at(8)), transitionId: 'transition-approval',
    },
  }
}

function manualScheduler() {
  let nextId = 0
  const scheduled = new Map()
  return {
    scheduler: {
      set(delayMs, callback) {
        const id = ++nextId
        scheduled.set(id, { delayMs, callback })
        return id
      },
      clear(id) { scheduled.delete(id) },
    },
    get size() { return scheduled.size },
    fireNext() {
      const entry = scheduled.entries().next().value
      assert.ok(entry, 'expected a scheduled lease renewal')
      const [id, task] = entry
      scheduled.delete(id)
      task.callback()
      return task.delayMs
    },
  }
}

test('Prisma lease renewal is a fenced CAS that changes only lease expiry', async () => {
  let command
  const repository = new PrismaProviderJobRepository({
    v2ProviderJob: {
      async updateMany(input) { command = input; return { count: 1 } },
    },
  })
  const current = claim()
  const renewed = await repository.renewLease({
    current,
    now: new Date('2029-01-01T00:00:10.000Z'),
    leaseExpiresAt: new Date('2029-01-01T00:00:40.000Z'),
  })

  assert.deepEqual(Object.keys(command.data), ['leaseExpiresAt'])
  assert.deepEqual(command.where, {
    id: current.job.id,
    workspaceId: current.job.workspaceId,
    projectId: current.job.projectId,
    jobHash: current.job.jobHash,
    status: current.job.status,
    leaseOwner: current.lease.owner,
    leaseToken: current.lease.token,
    leaseExpiresAt: { gt: new Date('2029-01-01T00:00:10.000Z') },
  })
  assert.equal(renewed.lease.expiresAt, '2029-01-01T00:00:40.000Z')
  assert.equal(renewed.job, current.job)
})

test('Prisma lease renewal fails closed when the fenced tuple no longer matches', async () => {
  const repository = new PrismaProviderJobRepository({
    v2ProviderJob: { async updateMany() { return { count: 0 } } },
  })
  await assert.rejects(repository.renewLease({
    current: claim(),
    now: new Date('2029-01-01T00:00:10.000Z'),
    leaseExpiresAt: new Date('2029-01-01T00:00:40.000Z'),
  }), (error) => error?.code === 'VERSION_CONFLICT')
})

test('provider lease renewal uses the current clock and cleanup awaits an in-flight heartbeat', async () => {
  const timers = manualScheduler()
  const callbackGate = deferred()
  const renewalGate = deferred()
  const calls = []
  const renewedClaim = claim('2029-01-01T00:01:00.000Z')
  const running = runWithProviderJobLease({
    jobs: {
      async renewLease(input) {
        calls.push(input)
        await renewalGate.promise
        return renewedClaim
      },
    },
    claim: claim(),
    clock: () => new Date('2029-01-01T00:00:30.000Z'),
    leaseMs: 30_000,
    renewalIntervalMs: 10_000,
    scheduler: timers.scheduler,
  }, async () => {
    await callbackGate.promise
    return 'critic-complete'
  })

  assert.equal(timers.fireNext(), 10_000)
  await Promise.resolve()
  callbackGate.resolve()
  let settled = false
  void running.finally(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'cleanup must wait for the heartbeat already in flight')

  renewalGate.resolve()
  const result = await running
  assert.equal(result.value, 'critic-complete')
  assert.equal(result.claim, renewedClaim)
  assert.equal(calls[0].now.toISOString(), '2029-01-01T00:00:30.000Z')
  assert.equal(calls[0].leaseExpiresAt.toISOString(), '2029-01-01T00:01:00.000Z')
  assert.equal(timers.size, 0, 'no heartbeat may survive callback cleanup')
})

test('provider lease loss aborts long work and refuses its successful result', async () => {
  const timers = manualScheduler()
  let observedSignal
  const running = runWithProviderJobLease({
    jobs: {
      async renewLease() {
        throw new DomainError('VERSION_CONFLICT', 'lease reclaimed')
      },
    },
    claim: claim(),
    clock: () => new Date('2029-01-01T00:00:10.000Z'),
    leaseMs: 30_000,
    renewalIntervalMs: 10_000,
    scheduler: timers.scheduler,
  }, async ({ signal }) => {
    observedSignal = signal
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    return 'must-not-settle'
  })

  timers.fireNext()
  await assert.rejects(running, (error) => error?.code === 'VERSION_CONFLICT')
  assert.equal(observedSignal.aborted, true)
  assert.equal(timers.size, 0)
})

test('external cancellation reaches the callback and removes the pending heartbeat', async () => {
  const timers = manualScheduler()
  const controller = new AbortController()
  let renewals = 0
  const cancellation = new DOMException('worker stopping', 'AbortError')
  const running = runWithProviderJobLease({
    jobs: { async renewLease() { renewals += 1; return claim() } },
    claim: claim(),
    clock: () => new Date('2029-01-01T00:00:10.000Z'),
    leaseMs: 30_000,
    renewalIntervalMs: 10_000,
    signal: controller.signal,
    scheduler: timers.scheduler,
  }, async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    throw signal.reason
  })

  controller.abort(cancellation)
  await assert.rejects(running, (error) => error === cancellation)
  assert.equal(renewals, 0)
  assert.equal(timers.size, 0)
})

test('an already aborted worker never starts the callback or a heartbeat', async () => {
  const timers = manualScheduler()
  const controller = new AbortController()
  const cancellation = new DOMException('worker already stopped', 'AbortError')
  controller.abort(cancellation)
  let callbacks = 0
  let renewals = 0

  await assert.rejects(runWithProviderJobLease({
    jobs: { async renewLease() { renewals += 1; return claim() } },
    claim: claim(),
    clock: () => new Date('2029-01-01T00:00:10.000Z'),
    leaseMs: 30_000,
    signal: controller.signal,
    scheduler: timers.scheduler,
  }, async () => {
    callbacks += 1
    return 'must-not-run'
  }), (error) => error === cancellation)

  assert.equal(callbacks, 0)
  assert.equal(renewals, 0)
  assert.equal(timers.size, 0)
})

test('provider approval transaction refuses consent revoked after critic evaluation', async () => {
  const { repository, writes, input } = approvalGuardRepository({ revoked: true })
  await assert.rejects(repository.advance(input), (error) => error?.code === 'ASSET_RIGHTS_BLOCKED')
  assert.equal(writes.length, 0, 'revoked consent must block before the approved job or transition is written')
})

test('provider approval transaction refuses rights replaced after critic evaluation', async () => {
  const { repository, writes, input } = approvalGuardRepository({ rightsDrift: true })
  await assert.rejects(repository.advance(input), (error) => error?.code === 'ASSET_RIGHTS_BLOCKED')
  assert.equal(writes.length, 0, 'rights drift must block before the approved job or transition is written')
})

test('provider approval transaction refuses a head swapped to another physical snapshot', async () => {
  const { repository, writes, input } = approvalGuardRepository({ headSwap: true })
  await assert.rejects(repository.advance(input), (error) => error?.code === 'ASSET_RIGHTS_BLOCKED')
  assert.equal(writes.length, 0, 'a mismatched head identity must block before the approved write')
})

test('provider approval transaction keeps transformation jobs outside the synthetic consent guard', async () => {
  const { repository, writes, input } = approvalGuardRepository()
  input.next = {
    ...input.next,
    operation: 'relight',
    input: {},
    transformation: {
      briefId: 'brief-lease', briefHash: hash('1'), selectionId: 'selection-lease',
      selectionHash: hash('2'), providerId: 'provider-lease', capabilityId: 'relight',
    },
  }
  await assert.rejects(repository.advance(input), /approval guard allowed a write/)
  assert.equal(writes.length, 1, 'transformation approval must pass the synthetic-only guard and reach its write')
})
