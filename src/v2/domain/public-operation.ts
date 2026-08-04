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
  'source-cleanup',
  'long-form-index',
  'project-director-run',
] as const
export type PublicOperationType = (typeof PUBLIC_OPERATION_TYPES)[number]

export function requiresArtifactRenderCheckpoint(type: PublicOperationType): boolean {
  return type === 'artifact-render'
}

function isRenderOperation(type: PublicOperationType): boolean {
  return type === 'artifact-render' ||
    type === 'project-proxy-render' ||
    type === 'project-final-export' ||
    type === 'source-cleanup'
}

function isLongFormIndexOperation(
  type: PublicOperationType,
): boolean {
  return type === 'long-form-index'
}

function isDirectorOperation(type: PublicOperationType): boolean {
  return type === 'project-director-run'
}

export const PUBLIC_OPERATION_PHASES = [
  'queued',
  'materializing',
  'rendering',
  'assembling',
  'probing',
  'normalizing',
  'transcribing',
  'diarizing',
  'chunking',
  'indexing',
  'directing',
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

export type PublicOperationTarget =
  | Readonly<{
      type: 'media-artifact'
      id: string
      manifestId: string
    }>
  | Readonly<{
      type: 'project-version'
      id: string
    }>

export interface PublicOperationResult {
  resource: PublicOperationTarget
}

export interface PublicOperationError {
  code: string
  message: string
  retryable: boolean
}

export interface PublicOperationEstimatedCost {
  currency: 'USD'
  estimatedMinorUnits: number
  maximumMinorUnits: number
}

export interface PublicOperationActualCost {
  currency: 'USD'
  minorUnits: number
}

export interface PublicOperation {
  schemaVersion: 'public-operation/v1'
  id: string
  workspaceId: string
  projectId?: string
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
  estimatedCost?: PublicOperationEstimatedCost
  actualCost?: PublicOperationActualCost
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
const MAX_COST_MINOR_UNITS = 10_000_000
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

const LONG_FORM_INDEX_PHASE_ORDER = [
  'probing',
  'transcribing',
  'diarizing',
  'chunking',
  'indexing',
  'persisting',
] as const

const DIRECTOR_PHASE_ORDER = [
  'directing',
  'persisting',
] as const

export type PublicOperationRunningPhase =
  | (typeof RENDER_PHASE_ORDER)[number]
  | (typeof INGEST_PHASE_ORDER)[number]
  | (typeof LONG_FORM_INDEX_PHASE_ORDER)[number]
  | (typeof DIRECTOR_PHASE_ORDER)[number]

function runningPhasesFor(type: PublicOperationType): readonly PublicOperationRunningPhase[] {
  if (isRenderOperation(type)) return RENDER_PHASE_ORDER
  if (isLongFormIndexOperation(type)) {
    return LONG_FORM_INDEX_PHASE_ORDER
  }
  if (isDirectorOperation(type)) return DIRECTOR_PHASE_ORDER
  return INGEST_PHASE_ORDER
}

function progressUnit(type: PublicOperationType): string {
  return isRenderOperation(type) ? 'render' : 'stage'
}

function canonicalProgressFor(
  operation: Pick<PublicOperation, 'type' | 'status' | 'phase' | 'progress'>,
): boolean {
  const phases = runningPhasesFor(operation.type)
  const progress = operation.progress
  if (
    !progress ||
    progress.total !== phases.length ||
    progress.unit !== progressUnit(operation.type)
  ) return false

  if (operation.status === 'queued') return progress.completed === 0
  if (operation.status === 'succeeded') return progress.completed === phases.length
  if (operation.status === 'running') {
    return progress.completed === phases.indexOf(
      operation.phase as PublicOperationRunningPhase,
    )
  }
  return progress.completed >= 0 && progress.completed < phases.length
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

function validateTarget(target: PublicOperationTarget, field: string): void {
  assertDomain(
    target.type === 'media-artifact' || target.type === 'project-version',
    'INVALID_PUBLIC_OPERATION',
    `${field}.type is invalid`,
  )
  validateId(target.id, `${field}.id`)
  if (target.type === 'media-artifact') {
    validateId(target.manifestId, `${field}.manifestId`)
  } else {
    assertDomain(
      !('manifestId' in target),
      'INVALID_PUBLIC_OPERATION',
      `${field}.manifestId is not valid for a project version`,
    )
  }
}

function sameTarget(
  left: PublicOperationTarget,
  right: PublicOperationTarget,
): boolean {
  return left.type === right.type &&
    left.id === right.id &&
    (left.type !== 'media-artifact' ||
      (right.type === 'media-artifact' && left.manifestId === right.manifestId))
}

function validateEstimatedCost(
  value: PublicOperationEstimatedCost,
): PublicOperationEstimatedCost {
  assertDomain(
    value.currency === 'USD' &&
      Number.isSafeInteger(value.estimatedMinorUnits) &&
      value.estimatedMinorUnits >= 0 &&
      value.estimatedMinorUnits <= MAX_COST_MINOR_UNITS &&
      Number.isSafeInteger(value.maximumMinorUnits) &&
      value.maximumMinorUnits >= value.estimatedMinorUnits &&
      value.maximumMinorUnits <= MAX_COST_MINOR_UNITS,
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation estimated cost is invalid',
  )
  return {
    currency: 'USD',
    estimatedMinorUnits: value.estimatedMinorUnits,
    maximumMinorUnits: value.maximumMinorUnits,
  }
}

function validateActualCost(
  value: PublicOperationActualCost,
): PublicOperationActualCost {
  assertDomain(
    value.currency === 'USD' &&
      Number.isSafeInteger(value.minorUnits) &&
      value.minorUnits >= 0 &&
      value.minorUnits <= MAX_COST_MINOR_UNITS,
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation actual cost is invalid',
  )
  return { currency: 'USD', minorUnits: value.minorUnits }
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
  if (operation.type === 'artifact-render') {
    assertDomain(
      operation.projectId === undefined,
      'INVALID_PUBLIC_OPERATION',
      'Artifact-global operations must not declare projectId',
    )
  } else {
    assertDomain(
      operation.projectId !== undefined,
      'INVALID_PUBLIC_OPERATION',
      'Project-bound operations must declare projectId',
    )
    validateId(operation.projectId, 'operation.projectId')
  }
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
  validateTarget(operation.target, 'operation.target')
  assertDomain(
    operation.type === 'project-director-run'
      ? operation.target.type === 'project-version'
      : operation.target.type === 'media-artifact',
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation type and target are incompatible',
  )
  if (operation.result) validateTarget(operation.result.resource, 'operation.result.resource')
  validateProgress(operation.progress)
  assertDomain(
    canonicalProgressFor(operation),
    'INVALID_PUBLIC_OPERATION',
    'PublicOperation progress must match its type, status and phase',
  )
  if (operation.estimatedCost) {
    validateEstimatedCost(operation.estimatedCost)
    assertDomain(
      operation.type === 'long-form-index',
      'INVALID_PUBLIC_OPERATION',
      'PublicOperation estimated cost requires a persisted cost source',
    )
  }
  if (operation.actualCost) {
    validateActualCost(operation.actualCost)
    assertDomain(
      operation.type === 'long-form-index' &&
        Boolean(operation.estimatedCost) &&
        TERMINAL_STATUSES.has(operation.status) &&
        operation.actualCost.minorUnits <=
          (operation.estimatedCost?.maximumMinorUnits ?? -1),
      'INVALID_PUBLIC_OPERATION',
      'PublicOperation actual cost requires a terminal persisted measurement',
    )
  }
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
      operation.result !== undefined &&
        sameTarget(operation.result.resource, operation.target),
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
    ...(operation.estimatedCost
      ? { estimatedCost: Object.freeze({ ...operation.estimatedCost }) }
      : {}),
    ...(operation.actualCost
      ? { actualCost: Object.freeze({ ...operation.actualCost }) }
      : {}),
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
  projectId?: string
  clientId: string
  type: PublicOperationType
  target: PublicOperationTarget
  maxAttempts?: number
  estimatedCost?: PublicOperationEstimatedCost
  createdAt: string
}): Readonly<PublicOperation> {
  const createdAt = validateDate(input.createdAt, 'createdAt')
  return freezeOperation({
    schemaVersion: 'public-operation/v1',
    id: validateId(input.id, 'id'),
    workspaceId: validateId(input.workspaceId, 'workspaceId'),
    ...(input.projectId ? { projectId: validateId(input.projectId, 'projectId') } : {}),
    clientId: validateId(input.clientId, 'clientId'),
    type: input.type,
    status: 'queued',
    phase: 'queued',
    progress: {
      completed: 0,
      total: runningPhasesFor(input.type).length,
      unit: progressUnit(input.type),
    },
    cancelable: true,
    retryable: false,
    target: input.target.type === 'media-artifact'
      ? {
          type: 'media-artifact',
          id: validateId(input.target.id, 'target.id'),
          manifestId: validateId(input.target.manifestId, 'target.manifestId'),
        }
      : {
          type: 'project-version',
          id: validateId(input.target.id, 'target.id'),
        },
    ...(input.estimatedCost
      ? { estimatedCost: validateEstimatedCost(input.estimatedCost) }
      : {}),
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
    estimatedCost: operation.estimatedCost
      ? validateEstimatedCost(operation.estimatedCost)
      : undefined,
    actualCost: operation.actualCost
      ? validateActualCost(operation.actualCost)
      : undefined,
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
    phase: runningPhasesFor(operation.type)[0],
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

export function waitPublicOperation(
  operation: PublicOperation,
  updatedAtValue: string,
): Readonly<PublicOperation> {
  assertPublicOperation(operation)
  assertDomain(
    operation.status === 'running',
    'INVALID_PUBLIC_OPERATION',
    'Only a running PublicOperation can wait for a dependency',
  )
  return freezeOperation({
    ...operation,
    status: 'waiting',
    phase: 'waiting',
    cancelable: true,
    retryable: false,
    updatedAt: transitionDate(operation, updatedAtValue),
  })
}

export function resumeWaitingPublicOperation(
  operation: PublicOperation,
  phase: PublicOperationRunningPhase,
  updatedAtValue: string,
): Readonly<PublicOperation> {
  assertPublicOperation(operation)
  const order = runningPhasesFor(operation.type)
  const nextIndex = order.indexOf(phase)
  const completed = operation.progress?.completed ?? 0
  assertDomain(
    operation.status === 'waiting' && nextIndex >= completed,
    'INVALID_PUBLIC_OPERATION',
    'Waiting PublicOperation cannot resume at the requested phase',
  )
  return freezeOperation({
    ...operation,
    status: 'running',
    phase,
    progress: { completed: nextIndex, total: order.length, unit: progressUnit(operation.type) },
    cancelable: true,
    retryable: false,
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
      actualCost: undefined,
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
    actualCost: undefined,
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
      actualCost: undefined,
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
    actualCost: undefined,
  })
}

export function isTerminalPublicOperation(operation: PublicOperation): boolean {
  return TERMINAL_STATUSES.has(operation.status)
}
