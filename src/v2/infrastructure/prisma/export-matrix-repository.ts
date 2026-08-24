import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  deriveExportMatrixRuntimeStatus,
  EXPORT_MATRIX_SCHEMA_VERSION,
  parseExportMatrixPreflight,
  type ExportMatrixCellRuntimeStatus,
} from '../../domain/export-matrix.ts'
import type {
  ExportMatrixPreflightRecord,
  ExportMatrixRecord,
  ExportMatrixRepository,
} from '../../application/ports/export-matrix-repository.ts'

type Client = Pick<PrismaClient, '$transaction' | 'v2ExportMatrixPreflight' | 'v2ExportMatrix' | 'v2ExportMatrixCell' | 'v2PublicOperation'>

const MATRIX_INCLUDE = {
  preflight: true,
  cells: {
    orderBy: { sequence: 'asc' as const },
    include: { operation: { include: { projectFinalExport: true } } },
  },
} as const

function auditData(audit: Parameters<ExportMatrixRepository['createPreflight']>[0]['authenticationAudit']) {
  return {
    createdByClientId: audit.clientId,
    actorCredentialId: audit.credentialId,
    actorEnvironment: audit.environment,
    actorAuthenticationKind: audit.authenticationKind,
    actorContextHash: audit.contextHash,
    delegatedUserId: audit.delegatedUserId,
    delegatedIdentityId: audit.delegatedIdentityId,
    workspaceRole: audit.workspaceRole,
  }
}

function hydratePreflight(row: {
  id: string
  workspaceId: string
  schemaVersion: string
  definitionHash: string
  preflightHash: string
  snapshotHash: string
  costFingerprint: string
  preflightJson: string
  allowed: boolean
  requestFingerprint: string
  idempotencyKey: string
  createdByClientId: string
  actorContextHash: string
  createdAt: Date
  expiresAt: Date
}): Readonly<ExportMatrixPreflightRecord> {
  try {
    const preflight = parseExportMatrixPreflight(JSON.parse(row.preflightJson) as unknown)
    if (
      row.schemaVersion !== preflight.schemaVersion ||
      row.workspaceId !== preflight.definition.workspaceId ||
      row.definitionHash !== preflight.definition.definitionHash ||
      row.preflightHash !== preflight.preflightHash ||
      row.snapshotHash !== preflight.snapshotHash ||
      row.costFingerprint !== preflight.costFingerprint ||
      row.allowed !== preflight.allowed ||
      row.createdAt.toISOString() !== preflight.createdAt ||
      row.expiresAt.toISOString() !== preflight.expiresAt ||
      !/^[a-f0-9]{64}$/.test(row.requestFingerprint) ||
      !/^[a-f0-9]{64}$/.test(row.actorContextHash)
    ) throw new Error('mismatch')
    return Object.freeze({
      id: row.id,
      preflight,
      createdByClientId: row.createdByClientId,
      actorContextHash: row.actorContextHash,
      requestFingerprint: row.requestFingerprint,
      idempotencyKey: row.idempotencyKey,
    })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored export matrix preflight failed integrity validation')
  }
}

function runtimeStatus(row: {
  dispatchStatus: string
  operation: null | { status: string }
}): ExportMatrixCellRuntimeStatus {
  if (row.dispatchStatus === 'failed') return 'failed'
  if (row.dispatchStatus === 'awaiting-dispatch' && !row.operation) return 'awaiting-dispatch'
  if (row.dispatchStatus !== 'linked' || !row.operation) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored export matrix cell dispatch state is invalid')
  const status = row.operation.status
  if (status === 'queued') return 'queued'
  if (status === 'running') return 'running'
  if (status === 'retrying' || status === 'waiting') return 'retrying'
  if (status === 'succeeded') return 'ready'
  if (status === 'failed') return 'failed'
  if (status === 'canceled') return 'canceled'
  throw new DomainError('PERSISTENCE_CONFLICT', 'Stored export matrix operation status is invalid')
}

function hydrateMatrix(row: any): Readonly<ExportMatrixRecord> {
  const preflight = hydratePreflight(row.preflight)
  if (
    row.schemaVersion !== EXPORT_MATRIX_SCHEMA_VERSION ||
    row.workspaceId !== preflight.preflight.definition.workspaceId ||
    row.preflightId !== preflight.id ||
    row.definitionHash !== preflight.preflight.definition.definitionHash ||
    row.preflightHash !== preflight.preflight.preflightHash ||
    row.createdByClientId !== preflight.createdByClientId ||
    row.actorContextHash !== preflight.actorContextHash ||
    row.cells.length !== preflight.preflight.definition.cells.length
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored export matrix identity is invalid')
  const definitions = new Map(preflight.preflight.definition.cells.map((cell) => [cell.id, cell]))
  const cells = Object.freeze(row.cells.map((cell: any) => {
    const definition = definitions.get(cell.id)
    if (
      !definition ||
      cell.workspaceId !== row.workspaceId ||
      cell.matrixId !== row.id ||
      cell.sequence !== definition.sequence ||
      cell.address !== definition.address ||
      cell.recipeId !== definition.recipeId ||
      cell.projectId !== definition.projectId ||
      cell.projectVersionId !== definition.projectVersionId ||
      cell.projectVersionHash !== definition.projectVersionHash ||
      cell.outputAspectRatio !== definition.format ||
      cell.locale !== definition.locale ||
      cell.outputFileName !== definition.outputFileName ||
      cell.manifestFileName !== definition.manifestFileName ||
      cell.cellHash !== definition.cellHash
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored export matrix cell does not match its immutable definition')
    const status = runtimeStatus(cell)
    const operation = cell.operation
    if (operation && (
      operation.workspaceId !== row.workspaceId ||
      operation.projectId !== definition.projectId ||
      operation.type !== 'project-final-export' ||
      operation.projectFinalExport?.projectVersionId !== definition.projectVersionId ||
      operation.projectFinalExport?.projectVersionHash !== definition.projectVersionHash ||
      operation.projectFinalExport?.outputAspectRatio !== definition.format ||
      operation.projectFinalExport?.originalFileName !== definition.outputFileName
    )) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored export matrix cell operation binding is invalid')
    const operationError = operation?.errorCode && operation.errorMessage && operation.errorRetryable !== null
      ? { code: operation.errorCode, message: operation.errorMessage, retryable: operation.errorRetryable }
      : undefined
    const dispatchError = cell.dispatchErrorCode && cell.dispatchErrorMessage && cell.dispatchRetryable !== null
      ? { code: cell.dispatchErrorCode, message: cell.dispatchErrorMessage, retryable: cell.dispatchRetryable }
      : undefined
    return Object.freeze({
      id: definition.id,
      sequence: definition.sequence,
      address: definition.address,
      recipeId: definition.recipeId,
      projectId: definition.projectId,
      projectVersionId: definition.projectVersionId,
      projectVersionHash: definition.projectVersionHash,
      format: definition.format,
      locale: definition.locale,
      outputFileName: definition.outputFileName,
      manifestFileName: definition.manifestFileName,
      cellHash: definition.cellHash,
      status,
      ...(operation ? {
        operationId: operation.id,
        outputArtifactId: operation.projectFinalExport.outputArtifactId,
        outputManifestId: operation.projectFinalExport.outputManifestId,
        attempt: operation.attempt,
      } : { attempt: 0 }),
      ...((operationError ?? dispatchError) ? { error: Object.freeze(operationError ?? dispatchError) } : {}),
    })
  }))
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    preflightId: row.preflightId,
    definitionHash: row.definitionHash,
    preflightHash: row.preflightHash,
    status: deriveExportMatrixRuntimeStatus(cells.map((cell: { status: ExportMatrixCellRuntimeStatus }) => cell.status)),
    cells,
    createdByClientId: row.createdByClientId,
    createdAt: row.createdAt.toISOString(),
  })
}

export class PrismaExportMatrixRepository implements ExportMatrixRepository {
  private readonly client: Client

  constructor(client: Client) {
    this.client = client
  }

  async findPreflightReplay(input: Parameters<ExportMatrixRepository['findPreflightReplay']>[0]) {
    const row = await this.client.v2ExportMatrixPreflight.findFirst({
      where: {
        workspaceId: input.workspaceId,
        createdByClientId: input.clientId,
        actorContextHash: input.actorContextHash,
        idempotencyKey: input.idempotencyKey,
      },
    })
    return row ? hydratePreflight(row) : null
  }

  async createPreflight(input: Parameters<ExportMatrixRepository['createPreflight']>[0]) {
    try {
      const row = await this.client.v2ExportMatrixPreflight.create({
        data: {
          id: input.id,
          workspaceId: input.preflight.definition.workspaceId,
          schemaVersion: input.preflight.schemaVersion,
          definitionHash: input.preflight.definition.definitionHash,
          preflightHash: input.preflight.preflightHash,
          snapshotHash: input.preflight.snapshotHash,
          costFingerprint: input.preflight.costFingerprint,
          preflightJson: stableSerialize(input.preflight),
          allowed: input.preflight.allowed,
          requestFingerprint: input.requestFingerprint,
          idempotencyKey: input.idempotencyKey,
          ...auditData(input.authenticationAudit),
          createdAt: new Date(input.preflight.createdAt),
          expiresAt: new Date(input.preflight.expiresAt),
        },
      })
      return hydratePreflight(row)
    } catch (error) {
      const replay = await this.findPreflightReplay({
        workspaceId: input.preflight.definition.workspaceId,
        clientId: input.authenticationAudit.clientId,
        actorContextHash: input.authenticationAudit.contextHash,
        idempotencyKey: input.idempotencyKey,
      })
      if (replay) {
        if (replay.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different export matrix preflight')
        return replay
      }
      if (error instanceof DomainError) throw error
      throw new DomainError('PERSISTENCE_CONFLICT', 'Export matrix preflight could not be persisted')
    }
  }

  async readPreflight(input: Parameters<ExportMatrixRepository['readPreflight']>[0]) {
    const row = await this.client.v2ExportMatrixPreflight.findFirst({ where: { id: input.preflightId, workspaceId: input.workspaceId } })
    return row ? hydratePreflight(row) : null
  }

  async findMatrixByPreflight(input: Parameters<ExportMatrixRepository['findMatrixByPreflight']>[0]) {
    const row = await this.client.v2ExportMatrix.findFirst({ where: { workspaceId: input.workspaceId, preflightId: input.preflightId }, include: MATRIX_INCLUDE })
    return row ? hydrateMatrix(row) : null
  }

  async createMatrix(input: Parameters<ExportMatrixRepository['createMatrix']>[0]) {
    const createdAt = new Date(input.createdAt)
    if (!Number.isFinite(createdAt.getTime())) throw new DomainError('INVALID_ARGUMENT', 'Export matrix creation time is invalid')
    try {
      await this.client.$transaction(async (transaction) => {
        const source = await transaction.v2ExportMatrixPreflight.findFirst({
          where: {
            id: input.preflight.id,
            workspaceId: input.preflight.preflight.definition.workspaceId,
            allowed: true,
            preflightHash: input.preflight.preflight.preflightHash,
            actorContextHash: input.authenticationAudit.contextHash,
            expiresAt: { gt: createdAt },
          },
        })
        if (!source) throw new DomainError('PREFLIGHT_TOKEN_STALE', 'Export matrix preflight is stale or expired')
        await transaction.v2ExportMatrix.create({
          data: {
            id: input.id,
            workspaceId: source.workspaceId,
            preflightId: source.id,
            schemaVersion: EXPORT_MATRIX_SCHEMA_VERSION,
            definitionHash: input.preflight.preflight.definition.definitionHash,
            preflightHash: input.preflight.preflight.preflightHash,
            ...auditData(input.authenticationAudit),
            createdAt,
            cells: { create: input.preflight.preflight.definition.cells.map((cell) => ({
              id: cell.id,
              workspaceId: source.workspaceId,
              sequence: cell.sequence,
              address: cell.address,
              recipeId: cell.recipeId,
              projectId: cell.projectId,
              projectVersionId: cell.projectVersionId,
              projectVersionHash: cell.projectVersionHash,
              outputAspectRatio: cell.format,
              locale: cell.locale,
              outputFileName: cell.outputFileName,
              manifestFileName: cell.manifestFileName,
              cellHash: cell.cellHash,
              dispatchStatus: 'awaiting-dispatch',
            })) },
          },
        })
      })
    } catch (error) {
      const replay = await this.findMatrixByPreflight({ workspaceId: input.preflight.preflight.definition.workspaceId, preflightId: input.preflight.id })
      if (replay) return replay
      if (error instanceof DomainError) throw error
      throw new DomainError('PERSISTENCE_CONFLICT', 'Export matrix could not be persisted')
    }
    const result = await this.readMatrix({ workspaceId: input.preflight.preflight.definition.workspaceId, matrixId: input.id })
    if (!result) throw new DomainError('PERSISTENCE_CONFLICT', 'Created export matrix disappeared')
    return result
  }

  async attachCellOperation(input: Parameters<ExportMatrixRepository['attachCellOperation']>[0]) {
    await this.client.$transaction(async (transaction) => {
      const cell = await transaction.v2ExportMatrixCell.findFirst({ where: { id: input.cellId, matrixId: input.matrixId, workspaceId: input.workspaceId } })
      if (!cell) throw new DomainError('EXPORT_MATRIX_NOT_FOUND', 'Export matrix cell was not found')
      if (cell.operationId === input.operationId && cell.dispatchStatus === 'linked') return
      if (cell.operationId || cell.dispatchStatus !== 'awaiting-dispatch') throw new DomainError('PERSISTENCE_CONFLICT', 'Export matrix cell already has a different dispatch result')
      const operation = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId, projectId: cell.projectId, type: 'project-final-export' },
        include: { projectFinalExport: true },
      })
      if (!operation?.projectFinalExport ||
        operation.projectFinalExport.projectVersionId !== cell.projectVersionId ||
        operation.projectFinalExport.projectVersionHash !== cell.projectVersionHash ||
        operation.projectFinalExport.outputAspectRatio !== cell.outputAspectRatio ||
        operation.projectFinalExport.originalFileName !== cell.outputFileName
      ) throw new DomainError('PERSISTENCE_CONFLICT', 'Final export operation does not match the export matrix cell')
      await transaction.v2ExportMatrixCell.update({ where: { id: cell.id }, data: { operationId: input.operationId, dispatchStatus: 'linked' } })
    })
  }

  async recordCellDispatchFailure(input: Parameters<ExportMatrixRepository['recordCellDispatchFailure']>[0]) {
    const updated = await this.client.v2ExportMatrixCell.updateMany({
      where: { id: input.cellId, matrixId: input.matrixId, workspaceId: input.workspaceId, operationId: null, dispatchStatus: 'awaiting-dispatch' },
      data: {
        dispatchStatus: 'failed',
        dispatchErrorCode: input.error.code.slice(0, 128),
        dispatchErrorMessage: input.error.message.slice(0, 500),
        dispatchRetryable: input.error.retryable,
      },
    })
    if (updated.count !== 1) {
      const existing = await this.client.v2ExportMatrixCell.findFirst({ where: { id: input.cellId, matrixId: input.matrixId, workspaceId: input.workspaceId } })
      if (existing?.dispatchStatus === 'failed' && existing.dispatchErrorCode === input.error.code && existing.dispatchErrorMessage === input.error.message && existing.dispatchRetryable === input.error.retryable) return
      throw new DomainError('PERSISTENCE_CONFLICT', 'Export matrix dispatch failure did not converge')
    }
  }

  async readMatrix(input: Parameters<ExportMatrixRepository['readMatrix']>[0]) {
    const row = await this.client.v2ExportMatrix.findFirst({ where: { id: input.matrixId, workspaceId: input.workspaceId }, include: MATRIX_INCLUDE })
    return row ? hydrateMatrix(row) : null
  }
}
