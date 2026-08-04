import type { MaterializationAuthorization } from '../../domain/materialization-authorization.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface MaterializationAuthorizationRecord {
  authorization: MaterializationAuthorization
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface MaterializationAuthorizationResult extends MaterializationAuthorizationRecord {
  replayed: boolean
}

export interface MaterializationAuthorizationRepository {
  findById(
    workspaceId: string,
    authorizationId: string,
  ): Promise<MaterializationAuthorizationRecord | null>
  findReplay(input: {
    workspaceId: string
    clientId: string
    actorContextHash: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<MaterializationAuthorizationResult | null>
  createOrReplay(input: {
    authorization: MaterializationAuthorization
    authenticationAudit: Readonly<ApiAccessAuditContext>
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<MaterializationAuthorizationResult>
}
