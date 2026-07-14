import { assertDomain } from './errors.ts'

export const PUBLIC_OPERATION_STATUSES = [
  'queued',
  'running',
  'waiting',
  'retrying',
  'succeeded',
  'failed',
  'canceled',
] as const

export type PublicOperationStatus = (typeof PUBLIC_OPERATION_STATUSES)[number]

export const PUBLIC_OPERATION_PHASES = [
  'queued',
  'materializing',
  'rendering',
  'verifying',
  'persisting',
  'waiting',
  'retrying',
  'completed',
  'failed',
  'canceled',
] as const

export type PublicOperationPhase = (typeof PUBLIC_OPERATION_PHASES)[number]

export interface PublicOperationProgress {
  completed: number
  total?: number
  unit?: string
}

export interface PublicOperationTarget {
  type: 'media-artifact'
  id: string
  manifestId: string
}

export interface PublicOperationResult {
  resource: PublicOperationTarget
}

export interface PublicOperationError {
  code: string
  message: string
  retryable: boolean
}

export interface PublicOperation {
  schemaVersion: 'public-operation/v1'
  id: string
  workspaceId: string
  clientId: string
  type: 'artifact-render'
  status: PublicOperationStatus
  phase: PublicOperationPhase
  progress?: PublicOperationProgress
  cancelable: boolean
  retryable: boolean
  target: PublicOperationTarget
  result?: PublicOperationResult
  error?: PublicOperationError
  attempt: number
  maxAttempts: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TERMINAL_STATUSES = new Set<PublicOperationStatus>([
  'succeeded',
  'failed',
  'canceled',
])

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    ID_PATTERN.test(normalized),
    'INVALID_PUBLIC_OPERATION',
    `${field} must contain 3 to 128 safe characters`,
  )
  return normalized
}

function validateToken(value: string, field: string): string {
  const normalized = value.trim().toLowerCase()
  assertDomain(
    TOKEN_PATTERN.test(normalized),
    'INVALID_PUBLIC_OPERATION',
    `${field} must be a portable token`,
  )
  return normalized
}

function validateDate(value: string, field: string): string {
  const date = new Date(value)
  assertDomain(
    !Number.isNaN(date.getTime()),
    'INVALID_PUBLIC_OPERATION',
    `${field} must be a valid date`,
  )
  return date.toISOString()
}

function validateProgress(
  progress: PublicOperationProgress | undefined,
): PublicOperationProgress | undefined {
  if (!progress) return undefined
  assertDomain(
    Number.isSafeInteger(progress.completed) && progress.completed >= 0,
    'INVALID_PUBLIC_OPERATION',
    'progress.completed must be a non-negative safe integer',
  )
  if (progress.total !== undefined) {
    assertDomain(
      Number.isSafeInteger(progress.total) &&
        progress.total > 0 &&
        progress.completed <= progress.total,
      'INVALID_PUBLIC_OPERATION',
      'progress.total must be positive and not smaller than completed',
    )
  }
  const unit = progress.unit === undefined
    ? undefined
    : validateToken(progress.unit, 'progress.unit')
  return {
    completed: progress.completed,
    ...(progress.total !== undefined ? { total: progress.total } : {}),
    ...(unit ? { unit } : {}),
  }
}

function validateError(error: PublicOperationError): PublicOperationError {
  const code = validateToken(error.code, 'error.code')
  const message = error.message.trim()
  assertDomain(
    message.length > 0 && message.length <= 500,
    'INVALID_PUBLIC_OPERATION',
    'error.message must contain 1 to 500 characters',
  )
  return { code, message, retryable: error.retryable }
}

export function assertPublicOperation(operation: PublicOperation): void {
  assertDomain(
    operation.schemaVersion === 'public-operation/v1',
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation schemaVersion is invalid',
  )
  validateId(operation.id, 'operation.id')
  validateId(operation.workspaceId, 'operation.workspaceId')
  validateId(operation.clientId, 'operation.clientId')
  assertDomain(
    operation.type === 'artifact-render',
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation type is invalid',
  )
  assertDomain(
    PUBLIC_OPERATION_STATUSES.includes(operation.status),
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation status is invalid',
  )
  assertDomain(
    PUBLIC_OPERATION_PHASES.includes(operation.phase),
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation phase is invalid',
  )
  assertDomain(
    operation.target.type === 'media-artifact',
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation target type is invalid',
  )
  validateId(operation.target.id, 'operation.target.id')
  validateId(operation.target.manifestId, 'operation.target.manifestId')
  validateProgress(operation.progress)
  assertDomain(
    Number.isSafeInteger(operation.attempt) && operation.attempt >= 0,
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation attempt must be a non-negative safe integer',
  )
  assertDomain(
    Number.isSafeInteger(operation.maxAttempts) &&
      operation.maxAttempts > 0 &&
      operation.attempt <= operation.maxAttempts,
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation maxAttempts is invalid',
  )
  const createdAt = validateDate(operation.createdAt, 'operation.createdAt')
  const updatedAt = validateDate(operation.updatedAt, 'operation.updatedAt')
  assertDomain(
    Date.parse(updatedAt) >= Date.parse(createdAt),
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation updatedAt cannot precede createdAt',
  )
  const startedAt = operation.startedAt
    ? validateDate(operation.startedAt, 'operation.startedAt')
    : undefined
  const completedAt = operation.completedAt
    ? validateDate(operation.completedAt, 'operation.completedAt')
    : undefined
  if (startedAt) {
    assertDomain(
      Date.parse(startedAt) >= Date.parse(createdAt),
      'INVALID_PUBLIC_OPERATION',
      'PublicOperation startedAt cannot precede createdAt',
    )
  }
  if (completedAt) {
    assertDomain(
      Date.parse(completedAt) >= Date.parse(startedAt ?? createdAt),
      'INVALID_PUBLIC_OPERATION',
      'PublicOperation completedAt cannot precede its start',
    )
  }

  if (operation.status === 'queued') {
    assertDomain(
      operation.phase === 'queued' &&
        operation.attempt === 0 &&
        !operation.startedAt &&
        !operation.completedAt &&
        !operation.result &&
        !operation.error &&
        operation.cancelable &&
        !operation.retryable,
      'INVALID_PUBLIC_OPERATION',
      'Queued PublicOperation invariants are invalid',
    )
  }
  if (operation.status === 'running') {
    assertDomain(
      !['queued', 'waiting', 'retrying', 'completed', 'failed', 'canceled'].includes(
        operation.phase,
      ) &&
        operation.attempt > 0 &&
        Boolean(operation.startedAt) &&
        !operation.completedAt &&
        !operation.result &&
        !operation.error &&
        operation.cancelable &&
        !operation.retryable,
      'INVALID_PUBLIC_OPERATION',
      'Running PublicOperation invariants are invalid',
    )
  }
  if (operation.status === 'waiting' || operation.status === 'retrying') {
    assertDomain(
      operation.phase === operation.status &&
        operation.attempt > 0 &&
        Boolean(operation.startedAt) &&
        !operation.completedAt &&
        !operation.result &&
        !operation.error &&
        operation.cancelable,
      'INVALID_PUBLIC_OPERATION',
      'Waiting or retrying PublicOperation invariants are invalid',
    )
  }
  if (operation.status === 'succeeded') {
    assertDomain(
      operation.phase === 'completed' &&
        Boolean(operation.startedAt) &&
        Boolean(operation.completedAt) &&
        Boolean(operation.result) &&
        !operation.error &&
        !operation.cancelable &&
        !operation.retryable,
      'INVALID_PUBLIC_OPERATION',
      'Succeeded PublicOperation invariants are invalid',
    )
    assertDomain(
      operation.result?.resource.type === operation.target.type &&
        operation.result.resource.id === operation.target.id &&
        operation.result.resource.manifestId === operation.target.manifestId,
      'INVALID_PUBLIC_OPERATION',
      'PublicOperation result must reference its exact target',
    )
  }
  if (operation.status === 'failed') {
    const error = operation.error ? validateError(operation.error) : undefined
    assertDomain(
      operation.phase === 'failed' &&
        Boolean(operation.startedAt) &&
        Boolean(operation.completedAt) &&
        Boolean(error) &&
        !operation.result &&
        !operation.cancelable &&
        operation.retryable === error?.retryable,
      'INVALID_PUBLIC_OPERATION',
      'Failed PublicOperation invariants are invalid',
    )
  }
  if (operation.status === 'canceled') {
    assertDomain(
      operation.phase === 'canceled' &&
        Boolean(operation.completedAt) &&
        !operation.result &&
        !operation.error &&
        !operation.cancelable &&
        !operation.retryable,
      'INVALID_PUBLIC_OPERATION',
      'Canceled PublicOperation invariants are invalid',
    )
  }
}

function freezeOperation(operation: PublicOperation): Readonly<PublicOperation> {
  assertPublicOperation(operation)
  return Object.freeze({
    ...operation,
    ...(operation.progress
      ? { progress: Object.freeze({ ...operation.progress }) }
      : {}),
    target: Object.freeze({ ...operation.target }),
    ...(operation.result
      ? {
          result: Object.freeze({
            resource: Object.freeze({ ...operation.result.resource }),
          }),
        }
      : {}),
    ...(operation.error ? { error: Object.freeze({ ...operation.error }) } : {}),
  })
}

export function createQueuedPublicOperation(input: {
  id: string
  workspaceId: string
  clientId: string
  type: 'artifact-render'
  target: PublicOperationTarget
  maxAttempts?: number
  createdAt: string
}): Readonly<PublicOperation> {
  const createdAt = validateDate(input.createdAt, 'createdAt')
  return freezeOperation({
    schemaVersion: 'public-operation/v1',
    id: validateId(input.id, 'id'),
    workspaceId: validateId(input.workspaceId, 'workspaceId'),
    clientId: validateId(input.clientId, 'clientId'),
    type: input.type,
    status: 'queued',
    phase: 'queued',
    progress: { completed: 0, total: 1, unit: 'render' },
    cancelable: true,
    retryable: false,
    target: {
      type: input.target.type,
      id: validateId(input.target.id, 'target.id'),
      manifestId: validateId(input.target.manifestId, 'target.manifestId'),
    },
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    createdAt,
    updatedAt: createdAt,
  })
}

export function rehydratePublicOperation(operation: PublicOperation): Readonly<PublicOperation> {
  return freezeOperation({
    ...operation,
    progress: operation.progress ? validateProgress(operation.progress) : undefined,
    target: { ...operation.target },
    result: operation.result
      ? { resource: { ...operation.result.resource } }
      : undefined,
    error: operation.error ? validateError(operation.error) : undefined,
    createdAt: validateDate(operation.createdAt, 'createdAt'),
    updatedAt: validateDate(operation.updatedAt, 'updatedAt'),
    ...(operation.startedAt
      ? { startedAt: validateDate(operation.startedAt, 'startedAt') }
      : {}),
    ...(operation.completedAt
      ? { completedAt: validateDate(operation.completedAt, 'completedAt') }
      : {}),
  })
}

export function isTerminalPublicOperation(operation: PublicOperation): boolean {
  return TERMINAL_STATUSES.has(operation.status)
}
