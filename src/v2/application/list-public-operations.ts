import { createHash } from 'node:crypto'

import { DomainError, assertDomain } from '../domain/errors.ts'
import {
  PUBLIC_OPERATION_STATUSES,
  type PublicOperation,
  type PublicOperationStatus,
} from '../domain/public-operation.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,1024}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const OPERATION_TYPES = ['artifact-render'] as const

interface OperationCursor {
  v: 1
  createdAt: string
  id: string
  filterHash: string
}

export interface ListPublicOperationsRequest {
  workspaceId: string
  limit?: number
  after?: string
  status?: string
  type?: string
  targetId?: string
  deadLettered?: boolean
}

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    ID_PATTERN.test(normalized),
    'INVALID_ARGUMENT',
    `${field} must contain 3 to 128 safe characters`,
  )
  return normalized
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function filterHash(input: {
  workspaceId: string
  status?: PublicOperationStatus
  type?: PublicOperation['type']
  targetId?: string
  deadLettered?: boolean
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      workspaceId: input.workspaceId,
      status: input.status ?? null,
      type: input.type ?? null,
      targetId: input.targetId ?? null,
      deadLettered: input.deadLettered ?? null,
    }))
    .digest('hex')
}

function encodeCursor(cursor: OperationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string, expectedFilterHash: string): OperationCursor {
  assertDomain(
    CURSOR_PATTERN.test(value),
    'INVALID_ARGUMENT',
    'after must be a valid operation cursor',
  )
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    assertDomain(
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
      'INVALID_ARGUMENT',
      'after must be a valid operation cursor',
    )
    const cursor = parsed as Record<string, unknown>
    assertDomain(
      Object.keys(cursor).length === 4 &&
        cursor.v === 1 &&
        typeof cursor.createdAt === 'string' &&
        typeof cursor.id === 'string' &&
        typeof cursor.filterHash === 'string' &&
        new Date(cursor.createdAt).toISOString() === cursor.createdAt &&
        ID_PATTERN.test(cursor.id) &&
        SHA256_PATTERN.test(cursor.filterHash) &&
        cursor.filterHash === expectedFilterHash,
      'INVALID_ARGUMENT',
      'after does not match this operation query',
    )
    return cursor as unknown as OperationCursor
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('INVALID_ARGUMENT', 'after must be a valid operation cursor')
  }
}

export function listPublicOperationsService(dependencies: {
  operations: PublicOperationRepository
}) {
  return async function listPublicOperations(request: ListPublicOperationsRequest) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const limit = request.limit ?? 20
    assertDomain(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer from 1 to 100',
    )

    const statusValue = normalizeOptional(request.status)
    assertDomain(
      !statusValue || PUBLIC_OPERATION_STATUSES.includes(statusValue as PublicOperationStatus),
      'INVALID_ARGUMENT',
      'status is not supported',
    )
    const status = statusValue as PublicOperationStatus | undefined

    const typeValue = normalizeOptional(request.type)
    assertDomain(
      !typeValue || OPERATION_TYPES.includes(typeValue as PublicOperation['type']),
      'INVALID_ARGUMENT',
      'type is not supported',
    )
    const type = typeValue as PublicOperation['type'] | undefined
    const targetIdValue = normalizeOptional(request.targetId)
    const targetId = targetIdValue ? validateId(targetIdValue, 'targetId') : undefined
    assertDomain(
      request.deadLettered === undefined || typeof request.deadLettered === 'boolean',
      'INVALID_ARGUMENT',
      'deadLettered must be a boolean',
    )
    const deadLettered = request.deadLettered
    const queryFilterHash = filterHash({ workspaceId, status, type, targetId, deadLettered })
    const afterValue = normalizeOptional(request.after)
    const after = afterValue ? decodeCursor(afterValue, queryFilterHash) : undefined

    const records = await dependencies.operations.list({
      workspaceId,
      limit: limit + 1,
      status,
      type,
      targetId,
      deadLettered,
      ...(after ? { after: { createdAt: after.createdAt, id: after.id } } : {}),
    })
    const hasNextPage = records.length > limit
    const page = records.slice(0, limit)
    const last = page.at(-1)?.operation
    return {
      operations: page.map((record) => record.operation),
      ...(hasNextPage && last
        ? {
            nextCursor: encodeCursor({
              v: 1,
              createdAt: last.createdAt,
              id: last.id,
              filterHash: queryFilterHash,
            }),
          }
        : {}),
    }
  }
}
