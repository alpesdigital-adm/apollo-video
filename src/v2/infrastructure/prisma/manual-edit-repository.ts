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
import { createProjectVersion } from '../../domain/project-version.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  createCommandArtifactInvalidations,
  normalizeCommandImpactOutputReferences,
  parseCommandArtifactInvalidation,
  parseCommandImpact,
} from '../../domain/command-impact.ts'
import {
  editCommandExternalActorAuditData,
  hydrateEditCommandExternalActorAudit,
} from './edit-command-actor-audit.ts'

type VersionWithPlan = Prisma.V2ProjectVersionGetPayload<{
  include: { editPlanSnapshot: true }
}>

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

function hydrateVersion(row: VersionWithPlan): Readonly<ManualEditVersionRecord> {
  const editPlan = parseRecord(row.editPlanSnapshot.contentJson, 'manual EditPlan')
  if (
    editPlan.schemaVersion !== 2 ||
    editPlan.state !== 'compiled' ||
    editPlan.projectVersionId !== row.id
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored manual EditPlan is inconsistent')
  }
  return Object.freeze({
    version: createProjectVersion({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      sequence: row.sequence,
      parentVersionId: row.parentVersionId ?? undefined,
      snapshotRefs: {
        brief: row.briefSnapshotId,
        editPlan: row.editPlanSnapshotId,
        policies: row.policiesSnapshotId,
      },
      baseHash: row.baseHash,
      createdBy: row.createdBy,
      commandId: row.commandId ?? undefined,
      createdAt: row.createdAt.toISOString(),
    }),
    editPlan: Object.freeze(editPlan),
    editPlanHash: row.editPlanSnapshot.contentHash,
  })
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
  const resultVersion = hydrateVersion(row.resultVersion)
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
        currentVersion: { include: { editPlanSnapshot: true } },
        mediaAssets: {
          where: { artifact: { status: 'available' } },
          select: { artifactId: true },
        },
        versions: {
          orderBy: { sequence: 'desc' },
          take: 40,
          include: {
            editPlanSnapshot: true,
            command: { select: { id: true, type: true, payloadJson: true } },
          },
        },
      },
    })
    if (!project?.currentVersion) return null
    const current = hydrateVersion(project.currentVersion)
    const [proxyOutputs, finalOutputs] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: current.version.id,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: current.version.id,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    const targetRow = input.targetVersionId
      ? project.versions.find((version) => version.id === input.targetVersionId)
        ?? await this.client.v2ProjectVersion.findFirst({
          where: {
            id: input.targetVersionId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
          },
          include: { editPlanSnapshot: true },
        })
      : undefined
    if (input.targetVersionId && !targetRow) return null
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
      renderVariantIds: Object.freeze([project.format ?? '9:16']),
      outputReferences: Object.freeze([
        ...proxyOutputs.map((output) => Object.freeze({
          artifactId: output.outputArtifactId,
          kind: 'proxy' as const,
          sourceVersionId: current.version.id,
          variantId: project.format ?? '9:16',
        })),
        ...finalOutputs.map((output) => Object.freeze({
          artifactId: output.outputArtifactId,
          kind: 'final' as const,
          sourceVersionId: current.version.id,
          variantId: output.outputAspectRatio,
        })),
      ].toSorted((left, right) => left.artifactId.localeCompare(right.artifactId))),
      ...(targetRow ? { targetVersion: hydrateVersion(targetRow) } : {}),
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
    bundle: ManualEditCommit,
    serializationAttempt = 1,
  ): Promise<ManualEditResult> {
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
          bundle.version.sequence !== project.currentVersion.sequence + 1
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
        const variantId = bundle.command.payload.variantId
        const currentAffectedArtifacts = bundle.impact.renderSemanticsChanged
          ? normalizeCommandImpactOutputReferences([
              ...(project.format === variantId
                ? proxyOutputs.map((output) => ({
                    artifactId: output.outputArtifactId,
                    kind: 'proxy' as const,
                    sourceVersionId: bundle.command.baseVersionId,
                    variantId,
                  }))
                : []),
              ...finalOutputs
                .filter((output) => output.outputAspectRatio === variantId)
                .map((output) => ({
                  artifactId: output.outputArtifactId,
                  kind: 'final' as const,
                  sourceVersionId: bundle.command.baseVersionId,
                  variantId,
                })),
            ])
          : []
        if (stableSerialize(currentAffectedArtifacts) !== stableSerialize(bundle.impact.affectedArtifacts)) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Project render outputs changed before Command impact commit',
          )
        }
        await transaction.v2EditCommand.create({
          data: {
            id: bundle.command.id,
            workspaceId: bundle.command.workspaceId,
            projectId: bundle.command.projectId,
            baseVersionId: bundle.command.baseVersionId,
            baseHash: bundle.command.baseHash,
            type: bundle.command.type,
            scopeJson: stableSerialize(bundle.command.scope),
            payloadJson: stableSerialize(bundle.command.payload),
            reason: bundle.command.reason,
            actorType: bundle.command.author.type,
            actorId: bundle.command.author.id,
            delegatedUserId: bundle.command.author.delegatedUserId,
            ...editCommandExternalActorAuditData(bundle.authenticationAudit, bundle.command.workspaceId, bundle.command.author),
            idempotencyKey: bundle.command.idempotencyKey,
            requestFingerprint: bundle.requestFingerprint,
            createdAt: new Date(bundle.command.createdAt),
          },
        })
        await transaction.v2ProjectSnapshot.create({
          data: {
            id: bundle.snapshot.id,
            workspaceId: bundle.snapshot.workspaceId,
            projectId: bundle.snapshot.projectId,
            kind: bundle.snapshot.kind,
            schemaVersion: bundle.snapshot.contentSchemaVersion,
            contentJson: bundle.snapshot.contentJson,
            contentHash: bundle.snapshot.contentHash,
            createdAt: new Date(bundle.snapshot.createdAt),
          },
        })
        await transaction.v2ProjectVersion.create({
          data: {
            id: bundle.version.id,
            workspaceId: bundle.version.workspaceId,
            projectId: bundle.version.projectId,
            sequence: bundle.version.sequence,
            parentVersionId: bundle.version.parentVersionId,
            briefSnapshotId: bundle.version.snapshotRefs.brief!,
            editPlanSnapshotId: bundle.version.snapshotRefs.editPlan,
            policiesSnapshotId: bundle.version.snapshotRefs.policies,
            baseHash: bundle.version.baseHash,
            createdBy: bundle.version.createdBy,
            commandId: bundle.command.id,
            createdAt: new Date(bundle.version.createdAt),
          },
        })
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
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) {
        return this.commitOrReplay(bundle, serializationAttempt + 1)
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
