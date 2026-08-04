import {
  createApiAccessAuditContext,
  type ApiAccessAuditContext,
} from './api-access-control.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export type AssetRightsChangeActor =
  | Readonly<{ kind: 'external'; audit: Readonly<ApiAccessAuditContext> }>
  | Readonly<{
      kind: 'internal'
      actorType: 'api-client' | 'user' | 'system'
      actorId: string
    }>

export interface AssetRightsChangeIntent {
  readonly id: string
  readonly workspaceId: string
  readonly artifactId: string
  readonly snapshotHash: string
  readonly baseRevision: string
  readonly actor: AssetRightsChangeActor
  readonly requestFingerprint: string
  readonly changedAt: string
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/

function canonicalActor(actor: AssetRightsChangeActor) {
  if (actor.kind === 'internal') {
    assertDomain(
      ['api-client', 'user', 'system'].includes(actor.actorType) &&
        ID_PATTERN.test(actor.actorId),
      'INVALID_ARGUMENT',
      'Asset rights internal actor is invalid',
    )
    return { kind: actor.kind, actorType: actor.actorType, actorId: actor.actorId }
  }
  const audit = createApiAccessAuditContext({
    clientId: actor.audit.clientId,
    credentialId: actor.audit.credentialId,
    workspaceId: actor.audit.workspaceId,
    environment: actor.audit.environment,
    authenticationKind: actor.audit.authenticationKind,
    ...(actor.audit.delegatedUserId ? { delegatedUserId: actor.audit.delegatedUserId } : {}),
    ...(actor.audit.delegatedIdentityId
      ? { delegatedIdentityId: actor.audit.delegatedIdentityId }
      : {}),
    ...(actor.audit.workspaceRole ? { workspaceRole: actor.audit.workspaceRole } : {}),
  })
  assertDomain(
    audit.contextHash === actor.audit.contextHash,
    'AUTH_INVALID',
    'Asset rights external actor is invalid',
  )
  return { kind: actor.kind, contextHash: audit.contextHash }
}

export function createAssetRightsChangeIntent(input: {
  workspaceId: string
  artifactId: string
  snapshotHash: string
  baseRevision: string
  actor: AssetRightsChangeActor
  changedAt: string
}): Readonly<AssetRightsChangeIntent> {
  assertDomain(
    ID_PATTERN.test(input.workspaceId) && ID_PATTERN.test(input.artifactId),
    'INVALID_ARGUMENT',
    'Asset rights change target is invalid',
  )
  assertDomain(
    HASH_PATTERN.test(input.snapshotHash) && HASH_PATTERN.test(input.baseRevision),
    'INVALID_ARGUMENT',
    'Asset rights change revision is invalid',
  )
  const actor = canonicalActor(input.actor)
  if (input.actor.kind === 'external') {
    assertDomain(
      input.actor.audit.workspaceId === input.workspaceId,
      'AUTH_INVALID',
      'Asset rights actor does not belong to the workspace',
    )
  }
  const changedAt = new Date(input.changedAt)
  assertDomain(!Number.isNaN(changedAt.getTime()), 'INVALID_ARGUMENT', 'Asset rights change time is invalid')
  const requestFingerprint = calculateCanonicalHash({
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    snapshotHash: input.snapshotHash,
    baseRevision: input.baseRevision,
    actor,
  })
  return Object.freeze({
    ...input,
    id: `rights-change-${requestFingerprint.slice(0, 48)}`,
    requestFingerprint,
    changedAt: changedAt.toISOString(),
  })
}
