import {
  assertApiAccessAuditBinding,
  type ApiAccessAuditContext,
} from './api-access-control.ts'
import { assertDomain } from './errors.ts'

export const API_ADMINISTRATION_ACTIONS = [
  'api-client.create',
  'api-credential.rotate',
  'api-credential.revoke',
] as const

export type ApiAdministrationAction = (typeof API_ADMINISTRATION_ACTIONS)[number]

export interface ApiAdministrationCommand {
  readonly schemaVersion: 1
  readonly id: string
  readonly workspaceId: string
  readonly action: ApiAdministrationAction
  readonly targetClientId: string
  readonly targetCredentialId: string
  readonly audit: Readonly<ApiAccessAuditContext>
  readonly idempotencyKey?: string
  readonly requestFingerprint: string
  readonly occurredAt: string
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/

export function createApiAdministrationCommand(
  input: Omit<ApiAdministrationCommand, 'schemaVersion'>,
): Readonly<ApiAdministrationCommand> {
  assertDomain(
    ID_PATTERN.test(input.id) && ID_PATTERN.test(input.workspaceId) &&
      ID_PATTERN.test(input.targetClientId) && ID_PATTERN.test(input.targetCredentialId),
    'INVALID_ARGUMENT',
    'API administration command identity is invalid',
  )
  assertDomain(
    API_ADMINISTRATION_ACTIONS.includes(input.action),
    'INVALID_ARGUMENT',
    'API administration action is invalid',
  )
  assertApiAccessAuditBinding({
    workspaceId: input.workspaceId,
    actorClientId: input.audit.clientId,
    delegatedUserId: input.audit.delegatedUserId,
  }, input.audit)
  assertDomain(
    input.action === 'api-credential.revoke'
      ? input.idempotencyKey === undefined
      : Boolean(input.idempotencyKey) && (input.idempotencyKey?.length ?? 0) <= 128,
    'INVALID_ARGUMENT',
    'API administration command idempotency is invalid',
  )
  assertDomain(
    HASH_PATTERN.test(input.requestFingerprint),
    'INVALID_ARGUMENT',
    'API administration request fingerprint is invalid',
  )
  const occurredAt = new Date(input.occurredAt)
  assertDomain(
    !Number.isNaN(occurredAt.getTime()) && occurredAt.toISOString() === input.occurredAt,
    'INVALID_ARGUMENT',
    'API administration command date is invalid',
  )
  return Object.freeze({
    ...input,
    schemaVersion: 1 as const,
    audit: Object.freeze({ ...input.audit }),
  })
}
