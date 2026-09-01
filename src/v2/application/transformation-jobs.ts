import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  classifyProviderCallbackReplay,
  verifyProviderCallback,
  type ProviderCallbackRejection,
} from '../domain/provider-job-callback.ts'
import {
  acknowledgeProviderJobCancellation,
  awaitProviderJobCallback,
  createProviderJobTransportState,
  DEFAULT_PROVIDER_JOB_RETRY_POLICY,
  requestProviderJobCancellation,
  requestProviderJobResume,
  transportsForCompletion,
  wakeProviderJob,
  type ProviderJobTransport,
} from '../domain/provider-job-transport.ts'
import {
  createProviderJob,
  TERMINAL_PROVIDER_JOB_STATUSES,
  transitionProviderJob,
  type ProviderJobAuthorization,
} from '../domain/provider-job.ts'
import {
  assertTransformationBrief,
  projectTransformationProviderInput,
} from '../domain/transformation-brief.ts'
import { TRANSFORMATION_MODE_CONTRACTS } from '../domain/transformation-mode-registry.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { NoveltyBudgetRepository } from './ports/novelty-budget-repository.ts'
import type { ProjectWorkspaceQueryRepository } from './ports/project-workspace-query-repository.ts'
import type { ProviderJobRepository } from './ports/provider-job-repository.ts'
import type { ProviderAdapterRegistry } from './ports/provider-job-runtime.ts'
import type { TransformationProviderRegistryRepository } from './ports/transformation-provider-registry-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const DEFAULT_DEADLINE_MS = 60 * 60 * 1_000

function identity(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function sealAuthorization(body: Omit<ProviderJobAuthorization, 'authorizationHash'>) {
  return Object.freeze({ ...body, authorizationHash: calculateCanonicalHash(body) })
}

/**
 * Pick the transport for a job.
 *
 * The provider's declared completion mode decides what is even possible; the
 * policy picks among what remains. A caller cannot choose: letting an API
 * client name the transport would let it ask for a webhook from a provider that
 * has no way to send one, and the job would wait until its deadline for a
 * callback that was never going to arrive.
 */
function selectTransport(input: {
  completion: Parameters<typeof transportsForCompletion>[0]
  preferred?: ProviderJobTransport
  webhookConfigured: boolean
}): ProviderJobTransport {
  const available = transportsForCompletion(input.completion)
  if (input.preferred && available.includes(input.preferred)) {
    assertDomain(
      input.preferred !== 'webhook' || input.webhookConfigured,
      'PRECONDITION_REQUIRED',
      'The webhook transport needs an inbound callback secret for this provider',
    )
    return input.preferred
  }
  const usable = available.filter((transport) => transport !== 'webhook' || input.webhookConfigured)
  const chosen = usable[0]
  if (!chosen) throw new DomainError('PRECONDITION_REQUIRED', 'No transport can carry this provider')
  return chosen
}

/**
 * Request a transformation from a persisted `TransformationBrief`.
 *
 * The provider payload is **projected** from the brief, never accepted from the
 * caller. `projectTransformationProviderInput` decides what crosses the
 * boundary, and project, story, rights and identity ids deliberately stay
 * inside Apollo. A client that could hand us `providerInput` could send the
 * provider anything it liked while the brief said something else — and the
 * brief is what the critic later judges the result against.
 */
export function requestTransformationJobService(dependencies: {
  jobs: ProviderJobRepository
  registry: TransformationProviderRegistryRepository
  adapters: ProviderAdapterRegistry
  projects: ProjectWorkspaceQueryRepository
  artifacts: MediaArtifactQueryRepository
  rights: AssetRightsRepository
  /**
   * The novelty preflight. Required: a transformation that no persisted
   * decision admits must not be submitted, because the cheapest transformation
   * is the one that was never paid for.
   */
  novelty: NoveltyBudgetRepository
  clock: () => Date
  createJobId: () => string
  createTransitionId: () => string
  webhookConfigured?: (providerId: string) => boolean
  deadlineMs?: number
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    briefId: string
    selectionId: string
    use: string
    market: string
    locale: string
    preferredTransport?: ProviderJobTransport
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Transformation actor does not belong to workspace')
    const now = dependencies.clock()
    assertDomain(Number.isFinite(now.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')

    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'request-transformation-job/v1',
      workspaceId,
      projectId,
      briefId: request.briefId,
      selectionId: request.selectionId,
      use: request.use,
      market: request.market,
      locale: request.locale,
      preferredTransport: request.preferredTransport ?? null,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.jobs.findReplay({
      workspaceId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: request.idempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different transformation request')
      }
      return Object.freeze({ persisted: replay, replayed: true })
    }

    const brief = await dependencies.registry.readBrief({ workspaceId, projectId, briefId: identity(request.briefId, 'briefId') })
    if (!brief) throw new DomainError('ASSET_NOT_FOUND', 'TransformationBrief was not found')
    assertTransformationBrief(brief)

    const selections = await dependencies.registry.listSelections({ workspaceId, projectId, briefId: brief.id })
    const selection = selections.find((candidate) => candidate.id === request.selectionId)
    if (!selection) throw new DomainError('ASSET_NOT_FOUND', 'Provider routing selection was not found for this brief')
    // The selection must be about *this* brief, byte for byte. A selection made
    // against an earlier revision of the brief would route work that no longer
    // matches the editorial intent it was authorised under.
    assertDomain(selection.briefHash === brief.briefHash, 'VERSION_CONFLICT', 'Routing selection was made against a different brief revision')
    assertDomain(Boolean(selection.selectedProviderId && selection.selectedCapabilityId), 'PRECONDITION_REQUIRED', 'Routing selection found no eligible provider')

    const providers = await dependencies.registry.listProviders({ workspaceId })
    const provider = providers.find((candidate) => candidate.id === selection.selectedProviderId)
    if (!provider) throw new DomainError('PRECONDITION_REQUIRED', 'Selected transformation provider is no longer registered')
    assertDomain(provider.enabled, 'PRECONDITION_REQUIRED', 'Selected transformation provider is disabled')
    const capability = provider.capabilities.find((candidate) => candidate.id === selection.selectedCapabilityId)
    if (!capability) throw new DomainError('PRECONDITION_REQUIRED', 'Selected provider capability is no longer offered')

    const adapter = dependencies.adapters.get({ adapterId: provider.adapterId, adapterVersion: provider.adapterVersion })
    if (!adapter) throw new DomainError('PRECONDITION_REQUIRED', 'Configured transformation adapter is unavailable')
    const capabilities = await adapter.getCapabilities()
    assertDomain(Date.parse(capabilities.expiresAt) > now.getTime(), 'PRECONDITION_REQUIRED', 'Transformation provider capabilities are stale')

    const contract = TRANSFORMATION_MODE_CONTRACTS[brief.mode]
    const operation = contract.providerCapability
    assertDomain(
      capabilities.operations.includes(operation as (typeof capabilities.operations)[number]),
      'PRECONDITION_REQUIRED',
      'Transformation adapter does not implement the operation this mode requires',
    )
    // The mode registry, not the caller and not the domain, says what must
    // survive a transformation. A brief that forgets a mandatory preserve is
    // refused before anything is paid for.
    assertDomain(
      contract.mandatoryPreserves.every((preserve) => brief.preserve.includes(preserve)),
      'INVALID_ARGUMENT',
      'Brief omits a preserve that this transformation mode requires',
    )

    const project = await dependencies.projects.read({ workspaceId, projectId })
    assertDomain(
      project?.project.currentVersionId === brief.projectVersionId && project.version?.id === brief.projectVersionId,
      'VERSION_CONFLICT',
      'Transformation must target the current project version',
    )

    const source = await dependencies.artifacts.findById(workspaceId, brief.sourceArtifactId)
    if (!source || source.status !== 'available') throw new DomainError('ASSET_NOT_USABLE', 'Transformation source artifact is unavailable')
    assertDomain(source.sha256 === brief.sourceArtifactHash, 'VERSION_CONFLICT', 'Transformation source artifact changed since the brief was written')

    const rights = await dependencies.rights.findCurrentForArtifacts(workspaceId, [brief.sourceArtifactId])
    const decision = {
      artifactId: brief.sourceArtifactId,
      ...evaluateAssetUse(rights.get(brief.sourceArtifactId) ?? null, {
        workspaceId,
        use: request.use,
        market: request.market,
        locale: request.locale,
        syntheticOperations: [operation as never],
      }, now),
    }
    assertDomain(decision.outcome === 'allow', 'ASSET_RIGHTS_BLOCKED', 'Transformation source artifact is not authorized')
    assertDomain(
      Boolean(decision.rightsSnapshotId && decision.rightsSnapshotHash && decision.validUntil),
      'ASSET_RIGHTS_BLOCKED',
      'Transformation source authorization is incomplete',
    )
    // Rights may have moved since the brief captured them. Routing work under a
    // snapshot the brief never saw is how a revoked consent gets paid for.
    assertDomain(
      decision.rightsSnapshotId === brief.rightsSnapshotId && decision.rightsSnapshotHash === brief.rightsSnapshotHash,
      'ASSET_RIGHTS_REVISION_MISMATCH',
      'Current rights differ from the snapshot the brief was authorized under',
    )

    // Novelty preflight, before any transport is chosen and long before
    // anything is submitted. The verdict comes from a decision persisted
    // against this exact project version: a policy evaluated in memory at
    // request time would be a policy nobody could audit afterwards.
    const verdict = await dependencies.novelty.findBriefVerdict({
      workspaceId,
      projectId,
      projectVersionId: brief.projectVersionId,
      briefId: brief.id,
    })
    if (!verdict) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'No novelty budget decision covers this brief for the current project version',
      )
    }
    if (verdict.outcome === 'blocked') {
      // The refusal quotes the policy's own reason rather than inventing one at
      // the boundary. An operator has to be able to act on it.
      throw new DomainError(
        'GOVERNANCE_LIMIT_EXCEEDED',
        `Novelty budget blocked this transformation: ${verdict.reason}`,
        { briefId: brief.id, decisionId: verdict.decisionId, blockedBecause: verdict.blockedBecause ?? null },
      )
    }

    const transport = selectTransport({
      completion: capabilities.completion,
      preferred: request.preferredTransport,
      webhookConfigured: dependencies.webhookConfigured?.(provider.id) ?? false,
    })

    const authorization = sealAuthorization({
      id: `transformation-authorization-${requestFingerprint.slice(0, 24)}`,
      // For a transformation the brief *is* the profile: it is the immutable
      // statement of what may change and what must not, and it is what the
      // critic later judges the result against.
      profileSnapshotId: brief.id,
      profileSnapshotHash: brief.briefHash,
      artifactDecisions: Object.freeze([Object.freeze({
        artifactId: decision.artifactId,
        rightsSnapshotId: decision.rightsSnapshotId!,
        rightsSnapshotHash: decision.rightsSnapshotHash!,
        validUntil: decision.validUntil!,
      })]),
      evaluatedAt: now.toISOString(),
      expiresAt: decision.validUntil!,
    })

    const job = createProviderJob({
      id: identity(dependencies.createJobId(), 'createJobId()'),
      workspaceId,
      projectId,
      originProjectVersionId: brief.projectVersionId,
      operation: operation as never,
      adapterId: provider.adapterId,
      adapterVersion: provider.adapterVersion,
      providerInput: projectTransformationProviderInput(brief),
      idempotencyKey: request.idempotencyKey,
      authorization,
      createdAt: now.toISOString(),
      transport,
      transformation: {
        briefId: brief.id,
        briefHash: brief.briefHash,
        selectionId: selection.id,
        selectionHash: selection.selectionHash,
        providerId: provider.id,
        capabilityId: capability.id,
      },
    })

    const deadlineMs = dependencies.deadlineMs ?? DEFAULT_DEADLINE_MS
    const transportState = createProviderJobTransportState({
      workspaceId,
      projectId,
      jobId: job.id,
      transport,
      completion: capabilities.completion,
      retryPolicy: DEFAULT_PROVIDER_JOB_RETRY_POLICY,
      deadlineAt: new Date(now.getTime() + deadlineMs).toISOString(),
      createdAt: now.toISOString(),
    })

    return dependencies.jobs.create({
      job,
      requestFingerprint,
      authenticationAudit: audit,
      transitionId: identity(dependencies.createTransitionId(), 'createTransitionId()'),
      transportState,
    })
  }
}

export function readTransformationJobService(dependencies: { jobs: ProviderJobRepository }) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    jobId: string
    actor: Readonly<AuthenticatedExternalActor>
  }) {
    requireScope(request.actor, 'projects:read')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    assertDomain(request.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Transformation actor does not belong to workspace')
    const persisted = await dependencies.jobs.read({
      workspaceId,
      projectId: identity(request.projectId, 'projectId'),
      jobId: identity(request.jobId, 'jobId'),
    })
    if (!persisted) throw new DomainError('ASSET_NOT_FOUND', 'Transformation job was not found')
    const callbacks = await dependencies.jobs.listCallbackEvents({
      workspaceId,
      projectId: request.projectId,
      jobId: request.jobId,
    })
    return Object.freeze({ persisted, callbacks })
  }
}

/**
 * Ask the provider to stop.
 *
 * Cancellation is durable and asynchronous. The API records the intent and
 * returns; the worker, which is the only thing holding a lease, is what talks
 * to the provider. A route that called `adapter.cancel` directly would be
 * racing the worker for the same job.
 *
 * When the provider does not support cancellation the request is still
 * recorded, as `unsupported`. Reporting a job cancelled that is still running —
 * and still billing — would be worse than saying so.
 */
export function cancelTransformationJobService(dependencies: {
  jobs: ProviderJobRepository
  adapters: ProviderAdapterRegistry
  clock: () => Date
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    jobId: string
    actor: Readonly<AuthenticatedExternalActor>
  }) {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    assertDomain(request.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Transformation actor does not belong to workspace')
    const persisted = await dependencies.jobs.read({
      workspaceId,
      projectId: identity(request.projectId, 'projectId'),
      jobId: identity(request.jobId, 'jobId'),
    })
    if (!persisted) throw new DomainError('ASSET_NOT_FOUND', 'Transformation job was not found')
    assertDomain(
      !TERMINAL_PROVIDER_JOB_STATUSES.includes(persisted.job.status as (typeof TERMINAL_PROVIDER_JOB_STATUSES)[number]),
      'VERSION_CONFLICT',
      'Transformation job already reached a terminal status',
    )
    const state = persisted.transportState
    if (!state) throw new DomainError('PRECONDITION_REQUIRED', 'This job has no durable transport to cancel')

    const adapter = dependencies.adapters.get({ adapterId: persisted.job.adapterId, adapterVersion: persisted.job.adapterVersion })
    const capabilities = adapter ? await adapter.getCapabilities() : null
    const supported = Boolean(capabilities?.supportsCancellation && typeof adapter?.cancel === 'function')

    // "Stop this job" is a statement of desired state, not an event. Asking
    // twice is not an error: the second request finds the intent already
    // recorded and returns it unchanged, which is what makes this endpoint
    // genuinely idempotent rather than merely declared so.
    if (state.cancellation !== 'none') {
      return Object.freeze({ persisted, transportState: state, supported, alreadyRequested: true })
    }

    const next = requestProviderJobCancellation({
      state,
      occurredAt: dependencies.clock().toISOString(),
      supported,
    })
    const saved = await dependencies.jobs.saveTransportState({ expectedRevision: state.revision, next })
    return Object.freeze({ persisted, transportState: saved, supported, alreadyRequested: false })
  }
}

/**
 * Explicitly resume or retry a job that stopped.
 *
 * This is a Command, not a nudge: it resets the transport attempt budget,
 * extends the deadline and records who asked. A job that failed permanently
 * cannot be resumed — its failure is a fact, and retrying it would only spend
 * money to reproduce it.
 */
export function retryTransformationJobService(dependencies: {
  jobs: ProviderJobRepository
  clock: () => Date
  deadlineMs?: number
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    jobId: string
    actor: Readonly<AuthenticatedExternalActor>
  }) {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    assertDomain(request.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Transformation actor does not belong to workspace')
    const persisted = await dependencies.jobs.read({
      workspaceId,
      projectId: identity(request.projectId, 'projectId'),
      jobId: identity(request.jobId, 'jobId'),
    })
    if (!persisted) throw new DomainError('ASSET_NOT_FOUND', 'Transformation job was not found')
    const state = persisted.transportState
    if (!state) throw new DomainError('PRECONDITION_REQUIRED', 'This job has no durable transport to resume')
    assertDomain(
      !TERMINAL_PROVIDER_JOB_STATUSES.includes(persisted.job.status as (typeof TERMINAL_PROVIDER_JOB_STATUSES)[number]),
      'VERSION_CONFLICT',
      'A terminal transformation job cannot be resumed; request a new transformation instead',
    )
    assertDomain(state.cancellation === 'none', 'VERSION_CONFLICT', 'A cancelled transformation job cannot be resumed')
    // A resume already pending and untouched is the same desired state. Moving
    // the deadline again on every retry of the same request would let a client
    // extend a job indefinitely just by repeating itself.
    if (state.resume === 'requested' && state.waitKind === 'none' && state.transportAttempts === 0) {
      return Object.freeze({ persisted, transportState: state, alreadyRequested: true })
    }
    const now = dependencies.clock()
    const next = requestProviderJobResume({
      state,
      occurredAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + (dependencies.deadlineMs ?? DEFAULT_DEADLINE_MS)).toISOString(),
    })
    const saved = await dependencies.jobs.saveTransportState({ expectedRevision: state.revision, next })
    return Object.freeze({ persisted, transportState: saved, alreadyRequested: false })
  }
}

export interface ProviderCallbackOutcomeReport {
  outcome: 'accepted' | 'duplicate' | 'rejected'
  reason?: ProviderCallbackRejection
  jobId?: string
}

/**
 * Apply an inbound provider callback.
 *
 * Every path through this function is durable and every rejection leaves the
 * job exactly as it was. The callback does not advance the job itself — it
 * records a verified event and wakes the schedule, and the worker, holding the
 * lease, does the advancing. That separation is what stops a duplicate delivery
 * from ingesting a result twice.
 */
export function applyProviderCallbackService(dependencies: {
  jobs: ProviderJobRepository
  clock: () => Date
  createEventId: () => string
  toleranceSeconds?: number
}) {
  return async function execute(request: {
    workspaceId: string
    providerId: string
    adapterId: string
    providerJobId: string
    secret: Uint8Array
    rawBody: Uint8Array
    headers: Readonly<Record<string, string | undefined>>
  }): Promise<Readonly<ProviderCallbackOutcomeReport>> {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const now = dependencies.clock()
    const persisted = await dependencies.jobs.findByProviderCorrelation({
      workspaceId,
      adapterId: identity(request.adapterId, 'adapterId'),
      providerJobId: request.providerJobId,
    })
    // An unroutable callback is refused without disclosing whether the job
    // exists, whether the workspace exists, or which of the two was wrong.
    if (!persisted) return Object.freeze({ outcome: 'rejected' as const, reason: 'correlation-mismatch' as const })

    const terminal = TERMINAL_PROVIDER_JOB_STATUSES.includes(
      persisted.job.status as (typeof TERMINAL_PROVIDER_JOB_STATUSES)[number],
    )
    const verification = verifyProviderCallback({
      secret: request.secret,
      rawBody: request.rawBody,
      headers: request.headers,
      job: {
        id: persisted.job.id,
        workspaceId: persisted.job.workspaceId,
        providerId: identity(request.providerId, 'providerId'),
        providerJobId: persisted.job.providerJobId,
        terminal,
      },
      now,
      ...(dependencies.toleranceSeconds ? { toleranceSeconds: dependencies.toleranceSeconds } : {}),
    })
    if (verification.outcome === 'rejected') {
      return Object.freeze({ outcome: 'rejected' as const, reason: verification.reason, jobId: persisted.job.id })
    }

    const stored = await dependencies.jobs.findCallbackEvent({
      workspaceId,
      providerId: request.providerId,
      eventId: verification.event.eventId,
    })
    if (stored) {
      const replay = classifyProviderCallbackReplay({ stored, incoming: verification.event })
      return Object.freeze({
        outcome: replay.outcome,
        ...(replay.reason ? { reason: replay.reason } : {}),
        jobId: persisted.job.id,
      })
    }

    const state = persisted.transportState
    if (!state) throw new DomainError('PRECONDITION_REQUIRED', 'A callback arrived for a job with no durable transport')
    try {
      await dependencies.jobs.recordCallbackEvent({
        id: identity(dependencies.createEventId(), 'createEventId()'),
        event: verification.event,
        outcome: 'accepted',
        projectId: persisted.job.projectId,
        wake: { expectedRevision: state.revision, next: wakeProviderJob({ state, occurredAt: now.toISOString() }) },
      })
    } catch (error) {
      // Losing the race on the partial unique index means another delivery of
      // the same event landed first. That is a duplicate, not a failure.
      if (error instanceof DomainError && error.code === 'WEBHOOK_REPLAY_DETECTED') {
        return Object.freeze({ outcome: 'duplicate' as const, jobId: persisted.job.id })
      }
      throw error
    }
    return Object.freeze({ outcome: 'accepted' as const, jobId: persisted.job.id })
  }
}

export {
  acknowledgeProviderJobCancellation,
  awaitProviderJobCallback,
  transitionProviderJob,
}
