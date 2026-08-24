import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createProviderJob,
  normalizeProviderStatus,
  transitionProviderJob,
  type ProviderJobAuthorization,
} from '../domain/provider-job.ts'
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
} from './ports/provider-job-runtime.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'

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
  profiles: SyntheticProductionRepository
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
      schemaVersion: 'enqueue-provider-job-request/v1',
      workspaceId, projectId, projectVersionId,
      profileSnapshotId: request.profileSnapshotId,
      operation: request.operation,
      adapterId: request.adapterId,
      adapterVersion: request.adapterVersion,
      providerInput: request.providerInput,
      sourceArtifactIds: request.sourceArtifactIds,
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
    const [project, profile] = await Promise.all([
      dependencies.projects.read({ workspaceId, projectId }),
      dependencies.profiles.readProfile({ workspaceId, snapshotId: request.profileSnapshotId }),
    ])
    assertDomain(project?.project.currentVersionId === projectVersionId && project.version?.id === projectVersionId, 'VERSION_CONFLICT', 'Provider job must target the current project version')
    if (!profile) throw new DomainError('PRECONDITION_REQUIRED', 'Synthetic presenter profile was not found')
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
      profileSnapshotId: profile.snapshot.id,
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
      providerInput: request.providerInput,
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

function normalizedFailure(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return Object.freeze({
      code: error.code,
      message: error instanceof Error ? error.message : 'Provider operation failed',
      retryable: 'retryable' in error && error.retryable === true,
      ...('retryAfterMs' in error && Number.isSafeInteger(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs as number } : {}),
    })
  }
  return Object.freeze({ code: 'PROVIDER_FAILURE', message: error instanceof Error ? error.message : 'Provider operation failed', retryable: false })
}

export function runProviderJobWorkerOnce(dependencies: {
  jobs: ProviderJobRepository
  adapters: ProviderAdapterRegistry
  ingestor: ProviderResultIngestor
  critic: ProviderResultCritic
  clock: () => Date
  createLeaseToken: () => string
  createTransitionId: () => string
  leaseMs?: number
}) {
  return async function execute(workerId: string) {
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
        next = transitionProviderJob(job, { status: 'estimated', occurredAt: now.toISOString(), estimate: await adapter.estimate(job.input) })
      } else if (job.status === 'estimated') {
        const submitted = await adapter.submit(job.input, {
          workspaceId: job.workspaceId,
          projectVersionId: job.originProjectVersionId,
          operationId: job.id,
          idempotencyKey: job.idempotencyKey,
        })
        next = transitionProviderJob(job, { status: 'submitted', occurredAt: now.toISOString(), providerJobId: submitted.providerJobId })
      } else if (['submitted', 'queued', 'processing', 'suspected-stalled'].includes(job.status)) {
        const providerStatus = await adapter.getStatus(job.providerJobId!)
        const status = normalizeProviderStatus(providerStatus)
        if (status === 'failed') {
          next = transitionProviderJob(job, { status, occurredAt: now.toISOString(), providerStatus, normalizedError: { code: 'PROVIDER_REPORTED_FAILURE', message: 'Provider reported a terminal failure', retryable: false } })
        } else {
          next = transitionProviderJob(job, { status, occurredAt: now.toISOString(), providerStatus })
        }
      } else if (job.status === 'retrieving') {
        const providerResult = await adapter.retrieve(job.providerJobId!)
        const artifact = await dependencies.ingestor.ingest({ job, providerResult })
        next = transitionProviderJob(job, { status: 'evaluating', occurredAt: now.toISOString(), resultArtifact: artifact })
      } else if (job.status === 'evaluating') {
        const result = await dependencies.critic.evaluate({ job, artifact: job.resultArtifact! })
        next = transitionProviderJob(job, { status: result.approved ? 'approved' : 'rejected', occurredAt: now.toISOString(), criticResultHash: result.resultHash })
      } else {
        throw new DomainError('VERSION_CONFLICT', `Provider job status ${job.status} is not executable`)
      }
    } catch (error) {
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
