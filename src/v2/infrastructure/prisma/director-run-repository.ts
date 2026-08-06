import { randomUUID } from 'node:crypto'

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
import { requireEditCommandType } from '../../domain/edit-command-registry.ts'
import { DomainError } from '../../domain/errors.ts'
import type { StoryPlan } from '../../domain/story-plan.ts'
import type { TreatmentPlan } from '../../domain/treatment-plan.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { createDirectorRunInvalidations, parseDirectorRunImpact } from '../../domain/director-run-impact.ts'
import { parseCommandArtifactInvalidation } from '../../domain/command-impact.ts'
import { persistOperationStatusEvents } from './public-operation-repository.ts'
import {
  editCommandExternalActorAuditData,
  hydrateEditCommandExternalActorAudit,
} from './edit-command-actor-audit.ts'
import { hydrateExternalActorAudit } from './external-actor-audit.ts'
import {
  bindDirectorObjective,
  resolveStrategicObjective,
} from '../../domain/strategic-objective.ts'

const directorRunInclude = Prisma.validator<Prisma.V2DirectorRunInclude>()({
  command: { include: { artifactInvalidations: true } },
  resultVersion: { include: { briefSnapshot: true } },
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
  hydrateEditCommandExternalActorAudit(row.command)
  const payload = parseRecord(row.command.payloadJson, 'Director command payload') as unknown as RunDirectorCommandPayload
  const impact = parseDirectorRunImpact(payload.impact)
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
    type: requireEditCommandType(row.command.type),
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
  const brief = parseRecord(row.resultVersion.briefSnapshot.contentJson, 'Director brief')
  const decisions = validateDirectorDecisions(parseArray(row.decisionsJson, 'Director decisions') as unknown as DirectorRun['decisions'])
  const assumptions = Object.freeze(parseArray(row.assumptionsJson, 'Director assumptions').map((item) => String(item)))
  const objective = resolveStrategicObjective(row.objective)
  const previousObjective = resolveStrategicObjective(payload.previousObjective)
  validateDirectedEditPlan(editPlan)
  if (
    row.command.type !== 'run-director' || payload.schemaVersion !== 3 || payload.directorRunId !== row.id ||
    row.baseVersionId !== row.command.baseVersionId || row.resultVersionId !== version.id ||
    payload.objective !== objective.id || payload.objective !== row.objective ||
    payload.previousObjective !== previousObjective.id ||
    payload.objectiveVersion !== row.objectiveVersion ||
    !Number.isSafeInteger(row.objectiveVersion) || row.objectiveVersion < 1 ||
    payload.rubricRef !== row.rubricRef || row.rubricRef !== `${objective.rubricId}/v1` ||
    payload.supersedesRunId !== (row.supersedesRunId ?? undefined) ||
    impact.commandId !== row.command.id || impact.baseVersionId !== row.baseVersionId ||
    impact.resultVersionId !== row.resultVersionId || impact.sourceTranscriptId !== payload.sourceTranscriptId ||
    impact.plannerVersion !== payload.plannerVersion || impact.criticVersion !== payload.criticVersion ||
    payload.snapshotRefs.perception !== row.perceptionSnapshotId ||
    payload.snapshotRefs.treatment !== row.treatmentSnapshotId ||
    payload.snapshotRefs.story !== row.storySnapshotId ||
    payload.snapshotRefs.editPlan !== row.editPlanSnapshotId ||
    payload.snapshotRefs.quality !== row.qualitySnapshotId ||
    payload.snapshotRefs.brief !== version.snapshotRefs.brief ||
    brief.objective !== objective.id ||
    editPlan.projectVersionId !== version.id || editPlan.directorRunId !== row.id ||
    treatmentPlan.id !== editPlan.treatmentPlanId || storyPlan.id !== editPlan.storyPlanId ||
    treatmentPlan.objective !== objective.id || storyPlan.objective !== objective.id ||
    qualityReport.status === 'blocked' || row.initiatedByType !== 'api-client'
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored DirectorRun references are inconsistent')
  const run: DirectorRun = Object.freeze({
    schemaVersion: 2 as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    commandId: row.commandId,
    baseVersionId: row.baseVersionId,
    resultVersionId: row.resultVersionId,
    status: row.status as DirectorRun['status'],
    plannerVersion: row.plannerVersion,
    criticVersion: row.criticVersion,
    objective: objective.id,
    objectiveVersion: row.objectiveVersion,
    rubricRef: row.rubricRef,
    ...(row.supersedesRunId
      ? { supersedesRunId: row.supersedesRunId }
      : {}),
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
  const expectedInvalidations = createDirectorRunInvalidations({ impact, createdAt: row.command.createdAt.toISOString() })
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const invalidations = row.command.artifactInvalidations.map((item) => parseCommandArtifactInvalidation({
    schemaVersion: 'command-artifact-invalidation/v1', id: item.id, status: item.status,
    commandId: item.commandId, baseVersionId: item.baseVersionId,
    resultVersionId: item.resultVersionId, artifactId: item.artifactId,
    kind: item.kind, variantId: item.variantId,
    dependencyTypes: parseArray(item.dependencyTypesJson, 'Director invalidation dependencies'),
    affectedRanges: parseArray(item.affectedRangesJson, 'Director invalidation ranges'),
    impactHash: item.impactHash, createdAt: item.createdAt.toISOString(),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(expectedInvalidations) !== stableSerialize(invalidations)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director invalidations are inconsistent')
  }
  return Object.freeze({ run, command, version, impact, invalidations: Object.freeze(invalidations), replayed })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaDirectorRunRepository implements DirectorRunRepository {
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
    const key = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    }
    const command = await this.client.v2EditCommand.findUnique({
      where: { workspaceId_projectId_idempotencyKey: key },
      include: { directorRun: { include: directorRunInclude } },
    })
    if (!command) return null
    if (!command.directorRun) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotency key belongs to a different command type')
    if (
      hydrateEditCommandExternalActorAudit(command).contextHash !==
      input.actorContextHash
    ) throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Director idempotency key belongs to another authentication context',
    )
    return Object.freeze({ requestFingerprint: command.requestFingerprint, result: hydrateStoredRun(command.directorRun, true) })
  }

  async readContext(input: { workspaceId: string; projectId: string }): Promise<Readonly<DirectorRunContext> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: {
        currentVersion: { include: { briefSnapshot: true, editPlanSnapshot: true, policiesSnapshot: true } },
        mediaAssets: { where: { role: 'source-master' }, orderBy: { createdAt: 'desc' }, take: 1 },
        directorRuns: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          include: { qualitySnapshot: true },
        },
      },
    })
    const versionRow = project?.currentVersion
    const master = project?.mediaAssets[0]
    if (!project || !versionRow || !master) return null
    if (!project.objective || !project.format || !project.locale) throw new DomainError('PERSISTENCE_CONFLICT', 'Project direction metadata is incomplete')
    const projectObjective = resolveStrategicObjective(project.objective)
    const latestDirectorRun = project.directorRuns[0]
    const latestDirectorObjective = latestDirectorRun
      ? (() => {
          const storedObjective = resolveStrategicObjective(latestDirectorRun.objective)
          const quality = parseRecord(
            latestDirectorRun.qualitySnapshot.contentJson,
            'latest Director quality report',
          )
          if (
            latestDirectorRun.rubricRef !== `${storedObjective.rubricId}/v1` ||
            !Number.isSafeInteger(latestDirectorRun.objectiveVersion) ||
            latestDirectorRun.objectiveVersion < 1 ||
            !['approved', 'approved-with-warnings', 'blocked'].includes(String(quality.status))
          ) throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Latest Director objective evidence is invalid',
          )
          return Object.freeze({
            runId: latestDirectorRun.id,
            objective: storedObjective.id,
            objectiveVersion: latestDirectorRun.objectiveVersion,
            rubricRef: latestDirectorRun.rubricRef,
            ...(latestDirectorRun.supersedesRunId
              ? { supersedesRunId: latestDirectorRun.supersedesRunId }
              : {}),
            approved: ['approved', 'approved-with-warnings'].includes(
              String(quality.status),
            ),
          })
        })()
      : undefined
    const editPlan = parseRecord(versionRow.editPlanSnapshot.contentJson, 'current EditPlan') as unknown as EditorialCutEditPlan
    const retimedTranscript = editPlan.retimedTranscript as unknown
    if (typeof retimedTranscript !== 'object' || retimedTranscript === null || !('sourceTranscriptId' in retimedTranscript) || typeof retimedTranscript.sourceTranscriptId !== 'string') {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan has no valid transcript selection')
    }
    const transcriptRow = await this.client.v2MediaTranscript.findFirst({
      where: {
        id: retimedTranscript.sourceTranscriptId,
        projectId: project.id,
        workspaceId: project.workspaceId,
      },
    })
    if (!transcriptRow) return null
    if (master.artifactId !== transcriptRow.sourceArtifactId) throw new DomainError('PERSISTENCE_CONFLICT', 'Current transcript does not belong to the project source master')
    const planTranscriptHash = 'sourceTranscriptHash' in retimedTranscript
      ? String(retimedTranscript.sourceTranscriptHash)
      : undefined
    if (
      editPlan.schemaVersion !== 2 || editPlan.state !== 'compiled' ||
      editPlan.projectVersionId !== versionRow.id ||
      retimedTranscript.sourceTranscriptId !== transcriptRow.id ||
      (planTranscriptHash !== undefined && planTranscriptHash !== transcriptRow.transcriptHash)
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan is not aligned to the current transcript')
    const [proxyOutputs, finalOutputs] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: project.workspaceId, projectId: project.id, projectVersionId: versionRow.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: project.workspaceId, projectId: project.id, projectVersionId: versionRow.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    const currentDurationFrames = Number(editPlan.durationFrames)
    if (!Number.isSafeInteger(currentDurationFrames) || currentDurationFrames <= 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Current EditPlan duration is invalid')
    }
    return Object.freeze({
      workspaceId: project.workspaceId,
      project: Object.freeze({ id: project.id, objective: projectObjective.id, format: project.format, locale: project.locale }),
      ...(latestDirectorObjective ? { latestDirectorObjective } : {}),
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
      currentDurationFrames,
      proxyVariantId: project.format,
      outputReferences: Object.freeze([
        ...proxyOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: versionRow.id, variantId: project.format! })),
        ...finalOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: versionRow.id, variantId: output.outputAspectRatio })),
      ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))),
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
    const fenceNow = bundle.operationFence
      ? new Date(bundle.operationFence.now)
      : undefined
    if (bundle.operationFence && (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(bundle.operationFence.operationId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(bundle.operationFence.leaseOwner) ||
      !Number.isSafeInteger(bundle.operationFence.attempt) ||
      bundle.operationFence.attempt < 1 ||
      !fenceNow || Number.isNaN(fenceNow.getTime())
    )) throw new DomainError('PERSISTENCE_CONFLICT', 'Director operation fence is invalid')
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
          if (
            hydrateEditCommandExternalActorAudit(existing).contextHash !==
            bundle.authenticationAudit.contextHash
          ) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Director replay belongs to another authentication context')
          if (!existing.directorRun) throw new DomainError('PERSISTENCE_CONFLICT', 'Director idempotency result is missing')
          if (bundle.operationFence) {
            const settled = await transaction.v2PublicOperation.findFirst({
              where: {
                id: bundle.operationFence.operationId,
                workspaceId: bundle.command.workspaceId,
                projectId: bundle.command.projectId,
                type: 'project-director-run',
                status: 'succeeded',
                phase: 'completed',
                targetType: 'project-version',
                targetId: existing.directorRun.resultVersionId,
              },
              select: { id: true },
            })
            if (!settled || existing.directorRun.operationId !== settled.id) {
              throw new DomainError('PERSISTENCE_CONFLICT', 'Director replay is not bound to the settled operation')
            }
          }
          return hydrateStoredRun(existing.directorRun, true)
        }
        if (bundle.operationFence) {
          const origin = await transaction.v2PublicOperation.findFirst({
            where: {
              id: bundle.operationFence.operationId,
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              type: 'project-director-run',
              status: 'running',
              phase: 'directing',
              attempt: bundle.operationFence.attempt,
              leaseOwner: bundle.operationFence.leaseOwner,
              leaseExpiresAt: { gt: fenceNow! },
              targetType: 'project-version',
              targetId: bundle.version.id,
            },
            include: { projectDirectorRun: true },
          })
          const originContext = origin?.projectDirectorRun
          if (
            !origin ||
            !originContext ||
            originContext.baseVersionId !== bundle.command.baseVersionId ||
            originContext.baseHash !== bundle.command.baseHash ||
            originContext.baseObjective !== bundle.command.payload.previousObjective ||
            originContext.objective !== bundle.command.payload.objective ||
            originContext.objectiveVersion !== bundle.command.payload.objectiveVersion ||
            originContext.rubricRef !== bundle.command.payload.rubricRef ||
            (originContext.supersedesRunId ?? undefined) !== bundle.command.payload.supersedesRunId ||
            hydrateExternalActorAudit(origin, origin.clientId).contextHash !==
              bundle.authenticationAudit.contextHash
          ) throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Director worker provenance does not match its originating operation',
          )
          const enteredPersisting = await transaction.v2PublicOperation.updateMany({
            where: {
              id: bundle.operationFence.operationId,
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              type: 'project-director-run',
              status: 'running',
              phase: 'directing',
              attempt: bundle.operationFence.attempt,
              leaseOwner: bundle.operationFence.leaseOwner,
              leaseExpiresAt: { gt: fenceNow! },
              targetType: 'project-version',
              targetId: bundle.version.id,
            },
            data: {
              phase: 'persisting',
              progressCompleted: 1,
              progressTotal: 2,
              progressUnit: 'stage',
              updatedAt: fenceNow!,
            },
          })
          if (enteredPersisting.count !== 1) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Director operation lease was lost before commit')
          }
        }
        const [project, transcript, sourceMaster] = await Promise.all([
          transaction.v2Project.findFirst({
            where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId },
            include: {
              currentVersion: true,
              directorRuns: {
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 1,
                include: { qualitySnapshot: true },
              },
            },
          }),
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
        const targetObjective = resolveStrategicObjective(bundle.command.payload.objective)
        const latestRun = project.directorRuns[0]
        const latestQuality = latestRun
          ? parseRecord(latestRun.qualitySnapshot.contentJson, 'latest Director quality report')
          : undefined
        const objectiveBinding = bindDirectorObjective({
          objective: targetObjective.id,
          ...(latestRun
            ? {
                previous: {
                  runId: latestRun.id,
                  objective: resolveStrategicObjective(latestRun.objective).id,
                  objectiveVersion: latestRun.objectiveVersion,
                  rubricRef: latestRun.rubricRef,
                  ...(latestRun.supersedesRunId
                    ? { supersedesRunId: latestRun.supersedesRunId }
                    : {}),
                  approved: ['approved', 'approved-with-warnings'].includes(
                    String(latestQuality?.status),
                  ),
                },
              }
            : {}),
        })
        const changedObjective = targetObjective.id !== project.objective
        const briefSnapshotChanged =
          bundle.command.payload.snapshotRefs.brief !== project.currentVersion.briefSnapshotId
        const proposedBrief = bundle.snapshots.find(
          (item) => item.id === bundle.command.payload.snapshotRefs.brief,
        )
        if (
          project.objective !== bundle.command.payload.previousObjective ||
          bundle.run.objective !== targetObjective.id ||
          bundle.run.objectiveVersion !== objectiveBinding.objectiveVersion ||
          bundle.run.rubricRef !== objectiveBinding.rubricRef ||
          bundle.run.supersedesRunId !== objectiveBinding.supersedesRunId ||
          changedObjective !== briefSnapshotChanged ||
          (briefSnapshotChanged && proposedBrief?.kind !== 'brief')
        ) throw new DomainError(
          'VERSION_CONFLICT',
          'Project strategic objective changed before Director commit',
        )
        if (proposedBrief) {
          const brief = parseRecord(proposedBrief.contentJson, 'proposed Director brief')
          if (brief.objective !== targetObjective.id) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Director brief objective is inconsistent')
          }
        }
        if (
          project.currentVersion.id !== bundle.command.baseVersionId ||
          project.currentVersion.baseHash !== bundle.command.baseHash ||
          bundle.version.parentVersionId !== project.currentVersion.id ||
          bundle.version.sequence !== project.currentVersion.sequence + 1
        ) throw new DomainError('VERSION_CONFLICT', 'Project version changed before Director commit', { currentVersionId: project.currentVersion.id, currentBaseHash: project.currentVersion.baseHash })
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
          throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before Director impact commit')
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
            ...editCommandExternalActorAuditData(
              bundle.authenticationAudit,
              bundle.command.workspaceId,
              bundle.command.author,
            ),
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
          objective: bundle.run.objective,
          objectiveVersion: bundle.run.objectiveVersion,
          rubricRef: bundle.run.rubricRef,
          supersedesRunId: bundle.run.supersedesRunId,
          perceptionSnapshotId: refs.perception,
          treatmentSnapshotId: refs.treatment,
          storySnapshotId: refs.story,
          editPlanSnapshotId: refs.editPlan,
          qualitySnapshotId: refs.quality,
          decisionsJson: stableSerialize(bundle.run.decisions),
          assumptionsJson: stableSerialize(bundle.run.assumptions),
          initiatedByType: bundle.run.initiatedBy.type,
          initiatedById: bundle.run.initiatedBy.id,
          operationId: bundle.operationFence?.operationId,
          createdAt: new Date(bundle.run.createdAt),
        } })
        const invalidations = createDirectorRunInvalidations({ impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt })
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
            objective: bundle.command.payload.previousObjective,
          },
          data: {
            currentVersionId: bundle.version.id,
            objective: bundle.command.payload.objective,
          },
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
        if (bundle.operationFence) {
          const completedAt = new Date(bundle.operationFence.now)
          const settled = await transaction.v2PublicOperation.updateMany({
            where: {
              id: bundle.operationFence.operationId,
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              type: 'project-director-run',
              status: 'running',
              phase: 'persisting',
              attempt: bundle.operationFence.attempt,
              leaseOwner: bundle.operationFence.leaseOwner,
              leaseExpiresAt: { gt: completedAt },
              targetType: 'project-version',
              targetId: bundle.version.id,
            },
            data: {
              status: 'succeeded',
              phase: 'completed',
              progressCompleted: 2,
              progressTotal: 2,
              progressUnit: 'stage',
              cancelable: false,
              retryable: false,
              resultJson: stableSerialize({
                resource: { type: 'project-version', id: bundle.version.id },
              }),
              updatedAt: completedAt,
              completedAt,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              nextAttemptAt: null,
              deadLetteredAt: null,
            },
          })
          if (settled.count !== 1) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Director operation lease was lost during commit')
          }
          const settledOperation = await transaction.v2PublicOperation.findUnique({
            where: { id: bundle.operationFence.operationId },
            select: { clientId: true },
          })
          if (!settledOperation) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Settled Director operation disappeared during commit',
            )
          }
          await persistOperationStatusEvents(
            transaction,
            'running',
            {
              id: bundle.operationFence.operationId,
              workspaceId: bundle.command.workspaceId,
              projectId: bundle.command.projectId,
              clientId: settledOperation.clientId,
              type: 'project-director-run',
              status: 'succeeded',
              phase: 'completed',
              attempt: bundle.operationFence.attempt,
              updatedAt: bundle.operationFence.now,
            },
            randomUUID,
          )
        }
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
          actorContextHash: bundle.authenticationAudit.contextHash,
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
