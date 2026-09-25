import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain } from '../domain/errors.ts'
import { createSyntheticCacheDecision } from '../domain/synthetic-cache-decision.ts'
import { calculateSyntheticCacheKey } from '../domain/synthetic-cache-identity.ts'
import { createSyntheticMasterConsumption } from '../domain/synthetic-master-consumption.ts'
import { SYNTHETIC_PRESENTER_ELIGIBILITY_POLICY_VERSION } from '../domain/synthetic-presenter-policy-engine.ts'
import type { SyntheticPresenterEditPlan } from '../domain/synthetic-production.ts'
import type {
  PreparedCanonicalMasterReuse,
  SyntheticMasterReuseRepository,
} from './ports/synthetic-master-reuse-repository.ts'

export const SYNTHETIC_MASTER_REUSE_ALIGNMENT_HASH_VERSION =
  'synthetic-master-reuse-production-alignment/v1' as const

export function calculateSyntheticMasterReuseProductionAlignmentHash(
  alignment: SyntheticPresenterEditPlan['audio']['alignment'],
): string {
  return calculateCanonicalHash({
    schemaVersion: SYNTHETIC_MASTER_REUSE_ALIGNMENT_HASH_VERSION,
    alignment,
  })
}

export function prepareCanonicalSyntheticMasterReuseService(dependencies: {
  repository: SyntheticMasterReuseRepository
  clock: () => Date
  createDecisionId: () => string
  createConsumptionId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    consumerProjectId: string
    consumerProjectVersionId: string
    plan: Readonly<SyntheticPresenterEditPlan>
    observationOpenedAt: string
  }): Promise<Readonly<PreparedCanonicalMasterReuse> | null> {
    const { plan } = request
    assertDomain(
      plan.workspaceId === request.workspaceId &&
        plan.projectId === request.consumerProjectId &&
        plan.projectVersionId === request.consumerProjectVersionId,
      'VERSION_CONFLICT',
      'synthetic production plan does not match the consuming project version',
    )
    if (plan.blocks.length !== 1) return null
    const block = plan.blocks[0]!
    if (block.rangeMs[0] !== 0 || block.rangeMs[1] !== plan.durationMs) return null

    const now = dependencies.clock()
    assertDomain(Number.isFinite(now.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')
    const createdAt = now.toISOString()
    const source = await dependencies.repository.resolveCanonicalSource({
      workspaceId: request.workspaceId,
      sourceProviderJobId: block.providerJobId,
      sourceArtifactId: block.artifact.artifactId,
      sourceArtifactSha256: block.artifact.sha256,
      use: plan.use,
      market: plan.market,
      locale: plan.locale,
      at: now,
    })
    if (!source) return null
    assertDomain(
      source.currentAuthorityValid,
      'ASSET_RIGHTS_BLOCKED',
      'canonical synthetic master is no longer authorized for reuse',
    )
    const { master } = source
    // A project's own promoted master is its normal production input. This
    // service contributes only the cross-project reuse decision/consumption;
    // returning null leaves the ordinary production validations in charge.
    if (master.projectId === request.consumerProjectId) return null
    const cacheKey = calculateSyntheticCacheKey(source.cacheSubject)
    const fullMasterMatches =
      master.workspaceId === request.workspaceId &&
      master.projectId !== request.consumerProjectId &&
      master.profileId === plan.profile.id &&
      master.profileVersion === plan.profile.version &&
      master.consentSnapshotHash === plan.profile.consent.snapshotHash &&
      master.locale === plan.locale &&
      master.durationMs === plan.durationMs &&
      master.scriptHash === plan.audio.scriptHash &&
      master.scriptText === block.text &&
      source.sourceJob.id === block.providerJobId &&
      source.sourceJob.authorization.profileSnapshotId === master.profileSnapshotId &&
      source.sourceJob.authorization.profileSnapshotHash === plan.profile.snapshotHash
    assertDomain(fullMasterMatches, 'PRECONDITION_REQUIRED', 'synthetic production does not consume one complete canonical master')
    assertDomain(
      source.sourceJob.id === master.provenance.providerJobId &&
        source.sourceJob.status === 'approved' &&
        source.sourceJob.criticResultHash === master.critic.reportHash &&
        source.providerOriginal.artifactId === block.artifact.artifactId &&
        source.providerOriginal.sha256 === block.artifact.sha256 &&
        source.finalAudio.artifactId === plan.audio.artifactId &&
        source.finalAudio.sha256 === block.audioSha256 &&
        block.critic.id === master.critic.reportId &&
        block.critic.resultHash === master.critic.reportHash &&
        block.critic.status === 'approved' &&
        block.cacheKey === cacheKey &&
        calculateSyntheticMasterReuseProductionAlignmentHash(plan.audio.alignment) === source.productionAlignmentHash,
      'PRECONDITION_REQUIRED',
      'synthetic production master source, artifacts, critic or cache identity diverged',
    )
    const decision = createSyntheticCacheDecision({
      id: dependencies.createDecisionId(),
      workspaceId: request.workspaceId,
      projectId: request.consumerProjectId,
      subject: source.cacheSubject,
      outcome: 'hit',
      reasonCode: 'CACHE_HIT_ELIGIBLE',
      reason: 'Complete approved synthetic master reused by another project',
      candidateGenerationId: null,
      candidateMasterId: master.id,
      policyVersion: SYNTHETIC_PRESENTER_ELIGIBILITY_POLICY_VERSION,
      criticReportHash: master.critic.reportHash,
      estimatedSavingMinorUnits: master.cost.minorUnits,
      avoidedCostMinorUnits: master.cost.minorUnits,
      currency: master.cost.currency,
      decidedAt: createdAt,
    })
    const consumption = createSyntheticMasterConsumption({
      id: dependencies.createConsumptionId(),
      workspaceId: request.workspaceId,
      consumerProjectId: request.consumerProjectId,
      consumerProjectVersionId: request.consumerProjectVersionId,
      productionRunId: plan.id,
      sourceMasterId: master.id,
      sourceMasterHash: master.masterHash,
      sourceProjectId: master.projectId,
      sourceProjectVersionId: master.projectVersionId,
      sourceProviderJobId: source.sourceJob.id,
      sourceArtifactId: source.providerOriginal.artifactId,
      sourceArtifactSha256: source.providerOriginal.sha256,
      cacheDecisionId: decision.id,
      cacheDecisionHash: decision.decisionHash,
      productionPlanHash: plan.planHash,
      observationOpenedAt: request.observationOpenedAt,
      createdAt,
    })
    return Object.freeze({ decision, consumption })
  }
}
