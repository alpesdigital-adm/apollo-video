import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ApprovedProjectFinalExportSource,
  ProjectFinalExportAttemptHistory,
  ProjectFinalExportRepository,
} from '../../application/ports/project-final-export-repository.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { admitDirectorQualityForFinal } from '../../domain/final-caption-certification.ts'
import { parseEditorialPolicyResolution } from '../../domain/editorial-policy-resolution.ts'
import { deriveEditorialRequestFromBrief } from '../../domain/editorial-request.ts'
import { projectStatusTransitionPath } from '../../domain/project.ts'
import { readOutputFormatPreset } from '../../domain/output-format-registry.ts'
import { outputVariantsOf } from '../../domain/output-consumption.ts'
import { renderOperationVariantId } from '../../domain/output-variant-references.ts'
import type { OutputAspectRatio } from '../../domain/output-spec.ts'
import { sourceOutputVariantId } from '../../application/project-render-sources.ts'
import { readStoredOutputStateV3 } from './output-state-consumption.ts'
import { legacyProxyBelongsToOutput } from './proxy-reuse-safety.ts'
import { PrismaProjectProxyRenderRepository } from './project-proxy-render-repository.ts'
import { parseDirectorQualityReport } from './director-run-repository.ts'
import { readDirectorInheritanceWalk } from './director-run-inheritance.ts'
import {
  describeDirectorInheritanceBlock, directorRunInheritanceEquals, type DirectorRunInheritance,
} from '../../domain/director-run-inheritance.ts'
import { PrismaPerceptionProducerEnvelopeRepository } from './perception-producer-envelope-repository.ts'

/**
 * W66r. A final is made from the very crop trajectory its proxy was approved with: the plan persisted for the Version now must be the one
 * the approved proxy was drawn from (or both must be absent). A plan that moved since is not what the reviewer saw, so there is no approval.
 */
function reframeMatchesApproval(source: Readonly<{ reframePlan?: Readonly<{ reframePlanHash: string }> }>, approval: Readonly<{ approvedReframePlanHash: string | null }>): boolean {
  return (source.reframePlan?.reframePlanHash ?? null) === approval.approvedReframePlanHash
}

/**
 * W68. A final is made with the very subtitle exceptions its proxy was approved with: the set of the Version's output now must equal the set the
 * approved proxy review records (both absent counts as equal). Every exception also makes a new Version, which a final never crosses; this guard
 * is the second, independent reason a final built from a proxy drawn with other exceptions is refused.
 */
export function subtitleOverridesMatchApproval(source: Readonly<{ subtitleOverridesHash?: string }>, approval: Readonly<{ approvedSubtitleOverridesHash: string | null }>): boolean {
  return (source.subtitleOverridesHash ?? null) === approval.approvedSubtitleOverridesHash
}

const FAILURE_STAGES = new Set([
  'source-read', 'color-plan', 'color-bindings', 'lut-materialization',
  'input-validation', 'rights', 'source-materialization', 'render',
  'output-verification', 'output-promotion', 'artifact-persistence',
])

export function parseFinalExportQuality(input: Parameters<typeof parseDirectorQualityReport>[0]) {
  return parseDirectorQualityReport(input)
}

export class PrismaProjectFinalExportRepository implements ProjectFinalExportRepository {
  private readonly sourceReader: PrismaProjectProxyRenderRepository
  private readonly perceptionEvidence: PrismaPerceptionProducerEnvelopeRepository
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
    this.sourceReader = new PrismaProjectProxyRenderRepository(client)
    this.perceptionEvidence = new PrismaPerceptionProducerEnvelopeRepository(client)
  }

  private async readApproval(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    directorRunId?: string
    qualitySnapshotId?: string
    qualitySnapshotHash?: string
    proxyReviewId?: string
    proxyReviewHash?: string
    proxyArtifactId?: string
    outputSpecId: string
    /** The stable State variant the export is for: the approving proxy review must be the one rendered for THIS output. */
    outputVariantId: string
    requireCurrent: boolean
    /** The inheritance the sealed operation was queued with (`null`: the Director's own Version). `undefined`: nothing to compare, a fresh read. */
    directorInheritance?: Readonly<DirectorRunInheritance> | null
  }) {
    // A review rendered before the column existed (no stated output) is this output's only when the Version has that one output.
    const legacyReviews = await legacyProxyBelongsToOutput(this.client, { workspaceId: input.workspaceId,
      projectId: input.projectId, versionId: input.projectVersionId, outputVariantId: input.outputVariantId })
    const project = await this.client.v2Project.findFirst({
      where: {
        id: input.projectId,
        workspaceId: input.workspaceId,
        ...(input.requireCurrent ? { currentVersionId: input.projectVersionId } : {}),
      },
      select: {
        locale: true,
        versions: {
          where: { id: input.projectVersionId, baseHash: input.projectVersionHash },
          take: 1,
          // ADR-160. The brief of the Version being exported: the request it states now is the request a Director report must have answered.
          select: { id: true, briefSnapshot: { select: { contentJson: true } } },
        },
        proxyReviews: {
          where: {
            projectVersionId: input.projectVersionId,
            outputSpecId: input.outputSpecId,
            operation: legacyReviews
              ? { OR: [{ outputVariantId: input.outputVariantId }, { outputVariantId: null }] }
              : { outputVariantId: input.outputVariantId },
            finalAllowed: true,
            status: 'ready-for-final',
            ...(input.proxyReviewId ? { id: input.proxyReviewId } : {}),
            ...(input.proxyReviewHash ? { reviewHash: input.proxyReviewHash } : {}),
            ...(input.proxyArtifactId ? { proxyArtifactId: input.proxyArtifactId } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            id: true,
            reviewHash: true,
            proxyArtifactId: true,
            formatQualityJson: true,
          },
        },
      },
    })
    const version = project?.versions[0]
    if (!project || !version) return null
    // W70 readiness. The DirectorRun whose quality this Version carries: its own, or the one an ancestor reached through exception
    // Commands only (a subtitle segment exception, a manual reframe). Anything else in the chain is refused with its precise reason,
    // never read past; and a sealed operation re-derives the chain it was queued with and refuses one that moved.
    const walk = await readDirectorInheritanceWalk(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: input.projectVersionId })
    if (walk.kind === 'blocked') {
      throw new DomainError('EDITORIAL_ACCEPTANCE_FAILED', describeDirectorInheritanceBlock(walk), {
        reason: 'director-run-not-inherited', inheritanceReason: walk.reason, versionId: walk.versionId,
        ...(walk.commandId ? { commandId: walk.commandId } : {}), ...(walk.commandType ? { commandType: walk.commandType } : {}),
      })
    }
    if (walk.kind === 'none') return null
    const inheritance = walk.kind === 'inherited' ? walk.inheritance : null
    if (input.directorInheritance !== undefined && !directorRunInheritanceEquals(inheritance, input.directorInheritance)) {
      throw new DomainError('EDITORIAL_ACCEPTANCE_FAILED', 'The Director run inheritance of this Version is not the one the final export was queued with', {
        reason: 'director-inheritance-moved', versionId: input.projectVersionId,
      })
    }
    const directorRun = await this.client.v2DirectorRun.findFirst({
      where: {
        workspaceId: input.workspaceId, projectId: input.projectId,
        resultVersionId: walk.kind === 'inherited' ? walk.inheritance.directorResultVersionId : walk.directorResultVersionId,
        status: 'succeeded',
        ...(input.directorRunId ? { id: input.directorRunId } : {}),
        ...(input.qualitySnapshotId ? { qualitySnapshotId: input.qualitySnapshotId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { qualitySnapshot: true, policySnapshot: true },
    })
    const proxyReview = project.proxyReviews[0]
    if (!directorRun || !proxyReview) return null
    if (input.qualitySnapshotHash && directorRun.qualitySnapshot.contentHash !== input.qualitySnapshotHash) return null
    const quality = parseFinalExportQuality({
      contentJson: directorRun.qualitySnapshot.contentJson,
      contentHash: directorRun.qualitySnapshot.contentHash,
      contentSchemaVersion: directorRun.qualitySnapshot.schemaVersion,
      objective: directorRun.objective, rubricRef: directorRun.rubricRef,
    })
    // W65b. A global facial safety is never granted (the Director's claim stays `unknown`), so the admission is decided on what
    // the final burns: `per-cue-caption-certification` admits the report the Director really produces when the unknown face claim
    // is its ONLY reservation, and the worker then certifies every burned cue and omits the rest. A report that DOES claim a
    // verified face safety keeps the original requirement: every evidence ref must be a face perception envelope of the run.
    // ADR-160. Nothing is inherited from a report that did not judge this request: the admission binds the report to the request the brief
    // states now (recomputed here) and to the resolution the Director run sealed (read back and verified here).
    let currentRequestHash: string
    try {
      currentRequestHash = deriveEditorialRequestFromBrief(JSON.parse(version.briefSnapshot.contentJson) as Record<string, unknown>).requestHash
    } catch { return null }
    let sealedPolicyResolutionHash: string | null = null
    if (directorRun.policySnapshot) {
      if (directorRun.policySnapshot.kind !== 'policy-resolution' || directorRun.policySnapshot.schemaVersion !== 1) return null
      const resolution = parseEditorialPolicyResolution(JSON.parse(directorRun.policySnapshot.contentJson))
      if (resolution.requestHash !== directorRun.requestHash) return null
      sealedPolicyResolutionHash = resolution.policyResolutionHash
    }
    const admission = admitDirectorQualityForFinal(quality, {
      currentRequestHash, sealedRequestHash: directorRun.requestHash, sealedPolicyResolutionHash,
    })
    if (!admission.admitted) return null
    if (admission.basis === 'verified-face-safety') {
      for (const reference of quality.faceSafety.evidenceRefs) {
        const evidence = await this.perceptionEvidence.read({ id: reference,
          workspaceId: input.workspaceId, projectId: input.projectId,
          inputVersionId: directorRun.baseVersionId, now: new Date() })
        // OCR is source-authenticated but carries no facial clearance. No face producer is authorized yet.
        if (!evidence || String(evidence.modality) !== 'face') return null
      }
    }
    return Object.freeze({
      locale: project.locale ?? 'pt-BR',
      directorRunId: directorRun.id,
      ...(inheritance ? { directorInheritance: inheritance } : {}),
      qualitySnapshotId: directorRun.qualitySnapshotId,
      qualitySnapshotHash: directorRun.qualitySnapshot.contentHash,
      qualityStatus: quality.status as 'approved' | 'approved-with-warnings' | 'review-required',
      admissionBasis: admission.basis,
      qualityScore: quality.score,
      proxyReviewId: proxyReview.id,
      proxyReviewHash: proxyReview.reviewHash,
      proxyArtifactId: proxyReview.proxyArtifactId,
      // W66r. The crop trajectory the approved proxy was drawn from (null: it was drawn without one).
      approvedReframePlanHash: (() => {
        if (typeof proxyReview.formatQualityJson !== 'string') return null
        const hash = (JSON.parse(proxyReview.formatQualityJson) as { reframePlanHash?: unknown }).reframePlanHash
        return typeof hash === 'string' ? hash : null
      })(),
      // W68. The subtitle exceptions the approved proxy was drawn with (null: drawn with none).
      approvedSubtitleOverridesHash: (() => {
        if (typeof proxyReview.formatQualityJson !== 'string') return null
        const hash = (JSON.parse(proxyReview.formatQualityJson) as { subtitleOverridesHash?: unknown }).subtitleOverridesHash
        return typeof hash === 'string' ? hash : null
      })(),
    })
  }

  async readApprovedCurrentSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    variantId?: string
  }): Promise<Readonly<ApprovedProjectFinalExportSource> | null> {
    // The final verdict first: a Version the persisted consumption does not admit for a final export (a cut copy still without
    // perception authority, a copy never cut, ...) refuses with its published reason before any approval is looked up.
    const source = await this.sourceReader.readCurrentSource({ workspaceId: input.workspaceId, projectId: input.projectId, purpose: 'final',
      ...(input.variantId === undefined ? {} : { variantId: input.variantId }) })
    if (!source || source.projectVersionId !== input.projectVersionId) return null
    const approval = await this.readApproval({ ...input, outputVariantId: sourceOutputVariantId(source),
      outputSpecId: readOutputFormatPreset(source.format as OutputAspectRatio).spec.id, requireCurrent: true })
    if (!approval || !reframeMatchesApproval(source, approval) || !subtitleOverridesMatchApproval(source, approval)) return null
    return Object.freeze({ ...source, projectVersionHash: input.projectVersionHash, ...approval })
  }

  /**
   * The output a format names in one Version: the stable variant of the only entry whose sealed spec carries that aspect ratio.
   * `null` when none does; two outputs of one ratio are refused (`output-variant-ambiguous`), exactly as everywhere else. This
   * is how a caller whose request names a format and not a variant (an export matrix cell) addresses an output without a guess.
   */
  async resolveOutputVariantByFormat(input: Parameters<ProjectFinalExportRepository['resolveOutputVariantByFormat']>[0]): Promise<string | null> {
    const stored = await readStoredOutputStateV3(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: input.projectVersionId })
    if (!stored) return null
    const matches = outputVariantsOf(stored.state).filter((variant) => variant.aspectRatio === input.format)
    if (matches.length > 1) {
      throw new DomainError('PRECONDITION_REQUIRED', 'Two outputs of this project share one aspect ratio', { reason: 'output-variant-ambiguous' })
    }
    return matches[0]?.variantId ?? null
  }

  async readImmutableApprovedSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    editPlanSnapshotId: string
    directorRunId: string
    qualitySnapshotId: string
    qualitySnapshotHash: string
    proxyReviewId: string
    proxyReviewHash: string
    proxyArtifactId: string
    sourceArtifactId: string
    sourceManifestId: string
    directorInheritance?: Readonly<DirectorRunInheritance> | null
    variantId?: string
    requireCurrent?: boolean
  }): Promise<Readonly<ApprovedProjectFinalExportSource> | null> {
    const source = await this.sourceReader.readImmutableSource({
      workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId,
      editPlanSnapshotId: input.editPlanSnapshotId, sourceArtifactId: input.sourceArtifactId, sourceManifestId: input.sourceManifestId,
      purpose: 'final', ...(input.variantId === undefined ? {} : { variantId: input.variantId }),
      ...(input.requireCurrent === true ? { requireCurrent: true } : {}),
    })
    if (!source) return null
    const approval = await this.readApproval({ ...input, directorInheritance: input.directorInheritance ?? null, outputVariantId: sourceOutputVariantId(source),
      outputSpecId: readOutputFormatPreset(source.format as OutputAspectRatio).spec.id, requireCurrent: false })
    if (!approval || !reframeMatchesApproval(source, approval) || !subtitleOverridesMatchApproval(source, approval)) return null
    return Object.freeze({ ...source, projectVersionHash: input.projectVersionHash, ...approval })
  }

  async convergeOutputIdentity(input: Parameters<ProjectFinalExportRepository['convergeOutputIdentity']>[0]): Promise<void> {
    const now = new Date(input.now)
    if (Number.isNaN(now.getTime())) throw new DomainError('PERSISTENCE_CONFLICT', 'Final export convergence time is invalid')
    await this.client.$transaction(async (transaction) => {
      const operation = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          workspaceId: input.workspaceId,
          type: 'project-final-export',
          status: 'running',
          targetType: 'media-artifact',
          targetId: input.reservedArtifactId,
          leaseOwner: input.leaseOwner,
          attempt: input.attempt,
          leaseExpiresAt: { gt: now },
        },
        data: { targetId: input.persistedArtifactId, updatedAt: now },
      })
      const context = await transaction.v2ProjectFinalExportOperation.updateMany({
        where: {
          operationId: input.operationId,
          workspaceId: input.workspaceId,
          outputArtifactId: input.reservedArtifactId,
          outputManifestId: input.reservedManifestId,
        },
        data: {
          outputArtifactId: input.persistedArtifactId,
          outputManifestId: input.persistedManifestId,
        },
      })
      if (operation.count !== 1 || context.count !== 1) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Final export output identity did not converge under its active lease')
      }
    })
  }

  async attachCompletedOutput(input: Parameters<ProjectFinalExportRepository['attachCompletedOutput']>[0]): Promise<void> {
    await this.client.$transaction(async (transaction) => {
      const [operation, artifact, manifest] = await Promise.all([
        transaction.v2ProjectFinalExportOperation.findFirst({
          where: {
            operationId: input.operationId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            projectVersionId: input.projectVersionId,
            outputArtifactId: input.outputArtifactId,
            outputManifestId: input.outputManifestId,
          },
        }),
        transaction.v2MediaArtifact.findFirst({ where: { id: input.outputArtifactId, workspaceId: input.workspaceId, status: 'available' } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.outputManifestId, workspaceId: input.workspaceId, artifactId: input.outputArtifactId } }),
      ])
      if (!operation || !artifact || !manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed project final export is inconsistent')
      // The invalidations this export resolves are attributed to the output it was made for: its stable State variant (a row written
      // before the column existed is attributed by its ratio, only when exactly one output of the Version has it).
      const outputVariantId = operation.outputVariantId ?? await (async () => {
        const stored = await readStoredOutputStateV3(transaction, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: input.projectVersionId })
        if (!stored) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed project final export has no sealed State')
        return renderOperationVariantId(stored.state, { outputVariantId: null, outputAspectRatio: operation.outputAspectRatio })
      })()
      await transaction.v2ProjectMediaAsset.upsert({
        where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: input.outputArtifactId, role: 'final-output' } },
        create: {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          artifactId: input.outputArtifactId,
          role: 'final-output',
          originalFileName: input.originalFileName,
          createdAt: new Date(input.createdAt),
        },
        update: {},
      })
      const unresolvedInvalidations = await transaction.v2CommandArtifactInvalidation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          resultVersionId: input.projectVersionId,
          kind: 'final',
          variantId: outputVariantId,
          resolutions: { none: { operation: { status: 'succeeded' } } },
        },
        select: { id: true },
      })
      if (unresolvedInvalidations.length > 0) {
        for (const invalidation of unresolvedInvalidations) {
          const replacement = {
            replacementArtifactId: input.outputArtifactId,
            replacementManifestId: input.outputManifestId,
            createdAt: new Date(input.createdAt),
          }
          await transaction.v2CommandArtifactInvalidationResolution.upsert({
            where: { invalidationId_operationId: {
              invalidationId: invalidation.id,
              operationId: input.operationId,
            } },
            create: {
              id: randomUUID(),
              invalidationId: invalidation.id,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              operationId: input.operationId,
              ...replacement,
            },
            update: replacement,
          })
        }
      }
      const updated = await transaction.v2Project.updateMany({
        where: {
          id: input.projectId, workspaceId: input.workspaceId,
          currentVersionId: input.projectVersionId,
          status: { in: projectStatusTransitionPath('rendering-final', 'completed', { includeSame: true }) },
        },
        data: { status: 'completed' },
      })
      if (updated.count !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Final export no longer matches the current project version')
    })
  }

  async markExportFailed(input: Parameters<ProjectFinalExportRepository['markExportFailed']>[0]): Promise<void> {
    const operation = await this.client.v2ProjectFinalExportOperation.findFirst({
      where: { operationId: input.operationId, workspaceId: input.workspaceId, projectId: input.projectId },
      select: { projectVersionId: true },
    })
    if (!operation) return
    // Another output's export of the same Version, queued, running or done, owns the project's status: this export failing is its
    // own failure (the operation records it), never the project's, or the sibling's completion would find a failed project.
    const siblings = await this.client.v2ProjectFinalExportOperation.count({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: operation.projectVersionId,
        operationId: { not: input.operationId }, operation: { status: { notIn: ['failed', 'canceled'] } } },
    })
    if (siblings > 0) return
    const project = await this.client.v2Project.updateMany({
      where: {
        id: input.projectId,
        workspaceId: input.workspaceId,
        currentVersionId: operation.projectVersionId,
        status: { in: projectStatusTransitionPath('rendering-final', 'failed', { includeSame: true }) },
      },
      data: { status: 'failed' },
    })
    if (project.count !== 1) {
      throw new DomainError('PROJECT_TRANSITION_REJECTED', 'Project cannot fail final export from its current status')
    }
  }

  async recordAttempt(
    input: Parameters<ProjectFinalExportRepository['recordAttempt']>[0],
  ): Promise<void> {
    const startedAt = new Date(input.startedAt)
    const completedAt = new Date(input.completedAt)
    const validValidators = input.validators.length >= 1 &&
      input.validators.length <= 100 &&
      input.validators.every((validator) =>
        /^[A-Z][A-Z0-9_]{2,63}$/.test(validator.code) &&
        validator.message.trim().length >= 1 &&
        validator.message.length <= 500)
    if (
      !Number.isSafeInteger(input.attempt) || input.attempt < 1 ||
      Number.isNaN(startedAt.getTime()) ||
      Number.isNaN(completedAt.getTime()) ||
      completedAt < startedAt ||
      !validValidators ||
      (input.status === 'promoted' && (
        !input.output ||
        input.error !== undefined ||
        !/^[a-f0-9]{64}$/.test(input.output.sha256) ||
        !Number.isSafeInteger(input.output.byteSize) ||
        input.output.byteSize < 1
      )) ||
      (input.status === 'failed' && (
        input.output !== undefined ||
        !input.error ||
        input.error.code.trim().length < 1 ||
        input.error.message.trim().length < 1 ||
        (input.error.stage !== undefined && !FAILURE_STAGES.has(input.error.stage))
      ))
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Final export attempt is invalid')
    const validatorsJson = stableSerialize(input.validators)
    await this.client.$transaction(async (transaction) => {
      const existing = await transaction.v2ProjectFinalExportAttempt.findUnique({
        where: {
          operationId_attempt: {
            operationId: input.operationId,
            attempt: input.attempt,
          },
        },
      })
      if (existing) {
        const converged =
          existing.workspaceId === input.workspaceId &&
          existing.status === input.status &&
          existing.validatorsJson === validatorsJson &&
          existing.outputArtifactId === (input.output?.artifactId ?? null) &&
          existing.outputManifestId === (input.output?.manifestId ?? null) &&
          existing.outputSha256 === (input.output?.sha256 ?? null) &&
          existing.outputByteSize === (input.output ? BigInt(input.output.byteSize) : null) &&
          existing.errorCode === (input.error?.code ?? null) &&
          existing.errorMessage === (input.error?.message ?? null) &&
          existing.errorStage === (input.error?.stage ?? null) &&
          existing.startedAt.getTime() === startedAt.getTime() &&
          existing.completedAt.getTime() === completedAt.getTime()
        if (!converged) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Final export attempt identity did not converge')
        }
        return
      }
      const operation = await transaction.v2ProjectFinalExportOperation.findFirst({
        where: {
          operationId: input.operationId,
          workspaceId: input.workspaceId,
          operation: {
            status: 'running',
            leaseOwner: input.leaseOwner,
            attempt: input.attempt,
            leaseExpiresAt: { gt: completedAt },
          },
        },
        select: { operationId: true },
      })
      if (!operation) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Final export attempt lost its active lease')
      }
      await transaction.v2ProjectFinalExportAttempt.create({
        data: {
          operationId: input.operationId,
          workspaceId: input.workspaceId,
          attempt: input.attempt,
          status: input.status,
          validatorsJson,
          outputArtifactId: input.output?.artifactId,
          outputManifestId: input.output?.manifestId,
          outputSha256: input.output?.sha256,
          outputByteSize: input.output ? BigInt(input.output.byteSize) : undefined,
          errorCode: input.error?.code,
          errorMessage: input.error?.message,
          errorStage: input.error?.stage,
          startedAt,
          completedAt,
        },
      })
    })
  }

  async readAttemptHistory(input: {
    workspaceId: string
    operationId: string
  }): Promise<Readonly<ProjectFinalExportAttemptHistory> | null> {
    const record = await this.client.v2ProjectFinalExportOperation.findFirst({
      where: {
        operationId: input.operationId,
        workspaceId: input.workspaceId,
      },
      select: {
        operationId: true,
        projectId: true,
        projectVersionId: true,
        proxyReviewId: true,
        outputAspectRatio: true,
        outputWidth: true,
        outputHeight: true,
        outputFps: true,
        outputCodec: true,
        outputAudioCodec: true,
        outputContainer: true,
        outputQuality: true,
        attempts: {
          orderBy: { attempt: 'asc' },
          take: 100,
        },
      },
    })
    if (!record) return null
    if (
      !['9:16', '16:9', '4:5', '1:1', '21:9'].includes(record.outputAspectRatio) ||
      record.outputCodec !== 'h264' ||
      record.outputAudioCodec !== 'aac' ||
      record.outputContainer !== 'mp4' ||
      record.outputQuality !== 'final'
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored final export profile is invalid')
    }
    const attempts = record.attempts.map((attempt) => {
      let validators: ProjectFinalExportAttemptHistory['attempts'][number]['validators']
      try {
        const parsed = JSON.parse(attempt.validatorsJson) as unknown
        if (
          !Array.isArray(parsed) ||
          parsed.length < 1 ||
          parsed.length > 100 ||
          !parsed.every((validator) =>
            typeof validator === 'object' &&
            validator !== null &&
            !Array.isArray(validator) &&
            typeof (validator as Record<string, unknown>).code === 'string' &&
            typeof (validator as Record<string, unknown>).passed === 'boolean' &&
            typeof (validator as Record<string, unknown>).message === 'string')
        ) throw new Error('invalid')
        validators = parsed as ProjectFinalExportAttemptHistory['attempts'][number]['validators']
      } catch {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored final export validators are invalid')
      }
      const byteSize = attempt.outputByteSize === null ? undefined : Number(attempt.outputByteSize)
      if (byteSize !== undefined && (!Number.isSafeInteger(byteSize) || byteSize < 1)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored final export byte size is invalid')
      }
      if (attempt.errorStage !== null && !FAILURE_STAGES.has(attempt.errorStage)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored final export failure stage is invalid')
      }
      return Object.freeze({
        attempt: attempt.attempt,
        status: attempt.status as 'failed' | 'promoted',
        validators: Object.freeze(validators.map((validator) => Object.freeze({ ...validator }))),
        ...(attempt.outputArtifactId && attempt.outputManifestId && attempt.outputSha256 && byteSize !== undefined
          ? {
              output: Object.freeze({
                artifactId: attempt.outputArtifactId,
                manifestId: attempt.outputManifestId,
                sha256: attempt.outputSha256,
                byteSize,
              }),
            }
          : {}),
        ...(attempt.errorCode && attempt.errorMessage
          ? { error: Object.freeze({ code: attempt.errorCode, message: attempt.errorMessage,
              ...(attempt.errorStage ? { stage: attempt.errorStage as NonNullable<ProjectFinalExportAttemptHistory['attempts'][number]['error']>['stage'] } : {}) }) }
          : {}),
        startedAt: attempt.startedAt.toISOString(),
        completedAt: attempt.completedAt.toISOString(),
      })
    })
    return Object.freeze({
      operationId: record.operationId,
      projectId: record.projectId,
      projectVersionId: record.projectVersionId,
      proxyReviewId: record.proxyReviewId,
      outputSpec: Object.freeze({
        aspectRatio: record.outputAspectRatio as ProjectFinalExportAttemptHistory['outputSpec']['aspectRatio'],
        width: record.outputWidth,
        height: record.outputHeight,
        fps: record.outputFps,
        codec: 'h264',
        audioCodec: 'aac',
        container: 'mp4',
        quality: 'final',
      }),
      attempts: Object.freeze(attempts),
    })
  }
}
