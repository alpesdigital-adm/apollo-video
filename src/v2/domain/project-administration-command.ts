import type { ApiAccessAuditContext } from './api-access-control.ts'
import { createApiAccessAuditContext } from './api-access-control.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  canTransitionProjectStatus,
  normalizeProjectName,
  PROJECT_STATUSES,
  type ProjectStatus,
} from './project.ts'

export const PROJECT_ADMINISTRATION_COMMAND_SCHEMA_VERSION =
  'project-administration-command/v1' as const

export type ProjectAdministrationAction = 'rename' | 'archive' | 'restore'

export interface ProjectAdministrationState {
  name: string
  status: ProjectStatus
  archivedFromStatus?: Exclude<ProjectStatus, 'archived'>
  revision: number
}

export interface ProjectAdministrationCommand {
  schemaVersion: typeof PROJECT_ADMINISTRATION_COMMAND_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  action: ProjectAdministrationAction
  before: Readonly<ProjectAdministrationState>
  after: Readonly<ProjectAdministrationState>
  confirmation: 'explicit' | 'not-required'
  audit: Readonly<ApiAccessAuditContext>
  idempotencyKey: string
  requestFingerprint: string
  resultHash: string
  occurredAt: string
  commandHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/

function canonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

export function createProjectAdministrationState(
  input: ProjectAdministrationState,
): Readonly<ProjectAdministrationState> {
  const name = normalizeProjectName(input.name)
  assertDomain(
    name.length >= 1 && name.length <= 120 &&
      PROJECT_STATUSES.includes(input.status) &&
      Number.isSafeInteger(input.revision) && input.revision >= 1 &&
      (input.archivedFromStatus === undefined ||
        (input.status === 'archived' &&
          PROJECT_STATUSES.includes(input.archivedFromStatus as ProjectStatus) &&
          canTransitionProjectStatus(input.archivedFromStatus, 'archived'))),
    'INVALID_PROJECT',
    'project administration state is invalid',
  )
  return Object.freeze({
    name,
    status: input.status,
    ...(input.archivedFromStatus
      ? { archivedFromStatus: input.archivedFromStatus }
      : {}),
    revision: input.revision,
  })
}

export function calculateProjectAdministrationResultHash(input: {
  projectId: string
  state: Readonly<ProjectAdministrationState>
}): string {
  return calculateCanonicalHash({
    schemaVersion: 'project-administration-result/v1',
    projectId: input.projectId,
    state: input.state,
  })
}

export function createProjectAdministrationCommand(
  input: Omit<ProjectAdministrationCommand, 'schemaVersion' | 'commandHash'> & {
    commandHash?: string
  },
): Readonly<ProjectAdministrationCommand> {
  assertDomain(
    ID.test(input.id) && ID.test(input.workspaceId) && ID.test(input.projectId) &&
      ['rename', 'archive', 'restore'].includes(input.action) &&
      IDEMPOTENCY_KEY.test(input.idempotencyKey) &&
      HASH.test(input.requestFingerprint) && HASH.test(input.resultHash) &&
      canonicalTimestamp(input.occurredAt),
    'INVALID_ARGUMENT',
    'project administration command evidence is invalid',
  )
  const before = createProjectAdministrationState(input.before)
  const after = createProjectAdministrationState(input.after)
  assertDomain(
    after.revision === before.revision + 1 &&
      (input.action === 'rename'
        ? before.status === after.status &&
          before.archivedFromStatus === after.archivedFromStatus &&
          before.name !== after.name && input.confirmation === 'not-required'
        : input.action === 'archive'
          ? before.status !== 'archived' && after.status === 'archived' &&
            after.archivedFromStatus === before.status &&
            before.name === after.name && input.confirmation === 'explicit'
          : before.status === 'archived' &&
            before.archivedFromStatus !== undefined &&
            after.status === before.archivedFromStatus &&
            after.archivedFromStatus === undefined &&
            before.name === after.name && input.confirmation === 'not-required'),
    'INVALID_PROJECT',
    'project administration transition is invalid',
  )
  const audit = createApiAccessAuditContext({
    clientId: input.audit.clientId,
    credentialId: input.audit.credentialId,
    workspaceId: input.audit.workspaceId,
    environment: input.audit.environment,
    authenticationKind: input.audit.authenticationKind,
    ...(input.audit.delegatedUserId
      ? { delegatedUserId: input.audit.delegatedUserId }
      : {}),
    ...(input.audit.delegatedIdentityId
      ? { delegatedIdentityId: input.audit.delegatedIdentityId }
      : {}),
    ...(input.audit.workspaceRole
      ? { workspaceRole: input.audit.workspaceRole }
      : {}),
  })
  assertDomain(
    audit.contextHash === input.audit.contextHash &&
      audit.workspaceId === input.workspaceId,
    'AUTH_INVALID',
    'project administration command audit is invalid',
  )
  assertDomain(
    calculateProjectAdministrationResultHash({
      projectId: input.projectId,
      state: after,
    }) === input.resultHash,
    'PERSISTENCE_CONFLICT',
    'project administration result hash is invalid',
  )
  const content = {
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    action: input.action,
    before,
    after,
    confirmation: input.confirmation,
    audit,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    resultHash: input.resultHash,
    occurredAt: input.occurredAt,
  }
  const commandHash = calculateCanonicalHash({
    schemaVersion: PROJECT_ADMINISTRATION_COMMAND_SCHEMA_VERSION,
    ...content,
  })
  assertDomain(
    input.commandHash === undefined || input.commandHash === commandHash,
    'PERSISTENCE_CONFLICT',
    'project administration command hash is invalid',
  )
  return Object.freeze({
    schemaVersion: PROJECT_ADMINISTRATION_COMMAND_SCHEMA_VERSION,
    ...content,
    commandHash,
  })
}
