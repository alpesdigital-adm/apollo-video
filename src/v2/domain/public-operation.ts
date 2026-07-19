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

export const PUBLIC_OPERATION_TYPES = [
  'artifact-render',
  'media-ingest',
  'project-proxy-render',
  'project-final-export',
] as const
export type PublicOperationType = (typeof PUBLIC_OPERATION_TYPES)[number]

export function requiresArtifactRenderCheckpoint(type: PublicOperationType): boolean {
  return type === 'artifact-render'
}

function isRenderOperation(type: PublicOperationType): boolean {
  return type === 'artifact-render' || type === 'project-proxy-render' || type === 'project-final-export'
}

export const PUBLIC_OPERATION_PHASES = [
  'queued',
  'materializing',
  'rendering',
  'assembling',
  'probing',
  'normalizing',
  'transcribing',
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
  type: PublicOperationType
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
  nextAttemptAt?: string
  deadLetteredAt?: string
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TERMINAL_STATUSES = new Set<PublicOperationStatus>([
  'succeeded',
  'failed',
  'canceled',
])
const RENDER_PHASE_ORDER = [
  'materializing',
  'rendering',
  'verifying',
  'persisting',
] as const

const INGEST_PHASE_ORDER = [
  'assembling',
  'probing',
  'normalizing',
  'transcribing',
  'verifying',
  'persisting',
] as const

export type PublicOperationRunningPhase =
  | (typeof RENDER_PHASE_ORDER)[number]
  | (typeof INGEST_PHASE_ORDER)[number]

function runningPhasesFor(type: PublicOperationType): readonly PublicOperationRunningPhase[] {
  return isRenderOperation(type) ? RENDER_PHASE_ORDER : INGEST_PHASE_ORDER
}

function progressUnit(type: PublicOperationType): string {
  return isRenderOperation(type) ? 'render' : 'stage'
}

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
    PUBLIC_OPERATION_TYPES.includes(operation.type),
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
  const nextAttemptAt = operation.nextAttemptAt
    ? validateDate(operation.nextAttemptAt, 'operation.nextAttemptAt')
    : undefined
  const deadLetteredAt = operation.deadLetteredAt
    ? validateDate(operation.deadLetteredAt, 'operation.deadLetteredAt')
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
  if (nextAttemptAt) {
    assertDomain(
      Date.parse(nextAttemptAt) > Date.parse(updatedAt),
      'INVALID_PUBLIC_OPERATION',
      'PublicOperation nextAttemptAt must follow its latest transition',
    )
  }
  if (deadLetteredAt) {
    assertDomain(
      deadLetteredAt === completedAt,
      'INVALID_PUBLIC_OPERATION',
      'PublicOperation deadLetteredAt must match terminal completion',
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
        !nextAttemptAt &&
        !deadLetteredAt &&
        operation.cancelable &&
        !operation.retryable,
      'INVALID_PUBLIC_OPERATION',
      'Queued PublicOperation invariants are invalid',
    )
  }
  if (operation.status === 'running') {
    assertDomain(
      runningPhasesFor(operation.type).includes(operation.phase as PublicOperationRunningPhase) &&
        operation.attempt > 0 &&
        Boolean(operation.startedAt) &&
        !operation.completedAt &&
        !operation.result &&
        !operation.error &&
        !nextAttemptAt &&
        !deadLetteredAt &&
        operation.cancelable &&
        !operation.retryable,
      'INVALID_PUBLIC_OPERATION',
      'Running PublicOperation invariants are invalid',
    )
  }
  if (operation.status === 'waiting') {
    assertDomain(
      operation.phase === 'waiting' &&
        operation.attempt > 0 &&
        Boolean(operation.startedAt) &&
        !operation.completedAt &&
        !operation.result &&
        !operation.error &&
        !nextAttemptAt &&
        !deadLetteredAt &&
        operation.cancelable,
      'INVALID_PUBLIC_OPERATION',
      'Waiting PublicOperation invariants are invalid',
    )
  }
  if (operation.status === 'retrying') {
    assertDomain(
      operation.phase === 'retrying' &&
        operation.attempt > 0 &&
        Boolean(operation.startedAt) &&
        !operation.completedAt &&
        !operation.result &&
        !operation.error &&
        Boolean(nextAttemptAt) &&
        !deadLetteredAt &&
        operation.cancelable &&
        operation.retryable,
      'INVALID_PUBLIC_OPERATION',
      'Retrying PublicOperation invariants are invalid',
    )
  }
  if (operation.status === 'succeeded') {
    assertDomain(
      operation.phase === 'completed' &&
        Boolean(operation.startedAt) &&
        Boolean(operation.completedAt) &&
        Boolean(operation.result) &&
        !operation.error &&
        !nextAttemptAt &&
        !deadLetteredAt &&
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
        !nextAttemptAt &&
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
        !nextAttemptAt &&
        !deadLetteredAt &&
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

function transitionDate(operation: PublicOperation, value: string): string {
  const updatedAt = validateDate(value, 'updatedAt')
  assertDomain(
    Date.parse(updatedAt) >= Date.parse(operation.updatedAt),
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation transition cannot move time backwards',
  )
  return updatedAt
}

export function createQueuedPublicOperation(input: {
  id: string
  workspaceId: string
  clientId: string
  type: PublicOperationType
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
    progress: { completed: 0, total: 1, unit: progressUnit(input.type) },
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
    ...(operation.nextAttemptAt
      ? { nextAttemptAt: validateDate(operation.nextAttemptAt, 'nextAttemptAt') }
      : {}),
    ...(operation.deadLetteredAt
      ? { deadLetteredAt: validateDate(operation.deadLetteredAt, 'deadLetteredAt') }
      : {}),
  })
}

export function startPublicOperationAttempt(
  operation: PublicOperation,
  updatedAtValue: string,
): Readonly<PublicOperation> {
  assertPublicOperation(operation)
  assertDomain(
    ['queued', 'retrying', 'running'].includes(operation.status) &&
      operation.attempt < operation.maxAttempts,
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation cannot start another attempt',
  )
  const updatedAt = transitionDate(operation, updatedAtValue)
  assertDomain(
    operation.status !== 'retrying' ||
      (Boolean(operation.nextAttemptAt) &&
        Date.parse(updatedAt) >= Date.parse(operation.nextAttemptAt as string)),
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation retry is not available yet',
  )
  return freezeOperation({
    ...operation,
    status: 'running',
    phase: isRenderOperation(operation.type) ? 'materializing' : 'assembling',
    progress: {
      completed: 0,
      total: runningPhasesFor(operation.type).length,
      unit: progressUnit(operation.type),
    },
    cancelable: true,
    retryable: false,
    attempt: operation.attempt + 1,
    updatedAt,
    startedAt: operation.startedAt ?? updatedAt,
    completedAt: undefined,
    nextAttemptAt: undefined,
    deadLetteredAt: undefined,
    result: undefined,
    error: undefined,
  })
}

export function advancePublicOperationPhase(
  operation: PublicOperation,
  phase: PublicOperationRunningPhase,
  updatedAtValue: string,
): Readonly<PublicOperation> {
  assertPublicOperation(operation)
  const order = runningPhasesFor(operation.type)
  const currentIndex = order.indexOf(operation.phase as PublicOperationRunningPhase)
  const nextIndex = order.indexOf(phase)
  assertDomain(
    operation.status === 'running' && currentIndex >= 0 && nextIndex >= currentIndex,
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation phase transition is invalid',
  )
  return freezeOperation({
    ...operation,
    phase,
    progress: { completed: nextIndex, total: order.length, unit: progressUnit(operation.type) },
    updatedAt: transitionDate(operation, updatedAtValue),
  })
}

export function succeedPublicOperation(
  operation: PublicOperation,
  updatedAtValue: string,
): Readonly<PublicOperation> {
  assertPublicOperation(operation)
  assertDomain(
    operation.status === 'running' && operation.phase === 'persisting',
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation can only succeed after persistence',
  )
  const completedAt = transitionDate(operation, updatedAtValue)
  return freezeOperation({
    ...operation,
    status: 'succeeded',
    phase: 'completed',
    progress: {
      completed: runningPhasesFor(operation.type).length,
      total: runningPhasesFor(operation.type).length,
      unit: progressUnit(operation.type),
    },
    cancelable: false,
    retryable: false,
    result: { resource: { ...operation.target } },
    error: undefined,
    updatedAt: completedAt,
    completedAt,
    nextAttemptAt: undefined,
    deadLetteredAt: undefined,
  })
}

export function retryOrFailPublicOperation(
  operation: PublicOperation,
  error: PublicOperationError,
  updatedAtValue: string,
  nextAttemptAtValue?: string,
): Readonly<PublicOperation> {
  assertPublicOperation(operation)
  assertDomain(
    operation.status === 'running',
    'INVALID_PUBLIC_OPERATION',
    'Only a running PublicOperation can record an attempt failure',
  )
  const safeError = validateError(error)
  const updatedAt = transitionDate(operation, updatedAtValue)
  if (safeError.retryable && operation.attempt < operation.maxAttempts) {
    const nextAttemptAt = nextAttemptAtValue
      ? validateDate(nextAttemptAtValue, 'nextAttemptAt')
      : undefined
    assertDomain(
      Boolean(nextAttemptAt) && Date.parse(nextAttemptAt as string) > Date.parse(updatedAt),
      'INVALID_PUBLIC_OPERATION',
      'Retryable PublicOperation failure requires a future nextAttemptAt',
    )
    return freezeOperation({
      ...operation,
      status: 'retrying',
      phase: 'retrying',
      cancelable: true,
      retryable: true,
      result: undefined,
      error: undefined,
      updatedAt,
      completedAt: undefined,
      nextAttemptAt,
      deadLetteredAt: undefined,
    })
  }
  assertDomain(
    nextAttemptAtValue === undefined,
    'INVALID_PUBLIC_OPERATION',
    'Terminal PublicOperation failure cannot schedule another attempt',
  )
  const terminalError = { ...safeError, retryable: false }
  const exhausted = safeError.retryable && operation.attempt >= operation.maxAttempts
  return freezeOperation({
    ...operation,
    status: 'failed',
    phase: 'failed',
    cancelable: false,
    retryable: false,
    result: undefined,
    error: terminalError,
    updatedAt,
    completedAt: updatedAt,
    nextAttemptAt: undefined,
    deadLetteredAt: exhausted ? updatedAt : undefined,
  })
}

export function cancelPublicOperation(
  operation: PublicOperation,
  updatedAtValue: string,
): Readonly<PublicOperation> {
  assertPublicOperation(operation)
  if (isTerminalPublicOperation(operation)) {
    return freezeOperation({ ...operation })
  }
  assertDomain(
    operation.cancelable &&
      ['queued', 'running', 'waiting', 'retrying'].includes(operation.status),
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation cannot be canceled in its current state',
  )
  const completedAt = transitionDate(operation, updatedAtValue)
  return freezeOperation({
    ...operation,
    status: 'canceled',
    phase: 'canceled',
    cancelable: false,
    retryable: false,
    result: undefined,
    error: undefined,
    updatedAt: completedAt,
    completedAt,
    nextAttemptAt: undefined,
    deadLetteredAt: undefined,
  })
}

export function retryPublicOperation(
  operation: PublicOperation,
  updatedAtValue: string,
  nextAttemptAtValue: string,
): Readonly<PublicOperation> {
  assertPublicOperation(operation)
  if (!isTerminalPublicOperation(operation)) {
    return freezeOperation({ ...operation })
  }
  assertDomain(
    operation.status === 'failed' || operation.status === 'canceled',
    'PUBLIC_OPERATION_RETRY_REJECTED',
    'A succeeded PublicOperation cannot be retried',
  )
  const updatedAt = transitionDate(operation, updatedAtValue)
  const maxAttempts = operation.attempt >= operation.maxAttempts
    ? operation.attempt + 1
    : operation.maxAttempts
  if (operation.attempt === 0) {
    return freezeOperation({
      ...operation,
      status: 'queued',
      phase: 'queued',
      cancelable: true,
      retryable: false,
      result: undefined,
      error: undefined,
      maxAttempts,
      updatedAt,
      startedAt: undefined,
      completedAt: undefined,
      nextAttemptAt: undefined,
      deadLetteredAt: undefined,
    })
  }
  const nextAttemptAt = validateDate(nextAttemptAtValue, 'nextAttemptAt')
  assertDomain(
    Date.parse(nextAttemptAt) > Date.parse(updatedAt),
    'INVALID_PUBLIC_OPERATION',
    'Manual retry requires a future nextAttemptAt',
  )
  return freezeOperation({
    ...operation,
    status: 'retrying',
    phase: 'retrying',
    cancelable: true,
    retryable: true,
    result: undefined,
    error: undefined,
    maxAttempts,
    updatedAt,
    completedAt: undefined,
    nextAttemptAt,
    deadLetteredAt: undefined,
  })
}

export function isTerminalPublicOperation(operation: PublicOperation): boolean {
  return TERMINAL_STATUSES.has(operation.status)
}
