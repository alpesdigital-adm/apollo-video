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

/**
 * A Serializable loser can exhaust its immediate retries while the winner of
 * the same idempotency key is still in flight (SSI cancels the loser on
 * identification as a pivot without waiting for the winner to commit). The
 * winner's record is only visible once it commits, so reconciliation must wait
 * for it for a bounded time instead of reading once.
 */
export interface IdempotencyWinnerWait {
  readonly delaysMs: readonly number[]
  readonly sleep: (milliseconds: number) => Promise<void>
}

export const DEFAULT_IDEMPOTENCY_WINNER_WAIT: Readonly<IdempotencyWinnerWait> =
  Object.freeze({
    delaysMs: Object.freeze([25, 50, 100, 200, 400, 800]),
    sleep: (milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds)
      }),
  })

/**
 * Reads the committed winner through `read`, re-reading after each configured
 * delay while `read` reports that nothing is visible yet. Errors thrown by
 * `read` (payload mismatch, corrupted record) are final and never retried.
 */
export async function awaitCommittedIdempotencyWinner<T>(
  read: () => Promise<T | null | undefined>,
  wait: Readonly<IdempotencyWinnerWait> = DEFAULT_IDEMPOTENCY_WINNER_WAIT,
): Promise<T | null> {
  const first = await read()
  if (first != null) return first
  for (const delay of wait.delaysMs) {
    await wait.sleep(delay)
    const next = await read()
    if (next != null) return next
  }
  return null
}
