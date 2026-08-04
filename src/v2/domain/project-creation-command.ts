import {
  createApiAccessAuditContext,
  type ApiAccessAuditContext,
} from './api-access-control.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const PROJECT_CREATION_ACTIONS = ['create', 'duplicate'] as const
export type ProjectCreationAction = (typeof PROJECT_CREATION_ACTIONS)[number]

export interface ProjectCreationCommand {
  readonly schemaVersion: 1
  readonly id: string
  readonly workspaceId: string
  readonly action: ProjectCreationAction
  readonly projectId: string
  readonly versionId: string
  readonly sourceProjectId?: string
  readonly sourceVersionId?: string
  readonly audit: Readonly<ApiAccessAuditContext>
  readonly requestFingerprint: string
  readonly commandHash: string
  readonly createdAt: string
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/

export function createProjectCreationCommand(
  input: Omit<ProjectCreationCommand, 'schemaVersion' | 'commandHash'>,
): Readonly<ProjectCreationCommand> {
  assertDomain(
    ID_PATTERN.test(input.id) && ID_PATTERN.test(input.workspaceId) &&
      ID_PATTERN.test(input.projectId) && ID_PATTERN.test(input.versionId),
    'INVALID_ARGUMENT',
    'Project creation command identity is invalid',
  )
  assertDomain(
    PROJECT_CREATION_ACTIONS.includes(input.action) &&
      HASH_PATTERN.test(input.requestFingerprint),
    'INVALID_ARGUMENT',
    'Project creation command intent is invalid',
  )
  const hasSource = Boolean(input.sourceProjectId || input.sourceVersionId)
  assertDomain(
    input.action === 'duplicate'
      ? Boolean(
          input.sourceProjectId && input.sourceVersionId &&
          ID_PATTERN.test(input.sourceProjectId) && ID_PATTERN.test(input.sourceVersionId),
        )
      : !hasSource,
    'INVALID_ARGUMENT',
    'Project creation source does not match its action',
  )
  const audit = createApiAccessAuditContext({
    clientId: input.audit.clientId,
    credentialId: input.audit.credentialId,
    workspaceId: input.audit.workspaceId,
    environment: input.audit.environment,
    authenticationKind: input.audit.authenticationKind,
    ...(input.audit.delegatedUserId ? { delegatedUserId: input.audit.delegatedUserId } : {}),
    ...(input.audit.delegatedIdentityId
      ? { delegatedIdentityId: input.audit.delegatedIdentityId }
      : {}),
    ...(input.audit.workspaceRole ? { workspaceRole: input.audit.workspaceRole } : {}),
  })
  assertDomain(
    audit.contextHash === input.audit.contextHash && audit.workspaceId === input.workspaceId,
    'AUTH_INVALID',
    'Project creation command actor is invalid',
  )
  const createdAt = new Date(input.createdAt)
  assertDomain(
    !Number.isNaN(createdAt.getTime()),
    'INVALID_ARGUMENT',
    'Project creation command timestamp is invalid',
  )
  const canonical = {
    schemaVersion: 1 as const,
    id: input.id,
    workspaceId: input.workspaceId,
    action: input.action,
    projectId: input.projectId,
    versionId: input.versionId,
    sourceProjectId: input.sourceProjectId ?? null,
    sourceVersionId: input.sourceVersionId ?? null,
    actorContextHash: audit.contextHash,
    requestFingerprint: input.requestFingerprint,
    createdAt: createdAt.toISOString(),
  }
  return Object.freeze({
    ...input,
    audit,
    schemaVersion: 1 as const,
    createdAt: canonical.createdAt,
    commandHash: calculateCanonicalHash(canonical),
  })
}
