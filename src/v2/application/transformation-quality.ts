import { assertDomain, DomainError } from '../domain/errors.ts'
import type { ProviderJob, ProviderJobResultArtifact } from '../domain/provider-job.ts'
import {
  createTransformationCriticReport,
  isTransformationApproval,
  rejectedProtectedContent,
} from '../domain/transformation-critic-report.ts'
import {
  availableFallbackActions,
  createTransformationFallbackLedger,
  descendFallbackLadder,
  nextFallbackRung,
  recordFallbackAttempt,
  settleFallbackReview,
  type FallbackDescentReason,
} from '../domain/transformation-fallback.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { requireScope } from './authenticate-api-client.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { NoveltyBudgetRepository } from './ports/novelty-budget-repository.ts'
import type { TransformationCriticEvaluator } from './ports/transformation-critic-evaluator.ts'
import type { TransformationProviderRegistryRepository } from './ports/transformation-provider-registry-repository.ts'
import type { TransformationQualityRepository } from './ports/transformation-quality-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

function id(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function afterLedger(ledger: Readonly<{ updatedAt: string }>, candidate: string): string {
  return new Date(Math.max(Date.parse(candidate), Date.parse(ledger.updatedAt) + 1)).toISOString()
}

export class PersistedTransformationResultCritic {
  constructor(private readonly dependencies: {
    registry: TransformationProviderRegistryRepository
    quality: TransformationQualityRepository
    artifacts: MediaArtifactQueryRepository
    novelty: NoveltyBudgetRepository
    evaluator: TransformationCriticEvaluator
    clock?: () => Date
  }) {}

  async evaluate(input: {
    job: Readonly<ProviderJob>
    artifact: Readonly<ProviderJobResultArtifact>
    signal?: AbortSignal
  }): Promise<Readonly<{ approved: boolean; resultHash: string }>> {
    const { job } = input
    assertDomain(Boolean(job.transformation), 'INVALID_ARGUMENT', 'Transformation critic requires a transformation job')
    const existing = await this.dependencies.quality.readCriticReportByJob({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      providerJobId: job.id,
    })
    if (existing) return Object.freeze({ approved: isTransformationApproval(existing), resultHash: existing.reportHash })

    const brief = await this.dependencies.registry.readBrief({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      briefId: job.transformation!.briefId,
    })
    if (!brief || brief.briefHash !== job.transformation!.briefHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Transformation brief is missing or changed before critic evaluation')
    }
    const source = await this.dependencies.artifacts.findById(job.workspaceId, brief.sourceArtifactId)
    const result = await this.dependencies.artifacts.findById(job.workspaceId, input.artifact.artifactId)
    if (!source || source.sha256 !== brief.sourceArtifactHash || source.status !== 'available') {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Transformation critic cannot verify the immutable source')
    }
    if (!result || result.sha256 !== input.artifact.artifactSha256 || result.status !== 'available') {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Transformation critic cannot verify the immutable result')
    }
    const novelty = await this.dependencies.novelty.findBriefVerdict({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      projectVersionId: job.originProjectVersionId,
      briefId: brief.id,
    })
    if (!novelty || novelty.outcome === 'blocked') {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Transformation critic cannot find the novelty decision that admitted this job')
    }
    const now = (this.dependencies.clock ?? (() => new Date()))()
    const evaluatedAt = now.toISOString()
    const evidence = await this.dependencies.evaluator.evaluate({
      brief,
      source,
      result,
      operationId: job.id,
      signal: input.signal,
    })
    const report = createTransformationCriticReport({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      briefId: brief.id,
      briefHash: brief.briefHash,
      providerJobId: job.id,
      policyId: novelty.policyId,
      policyHash: novelty.policyHash,
      sourceArtifactId: source.id,
      sourceArtifactSha256: source.sha256,
      resultArtifactId: result.id,
      resultArtifactSha256: result.sha256,
      ...evidence,
      evaluatedAt,
    })
    await this.dependencies.quality.recordCriticReport({ report })

    let ledger = await this.dependencies.quality.readLatestFallbackLedger({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      briefId: brief.id,
    })
    if (!ledger) {
      ledger = createTransformationFallbackLedger({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        projectVersionId: job.originProjectVersionId,
        brief,
        sourceArtifactId: source.id,
        sourceArtifactSha256: source.sha256,
        costCurrency: job.observedCost?.currency ?? job.estimate?.currency ?? 'USD',
        createdAt: evaluatedAt,
      })
      await this.dependencies.quality.recordFallbackLedger({ ledger, previousLedgerHash: null })
    }
    if (!ledger.attempts.some((attempt) => attempt.providerJobId === job.id)) {
      const approved = isTransformationApproval(report)
      const currency = job.observedCost?.currency ?? job.estimate?.currency ?? ledger.costCurrency
      const attemptBaseHash = ledger.ledgerHash
      ledger = recordFallbackAttempt({
        ledger,
        attempt: {
          rung: ledger.currentRung,
          providerJobId: job.id,
          providerId: job.transformation!.providerId,
          artifactId: result.id,
          artifactSha256: result.sha256,
          outcome: approved ? 'approved' : 'rejected',
          intentScoreBps: report.intentScoreBps,
          criticReportHash: report.reportHash,
          violatesProtectedContent: rejectedProtectedContent(report),
          estimatedCostMinorUnits: job.estimate?.costMinorUnits ?? 0,
          observedCostMinorUnits: job.observedCost?.costMinorUnits ?? 0,
          costCurrency: currency,
          reason: approved
            ? 'the measured transformation critic approved this result against the immutable brief'
            : 'the measured transformation critic rejected this result against the immutable brief',
        },
        occurredAt: afterLedger(ledger, evaluatedAt),
      })
      await this.dependencies.quality.recordFallbackLedger({ ledger, previousLedgerHash: attemptBaseHash })
      if (!approved && nextFallbackRung(ledger.ladder, ledger.currentRung) !== null) {
        const descentBaseHash = ledger.ledgerHash
        ledger = descendFallbackLadder({
          ledger,
          because: rejectedProtectedContent(report)
            ? 'critic-rejected-protected-content'
            : 'critic-rejected-quality',
          occurredAt: afterLedger(ledger, evaluatedAt),
        })
        await this.dependencies.quality.recordFallbackLedger({ ledger, previousLedgerHash: descentBaseHash })
      }
    }
    return Object.freeze({ approved: isTransformationApproval(report), resultHash: report.reportHash })
  }
}

export function readTransformationQualityService(dependencies: {
  quality: TransformationQualityRepository
  novelty: NoveltyBudgetRepository
}) {
  return async function execute(input: {
    workspaceId: string
    projectId: string
    actor: Readonly<AuthenticatedExternalActor>
  }) {
    requireScope(input.actor, 'projects:read')
    const workspaceId = id(input.workspaceId, 'workspaceId')
    const projectId = id(input.projectId, 'projectId')
    assertDomain(input.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Actor does not belong to workspace')
    const [ledgers, reports, novelty] = await Promise.all([
      dependencies.quality.listFallbackLedgers({ workspaceId, projectId, limit: 50 }),
      dependencies.quality.listCriticReports({ workspaceId, projectId, limit: 50 }),
      dependencies.novelty.listDecisions({ workspaceId, projectId, limit: 20 }),
    ])
    return Object.freeze({
      ledgers: Object.freeze(ledgers.map((ledger) => Object.freeze({ ledger, actions: availableFallbackActions(ledger) }))),
      reports,
      novelty,
    })
  }
}

export function applyTransformationFallbackActionService(dependencies: {
  quality: TransformationQualityRepository
  clock?: () => Date
}) {
  return async function execute(input: {
    workspaceId: string
    projectId: string
    ledgerId: string
    action: 'accept' | 'keep-source' | 'descend'
    because?: FallbackDescentReason
    actor: Readonly<AuthenticatedExternalActor>
  }) {
    requireScope(input.actor, 'projects:write')
    const workspaceId = id(input.workspaceId, 'workspaceId')
    const projectId = id(input.projectId, 'projectId')
    assertDomain(input.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Actor does not belong to workspace')
    const current = await dependencies.quality.readFallbackLedger({
      workspaceId,
      projectId,
      ledgerId: id(input.ledgerId, 'ledgerId'),
    })
    if (!current) throw new DomainError('ASSET_NOT_FOUND', 'Transformation fallback ledger was not found')
    const latest = await dependencies.quality.readLatestFallbackLedger({ workspaceId, projectId, briefId: current.briefId })
    if (!latest) throw new DomainError('PERSISTENCE_CONFLICT', 'Transformation fallback history disappeared')
    const requestedDecision = input.action === 'accept' ? 'accepted' : input.action === 'keep-source' ? 'kept-source' : null
    if (latest.id !== current.id) {
      if (requestedDecision && latest.reviewDecision === requestedDecision) {
        return Object.freeze({ ledger: latest, actions: availableFallbackActions(latest), replayed: true })
      }
      throw new DomainError('VERSION_CONFLICT', 'Transformation fallback ledger has a newer revision')
    }
    if (current.reviewDecision !== 'awaiting-review') {
      if (requestedDecision === current.reviewDecision) {
        return Object.freeze({ ledger: current, actions: availableFallbackActions(current), replayed: true })
      }
      throw new DomainError('VERSION_CONFLICT', 'Transformation fallback review is already settled')
    }
    const occurredAt = afterLedger(current, (dependencies.clock ?? (() => new Date()))().toISOString())
    const ledger = input.action === 'descend'
      ? descendFallbackLadder({ ledger: current, because: input.because ?? 'intent-not-satisfied', occurredAt })
      : settleFallbackReview({ ledger: current, decision: input.action === 'accept' ? 'accepted' : 'kept-source', occurredAt })
    const persisted = await dependencies.quality.recordFallbackLedger({ ledger, previousLedgerHash: current.ledgerHash })
    return Object.freeze({ ledger: persisted.ledger, actions: availableFallbackActions(persisted.ledger), replayed: persisted.replayed })
  }
}
