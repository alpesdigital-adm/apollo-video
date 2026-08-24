import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { OUTPUT_ASPECT_RATIOS, type OutputAspectRatio } from './output-spec.ts'

export const EXPORT_MATRIX_SCHEMA_VERSION = 'export-matrix/v1' as const
export const EXPORT_MATRIX_PREFLIGHT_SCHEMA_VERSION = 'export-matrix-preflight/v1' as const
export const EXPORT_MATRIX_ESTIMATE_POLICY_VERSION = 'export-matrix-estimate/1.0.0' as const
export const MAX_EXPORT_MATRIX_CELLS = 100

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/
const FORMAT_ORDER = new Map(OUTPUT_ASPECT_RATIOS.map((format, index) => [format, index]))

function identity(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value.trim()), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && HASH.test(value), 'INVALID_ARGUMENT', `${field} must be a SHA-256 hash`)
  return value
}

function locale(value: unknown): string {
  assertDomain(typeof value === 'string' && LOCALE.test(value.trim()), 'INVALID_ARGUMENT', 'locale is invalid')
  return value.trim()
}

function positiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  assertDomain(Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum, 'INVALID_ARGUMENT', `${field} is invalid`)
  return Number(value)
}

function nonNegativeInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  assertDomain(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum, 'INVALID_ARGUMENT', `${field} is invalid`)
  return Number(value)
}

function portableToken(value: string): string {
  const token = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-')
  assertDomain(token.length >= 1, 'INVALID_ARGUMENT', 'Export matrix naming token is empty')
  return token.slice(0, 48)
}

export interface ExportMatrixCellRequest {
  recipeId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  format: OutputAspectRatio
  locale: string
}

export interface ExportMatrixCellDefinition extends ExportMatrixCellRequest {
  id: string
  sequence: number
  address: string
  addressHash: string
  outputFileName: string
  manifestFileName: string
  cellHash: string
}

export interface ExportMatrixDefinition {
  schemaVersion: typeof EXPORT_MATRIX_SCHEMA_VERSION
  workspaceId: string
  cells: readonly Readonly<ExportMatrixCellDefinition>[]
  definitionHash: string
}

export function createExportMatrixDefinition(input: {
  workspaceId: string
  cells: readonly Readonly<ExportMatrixCellRequest>[]
}): Readonly<ExportMatrixDefinition> {
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  assertDomain(Array.isArray(input.cells) && input.cells.length >= 1 && input.cells.length <= MAX_EXPORT_MATRIX_CELLS, 'INVALID_ARGUMENT', `Export matrix must contain 1 to ${MAX_EXPORT_MATRIX_CELLS} cells`)
  const normalized = input.cells.map((cell) => {
    assertDomain(cell && typeof cell === 'object' && !Array.isArray(cell), 'INVALID_ARGUMENT', 'Export matrix cell is invalid')
    const recipeId = identity(cell.recipeId, 'recipeId')
    const projectId = identity(cell.projectId, 'projectId')
    const projectVersionId = identity(cell.projectVersionId, 'projectVersionId')
    const projectVersionHash = hash(cell.projectVersionHash, 'projectVersionHash')
    assertDomain(OUTPUT_ASPECT_RATIOS.includes(cell.format), 'INVALID_OUTPUT_SPEC', 'Export matrix format is not supported')
    const normalizedLocale = locale(cell.locale)
    const address = `${recipeId}::${cell.format}::${normalizedLocale}`
    const addressHash = calculateCanonicalHash({ schemaVersion: 'export-cell-address/v1', workspaceId, address })
    const nameStem = [portableToken(projectId), portableToken(recipeId), cell.format.replace(':', 'x'), portableToken(normalizedLocale), projectVersionHash.slice(0, 12)].join('--')
    const content = {
      recipeId,
      projectId,
      projectVersionId,
      projectVersionHash,
      format: cell.format,
      locale: normalizedLocale,
      address,
      addressHash,
      outputFileName: `${nameStem}.mp4`,
      manifestFileName: `${nameStem}.manifest.json`,
    }
    return { ...content, cellHash: calculateCanonicalHash({ schemaVersion: 'export-matrix-cell/v1', ...content }) }
  }).sort((left, right) =>
    left.recipeId.localeCompare(right.recipeId) ||
    (FORMAT_ORDER.get(left.format) ?? 999) - (FORMAT_ORDER.get(right.format) ?? 999) ||
    left.locale.localeCompare(right.locale) ||
    left.projectId.localeCompare(right.projectId) ||
    left.projectVersionId.localeCompare(right.projectVersionId))
  assertDomain(new Set(normalized.map((cell) => cell.address)).size === normalized.length, 'INVALID_ARGUMENT', 'Export matrix recipe, format and locale addresses must be unique')
  const cells = Object.freeze(normalized.map((cell, index) => Object.freeze({
    ...cell,
    id: `cell-${cell.addressHash.slice(0, 32)}`,
    sequence: index + 1,
  })))
  const content = Object.freeze({ schemaVersion: EXPORT_MATRIX_SCHEMA_VERSION, workspaceId, cells })
  return Object.freeze({ ...content, definitionHash: calculateCanonicalHash(content) })
}

export interface ExportMatrixCellEvidence {
  cellId: string
  ready: boolean
  rightsAllowed: boolean
  durationFrames: number
  fps: number
  width: number
  height: number
  sourceFingerprint: string
}

export type ExportMatrixBlockerCode =
  | 'CELL_NOT_READY'
  | 'CELL_RIGHTS_BLOCKED'
  | 'COST_LIMIT_EXCEEDED'
  | 'STORAGE_LIMIT_EXCEEDED'

export interface ExportMatrixPreflight {
  schemaVersion: typeof EXPORT_MATRIX_PREFLIGHT_SCHEMA_VERSION
  estimatePolicyVersion: typeof EXPORT_MATRIX_ESTIMATE_POLICY_VERSION
  definition: Readonly<ExportMatrixDefinition>
  quantity: number
  estimatedCostMinorUnits: number
  maximumCostMinorUnits: number
  estimatedStorageBytes: number
  maximumStorageBytes: number
  costLimitMinorUnits: number
  storageLimitBytes: number
  cells: readonly Readonly<ExportMatrixCellEvidence & {
    durationSeconds: number
    estimatedCostMinorUnits: number
    maximumCostMinorUnits: number
    estimatedStorageBytes: number
    maximumStorageBytes: number
    blockers: readonly ExportMatrixBlockerCode[]
  }>[]
  blockers: readonly Readonly<{ code: ExportMatrixBlockerCode; cellId?: string }>[]
  allowed: boolean
  snapshotHash: string
  costFingerprint: string
  createdAt: string
  expiresAt: string
  preflightHash: string
}

export function createExportMatrixPreflight(input: {
  definition: Readonly<ExportMatrixDefinition>
  evidence: readonly Readonly<ExportMatrixCellEvidence>[]
  requestedMaximumCostMinorUnits: number
  requestedMaximumStorageBytes: number
  operatorMaximumCostMinorUnits: number
  operatorAvailableStorageBytes: number
  createdAt: string
  expiresAt: string
}): Readonly<ExportMatrixPreflight> {
  const definition = createExportMatrixDefinition(input.definition)
  assertDomain(Array.isArray(input.evidence) && input.evidence.length === definition.cells.length, 'INVALID_ARGUMENT', 'Export matrix evidence must cover every cell')
  const evidenceByCell = new Map(input.evidence.map((item) => [item.cellId, item]))
  assertDomain(evidenceByCell.size === definition.cells.length && definition.cells.every((cell) => evidenceByCell.has(cell.id)), 'INVALID_ARGUMENT', 'Export matrix evidence identity is inconsistent')
  const requestedCost = nonNegativeInteger(input.requestedMaximumCostMinorUnits, 'requestedMaximumCostMinorUnits', 100_000_000)
  const requestedStorage = nonNegativeInteger(input.requestedMaximumStorageBytes, 'requestedMaximumStorageBytes')
  const operatorCost = nonNegativeInteger(input.operatorMaximumCostMinorUnits, 'operatorMaximumCostMinorUnits', 100_000_000)
  const operatorStorage = nonNegativeInteger(input.operatorAvailableStorageBytes, 'operatorAvailableStorageBytes')
  const costLimitMinorUnits = Math.min(requestedCost, operatorCost)
  const storageLimitBytes = Math.min(requestedStorage, operatorStorage)
  const createdAtMs = Date.parse(input.createdAt)
  const expiresAtMs = Date.parse(input.expiresAt)
  assertDomain(Number.isFinite(createdAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs > createdAtMs && expiresAtMs - createdAtMs <= 15 * 60_000, 'INVALID_ARGUMENT', 'Export matrix preflight validity window is invalid')

  const cells = Object.freeze(definition.cells.map((cell) => {
    const evidence = evidenceByCell.get(cell.id)!
    const durationFrames = positiveInteger(evidence.durationFrames, 'durationFrames', 24 * 60 * 60 * 120)
    assertDomain(typeof evidence.fps === 'number' && Number.isFinite(evidence.fps) && evidence.fps >= 1 && evidence.fps <= 120, 'INVALID_ARGUMENT', 'fps is invalid')
    const width = positiveInteger(evidence.width, 'width', 16_384)
    const height = positiveInteger(evidence.height, 'height', 16_384)
    const sourceFingerprint = hash(evidence.sourceFingerprint, 'sourceFingerprint')
    const durationSeconds = durationFrames / evidence.fps
    const megapixelSeconds = durationSeconds * width * height / 1_000_000
    const estimatedCostMinorUnits = Math.max(1, Math.ceil(megapixelSeconds))
    const maximumCostMinorUnits = Math.max(estimatedCostMinorUnits, Math.ceil(estimatedCostMinorUnits * 1.25))
    const estimatedStorageBytes = Math.max(1, Math.ceil(durationSeconds * 1_048_576))
    const maximumStorageBytes = Math.max(estimatedStorageBytes, Math.ceil(estimatedStorageBytes * 1.25))
    const blockers = Object.freeze([
      ...(!evidence.ready ? ['CELL_NOT_READY' as const] : []),
      ...(!evidence.rightsAllowed ? ['CELL_RIGHTS_BLOCKED' as const] : []),
    ])
    return Object.freeze({
      cellId: cell.id,
      ready: evidence.ready === true,
      rightsAllowed: evidence.rightsAllowed === true,
      durationFrames,
      fps: evidence.fps,
      width,
      height,
      sourceFingerprint,
      durationSeconds,
      estimatedCostMinorUnits,
      maximumCostMinorUnits,
      estimatedStorageBytes,
      maximumStorageBytes,
      blockers,
    })
  }))
  const estimatedCostMinorUnits = cells.reduce((total, cell) => total + cell.estimatedCostMinorUnits, 0)
  const maximumCostMinorUnits = cells.reduce((total, cell) => total + cell.maximumCostMinorUnits, 0)
  const estimatedStorageBytes = cells.reduce((total, cell) => total + cell.estimatedStorageBytes, 0)
  const maximumStorageBytes = cells.reduce((total, cell) => total + cell.maximumStorageBytes, 0)
  const blockers = Object.freeze([
    ...cells.flatMap((cell) => cell.blockers.map((code) => Object.freeze({ code, cellId: cell.cellId }))),
    ...(maximumCostMinorUnits > costLimitMinorUnits ? [Object.freeze({ code: 'COST_LIMIT_EXCEEDED' as const })] : []),
    ...(maximumStorageBytes > storageLimitBytes ? [Object.freeze({ code: 'STORAGE_LIMIT_EXCEEDED' as const })] : []),
  ])
  const snapshotHash = calculateCanonicalHash({
    schemaVersion: 'export-matrix-evidence-snapshot/v1',
    definitionHash: definition.definitionHash,
    cells: cells.map(({ cellId, ready, rightsAllowed, durationFrames, fps, width, height, sourceFingerprint }) => ({ cellId, ready, rightsAllowed, durationFrames, fps, width, height, sourceFingerprint })),
  })
  const costFingerprint = calculateCanonicalHash({
    schemaVersion: EXPORT_MATRIX_ESTIMATE_POLICY_VERSION,
    definitionHash: definition.definitionHash,
    estimatedCostMinorUnits,
    maximumCostMinorUnits,
    estimatedStorageBytes,
    maximumStorageBytes,
    costLimitMinorUnits,
    storageLimitBytes,
  })
  const content = Object.freeze({
    schemaVersion: EXPORT_MATRIX_PREFLIGHT_SCHEMA_VERSION,
    estimatePolicyVersion: EXPORT_MATRIX_ESTIMATE_POLICY_VERSION,
    definition,
    quantity: cells.length,
    estimatedCostMinorUnits,
    maximumCostMinorUnits,
    estimatedStorageBytes,
    maximumStorageBytes,
    costLimitMinorUnits,
    storageLimitBytes,
    cells,
    blockers,
    allowed: blockers.length === 0,
    snapshotHash,
    costFingerprint,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  })
  return Object.freeze({ ...content, preflightHash: calculateCanonicalHash(content) })
}

export function parseExportMatrixPreflight(input: unknown): Readonly<ExportMatrixPreflight> {
  assertDomain(input && typeof input === 'object' && !Array.isArray(input), 'PERSISTENCE_CONFLICT', 'Stored export matrix preflight is invalid')
  const record = input as Record<string, unknown>
  const suppliedHash = record.preflightHash
  assertDomain(typeof suppliedHash === 'string' && HASH.test(suppliedHash), 'PERSISTENCE_CONFLICT', 'Stored export matrix preflight hash is invalid')
  const { preflightHash: _ignored, ...content } = record
  assertDomain(calculateCanonicalHash(content) === suppliedHash, 'PERSISTENCE_CONFLICT', 'Stored export matrix preflight hash does not match its content')
  const cells = record.cells
  assertDomain(Array.isArray(cells), 'PERSISTENCE_CONFLICT', 'Stored export matrix preflight cells are invalid')
  const rebuilt = createExportMatrixPreflight({
    definition: record.definition as ExportMatrixDefinition,
    evidence: cells.map((cell) => {
      assertDomain(cell && typeof cell === 'object' && !Array.isArray(cell), 'PERSISTENCE_CONFLICT', 'Stored export matrix cell evidence is invalid')
      const value = cell as Record<string, unknown>
      return {
        cellId: value.cellId as string,
        ready: value.ready as boolean,
        rightsAllowed: value.rightsAllowed as boolean,
        durationFrames: value.durationFrames as number,
        fps: value.fps as number,
        width: value.width as number,
        height: value.height as number,
        sourceFingerprint: value.sourceFingerprint as string,
      }
    }),
    requestedMaximumCostMinorUnits: record.costLimitMinorUnits as number,
    requestedMaximumStorageBytes: record.storageLimitBytes as number,
    operatorMaximumCostMinorUnits: record.costLimitMinorUnits as number,
    operatorAvailableStorageBytes: record.storageLimitBytes as number,
    createdAt: record.createdAt as string,
    expiresAt: record.expiresAt as string,
  })
  assertDomain(rebuilt.preflightHash === suppliedHash, 'PERSISTENCE_CONFLICT', 'Stored export matrix preflight does not match canonical policy evaluation')
  return rebuilt
}

export type ExportMatrixCellRuntimeStatus = 'awaiting-dispatch' | 'queued' | 'running' | 'retrying' | 'ready' | 'failed' | 'canceled'
export type ExportMatrixRuntimeStatus = 'queued' | 'running' | 'partially-failed' | 'ready' | 'failed' | 'canceled'

export function deriveExportMatrixRuntimeStatus(statuses: readonly ExportMatrixCellRuntimeStatus[]): ExportMatrixRuntimeStatus {
  assertDomain(Array.isArray(statuses) && statuses.length >= 1 && statuses.length <= MAX_EXPORT_MATRIX_CELLS, 'INVALID_ARGUMENT', 'Export matrix runtime statuses are invalid')
  if (statuses.every((status) => status === 'ready')) return 'ready'
  if (statuses.every((status) => status === 'failed')) return 'failed'
  if (statuses.every((status) => status === 'canceled')) return 'canceled'
  if (statuses.some((status) => status === 'failed' || status === 'canceled')) return 'partially-failed'
  if (statuses.some((status) => status === 'running' || status === 'retrying' || status === 'ready')) return 'running'
  return 'queued'
}
