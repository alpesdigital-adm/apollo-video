import type { AdoptableObservationReader } from '../../application/ports/adoptable-observation-reader.ts'
import { readAdoptableObservationsV3 } from './output-adoptable-observations.ts'
import { randomUUID } from 'node:crypto'

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
import { requireEditCommandType } from '../../domain/edit-command-registry.ts'
import { DomainError } from '../../domain/errors.ts'
import { createPublicEvent } from '../../domain/public-event.ts'
import { operationalBundlePlanV3 } from '../../domain/output-version-bundle.ts'
import { childCommandOf } from '../../domain/project-output-state-transition.ts'
import { hydrateProjectVersionRowV3, type ProjectVersionRowFacts } from '../../domain/project-version-row.ts'
import type { ProjectVersionV3 } from '../../domain/project-version.ts'
import { createReviewAnnotation, type ReviewAnnotation, type ReviewScope } from '../../domain/review-system.ts'
import {
  assertReviewFormatsAreOutputs,
  createCommandArtifactInvalidations,
  normalizeCommandImpactOutputReferences,
  parseCommandArtifactInvalidation,
  parseCommandImpact,
} from '../../domain/command-impact.ts'
import { outputVariantsOf } from '../../domain/output-consumption.ts'
import { persistPublicEvents } from './public-event-outbox.ts'
import { hydrateEditCommandExternalActorAudit } from './edit-command-actor-audit.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState, settleDeferredOutputGuards } from './project-version-commit.ts'
import { readVersionRenderReferences } from './version-render-references.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
} from './external-actor-audit.ts'
import { reconcileAfterConflict } from './idempotency-record-persistence.ts'

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

export function hydrateInvalidation(item: Prisma.V2CommandArtifactInvalidationGetPayload<{}>) {
  return parseCommandArtifactInvalidation({
    schemaVersion: 'command-artifact-invalidation/v1',
    id: item.id,
    status: item.status,
    commandId: item.commandId,
    baseVersionId: item.baseVersionId,
    resultVersionId: item.resultVersionId,
    artifactId: item.artifactId,
    kind: item.kind,
    variantId: item.variantId,
    dependencyTypes: parseJson<unknown[]>(item.dependencyTypesJson, 'review patch invalidation dependencies'),
    affectedRanges: parseJson<unknown[]>(item.affectedRangesJson, 'review patch invalidation ranges'),
    impactHash: item.impactHash,
    createdAt: item.createdAt.toISOString(),
  })
}

export function hydrateReviewAnnotation(row: {
  id: string; workspaceId: string; projectVersionId: string; proxyArtifactId: string; proxyHash: string; frame: number; timeStartMs: number; timeEndMs: number
  screenshotRef: string; scope: string; regionX: number | null; regionY: number | null; regionWidth: number | null; regionHeight: number | null
  targetIdsJson: string; applicationScopeJson: string; affectedCount: number; text: string; authorId: string; authorName: string; authorType: string
  status: string; createdAt: Date; actorClientId: string | null; actorCredentialId: string | null; actorEnvironment: string | null
  actorAuthenticationKind: string | null; actorContextHash: string | null; delegatedUserId: string | null
  delegatedIdentityId: string | null; workspaceRole: string | null
}): Readonly<ReviewAnnotation> {
  const audit = hydrateExternalActorAudit(row, row.actorClientId ?? '')
  const expectedAuthor = audit.delegatedUserId
    ? { id: audit.delegatedUserId, name: audit.delegatedUserId, type: 'user' }
    : { id: audit.clientId, name: audit.clientId, type: 'api-client' }
  if (
    row.authorId !== expectedAuthor.id || row.authorName !== expectedAuthor.name ||
    row.authorType !== expectedAuthor.type
  ) throw new DomainError(
    'PERSISTENCE_CONFLICT',
    'Stored review annotation author does not match its authentication audit',
  )
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

/** A patched Version is operational (contract 3); it is read from its sealed document, never rebuilt from columns. */
export function hydrateReviewPatchVersion(row: ProjectVersionRowFacts): Readonly<ProjectVersionV3> {
  return hydrateProjectVersionRowV3(row)
}

type ProposalRow = Prisma.V2ReviewPatchProposalGetPayload<{ include: { renderOperation: true } }>

export function hydrateReviewPatchProposal(row: ProposalRow): Readonly<ReviewPatchProposal> {
  const operation = row.renderOperation
  const authenticationAudit = hydrateExternalActorAudit(
    row,
    row.actorClientId ?? '',
  )
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
    authenticationAudit,
  } as ReviewPatchProposal)
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaReviewPatchRepository implements ReviewPatchRepository {
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

  private proposalById(input: { workspaceId: string; projectId: string; proposalId: string }) {
    return this.client.v2ReviewPatchProposal.findFirst({
      where: { id: input.proposalId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: { renderOperation: true },
    })
  }

  async findProposalIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string }) {
    const row = await this.client.v2ReviewPatchProposal.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { renderOperation: true },
    })
    if (!row) return null
    const proposal = hydrateReviewPatchProposal(row)
    if (
      proposal.authenticationAudit.contextHash !== input.actorContextHash
    ) throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Review patch proposal idempotency key belongs to another authentication context',
    )
    return Object.freeze({ requestFingerprint: row.requestFingerprint, proposal })
  }

  private async contextForAnnotation(input: { workspaceId: string; projectId: string; annotationId: string }): Promise<Readonly<ReviewPatchProposalContext> | null> {
    const annotation = await this.client.v2ReviewAnnotation.findFirst({
      where: { id: input.annotationId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: {
        project: {
          include: {
            currentVersion: { include: { policiesSnapshot: true } },
            mediaAssets: { where: { artifact: { status: 'available' } }, select: { artifactId: true } },
          },
        },
      },
    })
    const version = annotation?.project.currentVersion
    if (!annotation || !version) return null
    const parent = await readPersistedOperationalOutputBundleV3(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: version.id })
    if (!parent) return null
    const editPlanSnapshot = operationalBundlePlanV3(parent)
    const editPlan = parseJson<Record<string, unknown>>(editPlanSnapshot.contentJson, 'review patch EditPlan')
    const policies = parseJson<Record<string, unknown>>(version.policiesSnapshot.contentJson, 'review patch policies')
    const hydratedAnnotation = hydrateReviewAnnotation(annotation)
    // A patch edits the shared plan: its impact is every output's renders. The formats its annotation names must be outputs of the
    // State the patch is applied to, and never narrow that impact.
    assertReviewFormatsAreOutputs(
      outputVariantsOf(parent.state).map((output) => output.variantId),
      hydratedAnnotation.applicationScope.formatIds,
    )
    const outputReferences = await readVersionRenderReferences(this.client, {
      workspaceId: input.workspaceId, projectId: input.projectId, versionId: version.id, state: parent.state,
    })
    return Object.freeze({
      annotation: hydratedAnnotation,
      parent,
      currentVersion: parent.version,
      editPlan: Object.freeze(editPlan),
      editPlanHash: editPlanSnapshot.contentHash,
      policies: Object.freeze(policies),
      availableAssetIds: Object.freeze([...new Set(annotation.project.mediaAssets.map((asset) => asset.artifactId))]),
      outputReferences: normalizeCommandImpactOutputReferences(outputReferences),
    })
  }

  readProposalContext(input: { workspaceId: string; projectId: string; annotationId: string }) {
    return this.contextForAnnotation(input)
  }

  async createProposal(input: { proposal: ReviewPatchProposal; idempotencyKey: string; requestFingerprint: string }) {
    try {
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
        actorClientId: input.proposal.authenticationAudit.clientId,
        ...externalActorAuditData(
          input.proposal.authenticationAudit,
          input.proposal.workspaceId,
          input.proposal.authenticationAudit.clientId,
        ),
        createdAt: new Date(input.proposal.createdAt),
        updatedAt: new Date(input.proposal.updatedAt),
        },
        include: { renderOperation: true },
      })
      return hydrateReviewPatchProposal(row)
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const replay = await this.findProposalIdempotent({
        workspaceId: input.proposal.workspaceId,
        projectId: input.proposal.projectId,
        idempotencyKey: input.idempotencyKey,
        actorContextHash: input.proposal.authenticationAudit.contextHash,
      })
      if (!replay) throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Concurrent review patch proposal did not publish an idempotent winner',
      )
      if (replay.requestFingerprint !== input.requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Concurrent review patch proposal changed its idempotency payload',
        )
      }
      return replay.proposal
    }
  }

  async readProposal(input: { workspaceId: string; projectId: string; proposalId: string }) {
    const row = await this.proposalById(input)
    return row ? hydrateReviewPatchProposal(row) : null
  }

  async readApplyContext(input: { workspaceId: string; projectId: string; proposalId: string }): Promise<Readonly<ReviewPatchApplyContext> | null> {
    const row = await this.proposalById(input)
    if (!row) return null
    const context = await this.contextForAnnotation({ workspaceId: input.workspaceId, projectId: input.projectId, annotationId: row.annotationId })
    return context ? Object.freeze({ ...context, proposal: hydrateReviewPatchProposal(row) }) : null
  }

  async readAppliedResult(input: { workspaceId: string; projectId: string; proposalId: string; applyIdempotencyKey: string; applyRequestFingerprint: string; actorContextHash: string }, options: { rejectFingerprintMismatch?: boolean } = {}): Promise<Readonly<ReviewPatchApplyResult> | null> {
    const proposal = await this.client.v2ReviewPatchProposal.findFirst({
      where: { id: input.proposalId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: { renderOperation: true, resultVersion: { include: { editPlanSnapshot: true, command: { include: { artifactInvalidations: true } } } } },
    })
    if (!proposal || proposal.status !== 'applied' || !proposal.resultVersion || !proposal.resultVersion.command || !proposal.comparisonJson) return null
    if (proposal.applyIdempotencyKey !== input.applyIdempotencyKey) return null
    if (proposal.applyRequestFingerprint !== input.applyRequestFingerprint) {
      // A lost race meeting a winner that used this key for another request must answer like a sequential duplicate.
      if (options.rejectFingerprintMismatch) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different review patch apply request')
      return null
    }
    const commandRow = proposal.resultVersion.command
    if (hydrateEditCommandExternalActorAudit(commandRow).contextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Review patch replay belongs to another authentication context')
    const payload = parseJson<Record<string, unknown>>(commandRow.payloadJson, 'review patch command payload')
    if (payload.schemaVersion !== 2 || !payload.impact) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored review patch command impact is missing')
    const impact = parseCommandImpact(payload.impact)
    if (
      impact.commandType !== 'apply-review-patch' || impact.commandId !== commandRow.id ||
      impact.baseVersionId !== commandRow.baseVersionId || impact.resultVersionId !== proposal.resultVersion.id
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored review patch command impact identity is inconsistent')
    const invalidations = Object.freeze(createCommandArtifactInvalidations({ impact, createdAt: commandRow.createdAt.toISOString() }).toSorted((left, right) => left.id.localeCompare(right.id)))
    const storedInvalidations = Object.freeze(commandRow.artifactInvalidations.map(hydrateInvalidation).toSorted((left, right) => left.id.localeCompare(right.id)))
    if (stableSerialize(invalidations) !== stableSerialize(storedInvalidations)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored review patch artifact invalidations are inconsistent')
    const command = createEditCommand({
      id: commandRow.id,
      workspaceId: commandRow.workspaceId,
      projectId: commandRow.projectId,
      baseVersionId: commandRow.baseVersionId,
      baseHash: commandRow.baseHash,
      author: { type: commandRow.actorType as 'user' | 'director' | 'system' | 'api-client', id: commandRow.actorId, ...(commandRow.delegatedUserId ? { delegatedUserId: commandRow.delegatedUserId } : {}) },
      type: requireEditCommandType(commandRow.type),
      scope: parseJson<EditScope>(commandRow.scopeJson, 'review patch command scope'),
      payload,
      ...(commandRow.reason ? { reason: commandRow.reason } : {}),
      idempotencyKey: commandRow.idempotencyKey,
      createdAt: commandRow.createdAt.toISOString(),
    })
    if (commandRow.commandHash !== command.commandHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored review patch command seal is invalid')
    return Object.freeze({
      proposal: hydrateReviewPatchProposal(proposal),
      command,
      version: hydrateReviewPatchVersion(proposal.resultVersion),
      editPlan: Object.freeze(parseJson<Record<string, unknown>>(proposal.resultVersion.editPlanSnapshot.contentJson, 'applied review patch EditPlan')),
      comparison: Object.freeze(parseJson<NonNullable<ReviewPatchProposal['comparison']>>(proposal.comparisonJson, 'patch comparison')),
      impact,
      invalidations,
      replayed: true,
    })
  }

  async commitOrReplay(input: ReviewPatchCommit, serializationAttempt = 1): Promise<Readonly<ReviewPatchApplyResult>> {
    const sealed = childCommandOf(input.bundle)
    if (!sealed.audit) throw new DomainError('AUTH_INVALID', 'Review patch application requires an authenticated external actor')
    // Local view with the names the transaction below was written against.
    const bundle = {
      proposalId: input.proposalId, applyIdempotencyKey: input.applyIdempotencyKey, applyRequestFingerprint: input.applyRequestFingerprint,
      command: sealed.command, authenticationAudit: sealed.audit, version: input.bundle.version, event: input.event, comparison: input.comparison, impact: input.impact,
    }
    if (bundle.command.type !== 'apply-review-patch' || bundle.version.commandId !== bundle.command.id || bundle.version.parentVersionId !== bundle.command.baseVersionId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Review patch Version does not belong to its Command')
    }
    const replay = await this.readAppliedResult({ workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, proposalId: bundle.proposalId, applyIdempotencyKey: bundle.applyIdempotencyKey, applyRequestFingerprint: bundle.applyRequestFingerprint, actorContextHash: bundle.authenticationAudit.contextHash })
    if (replay) return replay
    let lostRace: unknown = null
    try {
      await this.client.$transaction(async (transaction) => {
        const proposal = await transaction.v2ReviewPatchProposal.findFirst({ where: { id: bundle.proposalId, workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId } })
        const project = await transaction.v2Project.findFirst({ where: { id: bundle.version.projectId, workspaceId: bundle.version.workspaceId }, include: { currentVersion: true } })
        if (!proposal || !project?.currentVersion) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch proposal context disappeared before commit')
        if (proposal.status === 'applied') {
          if (proposal.applyIdempotencyKey !== bundle.applyIdempotencyKey || proposal.applyRequestFingerprint !== bundle.applyRequestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Patch proposal was already applied by another request')
          return
        }
        if (proposal.status !== 'ready' || project.currentVersion.id !== proposal.baseVersionId || bundle.version.parentVersionId !== project.currentVersion.id || bundle.version.sequence !== project.currentVersion.sequence + 1 || input.bundle.state.document.parentStateHash !== project.currentVersion.outputStateHash) {
          throw new DomainError('VERSION_CONFLICT', 'Project version changed before review patch commit', { currentVersionId: project.currentVersion.id })
        }
        const payload = bundle.command.payload as Readonly<{ schemaVersion?: unknown; impact?: unknown }>
        const persistedImpact = payload.schemaVersion === 2 && payload.impact ? parseCommandImpact(payload.impact) : null
        if (
          !persistedImpact || persistedImpact.commandType !== 'apply-review-patch' ||
          persistedImpact.impactHash !== bundle.impact.impactHash
        ) throw new DomainError('PERSISTENCE_CONFLICT', 'Review patch command and impact payload are inconsistent')
        // The child carries the very outputs of its parent, so its State attributes the base Version's renders (every output's).
        const currentAffectedArtifacts = normalizeCommandImpactOutputReferences(await readVersionRenderReferences(transaction, {
          workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId,
          versionId: bundle.command.baseVersionId, state: input.bundle.state,
        }))
        if (stableSerialize(currentAffectedArtifacts) !== stableSerialize(bundle.impact.affectedArtifacts)) {
          throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before review patch impact commit')
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
        const updated = await transaction.v2Project.updateMany({ where: { id: bundle.version.projectId, workspaceId: bundle.version.workspaceId, currentVersionId: bundle.command.baseVersionId }, data: { currentVersionId: bundle.version.id } })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during review patch commit')
        await transaction.v2ReviewAnnotation.update({ where: { id: proposal.annotationId }, data: { status: 'applied', updatedAt: new Date(bundle.command.createdAt) } })
        await transaction.v2ReviewPatchProposal.update({ where: { id: proposal.id }, data: {
          status: 'applied', applyIdempotencyKey: bundle.applyIdempotencyKey, applyRequestFingerprint: bundle.applyRequestFingerprint,
          resultCommandId: bundle.command.id, resultVersionId: bundle.version.id, comparisonJson: stableSerialize(bundle.comparison),
          appliedAt: new Date(bundle.command.createdAt), updatedAt: new Date(bundle.command.createdAt),
        } })
        await persistPublicEvents(transaction, [
          bundle.event,
          createPublicEvent({
            id: this.createEventId(),
            type: 'annotation.resolved',
            version: '1.0.0',
            workspaceId: bundle.command.workspaceId,
            occurredAt: bundle.command.createdAt,
            ...(bundle.event.actor ? { actor: bundle.event.actor } : {}),
            resource: { type: 'annotation', id: proposal.annotationId },
            data: {
              projectId: bundle.command.projectId,
              baseVersionId: bundle.command.baseVersionId,
              resultVersionId: bundle.version.id,
              commandId: bundle.command.id,
              proposalId: proposal.id,
              status: 'applied',
            },
          }),
        ])
        await settleDeferredOutputGuards(transaction)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) return this.commitOrReplay(input, serializationAttempt + 1)
      if (!isPrismaCode(error, 'P2002') && !isPrismaCode(error, 'P2034')) throw error
      lostRace = error
    }
    const result = await reconcileAfterConflict(lostRace, () => this.readAppliedResult({ workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId, proposalId: bundle.proposalId, applyIdempotencyKey: bundle.applyIdempotencyKey, applyRequestFingerprint: bundle.applyRequestFingerprint, actorContextHash: bundle.authenticationAudit.contextHash }, { rejectFingerprintMismatch: true }))
    if (!result) throw new DomainError('PERSISTENCE_CONFLICT', 'Applied review patch could not be reconstructed')
    // A lost race answers like a sequential duplicate (replayed); the committer's own readback is not a replay.
    return Object.freeze({ ...result, replayed: lostRace !== null })
  }

  async attachRenderOperation(input: { workspaceId: string; projectId: string; proposalId: string; renderOperationId: string }) {
    const proposal = await this.client.v2ReviewPatchProposal.findFirst({ where: { id: input.proposalId, workspaceId: input.workspaceId, projectId: input.projectId } })
    if (!proposal?.resultVersionId) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch proposal has no applied version')
    const operation = await this.client.v2ProjectProxyRenderOperation.findFirst({ where: { operationId: input.renderOperationId, workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: proposal.resultVersionId } })
    if (!operation) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch render operation does not target the applied version')
    if (proposal.renderOperationId && proposal.renderOperationId !== input.renderOperationId) throw new DomainError('PERSISTENCE_CONFLICT', 'Patch proposal already has another render operation')
    const row = await this.client.v2ReviewPatchProposal.update({ where: { id: proposal.id }, data: { renderOperationId: input.renderOperationId }, include: { renderOperation: true } })
    return hydrateReviewPatchProposal(row)
  }
}
