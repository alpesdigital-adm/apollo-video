import type {
  ApiAccessAuditContext,
  ApiAccessCommand,
  ApiAccessControl,
  ApiAccessTargetType,
} from '../../domain/api-access-control.ts'

export interface ApiAccessCommandResult {
  readonly access: Readonly<ApiAccessControl>
  readonly command: Readonly<ApiAccessCommand>
  readonly canceledOperationCount: number
  readonly replayed: boolean
}

export interface ApiAccessControlRepository {
  find(input: {
    workspaceId: string
    targetType: ApiAccessTargetType
    targetId: string
  }): Promise<Readonly<ApiAccessControl> | null>
  findReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<Readonly<ApiAccessCommandResult> | null>
  apply(
    command: Readonly<ApiAccessCommand>,
    audit: Readonly<ApiAccessAuditContext>,
  ): Promise<Readonly<ApiAccessCommandResult>>
}
