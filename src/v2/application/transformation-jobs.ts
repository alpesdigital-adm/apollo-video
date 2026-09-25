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
import { descendFallbackLadder, nextFallbackRung, recordFallbackAttempt } from '../domain/transformation-fallback.ts'
import {
  assertTransformationBrief,
  projectTransformationProviderInput,
} from '../domain/transformation-brief.ts'
import { TRANSFORMATION_MODE_CONTRACTS } from '../domain/transformation-mode-registry.ts'
import {
  assertReviewCleanupMaskExecutable,
  projectReviewCleanupMaskProviderInput,
} from '../domain/review-cleanup-mask.ts'
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
import type { ReviewCleanupMaskRepository } from './ports/review-cleanup-mask-repository.ts'
import type { TransformationProviderRegistryRepository } from './ports/transformation-provider-registry-repository.ts'
import type { TransformationFallbackDispatchClaim, TransformationQualityRepository } from './ports/transformation-quality-repository.ts'
import type { TransformationRoutingPolicy, TransformationProviderSelection } from '../domain/transformation-provider-registry.ts'
import { routeTransformationFallbackService } from './transformation-provider-registry.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/
const DEFAULT_DEADLINE_MS = 60 * 60 * 1_000

export interface GeneratedCutawayFallbackEnqueueInput {
  workspaceId: string
  projectId: string
  briefId: string
  selection: Readonly<TransformationProviderSelection>
  fallback: NonNullable<import('../domain/provider-job.ts').ProviderJobTransformationOrigin['fallback']>
  use: string
  market: string
  locale: string
  actor: Readonly<AuthenticatedExternalActor>
  idempotencyKey: string
}

/** Dispatches the current fallback rung from persisted state. The caller may
 * identify the ledger revision, but cannot choose the rung, operation,
 * provider, rejected result or critic report. */
export function dispatchGeneratedCutawayFallbackService(dependencies: {
  quality: TransformationQualityRepository
  registry: TransformationProviderRegistryRepository
  jobs: ProviderJobRepository
  enqueue: (input: Readonly<GeneratedCutawayFallbackEnqueueInput>) => Promise<Readonly<{ persisted: Readonly<import('./ports/provider-job-repository.ts').PersistedProviderJob>; replayed: boolean }>>
  clock: () => Date
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    ledgerId: string
    expectedLedgerHash: string
    use: string
    market: string
    locale: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    assertDomain(request.actor.workspaceId === request.workspaceId, 'AUTH_INVALID', 'Fallback actor does not belong to workspace')
    assertDomain(IDEMPOTENCY_KEY.test(request.idempotencyKey), 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const audit = materializeActorAuditContext(request.actor)
    const dispatchRequestHash = calculateCanonicalHash({
      schemaVersion: 'generated-cutaway-dispatch-request/v1', workspaceId: request.workspaceId, projectId: request.projectId,
      ledgerId: request.ledgerId, expectedLedgerHash: request.expectedLedgerHash,
      use: request.use, market: request.market, locale: request.locale, actorContextHash: audit.contextHash,
    })
    const replaySettledClaim = async (claim: Readonly<TransformationFallbackDispatchClaim>) => {
      const claimedLedger = await dependencies.quality.readFallbackLedger({ workspaceId: request.workspaceId, projectId: request.projectId, ledgerId: claim.requestedLedgerId })
      assertDomain(Boolean(claimedLedger) && claimedLedger!.ledgerHash === claim.requestedLedgerHash, 'PERSISTENCE_CONFLICT', 'Fallback dispatch claim refers to a missing ledger revision')
      if (claim.outcome === 'enqueued') {
        const job = claim.providerJobId
          ? await dependencies.jobs.read({ workspaceId: request.workspaceId, projectId: request.projectId, jobId: claim.providerJobId })
          : null
        assertDomain(Boolean(job), 'PERSISTENCE_CONFLICT', 'Settled fallback dispatch refers to a missing provider job')
        const origin = job!.job.transformation?.fallback
        assertDomain(
          Boolean(origin) && origin!.ledgerId === claim.requestedLedgerId &&
            origin!.ledgerHash === claim.requestedLedgerHash && origin!.rung === claim.rung &&
            origin!.dispatchRequestHash === claim.dispatchRequestHash,
          'PERSISTENCE_CONFLICT',
          'Settled fallback dispatch job does not match its durable claim',
        )
        return Object.freeze({ outcome: 'replayed' as const, ledger: claimedLedger!, job: job! })
      }
      if (claim.outcome === 'skipped') {
        const settledLedger = claim.resultLedgerId
          ? await dependencies.quality.readFallbackLedger({ workspaceId: request.workspaceId, projectId: request.projectId, ledgerId: claim.resultLedgerId })
          : null
        assertDomain(Boolean(settledLedger) && settledLedger!.ledgerHash === claim.resultLedgerHash, 'PERSISTENCE_CONFLICT', 'Settled fallback skip refers to a missing ledger')
        assertDomain(Boolean(dependencies.quality.findFallbackDispatchAttempt), 'PERSISTENCE_NOT_CONFIGURED', 'Fallback dispatch audit repository is unavailable')
        const attempt = await dependencies.quality.findFallbackDispatchAttempt!({ workspaceId: request.workspaceId, projectId: request.projectId, briefId: claim.briefId, rung: claim.rung })
        assertDomain(
          Boolean(attempt) && attempt!.ledger.id === settledLedger!.id &&
            attempt!.requestHash === claim.dispatchRequestHash &&
            attempt!.authenticationAudit.contextHash === claim.authenticationAudit.contextHash,
          'PERSISTENCE_CONFLICT',
          'Settled fallback skip does not match its durable claim',
        )
        return Object.freeze({ outcome: 'skipped' as const, ledger: settledLedger!, reason: 'capability-unavailable' as const })
      }
      return null
    }
    const publicReplay = await dependencies.quality.readFallbackDispatchRequest({
      workspaceId: request.workspaceId, actorClientId: audit.clientId, idempotencyKey: request.idempotencyKey,
    })
    if (publicReplay) {
      assertDomain(publicReplay.requestFingerprint === dispatchRequestHash && publicReplay.authenticationAudit.contextHash === audit.contextHash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Fallback dispatch idempotency key was already used for a different request')
      const settled = await replaySettledClaim(publicReplay.claim)
      if (settled) return settled
    }
    const current = await dependencies.quality.readFallbackLedger({ workspaceId: request.workspaceId, projectId: request.projectId, ledgerId: request.ledgerId })
    if (!current) throw new DomainError('ASSET_NOT_FOUND', 'Transformation fallback ledger was not found')
    assertDomain(current.ledgerHash === request.expectedLedgerHash, 'VERSION_CONFLICT', 'Transformation fallback ledger hash is stale')
    const dispatchClaim = await dependencies.quality.claimFallbackDispatch({
      claimId: `fallback-claim-${calculateCanonicalHash({ workspaceId: request.workspaceId, projectId: request.projectId, ledgerId: current.id, rung: 'generated-cutaway' }).slice(0, 48)}`,
      requestId: `fallback-request-${calculateCanonicalHash({ workspaceId: request.workspaceId, actorClientId: audit.clientId, idempotencyKey: request.idempotencyKey }).slice(0, 48)}`,
      workspaceId: request.workspaceId, projectId: request.projectId,
      ledgerId: current.id, ledgerHash: current.ledgerHash, briefId: current.briefId,
      rung: 'generated-cutaway', idempotencyKey: request.idempotencyKey,
      requestFingerprint: dispatchRequestHash, authenticationAudit: audit,
      createdAt: dependencies.clock().toISOString(),
    })
    const settledClaim = await replaySettledClaim(dispatchClaim.claim)
    if (settledClaim) return settledClaim
    assertDomain(Boolean(dependencies.jobs.findFallbackDispatch), 'PERSISTENCE_NOT_CONFIGURED', 'Fallback dispatch repository is unavailable')
    const priorDispatch = await dependencies.jobs.findFallbackDispatch!({ workspaceId: request.workspaceId, projectId: request.projectId, ledgerId: current.id, rung: 'generated-cutaway' })
    if (priorDispatch) {
      const origin = priorDispatch.job.transformation?.fallback
      assertDomain(Boolean(origin) && origin!.ledgerHash === current.ledgerHash && origin!.rung === 'generated-cutaway', 'PERSISTENCE_CONFLICT', 'Persisted fallback dispatch does not match its ledger claim')
      assertDomain(origin!.dispatchRequestHash === dispatchRequestHash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Fallback dispatch already exists with a different request context')
      await dependencies.quality.settleFallbackDispatch({
        workspaceId: request.workspaceId, projectId: request.projectId,
        claimId: dispatchClaim.claim.id, expectedLedgerId: current.id, outcome: 'enqueued',
        providerJobId: priorDispatch.job.id, settledAt: dependencies.clock().toISOString(),
      })
      return Object.freeze({ outcome: 'replayed' as const, ledger: current, job: priorDispatch })
    }
    assertDomain(Boolean(dependencies.quality.findFallbackDispatchAttempt), 'PERSISTENCE_NOT_CONFIGURED', 'Fallback dispatch audit repository is unavailable')
    const priorSkip = await dependencies.quality.findFallbackDispatchAttempt!({ workspaceId: request.workspaceId, projectId: request.projectId, briefId: current.briefId, rung: 'generated-cutaway' })
    if (priorSkip) {
      assertDomain(priorSkip.requestHash === dispatchRequestHash && priorSkip.authenticationAudit.contextHash === audit.contextHash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Fallback skip already exists with a different request context')
      await dependencies.quality.settleFallbackDispatch({
        workspaceId: request.workspaceId, projectId: request.projectId,
        claimId: dispatchClaim.claim.id, expectedLedgerId: current.id, outcome: 'skipped',
        resultLedgerId: priorSkip.ledger.id, resultLedgerHash: priorSkip.ledger.ledgerHash,
        reason: 'capability-unavailable', settledAt: dependencies.clock().toISOString(),
      })
      return Object.freeze({ outcome: 'skipped' as const, ledger: priorSkip.ledger, reason: 'capability-unavailable' as const })
    }
    const latest = await dependencies.quality.readLatestFallbackLedger({ workspaceId: request.workspaceId, projectId: request.projectId, briefId: current.briefId })
    assertDomain(latest?.id === current.id && latest.ledgerHash === request.expectedLedgerHash && current.ledgerHash === request.expectedLedgerHash, 'VERSION_CONFLICT', 'Transformation fallback ledger has a newer revision')
    assertDomain(current.reviewDecision === 'awaiting-review' && current.currentRung === 'generated-cutaway', 'PRECONDITION_REQUIRED', 'Generated cutaway is not the current fallback rung')
    const rejectedAttempt = [...current.attempts].reverse().find((attempt) => attempt.outcome === 'rejected')
    assertDomain(Boolean(rejectedAttempt?.providerJobId && rejectedAttempt.criticReportHash), 'PERSISTENCE_CONFLICT', 'Fallback has no rejected provider result and critic report')
    const rejectedJob = await dependencies.jobs.read({ workspaceId: request.workspaceId, projectId: request.projectId, jobId: rejectedAttempt!.providerJobId! })
    assertDomain(Boolean(rejectedJob?.job.transformation) && rejectedJob!.job.transformation!.briefId === current.briefId && rejectedJob!.job.transformation!.briefHash === current.briefHash, 'PERSISTENCE_CONFLICT', 'Fallback rejected job is missing or bound to another brief')
    const report = await dependencies.quality.readCriticReportByJob({ workspaceId: request.workspaceId, projectId: request.projectId, providerJobId: rejectedAttempt!.providerJobId! })
    assertDomain(Boolean(report) && report!.reportHash === rejectedAttempt!.criticReportHash && report!.briefId === current.briefId && report!.briefHash === current.briefHash && report!.decision === 'rejected' && report!.action === 'fallback', 'PERSISTENCE_CONFLICT', 'Fallback rejection is not bound to its persisted critic report')
    const originalSelections = await dependencies.registry.listSelections({ workspaceId: request.workspaceId, projectId: request.projectId, briefId: current.briefId })
    const originalSelection = originalSelections.find((selection) => selection.id === rejectedJob!.job.transformation!.selectionId)
    assertDomain(Boolean(originalSelection) && originalSelection!.selectionHash === rejectedJob!.job.transformation!.selectionHash && originalSelection!.briefHash === current.briefHash, 'PERSISTENCE_CONFLICT', 'Fallback cannot recover the routing policy that authorized the rejected attempt')

    const routed = await routeTransformationFallbackService({ repository: dependencies.registry, workspaceId: request.workspaceId, projectId: request.projectId, briefId: current.briefId, policy: originalSelection!.policy, createdAt: dependencies.clock().toISOString() })
    const selection = routed.selection
    if (!selection.selectedProviderId || !selection.selectedCapabilityId) {
      const skippedAt = new Date(Math.max(Date.parse(current.updatedAt) + 1, dependencies.clock().getTime())).toISOString()
      const attempted = recordFallbackAttempt({ ledger: current, attempt: {
        rung: 'generated-cutaway', outcome: 'skipped', intentScoreBps: null, violatesProtectedContent: false,
        estimatedCostMinorUnits: 0, observedCostMinorUnits: 0, costCurrency: current.costCurrency,
        reason: 'no registered healthy capability can execute generated-cutaway', descendedBecause: 'capability-unavailable',
      }, occurredAt: skippedAt })
      const next = nextFallbackRung(attempted.ladder, attempted.currentRung)
      const settled = next ? descendFallbackLadder({ ledger: attempted, because: 'capability-unavailable', occurredAt: new Date(Math.max(Date.parse(attempted.updatedAt) + 1, dependencies.clock().getTime())).toISOString() }) : attempted
      const persisted = await dependencies.quality.recordFallbackLedger({
        ledger: settled,
        previousLedgerHash: current.ledgerHash,
        dispatch: { attemptSequence: current.attempts.length + 1, requestHash: dispatchRequestHash, authenticationAudit: audit },
      })
      await dependencies.quality.settleFallbackDispatch({
        workspaceId: request.workspaceId, projectId: request.projectId,
        claimId: dispatchClaim.claim.id, expectedLedgerId: current.id, outcome: 'skipped',
        resultLedgerId: persisted.ledger.id, resultLedgerHash: persisted.ledger.ledgerHash,
        reason: 'capability-unavailable', settledAt: dependencies.clock().toISOString(),
      })
      return Object.freeze({ outcome: 'skipped' as const, ledger: persisted.ledger, reason: 'capability-unavailable' as const })
    }
    const dispatchIdentityHash = calculateCanonicalHash({ schemaVersion: 'generated-cutaway-dispatch/v1', workspaceId: request.workspaceId, projectId: request.projectId, briefId: current.briefId, ledgerId: current.id, ledgerHash: current.ledgerHash, rung: 'generated-cutaway' })
    const result = await dependencies.enqueue({
      workspaceId: request.workspaceId, projectId: request.projectId, briefId: current.briefId, selection,
      fallback: { ledgerId: current.id, ledgerHash: current.ledgerHash, rung: 'generated-cutaway', rejectedJobId: rejectedAttempt!.providerJobId!, rejectedReportHash: rejectedAttempt!.criticReportHash!, dispatchRequestHash },
      use: request.use, market: request.market, locale: request.locale, actor: request.actor,
      idempotencyKey: `fallback-${dispatchIdentityHash.slice(0, 48)}`,
    })
    await dependencies.quality.settleFallbackDispatch({
      workspaceId: request.workspaceId, projectId: request.projectId,
      claimId: dispatchClaim.claim.id, expectedLedgerId: current.id, outcome: 'enqueued',
      providerJobId: result.persisted.job.id, settledAt: dependencies.clock().toISOString(),
    })
    return Object.freeze({ outcome: result.replayed ? 'replayed' as const : 'enqueued' as const, ledger: current, job: result.persisted })
  }
}

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
  masks?: ReviewCleanupMaskRepository
  clock: () => Date
  createJobId: () => string
  createTransitionId: () => string
  webhookConfigured?: (providerId: string) => boolean
  deadlineMs?: number
}) {
  type Request = {
    workspaceId: string
    projectId: string
    briefId: string
    selectionId: string
    use: string
    market: string
    locale: string
    preferredTransport?: ProviderJobTransport
    maskId?: string
    outputSpecId?: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }
  type InternalFallback = Readonly<{
    operation: 'generated-cutaway'
    origin: NonNullable<import('../domain/provider-job.ts').ProviderJobTransformationOrigin['fallback']>
  }>
  const execute = async function execute(request: Request, internalFallback?: InternalFallback) {
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
      maskId: request.maskId ?? null,
      outputSpecId: request.outputSpecId ?? null,
      actorContextHash: audit.contextHash,
      fallback: internalFallback?.origin ?? null,
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
    const operation = internalFallback?.operation ?? contract.providerCapability
    assertDomain(
      internalFallback
        ? selection.requestedOperation === operation && brief.fallbackLadder.includes('generated-cutaway')
        : selection.requestedOperation === undefined,
      'PERSISTENCE_CONFLICT',
      'Routing selection operation does not match this transformation request',
    )
    assertDomain(capability.operation === operation && capability.modes.includes(brief.mode), 'PERSISTENCE_CONFLICT', 'Selected provider capability does not satisfy this brief mode')
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

    let cleanupMask: Readonly<Record<string, unknown>> | undefined
    if (contract.requiresMask) {
      assertDomain(Boolean(request.maskId && request.outputSpecId), 'PRECONDITION_REQUIRED', 'This transformation mode requires a reviewed cleanup mask and output format')
      assertDomain(Boolean(dependencies.masks), 'PRECONDITION_REQUIRED', 'Review cleanup mask repository is unavailable')
      assertDomain(brief.outputSpecIds.includes(request.outputSpecId!), 'INVALID_ARGUMENT', 'Requested mask output format is outside the TransformationBrief')
      const persistedMask = await dependencies.masks!.read({ workspaceId, projectId, maskId: identity(request.maskId!, 'maskId') })
      if (!persistedMask) throw new DomainError('ASSET_NOT_FOUND', 'Review cleanup mask was not found')
      const latestMask = await dependencies.masks!.readLatest({ workspaceId, projectId, rootId: persistedMask.mask.rootId })
      assertDomain(latestMask?.mask.id === persistedMask.mask.id, 'VERSION_CONFLICT', 'Review cleanup mask has a newer revision')
      cleanupMask = projectReviewCleanupMaskProviderInput(assertReviewCleanupMaskExecutable({
        mask: persistedMask.mask,
        brief,
        outputSpecId: request.outputSpecId!,
      }))
    } else {
      assertDomain(request.maskId === undefined && request.outputSpecId === undefined, 'INVALID_ARGUMENT', 'This transformation mode does not accept a cleanup mask')
    }

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
      providerInput: Object.freeze({
        ...projectTransformationProviderInput(brief),
        ...(cleanupMask ? { cleanupMask } : {}),
      }),
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
        ...(internalFallback ? { fallback: internalFallback.origin } : {}),
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
  return Object.assign(execute, {
    enqueueGeneratedCutawayFallback: (request: Request, origin: InternalFallback['origin']) => execute(request, { operation: 'generated-cutaway', origin }),
  })
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
