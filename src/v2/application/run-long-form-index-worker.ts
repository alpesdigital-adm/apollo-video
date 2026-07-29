import { DomainError } from '../domain/errors.ts'
import {
  completeLongFormIndexStage,
  failLongFormIndexStage,
  resumeLongFormIndexWorkflow,
  startLongFormIndexStage,
  type LongFormIndexStage,
  type LongFormIndexWorkflow,
} from '../domain/long-form-index-workflow.ts'
import type {
  PublicOperationRunningPhase,
} from '../domain/public-operation.ts'
import type {
  LongFormIndexStageProcessor,
} from './ports/long-form-index-stage-processor.ts'
import type {
  LongFormIndexWorkflowRepository,
} from './ports/long-form-index-workflow-repository.ts'
import type {
  PublicOperationRepository,
} from './ports/public-operation-repository.ts'
import {
  calculatePublicOperationRetryDelayMs,
} from './run-public-operation-worker.ts'

export interface LongFormIndexWorkerOutcome {
  operationId: string
  workflowId: string
  status: 'succeeded' | 'retrying' | 'failed' | 'lease-lost'
}

const PHASE_BY_STAGE: Readonly<Record<
  LongFormIndexStage,
  PublicOperationRunningPhase
>> = Object.freeze({
  probe: 'probing',
  transcript: 'transcribing',
  diarization: 'diarizing',
  chunks: 'chunking',
  moments: 'indexing',
})

const NON_RETRYABLE_CODES = new Set([
  'INVALID_ARGUMENT',
  'VERSION_CONFLICT',
  'PERSISTENCE_CONFLICT',
  'ASSET_RIGHTS_BLOCKED',
  'PRECONDITION_REQUIRED',
])

function safeFailure(error: unknown) {
  const retryable = !(
    error instanceof DomainError &&
    NON_RETRYABLE_CODES.has(error.code)
  )
  return Object.freeze({
    code: error instanceof DomainError
      ? error.code.toLowerCase()
      : 'long_form_stage_failed',
    message: 'Long-form indexing stage could not be completed',
    retryable,
  })
}

export function runNextLongFormIndexOperationService(
  dependencies: {
    operations: PublicOperationRepository
    workflows: LongFormIndexWorkflowRepository
    processor: LongFormIndexStageProcessor
    clock?: () => Date
    leaseDurationMs?: number
    heartbeatIntervalMs?: number
    retryBaseDelayMs?: number
    retryMaxDelayMs?: number
  },
) {
  const clock = dependencies.clock ?? (() => new Date())
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000
  const heartbeatIntervalMs =
    dependencies.heartbeatIntervalMs ?? 10_000
  const retryBaseDelayMs =
    dependencies.retryBaseDelayMs ?? 5_000
  const retryMaxDelayMs =
    dependencies.retryMaxDelayMs ?? 300_000
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    leaseDurationMs <= heartbeatIntervalMs ||
    !Number.isSafeInteger(retryBaseDelayMs) ||
    retryBaseDelayMs <= 0 ||
    !Number.isSafeInteger(retryMaxDelayMs) ||
    retryMaxDelayMs < retryBaseDelayMs
  ) {
    throw new DomainError(
      'INVALID_PUBLIC_OPERATION',
      'Long-form worker lease and retry configuration is invalid',
    )
  }

  const leaseWindow = (now: Date) =>
    new Date(now.getTime() + leaseDurationMs).toISOString()

  return async function runNext(
    leaseOwner: string,
  ): Promise<Readonly<LongFormIndexWorkerOutcome> | null> {
    const claimedAt = clock()
    const claimed = await dependencies.operations.claimNext({
      leaseOwner,
      now: claimedAt.toISOString(),
      leaseUntil: leaseWindow(claimedAt),
      type: 'long-form-index',
    })
    if (!claimed) return null
    if (claimed.context.kind !== 'long-form-index') {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Long-form worker claimed an incompatible operation',
      )
    }
    const context = claimed.context

    const operationId = claimed.operation.id
    const workflowId = context.workflowId
    const operationAttempt = claimed.lease.attempt
    const abortController = new AbortController()
    let stopped = false
    let leaseLost = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<boolean> | undefined
    let workflow: Readonly<LongFormIndexWorkflow> | undefined

    const heartbeat = async (): Promise<boolean> => {
      if (stopped || leaseLost) return false
      if (renewal) return renewal
      renewal = (async () => {
        try {
          const now = clock()
          const renewed = await dependencies.operations.heartbeat({
            operationId,
            leaseOwner,
            attempt: operationAttempt,
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
    const operationCommand = (now: Date) => ({
      operationId,
      leaseOwner,
      attempt: operationAttempt,
      now: now.toISOString(),
    })
    const replace = async (
      expectedRunHash: string,
      nextWorkflow: Readonly<LongFormIndexWorkflow>,
      now: Date,
    ) => dependencies.workflows.replaceWithLease({
      workspaceId: claimed.operation.workspaceId,
      projectId: context.projectId,
      workflowId,
      operationId,
      expectedRunHash,
      nextWorkflow,
      leaseOwner,
      operationAttempt,
      now: now.toISOString(),
    })

    try {
      const record = await dependencies.workflows.read({
        workspaceId: claimed.operation.workspaceId,
        projectId: context.projectId,
        workflowId,
      })
      if (
        !record ||
        record.operation.id !== operationId ||
        record.workflow.sourceArtifactId !==
          context.sourceArtifactId ||
        record.workflow.sourceManifestId !==
          context.sourceManifestId
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Claimed long-form workflow binding is invalid',
        )
      }
      workflow = record.workflow
      scheduleHeartbeat()

      const interrupted = workflow.stages.some((stage) =>
        stage.status === 'running' ||
        stage.status === 'failed' && stage.error?.retryable)
      if (interrupted) {
        const resumedAt = clock()
        const resumed = resumeLongFormIndexWorkflow({
          workflow,
          expectedRunHash: workflow.runHash,
          resumedAt: resumedAt.toISOString(),
        })
        const persisted = await replace(
          workflow.runHash,
          resumed,
          resumedAt,
        )
        if (!persisted) {
          leaseLost = true
          abortController.abort()
          return Object.freeze({
            operationId,
            workflowId,
            status: 'lease-lost',
          })
        }
        workflow = persisted
      }

      while (workflow.status !== 'succeeded') {
        const stage = workflow.summary.nextStage
        if (!stage) {
          throw new DomainError(
            'PRECONDITION_REQUIRED',
            'Long-form workflow has no executable stage',
          )
        }
        const phaseAt = clock()
        const phaseEntered =
          await dependencies.operations.advancePhase({
            ...operationCommand(phaseAt),
            phase: PHASE_BY_STAGE[stage],
          })
        if (!phaseEntered) {
          leaseLost = true
          abortController.abort()
          return Object.freeze({
            operationId,
            workflowId,
            status: 'lease-lost',
          })
        }
        const startedAt = clock()
        const started = startLongFormIndexStage({
          workflow,
          stage,
          expectedRunHash: workflow.runHash,
          startedAt: startedAt.toISOString(),
        })
        const persistedStart = await replace(
          workflow.runHash,
          started,
          startedAt,
        )
        if (!persistedStart) {
          leaseLost = true
          abortController.abort()
          return Object.freeze({
            operationId,
            workflowId,
            status: 'lease-lost',
          })
        }
        workflow = persistedStart
        const checkpoint = workflow.stages.find(
          (candidate) => candidate.stage === stage,
        )!
        const result = await dependencies.processor.process({
          workflow,
          checkpoint,
          lease: Object.freeze({
            operationId,
            owner: leaseOwner,
            attempt: operationAttempt,
          }),
          signal: abortController.signal,
          heartbeat,
        })
        if (!(await heartbeat())) {
          return Object.freeze({
            operationId,
            workflowId,
            status: 'lease-lost',
          })
        }
        const completedAt = clock()
        const completed = completeLongFormIndexStage({
          workflow,
          stage,
          expectedRunHash: workflow.runHash,
          expectedInputHash: checkpoint.inputHash,
          outputHash: result.outputHash,
          outputEntityId: result.outputEntityId,
          resultCount: result.resultCount,
          costMinorUnits: result.costMinorUnits,
          elapsedMs: result.elapsedMs,
          completedAt: completedAt.toISOString(),
        })
        const persistedCompletion = await replace(
          workflow.runHash,
          completed,
          completedAt,
        )
        if (!persistedCompletion) {
          leaseLost = true
          abortController.abort()
          return Object.freeze({
            operationId,
            workflowId,
            status: 'lease-lost',
          })
        }
        workflow = persistedCompletion
      }

      const persistingAt = clock()
      const enteredPersisting =
        await dependencies.operations.advancePhase({
          ...operationCommand(persistingAt),
          phase: 'persisting',
        })
      if (!enteredPersisting) {
        return Object.freeze({
          operationId,
          workflowId,
          status: 'lease-lost',
        })
      }
      stopHeartbeat()
      const succeeded = await dependencies.operations.succeed(
        operationCommand(clock()),
      )
      if (!succeeded) {
        return Object.freeze({
          operationId,
          workflowId,
          status: 'lease-lost',
        })
      }
      return Object.freeze({
        operationId,
        workflowId,
        status: 'succeeded',
      })
    } catch (error) {
      if (leaseLost) {
        return Object.freeze({
          operationId,
          workflowId,
          status: 'lease-lost',
        })
      }
      const failedAt = clock()
      const failure = safeFailure(error)
      const runningStage = workflow?.stages.find(
        (stage) => stage.status === 'running',
      )
      if (workflow && runningStage) {
        const failedWorkflow = failLongFormIndexStage({
          workflow,
          stage: runningStage.stage,
          expectedRunHash: workflow.runHash,
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          failedAt: failedAt.toISOString(),
        })
        const persisted = await replace(
          workflow.runHash,
          failedWorkflow,
          failedAt,
        )
        if (!persisted) {
          leaseLost = true
          abortController.abort()
          return Object.freeze({
            operationId,
            workflowId,
            status: 'lease-lost',
          })
        }
        workflow = persisted
      }
      stopHeartbeat()
      const nextAttemptAt =
        failure.retryable &&
        operationAttempt < claimed.operation.maxAttempts
          ? new Date(
              failedAt.getTime() +
                calculatePublicOperationRetryDelayMs({
                  attempt: operationAttempt,
                  baseDelayMs: retryBaseDelayMs,
                  maxDelayMs: retryMaxDelayMs,
                }),
            ).toISOString()
          : undefined
      const failed = await dependencies.operations.failOrRetry({
        ...operationCommand(failedAt),
        error: failure,
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
      })
      if (!failed) {
        return Object.freeze({
          operationId,
          workflowId,
          status: 'lease-lost',
        })
      }
      return Object.freeze({
        operationId,
        workflowId,
        status:
          failed.operation.status === 'retrying'
            ? 'retrying'
            : 'failed',
      })
    } finally {
      stopHeartbeat()
    }
  }
}
