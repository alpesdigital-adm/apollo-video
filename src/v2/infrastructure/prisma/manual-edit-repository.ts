import type { AdoptableObservationReader } from '../../application/ports/adoptable-observation-reader.ts'
import { readAdoptableObservationsV3 } from './output-adoptable-observations.ts'
import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ManualEditCommit,
  ManualEditContext,
  ManualEditRepository,
  ManualEditResult,
  ManualEditVersionRecord,
} from '../../application/ports/manual-edit-repository.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  timelineViewModelFromEditPlan,
  type PersistedManualEditPayload,
} from '../../domain/manual-editing.ts'
import { operationalBundlePlanV3, type OperationalOutputParentV3 } from '../../domain/output-version-bundle.ts'
import { manualEditCommandOf } from '../../domain/project-output-state-transition.ts'
import { hydrateProjectVersionRowV3 } from '../../domain/project-version-row.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  createCommandArtifactInvalidations,
  normalizeCommandImpactOutputReferences,
  parseCommandArtifactInvalidation,
  parseCommandImpact,
} from '../../domain/command-impact.ts'
import { hydrateEditCommandExternalActorAudit } from './edit-command-actor-audit.ts'
import { assertManualOutputReferencesV3 } from './output-version-bundle-repository.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState, settleDeferredOutputGuards } from './project-version-commit.ts'
import { readVersionRenderReferences } from './version-render-references.ts'

type StoredManualCommand = Prisma.V2EditCommandGetPayload<{
  include: {
    baseVersion: { include: { editPlanSnapshot: true } }
    resultVersion: { include: { editPlanSnapshot: true } }
    artifactInvalidations: true
  }
}>

type StoredInvalidation = Prisma.V2CommandArtifactInvalidationGetPayload<{}>

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseArray(value: string, field: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function hydrateInvalidation(item: StoredInvalidation) {
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
    dependencyTypes: parseArray(item.dependencyTypesJson, 'artifact invalidation dependencies'),
    affectedRanges: parseArray(item.affectedRangesJson, 'artifact invalidation ranges'),
    impactHash: item.impactHash,
    createdAt: item.createdAt.toISOString(),
  })
}

/** A manual edit works on a compiled EditPlan; the sealed bundle is the only source of the current one. */
function assertCompiledManualPlan(editPlan: Record<string, unknown>, versionId: string): void {
  if (editPlan.schemaVersion !== 2 || editPlan.state !== 'compiled' || editPlan.projectVersionId !== versionId) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored manual EditPlan is inconsistent')
  }
}

function recordFromBundle(bundle: OperationalOutputParentV3): Readonly<ManualEditVersionRecord> {
  const snapshot = operationalBundlePlanV3(bundle)
  const editPlan = parseRecord(snapshot.contentJson, 'manual EditPlan')
  assertCompiledManualPlan(editPlan, bundle.version.id)
  return Object.freeze({ version: bundle.version, editPlan: Object.freeze(editPlan), editPlanHash: snapshot.contentHash, bundle })
}

function hydrateStoredCommand(
  row: StoredManualCommand,
  replayed: boolean,
): ManualEditResult {
  hydrateEditCommandExternalActorAudit(row)
  if (row.type !== 'manual-edit' || !row.resultVersion) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Manual command result version is missing')
  }
  const scope = parseRecord(row.scopeJson, 'manual command scope') as EditScope
  const payload = parseRecord(
    row.payloadJson,
    'manual command payload',
  ) as unknown as PersistedManualEditPayload
  if (
    ![1, 2].includes(payload.schemaVersion) ||
    !['apply', 'undo', 'redo', 'restore'].includes(payload.action) ||
    !Number.isInteger(payload.expectedRevision)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored manual command payload is inconsistent')
  }
  const command = createEditCommand<PersistedManualEditPayload>({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    baseVersionId: row.baseVersionId,
    baseHash: row.baseHash,
    author: {
      type: row.actorType as 'user' | 'director' | 'system' | 'api-client',
      id: row.actorId,
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
    },
    type: row.type,
    scope,
    payload,
    ...(row.reason ? { reason: row.reason } : {}),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  })
  if (row.commandHash !== command.commandHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored manual command seal is invalid')
  }
  const resultEditPlan = parseRecord(row.resultVersion.editPlanSnapshot.contentJson, 'manual EditPlan')
  assertCompiledManualPlan(resultEditPlan, row.resultVersion.id)
  const resultVersion = Object.freeze({
    version: hydrateProjectVersionRowV3(row.resultVersion),
    editPlan: Object.freeze(resultEditPlan),
    editPlanHash: row.resultVersion.editPlanSnapshot.contentHash,
  })
  const editPlanHash = resultVersion.editPlanHash
  const impact = payload.impact ? parseCommandImpact(payload.impact) : undefined
  if (
    impact &&
    (impact.commandId !== row.id ||
      impact.baseVersionId !== row.baseVersionId ||
      impact.resultVersionId !== resultVersion.version.id)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Command impact identity is inconsistent')
  }
  const invalidations = impact
    ? Object.freeze(createCommandArtifactInvalidations({
        impact,
        createdAt: row.createdAt.toISOString(),
      }).toSorted((left, right) => left.id.localeCompare(right.id)))
    : Object.freeze([])
  const storedInvalidations = row.artifactInvalidations
    .map(hydrateInvalidation)
    .toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(storedInvalidations) !== stableSerialize(invalidations)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored Command artifact invalidations are inconsistent',
    )
  }
  return Object.freeze({
    command,
    version: resultVersion.version,
    editPlan: resultVersion.editPlan,
    timeline: timelineViewModelFromEditPlan({
      editPlan: resultVersion.editPlan,
      versionId: resultVersion.version.id,
      revision: resultVersion.version.sequence,
      ...(payload.operation ? { selectedClipId: payload.operation.clipId } : {}),
    }),
    comparison: Object.freeze({
      beforeVersionId: row.baseVersionId,
      afterVersionId: resultVersion.version.id,
      beforeEditPlanHash: row.baseVersion.editPlanSnapshot.contentHash,
      afterEditPlanHash: editPlanHash,
      action: payload.action,
      targetId: payload.targetId,
    }),
    replayed,
    ...(impact ? { impact } : {}),
    invalidations,
  })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaManualEditRepository implements ManualEditRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  /** The persisted receipts of the recordings a new plan consumes and the head State does not observe (see adoptable-observations). */
  async readAdoptableObservations(input: Parameters<AdoptableObservationReader['readAdoptableObservations']>[0]) {
    return readAdoptableObservationsV3(this.client, input)
  }

  async findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.client.v2EditCommand.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: {
        baseVersion: { include: { editPlanSnapshot: true } },
        resultVersion: { include: { editPlanSnapshot: true } },
        artifactInvalidations: true,
      },
    })
    if (!row) return null
    if (row.type !== 'manual-edit') {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key belongs to another command type',
      )
    }
    if (hydrateEditCommandExternalActorAudit(row).contextHash !== input.actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Manual edit replay belongs to another authentication context')
    }
    return Object.freeze({
      requestFingerprint: row.requestFingerprint,
      result: hydrateStoredCommand(row, true),
    })
  }

  async readContext(input: {
    workspaceId: string
    projectId: string
    targetVersionId?: string
  }): Promise<Readonly<ManualEditContext> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: {
        mediaAssets: {
          where: { artifact: { status: 'available' } },
          select: { artifactId: true },
        },
        versions: {
          orderBy: { sequence: 'desc' },
          take: 40,
          include: {
            command: { select: { id: true, type: true, payloadJson: true } },
          },
        },
      },
    })
    if (!project?.currentVersionId) return null
    const currentBundle = await readPersistedOperationalOutputBundleV3(this.client, {
      workspaceId: input.workspaceId, projectId: input.projectId, versionId: project.currentVersionId,
    })
    if (!currentBundle) return null
    const current = recordFromBundle(currentBundle)
    // The renders of the current Version, every output's, each attributed to the stable variant it was made for.
    const outputReferences = await readVersionRenderReferences(this.client, {
      workspaceId: input.workspaceId, projectId: input.projectId, versionId: current.version.id, state: currentBundle.state,
    })
    const targetBundle = input.targetVersionId
      ? await readPersistedOperationalOutputBundleV3(this.client, {
          workspaceId: input.workspaceId, projectId: input.projectId, versionId: input.targetVersionId,
        })
      : undefined
    if (input.targetVersionId && !targetBundle) return null
    const history = project.versions.map((row) => {
      let action: 'apply' | 'undo' | 'redo' | 'restore' | undefined
      let restoresVersionId: string | undefined
      if (row.command?.type === 'manual-edit') {
        const payload = parseRecord(row.command.payloadJson, 'manual history payload')
        if (['apply', 'undo', 'redo', 'restore'].includes(String(payload.action))) {
          action = payload.action as 'apply' | 'undo' | 'redo' | 'restore'
        }
        if (typeof payload.restoresVersionId === 'string') {
          restoresVersionId = payload.restoresVersionId
        }
      }
      return Object.freeze({
        id: row.id,
        sequence: row.sequence,
        ...(row.parentVersionId ? { parentVersionId: row.parentVersionId } : {}),
        ...(row.commandId ? { commandId: row.commandId } : {}),
        ...(row.command?.type ? { commandType: row.command.type } : {}),
        ...(action ? { action } : {}),
        ...(restoresVersionId ? { restoresVersionId } : {}),
        createdAt: row.createdAt.toISOString(),
      })
    })
    return Object.freeze({
      ...current,
      availableAssetIds: Object.freeze([
        ...new Set(project.mediaAssets.map((item) => item.artifactId)),
      ]),
      outputReferences,
      ...(targetBundle ? { targetVersion: recordFromBundle(targetBundle) } : {}),
      history: Object.freeze(history),
    })
  }

  async readArtifactInvalidations(input: {
    workspaceId: string
    projectId: string
    resultVersionId?: string
  }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { currentVersionId: true },
    })
    if (!project?.currentVersionId) return null
    const resultVersionId = input.resultVersionId ?? project.currentVersionId
    if (input.resultVersionId) {
      const version = await this.client.v2ProjectVersion.findFirst({
        where: {
          id: resultVersionId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
        },
        select: { id: true },
      })
      if (!version) return null
    }
    const rows = await this.client.v2CommandArtifactInvalidation.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        resultVersionId,
        resolutions: { none: { operation: { status: 'succeeded' } } },
      },
      orderBy: { id: 'asc' },
    })
    return Object.freeze({
      projectId: input.projectId,
      resultVersionId,
      invalidations: Object.freeze(rows.map(hydrateInvalidation)),
    })
  }

  async commitOrReplay(
    input: ManualEditCommit,
    serializationAttempt = 1,
  ): Promise<ManualEditResult> {
    const sealed = manualEditCommandOf(input.bundle)
    if (!sealed.audit) throw new DomainError('AUTH_INVALID', 'A manual edit requires an authenticated external actor')
    // Local view with the names the transaction below was written against.
    const bundle = {
      command: sealed.command, authenticationAudit: sealed.audit, requestFingerprint: sealed.requestFingerprint,
      version: input.bundle.version, event: input.event, comparison: input.comparison, impact: input.impact,
    }
    if (bundle.command.type !== 'manual-edit' || bundle.version.commandId !== bundle.command.id || bundle.version.parentVersionId !== bundle.command.baseVersionId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Manual edit Version does not belong to its Command')
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const key = {
          workspaceId_projectId_idempotencyKey: {
            workspaceId: bundle.command.workspaceId,
            projectId: bundle.command.projectId,
            idempotencyKey: bundle.command.idempotencyKey,
          },
        }
        const existing = await transaction.v2EditCommand.findUnique({
          where: key,
          include: {
            baseVersion: { include: { editPlanSnapshot: true } },
            resultVersion: { include: { editPlanSnapshot: true } },
            artifactInvalidations: true,
          },
        })
        if (existing) {
          if (
            existing.type !== 'manual-edit' ||
            existing.requestFingerprint !== bundle.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different manual edit',
            )
          }
          if (hydrateEditCommandExternalActorAudit(existing).contextHash !== bundle.authenticationAudit.contextHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Manual edit replay belongs to another authentication context')
          }
          return hydrateStoredCommand(existing, true)
        }
        const project = await transaction.v2Project.findFirst({
          where: {
            id: bundle.command.projectId,
            workspaceId: bundle.command.workspaceId,
          },
          include: { currentVersion: true },
        })
        if (
          !project?.currentVersion ||
          project.currentVersion.id !== bundle.command.baseVersionId ||
          project.currentVersion.baseHash !== bundle.command.baseHash ||
          bundle.version.parentVersionId !== project.currentVersion.id ||
          bundle.version.sequence !== project.currentVersion.sequence + 1 ||
          input.bundle.state.document.parentStateHash !== project.currentVersion.outputStateHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Project version changed before manual edit commit',
            project?.currentVersion
              ? {
                  currentVersionId: project.currentVersion.id,
                  currentBaseHash: project.currentVersion.baseHash,
                  currentRevision: project.currentVersion.sequence,
                }
              : undefined,
          )
        }
        const persistedImpact = bundle.command.payload.impact
          ? parseCommandImpact(bundle.command.payload.impact)
          : null
        if (!persistedImpact || persistedImpact.impactHash !== bundle.impact.impactHash) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Manual command and impact payload are inconsistent',
          )
        }
        if (sealed.kind !== 'child-command') {
          // Selection and restore: the database guard re-derives these references, so the owner's own check runs.
          await assertManualOutputReferencesV3(transaction, input.bundle)
        } else {
          // The child carries the very outputs (variants and specs) of its parent, so its State attributes the base Version's renders.
          const currentAffectedArtifacts = bundle.impact.renderSemanticsChanged
            ? normalizeCommandImpactOutputReferences(await readVersionRenderReferences(transaction, {
                workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId,
                versionId: bundle.command.baseVersionId, state: input.bundle.state,
              }))
            : []
          if (stableSerialize(currentAffectedArtifacts) !== stableSerialize(bundle.impact.affectedArtifacts)) {
            throw new DomainError(
              'VERSION_CONFLICT',
              'Project render outputs changed before Command impact commit',
            )
          }
        }
        await commitProjectVersionWithOutputState(transaction, input.bundle)
        const invalidations = createCommandArtifactInvalidations({
          impact: bundle.impact,
          createdAt: bundle.command.createdAt,
        })
        if (invalidations.length > 0) {
          await transaction.v2CommandArtifactInvalidation.createMany({
            data: invalidations.map((invalidation) => ({
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
            })),
          })
        }
        const updated = await transaction.v2Project.updateMany({
          where: {
            id: bundle.command.projectId,
            workspaceId: bundle.command.workspaceId,
            currentVersionId: bundle.command.baseVersionId,
          },
          data: { currentVersionId: bundle.version.id },
        })
        if (updated.count !== 1) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Project current version changed during manual edit commit',
          )
        }
        await transaction.v2PublicEventOutbox.create({
          data: {
            id: bundle.event.id,
            workspaceId: bundle.event.workspaceId,
            type: bundle.event.type,
            version: bundle.event.version,
            occurredAt: new Date(bundle.event.occurredAt),
            sequence: bundle.event.sequence,
            actorClientId: bundle.event.actor?.clientId,
            actorUserId: bundle.event.actor?.userId,
            resourceType: bundle.event.resource.type,
            resourceId: bundle.event.resource.id,
            dataJson: stableSerialize(bundle.event.data),
          },
        })
        await settleDeferredOutputGuards(transaction)
        const stored = await transaction.v2EditCommand.findUniqueOrThrow({
          where: { id: bundle.command.id },
          include: {
            baseVersion: { include: { editPlanSnapshot: true } },
            resultVersion: { include: { editPlanSnapshot: true } },
            artifactInvalidations: true,
          },
        })
        const result = hydrateStoredCommand(stored, false)
        return Object.freeze({ ...result, comparison: bundle.comparison })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) {
        return this.commitOrReplay(input, serializationAttempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const existing = await this.findIdempotentResult({
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          idempotencyKey: bundle.command.idempotencyKey,
          actorContextHash: bundle.authenticationAudit.contextHash,
        })
        if (existing) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different manual edit',
            )
          }
          return Object.freeze({ ...existing.result, replayed: true })
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Manual edit collided with immutable persisted state',
        )
      }
      throw error
    }
  }
}
