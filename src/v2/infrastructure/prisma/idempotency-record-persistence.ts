import type { V2IdempotencyRecord } from '../../../../generated/prisma-v2/index.js'

import { DomainError } from '../../domain/errors.ts'

const MAX_IDEMPOTENCY_RESPONSE_BYTES = 1_048_576

type ReplayRecord = Pick<
  V2IdempotencyRecord,
  | 'id'
  | 'requestFingerprint'
  | 'status'
  | 'responseStatus'
  | 'responseJson'
>

function persistenceConflict(
  record: ReplayRecord,
  message: string,
): never {
  throw new DomainError('PERSISTENCE_CONFLICT', message, {
    idempotencyRecordId: record.id,
  })
}

export function readCompletedIdempotencyResponse(
  record: ReplayRecord,
  expectedRequestFingerprint: string,
): Readonly<Record<string, unknown>> {
  if (record.requestFingerprint !== expectedRequestFingerprint) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Idempotency key was already used with a different request',
      { idempotencyRecordId: record.id },
    )
  }
  if (
    record.status !== 'completed' ||
    !Number.isInteger(record.responseStatus) ||
    record.responseStatus! < 200 ||
    record.responseStatus! > 299 ||
    typeof record.responseJson !== 'string' ||
    Buffer.byteLength(record.responseJson, 'utf8') >
      MAX_IDEMPOTENCY_RESPONSE_BYTES
  ) {
    persistenceConflict(
      record,
      'Completed idempotency record has an invalid response envelope',
    )
  }
  let response: unknown
  try {
    response = JSON.parse(record.responseJson)
  } catch {
    persistenceConflict(record, 'Stored idempotency response is invalid JSON')
  }
  if (
    typeof response !== 'object' ||
    response === null ||
    Array.isArray(response)
  ) {
    persistenceConflict(record, 'Stored idempotency response must be an object')
  }
  return Object.freeze(response as Record<string, unknown>)
}
