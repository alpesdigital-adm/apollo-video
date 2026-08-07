import { calculateVersionHash } from './version-hash.ts'
import { DomainError } from '../domain/errors.ts'
import type {
  PublicOperationRepository,
} from './ports/public-operation-repository.ts'
import type { DirectorRunRepository } from './ports/director-run-repository.ts'
import { runProjectDirectorService } from './run-project-director.ts'
import type { BriefCompilation } from './compile-brief.ts'

export interface ProjectDirectorOperationWorkerOutcome {
  operationId: string
  status: 'succeeded' | 'retrying' | 'failed' | 'lease-lost'
}

function retryableDirectorError(error: unknown): boolean {
  return error instanceof DomainError &&
    ['PERSISTENCE_CONFLICT', 'PERSISTENCE_NOT_CONFIGURED'].includes(error.code)
}

export function runNextProjectDirectorOperationService(dependencies: {
  operations: PublicOperationRepository
  directorRuns: DirectorRunRepository
  clock?: () => Date
  createId: (
    kind: 'director-run' | 'edit-command' | 'project-version' | 'project-snapshot',
  ) => string
  createEventId: () => string
  compileBrief: (input: {
    text: string
    guardrails?: readonly string[]
  }) => Promise<Readonly<BriefCompilation>>
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000
  const retryBaseDelayMs = dependencies.retryBaseDelayMs ?? 5_000
  const retryMaxDelayMs = dependencies.retryMaxDelayMs ?? 300_000
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    leaseDurationMs <= heartbeatIntervalMs ||
    !Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs <= 0 ||
    !Number.isSafeInteger(retryMaxDelayMs) || retryMaxDelayMs < retryBaseDelayMs
  ) throw new DomainError(
    'INVALID_PUBLIC_OPERATION',
    'Director worker lease configuration is invalid',
  )
  const leaseUntil = (now: Date) =>
    new Date(now.getTime() + leaseDurationMs).toISOString()

  return async function runNext(
    leaseOwner: string,
  ): Promise<Readonly<ProjectDirectorOperationWorkerOutcome> | null> {
    const claimedAt = clock()
    const claimed = await dependencies.operations.claimNext({
      leaseOwner,
      now: claimedAt.toISOString(),
      leaseUntil: leaseUntil(claimedAt),
      type: 'project-director-run',
    })
    if (!claimed) return null
    if (
      claimed.context.kind !== 'project-director-run' ||
      claimed.operation.target.type !== 'project-version' ||
      claimed.operation.projectId !== claimed.context.projectId ||
      claimed.operation.target.id !== claimed.context.resultVersionId ||
      claimed.authenticationAudit.clientId !== claimed.operation.clientId ||
      claimed.authenticationAudit.workspaceId !==
        claimed.operation.workspaceId ||
      claimed.authenticationAudit.delegatedUserId !==
        claimed.context.delegatedUserId
    ) throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Director worker claimed an invalid operation context',
    )

    const operationId = claimed.operation.id
    const attempt = claimed.lease.attempt
    let leaseLost = false
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<boolean> | undefined
    const heartbeat = async (): Promise<boolean> => {
      if (leaseLost || stopped) return false
      if (renewal) return renewal
      renewal = (async () => {
        const now = clock()
        try {
          const renewed = await dependencies.operations.heartbeat({
            operationId,
            leaseOwner,
            attempt,
            now: now.toISOString(),
            leaseUntil: leaseUntil(now),
          })
          if (!renewed) leaseLost = true
          return renewed
        } catch {
          leaseLost = true
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
      if (!(await heartbeat())) {
        return Object.freeze({ operationId, status: 'lease-lost' as const })
      }
      scheduleHeartbeat()
      const context = claimed.context
      await runProjectDirectorService({
        repository: dependencies.directorRuns,
        clock,
        createId: dependencies.createId,
        createEventId: dependencies.createEventId,
        compileBrief: dependencies.compileBrief,
      })({
        workspaceId: claimed.operation.workspaceId,
        projectId: context.projectId,
        baseVersionId: context.baseVersionId,
        baseHash: context.baseHash,
        authenticationAudit: claimed.authenticationAudit,
        idempotency: {
          key: calculateVersionHash({
            kind: 'project-director-operation',
            operationId,
          }),
        },
        allocatedResultVersionId: context.resultVersionId,
        objective: context.objective,
        expectedBaseObjective: context.baseObjective,
        expectedObjectiveVersion: context.objectiveVersion,
        expectedRubricRef: context.rubricRef,
        ...(context.supersedesRunId
          ? { expectedSupersedesRunId: context.supersedesRunId }
          : {}),
        ...(context.desiredAction ? { desiredAction: context.desiredAction } : {}),
        operationFence: command(clock()),
        ...(context.reason ? { reason: context.reason } : {}),
      })
      const settled = await dependencies.operations.findById(
        claimed.operation.workspaceId,
        operationId,
      )
      if (settled?.operation.status !== 'succeeded') {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Director commit did not settle its operation atomically',
        )
      }
      return Object.freeze({ operationId, status: 'succeeded' as const })
    } catch (error) {
      if (leaseLost) {
        return Object.freeze({ operationId, status: 'lease-lost' as const })
      }
      const retryable = retryableDirectorError(error)
      const canRetry = retryable && attempt < claimed.operation.maxAttempts
      const failedAt = clock()
      const delay = Math.min(
        retryMaxDelayMs,
        retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
      )
      const settled = await dependencies.operations.failOrRetry({
        ...command(failedAt),
        error: {
          code: error instanceof DomainError
            ? error.code.toLowerCase().replaceAll('_', '-')
            : 'director-operation-failed',
          message: error instanceof DomainError
            ? error.message
            : 'Director operation failed',
          retryable,
        },
        ...(canRetry
          ? { nextAttemptAt: new Date(failedAt.getTime() + delay).toISOString() }
          : {}),
      })
      if (!settled) {
        return Object.freeze({ operationId, status: 'lease-lost' as const })
      }
      return Object.freeze({
        operationId,
        status: settled.operation.status === 'retrying'
          ? 'retrying' as const
          : 'failed' as const,
      })
    } finally {
      stopHeartbeat()
      await renewal?.catch(() => undefined)
    }
  }
}
