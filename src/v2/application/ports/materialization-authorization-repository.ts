import type { MaterializationAuthorization } from '../../domain/materialization-authorization.ts'

export interface MaterializationAuthorizationResult {
  authorization: MaterializationAuthorization
  replayed: boolean
}

export interface MaterializationAuthorizationRepository {
  findById(
    workspaceId: string,
    authorizationId: string,
  ): Promise<MaterializationAuthorization | null>
  findReplay(input: {
    workspaceId: string
    clientId: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<MaterializationAuthorizationResult | null>
  createOrReplay(input: {
    authorization: MaterializationAuthorization
    clientId: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<MaterializationAuthorizationResult>
}
