import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type {
  ExportMatrixCellRuntimeStatus,
  ExportMatrixPreflight,
  ExportMatrixRuntimeStatus,
} from '../../domain/export-matrix.ts'

export interface ExportMatrixPreflightRecord {
  id: string
  preflight: Readonly<ExportMatrixPreflight>
  createdByClientId: string
  actorContextHash: string
  requestFingerprint: string
  idempotencyKey: string
}

export interface ExportMatrixCellRecord {
  id: string
  sequence: number
  address: string
  recipeId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  format: '9:16' | '16:9' | '4:5' | '1:1' | '21:9'
  locale: string
  outputFileName: string
  manifestFileName: string
  cellHash: string
  status: ExportMatrixCellRuntimeStatus
  operationId?: string
  outputArtifactId?: string
  outputManifestId?: string
  attempt: number
  error?: Readonly<{ code: string; message: string; retryable: boolean }>
}

export interface ExportMatrixRecord {
  id: string
  workspaceId: string
  preflightId: string
  definitionHash: string
  preflightHash: string
  status: ExportMatrixRuntimeStatus
  cells: readonly Readonly<ExportMatrixCellRecord>[]
  createdByClientId: string
  createdAt: string
}

export interface ExportMatrixRepository {
  findPreflightReplay(input: {
    workspaceId: string
    clientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<ExportMatrixPreflightRecord> | null>
  createPreflight(input: {
    id: string
    preflight: Readonly<ExportMatrixPreflight>
    authenticationAudit: Readonly<ApiAccessAuditContext>
    requestFingerprint: string
    idempotencyKey: string
  }): Promise<Readonly<ExportMatrixPreflightRecord>>
  readPreflight(input: {
    workspaceId: string
    preflightId: string
  }): Promise<Readonly<ExportMatrixPreflightRecord> | null>
  findMatrixByPreflight(input: {
    workspaceId: string
    preflightId: string
  }): Promise<Readonly<ExportMatrixRecord> | null>
  createMatrix(input: {
    id: string
    preflight: Readonly<ExportMatrixPreflightRecord>
    authenticationAudit: Readonly<ApiAccessAuditContext>
    createdAt: string
  }): Promise<Readonly<ExportMatrixRecord>>
  attachCellOperation(input: {
    workspaceId: string
    matrixId: string
    cellId: string
    operationId: string
  }): Promise<void>
  recordCellDispatchFailure(input: {
    workspaceId: string
    matrixId: string
    cellId: string
    error: Readonly<{ code: string; message: string; retryable: boolean }>
  }): Promise<void>
  readMatrix(input: {
    workspaceId: string
    matrixId: string
  }): Promise<Readonly<ExportMatrixRecord> | null>
}
