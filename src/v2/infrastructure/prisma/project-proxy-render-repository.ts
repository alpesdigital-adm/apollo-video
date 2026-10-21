import { createHash, randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { EditorialCutEditPlan } from '../../application/apply-editorial-cut-command.ts'
import type { DirectedEditPlan } from '../../domain/director-run.ts'
import type { ProjectProxyRenderRepository, ProjectProxyRenderSource, ProjectRenderConsumptionPurpose } from '../../application/ports/project-proxy-render-repository.ts'
import { MAX_PARTIAL_RENDER_RANGES } from '../../application/ports/project-proxy-render-repository.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION } from '../../application/ports/editorial-proxy-renderer.ts'
import { catalogApprovedOutputService } from '../../application/catalog-approved-output.ts'
import { calculateVersionHash } from '../../application/version-hash.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { PrismaAssetRightsRepository } from './asset-rights-repository.ts'
import { expectedOcrTimeline } from '../../domain/projected-ocr-timeline.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  parseCommandArtifactInvalidation,
  parseCommandImpact,
} from '../../domain/command-impact.ts'
import { editCommandRenderPolicy } from '../../domain/edit-command-registry.ts'
import { PrismaRenderablePlanSnapshotRepository } from './renderable-plan-snapshot-repository.ts'
import { readSafeReusableProxy, selectReusableProxyOperation } from './proxy-reuse-safety.ts'
import { sourceOutputVariantId } from '../../application/project-render-sources.ts'
import { queryProxySourceProject, hydrateProxySource, hydrateProxyRenderSources, uniqueSourceLink, effectiveDirectorRunOf,
  parseProxySourceRecord, parseProxySourceCriticIssues, assertProxySourceLineage, lockProxySourceArtifacts } from './proxy-source-authority.ts'
import { parseDirectorPerceptionSnapshotUnchecked } from './director-run-repository.ts'
import { readPerceptionProducerEnvelope } from './perception-producer-envelope-repository.ts'
import { PrismaAutomaticCatalogRepository } from './automatic-catalog-repository.ts'
import { PrismaProxyReviewRepository } from './proxy-review-repository.ts'
import { reframeTimelineOf } from '../../application/project-reframe-facts.ts'
import { reframeClipMapHash } from '../../domain/variant-reframe-plan.ts'
import { readVariantReframePlanHead } from './variant-reframe-plan-repository.ts'
import { readSubtitleSegmentOverrideHeads } from './subtitle-segment-override-repository.ts'
import { subtitleOverrideSetHash } from '../../domain/subtitle-segment-override.ts'
import { PrismaPublicOperationRepository } from './public-operation-repository.ts'

function parseArray(value: string, field: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function assertSealedProxyRecipe(input: Readonly<{
  recipeParameters: Readonly<Record<string, unknown>>
  /** A project render: the stable State variant it was made for. A renderable snapshot: its LOCALIZATION variant. */
  variantId: string
  /** A project render: the aspect ratio it drew (the recipe records the same). Absent for a renderable snapshot. */
  format?: string
  ocrReceipt: Readonly<NonNullable<Parameters<ProjectProxyRenderRepository['attachCompletedOutput']>[0]['ocrReceipt']>> | null
}>, operation: Readonly<{ inputHash: string; projectVersionId: string; editPlanSnapshotId: string;
  renderablePlanHash?: string | null; renderableVariantId?: string | null;
  renderableFormat?: string | null; outputVariantId?: string | null }>,
artifact: Readonly<{ artifactKey: string; sha256: string; byteSize: bigint; mediaType: string; container: string }>,
manifest: Readonly<{ manifestJson: string; manifestHash: string }>): void {
  const manifestBody = parseProxySourceRecord(manifest.manifestJson, 'project proxy output manifest')
  const { manifestHash, ...unsignedManifest } = manifestBody
  const recipe = manifestBody.recipe
  const manifestArtifact = manifestBody.artifact
  if (manifestHash !== manifest.manifestHash ||
      calculateCanonicalHash(unsignedManifest) !== manifestHash ||
      typeof manifestArtifact !== 'object' || manifestArtifact === null || Array.isArray(manifestArtifact) ||
      (manifestArtifact as Record<string, unknown>).artifactKey !== artifact.artifactKey ||
      (manifestArtifact as Record<string, unknown>).sha256 !== artifact.sha256 ||
      (manifestArtifact as Record<string, unknown>).byteSize !== Number(artifact.byteSize) ||
      (manifestArtifact as Record<string, unknown>).mediaType !== artifact.mediaType ||
      (manifestArtifact as Record<string, unknown>).container !== artifact.container ||
      typeof recipe !== 'object' || recipe === null || Array.isArray(recipe) ||
      (recipe as Record<string, unknown>).id !== 'editorial-proxy' ||
      (recipe as Record<string, unknown>).version !== EDITORIAL_PROXY_RECIPE_VERSION ||
      (recipe as Record<string, unknown>).parametersHash !== calculateCanonicalHash(input.recipeParameters) ||
      !Object.hasOwn(input.recipeParameters, 'ocrReceipt') ||
      !Object.hasOwn(input, 'ocrReceipt') ||
      calculateCanonicalHash(input.recipeParameters.ocrReceipt) !== calculateCanonicalHash(input.ocrReceipt) ||
      input.recipeParameters.inputHash !== operation.inputHash ||
      input.recipeParameters.projectVersionId !== operation.projectVersionId ||
      input.recipeParameters.editPlanSnapshotId !== operation.editPlanSnapshotId ||
      (operation.renderablePlanHash
        ? (operation.renderableVariantId !== input.variantId ||
          input.recipeParameters.format !== operation.renderableFormat)
        // A project render: the recipe's format is the aspect ratio of the output, and the output is the one the operation was
        // persisted for (a legacy row, persisted for none, accepts the sole output it resolves to).
        : (input.format === undefined || input.recipeParameters.format !== input.format ||
          (operation.outputVariantId != null && operation.outputVariantId !== input.variantId)))) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Project proxy receipt is not sealed by the output recipe')
  }
}

function isProxySerializationConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  if (error.code === 'P2034') return true
  return error.code === 'P2010' && 'meta' in error && typeof error.meta === 'object' &&
    error.meta !== null && 'code' in error.meta && error.meta.code === '40001'
}


export class PrismaProjectProxyRenderRepository implements ProjectProxyRenderRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  queryProject(input: Parameters<typeof queryProxySourceProject>[1], client: PrismaClient | Prisma.TransactionClient = this.client) {
    return queryProxySourceProject(client, input)
  }

  /** The head Version, consumed for `purpose` (default: the proxy render). The persisted verdict refuses what may not be consumed. */
  async readCurrentSource(input: { workspaceId: string; projectId: string; purpose?: ProjectRenderConsumptionPurpose; variantId?: string }) {
    const project = await this.queryProject(input)
    const source = hydrateProxySource(project)
    return source ? this.attachSubtitleOverrides(project!, await this.attachReframePlan(project!, await this.attachTrustedOcr(project!, await this.attachRangeReuse(input.workspaceId, project!, source)))) : null
  }

  /** The exact Version a worker was sealed to, consumed for `purpose` (default: the proxy render). */
  async readImmutableSource(input: { workspaceId: string; projectId: string; projectVersionId: string; editPlanSnapshotId: string; sourceArtifactId: string;
    sourceManifestId: string; purpose?: ProjectRenderConsumptionPurpose; variantId?: string; requireCurrent?: boolean }) {
    const project = await this.queryProject(input)
    if (input.requireCurrent === true && project && project.currentVersionId !== input.projectVersionId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'The sealed Version is no longer the current Version of the project')
    }
    const source = hydrateProxySource(project, input)
    return source ? this.attachSubtitleOverrides(project!, await this.attachReframePlan(project!, await this.attachTrustedOcr(project!, await this.attachRangeReuse(input.workspaceId, project!, source)))) : null
  }

  /**
   * W66r. The reframe plan persisted for THIS Version and THIS output (by its stable variant id), with its localized issues and its content
   * address. Nothing is decided here: a Version with no persisted plan renders as it always did. A plan that does not describe the Version it
   * is bound to (another spec revision, other clips) is a defect and stops the read, it is never bent onto the render.
   *
   * A reframed render is always a full render of the output: the bytes of an earlier proxy were drawn under another trajectory, and the
   * renderer refuses a trajectory combined with a reused range.
   */
  private async attachReframePlan(
    project: NonNullable<Awaited<ReturnType<PrismaProjectProxyRenderRepository['queryProject']>>>,
    source: Readonly<ProjectProxyRenderSource>,
    client: PrismaClient | Prisma.TransactionClient = this.client,
  ): Promise<Readonly<ProjectProxyRenderSource>> {
    const variantId = sourceOutputVariantId(source)
    const stored = await readVariantReframePlanHead(client, { workspaceId: project.workspaceId, projectId: project.id, projectVersionId: source.projectVersionId, variantId })
    if (!stored) return source
    const record = stored.record
    const facts = reframeTimelineOf(source)
    const seal = source.outputConsumption.seal
    if (
      record.binding.specHash !== seal.specHash || record.binding.outputSpecRevisionId !== seal.outputSpecRevisionId ||
      record.binding.aspectRatio !== source.format ||
      record.binding.clipMapHash !== reframeClipMapHash(facts.timeline, facts.clips.map(({ hasStaticCrop: _crop, ...clip }) => clip)) ||
      record.renderPlan.variantId !== variantId
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'The persisted reframe plan does not describe the Version and output it is bound to')
    const { rangeReuse: _range, unchangedReuse: _unchanged, unchangedReuseRequired: _required, ...rest } = source
    return Object.freeze({ ...rest, reframePlan: record.renderPlan, reframeIssues: record.issues, reframeRecordHash: record.recordHash })
  }

  /**
   * W68. The persisted subtitle exceptions of THIS output, applied by the single geometry derivation (text, visibility, style, and the band
   * an operator pinned a cue to). Nothing is decided here: a variant with no exception that carries a value renders as it always did, with
   * the identity it always had.
   *
   * A render that carries an exception is always a full render of the output: the bytes of an earlier proxy were drawn under another
   * caption, so a reused range or an unchanged-render reuse of them would put the old caption back.
   */
  private async attachSubtitleOverrides(
    project: NonNullable<Awaited<ReturnType<PrismaProjectProxyRenderRepository['queryProject']>>>,
    source: Readonly<ProjectProxyRenderSource>,
    client: PrismaClient | Prisma.TransactionClient = this.client,
  ): Promise<Readonly<ProjectProxyRenderSource>> {
    const variantId = sourceOutputVariantId(source)
    const heads = await readSubtitleSegmentOverrideHeads(client, { workspaceId: project.workspaceId, projectId: project.id, variantId })
    const overridesHash = subtitleOverrideSetHash(heads, variantId)
    if (overridesHash === null) return source
    const { rangeReuse: _range, unchangedReuse: _unchanged, unchangedReuseRequired: _required, ...rest } = source
    return Object.freeze({ ...rest, subtitleOverrides: Object.freeze([...heads]), subtitleOverridesHash: overridesHash })
  }

  private async attachTrustedOcr(
    project: NonNullable<Awaited<ReturnType<PrismaProjectProxyRenderRepository['queryProject']>>>,
    source: Readonly<ProjectProxyRenderSource>,
    client: PrismaClient | Prisma.TransactionClient = this.client,
  ): Promise<Readonly<ProjectProxyRenderSource>> {
    // The Director's own run, or the one an ancestor reached through exception Commands only (W70 readiness): the evidence stays the
    // Director's (its `baseVersionId` below), and the time-map check refuses it whenever the clips are not the ones it was read for.
    const directed = effectiveDirectorRunOf(project)
    if (!directed) return source
    const run = directed.run
    if (run.resultVersionId !== (directed.inheritance?.directorResultVersionId ?? source.projectVersionId) || run.projectId !== project.id ||
        run.workspaceId !== project.workspaceId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy Director result lineage is invalid')
    }
    const perception = parseDirectorPerceptionSnapshotUnchecked({
      contentJson: run.perceptionSnapshot.contentJson,
      contentHash: run.perceptionSnapshot.contentHash,
      schemaVersion: run.perceptionSnapshot.schemaVersion,
      baseVersionId: run.baseVersionId,
    })
    if (perception.schemaVersion !== 2 || !perception.ocrEvidence) return source
    const evidence = perception.ocrEvidence
    if (evidence.sourceArtifactId !== source.sourceArtifactId ||
        evidence.sourceSha256 !== source.sourceSha256) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy OCR source identity differs from Director evidence')
    }
    const map = source.editPlan.videoTracks.filter((track) => track.kind === 'base-video')
      .flatMap((track) => track.clips.map((clip) => ({ clipId: clip.id,
        sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
        timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame,
        rate: clip.rate })))
    // A later edit may change the source→timeline projection. It must not inherit coordinates.
    if (calculateCanonicalHash(map) !== evidence.timeMapHash) return source
    const envelope = await readPerceptionProducerEnvelope(client, {
      id: evidence.envelopeId, workspaceId: project.workspaceId, projectId: project.id,
      inputVersionId: run.baseVersionId, now: new Date(),
    })
    if (!envelope || envelope.envelopeHash !== evidence.envelopeHash ||
        envelope.timeMapHash !== evidence.timeMapHash ||
        envelope.sourceArtifactId !== source.sourceArtifactId ||
        envelope.sourceSha256 !== source.sourceSha256 ||
        envelope.timelineDurationFrames !== source.editPlan.durationFrames ||
        envelope.timelineFps.num !== source.editPlan.fps * envelope.timelineFps.den) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy OCR envelope is not bound to the rendered version')
    }
    return Object.freeze({ ...source, trustedOcr: Object.freeze({
      envelopeId: envelope.id, envelopeHash: envelope.envelopeHash,
      inputVersionId: run.baseVersionId, timeMapHash: envelope.timeMapHash,
      timeline: expectedOcrTimeline(envelope, source.editPlan.fps,
        source.editPlan.durationFrames),
    }) })
  }

  async readRenderableSnapshotSource(input: { workspaceId: string; projectId: string; planId: string; planHash: string; format: string; variantId?: string },
    client: PrismaClient | Prisma.TransactionClient = this.client, evaluatedAt: Date = new Date()) {
    // Renderable snapshots use their own edit maps. OCR from a Director result is never inherited;
    // the worker renders cues only with explicit unknown-face review and no OCR coordinates.
    const snapshot = await new PrismaRenderablePlanSnapshotRepository(client).readByPlan(input)
    if (!snapshot || snapshot.projectId !== input.projectId || snapshot.plan.projectVersionId.trim().length === 0) return null
    if (!snapshot.plan.formatVariantRefs.includes(input.format as never)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable snapshot is not bound to the requested format')
    }
    // The plan's own Version is consumed (never the head) for the proxy render, and its sealed entry names the format: the
    // requested one must be it. A State with several outputs is a named gap (the sole-output rule refuses it, never guesses).
    const project = await this.queryProject({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectVersionId: snapshot.plan.projectVersionId,
      purpose: 'render',
      ...(input.variantId !== undefined ? { variantId: input.variantId } : {}),
    }, client)
    if (project && project.format !== input.format) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable snapshot is not bound to the requested format')
    }
    const version = project?.versions[0]
    if (!project || !version) return null
    if (project.outputConsumption.seal.projectVersionId !== version.id || project.outputConsumption.seal.projectVersionHash !== version.baseHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable snapshot Version is not the Version its output consumption seals')
    }
    const renderSources = hydrateProxyRenderSources(project, snapshot.plan, evaluatedAt)
    const directed = effectiveDirectorRunOf(project)
    const primary = renderSources.find((asset) => asset.mediaType === 'video') ?? renderSources[0]
    const primaryLink = primary ? uniqueSourceLink(project.mediaAssets, primary.artifactId) : undefined
    if (!primary || !primaryLink) throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable snapshot has no source media')
    return Object.freeze({
      projectId: project.id,
      projectVersionId: snapshot.plan.projectVersionId,
      // The version snapshot remains a lineage anchor only. The discriminated
      // renderableSnapshot operation context is the plan authority.
      editPlanSnapshotId: version.editPlanSnapshotId,
      editPlanHash: snapshot.planHash,
      editPlan: snapshot.plan,
      format: project.format,
      outputConsumption: project.outputConsumption,
      sourceArtifactId: primary.artifactId,
      sourceManifestId: primary.manifestId,
      sourceArtifactKey: primary.artifactKey,
      sourceSha256: primary.sha256,
      renderSources: Object.freeze(renderSources),
      originalFileName: primaryLink.originalFileName,
      uploadReceivedAt: (primaryLink.upload?.createdAt ?? primaryLink.createdAt).toISOString(),
      criticIssues: parseProxySourceCriticIssues(directed?.run.qualitySnapshot.contentJson),
      ...(directed?.inheritance ? { directorInheritance: directed.inheritance } : {}),
    })
  }

  private async assertCompletionLease(
    transaction: Prisma.TransactionClient,
    input: Parameters<ProjectProxyRenderRepository['attachCompletedOutput']>[0] |
      Parameters<ProjectProxyRenderRepository['attachCompletedSnapshotOutput']>[0],
  ): Promise<Date | null> {
    // The row lock serializes cancellation, heartbeat and final publication. Use the
    // database clock after acquiring it, so time spent waiting on a lock cannot
    // extend an expired lease through a stale worker timestamp.
    await transaction.$queryRaw`SELECT id FROM public_operations WHERE id = ${input.operationId} FOR UPDATE`
    const [{ observedAt }] = await transaction.$queryRaw<readonly { observedAt: Date }[]>`
      SELECT clock_timestamp() AS "observedAt"`
    const operation = await transaction.v2PublicOperation.findUnique({ where: { id: input.operationId } })
    if (operation?.status === 'succeeded' && operation.phase === 'completed') {
      const [detail, review, association, artifact, manifest] = await Promise.all([
        transaction.v2ProjectProxyRenderOperation.findUnique({ where: { operationId: input.operationId } }),
        transaction.v2ProxyReview.findUnique({ where: { operationId: input.operationId } }),
        transaction.v2ProjectMediaAsset.findFirst({ where: { workspaceId: input.workspaceId,
          projectId: input.projectId, artifactId: input.outputArtifactId, role: 'editorial-proxy' } }),
        transaction.v2MediaArtifact.findUnique({ where: { id: input.outputArtifactId } }),
        transaction.v2MediaArtifactManifest.findUnique({ where: { id: input.outputManifestId } }),
      ])
      const result = operation.resultJson ? parseProxySourceRecord(operation.resultJson, 'completed proxy result') : null
      const resource = result?.resource
      if (!detail || !review || !association || !artifact || !manifest ||
          operation.type !== 'project-proxy-render' ||
          operation.workspaceId !== input.workspaceId || operation.projectId !== input.projectId ||
          operation.targetType !== 'media-artifact' || operation.targetId !== input.outputArtifactId ||
          operation.attempt !== input.lease.attempt ||
          detail.workspaceId !== input.workspaceId || detail.projectId !== input.projectId ||
          detail.projectVersionId !== input.review.projectVersionId ||
          detail.outputArtifactId !== input.outputArtifactId ||
          detail.outputManifestId !== input.outputManifestId ||
          ('projectVersionId' in input && detail.projectVersionId !== input.projectVersionId) ||
          (detail.renderablePlanHash
            ? detail.renderableVariantId !== input.variantId
            : !('format' in input) || input.recipeParameters.format !== input.format) ||
          artifact.workspaceId !== input.workspaceId || artifact.status !== 'available' ||
          manifest.workspaceId !== input.workspaceId || manifest.artifactId !== input.outputArtifactId ||
          review.workspaceId !== input.workspaceId || review.projectId !== input.projectId ||
          review.projectVersionId !== detail.projectVersionId ||
          review.reviewHash !== input.review.reviewHash ||
          review.proxyArtifactId !== input.outputArtifactId ||
          review.proxyManifestId !== input.outputManifestId ||
          typeof resource !== 'object' || resource === null || Array.isArray(resource) ||
          (resource as Record<string, unknown>).type !== 'media-artifact' ||
          (resource as Record<string, unknown>).id !== input.outputArtifactId ||
          (resource as Record<string, unknown>).manifestId !== input.outputManifestId ||
          // W70 readiness (R2): a replay names the evidence the committed completion stored, or it is not the same completion.
          ('renderEvidence' in input && input.renderEvidence !== undefined &&
            (detail.faceEvidenceDigest !== input.renderEvidence.faceEvidenceDigest || detail.criticIssuesDigest !== input.renderEvidence.criticIssuesDigest))) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Completed proxy replay identity did not converge')
      }
      assertSealedProxyRecipe(input, detail, artifact, manifest)
      return null
    }
    if (!operation || operation.type !== 'project-proxy-render' ||
        operation.workspaceId !== input.workspaceId || operation.projectId !== input.projectId ||
        operation.targetType !== 'media-artifact' || operation.targetId !== input.outputArtifactId ||
        operation.status !== 'running' || operation.phase !== 'persisting' ||
        operation.leaseOwner !== input.lease.owner || operation.attempt !== input.lease.attempt ||
        !operation.leaseExpiresAt || operation.leaseExpiresAt <= observedAt ||
        !Number.isSafeInteger(input.lease.attempt) || input.lease.attempt < 1 ||
        !Number.isFinite(new Date(input.lease.now).getTime())) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy completion lost its active worker lease')
    }
    return observedAt
  }

  private async lockCompletionSources(
    transaction: Prisma.TransactionClient,
    input: Parameters<ProjectProxyRenderRepository['attachCompletedOutput']>[0] |
      Parameters<ProjectProxyRenderRepository['attachCompletedSnapshotOutput']>[0],
    operation: Readonly<{ projectVersionId: string; editPlanSnapshotId: string;
      sourceArtifactId: string; renderablePlanId?: string | null; renderablePlanHash?: string | null; outputVariantId?: string | null }>,
  ): Promise<Date> {
    // The operation fence is already held. Project/head and every authoritative
    // source pointer must participate: a plain SELECT in SERIALIZABLE can keep
    // seeing rights from before an operation-lock wait. FOR UPDATE on a changed
    // row instead raises 40001, requiring a wholly new transaction/snapshot.
    const projects = await transaction.$queryRaw<readonly { id: string }[]>`
      SELECT id FROM projects WHERE id = ${input.projectId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE`
    if (projects.length !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy publication project fence is unavailable')
    let plan: EditorialCutEditPlan | DirectedEditPlan
    if (operation.renderablePlanHash) {
      const snapshot = await new PrismaRenderablePlanSnapshotRepository(transaction).readByPlan({
        workspaceId: input.workspaceId, projectId: input.projectId,
        planId: operation.renderablePlanId ?? '', planHash: operation.renderablePlanHash,
      })
      if (!snapshot || snapshot.plan.projectVersionId !== operation.projectVersionId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy publication snapshot authority is unavailable')
      }
      plan = snapshot.plan
    } else {
      // The Version is consumed for the output the operation was made for (a legacy row: the State's only output).
      const project = await this.queryProject({ workspaceId: input.workspaceId,
        projectId: input.projectId, projectVersionId: operation.projectVersionId,
        editPlanSnapshotId: operation.editPlanSnapshotId,
        ...(operation.outputVariantId ? { variantId: operation.outputVariantId } : {}) }, transaction)
      const version = project?.versions[0]
      if (!project || !version || version.editPlanSnapshot.workspaceId !== input.workspaceId ||
          version.editPlanSnapshot.projectId !== input.projectId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy publication plan authority is unavailable')
      }
      plan = parseProxySourceRecord(version.editPlanSnapshot.contentJson, 'proxy publication EditPlan') as unknown as EditorialCutEditPlan | DirectedEditPlan
      if (plan.schemaVersion !== 2 || plan.state !== 'compiled' ||
          calculateVersionHash(plan) !== version.editPlanSnapshot.contentHash) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy publication plan authority is inconsistent')
      }
    }
    await lockProxySourceArtifacts(transaction, { workspaceId: input.workspaceId, plan,
      sourceArtifactId: operation.sourceArtifactId, outputArtifactId: input.outputArtifactId })
    // Refresh lease and clock only after every possible lock wait. Rights/source
    // reads in the caller are repeated under these fences before publication.
    const observedAt = await this.assertCompletionLease(transaction, input)
    if (!observedAt) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy completed while acquiring publication fences')
    return observedAt
  }

  private async completeProxyTransaction(
    transaction: Prisma.TransactionClient,
    input: Parameters<ProjectProxyRenderRepository['attachCompletedOutput']>[0] |
      Parameters<ProjectProxyRenderRepository['attachCompletedSnapshotOutput']>[0],
    observedAt: Date,
  ): Promise<void> {
    const detail = await transaction.v2ProjectProxyRenderOperation.findUnique({
      where: { operationId: input.operationId },
    })
    if (!detail || detail.workspaceId !== input.workspaceId || detail.projectId !== input.projectId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy context changed before completion')
    }
    const reviewInput = {
      id: `proxy-review-${createHash('sha256').update(input.operationId).digest('hex').slice(0, 32)}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      operationId: input.operationId,
      review: input.review,
      createdAt: input.createdAt,
      lease: input.lease,
    }
    const reviews = new PrismaProxyReviewRepository(this.client)
    if (detail.renderablePlanHash) {
      if (!detail.renderablePlanId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable snapshot plan identity is missing')
      }
      await reviews.persistRenderableSnapshotInTransaction(transaction, reviewInput, {
        planId: detail.renderablePlanId, planHash: detail.renderablePlanHash,
      })
    } else {
      await reviews.persistGeneratedInTransaction(transaction, reviewInput)
    }
    await catalogApprovedOutputService({
      repository: new PrismaAutomaticCatalogRepository(transaction),
      rights: new PrismaAssetRightsRepository(transaction),
      clock: () => observedAt,
    })({ workspaceId: input.workspaceId, artifactId: input.outputArtifactId,
      manifestId: input.outputManifestId })
    const completedAt = await this.assertCompletionLease(transaction, input)
    if (!completedAt) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy completed while finalizing')
    if (detail.renderablePlanHash) {
      const source = await this.readRenderableSnapshotSource({
        workspaceId: input.workspaceId, projectId: input.projectId,
        planId: detail.renderablePlanId ?? '', planHash: detail.renderablePlanHash,
        format: detail.renderableFormat ?? '',
        ...(detail.outputVariantId ? { variantId: detail.outputVariantId } : {}),
      }, transaction, completedAt)
      if (!source || source.sourceArtifactId !== detail.sourceArtifactId ||
          source.sourceManifestId !== detail.sourceManifestId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable source changed before completion')
      }
    } else {
      const project = await this.queryProject({ workspaceId: input.workspaceId,
        projectId: input.projectId, projectVersionId: detail.projectVersionId,
        ...(detail.outputVariantId ? { variantId: detail.outputVariantId } : {}) }, transaction)
      const source = hydrateProxySource(project, { sourceArtifactId: detail.sourceArtifactId,
        sourceManifestId: detail.sourceManifestId }, completedAt)
      if (!project || project.currentVersionId !== detail.projectVersionId ||
          !source || source.editPlanSnapshotId !== detail.editPlanSnapshotId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy source changed before completion')
      }
    }
    const completed = await new PrismaPublicOperationRepository(this.client).succeedProxyInTransaction(
      transaction,
      { operationId: input.operationId, leaseOwner: input.lease.owner,
        attempt: input.lease.attempt, now: completedAt.toISOString() },
    )
    if (!completed) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy completion lost its lease')
  }

  async findAdmittedOperationId(input: { workspaceId: string; projectId: string; projectVersionId: string; inputHash: string }): Promise<string | null> {
    const row = await this.client.v2ProjectProxyRenderOperation.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, inputHash: input.inputHash },
      select: { operationId: true },
    })
    return row?.operationId ?? null
  }

  /** The base Version's completed proxy of THE SAME OUTPUT (a render of another output is never offered, whatever its age). */
  private async readReusableProxy(input: {
    workspaceId: string
    projectId: string
    baseVersionId: string
    outputVariantId: string
    artifactIds?: readonly string[]
  }) {
    const previous = await selectReusableProxyOperation(this.client, input)
    if (!previous) return null
    return readSafeReusableProxy(this.client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      baseVersionId: input.baseVersionId, operationId: previous.operationId,
      artifactId: previous.outputArtifactId, manifestId: previous.outputManifestId,
      outputVariantId: input.outputVariantId,
    })
  }

  private async attachRangeReuse(
    workspaceId: string,
    project: NonNullable<Awaited<ReturnType<PrismaProjectProxyRenderRepository['queryProject']>>>,
    source: Readonly<ProjectProxyRenderSource>,
  ): Promise<Readonly<ProjectProxyRenderSource>> {
    const version = project.versions[0]
    const command = version?.command
    // The output this source was read for. Impact documents, invalidations and the base proxy all name outputs by their stable
    // State variant; a render of another output is never narrowed, nor reused, for this one.
    const outputVariantId = sourceOutputVariantId(source)
    // Range reuse is derived from the canonical registry: only Command types whose
    // declared policy is partial-range may narrow a render to stale ranges.
    if (!version || !command || editCommandRenderPolicy(command.type) !== 'partial-range') return source
    const payload = parseProxySourceRecord(command.payloadJson, 'project proxy Command payload')
    if (!payload.impact) return source
    const impact = parseCommandImpact(payload.impact)
    if (
      impact.commandId !== command.id ||
      impact.commandType !== command.type ||
      impact.baseVersionId !== command.baseVersionId ||
      impact.resultVersionId !== version.id
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Project proxy Command impact identity is inconsistent')
    }
    if (!impact.renderSemanticsChanged) {
      if (
        impact.changeKinds.length !== 1 || impact.changeKinds[0] !== 'selection' ||
        impact.affectedArtifacts.length !== 0 || impact.minimalRenders.length !== 0
      ) throw new DomainError('PERSISTENCE_CONFLICT', 'Render-free Command impact is inconsistent')
      const reusable = await this.readReusableProxy({
        workspaceId,
        projectId: source.projectId,
        baseVersionId: impact.baseVersionId,
        outputVariantId,
      })
      return Object.freeze({
        ...source,
        unchangedReuseRequired: true as const,
        ...(reusable ? { unchangedReuse: Object.freeze({
          schemaVersion: 'project-proxy-unchanged-reuse/v1' as const,
          commandId: command.id,
          impactHash: impact.impactHash,
          baseVersionId: impact.baseVersionId,
          ...reusable,
        }) } : {}),
      })
    }
    const minimalRenders = impact.minimalRenders.filter((render) =>
      render.kind === 'proxy' && render.variantId === outputVariantId)
    if (minimalRenders.length !== 1) return source
    const requestedRanges = minimalRenders[0]!.ranges
    const durationFrames = source.editPlan.durationFrames
    if (
      requestedRanges.length < 1 || requestedRanges.length > MAX_PARTIAL_RENDER_RANGES
    ) return source
    // Clamp each stale range to the compiled duration and require the canonical
    // shape the domain produces: ordered and strictly disjoint. Anything else —
    // including a set that covers the whole timeline — falls back to a full render.
    const ranges: { startFrame: number; endFrame: number }[] = []
    for (const requested of requestedRanges) {
      const startFrame = requested.startFrame
      const endFrame = Math.min(requested.endFrame, durationFrames)
      if (
        !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) ||
        startFrame < 0 || endFrame <= startFrame
      ) return source
      const previous = ranges.at(-1)
      if (previous && startFrame <= previous.endFrame) return source
      ranges.push({ startFrame, endFrame })
    }
    const staleFrames = ranges.reduce((total, item) => total + item.endFrame - item.startFrame, 0)
    if (ranges.length < 1 || staleFrames >= durationFrames) return source
    const invalidations = command.artifactInvalidations
      .filter((row) => !row.resolutions.some((resolution) => resolution.operation.status === 'succeeded'))
      .map((row) => parseCommandArtifactInvalidation({
        schemaVersion: 'command-artifact-invalidation/v1',
        id: row.id,
        status: row.status,
        commandId: row.commandId,
        baseVersionId: row.baseVersionId,
        resultVersionId: row.resultVersionId,
        artifactId: row.artifactId,
        kind: row.kind,
        variantId: row.variantId,
        dependencyTypes: parseArray(row.dependencyTypesJson, 'proxy invalidation dependencies'),
        affectedRanges: parseArray(row.affectedRangesJson, 'proxy invalidation ranges'),
        impactHash: row.impactHash,
        createdAt: row.createdAt.toISOString(),
      }))
    const proxyArtifactIds = invalidations
      .filter((item) =>
        item.kind === 'proxy' && item.variantId === outputVariantId &&
        item.commandId === command.id && item.baseVersionId === impact.baseVersionId &&
        item.resultVersionId === impact.resultVersionId && item.impactHash === impact.impactHash)
      .map((item) => item.artifactId)
    if (proxyArtifactIds.length === 0) return source
    const reusable = await this.readReusableProxy({
      workspaceId,
      projectId: source.projectId,
      baseVersionId: impact.baseVersionId,
      outputVariantId,
      artifactIds: proxyArtifactIds,
    })
    if (!reusable) return source
    return Object.freeze({
      ...source,
      rangeReuse: Object.freeze({
        schemaVersion: 'project-proxy-range-reuse/v1' as const,
        commandId: command.id,
        impactHash: impact.impactHash,
        baseVersionId: impact.baseVersionId,
        ranges: Object.freeze(ranges.map((item) => Object.freeze(item))),
        artifactId: reusable.artifactId,
        manifestId: reusable.manifestId,
        artifactKey: reusable.artifactKey,
        sha256: reusable.sha256,
        byteSize: reusable.byteSize,
      }),
    })
  }

  async attachCompletedOutput(input: Parameters<ProjectProxyRenderRepository['attachCompletedOutput']>[0]): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.client.$transaction(async (transaction) => {
      const admittedAt = await this.assertCompletionLease(transaction, input)
      if (!admittedAt) return
      const operation = await transaction.v2ProjectProxyRenderOperation.findFirst({ where: {
          operationId: input.operationId, workspaceId: input.workspaceId, projectId: input.projectId,
          projectVersionId: input.projectVersionId, outputArtifactId: input.outputArtifactId, outputManifestId: input.outputManifestId,
        } })
      if (!operation || operation.renderablePlanHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed project proxy context is inconsistent')
      const observedAt = await this.lockCompletionSources(transaction, input, operation)
      const [artifact, manifest] = await Promise.all([
        transaction.v2MediaArtifact.findFirst({ where: { id: input.outputArtifactId, workspaceId: input.workspaceId, status: 'available' } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.outputManifestId, workspaceId: input.workspaceId, artifactId: input.outputArtifactId } }),
      ])
      if (!artifact || !manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed project proxy output is inconsistent')
      assertSealedProxyRecipe(input, operation, artifact, manifest)
      if (input.renderEvidence) {
        // W70 readiness (R2). The evidence the content address cannot see, as this render read it: what a carry from it is compared with.
        const { faceEvidenceDigest, criticIssuesDigest } = input.renderEvidence
        if (![faceEvidenceDigest, criticIssuesDigest].every((digest) => /^[a-f0-9]{64}$/.test(digest))) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Completed project proxy evidence digests are invalid')
        }
        await transaction.v2ProjectProxyRenderOperation.update({
          where: { operationId: input.operationId }, data: { faceEvidenceDigest, criticIssuesDigest },
        })
      }
      // The Version is consumed for the output the render was made for: the stable variant the worker names.
      const project = await this.queryProject({ workspaceId: input.workspaceId,
        projectId: input.projectId, projectVersionId: input.projectVersionId, variantId: input.variantId }, transaction)
      if (!project || project.currentVersionId !== input.projectVersionId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy result version is no longer current')
      }
      const source = hydrateProxySource(project, { sourceArtifactId: operation.sourceArtifactId,
        sourceManifestId: operation.sourceManifestId }, observedAt)
      if (!source || source.editPlanSnapshotId !== operation.editPlanSnapshotId ||
          source.sourceArtifactId !== operation.sourceArtifactId ||
          source.sourceManifestId !== operation.sourceManifestId ||
          sourceOutputVariantId(source) !== input.variantId || source.format !== input.format) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy source changed during rendering')
      }
      assertProxySourceLineage(manifest.manifestJson, source)
      const resolved = await this.attachTrustedOcr(project, source, transaction)
      const ocr = resolved.trustedOcr
      if ((ocr === undefined) !== (input.ocrReceipt === null)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy OCR receipt presence differs from Director evidence')
      }
      if (input.ocrReceipt) {
        if (operation.sourceArtifactId !== input.ocrReceipt.sourceArtifactId ||
            operation.sourceManifestId !== input.ocrReceipt.sourceManifestId ||
            operation.editPlanSnapshotId !== input.recipeParameters.editPlanSnapshotId ||
            Object.keys(input.ocrReceipt).sort().join('|') !==
              'editPlanHash|envelopeHash|envelopeId|inputVersionId|sourceArtifactId|sourceManifestId|sourceSha256|timeMapHash|timelineHash') {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy OCR receipt source binding is invalid')
        }
        if (source.editPlanHash !== input.ocrReceipt.editPlanHash ||
            source.sourceSha256 !== input.ocrReceipt.sourceSha256 ||
            source.sourceManifestId !== input.ocrReceipt.sourceManifestId ||
            source.editPlanSnapshotId !== operation.editPlanSnapshotId) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy OCR source changed during rendering')
        }
        if (!ocr || ocr.envelopeId !== input.ocrReceipt.envelopeId ||
            ocr.envelopeHash !== input.ocrReceipt.envelopeHash ||
            ocr.inputVersionId !== input.ocrReceipt.inputVersionId ||
            ocr.timeMapHash !== input.ocrReceipt.timeMapHash ||
            ocr.timeline.timelineHash !== input.ocrReceipt.timelineHash) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy OCR evidence changed during rendering')
        }
      }
      await transaction.v2ProjectMediaAsset.upsert({
        where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: input.outputArtifactId, role: 'editorial-proxy' } },
        create: {
          id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId, artifactId: input.outputArtifactId,
          role: 'editorial-proxy', originalFileName: input.originalFileName, createdAt: new Date(input.createdAt),
        },
        update: {},
      })
      const unresolvedInvalidations = await transaction.v2CommandArtifactInvalidation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          resultVersionId: input.projectVersionId,
          kind: 'proxy',
          variantId: input.variantId,
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
      await transaction.v2DirectorRun.updateMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          resultVersionId: input.projectVersionId,
          status: { in: ['planned', 'rendering'] },
        },
        data: { status: 'succeeded' },
      })
      await this.completeProxyTransaction(transaction, input, observedAt)
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        return
      } catch (error) {
        const serialization = isProxySerializationConflict(error)
        if (serialization && attempt < 2) continue
        if (serialization) throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy attachment serialization conflicted')
        throw error
      }
    }
  }

  async attachCompletedSnapshotOutput(input: Parameters<ProjectProxyRenderRepository['attachCompletedSnapshotOutput']>[0]): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.client.$transaction(async (transaction) => {
      const admittedAt = await this.assertCompletionLease(transaction, input)
      if (!admittedAt) return
      const operation = await transaction.v2ProjectProxyRenderOperation.findFirst({ where: {
          operationId: input.operationId, workspaceId: input.workspaceId, projectId: input.projectId,
          renderableVariantId: input.variantId, outputArtifactId: input.outputArtifactId,
          outputManifestId: input.outputManifestId,
        } })
      if (!operation || !operation.renderablePlanHash || !operation.renderablePlanId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Completed renderable snapshot proxy context is inconsistent')
      }
      const observedAt = await this.lockCompletionSources(transaction, input, operation)
      const [artifact, manifest] = await Promise.all([
        transaction.v2MediaArtifact.findFirst({ where: { id: input.outputArtifactId, workspaceId: input.workspaceId, status: 'available' } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.outputManifestId, workspaceId: input.workspaceId, artifactId: input.outputArtifactId } }),
      ])
      if (!artifact || !manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed renderable snapshot proxy output is inconsistent')
      assertSealedProxyRecipe(input, operation, artifact, manifest)
      if (input.ocrReceipt !== null || input.recipeParameters.ocrReceipt !== null ||
          !operation.renderablePlanId || !operation.renderablePlanHash ||
          operation.renderableVariantId !== input.variantId ||
          operation.renderableFormat !== input.recipeParameters.format) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable snapshot proxy receipt is invalid')
      }
      const source = await this.readRenderableSnapshotSource({
        workspaceId: input.workspaceId, projectId: input.projectId,
        planId: operation.renderablePlanId, planHash: operation.renderablePlanHash,
        format: operation.renderableFormat!,
        ...(operation.outputVariantId ? { variantId: operation.outputVariantId } : {}),
      }, transaction, observedAt)
      if (!source || source.projectVersionId !== operation.projectVersionId ||
          source.editPlanSnapshotId !== operation.editPlanSnapshotId ||
          source.editPlanHash !== operation.renderablePlanHash ||
          source.sourceArtifactId !== operation.sourceArtifactId ||
          source.sourceManifestId !== operation.sourceManifestId) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Renderable snapshot source changed before proxy attachment')
      }
      assertProxySourceLineage(manifest.manifestJson, source)
      await transaction.v2ProjectMediaAsset.upsert({
        where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: input.outputArtifactId, role: 'editorial-proxy' } },
        create: {
          id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId,
          artifactId: input.outputArtifactId, role: 'editorial-proxy',
          originalFileName: input.originalFileName, createdAt: new Date(input.createdAt),
        },
        update: {},
      })
      await this.completeProxyTransaction(transaction, input, observedAt)
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        return
      } catch (error) {
        const serialization = isProxySerializationConflict(error)
        if (serialization && attempt < 2) continue
        if (serialization) throw new DomainError('PERSISTENCE_CONFLICT', 'Snapshot proxy attachment serialization conflicted')
        throw error
      }
    }
  }
}
