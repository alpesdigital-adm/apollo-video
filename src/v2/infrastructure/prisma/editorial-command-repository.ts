import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  EditorialCommandCommit,
  EditorialCommandContext,
  EditorialCommandRepository,
  EditorialCommandResult,
} from '../../application/ports/editorial-command-repository.ts'
import type {
  EditorialCutEditPlan,
  RemoveSpokenContentPayload,
} from '../../application/apply-editorial-cut-command.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import { createEditorialCutInvalidations, parseEditorialCutImpact } from '../../domain/editorial-cut-impact.ts'
import { parseCommandArtifactInvalidation } from '../../domain/command-impact.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type StoredCommand = Prisma.V2EditCommandGetPayload<{
  include: { resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true }
}>

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

function hydrateStoredCommand(row: StoredCommand, replayed: boolean): EditorialCommandResult {
  if (!row.resultVersion) throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial command result version is missing')
  const scope = parseRecord(row.scopeJson, 'editorial command scope') as EditScope
  const payload = parseRecord(row.payloadJson, 'editorial command payload') as unknown as RemoveSpokenContentPayload
  const impact = parseEditorialCutImpact(payload.impact)
  if (
    row.type !== 'remove-spoken-content' || payload.schemaVersion !== 2 ||
    impact.commandId !== row.id || impact.baseVersionId !== row.baseVersionId ||
    impact.resultVersionId !== row.resultVersion.id ||
    impact.sourceTranscriptId !== payload.sourceTranscriptId
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored editorial command impact is inconsistent')
  const command = createEditCommand<RemoveSpokenContentPayload>({
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
  const versionRow = row.resultVersion
  const version = createProjectVersion({
    id: versionRow.id,
    workspaceId: versionRow.workspaceId,
    projectId: versionRow.projectId,
    sequence: versionRow.sequence,
    parentVersionId: versionRow.parentVersionId ?? undefined,
    snapshotRefs: {
      brief: versionRow.briefSnapshotId,
      editPlan: versionRow.editPlanSnapshotId,
      policies: versionRow.policiesSnapshotId,
    },
    baseHash: versionRow.baseHash,
    createdBy: versionRow.createdBy,
    commandId: versionRow.commandId ?? undefined,
    createdAt: versionRow.createdAt.toISOString(),
  })
  const editPlan = parseRecord(versionRow.editPlanSnapshot.contentJson, 'editorial EditPlan') as unknown as EditorialCutEditPlan
  if (
    editPlan.schemaVersion !== 2 ||
    editPlan.state !== 'compiled' ||
    editPlan.projectVersionId !== version.id ||
    !editPlan.editorial ||
    editPlan.editorial.commandType !== 'remove-spoken-content'
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored editorial EditPlan is inconsistent')
  }
  const expectedInvalidations = createEditorialCutInvalidations({ impact, createdAt: row.createdAt.toISOString() })
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const invalidations = row.artifactInvalidations.map((item) => parseCommandArtifactInvalidation({
    schemaVersion: 'command-artifact-invalidation/v1', id: item.id, status: item.status,
    commandId: item.commandId, baseVersionId: item.baseVersionId,
    resultVersionId: item.resultVersionId, artifactId: item.artifactId,
    kind: item.kind, variantId: item.variantId,
    dependencyTypes: parseArray(item.dependencyTypesJson, 'editorial invalidation dependencies'),
    affectedRanges: parseArray(item.affectedRangesJson, 'editorial invalidation ranges'),
    impactHash: item.impactHash, createdAt: item.createdAt.toISOString(),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(expectedInvalidations) !== stableSerialize(invalidations)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored editorial invalidations are inconsistent')
  }
  return Object.freeze({
    command,
    version,
    editPlan: Object.freeze(editPlan),
    exclusions: Object.freeze(editPlan.editorial.exclusions),
    retainedSourceRanges: Object.freeze(editPlan.editorial.retainedSourceRanges),
    impact,
    invalidations: Object.freeze(invalidations),
    replayed,
  })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaEditorialCommandRepository implements EditorialCommandRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2EditCommand.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: input,
      },
      include: { resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true },
    })
    if (!row) return null
    return Object.freeze({
      requestFingerprint: row.requestFingerprint,
      result: hydrateStoredCommand(row, true),
    })
  }

  async readContext(input: {
    workspaceId: string
    projectId: string
    transcriptId: string
  }): Promise<Readonly<EditorialCommandContext> | null> {
    const [project, transcriptRow] = await Promise.all([
      this.client.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        include: { currentVersion: { include: { editPlanSnapshot: true } } },
      }),
      this.client.v2MediaTranscript.findFirst({
        where: { id: input.transcriptId, projectId: input.projectId, workspaceId: input.workspaceId },
      }),
    ])
    if (!project?.currentVersion || !transcriptRow) return null
    const [artifact, manifests, proxyOutputs, finalOutputs] = await Promise.all([
      this.client.v2MediaArtifact.findFirst({
        where: { id: transcriptRow.sourceArtifactId, workspaceId: input.workspaceId, status: 'available' },
      }),
      this.client.v2MediaArtifactManifest.findMany({
        where: {
          artifactId: transcriptRow.sourceArtifactId,
          workspaceId: input.workspaceId,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 32,
      }),
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    if (!artifact || manifests.length === 0) throw new DomainError('PERSISTENCE_CONFLICT', 'Transcript source artifact or manifest is missing')
    const transcriptInput = parseRecord(transcriptRow.transcriptJson, 'aligned transcript') as unknown as {
      language: string
      text: string
      words: { word: string; start: number; end: number }[]
      segments: { id: number; start: number; end: number; text: string; confidence?: number }[]
      provider: string
      model: string
    }
    const transcript = createMediaTranscript({
      language: transcriptInput.language,
      text: transcriptInput.text,
      words: transcriptInput.words,
      segments: transcriptInput.segments,
      provider: transcriptInput.provider,
      model: transcriptInput.model,
    })
    if (transcript.transcriptHash !== transcriptRow.transcriptHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Aligned transcript hash does not match persisted identity')
    }
    const probeRecord = manifests.flatMap((candidate) => {
      const record = parseRecord(candidate.manifestJson, 'source media manifest')
      const probe = record.probe
      return typeof probe === 'object' && probe !== null && !Array.isArray(probe)
        ? [probe as Record<string, unknown>]
        : []
    }).find((probe) => Number.isFinite(Number(probe.duration)) && Number.isFinite(Number(probe.fps)))
    if (!probeRecord) throw new DomainError('PERSISTENCE_CONFLICT', 'Source media manifests have no probe evidence')
    const sourceDurationSeconds = Number(probeRecord.duration)
    const sourceFps = Number(probeRecord.fps)
    if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0 || !Number.isFinite(sourceFps) || sourceFps <= 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Source media duration or frame rate is invalid')
    }
    const versionRow = project.currentVersion
    const currentEditPlan = parseRecord(versionRow.editPlanSnapshot.contentJson, 'current editorial base EditPlan')
    const currentDurationFrames = Number(currentEditPlan.durationFrames)
    if (!Number.isSafeInteger(currentDurationFrames) || currentDurationFrames <= 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan duration is invalid')
    }
    return Object.freeze({
      projectId: project.id,
      workspaceId: project.workspaceId,
      currentVersion: createProjectVersion({
        id: versionRow.id,
        workspaceId: versionRow.workspaceId,
        projectId: versionRow.projectId,
        sequence: versionRow.sequence,
        parentVersionId: versionRow.parentVersionId ?? undefined,
        snapshotRefs: {
          brief: versionRow.briefSnapshotId,
          editPlan: versionRow.editPlanSnapshotId,
          policies: versionRow.policiesSnapshotId,
        },
        baseHash: versionRow.baseHash,
        createdBy: versionRow.createdBy,
        commandId: versionRow.commandId ?? undefined,
        createdAt: versionRow.createdAt.toISOString(),
      }),
      transcriptId: transcriptRow.id,
      transcript,
      sourceArtifactId: transcriptRow.sourceArtifactId,
      sourceDurationSeconds,
      sourceFps,
      currentDurationFrames,
      proxyVariantId: project.format ?? '9:16',
      outputReferences: Object.freeze([
        ...proxyOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: versionRow.id, variantId: project.format ?? '9:16' })),
        ...finalOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: versionRow.id, variantId: output.outputAspectRatio })),
      ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))),
    })
  }

  async commitOrReplay(bundle: EditorialCommandCommit, serializationAttempt = 1): Promise<EditorialCommandResult> {
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
          include: { resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true },
        })
        if (existing) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different editorial command')
          }
          return hydrateStoredCommand(existing, true)
        }
        const [project, transcript] = await Promise.all([
          transaction.v2Project.findFirst({
            where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId },
            include: { currentVersion: true },
          }),
          transaction.v2MediaTranscript.findFirst({
            where: {
              id: bundle.sourceEvidence.transcriptId,
              projectId: bundle.command.projectId,
              workspaceId: bundle.command.workspaceId,
              sourceArtifactId: bundle.sourceEvidence.sourceArtifactId,
              transcriptHash: bundle.sourceEvidence.transcriptHash,
            },
          }),
        ])
        if (!project?.currentVersion || !transcript) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial command source evidence disappeared before commit')
        }
        if (
          project.currentVersion.id !== bundle.command.baseVersionId ||
          project.currentVersion.baseHash !== bundle.command.baseHash ||
          bundle.version.parentVersionId !== project.currentVersion.id ||
          bundle.version.sequence !== project.currentVersion.sequence + 1
        ) {
          throw new DomainError('VERSION_CONFLICT', 'Project version changed before editorial command commit', {
            currentVersionId: project.currentVersion.id,
            currentBaseHash: project.currentVersion.baseHash,
          })
        }
        const [proxyOutputs, finalOutputs] = await Promise.all([
          transaction.v2ProjectProxyRenderOperation.findMany({
            where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
            select: { outputArtifactId: true },
          }),
          transaction.v2ProjectFinalExportOperation.findMany({
            where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
            select: { outputArtifactId: true, outputAspectRatio: true },
          }),
        ])
        const currentOutputs = [
          ...proxyOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: bundle.command.baseVersionId, variantId: project.format ?? '9:16' })),
          ...finalOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: bundle.command.baseVersionId, variantId: output.outputAspectRatio })),
        ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
        if (stableSerialize(currentOutputs) !== stableSerialize(bundle.command.payload.impact.affectedArtifacts)) {
          throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before editorial impact commit')
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
        const invalidations = createEditorialCutInvalidations({ impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt })
        if (invalidations.length > 0) {
          await transaction.v2CommandArtifactInvalidation.createMany({ data: invalidations.map((item) => ({
            id: item.id, workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId,
            commandId: item.commandId, baseVersionId: item.baseVersionId, resultVersionId: item.resultVersionId,
            artifactId: item.artifactId, kind: item.kind, variantId: item.variantId, status: item.status,
            dependencyTypesJson: stableSerialize(item.dependencyTypes), affectedRangesJson: stableSerialize(item.affectedRanges),
            impactHash: item.impactHash, createdAt: new Date(item.createdAt),
          })) })
        }
        const updated = await transaction.v2Project.updateMany({
          where: {
            id: bundle.command.projectId,
            workspaceId: bundle.command.workspaceId,
            currentVersionId: bundle.command.baseVersionId,
          },
          data: { currentVersionId: bundle.version.id },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during editorial command commit')
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
          include: { resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true },
        })
        return hydrateStoredCommand(stored, false)
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
        })
        if (existing) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different editorial command')
          }
          return Object.freeze({ ...existing.result, replayed: true })
        }
        throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial command collided with persisted immutable state')
      }
      throw error
    }
  }
}
