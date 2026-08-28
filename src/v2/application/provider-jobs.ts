import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { ProviderAdapterError } from '../domain/provider-contract.ts'
import {
  createProviderJob,
  normalizeProviderStatus,
  transitionProviderJob,
  type ProviderJobAuthorization,
} from '../domain/provider-job.ts'
import { createSyntheticAvatarAudioRange } from '../domain/synthetic-audio-master.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ProjectWorkspaceQueryRepository } from './ports/project-workspace-query-repository.ts'
import type { ProviderJobRepository } from './ports/provider-job-repository.ts'
import type {
  ProviderAdapterRegistry,
  ProviderResultCritic,
  ProviderResultIngestor,
  ProviderSubmissionInputMaterializer,
} from './ports/provider-job-runtime.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'
import type { SyntheticAudioMasterRepository } from './ports/synthetic-audio-master-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

function identity(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function jobAuthorizationHash(body: Omit<ProviderJobAuthorization, 'authorizationHash'>) {
  return Object.freeze({ ...body, authorizationHash: calculateCanonicalHash(body) })
}

export function enqueueProviderJobService(dependencies: {
  jobs: ProviderJobRepository
  adapters: ProviderAdapterRegistry
  profiles: SyntheticProductionRepository
  audioMasters: SyntheticAudioMasterRepository
  projects: ProjectWorkspaceQueryRepository
  artifacts: MediaArtifactQueryRepository
  rights: AssetRightsRepository
  clock: () => Date
  createJobId: () => string
  createTransitionId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    profileSnapshotId: string
    operation: 'tts' | 'audio-avatar'
    adapterId: string
    adapterVersion: string
    providerInput: Readonly<Record<string, unknown>>
    sourceArtifactIds: readonly string[]
    audioMasterId?: string
    audioRange?: Readonly<{ startWordIndex: number; endWordIndex: number }>
    use: string
    market: string
    locale: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = identity(request.projectVersionId, 'projectVersionId')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Provider job actor does not belong to workspace')
    const now = dependencies.clock()
    assertDomain(Number.isFinite(now.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'enqueue-provider-job-request/v2',
      workspaceId, projectId, projectVersionId,
      profileSnapshotId: request.profileSnapshotId,
      operation: request.operation,
      adapterId: request.adapterId,
      adapterVersion: request.adapterVersion,
      providerInput: request.providerInput,
      sourceArtifactIds: request.sourceArtifactIds,
      audioMasterId: request.audioMasterId,
      audioRange: request.audioRange,
      use: request.use, market: request.market, locale: request.locale,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.jobs.findReplay({
      workspaceId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: request.idempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different provider job')
      return Object.freeze({ persisted: replay, replayed: true })
    }
    if (!dependencies.adapters.get({ adapterId: request.adapterId, adapterVersion: request.adapterVersion })) {
      throw new DomainError('PRECONDITION_REQUIRED', 'Configured provider adapter is unavailable')
    }
    const [project, profile, persistedAudioMaster] = await Promise.all([
      dependencies.projects.read({ workspaceId, projectId }),
      dependencies.profiles.readProfile({ workspaceId, snapshotId: request.profileSnapshotId }),
      request.audioMasterId
        ? dependencies.audioMasters.read({ workspaceId, projectId, audioMasterId: identity(request.audioMasterId, 'audioMasterId') })
        : Promise.resolve(null),
    ])
    assertDomain(project?.project.currentVersionId === projectVersionId && project.version?.id === projectVersionId, 'VERSION_CONFLICT', 'Provider job must target the current project version')
    if (!profile) throw new DomainError('PRECONDITION_REQUIRED', 'Synthetic presenter profile was not found')
    let providerInput = request.providerInput
    if (request.operation === 'audio-avatar') {
      assertDomain(Boolean(persistedAudioMaster && request.audioRange), 'PRECONDITION_REQUIRED', 'Audio-avatar requires a persisted audio master and word range')
      const master = persistedAudioMaster!.master
      assertDomain(master.projectVersionId === projectVersionId && master.profileSnapshotId === profile.profileSnapshotId, 'VERSION_CONFLICT', 'Audio master does not belong to the exact project version and profile')
      const range = createSyntheticAvatarAudioRange({ master, startWordIndex: request.audioRange!.startWordIndex, endWordIndex: request.audioRange!.endWordIndex })
      assertDomain(range.durationMs >= 1_000, 'INVALID_ARGUMENT', 'Audio-avatar range is shorter than the provider-safe minimum')
      assertDomain(request.sourceArtifactIds.length === 1 && request.sourceArtifactIds[0] === master.audio.artifactId, 'INVALID_ARGUMENT', 'Audio-avatar source must be the exact canonical audio master artifact')
      assertDomain(Object.keys(request.providerInput).every((key) => key === 'aspectRatio'), 'INVALID_ARGUMENT', 'Audio-avatar provider input may only select aspectRatio')
      providerInput = Object.freeze({
        audioArtifactId: master.audio.artifactId,
        durationMs: range.durationMs,
        locale: master.audio.locale,
        audioMasterId: master.id,
        audioMasterHash: master.masterHash,
        audioRange: Object.freeze({ startMs: range.startMs, endMs: range.endMs, rangeHash: range.rangeHash }),
        ...(request.providerInput.aspectRatio ? { aspectRatio: request.providerInput.aspectRatio } : {}),
      })
    } else {
      assertDomain(!request.audioMasterId && !request.audioRange, 'INVALID_ARGUMENT', 'TTS jobs cannot reference an existing audio master')
    }
    const consent = profile.snapshot.consent
    assertDomain(
      profile.snapshot.status === 'active' && consent.granted && !consent.revokedAt &&
      Date.parse(consent.expiresAt) > now.getTime() &&
      consent.allowedUses.includes(request.use) && consent.allowedMarkets.includes(request.market) &&
      consent.allowedLocales.includes(request.locale) && consent.allowedOperations.includes(request.operation),
      'ASSET_RIGHTS_BLOCKED',
      'Synthetic presenter consent does not authorize this provider operation',
    )
    assertDomain(new Set(request.sourceArtifactIds).size === request.sourceArtifactIds.length, 'INVALID_ARGUMENT', 'sourceArtifactIds contains duplicates')
    const artifacts = await Promise.all(request.sourceArtifactIds.map(async (artifactId) => {
      const artifact = await dependencies.artifacts.findById(workspaceId, identity(artifactId, 'sourceArtifactId'))
      if (!artifact || artifact.status !== 'available') throw new DomainError('ASSET_NOT_USABLE', 'Provider source artifact is unavailable')
      return artifact
    }))
    const rights = await dependencies.rights.findCurrentForArtifacts(workspaceId, request.sourceArtifactIds)
    const decisions = artifacts.map((artifact) => ({
      artifactId: artifact.id,
      ...evaluateAssetUse(rights.get(artifact.id) ?? null, {
        workspaceId,
        use: request.use,
        market: request.market,
        locale: request.locale,
        syntheticOperations: [request.operation],
      }, now),
    }))
    assertDomain(decisions.every((decision) => decision.outcome === 'allow'), 'ASSET_RIGHTS_BLOCKED', 'Provider source artifact is not authorized')
    const validUntil = [consent.expiresAt, ...decisions.flatMap((decision) => decision.validUntil ? [decision.validUntil] : [])].toSorted()[0]!
    const authorizationBody = Object.freeze({
      id: `provider-authorization-${requestFingerprint.slice(0, 24)}`,
      profileSnapshotId: profile.profileSnapshotId,
      profileSnapshotHash: profile.snapshot.snapshotHash,
      artifactDecisions: Object.freeze(decisions.map((decision) => {
        assertDomain(decision.rightsSnapshotId && decision.rightsSnapshotHash && decision.validUntil, 'ASSET_RIGHTS_BLOCKED', 'Provider source authorization is incomplete')
        return Object.freeze({ artifactId: decision.artifactId, rightsSnapshotId: decision.rightsSnapshotId, rightsSnapshotHash: decision.rightsSnapshotHash, validUntil: decision.validUntil })
      })),
      evaluatedAt: now.toISOString(),
      expiresAt: validUntil,
    })
    const job = createProviderJob({
      id: identity(dependencies.createJobId(), 'createJobId()'),
      workspaceId, projectId, originProjectVersionId: projectVersionId,
      operation: request.operation,
      adapterId: identity(request.adapterId, 'adapterId'),
      adapterVersion: identity(request.adapterVersion, 'adapterVersion'),
      providerInput,
      idempotencyKey: request.idempotencyKey,
      authorization: jobAuthorizationHash(authorizationBody),
      createdAt: now.toISOString(),
    })
    return dependencies.jobs.create({
      job,
      requestFingerprint,
      authenticationAudit: audit,
      transitionId: identity(dependencies.createTransitionId(), 'createTransitionId()'),
    })
  }
}

export function readProviderJobService(dependencies: { jobs: ProviderJobRepository }) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    jobId: string
    actor: Readonly<AuthenticatedExternalActor>
  }) {
    requireScope(request.actor, 'projects:read')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    assertDomain(request.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Provider job actor does not belong to workspace')
    const persisted = await dependencies.jobs.read({
      workspaceId,
      projectId: identity(request.projectId, 'projectId'),
      jobId: identity(request.jobId, 'jobId'),
    })
    if (!persisted) throw new DomainError('PROJECT_NOT_FOUND', 'Provider job was not found')
    return persisted
  }
}

function normalizedFailure(error: unknown) {
  if (error instanceof ProviderAdapterError) {
    return Object.freeze({
      code: error.code,
      message: 'Provider operation failed',
      retryable: error.retryable === true,
      ...(Number.isSafeInteger(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
    })
  }
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return Object.freeze({
      code: error.code,
      message: 'Provider operation failed',
      retryable: 'retryable' in error && error.retryable === true,
      ...('retryAfterMs' in error && Number.isSafeInteger(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs as number } : {}),
    })
  }
  return Object.freeze({ code: 'PROVIDER_FAILURE', message: 'Provider operation failed', retryable: false })
}

async function waitForProviderPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolveWait) => {
    const timeout = setTimeout(finish, milliseconds)
    const abort = () => finish()
    function finish() {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      resolveWait()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function runProviderJobWorkerLoop(input: {
  workerId: string
  runNext: (workerId: string, signal?: AbortSignal) => Promise<unknown | null>
  signal: AbortSignal
  pollIntervalMs?: number
  onIterationError?: () => void
  wait?: (signal: AbortSignal, milliseconds: number) => Promise<void>
}): Promise<void> {
  const workerId = identity(input.workerId, 'workerId')
  const pollIntervalMs = input.pollIntervalMs ?? 1_000
  assertDomain(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 100 && pollIntervalMs <= 60_000, 'INVALID_ARGUMENT', 'pollIntervalMs is invalid')
  const wait = input.wait ?? waitForProviderPoll
  while (!input.signal.aborted) {
    try {
      const outcome = await input.runNext(workerId, input.signal)
      if (!outcome) await wait(input.signal, pollIntervalMs)
    } catch {
      input.onIterationError?.()
      await wait(input.signal, pollIntervalMs)
    }
  }
}

export function runProviderJobWorkerOnce(dependencies: {
  jobs: ProviderJobRepository
  adapters: ProviderAdapterRegistry
  materializer: ProviderSubmissionInputMaterializer
  ingestor: ProviderResultIngestor
  critic: ProviderResultCritic
  clock: () => Date
  createLeaseToken: () => string
  createTransitionId: () => string
  leaseMs?: number
}) {
  return async function execute(workerId: string, signal?: AbortSignal) {
    const now = dependencies.clock()
    const leaseMs = dependencies.leaseMs ?? 30_000
    const claimed = await dependencies.jobs.claimNext({
      workerId: identity(workerId, 'workerId'),
      leaseToken: identity(dependencies.createLeaseToken(), 'leaseToken'),
      now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
    })
    if (!claimed) return null
    const job = claimed.job
    let next
    try {
      const adapter = dependencies.adapters.get({ adapterId: job.adapterId, adapterVersion: job.adapterVersion })
      if (!adapter) throw new DomainError('PRECONDITION_REQUIRED', 'Configured provider adapter is unavailable')
      if (job.status === 'planned') {
        const capabilities = await adapter.getCapabilities()
        const durationMs = typeof job.input.durationMs === 'number' ? job.input.durationMs : undefined
        const locale = typeof job.input.locale === 'string' ? job.input.locale : undefined
        assertDomain(Date.parse(capabilities.expiresAt) > now.getTime(), 'PRECONDITION_REQUIRED', 'Provider capabilities are stale')
        assertDomain(capabilities.operations.includes(job.operation), 'PRECONDITION_REQUIRED', 'Provider operation is unsupported')
        assertDomain(!locale || !capabilities.locales || capabilities.locales.includes(locale), 'PRECONDITION_REQUIRED', 'Provider locale is unsupported')
        assertDomain(!durationMs || durationMs / 1_000 >= capabilities.duration.minSeconds && durationMs / 1_000 <= capabilities.duration.maxSeconds, 'PRECONDITION_REQUIRED', 'Provider duration is unsupported')
        if (capabilities.completion !== 'synchronous') {
          assertDomain(typeof adapter.getStatus === 'function' && typeof adapter.retrieve === 'function', 'PRECONDITION_REQUIRED', 'Asynchronous provider adapter must implement polling and retrieval')
        }
        if (capabilities.supportsCancellation) {
          assertDomain(typeof adapter.cancel === 'function', 'PRECONDITION_REQUIRED', 'Provider declares cancellation support without an implementation')
        }
        if (capabilities.completion === 'webhook' || capabilities.completion === 'both') {
          assertDomain(typeof adapter.verifyWebhook === 'function', 'PRECONDITION_REQUIRED', 'Provider declares webhook completion without verification')
        }
        next = transitionProviderJob(job, { status: 'estimated', occurredAt: now.toISOString(), estimate: await adapter.estimate(job.input) })
      } else if (job.status === 'estimated') {
        const submissionInput = await dependencies.materializer.materialize({ job, signal })
        const submission = await adapter.submit(submissionInput, {
          workspaceId: job.workspaceId,
          projectVersionId: job.originProjectVersionId,
          operationId: job.id,
          idempotencyKey: job.idempotencyKey,
          signal,
        })
        if (submission.kind === 'completed') {
          assertDomain(Number.isFinite(Date.parse(submission.bundle.completedAt)), 'INVALID_ARGUMENT', 'Provider result bundle completedAt is invalid')
          const artifact = await dependencies.ingestor.ingest({ job, providerResult: submission.bundle.result, signal })
          next = transitionProviderJob(job, { status: 'submitted', occurredAt: now.toISOString(), providerJobId: submission.bundle.providerJobRef, providerStatus: 'completed', resultArtifact: artifact })
        } else {
          next = transitionProviderJob(job, { status: 'submitted', occurredAt: now.toISOString(), providerJobId: submission.providerJobId })
        }
      } else if (['submitted', 'queued', 'processing', 'suspected-stalled'].includes(job.status)) {
        if (job.providerStatus === 'completed') {
          assertDomain(Boolean(job.resultArtifact), 'PERSISTENCE_CONFLICT', 'Synchronously completed provider job lost its ingested result artifact')
          next = transitionProviderJob(job, { status: 'retrieving', occurredAt: now.toISOString() })
        } else {
          assertDomain(typeof adapter.getStatus === 'function', 'PRECONDITION_REQUIRED', 'Provider adapter cannot be polled')
          const providerStatus = await adapter.getStatus(job.providerJobId!, signal)
          const status = normalizeProviderStatus(providerStatus)
          if (status === 'failed') {
            next = transitionProviderJob(job, { status, occurredAt: now.toISOString(), providerStatus, normalizedError: { code: 'PROVIDER_REPORTED_FAILURE', message: 'Provider reported a terminal failure', retryable: false } })
          } else {
            next = transitionProviderJob(job, { status, occurredAt: now.toISOString(), providerStatus })
          }
        }
      } else if (job.status === 'retrieving') {
        let artifact = job.resultArtifact
        if (!artifact) {
          assertDomain(typeof adapter.retrieve === 'function', 'PRECONDITION_REQUIRED', 'Provider adapter has no retrieval path')
          const providerResult = await adapter.retrieve(job.providerJobId!, signal)
          artifact = await dependencies.ingestor.ingest({ job, providerResult, signal })
        }
        next = transitionProviderJob(job, { status: 'evaluating', occurredAt: now.toISOString(), resultArtifact: artifact })
      } else if (job.status === 'evaluating') {
        const result = await dependencies.critic.evaluate({ job, artifact: job.resultArtifact! })
        next = transitionProviderJob(job, { status: result.approved ? 'approved' : 'rejected', occurredAt: now.toISOString(), criticResultHash: result.resultHash })
      } else {
        throw new DomainError('VERSION_CONFLICT', `Provider job status ${job.status} is not executable`)
      }
    } catch (error) {
      if (signal?.aborted) throw error
      next = transitionProviderJob(job, { status: 'failed', occurredAt: now.toISOString(), normalizedError: normalizedFailure(error) })
    }
    return dependencies.jobs.advance({
      current: claimed,
      next,
      transitionId: identity(dependencies.createTransitionId(), 'createTransitionId()'),
      occurredAt: now,
    })
  }
}
