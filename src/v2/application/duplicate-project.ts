import { assertDomain, DomainError } from '../domain/errors.ts'
import type { CommandActor } from '../domain/edit-command.ts'
import { createProjectCreationCommand } from '../domain/project-creation-command.ts'
import { createProject, normalizeProjectName } from '../domain/project.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type {
  ProjectDuplicationRepository,
  ProjectDuplicationResult,
} from './ports/project-duplication-repository.ts'
import { calculateVersionHash } from './version-hash.ts'

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60
const SHA_256_PATTERN = /^[a-f0-9]{64}$/

export function duplicateProjectService(dependencies: {
  repository: ProjectDuplicationRepository
  clock: () => Date
  createId: (
    kind: 'project' | 'project-version' | 'project-media-asset' |
      'project-creation-command' | 'idempotency-record',
  ) => string
}) {
  return async function duplicate(request: {
    workspaceId: string
    projectId: string
    expectedVersionId: string
    expectedVersionHash: string
    name?: string
    actor: AuthenticatedExternalActor
    idempotency: Readonly<{
      clientId: string
      key: string
      ttlSeconds?: number
    }>
  }): Promise<Readonly<ProjectDuplicationResult>> {
    const workspaceId = request.workspaceId.trim()
    const projectId = request.projectId.trim()
    const expectedVersionId = request.expectedVersionId.trim()
    const clientId = request.idempotency.clientId.trim()
    const key = request.idempotency.key.trim()
    const ttlSeconds =
      request.idempotency.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    const commandActor: Readonly<CommandActor> = audit.delegatedUserId
      ? { type: 'api-client', id: audit.clientId, delegatedUserId: audit.delegatedUserId }
      : { type: 'api-client', id: audit.clientId }
    assertDomain(workspaceId.length > 0, 'INVALID_ARGUMENT', 'workspaceId is required')
    assertDomain(projectId.length > 0, 'INVALID_ARGUMENT', 'projectId is required')
    assertDomain(
      expectedVersionId.length > 0,
      'INVALID_ARGUMENT',
      'expectedVersionId is required',
    )
    assertDomain(
      SHA_256_PATTERN.test(request.expectedVersionHash),
      'INVALID_ARGUMENT',
      'expectedVersionHash must be SHA-256',
    )
    assertDomain(
      audit.workspaceId === workspaceId && audit.clientId === clientId,
      'AUTH_INVALID',
      'Project duplication actor must match the authenticated workspace and client',
    )
    assertDomain(
      key.length >= 1 && key.length <= 128,
      'INVALID_ARGUMENT',
      'idempotency key must contain 1-128 characters',
    )
    assertDomain(
      Number.isSafeInteger(ttlSeconds) &&
        ttlSeconds >= 60 &&
        ttlSeconds <= 7 * 24 * 60 * 60,
      'INVALID_ARGUMENT',
      'idempotency ttlSeconds must be between 60 seconds and 7 days',
    )
    const requestedName = request.name === undefined
      ? null
      : normalizeProjectName(request.name)
    const requestFingerprint = calculateVersionHash({
      schemaVersion: 'project-duplication-request/v1',
      workspaceId,
      sourceProjectId: projectId,
      sourceVersionId: expectedVersionId,
      sourceVersionHash: request.expectedVersionHash,
      requestedName,
      actorContextHash: audit.contextHash,
    })
    const existing = await dependencies.repository.findIdempotent({
      workspaceId,
      clientId,
      key,
      requestFingerprint,
      audit,
    })
    if (existing) return existing

    const source = await dependencies.repository.readSource({
      workspaceId,
      projectId,
    })
    if (!source) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Source project was not found')
    }
    if (
      source.version.id !== expectedVersionId ||
      source.version.baseHash !== request.expectedVersionHash ||
      source.project.currentVersionId !== expectedVersionId
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Source project version changed before duplication',
        {
          currentVersionId: source.version.id,
          currentVersionHash: source.version.baseHash,
        },
      )
    }
    const createdAtDate = dependencies.clock()
    const createdAt = createdAtDate.toISOString()
    const duplicateProjectId = dependencies.createId('project')
    const duplicateVersionId = dependencies.createId('project-version')
    const name = requestedName ?? normalizeProjectName(
      `${source.project.name} (cópia)`,
    )
    const project = createProject({
      id: duplicateProjectId,
      workspaceId,
      name,
      status: 'draft',
      ...(source.project.objective
        ? { objective: source.project.objective }
        : {}),
      ...(source.project.format ? { format: source.project.format } : {}),
      ...(source.project.locale ? { locale: source.project.locale } : {}),
      ownerId: commandActor.id,
      currentVersionId: duplicateVersionId,
      duplicatedFromProjectId: source.project.id,
      createdBy: commandActor,
      createdAt,
    })
    const version = createProjectVersion({
      id: duplicateVersionId,
      workspaceId,
      projectId: duplicateProjectId,
      sequence: 1,
      forkedFromProjectId: source.project.id,
      forkedFromVersionId: source.version.id,
      snapshotRefs: source.version.snapshotRefs,
      baseHash: calculateVersionHash({
        projectId: duplicateProjectId,
        sequence: 1,
        forkedFromProjectId: source.project.id,
        forkedFromVersionId: source.version.id,
        snapshotRefs: source.version.snapshotRefs,
      }),
      createdBy: commandActor.id,
      createdAt,
    })
    const media = source.media.map((item) => Object.freeze({
      id: dependencies.createId('project-media-asset'),
      artifactId: item.artifactId,
      role: item.role,
      originalFileName: item.originalFileName,
      createdAt,
    }))
    const auditCommand = createProjectCreationCommand({
      id: dependencies.createId('project-creation-command'),
      workspaceId,
      action: 'duplicate',
      projectId: duplicateProjectId,
      versionId: duplicateVersionId,
      sourceProjectId: source.project.id,
      sourceVersionId: source.version.id,
      audit,
      requestFingerprint,
      createdAt,
    })
    return dependencies.repository.duplicateOrReplay({
      sourceProjectId: source.project.id,
      sourceVersionId: source.version.id,
      sourceVersionHash: source.version.baseHash,
      project,
      version,
      media,
      auditCommand,
      idempotency: {
        id: dependencies.createId('idempotency-record'),
        workspaceId,
        clientId,
        key,
        requestFingerprint,
        expiresAt: new Date(
          createdAtDate.getTime() + ttlSeconds * 1000,
        ).toISOString(),
      },
    })
  }
}
