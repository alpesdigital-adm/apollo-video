import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { ProviderAdapterError, type ProviderObservedCost } from '../domain/provider-contract.ts'
import {
  acknowledgeProviderJobCancellation,
  awaitProviderJobCallback,
  providerJobAttemptsExhausted,
  providerJobDeadlineExceeded,
  scheduleProviderJobAttempt,
  type ProviderJobTransportState,
} from '../domain/provider-job-transport.ts'
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
import { runWithProviderJobLease } from './with-provider-job-lease.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'
import type { SyntheticAudioMasterRepository } from './ports/synthetic-audio-master-repository.ts'
import type { ProviderExecutionProvenanceRepository } from './ports/provider-execution-provenance-repository.ts'
import type { ProviderResultArtifactRepository } from './ports/provider-result-artifact-repository.ts'
import { bindProviderTransportEvidence, createProviderExecutionReceipt } from './provider-transport-observation.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

function identity(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function observedCostFromProviderResult(value: unknown): Readonly<ProviderObservedCost> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const observedCost = (value as Readonly<Record<string, unknown>>).observedCost
  if (observedCost === undefined) return undefined
  assertDomain(
    typeof observedCost === 'object' && observedCost !== null &&
      typeof (observedCost as Readonly<Record<string, unknown>>).currency === 'string' &&
      /^[A-Z]{3}$/.test(String((observedCost as Readonly<Record<string, unknown>>).currency)) &&
      Number.isSafeInteger((observedCost as Readonly<Record<string, unknown>>).costMinorUnits) &&
      Number((observedCost as Readonly<Record<string, unknown>>).costMinorUnits) >= 0,
    'PERSISTENCE_CONFLICT',
    'Provider result observed cost is invalid',
  )
  return Object.freeze({
    currency: String((observedCost as Readonly<Record<string, unknown>>).currency),
    costMinorUnits: Number((observedCost as Readonly<Record<string, unknown>>).costMinorUnits),
  })
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
  resolveAvatarCriticBinding?: (input: {
    workspaceId: string
    projectId: string
    profileSnapshotId: string
    audioMaster: Readonly<import('../domain/synthetic-audio-master.ts').SyntheticAudioMaster>
    audioRange: Readonly<import('../domain/synthetic-audio-master.ts').SyntheticAvatarAudioRange>
    use: string
    market: string
    locale: string
  }) => Promise<Readonly<{
    blockId: string
    scriptText: string
    scriptHash: string
    profileSnapshotId: string
    expectedDurationMs: number
    alignmentArtifactId: string | null
    use: string
    market: string
    locale: string
  }>>
  resolveTtsCriticBinding?: (input: {
    workspaceId: string
    projectId: string
    profileSnapshotId: string
    planId: string
    blockId: string
    use: string
    market: string
    locale: string
  }) => Promise<Readonly<{
    planId: string
    blockId: string
    scriptText: string
    scriptHash: string
    profileSnapshotId: string
    use: string
    market: string
    locale: string
  }>>
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
    /** Trusted application binding; public provider-job payloads cannot set it. */
    criticBinding?: Readonly<{
      planId?: string
      blockId: string
      scriptText: string
      scriptHash: string
      profileSnapshotId: string
      expectedDurationMs?: number
      alignmentArtifactId?: string | null
      use: string
      market: string
      locale: string
    }>
    sourceArtifactIds: readonly string[]
    audioMasterId?: string
    audioRange?: Readonly<{ startWordIndex: number; endWordIndex: number }>
    scriptPlanId?: string
    scriptBlockId?: string
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
      schemaVersion: 'enqueue-provider-job-request/v3',
      workspaceId, projectId, projectVersionId,
      profileSnapshotId: request.profileSnapshotId,
      operation: request.operation,
      adapterId: request.adapterId,
      adapterVersion: request.adapterVersion,
      providerInput: request.providerInput,
      criticBinding: request.criticBinding,
      sourceArtifactIds: request.sourceArtifactIds,
      audioMasterId: request.audioMasterId,
      audioRange: request.audioRange,
      scriptPlanId: request.scriptPlanId,
      scriptBlockId: request.scriptBlockId,
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
      assertDomain(Boolean(dependencies.resolveAvatarCriticBinding), 'PRECONDITION_REQUIRED', 'Audio-avatar critic context resolver is unavailable')
      const criticBinding = await dependencies.resolveAvatarCriticBinding!({
        workspaceId,
        projectId,
        profileSnapshotId: profile.profileSnapshotId,
        audioMaster: master,
        audioRange: range,
        use: request.use,
        market: request.market,
        locale: request.locale,
      })
      providerInput = Object.freeze({
        audioArtifactId: master.audio.artifactId,
        durationMs: range.durationMs,
        locale: master.audio.locale,
        audioMasterId: master.id,
        audioMasterHash: master.masterHash,
        audioRange: Object.freeze({ startMs: range.startMs, endMs: range.endMs, rangeHash: range.rangeHash }),
        criticBinding,
        ...(request.providerInput.aspectRatio ? { aspectRatio: request.providerInput.aspectRatio } : {}),
      })
    } else {
      assertDomain(!request.audioMasterId && !request.audioRange, 'INVALID_ARGUMENT', 'TTS jobs cannot reference an existing audio master')
      const criticBinding = request.criticBinding ?? (
        request.scriptPlanId && request.scriptBlockId && dependencies.resolveTtsCriticBinding
          ? await dependencies.resolveTtsCriticBinding({
              workspaceId,
              projectId,
              profileSnapshotId: profile.profileSnapshotId,
              planId: request.scriptPlanId,
              blockId: request.scriptBlockId,
              use: request.use,
              market: request.market,
              locale: request.locale,
            })
          : undefined
      )
      assertDomain(Boolean(criticBinding), 'PRECONDITION_REQUIRED', 'TTS jobs must reference a persisted synthetic script plan and block')
      assertDomain(
        criticBinding!.profileSnapshotId === profile.profileSnapshotId,
        'PERSISTENCE_CONFLICT',
        'TTS critic binding does not match the persisted profile',
      )
      providerInput = Object.freeze({
        ...request.providerInput,
        text: criticBinding!.scriptText,
        scriptHash: criticBinding!.scriptHash,
        locale: request.locale,
        criticBinding,
      })
    }
    const head = await dependencies.profiles.readProfileHead({ workspaceId, profileId: profile.snapshot.id })
    const consent = profile.snapshot.consent
    const currentConsent = head?.current.snapshot.consent
    assertDomain(
      profile.snapshot.status === 'active' && consent.granted && !consent.revokedAt &&
      Date.parse(consent.expiresAt) > now.getTime() &&
      consent.allowedUses.includes(request.use) && consent.allowedMarkets.includes(request.market) &&
      consent.allowedLocales.includes(request.locale) && consent.allowedOperations.includes(request.operation),
      'ASSET_RIGHTS_BLOCKED',
      'Synthetic presenter consent does not authorize this provider operation',
    )
    assertDomain(
      Boolean(head) && head!.current.snapshot.status === 'active' && currentConsent!.granted && !currentConsent!.revokedAt &&
      Date.parse(currentConsent!.expiresAt) > now.getTime() &&
      currentConsent!.allowedUses.includes(request.use) && currentConsent!.allowedMarkets.includes(request.market) &&
      currentConsent!.allowedLocales.includes(request.locale) && currentConsent!.allowedOperations.includes(request.operation),
      'ASSET_RIGHTS_BLOCKED',
      'Current synthetic presenter consent does not authorize this provider operation',
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

/**
 * Statuses a retryable failure may return to `estimated` from. `submitting` is
 * absent on purpose: a submission whose outcome is unknown may already have
 * been accepted and charged, so resubmitting it would risk paying twice.
 */
const ALLOWED_RETRY_SOURCE_STATUSES: readonly string[] = Object.freeze([
  'submitted', 'queued', 'processing', 'suspected-stalled', 'retrieving',
])

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
  /**
   * Host admission gate, asked once per iteration. A closed gate idles at the same
   * poll interval instead of exiting: the worker keeps its connections and comes
   * back the moment the gate reopens, which is what makes stopping admission a
   * cheap operator move rather than a restart.
   *
   * It is asked before the claim and never after: provider work already admitted
   * is never abandoned by the gate, because a submitted provider job may already
   * have been charged.
   */
  admits?: () => Promise<boolean>
}): Promise<void> {
  const workerId = identity(input.workerId, 'workerId')
  const pollIntervalMs = input.pollIntervalMs ?? 1_000
  assertDomain(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 100 && pollIntervalMs <= 60_000, 'INVALID_ARGUMENT', 'pollIntervalMs is invalid')
  const wait = input.wait ?? waitForProviderPoll
  while (!input.signal.aborted) {
    try {
      if (input.admits && !(await input.admits())) {
        await wait(input.signal, pollIntervalMs)
        continue
      }
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
  provenance: ProviderExecutionProvenanceRepository
  resultArtifacts: ProviderResultArtifactRepository
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
    let activeClaim = claimed
    let job = claimed.job
    let next
    let advanceAt = now
    // Transport state is advanced in the same transaction as the transition, so
    // a job can never be recorded as retrying without its schedule moving, nor
    // parked on a wait whose transition never committed.
    let transportState: Readonly<ProviderJobTransportState> | undefined
    let evidencePersistenceFailed = false
    const state = claimed.transportState ?? null
    try {
      const adapter = dependencies.adapters.get({ adapterId: job.adapterId, adapterVersion: job.adapterVersion })
      if (!adapter) throw new DomainError('PRECONDITION_REQUIRED', 'Configured provider adapter is unavailable')

      // A job past its deadline fails closed. Waiting forever for a callback
      // that is not coming is how a queue silently stops being a queue.
      if (state && providerJobDeadlineExceeded(state, now.toISOString())) {
        next = transitionProviderJob(job, {
          status: 'expired',
          occurredAt: now.toISOString(),
          normalizedError: { code: 'PROVIDER_DEADLINE_EXCEEDED', message: 'Provider did not finish before the durable deadline', retryable: false },
        })
      } else if (state?.cancellation === 'requested') {
        // The worker holds the lease, so the worker is what talks to the
        // provider. A route calling cancel directly would race it.
        if (typeof adapter.cancel === 'function' && job.providerJobId) {
          await adapter.cancel(job.providerJobId, signal)
        }
        next = transitionProviderJob(job, { status: 'canceled', occurredAt: now.toISOString() })
        transportState = acknowledgeProviderJobCancellation({ state, occurredAt: now.toISOString() })
      } else if (job.status === 'planned') {
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
        const intent = transitionProviderJob(job, { status: 'submitting', occurredAt: now.toISOString() })
        activeClaim = await dependencies.jobs.beginSubmission({
          current: activeClaim,
          next: intent,
          transitionId: identity(dependencies.createTransitionId(), 'createTransitionId()'),
          occurredAt: now,
        })
        job = activeClaim.job
        const observeTransport = async (observation: Readonly<import('./ports/provider-execution-provenance-repository.ts').ProviderTransportObservation>) => {
          try {
            await dependencies.provenance.recordEvidence({ evidence: bindProviderTransportEvidence({
              observation, workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id,
              attempt: job.attempt, inputHash: job.inputHash, authorizationHash: job.authorization.authorizationHash,
              jobHash: job.jobHash,
              leaseOwner: activeClaim.lease.owner, leaseToken: activeClaim.lease.token,
            }) })
          } catch (error) {
            evidencePersistenceFailed = true
            throw error
          }
        }
        const submitted = await runWithProviderJobLease({ jobs: dependencies.jobs, claim: activeClaim, clock: dependencies.clock, leaseMs, signal },
          async ({ signal: submitSignal }) => {
            const submission = await adapter.submit(submissionInput, {
              workspaceId: job.workspaceId, projectVersionId: job.originProjectVersionId,
              operationId: job.id, idempotencyKey: job.idempotencyKey,
              signal: submitSignal, observeTransport,
            })
            if (submission.kind !== 'completed') return Object.freeze({ submission })
            assertDomain(Number.isFinite(Date.parse(submission.bundle.completedAt)), 'INVALID_ARGUMENT', 'Provider result bundle completedAt is invalid')
            return Object.freeze({ submission, artifact: await dependencies.ingestor.ingest({ job, providerResult: submission.bundle.result, signal: submitSignal }) })
          })
        activeClaim = submitted.claim
        advanceAt = dependencies.clock()
        const submission = submitted.value.submission
        if (submission.kind === 'completed') {
          assertDomain('artifact' in submitted.value, 'PERSISTENCE_CONFLICT', 'Synchronous provider result was not ingested')
          const artifact = submitted.value.artifact
          next = transitionProviderJob(job, {
            status: 'submitted', occurredAt: advanceAt.toISOString(),
            providerJobId: submission.bundle.providerJobRef, providerStatus: 'completed', resultArtifact: artifact,
            // The cost the provider actually reported, never the estimate.
            ...(submission.bundle.observedCost ? { observedCost: submission.bundle.observedCost } : {}),
          })
        } else {
          next = transitionProviderJob(job, { status: 'submitted', occurredAt: advanceAt.toISOString(), providerJobId: submission.providerJobId })
        }
      } else if (job.status === 'submitting') {
        const submitCandidates = (await dependencies.provenance.listEvidenceByJob({ workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id }))
          .filter((evidence) => evidence.attempt === job.attempt && evidence.phase === 'submit' && evidence.adapterId === job.adapterId && evidence.adapterVersion === job.adapterVersion && evidence.inputHash === job.inputHash && evidence.authorizationHash === job.authorization.authorizationHash && evidence.jobHash === job.jobHash)
        assertDomain(submitCandidates.length <= 1, 'PERSISTENCE_CONFLICT', 'Provider submission has ambiguous transport evidence')
        const submitEvidence = submitCandidates[0]
        const completion = (await adapter.getCapabilities(signal)).completion
        if (submitEvidence?.providerJobRef && completion !== 'synchronous') {
          next = transitionProviderJob(job, { status: 'submitted', occurredAt: now.toISOString(), providerJobId: submitEvidence.providerJobRef })
        } else if (submitEvidence?.providerJobRef && completion === 'synchronous') {
          const records = await dependencies.resultArtifacts.listByJob({ workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id })
          const primary = records.find((record) => record.role === 'primary-audio' || record.role === 'primary-video')
          const complete = Boolean(primary?.recordHash) && records.every((record) => record.recordHash !== undefined && record.providerJobRef === submitEvidence.providerJobRef && record.adapterId === job.adapterId && record.adapterVersion === job.adapterVersion && record.adapterConfigHash === submitEvidence.adapterConfigHash && record.inputHash === job.inputHash && record.authorizationHash === job.authorization.authorizationHash)
          if (complete && primary) {
            next = transitionProviderJob(job, {
              status: 'submitted', occurredAt: now.toISOString(), providerJobId: submitEvidence.providerJobRef,
              providerStatus: 'completed', resultArtifact: { artifactId: primary.artifactId, artifactSha256: primary.artifactSha256, mediaType: primary.mediaType === 'audio' ? 'audio' : 'video', byteSize: primary.byteSize },
              ...(primary.observedCost ? { observedCost: primary.observedCost } : {}),
            })
          } else {
            next = transitionProviderJob(job, { status: 'failed', occurredAt: now.toISOString(), normalizedError: { code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN', message: 'Provider submission outcome requires reconciliation', retryable: false } })
          }
        } else {
          next = transitionProviderJob(job, {
            status: 'failed', occurredAt: now.toISOString(),
            normalizedError: { code: 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN', message: 'Provider submission outcome requires reconciliation', retryable: false },
          })
        }
      } else if (['submitted', 'queued', 'processing', 'suspected-stalled'].includes(job.status)) {
        if (job.providerStatus === 'completed') {
          assertDomain(Boolean(job.resultArtifact), 'PERSISTENCE_CONFLICT', 'Synchronously completed provider job lost its ingested result artifact')
          next = transitionProviderJob(job, { status: 'retrieving', occurredAt: now.toISOString() })
        } else if (state?.transport === 'webhook' && state.waitKind !== 'callback') {
          // A webhook provider is not polled into completion: it pushes. The
          // job parks on a durable wait whose wake-up is the deadline, so an
          // absent callback is reaped by this same loop rather than by a timer
          // nobody owns.
          next = transitionProviderJob(job, { status: job.status === 'submitted' ? 'queued' : job.status, occurredAt: now.toISOString() })
          transportState = awaitProviderJobCallback({ state, occurredAt: now.toISOString() })
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
        let observedCost: Readonly<ProviderObservedCost> | undefined
        if (!artifact) {
          assertDomain(typeof adapter.retrieve === 'function', 'PRECONDITION_REQUIRED', 'Provider adapter has no retrieval path')
          const retrieved = await runWithProviderJobLease({ jobs: dependencies.jobs, claim: activeClaim, clock: dependencies.clock, leaseMs, signal },
            async ({ signal: retrieveSignal }) => {
              const providerResult = await adapter.retrieve!(job.providerJobId!, retrieveSignal, {
                signal: retrieveSignal,
                observeTransport: async (observation) => {
                  try {
                    await dependencies.provenance.recordEvidence({ evidence: bindProviderTransportEvidence({
                      observation, workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id,
                      attempt: job.attempt, inputHash: job.inputHash, authorizationHash: job.authorization.authorizationHash,
                      jobHash: job.jobHash,
                      leaseOwner: activeClaim.lease.owner, leaseToken: activeClaim.lease.token,
                    }) })
                  } catch (error) {
                    evidencePersistenceFailed = true
                    throw error
                  }
                },
              })
              const ingested = await dependencies.ingestor.ingest({ job, providerResult, signal: retrieveSignal })
              return Object.freeze({ providerResult, artifact: ingested })
            })
          activeClaim = retrieved.claim
          advanceAt = dependencies.clock()
          observedCost = observedCostFromProviderResult(retrieved.value.providerResult)
          artifact = retrieved.value.artifact
        }
        if (!job.resultArtifact) {
          // Persist the canonical result on the job first. A later leased tick
          // builds the receipt against this state and only then enters critic.
          next = transitionProviderJob(job, { status: 'retrieving', occurredAt: advanceAt.toISOString(), resultArtifact: artifact, ...(observedCost ? { observedCost } : {}) })
        } else {
          const capabilities = await adapter.getCapabilities(signal)
          const allEvidence = (await dependencies.provenance.listEvidenceByJob({ workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id }))
            .filter((evidence) => evidence.attempt === job.attempt)
          const submit = allEvidence.filter((evidence) => evidence.phase === 'submit')
          const retrieveCandidates = allEvidence.filter((evidence) => evidence.phase === 'retrieve')
          assertDomain(submit.length === 1 && (capabilities.completion === 'synchronous' ? retrieveCandidates.length === 0 : retrieveCandidates.length >= 1), 'PERSISTENCE_CONFLICT', 'Provider execution transport evidence is incomplete or ambiguous')
          assertDomain(retrieveCandidates.every((evidence) => evidence.adapterId === job.adapterId && evidence.adapterVersion === job.adapterVersion && evidence.adapterConfigHash === submit[0]!.adapterConfigHash && evidence.inputHash === job.inputHash && evidence.authorizationHash === job.authorization.authorizationHash && evidence.providerJobRef === job.providerJobId), 'PERSISTENCE_CONFLICT', 'Provider retrieve evidence diverges from the durable effect')
          const retrieve = retrieveCandidates.toSorted((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id)).at(-1)
          const records = await dependencies.resultArtifacts.listByJob({ workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id })
          assertDomain(records.length > 0 && records.every((record) => record.recordHash !== undefined), 'PERSISTENCE_CONFLICT', 'Provider execution result ledger is unattested')
          const receipt = createProviderExecutionReceipt({
            schemaVersion: 'provider-execution-receipt/v1', id: `provider-receipt-${calculateCanonicalHash({ workspaceId: job.workspaceId, jobId: job.id }).slice(0, 48)}`,
            workspaceId: job.workspaceId, projectId: job.projectId, jobId: job.id, attempt: job.attempt,
            runtimeClass: [...submit, ...retrieveCandidates].every((evidence) => evidence.runtimeClass === 'live') ? 'live' : 'controlled',
            adapterId: job.adapterId, adapterVersion: job.adapterVersion, adapterConfigHash: submit[0]!.adapterConfigHash,
            inputHash: job.inputHash, authorizationHash: job.authorization.authorizationHash, providerJobRef: job.providerJobId!,
            leaseOwner: activeClaim.lease.owner, leaseToken: activeClaim.lease.token,
            submitEvidenceId: submit[0]!.id, submitEvidenceHash: submit[0]!.evidenceHash,
            ...(retrieve ? { retrieveEvidenceId: retrieve.id, retrieveEvidenceHash: retrieve.evidenceHash } : {}),
            results: records.map((record) => Object.freeze({ resultRecordId: record.id, resultRecordHash: record.recordHash!, role: record.role, artifactId: record.artifactId, artifactSha256: record.artifactSha256, byteSize: record.byteSize })),
            createdAt: dependencies.clock().toISOString(),
          })
          await dependencies.provenance.createReceipt({ receipt })
          advanceAt = dependencies.clock()
          next = transitionProviderJob(job, { status: 'evaluating', occurredAt: advanceAt.toISOString(), resultArtifact: artifact })
        }
      } else if (job.status === 'evaluating') {
        const evaluated = await runWithProviderJobLease({
          jobs: dependencies.jobs,
          claim: activeClaim,
          clock: dependencies.clock,
          leaseMs,
          signal,
        }, async ({ signal: criticSignal }) => {
          try {
            return Object.freeze({
              ok: true as const,
              value: await dependencies.critic.evaluate({ job, artifact: job.resultArtifact!, signal: criticSignal }),
            })
          } catch (error) {
            return Object.freeze({ ok: false as const, error })
          }
        })
        activeClaim = evaluated.claim
        advanceAt = dependencies.clock()
        if (!evaluated.value.ok) throw evaluated.value.error
        next = transitionProviderJob(job, {
          status: evaluated.value.value.approved ? 'approved' : 'rejected',
          occurredAt: advanceAt.toISOString(),
          criticResultHash: evaluated.value.value.resultHash,
        })
      } else {
        throw new DomainError('VERSION_CONFLICT', `Provider job status ${job.status} is not executable`)
      }
    } catch (error) {
      if (signal?.aborted) throw error
      // The external effect completed but its server-owned proof did not
      // persist. Keep `submitting`/`retrieving` intact for reconciliation;
      // turning this into a retry would risk a second paid submission.
      if (evidencePersistenceFailed) throw error
      if (error instanceof DomainError && error.code === 'VERSION_CONFLICT' && job.status === 'evaluating') throw error
      // Evaluation may outlive the claim's original timestamp. Persist its
      // terminal/retry decision at the time the renewed claim actually
      // finished, never at the time the worker first entered this iteration.
      if (job.status === 'evaluating') advanceAt = dependencies.clock()
      const failure = normalizedFailure(error)
      // A retryable transport failure is not the end of the job. It goes back
      // for another submission with the schedule advanced, and the provider's
      // Retry-After wins over our own backoff whenever it is longer — honouring
      // a shorter delay than the provider asked for is how a 429 becomes a ban.
      const retryable =
        failure.retryable &&
        Boolean(state) &&
        !providerJobAttemptsExhausted(state!) &&
        !providerJobDeadlineExceeded(state!, advanceAt.toISOString()) &&
        ALLOWED_RETRY_SOURCE_STATUSES.includes(job.status)
      if (retryable) {
        const resumeKnownProviderEffect = Boolean(job.providerJobId) && ['submitted', 'queued', 'processing', 'suspected-stalled', 'retrieving'].includes(job.status)
        next = transitionProviderJob(job, {
          status: resumeKnownProviderEffect ? job.status : 'estimated',
          occurredAt: advanceAt.toISOString(),
          estimate: job.estimate ?? { currency: 'USD', costMinorUnits: 0, estimatedLatencyMs: 0 },
          normalizedError: failure,
        })
        transportState = scheduleProviderJobAttempt({
          state: state!,
          waitKind: 'retry',
          occurredAt: advanceAt.toISOString(),
          retryAfterMs: failure.retryAfterMs ?? null,
        })
      } else {
        next = transitionProviderJob(job, { status: 'failed', occurredAt: advanceAt.toISOString(), normalizedError: failure })
      }
    }
    return dependencies.jobs.advance({
      current: activeClaim,
      next,
      transitionId: identity(dependencies.createTransitionId(), 'createTransitionId()'),
      occurredAt: advanceAt,
      ...(transportState ? { transportState } : {}),
    })
  }
}
