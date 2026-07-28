import type {
  CommitBatchEditRequest,
  CreateBatchEditPreflightRequest,
} from '../application/batch-edits.ts'
import type {
  BatchEditCommand,
  BatchEditMode,
  BatchEditOperation,
  BatchEditPreflightRun,
} from '../domain/batch-edit.ts'
import { assertDomain } from '../domain/errors.ts'

type ParsedCreateBody = Omit<
  CreateBatchEditPreflightRequest,
  'workspaceId' | 'batchId' | 'actor' | 'idempotencyKey'
>

type ParsedCommitBody = Omit<
  CommitBatchEditRequest,
  | 'workspaceId'
  | 'batchId'
  | 'preflightId'
  | 'actor'
  | 'idempotencyKey'
>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function record(value: unknown, field = 'Request body') {
  assertDomain(
    typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be a JSON object`,
  )
  return value as Record<string, unknown>
}

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field = 'Request body',
) {
  const unexpected = Object.keys(value).filter(
    (key) => !allowed.includes(key),
  )
  assertDomain(
    unexpected.length === 0,
    'INVALID_ARGUMENT',
    `${field} contains unexpected fields: ${unexpected.join(', ')}`,
  )
}

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function ids(value: unknown, field: string): readonly string[] {
  assertDomain(
    Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 1_000,
    'INVALID_ARGUMENT',
    `${field} must contain one to 1000 IDs`,
  )
  const normalized = value.map((item, index) =>
    identity(item, `${field}[${index}]`))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicate IDs`,
  )
  return Object.freeze(normalized)
}

function operation(value: unknown): Readonly<BatchEditOperation> {
  const body = record(value, 'operation')
  exact(body, ['type', 'valueRef'], 'operation')
  assertDomain(
    body.type === 'replace-cta' ||
      body.type === 'subtitle-style' ||
      body.type === 'brand-kit',
    'INVALID_ARGUMENT',
    'operation.type is invalid',
  )
  return Object.freeze({
    type: body.type,
    valueRef: identity(body.valueRef, 'operation.valueRef'),
  })
}

function parsedMode(value: unknown): BatchEditMode | undefined {
  assertDomain(
    value === undefined ||
      value === 'all-or-nothing' ||
      value === 'skip-failures',
    'INVALID_ARGUMENT',
    'mode is invalid',
  )
  return value as BatchEditMode | undefined
}

export function parseCreateBatchEditPreflightBody(
  value: unknown,
): Readonly<ParsedCreateBody> {
  const body = record(value)
  exact(body, [
    'expectedBatchRevision',
    'expectedBatchDefinitionHash',
    'recipeIds',
    'outputSpecIds',
    'itemIds',
    'operation',
    'mode',
  ])
  assertDomain(
    Number.isSafeInteger(body.expectedBatchRevision) &&
      Number(body.expectedBatchRevision) >= 1 &&
      Number(body.expectedBatchRevision) <= 1_000_000,
    'INVALID_ARGUMENT',
    'expectedBatchRevision must be an integer between 1 and 1000000',
  )
  const mode = parsedMode(body.mode)
  return Object.freeze({
    expectedBatchRevision: Number(body.expectedBatchRevision),
    expectedBatchDefinitionHash: hash(
      body.expectedBatchDefinitionHash,
      'expectedBatchDefinitionHash',
    ),
    recipeIds: ids(body.recipeIds, 'recipeIds'),
    outputSpecIds: ids(body.outputSpecIds, 'outputSpecIds'),
    itemIds: ids(body.itemIds, 'itemIds'),
    operation: operation(body.operation),
    ...(mode ? { mode } : {}),
  })
}

export function parseCommitBatchEditBody(
  value: unknown,
): Readonly<ParsedCommitBody> {
  const body = record(value)
  exact(body, [
    'expectedPreflightHash',
    'expectedScopeHash',
    'commitToken',
  ])
  assertDomain(
    typeof body.commitToken === 'string' &&
      body.commitToken.length >= 32 &&
      body.commitToken.length <= 4_096 &&
      /^[\x21-\x7E]+$/.test(body.commitToken),
    'INVALID_ARGUMENT',
    'commitToken is invalid',
  )
  return Object.freeze({
    expectedPreflightHash: hash(
      body.expectedPreflightHash,
      'expectedPreflightHash',
    ),
    expectedScopeHash: hash(
      body.expectedScopeHash,
      'expectedScopeHash',
    ),
    commitToken: body.commitToken,
  })
}

export function presentBatchEditPreflight(
  run: Readonly<BatchEditPreflightRun>,
) {
  return run
}

export function presentBatchEditPreflightPage(input: {
  preflights: readonly Readonly<BatchEditPreflightRun>[]
  nextCursor?: string
}) {
  return Object.freeze({
    preflights: Object.freeze(
      input.preflights.map(presentBatchEditPreflight),
    ),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}

export function presentBatchEditCommand(
  command: Readonly<BatchEditCommand>,
) {
  return command
}

export function presentBatchEditCommandPage(input: {
  commands: readonly Readonly<BatchEditCommand>[]
  nextCursor?: string
}) {
  return Object.freeze({
    commands: Object.freeze(
      input.commands.map(presentBatchEditCommand),
    ),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}
