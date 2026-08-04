import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  SourceTranscriptReplacementCommit,
  SourceTranscriptReplacementPayload,
  SourceTranscriptReplacementRepository,
  SourceTranscriptReplacementResult,
} from '../../application/ports/source-transcript-replacement-repository.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import {
  createSourceTranscriptArtifactInvalidations,
  parseSourceTranscriptReplacementImpact,
} from '../../domain/source-transcript-replacement.ts'
import { parseCommandArtifactInvalidation } from '../../domain/command-impact.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  editCommandExternalActorAuditData,
  hydrateEditCommandExternalActorAudit,
} from './edit-command-actor-audit.ts'

type StoredCommand = Prisma.V2EditCommandGetPayload<{
  include: {
    baseVersion: { include: { editPlanSnapshot: true } }
    resultVersion: { include: { editPlanSnapshot: true } }
    artifactInvalidations: true
  }
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

function hydrateTranscript(row: {
  transcriptJson: string
  transcriptHash: string
}) {
  const value = parseRecord(row.transcriptJson, 'media transcript') as unknown as {
    language: string
    text: string
    words: { word: string; start: number; end: number }[]
    segments: { id: number; start: number; end: number; text: string; confidence?: number }[]
    provider: string
    model: string
  }
  const transcript = createMediaTranscript(value)
  if (transcript.transcriptHash !== row.transcriptHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored transcript hash is inconsistent')
  return transcript
}

function version(row: NonNullable<StoredCommand['resultVersion']>) {
  return createProjectVersion({
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId,
    sequence: row.sequence, parentVersionId: row.parentVersionId ?? undefined,
    snapshotRefs: {
      brief: row.briefSnapshotId,
      treatment: row.treatmentSnapshotId ?? undefined,
      story: row.storySnapshotId ?? undefined,
      editPlan: row.editPlanSnapshotId,
      policies: row.policiesSnapshotId,
    },
    baseHash: row.baseHash, createdBy: row.createdBy,
    commandId: row.commandId ?? undefined, createdAt: row.createdAt.toISOString(),
  })
}

function hydrateStoredCommand(row: StoredCommand, replayed: boolean): SourceTranscriptReplacementResult {
  hydrateEditCommandExternalActorAudit(row)
  if (row.type !== 'replace-source-transcript' || !row.resultVersion) throw new DomainError('PERSISTENCE_CONFLICT', 'Source transcript replacement result is missing')
  const payload = parseRecord(row.payloadJson, 'source transcript replacement payload') as unknown as SourceTranscriptReplacementPayload
  const impact = parseSourceTranscriptReplacementImpact(payload.impact)
  if (
    payload.schemaVersion !== 1 || payload.action !== 'replace-source-transcript' ||
    payload.nextRequiredCapability !== 'apollo.projects.commands.apply:run-director' ||
    impact.commandId !== row.id || impact.baseVersionId !== row.baseVersionId ||
    impact.resultVersionId !== row.resultVersion.id
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored source transcript replacement payload is inconsistent')
  const command = createEditCommand<SourceTranscriptReplacementPayload>({
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId,
    baseVersionId: row.baseVersionId, baseHash: row.baseHash,
    author: {
      type: row.actorType as 'user' | 'director' | 'system' | 'api-client', id: row.actorId,
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
    },
    type: row.type, scope: parseRecord(row.scopeJson, 'source transcript replacement scope') as EditScope,
    payload, ...(row.reason ? { reason: row.reason } : {}),
    idempotencyKey: row.idempotencyKey, createdAt: row.createdAt.toISOString(),
  })
  const expectedInvalidations = createSourceTranscriptArtifactInvalidations({ impact, createdAt: row.createdAt.toISOString() })
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const storedInvalidations = row.artifactInvalidations.map((item) => parseCommandArtifactInvalidation({
    schemaVersion: 'command-artifact-invalidation/v1', id: item.id, status: item.status,
    commandId: item.commandId, baseVersionId: item.baseVersionId,
    resultVersionId: item.resultVersionId, artifactId: item.artifactId,
    kind: item.kind, variantId: item.variantId,
    dependencyTypes: parseArray(item.dependencyTypesJson, 'source transcript invalidation dependencies'),
    affectedRanges: parseArray(item.affectedRangesJson, 'source transcript invalidation ranges'),
    impactHash: item.impactHash, createdAt: item.createdAt.toISOString(),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(expectedInvalidations) !== stableSerialize(storedInvalidations)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored source transcript invalidations are inconsistent')
  const editPlan = Object.freeze(parseRecord(row.resultVersion.editPlanSnapshot.contentJson, 'source transcript replacement EditPlan'))
  const retimedTranscript = editPlan.retimedTranscript as Record<string, unknown> | undefined
  if (
    editPlan.projectVersionId !== row.resultVersion.id ||
    retimedTranscript?.sourceTranscriptId !== payload.replacementTranscriptId ||
    retimedTranscript.sourceTranscriptHash !== payload.replacementTranscriptHash
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored replacement EditPlan is inconsistent')
  return Object.freeze({ command, version: version(row.resultVersion), editPlan, impact, invalidations: Object.freeze(storedInvalidations), replayed })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaSourceTranscriptReplacementRepository implements SourceTranscriptReplacementRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async findIdempotentResult(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string }) {
    const row = await this.client.v2EditCommand.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { baseVersion: { include: { editPlanSnapshot: true } }, resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true },
    })
    if (!row) return null
    if (row.type !== 'replace-source-transcript') throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another command type')
    if (hydrateEditCommandExternalActorAudit(row).contextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Transcript replacement replay belongs to another authentication context')
    return Object.freeze({ requestFingerprint: row.requestFingerprint, result: hydrateStoredCommand(row, true) })
  }

  async readContext(input: { workspaceId: string; projectId: string; replacementTranscriptId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: { include: { editPlanSnapshot: true } } },
    })
    if (!project?.currentVersion) return null
    const editPlan = parseRecord(project.currentVersion.editPlanSnapshot.contentJson, 'current EditPlan')
    const currentTranscriptId = (editPlan.retimedTranscript as Record<string, unknown> | undefined)?.sourceTranscriptId
    if (typeof currentTranscriptId !== 'string') throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan has no source transcript identity')
    const [current, replacement, proxyOutputs, finalOutputs] = await Promise.all([
      this.client.v2MediaTranscript.findFirst({ where: { id: currentTranscriptId, workspaceId: input.workspaceId, projectId: input.projectId } }),
      this.client.v2MediaTranscript.findFirst({ where: { id: input.replacementTranscriptId, workspaceId: input.workspaceId, projectId: input.projectId } }),
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    if (!current || !replacement) return null
    const selectedTranscriptHash = (editPlan.retimedTranscript as Record<string, unknown>).sourceTranscriptHash
    if (selectedTranscriptHash !== undefined && selectedTranscriptHash !== current.transcriptHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan transcript hash is inconsistent')
    }
    const currentVersion = createProjectVersion({
      id: project.currentVersion.id, workspaceId: project.currentVersion.workspaceId,
      projectId: project.currentVersion.projectId, sequence: project.currentVersion.sequence,
      parentVersionId: project.currentVersion.parentVersionId ?? undefined,
      snapshotRefs: {
        brief: project.currentVersion.briefSnapshotId,
        treatment: project.currentVersion.treatmentSnapshotId ?? undefined,
        story: project.currentVersion.storySnapshotId ?? undefined,
        editPlan: project.currentVersion.editPlanSnapshotId,
        policies: project.currentVersion.policiesSnapshotId,
      },
      baseHash: project.currentVersion.baseHash, createdBy: project.currentVersion.createdBy,
      commandId: project.currentVersion.commandId ?? undefined,
      createdAt: project.currentVersion.createdAt.toISOString(),
    })
    return Object.freeze({
      currentVersion, editPlan: Object.freeze(editPlan), editPlanHash: project.currentVersion.editPlanSnapshot.contentHash,
      currentTranscript: Object.freeze({ id: current.id, transcriptHash: current.transcriptHash, sourceArtifactId: current.sourceArtifactId }),
      replacementTranscript: Object.freeze({
        id: replacement.id, transcriptHash: replacement.transcriptHash,
        sourceArtifactId: replacement.sourceArtifactId, transcript: hydrateTranscript(replacement),
      }),
      outputReferences: Object.freeze([
        ...proxyOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: currentVersion.id, variantId: project.format ?? '9:16' })),
        ...finalOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: currentVersion.id, variantId: output.outputAspectRatio })),
      ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))),
    })
  }

  async commitOrReplay(bundle: SourceTranscriptReplacementCommit, serializationAttempt = 1): Promise<Readonly<SourceTranscriptReplacementResult>> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const key = { workspaceId_projectId_idempotencyKey: {
          workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, idempotencyKey: bundle.command.idempotencyKey,
        } }
        const existing = await transaction.v2EditCommand.findUnique({
          where: key,
          include: { baseVersion: { include: { editPlanSnapshot: true } }, resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true },
        })
        if (existing) {
          if (existing.type !== 'replace-source-transcript' || existing.requestFingerprint !== bundle.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different source transcript replacement')
          if (hydrateEditCommandExternalActorAudit(existing).contextHash !== bundle.authenticationAudit.contextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Transcript replacement replay belongs to another authentication context')
          return hydrateStoredCommand(existing, true)
        }
        const [project, currentTranscript, replacementTranscript] = await Promise.all([
          transaction.v2Project.findFirst({ where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId }, include: { currentVersion: { include: { editPlanSnapshot: true } } } }),
          transaction.v2MediaTranscript.findFirst({ where: { id: bundle.sourceEvidence.currentTranscriptId, workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, transcriptHash: bundle.sourceEvidence.currentTranscriptHash, sourceArtifactId: bundle.sourceEvidence.sourceArtifactId } }),
          transaction.v2MediaTranscript.findFirst({ where: { id: bundle.sourceEvidence.replacementTranscriptId, workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, transcriptHash: bundle.sourceEvidence.replacementTranscriptHash, sourceArtifactId: bundle.sourceEvidence.sourceArtifactId } }),
        ])
        if (!project?.currentVersion || !currentTranscript || !replacementTranscript) throw new DomainError('PERSISTENCE_CONFLICT', 'Source transcript evidence disappeared before commit')
        if (
          project.currentVersion.id !== bundle.command.baseVersionId ||
          project.currentVersion.baseHash !== bundle.command.baseHash ||
          bundle.version.parentVersionId !== project.currentVersion.id ||
          bundle.version.sequence !== project.currentVersion.sequence + 1
        ) throw new DomainError('VERSION_CONFLICT', 'Project changed before source transcript replacement commit')
        const currentPlan = parseRecord(project.currentVersion.editPlanSnapshot.contentJson, 'current EditPlan')
        const currentRetimedTranscript = currentPlan.retimedTranscript as Record<string, unknown> | undefined
        if (
          currentRetimedTranscript?.sourceTranscriptId !== currentTranscript.id ||
          (currentRetimedTranscript.sourceTranscriptHash !== undefined && currentRetimedTranscript.sourceTranscriptHash !== currentTranscript.transcriptHash)
        ) throw new DomainError('VERSION_CONFLICT', 'Current EditPlan transcript changed before commit')
        const [proxyOutputs, finalOutputs] = await Promise.all([
          transaction.v2ProjectProxyRenderOperation.findMany({ where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } }, select: { outputArtifactId: true } }),
          transaction.v2ProjectFinalExportOperation.findMany({ where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } }, select: { outputArtifactId: true, outputAspectRatio: true } }),
        ])
        const currentOutputs = [
          ...proxyOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: bundle.command.baseVersionId, variantId: project.format ?? '9:16' })),
          ...finalOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: bundle.command.baseVersionId, variantId: output.outputAspectRatio })),
        ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
        if (stableSerialize(currentOutputs) !== stableSerialize(bundle.command.payload.impact.affectedArtifacts)) throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before source transcript impact commit')
        await transaction.v2EditCommand.create({ data: {
          id: bundle.command.id, workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId,
          baseVersionId: bundle.command.baseVersionId, baseHash: bundle.command.baseHash,
          type: bundle.command.type, scopeJson: stableSerialize(bundle.command.scope), payloadJson: stableSerialize(bundle.command.payload),
          reason: bundle.command.reason, actorType: bundle.command.author.type, actorId: bundle.command.author.id,
          delegatedUserId: bundle.command.author.delegatedUserId, idempotencyKey: bundle.command.idempotencyKey,
          ...editCommandExternalActorAuditData(bundle.authenticationAudit, bundle.command.workspaceId, bundle.command.author),
          requestFingerprint: bundle.requestFingerprint, createdAt: new Date(bundle.command.createdAt),
        } })
        await transaction.v2ProjectSnapshot.create({ data: {
          id: bundle.snapshot.id, workspaceId: bundle.snapshot.workspaceId, projectId: bundle.snapshot.projectId,
          kind: bundle.snapshot.kind, schemaVersion: bundle.snapshot.contentSchemaVersion,
          contentJson: bundle.snapshot.contentJson, contentHash: bundle.snapshot.contentHash,
          createdAt: new Date(bundle.snapshot.createdAt),
        } })
        await transaction.v2ProjectVersion.create({ data: {
          id: bundle.version.id, workspaceId: bundle.version.workspaceId, projectId: bundle.version.projectId,
          sequence: bundle.version.sequence, parentVersionId: bundle.version.parentVersionId,
          briefSnapshotId: bundle.version.snapshotRefs.brief!, treatmentSnapshotId: bundle.version.snapshotRefs.treatment,
          storySnapshotId: bundle.version.snapshotRefs.story, editPlanSnapshotId: bundle.version.snapshotRefs.editPlan,
          policiesSnapshotId: bundle.version.snapshotRefs.policies, baseHash: bundle.version.baseHash,
          createdBy: bundle.version.createdBy, commandId: bundle.command.id, createdAt: new Date(bundle.version.createdAt),
        } })
        const invalidations = createSourceTranscriptArtifactInvalidations({ impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt })
        if (invalidations.length > 0) await transaction.v2CommandArtifactInvalidation.createMany({ data: invalidations.map((item) => ({
          id: item.id, workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId,
          commandId: item.commandId, baseVersionId: item.baseVersionId, resultVersionId: item.resultVersionId,
          artifactId: item.artifactId, kind: item.kind, variantId: item.variantId, status: item.status,
          dependencyTypesJson: stableSerialize(item.dependencyTypes), affectedRangesJson: stableSerialize(item.affectedRanges),
          impactHash: item.impactHash, createdAt: new Date(item.createdAt),
        })) })
        const updated = await transaction.v2Project.updateMany({
          where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId, currentVersionId: bundle.command.baseVersionId },
          data: { currentVersionId: bundle.version.id },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during source transcript replacement')
        await transaction.v2PublicEventOutbox.create({ data: {
          id: bundle.event.id, workspaceId: bundle.event.workspaceId, type: bundle.event.type,
          version: bundle.event.version, occurredAt: new Date(bundle.event.occurredAt), sequence: bundle.event.sequence,
          actorClientId: bundle.event.actor?.clientId, actorUserId: bundle.event.actor?.userId,
          resourceType: bundle.event.resource.type, resourceId: bundle.event.resource.id,
          dataJson: stableSerialize(bundle.event.data),
        } })
        const stored = await transaction.v2EditCommand.findUniqueOrThrow({
          where: { id: bundle.command.id },
          include: { baseVersion: { include: { editPlanSnapshot: true } }, resultVersion: { include: { editPlanSnapshot: true } }, artifactInvalidations: true },
        })
        return hydrateStoredCommand(stored, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) return this.commitOrReplay(bundle, serializationAttempt + 1)
      if (isPrismaCode(error, 'P2002')) {
        const existing = await this.findIdempotentResult({ workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, idempotencyKey: bundle.command.idempotencyKey, actorContextHash: bundle.authenticationAudit.contextHash })
        if (existing) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different source transcript replacement')
          return Object.freeze({ ...existing.result, replayed: true })
        }
        throw new DomainError('PERSISTENCE_CONFLICT', 'Source transcript replacement collided with immutable persisted state')
      }
      throw error
    }
  }
}
