import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ReviewPatchBatch,
  ReviewPatchBatchApplyContext,
  ReviewPatchBatchApplyResult,
  ReviewPatchBatchCommit,
  ReviewPatchBatchItem,
  ReviewPatchBatchProposalContext,
  ReviewPatchBatchRepository,
} from '../../application/ports/review-patch-batch-repository.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createCommandArtifactInvalidations,
  normalizeCommandImpactOutputReferences,
  parseCommandImpact,
} from '../../domain/command-impact.ts'
import {
  hydrateInvalidation,
  hydrateReviewAnnotation,
  hydrateReviewPatchProposal,
  hydrateReviewPatchVersion,
} from './review-patch-repository.ts'

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

type BatchRow = Prisma.V2ReviewPatchBatchGetPayload<{ include: { items: true; renderOperation: true } }>

function hydrateBatchItem(row: BatchRow['items'][number]): Readonly<ReviewPatchBatchItem> {
  return Object.freeze({
    id: row.id,
    annotationId: row.annotationId,
    proposalId: row.proposalId,
    status: row.status as ReviewPatchBatchItem['status'],
    operation: row.operationJson ? Object.freeze(parseJson<NonNullable<ReviewPatchBatchItem['operation']>>(row.operationJson, 'batch patch operation')) : null,
    conflictIds: Object.freeze(parseJson<string[]>(row.conflictIdsJson, 'batch conflict IDs')),
    ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function hydrateBatch(row: BatchRow): Readonly<ReviewPatchBatch> {
  const operation = row.renderOperation
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    baseVersionId: row.baseVersionId,
    mode: row.mode as ReviewPatchBatch['mode'],
    status: row.status as ReviewPatchBatch['status'],
    patch: row.patchJson ? Object.freeze(parseJson<NonNullable<ReviewPatchBatch['patch']>>(row.patchJson, 'batch patch')) : null,
    impact: row.impactJson ? Object.freeze(parseJson<NonNullable<ReviewPatchBatch['impact']>>(row.impactJson, 'batch impact')) : null,
    conflicts: Object.freeze(parseJson<string[]>(row.conflictsJson, 'batch conflicts')),
    items: Object.freeze(row.items.toSorted((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)).map(hydrateBatchItem)),
    ...(row.resultCommandId ? { resultCommandId: row.resultCommandId } : {}),
    ...(row.resultVersionId ? { resultVersionId: row.resultVersionId } : {}),
    ...(row.renderOperationId ? { renderOperationId: row.renderOperationId } : {}),
    ...(row.comparisonJson ? { comparison: Object.freeze(parseJson<NonNullable<ReviewPatchBatch['comparison']>>(row.comparisonJson, 'batch comparison')) } : {}),
    ...(operation ? {
      render: Object.freeze({
        operationId: operation.id,
        status: operation.status,
        phase: operation.phase,
        ...(operation.errorCode || operation.errorMessage ? { error: { code: operation.errorCode ?? 'RENDER_FAILED', message: operation.errorMessage ?? 'Batch patch render failed' } } : {}),
      }),
    } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as ReviewPatchBatch)
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaReviewPatchBatchRepository implements ReviewPatchBatchRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  private batchById(input: { workspaceId: string; projectId: string; batchId: string }) {
    return this.client.v2ReviewPatchBatch.findFirst({
      where: { id: input.batchId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: { items: true, renderOperation: true },
    })
  }

  async findBatchIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const row = await this.client.v2ReviewPatchBatch.findUnique({
      where: { workspaceId_projectId_idempotencyKey: input },
      include: { items: true, renderOperation: true },
    })
    return row ? Object.freeze({ requestFingerprint: row.requestFingerprint, batch: hydrateBatch(row) }) : null
  }

  async readProposalSet(input: { workspaceId: string; projectId: string; proposalIds: readonly string[] }): Promise<Readonly<ReviewPatchBatchProposalContext> | null> {
    const [project, rows] = await Promise.all([
      this.client.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        include: {
          currentVersion: { include: { editPlanSnapshot: true } },
          mediaAssets: { where: { artifact: { status: 'available' } }, select: { artifactId: true } },
        },
      }),
      this.client.v2ReviewPatchProposal.findMany({
        where: { id: { in: [...input.proposalIds] }, workspaceId: input.workspaceId, projectId: input.projectId },
        include: { annotation: true, renderOperation: true },
      }),
    ])
    const version = project?.currentVersion
    if (!project || !version || rows.length !== input.proposalIds.length) return null
    const byId = new Map(rows.map((row) => [row.id, row]))
    const entries = input.proposalIds.map((proposalId) => {
      const row = byId.get(proposalId)!
      return Object.freeze({
        annotation: hydrateReviewAnnotation(row.annotation),
        proposal: hydrateReviewPatchProposal(row),
      })
    })
    const renderVariantIds = Object.freeze([
      ...new Set([
        project.format ?? '9:16',
        ...entries.flatMap((entry) => entry.annotation.applicationScope.formatIds),
      ]),
    ].toSorted())
    const [proxyOutputs, finalOutputs] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: version.id,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: version.id,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    return Object.freeze({
      currentVersion: hydrateReviewPatchVersion(version),
      editPlan: Object.freeze(parseJson<Record<string, unknown>>(version.editPlanSnapshot.contentJson, 'batch review EditPlan')),
      editPlanHash: version.editPlanSnapshot.contentHash,
      availableAssetIds: Object.freeze([...new Set(project.mediaAssets.map((asset) => asset.artifactId))]),
      renderVariantIds,
      outputReferences: normalizeCommandImpactOutputReferences([
        ...(renderVariantIds.includes(project.format ?? '9:16')
          ? proxyOutputs.map((output) => ({
              artifactId: output.outputArtifactId,
              kind: 'proxy' as const,
              sourceVersionId: version.id,
              variantId: project.format ?? '9:16',
            }))
          : []),
        ...finalOutputs
          .filter((output) => renderVariantIds.includes(output.outputAspectRatio))
          .map((output) => ({
            artifactId: output.outputArtifactId,
            kind: 'final' as const,
            sourceVersionId: version.id,
            variantId: output.outputAspectRatio,
          })),
      ]),
      entries: Object.freeze(entries),
    })
  }

  async createBatch(input: { batch: ReviewPatchBatch; idempotencyKey: string; requestFingerprint: string }) {
    const row = await this.client.v2ReviewPatchBatch.create({
      data: {
        id: input.batch.id,
        workspaceId: input.batch.workspaceId,
        projectId: input.batch.projectId,
        baseVersionId: input.batch.baseVersionId,
        mode: input.batch.mode,
        status: input.batch.status,
        patchJson: input.batch.patch ? stableSerialize(input.batch.patch) : null,
        impactJson: input.batch.impact ? stableSerialize(input.batch.impact) : null,
        conflictsJson: stableSerialize(input.batch.conflicts),
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        createdAt: new Date(input.batch.createdAt),
        updatedAt: new Date(input.batch.updatedAt),
        items: {
          create: input.batch.items.map((item) => ({
            id: item.id,
            annotationId: item.annotationId,
            proposalId: item.proposalId,
            status: item.status,
            operationJson: item.operation ? stableSerialize(item.operation) : null,
            conflictIdsJson: stableSerialize(item.conflictIds),
            reasonCode: item.reasonCode,
            createdAt: new Date(item.createdAt),
            updatedAt: new Date(item.updatedAt),
          })),
        },
      },
      include: { items: true, renderOperation: true },
    })
    return hydrateBatch(row)
  }

  async readBatch(input: { workspaceId: string; projectId: string; batchId: string }) {
    const row = await this.batchById(input)
    return row ? hydrateBatch(row) : null
  }

  async readApplyContext(input: { workspaceId: string; projectId: string; batchId: string }): Promise<Readonly<ReviewPatchBatchApplyContext> | null> {
    const row = await this.batchById(input)
    if (!row) return null
    const context = await this.readProposalSet({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      proposalIds: row.items.map((item) => item.proposalId),
    })
    return context ? Object.freeze({ ...context, batch: hydrateBatch(row) }) : null
  }

  async readAppliedResult(input: { workspaceId: string; projectId: string; batchId: string; applyIdempotencyKey: string; applyRequestFingerprint: string }): Promise<Readonly<ReviewPatchBatchApplyResult> | null> {
    const row = await this.client.v2ReviewPatchBatch.findFirst({
      where: { id: input.batchId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: {
        items: true,
        renderOperation: true,
        resultVersion: { include: { editPlanSnapshot: true, command: { include: { artifactInvalidations: true } } } },
      },
    })
    if (!row || row.status !== 'applied' || !row.resultVersion?.command || !row.comparisonJson) return null
    if (row.applyIdempotencyKey !== input.applyIdempotencyKey || row.applyRequestFingerprint !== input.applyRequestFingerprint) return null
    const commandRow = row.resultVersion.command
    const payload = parseJson<Record<string, unknown>>(commandRow.payloadJson, 'batch patch command payload')
    if (payload.schemaVersion !== 2 || !payload.impact) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored batch review command impact is missing')
    const impact = parseCommandImpact(payload.impact)
    if (
      impact.commandType !== 'apply-review-patch-batch' || impact.commandId !== commandRow.id ||
      impact.baseVersionId !== commandRow.baseVersionId || impact.resultVersionId !== row.resultVersion.id
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored batch review command impact identity is inconsistent')
    const invalidations = Object.freeze(createCommandArtifactInvalidations({ impact, createdAt: commandRow.createdAt.toISOString() }).toSorted((left, right) => left.id.localeCompare(right.id)))
    const storedInvalidations = Object.freeze(commandRow.artifactInvalidations.map(hydrateInvalidation).toSorted((left, right) => left.id.localeCompare(right.id)))
    if (stableSerialize(invalidations) !== stableSerialize(storedInvalidations)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored batch review artifact invalidations are inconsistent')
    const command = createEditCommand({
      id: commandRow.id,
      workspaceId: commandRow.workspaceId,
      projectId: commandRow.projectId,
      baseVersionId: commandRow.baseVersionId,
      baseHash: commandRow.baseHash,
      author: { type: commandRow.actorType as 'user' | 'director' | 'system' | 'api-client', id: commandRow.actorId, ...(commandRow.delegatedUserId ? { delegatedUserId: commandRow.delegatedUserId } : {}) },
      type: commandRow.type,
      scope: parseJson<EditScope>(commandRow.scopeJson, 'batch patch command scope'),
      payload,
      ...(commandRow.reason ? { reason: commandRow.reason } : {}),
      idempotencyKey: commandRow.idempotencyKey,
      createdAt: commandRow.createdAt.toISOString(),
    })
    return Object.freeze({
      batch: hydrateBatch(row),
      command,
      version: hydrateReviewPatchVersion(row.resultVersion),
      editPlan: Object.freeze(parseJson<Record<string, unknown>>(row.resultVersion.editPlanSnapshot.contentJson, 'applied batch review EditPlan')),
      comparison: Object.freeze(parseJson<NonNullable<ReviewPatchBatch['comparison']>>(row.comparisonJson, 'batch comparison')),
      impact,
      invalidations,
      replayed: true,
    })
  }

  async commitOrReplay(bundle: ReviewPatchBatchCommit, serializationAttempt = 1): Promise<Readonly<ReviewPatchBatchApplyResult>> {
    const replay = await this.readAppliedResult({
      workspaceId: bundle.version.workspaceId,
      projectId: bundle.version.projectId,
      batchId: bundle.batchId,
      applyIdempotencyKey: bundle.applyIdempotencyKey,
      applyRequestFingerprint: bundle.applyRequestFingerprint,
    })
    if (replay) return replay
    try {
      await this.client.$transaction(async (transaction) => {
        const batch = await transaction.v2ReviewPatchBatch.findFirst({
          where: { id: bundle.batchId, workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId },
          include: { items: true },
        })
        const project = await transaction.v2Project.findFirst({
          where: { id: bundle.version.projectId, workspaceId: bundle.version.workspaceId },
          include: { currentVersion: true },
        })
        if (!batch || !project?.currentVersion) throw new DomainError('PERSISTENCE_CONFLICT', 'Batch patch context disappeared before commit')
        if (batch.status === 'applied') {
          if (batch.applyIdempotencyKey !== bundle.applyIdempotencyKey || batch.applyRequestFingerprint !== bundle.applyRequestFingerprint) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Batch review was already applied by another request')
          }
          return
        }
        if (!['ready', 'partial'].includes(batch.status) || (batch.status === 'partial' && batch.mode !== 'partial-retry') ||
          project.currentVersion.id !== batch.baseVersionId || bundle.version.parentVersionId !== project.currentVersion.id ||
          bundle.version.sequence !== project.currentVersion.sequence + 1) {
          throw new DomainError('VERSION_CONFLICT', 'Project version changed before batch patch commit', { currentVersionId: project.currentVersion.id })
        }
        const included = batch.items.filter((item) => item.status === 'included')
        if (!included.length) throw new DomainError('PRECONDITION_REQUIRED', 'Batch review has no included annotations')
        const payload = bundle.command.payload as Readonly<{ schemaVersion?: unknown; impact?: unknown }>
        const persistedImpact = payload.schemaVersion === 2 && payload.impact ? parseCommandImpact(payload.impact) : null
        if (
          !persistedImpact || persistedImpact.commandType !== 'apply-review-patch-batch' ||
          persistedImpact.impactHash !== bundle.impact.impactHash
        ) throw new DomainError('PERSISTENCE_CONFLICT', 'Batch review command and impact payload are inconsistent')
        const [proxyOutputs, finalOutputs] = await Promise.all([
          transaction.v2ProjectProxyRenderOperation.findMany({
            where: {
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              projectVersionId: bundle.command.baseVersionId,
              operation: { status: 'succeeded', phase: 'completed' },
            },
            select: { outputArtifactId: true },
          }),
          transaction.v2ProjectFinalExportOperation.findMany({
            where: {
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              projectVersionId: bundle.command.baseVersionId,
              operation: { status: 'succeeded', phase: 'completed' },
            },
            select: { outputArtifactId: true, outputAspectRatio: true },
          }),
        ])
        const projectVariantId = project.format ?? '9:16'
        const currentAffectedArtifacts = normalizeCommandImpactOutputReferences([
          ...(bundle.impact.affectedVariantIds.includes(projectVariantId)
            ? proxyOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: bundle.command.baseVersionId, variantId: projectVariantId }))
            : []),
          ...finalOutputs
            .filter((output) => bundle.impact.affectedVariantIds.includes(output.outputAspectRatio))
            .map((output) => ({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: bundle.command.baseVersionId, variantId: output.outputAspectRatio })),
        ])
        if (stableSerialize(currentAffectedArtifacts) !== stableSerialize(bundle.impact.affectedArtifacts)) {
          throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before batch review impact commit')
        }
        await transaction.v2EditCommand.create({ data: {
          id: bundle.command.id, workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId,
          baseVersionId: bundle.command.baseVersionId, baseHash: bundle.command.baseHash, type: bundle.command.type,
          scopeJson: stableSerialize(bundle.command.scope), payloadJson: stableSerialize(bundle.command.payload), reason: bundle.command.reason,
          actorType: bundle.command.author.type, actorId: bundle.command.author.id, delegatedUserId: bundle.command.author.delegatedUserId,
          idempotencyKey: bundle.command.idempotencyKey, requestFingerprint: bundle.applyRequestFingerprint, createdAt: new Date(bundle.command.createdAt),
        } })
        await transaction.v2ProjectSnapshot.create({ data: {
          id: bundle.snapshot.id, workspaceId: bundle.snapshot.workspaceId, projectId: bundle.snapshot.projectId, kind: bundle.snapshot.kind,
          schemaVersion: bundle.snapshot.contentSchemaVersion, contentJson: bundle.snapshot.contentJson, contentHash: bundle.snapshot.contentHash, createdAt: new Date(bundle.snapshot.createdAt),
        } })
        await transaction.v2ProjectVersion.create({ data: {
          id: bundle.version.id, workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, sequence: bundle.version.sequence,
          parentVersionId: bundle.version.parentVersionId, briefSnapshotId: bundle.version.snapshotRefs.brief!, treatmentSnapshotId: bundle.version.snapshotRefs.treatment,
          storySnapshotId: bundle.version.snapshotRefs.story, editPlanSnapshotId: bundle.version.snapshotRefs.editPlan, policiesSnapshotId: bundle.version.snapshotRefs.policies,
          baseHash: bundle.version.baseHash, createdBy: bundle.version.createdBy, commandId: bundle.command.id, createdAt: new Date(bundle.version.createdAt),
        } })
        const invalidations = createCommandArtifactInvalidations({ impact: bundle.impact, createdAt: bundle.command.createdAt })
        if (invalidations.length > 0) {
          await transaction.v2CommandArtifactInvalidation.createMany({ data: invalidations.map((invalidation) => ({
            id: invalidation.id,
            workspaceId: bundle.command.workspaceId,
            projectId: bundle.command.projectId,
            commandId: invalidation.commandId,
            baseVersionId: invalidation.baseVersionId,
            resultVersionId: invalidation.resultVersionId,
            artifactId: invalidation.artifactId,
            kind: invalidation.kind,
            variantId: invalidation.variantId,
            status: invalidation.status,
            dependencyTypesJson: stableSerialize(invalidation.dependencyTypes),
            affectedRangesJson: stableSerialize(invalidation.affectedRanges),
            impactHash: invalidation.impactHash,
            createdAt: new Date(invalidation.createdAt),
          })) })
        }
        const updated = await transaction.v2Project.updateMany({
          where: { id: bundle.version.projectId, workspaceId: bundle.version.workspaceId, currentVersionId: bundle.command.baseVersionId },
          data: { currentVersionId: bundle.version.id },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during batch patch commit')
        const annotationIds = included.map((item) => item.annotationId)
        const proposalIds = included.map((item) => item.proposalId)
        const annotations = await transaction.v2ReviewAnnotation.updateMany({
          where: { id: { in: annotationIds }, workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, status: 'open' },
          data: { status: 'applied', updatedAt: new Date(bundle.command.createdAt) },
        })
        if (annotations.count !== annotationIds.length) throw new DomainError('VERSION_CONFLICT', 'One or more batch annotations changed before commit')
        const proposals = await transaction.v2ReviewPatchProposal.updateMany({
          where: { id: { in: proposalIds }, workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, status: 'ready' },
          data: { status: 'applied', updatedAt: new Date(bundle.command.createdAt) },
        })
        if (proposals.count !== proposalIds.length) throw new DomainError('VERSION_CONFLICT', 'One or more batch proposals changed before commit')
        await transaction.v2ReviewPatchBatchItem.updateMany({
          where: { batchId: batch.id, workspaceId: bundle.version.workspaceId, status: 'included' },
          data: { status: 'applied', updatedAt: new Date(bundle.command.createdAt) },
        })
        await transaction.v2ReviewPatchBatch.update({ where: { id: batch.id }, data: {
          status: 'applied', applyIdempotencyKey: bundle.applyIdempotencyKey, applyRequestFingerprint: bundle.applyRequestFingerprint,
          resultCommandId: bundle.command.id, resultVersionId: bundle.version.id, comparisonJson: stableSerialize(bundle.comparison),
          appliedAt: new Date(bundle.command.createdAt), updatedAt: new Date(bundle.command.createdAt),
        } })
        await transaction.v2PublicEventOutbox.create({ data: {
          id: bundle.event.id, workspaceId: bundle.event.workspaceId, type: bundle.event.type, version: bundle.event.version,
          occurredAt: new Date(bundle.event.occurredAt), sequence: bundle.event.sequence, actorClientId: bundle.event.actor?.clientId,
          actorUserId: bundle.event.actor?.userId, resourceType: bundle.event.resource.type, resourceId: bundle.event.resource.id,
          dataJson: stableSerialize(bundle.event.data),
        } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) return this.commitOrReplay(bundle, serializationAttempt + 1)
      if (!isPrismaCode(error, 'P2002')) throw error
    }
    const result = await this.readAppliedResult({
      workspaceId: bundle.version.workspaceId,
      projectId: bundle.version.projectId,
      batchId: bundle.batchId,
      applyIdempotencyKey: bundle.applyIdempotencyKey,
      applyRequestFingerprint: bundle.applyRequestFingerprint,
    })
    if (!result) throw new DomainError('PERSISTENCE_CONFLICT', 'Applied batch review could not be reconstructed')
    return Object.freeze({ ...result, replayed: false })
  }

  async attachRenderOperation(input: { workspaceId: string; projectId: string; batchId: string; renderOperationId: string }) {
    const batch = await this.client.v2ReviewPatchBatch.findFirst({
      where: { id: input.batchId, workspaceId: input.workspaceId, projectId: input.projectId },
    })
    if (!batch?.resultVersionId) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch batch has no applied version')
    const operation = await this.client.v2ProjectProxyRenderOperation.findFirst({
      where: { operationId: input.renderOperationId, workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: batch.resultVersionId },
    })
    if (!operation) throw new DomainError('PERSISTENCE_CONFLICT', 'Batch render operation does not target the applied version')
    if (batch.renderOperationId && batch.renderOperationId !== input.renderOperationId) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch batch already has another render operation')
    const row = await this.client.v2ReviewPatchBatch.update({
      where: { id: batch.id },
      data: { renderOperationId: input.renderOperationId },
      include: { items: true, renderOperation: true },
    })
    return hydrateBatch(row)
  }
}
