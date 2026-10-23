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

const BASE_IDEMPOTENCY_WINNER_WAIT: Readonly<IdempotencyWinnerWait> = Object.freeze({
  delaysMs: Object.freeze([25, 50, 100, 200, 400, 800]),
  sleep: (milliseconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds)
    }),
})

let configuredWinnerWait: Readonly<IdempotencyWinnerWait> = BASE_IDEMPOTENCY_WINNER_WAIT

/**
 * The process-wide default every repository uses (constructor parameters and the sweep helpers read it at call time).
 * Tests replace it to inject the ordering of a lost race and call the returned function to restore the previous one.
 */
export function configureIdempotencyWinnerWait(
  wait: Readonly<IdempotencyWinnerWait>,
): () => void {
  const previous = configuredWinnerWait
  configuredWinnerWait = wait
  return () => {
    configuredWinnerWait = previous
  }
}

export const DEFAULT_IDEMPOTENCY_WINNER_WAIT: Readonly<IdempotencyWinnerWait> =
  Object.freeze({
    get delaysMs() {
      return configuredWinnerWait.delaysMs
    },
    sleep: (milliseconds: number) => configuredWinnerWait.sleep(milliseconds),
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

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

/**
 * Reconciles a lost idempotency race from inside a repository's catch block.
 * - P2034 (Serializable cancelled the loser while the winner may still be in flight): the winner's record is read with
 *   the bounded wait, so the loser answers exactly as a sequential duplicate would (replay or payload mismatch).
 * - anything else (P2002: the unique insert already waited for the winner's commit): one read, as before.
 * `read` returns null when no committed winner is visible and throws the mismatch itself.
 */
export async function reconcileAfterConflict<T>(
  error: unknown,
  read: () => Promise<T | null | undefined>,
  wait: Readonly<IdempotencyWinnerWait> = DEFAULT_IDEMPOTENCY_WINNER_WAIT,
): Promise<T | null> {
  if (prismaErrorCode(error) === 'P2034') {
    return awaitCommittedIdempotencyWinner(read, wait)
  }
  return (await read()) ?? null
}

/**
 * For retry loops whose every attempt re-reads the winner inside its own transaction: instead of three immediate
 * attempts that can all be spent while the winner is still in flight, pause (bounded, the same schedule as the winner
 * wait) before each further attempt. Returns false when the budget is spent; `attemptsMade` is 1 after the first try.
 */
export async function pauseBeforeLostRaceRetry(
  attemptsMade: number,
  wait: Readonly<IdempotencyWinnerWait> = DEFAULT_IDEMPOTENCY_WINNER_WAIT,
): Promise<boolean> {
  const delay = wait.delaysMs[attemptsMade - 1]
  if (delay === undefined) return false
  await wait.sleep(delay)
  return true
}

/**
 * For writes whose transaction already answers a committed winner (in-transaction replay) but whose catch block maps a
 * lost race straight to PERSISTENCE_CONFLICT: run the whole transaction again after each bounded pause, so the loser
 * meets the winner's committed record in its own replay check. The last lost-race error is rethrown when the budget is
 * spent, for the caller's catch to map as before.
 */
export async function retryAfterLostRace<T>(
  operation: () => Promise<T>,
  isLostRace: (error: unknown) => boolean = (error) => {
    const code = prismaErrorCode(error)
    return code === 'P2034' || code === 'P2002'
  },
  wait: Readonly<IdempotencyWinnerWait> = DEFAULT_IDEMPOTENCY_WINNER_WAIT,
): Promise<T> {
  for (let attemptsMade = 1; ; attemptsMade += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isLostRace(error) || !(await pauseBeforeLostRaceRetry(attemptsMade, wait))) throw error
    }
  }
}
