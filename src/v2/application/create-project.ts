import { assertDomain } from '../domain/errors.ts'
import type { CommandActor } from '../domain/edit-command.ts'
import { createDesiredAction } from '../domain/desired-action.ts'
import {
  createOutputSpec,
  OUTPUT_PRESETS,
  type OutputAspectRatio,
} from '../domain/output-spec.ts'
import { createProject, normalizeProjectName } from '../domain/project.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createProductionBrief } from '../domain/production-brief.ts'
import {
  assertUniquePublicEventIds,
  createPublicEvent,
} from '../domain/public-event.ts'
import {
  resolveStrategicObjective,
  type StrategicObjectiveId,
} from '../domain/strategic-objective.ts'
import type {
  ProjectCreationRepository,
  ProjectCreationResult,
} from './ports/project-creation-repository.ts'
import { calculateVersionHash, stableSerialize } from './version-hash.ts'

export type ProjectEntityKind =
  | 'project'
  | 'project-version'
  | 'project-snapshot'
  | 'idempotency-record'

export interface CreateProjectRequest {
  workspaceId: string
  name: string
  objective: StrategicObjectiveId
  format: OutputAspectRatio
  locale?: string
  briefing?: string
  destination?: string
  actor: CommandActor
  idempotency: {
    clientId: string
    key: string
    ttlSeconds?: number
  }
}

export interface CreateProjectDependencies {
  repository: ProjectCreationRepository
  clock: () => Date
  createId: (kind: ProjectEntityKind) => string
  createEventId: () => string
}

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

export function createProjectService(dependencies: CreateProjectDependencies) {
  return async function execute(request: CreateProjectRequest): Promise<ProjectCreationResult> {
    const workspaceId = request.workspaceId.trim()
    const clientId = request.idempotency.clientId.trim()
    const idempotencyKey = request.idempotency.key.trim()
    const name = normalizeProjectName(request.name)
    const objective = resolveStrategicObjective(request.objective)
    const locale = request.locale?.trim() || 'pt-BR'
    const outputPreset = OUTPUT_PRESETS[request.format]
    assertDomain(Boolean(outputPreset), 'INVALID_OUTPUT_SPEC', 'Unsupported output format')
    const outputSpec = createOutputSpec({
      ...outputPreset,
      id: `output-${request.format.replace(':', 'x')}-${locale.toLowerCase()}`,
      locale,
    })
    const desiredAction = createDesiredAction({
      objective: objective.id,
      destination: request.destination,
    })
    const productionBrief = createProductionBrief({ ownerText: request.briefing })
    const ttlSeconds = request.idempotency.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS

    assertDomain(workspaceId.length > 0, 'INVALID_PROJECT', 'workspaceId is required')
    assertDomain(clientId.length > 0, 'INVALID_ARGUMENT', 'idempotency clientId is required')
    assertDomain(idempotencyKey.length > 0, 'INVALID_ARGUMENT', 'idempotency key is required')
    assertDomain(idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'idempotency key is too long')
    assertDomain(
      Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 7 * 24 * 60 * 60,
      'INVALID_ARGUMENT',
      'idempotency ttlSeconds must be between 60 seconds and 7 days',
    )

    const now = dependencies.clock()
    const createdAt = now.toISOString()
    const projectId = dependencies.createId('project')
    const versionId = dependencies.createId('project-version')
    const briefSnapshotId = dependencies.createId('project-snapshot')
    const editPlanSnapshotId = dependencies.createId('project-snapshot')
    const policiesSnapshotId = dependencies.createId('project-snapshot')

    const briefContent = {
      schemaVersion: 1,
      objective: objective.id,
      desiredAction,
      outputSpec,
      productionBrief,
      createdAt,
    }
    const editPlanContent = {
      schemaVersion: 2,
      state: 'uncompiled',
      id: `edit-plan-${versionId}`,
      projectVersionId: versionId,
      storyPlanId: null,
      fps: 30,
      durationFrames: 0,
      sources: [],
      videoTracks: [],
      overlayTracks: [],
      subtitleTracks: [],
      audioTracks: [],
      effectTracks: [],
      markers: [],
      protectedElements: [],
      localeVariantRefs: [],
      formatVariantRefs: [],
      lineageRefs: [],
      createdAt,
    }
    const policiesContent = {
      schemaVersion: 1,
      workspaceId,
      state: 'unconfigured',
      brandKitMode: 'inherit',
      guardrails: [],
      createdAt,
    }

    const briefJson = stableSerialize(briefContent)
    const editPlanJson = stableSerialize(editPlanContent)
    const policiesJson = stableSerialize(policiesContent)
    const briefHash = calculateVersionHash(briefContent)
    const editPlanHash = calculateVersionHash(editPlanContent)
    const policiesHash = calculateVersionHash(policiesContent)
    const versionHash = calculateVersionHash({
      projectId,
      sequence: 1,
      name,
      briefHash,
      editPlanHash,
      policiesHash,
    })

    const project = createProject({
      id: projectId,
      workspaceId,
      name,
      status: 'draft',
      objective: objective.id,
      format: request.format,
      locale,
      ownerId: request.actor.id,
      currentVersionId: versionId,
      createdBy: request.actor,
      createdAt,
    })
    const snapshots = [
      createProjectSnapshot({
        id: briefSnapshotId,
        workspaceId,
        projectId,
        kind: 'brief',
        contentSchemaVersion: 1,
        contentJson: briefJson,
        contentHash: briefHash,
        createdAt,
      }),
      createProjectSnapshot({
        id: editPlanSnapshotId,
        workspaceId,
        projectId,
        kind: 'edit-plan',
        contentSchemaVersion: 2,
        contentJson: editPlanJson,
        contentHash: editPlanHash,
        createdAt,
      }),
      createProjectSnapshot({
        id: policiesSnapshotId,
        workspaceId,
        projectId,
        kind: 'policies',
        contentSchemaVersion: 1,
        contentJson: policiesJson,
        contentHash: policiesHash,
        createdAt,
      }),
    ] as const
    const version = createProjectVersion({
      id: versionId,
      workspaceId,
      projectId,
      sequence: 1,
      snapshotRefs: {
        brief: briefSnapshotId,
        editPlan: editPlanSnapshotId,
        policies: policiesSnapshotId,
      },
      baseHash: versionHash,
      createdBy: request.actor.id,
      createdAt,
    })
    const eventActor = request.actor.type === 'api-client'
      ? {
          clientId: request.actor.id,
          ...(request.actor.delegatedUserId
            ? { userId: request.actor.delegatedUserId }
            : {}),
        }
      : request.actor.type === 'system'
        ? undefined
        : { userId: request.actor.id }
    const events = [
      createPublicEvent({
        id: dependencies.createEventId(),
        type: 'project.created',
        version: '1.0.0',
        workspaceId,
        occurredAt: createdAt,
        ...(eventActor ? { actor: eventActor } : {}),
        resource: { type: 'project', id: projectId },
        data: {
          name,
          status: project.status,
          objective: objective.id,
          format: request.format,
          locale,
          briefingSupplied: productionBrief.summary.supplied,
          currentVersionId: versionId,
          createdAt,
        },
      }),
      createPublicEvent({
        id: dependencies.createEventId(),
        type: 'project.version.created',
        version: '1.0.0',
        workspaceId,
        occurredAt: createdAt,
        sequence: version.sequence,
        ...(eventActor ? { actor: eventActor } : {}),
        resource: { type: 'project-version', id: versionId },
        data: {
          projectId,
          sequence: version.sequence,
          parentVersionId: null,
          baseHash: version.baseHash,
          snapshotRefs: version.snapshotRefs,
          createdAt,
        },
      }),
    ] as const
    assertUniquePublicEventIds(events)
    const requestFingerprint = calculateVersionHash({
      name,
      objective: objective.id,
      format: request.format,
      locale,
      briefing: productionBrief.ownerInput?.text ?? null,
      desiredAction,
    })

    return dependencies.repository.createOrReplay({
      project,
      version,
      snapshots,
      events,
      idempotency: {
        id: dependencies.createId('idempotency-record'),
        workspaceId,
        clientId,
        key: idempotencyKey,
        requestFingerprint,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      },
    })
  }
}
