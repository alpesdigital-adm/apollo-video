import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ReviewPatchApplyContext,
  ReviewPatchApplyResult,
  ReviewPatchCommit,
  ReviewPatchProposal,
  ReviewPatchProposalContext,
  ReviewPatchRepository,
} from '../../application/ports/review-patch-repository.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import { createProjectVersion, type ProjectVersion } from '../../domain/project-version.ts'
import { createReviewAnnotation, type ReviewAnnotation, type ReviewScope } from '../../domain/review-system.ts'

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function hydrateAnnotation(row: {
  id: string; projectVersionId: string; proxyArtifactId: string; proxyHash: string; frame: number; timeStartMs: number; timeEndMs: number
  screenshotRef: string; scope: string; regionX: number | null; regionY: number | null; regionWidth: number | null; regionHeight: number | null
  targetIdsJson: string; applicationScopeJson: string; affectedCount: number; text: string; authorId: string; authorName: string; authorType: string
  status: string; createdAt: Date
}): Readonly<ReviewAnnotation> {
  return createReviewAnnotation({
    id: row.id,
    projectVersionId: row.projectVersionId,
    proxyArtifactId: row.proxyArtifactId,
    proxyHash: row.proxyHash,
    frame: row.frame,
    timeRangeMs: [row.timeStartMs, row.timeEndMs],
    screenshotRef: row.screenshotRef,
    scope: row.scope as 'point' | 'region' | 'scene',
    ...(row.regionX !== null && row.regionY !== null && row.regionWidth !== null && row.regionHeight !== null ? { region: { x: row.regionX, y: row.regionY, width: row.regionWidth, height: row.regionHeight } } : {}),
    targetIds: parseJson<string[]>(row.targetIdsJson, 'review annotation targets'),
    applicationScope: parseJson<ReviewScope>(row.applicationScopeJson, 'review application scope'),
    affectedCount: row.affectedCount,
    text: row.text,
    author: { id: row.authorId, name: row.authorName, type: row.authorType as 'user' | 'api-client' },
    status: row.status as 'open' | 'applied' | 'dismissed',
    createdAt: row.createdAt.toISOString(),
  })
}

function hydrateVersion(row: {
  id: string; workspaceId: string; projectId: string; sequence: number; parentVersionId: string | null
  briefSnapshotId: string; treatmentSnapshotId: string | null; storySnapshotId: string | null; editPlanSnapshotId: string
  policiesSnapshotId: string; baseHash: string; createdBy: string; commandId: string | null; createdAt: Date
}): Readonly<ProjectVersion> {
  return createProjectVersion({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sequence: row.sequence,
    ...(row.parentVersionId ? { parentVersionId: row.parentVersionId } : {}),
    snapshotRefs: {
      brief: row.briefSnapshotId,
      ...(row.treatmentSnapshotId ? { treatment: row.treatmentSnapshotId } : {}),
      ...(row.storySnapshotId ? { story: row.storySnapshotId } : {}),
      editPlan: row.editPlanSnapshotId,
      policies: row.policiesSnapshotId,
    },
    baseHash: row.baseHash,
    createdBy: row.createdBy,
    ...(row.commandId ? { commandId: row.commandId } : {}),
    createdAt: row.createdAt.toISOString(),
  })
}

type ProposalRow = Prisma.V2ReviewPatchProposalGetPayload<{ include: { renderOperation: true } }>

function hydrateProposal(row: ProposalRow): Readonly<ReviewPatchProposal> {
  const operation = row.renderOperation
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    annotationId: row.annotationId,
    baseVersionId: row.baseVersionId,
    status: row.status as ReviewPatchProposal['status'],
    interpretationVersion: row.interpretationVersion,
    choices: Object.freeze(parseJson<ReviewPatchProposal['choices']>(row.choicesJson, 'patch choices')),
    patch: row.patchJson ? Object.freeze(parseJson<NonNullable<ReviewPatchProposal['patch']>>(row.patchJson, 'patch')) : null,
    impact: row.impactJson ? Object.freeze(parseJson<NonNullable<ReviewPatchProposal['impact']>>(row.impactJson, 'patch impact')) : null,
    gates: Object.freeze(parseJson<ReviewPatchProposal['gates']>(row.gatesJson, 'patch gates')),
    ...(row.resultCommandId ? { resultCommandId: row.resultCommandId } : {}),
    ...(row.resultVersionId ? { resultVersionId: row.resultVersionId } : {}),
    ...(row.renderOperationId ? { renderOperationId: row.renderOperationId } : {}),
    ...(row.comparisonJson ? { comparison: Object.freeze(parseJson<NonNullable<ReviewPatchProposal['comparison']>>(row.comparisonJson, 'patch comparison')) } : {}),
    ...(operation ? { render: Object.freeze({ operationId: operation.id, status: operation.status, phase: operation.phase, ...(operation.errorCode || operation.errorMessage ? { error: { code: operation.errorCode ?? 'RENDER_FAILED', message: operation.errorMessage ?? 'Patch render failed' } } : {}) }) } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as ReviewPatchProposal)
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaReviewPatchRepository implements ReviewPatchRepository {
  constructor(private readonly client: PrismaClient) {}

  private proposalById(input: { workspaceId: string; projectId: string; proposalId: string }) {
    return this.client.v2ReviewPatchProposal.findFirst({
      where: { id: input.proposalId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: { renderOperation: true },
    })
  }

  async findProposalIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const row = await this.client.v2ReviewPatchProposal.findUnique({
      where: { workspaceId_projectId_idempotencyKey: input },
      include: { renderOperation: true },
    })
    return row ? Object.freeze({ requestFingerprint: row.requestFingerprint, proposal: hydrateProposal(row) }) : null
  }

  private async contextForAnnotation(input: { workspaceId: string; projectId: string; annotationId: string }): Promise<Readonly<ReviewPatchProposalContext> | null> {
    const annotation = await this.client.v2ReviewAnnotation.findFirst({
      where: { id: input.annotationId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: {
        project: {
          include: {
            currentVersion: { include: { editPlanSnapshot: true, policiesSnapshot: true } },
            mediaAssets: { where: { artifact: { status: 'available' } }, select: { artifactId: true } },
          },
        },
      },
    })
    const version = annotation?.project.currentVersion
    if (!annotation || !version) return null
    const editPlan = parseJson<Record<string, unknown>>(version.editPlanSnapshot.contentJson, 'review patch EditPlan')
    const policies = parseJson<Record<string, unknown>>(version.policiesSnapshot.contentJson, 'review patch policies')
    return Object.freeze({
      annotation: hydrateAnnotation(annotation),
      currentVersion: hydrateVersion(version),
      editPlan: Object.freeze(editPlan),
      editPlanHash: version.editPlanSnapshot.contentHash,
      policies: Object.freeze(policies),
      availableAssetIds: Object.freeze([...new Set(annotation.project.mediaAssets.map((asset) => asset.artifactId))]),
    })
  }

  readProposalContext(input: { workspaceId: string; projectId: string; annotationId: string }) {
    return this.contextForAnnotation(input)
  }

  async createProposal(input: { proposal: ReviewPatchProposal; idempotencyKey: string; requestFingerprint: string }) {
    const row = await this.client.v2ReviewPatchProposal.create({
      data: {
        id: input.proposal.id,
        workspaceId: input.proposal.workspaceId,
        projectId: input.proposal.projectId,
        annotationId: input.proposal.annotationId,
        baseVersionId: input.proposal.baseVersionId,
        status: input.proposal.status,
        interpretationVersion: input.proposal.interpretationVersion,
        choicesJson: stableSerialize(input.proposal.choices),
        patchJson: input.proposal.patch ? stableSerialize(input.proposal.patch) : null,
        impactJson: input.proposal.impact ? stableSerialize(input.proposal.impact) : null,
        gatesJson: stableSerialize(input.proposal.gates),
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        createdAt: new Date(input.proposal.createdAt),
        updatedAt: new Date(input.proposal.updatedAt),
      },
      include: { renderOperation: true },
    })
    return hydrateProposal(row)
  }

  async readProposal(input: { workspaceId: string; projectId: string; proposalId: string }) {
    const row = await this.proposalById(input)
    return row ? hydrateProposal(row) : null
  }

  async readApplyContext(input: { workspaceId: string; projectId: string; proposalId: string }): Promise<Readonly<ReviewPatchApplyContext> | null> {
    const row = await this.proposalById(input)
    if (!row) return null
    const context = await this.contextForAnnotation({ workspaceId: input.workspaceId, projectId: input.projectId, annotationId: row.annotationId })
    return context ? Object.freeze({ ...context, proposal: hydrateProposal(row) }) : null
  }

  async readAppliedResult(input: { workspaceId: string; projectId: string; proposalId: string; applyIdempotencyKey: string; applyRequestFingerprint: string }): Promise<Readonly<ReviewPatchApplyResult> | null> {
    const proposal = await this.client.v2ReviewPatchProposal.findFirst({
      where: { id: input.proposalId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: { renderOperation: true, resultVersion: { include: { editPlanSnapshot: true, command: true } } },
    })
    if (!proposal || proposal.status !== 'applied' || !proposal.resultVersion || !proposal.resultVersion.command || !proposal.comparisonJson) return null
    if (proposal.applyIdempotencyKey !== input.applyIdempotencyKey || proposal.applyRequestFingerprint !== input.applyRequestFingerprint) return null
    const commandRow = proposal.resultVersion.command
    const command = createEditCommand({
      id: commandRow.id,
      workspaceId: commandRow.workspaceId,
      projectId: commandRow.projectId,
      baseVersionId: commandRow.baseVersionId,
      baseHash: commandRow.baseHash,
      author: { type: commandRow.actorType as 'user' | 'director' | 'system' | 'api-client', id: commandRow.actorId, ...(commandRow.delegatedUserId ? { delegatedUserId: commandRow.delegatedUserId } : {}) },
      type: commandRow.type,
      scope: parseJson<EditScope>(commandRow.scopeJson, 'review patch command scope'),
      payload: parseJson<unknown>(commandRow.payloadJson, 'review patch command payload'),
      ...(commandRow.reason ? { reason: commandRow.reason } : {}),
      idempotencyKey: commandRow.idempotencyKey,
      createdAt: commandRow.createdAt.toISOString(),
    })
    return Object.freeze({
      proposal: hydrateProposal(proposal),
      command,
      version: hydrateVersion(proposal.resultVersion),
      editPlan: Object.freeze(parseJson<Record<string, unknown>>(proposal.resultVersion.editPlanSnapshot.contentJson, 'applied review patch EditPlan')),
      comparison: Object.freeze(parseJson<NonNullable<ReviewPatchProposal['comparison']>>(proposal.comparisonJson, 'patch comparison')),
      replayed: true,
    })
  }

  async commitOrReplay(bundle: ReviewPatchCommit, serializationAttempt = 1): Promise<Readonly<ReviewPatchApplyResult>> {
    const replay = await this.readAppliedResult({ workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, proposalId: bundle.proposalId, applyIdempotencyKey: bundle.applyIdempotencyKey, applyRequestFingerprint: bundle.applyRequestFingerprint })
    if (replay) return replay
    try {
      await this.client.$transaction(async (transaction) => {
        const proposal = await transaction.v2ReviewPatchProposal.findFirst({ where: { id: bundle.proposalId, workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId } })
        const project = await transaction.v2Project.findFirst({ where: { id: bundle.version.projectId, workspaceId: bundle.version.workspaceId }, include: { currentVersion: true } })
        if (!proposal || !project?.currentVersion) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch proposal context disappeared before commit')
        if (proposal.status === 'applied') {
          if (proposal.applyIdempotencyKey !== bundle.applyIdempotencyKey || proposal.applyRequestFingerprint !== bundle.applyRequestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Patch proposal was already applied by another request')
          return
        }
        if (proposal.status !== 'ready' || project.currentVersion.id !== proposal.baseVersionId || bundle.version.parentVersionId !== project.currentVersion.id || bundle.version.sequence !== project.currentVersion.sequence + 1) {
          throw new DomainError('VERSION_CONFLICT', 'Project version changed before review patch commit', { currentVersionId: project.currentVersion.id })
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
        const updated = await transaction.v2Project.updateMany({ where: { id: bundle.version.projectId, workspaceId: bundle.version.workspaceId, currentVersionId: bundle.command.baseVersionId }, data: { currentVersionId: bundle.version.id } })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during review patch commit')
        await transaction.v2ReviewAnnotation.update({ where: { id: proposal.annotationId }, data: { status: 'applied', updatedAt: new Date(bundle.command.createdAt) } })
        await transaction.v2ReviewPatchProposal.update({ where: { id: proposal.id }, data: {
          status: 'applied', applyIdempotencyKey: bundle.applyIdempotencyKey, applyRequestFingerprint: bundle.applyRequestFingerprint,
          resultCommandId: bundle.command.id, resultVersionId: bundle.version.id, comparisonJson: stableSerialize(bundle.comparison),
          appliedAt: new Date(bundle.command.createdAt), updatedAt: new Date(bundle.command.createdAt),
        } })
        await transaction.v2PublicEventOutbox.create({ data: {
          id: bundle.event.id, workspaceId: bundle.event.workspaceId, type: bundle.event.type, version: bundle.event.version,
          occurredAt: new Date(bundle.event.occurredAt), sequence: bundle.event.sequence, actorClientId: bundle.event.actor?.clientId,
          actorUserId: bundle.event.actor?.userId, resourceType: bundle.event.resource.type, resourceId: bundle.event.resource.id, dataJson: stableSerialize(bundle.event.data),
        } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) return this.commitOrReplay(bundle, serializationAttempt + 1)
      if (!isPrismaCode(error, 'P2002')) throw error
    }
    const result = await this.readAppliedResult({ workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, proposalId: bundle.proposalId, applyIdempotencyKey: bundle.applyIdempotencyKey, applyRequestFingerprint: bundle.applyRequestFingerprint })
    if (!result) throw new DomainError('PERSISTENCE_CONFLICT', 'Applied review patch could not be reconstructed')
    return Object.freeze({ ...result, replayed: false })
  }

  async attachRenderOperation(input: { workspaceId: string; projectId: string; proposalId: string; renderOperationId: string }) {
    const proposal = await this.client.v2ReviewPatchProposal.findFirst({ where: { id: input.proposalId, workspaceId: input.workspaceId, projectId: input.projectId } })
    if (!proposal?.resultVersionId) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch proposal has no applied version')
    const operation = await this.client.v2ProjectProxyRenderOperation.findFirst({ where: { operationId: input.renderOperationId, workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: proposal.resultVersionId } })
    if (!operation) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch render operation does not target the applied version')
    if (proposal.renderOperationId && proposal.renderOperationId !== input.renderOperationId) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch proposal already has another render operation')
    const row = await this.client.v2ReviewPatchProposal.update({ where: { id: proposal.id }, data: { renderOperationId: input.renderOperationId }, include: { renderOperation: true } })
    return hydrateProposal(row)
  }
}
