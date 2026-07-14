import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import { DomainError } from '../domain/errors.ts'
import type { AuthorizedRenderReceipt } from './render-authorized-input.ts'

type RenderAuthorized = (request: {
  workspaceId: string
  authorizationId: string
  signal?: AbortSignal
  beforeCommit?: () => Promise<void>
}) => Promise<Readonly<AuthorizedRenderReceipt>>

export interface PublicOperationWorkerOutcome {
  operationId: string
  status: 'succeeded' | 'retrying' | 'failed' | 'lease-lost'
}

const NON_RETRYABLE_CODES = new Set([
  'INVALID_RENDER_INPUT',
  'MATERIALIZATION_AUTHORIZATION_REJECTED',
  'MATERIALIZATION_AUTHORIZATION_EXPIRED',
  'MATERIALIZATION_REVALIDATION_FAILED',
  'RENDER_OUTPUT_CONFLICT',
  'PERSISTENCE_CONFLICT',
])

function safeFailure(error: unknown) {
  const retryable = !(error instanceof DomainError && NON_RETRYABLE_CODES.has(error.code))
  return {
    code: error instanceof DomainError
      ? error.code.toLowerCase()
      : 'render_execution_failed',
    message: 'Render operation could not be completed',
    retryable,
  }
}

export function runNextPublicOperationService(dependencies: {
  operations: PublicOperationRepository
  render: RenderAuthorized
  clock?: () => Date
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    leaseDurationMs <= heartbeatIntervalMs
  ) {
    throw new DomainError(
      'INVALID_PUBLIC_OPERATION',
      'Worker lease and heartbeat configuration is invalid',
    )
  }

  const leaseWindow = (now: Date) =>
    new Date(now.getTime() + leaseDurationMs).toISOString()

  return async function runNextPublicOperation(
    leaseOwner: string,
  ): Promise<Readonly<PublicOperationWorkerOutcome> | null> {
    const claimedAt = clock()
    const claimed = await dependencies.operations.claimNext({
      leaseOwner,
      now: claimedAt.toISOString(),
      leaseUntil: leaseWindow(claimedAt),
    })
    if (!claimed) return null

    const operationId = claimed.operation.id
    const attempt = claimed.lease.attempt
    const abortController = new AbortController()
    let stopped = false
    let leaseLost = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<boolean> | undefined

    const heartbeat = async (): Promise<boolean> => {
      if (leaseLost || stopped) return false
      if (renewal) return renewal
      renewal = (async () => {
        try {
          const now = clock()
          const renewed = await dependencies.operations.heartbeat({
            operationId,
            leaseOwner,
            attempt,
            now: now.toISOString(),
            leaseUntil: leaseWindow(now),
          })
          if (!renewed) {
            leaseLost = true
            abortController.abort()
          }
          return renewed
        } catch {
          leaseLost = true
          abortController.abort()
          return false
        } finally {
          renewal = undefined
        }
      })()
      return renewal
    }

    const scheduleHeartbeat = () => {
      if (stopped || leaseLost) return
      timer = setTimeout(async () => {
        await heartbeat()
        scheduleHeartbeat()
      }, heartbeatIntervalMs)
      timer.unref?.()
    }
    const stopHeartbeat = () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }

    const command = (now: Date) => ({
      operationId,
      leaseOwner,
      attempt,
      now: now.toISOString(),
    })

    try {
      const renderingAt = clock()
      const enteredRendering = await dependencies.operations.advancePhase({
        ...command(renderingAt),
        phase: 'rendering',
      })
      if (!enteredRendering) {
        return Object.freeze({ operationId, status: 'lease-lost' })
      }
      scheduleHeartbeat()

      const receipt = await dependencies.render({
        workspaceId: claimed.operation.workspaceId,
        authorizationId: claimed.context.authorizationId,
        signal: abortController.signal,
        beforeCommit: async () => {
          if (!(await heartbeat())) {
            throw new DomainError('RENDER_EXECUTION_FAILED', 'Render lease was lost')
          }
          const persistingAt = clock()
          const enteredPersisting = await dependencies.operations.advancePhase({
            ...command(persistingAt),
            phase: 'persisting',
          })
          if (!enteredPersisting) {
            leaseLost = true
            abortController.abort()
            throw new DomainError('RENDER_EXECUTION_FAILED', 'Render lease was lost')
          }
        },
      })

      if (
        receipt.authorizationId !== claimed.context.authorizationId ||
        receipt.artifactId !== claimed.operation.target.id ||
        receipt.manifestId !== claimed.operation.target.manifestId ||
        receipt.inputHash !== claimed.context.inputHash
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Render receipt does not match the claimed operation',
        )
      }

      stopHeartbeat()
      const succeeded = await dependencies.operations.succeed(command(clock()))
      if (!succeeded) {
        return Object.freeze({ operationId, status: 'lease-lost' })
      }
      return Object.freeze({ operationId, status: 'succeeded' })
    } catch (error) {
      stopHeartbeat()
      if (leaseLost) {
        return Object.freeze({ operationId, status: 'lease-lost' })
      }
      const failed = await dependencies.operations.failOrRetry({
        ...command(clock()),
        error: safeFailure(error),
      })
      if (!failed) {
        return Object.freeze({ operationId, status: 'lease-lost' })
      }
      return Object.freeze({
        operationId,
        status: failed.operation.status === 'retrying' ? 'retrying' : 'failed',
      })
    } finally {
      stopHeartbeat()
    }
  }
}
