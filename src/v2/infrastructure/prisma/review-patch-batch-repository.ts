import type { AdoptableObservationReader } from '../../application/ports/adoptable-observation-reader.ts'
import { readAdoptableObservationsV3 } from './output-adoptable-observations.ts'
import { randomUUID } from 'node:crypto'

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
import { requireEditCommandType } from '../../domain/edit-command-registry.ts'
import { DomainError } from '../../domain/errors.ts'
import { createPublicEvent } from '../../domain/public-event.ts'
import {
  assertReviewFormatsAreOutputs,
  createCommandArtifactInvalidations,
  normalizeCommandImpactOutputReferences,
  parseCommandImpact,
} from '../../domain/command-impact.ts'
import { outputVariantsOf } from '../../domain/output-consumption.ts'
import {
  hydrateInvalidation,
  hydrateReviewAnnotation,
  hydrateReviewPatchProposal,
  hydrateReviewPatchVersion,
} from './review-patch-repository.ts'
import { operationalBundlePlanV3 } from '../../domain/output-version-bundle.ts'
import { childCommandOf } from '../../domain/project-output-state-transition.ts'
import { persistPublicEvents } from './public-event-outbox.ts'
import { hydrateEditCommandExternalActorAudit } from './edit-command-actor-audit.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState, settleDeferredOutputGuards } from './project-version-commit.ts'
import { readVersionRenderReferences } from './version-render-references.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
} from './external-actor-audit.ts'

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
  const authenticationAudit = hydrateExternalActorAudit(
    row,
    row.actorClientId ?? '',
  )
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
    authenticationAudit,
  } as ReviewPatchBatch)
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaReviewPatchBatchRepository implements ReviewPatchBatchRepository {
  private readonly client: PrismaClient
  private readonly createEventId: () => string

  constructor(client: PrismaClient, createEventId: () => string = randomUUID) {
    this.client = client
    this.createEventId = createEventId
  }

  /** The persisted receipts of the recordings a new plan consumes and the head State does not observe (see adoptable-observations). */
  async readAdoptableObservations(input: Parameters<AdoptableObservationReader['readAdoptableObservations']>[0]) {
    return readAdoptableObservationsV3(this.client, input)
  }

  private batchById(input: { workspaceId: string; projectId: string; batchId: string }) {
    return this.client.v2ReviewPatchBatch.findFirst({
      where: { id: input.batchId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: { items: true, renderOperation: true },
    })
  }

  async findBatchIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string }) {
    const row = await this.client.v2ReviewPatchBatch.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { items: true, renderOperation: true },
    })
    if (!row) return null
    const batch = hydrateBatch(row)
    if (
      batch.authenticationAudit.contextHash !== input.actorContextHash
    ) throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Review patch batch idempotency key belongs to another authentication context',
    )
    return Object.freeze({ requestFingerprint: row.requestFingerprint, batch })
  }

  async readProposalSet(input: { workspaceId: string; projectId: string; proposalIds: readonly string[] }): Promise<Readonly<ReviewPatchBatchProposalContext> | null> {
    const [project, rows] = await Promise.all([
      this.client.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        include: {
          currentVersion: true,
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
    const parent = await readPersistedOperationalOutputBundleV3(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: version.id })
    if (!parent) return null
    const editPlanSnapshot = operationalBundlePlanV3(parent)
    const byId = new Map(rows.map((row) => [row.id, row]))
    const entries = input.proposalIds.map((proposalId) => {
      const row = byId.get(proposalId)!
      return Object.freeze({
        annotation: hydrateReviewAnnotation(row.annotation),
        proposal: hydrateReviewPatchProposal(row),
      })
    })
    // A batch edits the shared plan: its impact is every output's renders. The formats its annotations name must be outputs of the
    // State the batch is applied to, and never narrow that impact.
    assertReviewFormatsAreOutputs(
      outputVariantsOf(parent.state).map((output) => output.variantId),
      entries.flatMap((entry) => entry.annotation.applicationScope.formatIds),
    )
    const outputReferences = await readVersionRenderReferences(this.client, {
      workspaceId: input.workspaceId, projectId: input.projectId, versionId: version.id, state: parent.state,
    })
    return Object.freeze({
      parent,
      currentVersion: parent.version,
      editPlan: Object.freeze(parseJson<Record<string, unknown>>(editPlanSnapshot.contentJson, 'batch review EditPlan')),
      editPlanHash: editPlanSnapshot.contentHash,
      availableAssetIds: Object.freeze([...new Set(project.mediaAssets.map((asset) => asset.artifactId))]),
      outputReferences: normalizeCommandImpactOutputReferences(outputReferences),
      entries: Object.freeze(entries),
    })
  }

  async createBatch(input: { batch: ReviewPatchBatch; idempotencyKey: string; requestFingerprint: string }) {
    try {
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
        actorClientId: input.batch.authenticationAudit.clientId,
        ...externalActorAuditData(
          input.batch.authenticationAudit,
          input.batch.workspaceId,
          input.batch.authenticationAudit.clientId,
        ),
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
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const replay = await this.findBatchIdempotent({
        workspaceId: input.batch.workspaceId,
        projectId: input.batch.projectId,
        idempotencyKey: input.idempotencyKey,
        actorContextHash: input.batch.authenticationAudit.contextHash,
      })
      if (!replay) throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Concurrent review patch batch did not publish an idempotent winner',
      )
      if (replay.requestFingerprint !== input.requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Concurrent review patch batch changed its idempotency payload',
        )
      }
      return replay.batch
    }
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

  async readAppliedResult(input: { workspaceId: string; projectId: string; batchId: string; applyIdempotencyKey: string; applyRequestFingerprint: string; actorContextHash: string }): Promise<Readonly<ReviewPatchBatchApplyResult> | null> {
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
    if (hydrateEditCommandExternalActorAudit(commandRow).contextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Batch review replay belongs to another authentication context')
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
      type: requireEditCommandType(commandRow.type),
      scope: parseJson<EditScope>(commandRow.scopeJson, 'batch patch command scope'),
      payload,
      ...(commandRow.reason ? { reason: commandRow.reason } : {}),
      idempotencyKey: commandRow.idempotencyKey,
      createdAt: commandRow.createdAt.toISOString(),
    })
    if (commandRow.commandHash !== command.commandHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored batch review command seal is invalid')
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

  async commitOrReplay(input: ReviewPatchBatchCommit, serializationAttempt = 1): Promise<Readonly<ReviewPatchBatchApplyResult>> {
    const sealed = childCommandOf(input.bundle)
    if (!sealed.audit) throw new DomainError('AUTH_INVALID', 'Review batch application requires an authenticated external actor')
    // Local view with the names the transaction below was written against.
    const bundle = {
      batchId: input.batchId, applyIdempotencyKey: input.applyIdempotencyKey, applyRequestFingerprint: input.applyRequestFingerprint,
      command: sealed.command, authenticationAudit: sealed.audit, version: input.bundle.version, event: input.event, comparison: input.comparison, impact: input.impact,
    }
    if (bundle.command.type !== 'apply-review-patch-batch' || bundle.version.commandId !== bundle.command.id || bundle.version.parentVersionId !== bundle.command.baseVersionId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Review batch Version does not belong to its Command')
    }
    const replay = await this.readAppliedResult({
      workspaceId: bundle.version.workspaceId,
      projectId: bundle.version.projectId,
      batchId: bundle.batchId,
      applyIdempotencyKey: bundle.applyIdempotencyKey,
      applyRequestFingerprint: bundle.applyRequestFingerprint,
      actorContextHash: bundle.authenticationAudit.contextHash,
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
          bundle.version.sequence !== project.currentVersion.sequence + 1 || input.bundle.state.document.parentStateHash !== project.currentVersion.outputStateHash) {
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
        // The child carries the very outputs of its parent, so its State attributes the base Version's renders (every output's).
        const currentAffectedArtifacts = normalizeCommandImpactOutputReferences(await readVersionRenderReferences(transaction, {
          workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId,
          versionId: bundle.command.baseVersionId, state: input.bundle.state,
        }))
        if (stableSerialize(currentAffectedArtifacts) !== stableSerialize(bundle.impact.affectedArtifacts)) {
          throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before batch review impact commit')
        }
        await commitProjectVersionWithOutputState(transaction, input.bundle)
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
        await persistPublicEvents(transaction, [
          bundle.event,
          ...included.map((item) => createPublicEvent({
            id: this.createEventId(),
            type: 'annotation.resolved',
            version: '1.0.0',
            workspaceId: bundle.command.workspaceId,
            occurredAt: bundle.command.createdAt,
            ...(bundle.event.actor ? { actor: bundle.event.actor } : {}),
            resource: { type: 'annotation', id: item.annotationId },
            data: {
              projectId: bundle.command.projectId,
              baseVersionId: bundle.command.baseVersionId,
              resultVersionId: bundle.version.id,
              commandId: bundle.command.id,
              batchId: batch.id,
              proposalId: item.proposalId,
              status: 'applied',
            },
          })),
        ])
        await settleDeferredOutputGuards(transaction)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) return this.commitOrReplay(input, serializationAttempt + 1)
      if (!isPrismaCode(error, 'P2002')) throw error
    }
    const result = await this.readAppliedResult({
      workspaceId: bundle.version.workspaceId,
      projectId: bundle.version.projectId,
      batchId: bundle.batchId,
      applyIdempotencyKey: bundle.applyIdempotencyKey,
      applyRequestFingerprint: bundle.applyRequestFingerprint,
      actorContextHash: bundle.authenticationAudit.contextHash,
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
