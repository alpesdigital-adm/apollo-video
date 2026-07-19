import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  DirectorRunCommit,
  DirectorRunContext,
  DirectorRunRepository,
  DirectorRunResult,
} from '../../application/ports/director-run-repository.ts'
import type { EditorialCutEditPlan } from '../../application/apply-editorial-cut-command.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import {
  type DirectedEditPlan,
  type DirectorPerceptionSnapshot,
  type DirectorQualityReport,
  type DirectorRun,
  type RunDirectorCommandPayload,
  validateDirectedEditPlan,
  validateDirectorDecisions,
} from '../../domain/director-run.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import type { StoryPlan } from '../../domain/story-plan.ts'
import type { TreatmentPlan } from '../../domain/treatment-plan.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

const directorRunInclude = Prisma.validator<Prisma.V2DirectorRunInclude>()({
  command: true,
  resultVersion: true,
  perceptionSnapshot: true,
  treatmentSnapshot: true,
  storySnapshot: true,
  editPlanSnapshot: true,
  qualitySnapshot: true,
})

type StoredDirectorRun = Prisma.V2DirectorRunGetPayload<{ include: typeof directorRunInclude }>

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseArray(value: string, field: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function hydrateStoredRun(row: StoredDirectorRun, replayed: boolean): Readonly<DirectorRunResult> {
  const payload = parseRecord(row.command.payloadJson, 'Director command payload') as unknown as RunDirectorCommandPayload
  const scope = parseRecord(row.command.scopeJson, 'Director command scope') as EditScope
  const command = createEditCommand<RunDirectorCommandPayload>({
    id: row.command.id,
    workspaceId: row.command.workspaceId,
    projectId: row.command.projectId,
    baseVersionId: row.command.baseVersionId,
    baseHash: row.command.baseHash,
    author: {
      type: row.command.actorType as 'user' | 'director' | 'system' | 'api-client',
      id: row.command.actorId,
      ...(row.command.delegatedUserId ? { delegatedUserId: row.command.delegatedUserId } : {}),
    },
    type: row.command.type,
    scope,
    payload,
    ...(row.command.reason ? { reason: row.command.reason } : {}),
    idempotencyKey: row.command.idempotencyKey,
    createdAt: row.command.createdAt.toISOString(),
  })
  const version = createProjectVersion({
    id: row.resultVersion.id,
    workspaceId: row.resultVersion.workspaceId,
    projectId: row.resultVersion.projectId,
    sequence: row.resultVersion.sequence,
    parentVersionId: row.resultVersion.parentVersionId ?? undefined,
    snapshotRefs: {
      brief: row.resultVersion.briefSnapshotId,
      treatment: row.resultVersion.treatmentSnapshotId ?? undefined,
      story: row.resultVersion.storySnapshotId ?? undefined,
      editPlan: row.resultVersion.editPlanSnapshotId,
      policies: row.resultVersion.policiesSnapshotId,
    },
    baseHash: row.resultVersion.baseHash,
    createdBy: row.resultVersion.createdBy,
    commandId: row.resultVersion.commandId ?? undefined,
    createdAt: row.resultVersion.createdAt.toISOString(),
  })
  const perception = parseRecord(row.perceptionSnapshot.contentJson, 'Director perception') as unknown as DirectorPerceptionSnapshot
  const treatmentPlan = parseRecord(row.treatmentSnapshot.contentJson, 'TreatmentPlan') as unknown as TreatmentPlan & { id: string }
  const storyPlan = parseRecord(row.storySnapshot.contentJson, 'StoryPlan') as unknown as StoryPlan & { id: string }
  const editPlan = parseRecord(row.editPlanSnapshot.contentJson, 'Director EditPlan') as unknown as DirectedEditPlan
  const qualityReport = parseRecord(row.qualitySnapshot.contentJson, 'Director quality report') as unknown as DirectorQualityReport
  const decisions = validateDirectorDecisions(parseArray(row.decisionsJson, 'Director decisions') as unknown as DirectorRun['decisions'])
  const assumptions = Object.freeze(parseArray(row.assumptionsJson, 'Director assumptions').map((item) => String(item)))
  validateDirectedEditPlan(editPlan)
  if (
    row.command.type !== 'run-director' || payload.schemaVersion !== 1 || payload.directorRunId !== row.id ||
    row.baseVersionId !== row.command.baseVersionId || row.resultVersionId !== version.id ||
    payload.snapshotRefs.perception !== row.perceptionSnapshotId ||
    payload.snapshotRefs.treatment !== row.treatmentSnapshotId ||
    payload.snapshotRefs.story !== row.storySnapshotId ||
    payload.snapshotRefs.editPlan !== row.editPlanSnapshotId ||
    payload.snapshotRefs.quality !== row.qualitySnapshotId ||
    editPlan.projectVersionId !== version.id || editPlan.directorRunId !== row.id ||
    treatmentPlan.id !== editPlan.treatmentPlanId || storyPlan.id !== editPlan.storyPlanId ||
    qualityReport.status === 'blocked' || row.initiatedByType !== 'api-client'
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored DirectorRun references are inconsistent')
  const run: DirectorRun = Object.freeze({
    schemaVersion: 1 as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    commandId: row.commandId,
    baseVersionId: row.baseVersionId,
    resultVersionId: row.resultVersionId,
    status: row.status as DirectorRun['status'],
    plannerVersion: row.plannerVersion,
    criticVersion: row.criticVersion,
    perception: Object.freeze(perception),
    treatmentPlan: Object.freeze(treatmentPlan),
    storyPlan: Object.freeze(storyPlan),
    editPlan: Object.freeze(editPlan),
    qualityReport: Object.freeze(qualityReport),
    decisions,
    assumptions,
    initiatedBy: Object.freeze({ type: 'api-client' as const, id: row.initiatedById }),
    createdAt: row.createdAt.toISOString(),
  })
  return Object.freeze({ run, command, version, replayed })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaDirectorRunRepository implements DirectorRunRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async findIdempotentResult(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const command = await this.client.v2EditCommand.findUnique({
      where: { workspaceId_projectId_idempotencyKey: input },
      include: { directorRun: { include: directorRunInclude } },
    })
    if (!command) return null
    if (!command.directorRun) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotency key belongs to a different command type')
    return Object.freeze({ requestFingerprint: command.requestFingerprint, result: hydrateStoredRun(command.directorRun, true) })
  }

  async readContext(input: { workspaceId: string; projectId: string }): Promise<Readonly<DirectorRunContext> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: {
        currentVersion: { include: { briefSnapshot: true, editPlanSnapshot: true, policiesSnapshot: true } },
        mediaTranscripts: { orderBy: { createdAt: 'desc' }, take: 1 },
        mediaAssets: { where: { role: 'source-master' }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    const versionRow = project?.currentVersion
    const transcriptRow = project?.mediaTranscripts[0]
    const master = project?.mediaAssets[0]
    if (!project || !versionRow || !transcriptRow || !master) return null
    if (master.artifactId !== transcriptRow.sourceArtifactId) throw new DomainError('PERSISTENCE_CONFLICT', 'Current transcript does not belong to the project source master')
    if (!project.objective || !project.format || !project.locale) throw new DomainError('PERSISTENCE_CONFLICT', 'Project direction metadata is incomplete')
    const editPlan = parseRecord(versionRow.editPlanSnapshot.contentJson, 'current EditPlan') as unknown as EditorialCutEditPlan
    if (
      editPlan.schemaVersion !== 2 || editPlan.state !== 'compiled' ||
      editPlan.projectVersionId !== versionRow.id ||
      editPlan.retimedTranscript.sourceTranscriptId !== transcriptRow.id
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan is not aligned to the current transcript')
    return Object.freeze({
      workspaceId: project.workspaceId,
      project: Object.freeze({ id: project.id, objective: project.objective, format: project.format, locale: project.locale }),
      currentVersion: createProjectVersion({
        id: versionRow.id,
        workspaceId: versionRow.workspaceId,
        projectId: versionRow.projectId,
        sequence: versionRow.sequence,
        parentVersionId: versionRow.parentVersionId ?? undefined,
        snapshotRefs: {
          brief: versionRow.briefSnapshotId,
          treatment: versionRow.treatmentSnapshotId ?? undefined,
          story: versionRow.storySnapshotId ?? undefined,
          editPlan: versionRow.editPlanSnapshotId,
          policies: versionRow.policiesSnapshotId,
        },
        baseHash: versionRow.baseHash,
        createdBy: versionRow.createdBy,
        commandId: versionRow.commandId ?? undefined,
        createdAt: versionRow.createdAt.toISOString(),
      }),
      brief: Object.freeze(parseRecord(versionRow.briefSnapshot.contentJson, 'project brief')),
      policies: Object.freeze(parseRecord(versionRow.policiesSnapshot.contentJson, 'project policies')),
      editPlan: Object.freeze(editPlan),
      transcript: Object.freeze({
        id: transcriptRow.id,
        sourceArtifactId: transcriptRow.sourceArtifactId,
        language: transcriptRow.language,
        provider: transcriptRow.provider,
        model: transcriptRow.model,
        transcriptHash: transcriptRow.transcriptHash,
      }),
    })
  }

  async commitOrReplay(bundle: DirectorRunCommit, serializationAttempt = 1): Promise<Readonly<DirectorRunResult>> {
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
          include: { directorRun: { include: directorRunInclude } },
        })
        if (existing) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with different Director input')
          if (!existing.directorRun) throw new DomainError('PERSISTENCE_CONFLICT', 'Director idempotency result is missing')
          return hydrateStoredRun(existing.directorRun, true)
        }
        const [project, transcript, sourceMaster] = await Promise.all([
          transaction.v2Project.findFirst({ where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId }, include: { currentVersion: true } }),
          transaction.v2MediaTranscript.findFirst({ where: {
            id: bundle.sourceEvidence.transcriptId,
            projectId: bundle.command.projectId,
            workspaceId: bundle.command.workspaceId,
            sourceArtifactId: bundle.sourceEvidence.sourceArtifactId,
            transcriptHash: bundle.sourceEvidence.transcriptHash,
          } }),
          transaction.v2ProjectMediaAsset.findFirst({ where: {
            projectId: bundle.command.projectId,
            workspaceId: bundle.command.workspaceId,
            artifactId: bundle.sourceEvidence.sourceArtifactId,
            role: 'source-master',
          } }),
        ])
        if (!project?.currentVersion || !transcript || !sourceMaster) throw new DomainError('PERSISTENCE_CONFLICT', 'Director source evidence disappeared before commit')
        if (
          project.currentVersion.id !== bundle.command.baseVersionId ||
          project.currentVersion.baseHash !== bundle.command.baseHash ||
          bundle.version.parentVersionId !== project.currentVersion.id ||
          bundle.version.sequence !== project.currentVersion.sequence + 1
        ) throw new DomainError('VERSION_CONFLICT', 'Project version changed before Director commit', { currentVersionId: project.currentVersion.id, currentBaseHash: project.currentVersion.baseHash })
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
        for (const item of bundle.snapshots) {
          await transaction.v2ProjectSnapshot.create({ data: {
            id: item.id, workspaceId: item.workspaceId, projectId: item.projectId,
            kind: item.kind, schemaVersion: item.contentSchemaVersion,
            contentJson: item.contentJson, contentHash: item.contentHash,
            createdAt: new Date(item.createdAt),
          } })
        }
        await transaction.v2ProjectVersion.create({ data: {
          id: bundle.version.id,
          workspaceId: bundle.version.workspaceId,
          projectId: bundle.version.projectId,
          sequence: bundle.version.sequence,
          parentVersionId: bundle.version.parentVersionId,
          briefSnapshotId: bundle.version.snapshotRefs.brief!,
          treatmentSnapshotId: bundle.version.snapshotRefs.treatment!,
          storySnapshotId: bundle.version.snapshotRefs.story!,
          editPlanSnapshotId: bundle.version.snapshotRefs.editPlan,
          policiesSnapshotId: bundle.version.snapshotRefs.policies,
          baseHash: bundle.version.baseHash,
          createdBy: bundle.version.createdBy,
          commandId: bundle.command.id,
          createdAt: new Date(bundle.version.createdAt),
        } })
        const refs = bundle.command.payload.snapshotRefs
        await transaction.v2DirectorRun.create({ data: {
          id: bundle.run.id,
          workspaceId: bundle.run.workspaceId,
          projectId: bundle.run.projectId,
          commandId: bundle.run.commandId,
          baseVersionId: bundle.run.baseVersionId,
          resultVersionId: bundle.run.resultVersionId,
          status: bundle.run.status,
          plannerVersion: bundle.run.plannerVersion,
          criticVersion: bundle.run.criticVersion,
          perceptionSnapshotId: refs.perception,
          treatmentSnapshotId: refs.treatment,
          storySnapshotId: refs.story,
          editPlanSnapshotId: refs.editPlan,
          qualitySnapshotId: refs.quality,
          decisionsJson: stableSerialize(bundle.run.decisions),
          assumptionsJson: stableSerialize(bundle.run.assumptions),
          initiatedByType: bundle.run.initiatedBy.type,
          initiatedById: bundle.run.initiatedBy.id,
          createdAt: new Date(bundle.run.createdAt),
        } })
        const updated = await transaction.v2Project.updateMany({
          where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId, currentVersionId: bundle.command.baseVersionId },
          data: { currentVersionId: bundle.version.id },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during Director commit')
        await transaction.v2PublicEventOutbox.create({ data: {
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
        } })
        const stored = await transaction.v2DirectorRun.findUniqueOrThrow({ where: { id: bundle.run.id }, include: directorRunInclude })
        return hydrateStoredRun(stored, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) return this.commitOrReplay(bundle, serializationAttempt + 1)
      if (isPrismaCode(error, 'P2002')) {
        const existing = await this.findIdempotentResult({
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          idempotencyKey: bundle.command.idempotencyKey,
        })
        if (existing) {
          if (existing.requestFingerprint !== bundle.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with different Director input')
          return Object.freeze({ ...existing.result, replayed: true })
        }
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director commit collided with immutable state')
      }
      throw error
    }
  }
}
