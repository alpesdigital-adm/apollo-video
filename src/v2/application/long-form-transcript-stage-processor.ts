import { DomainError } from '../domain/errors.ts'
import type { MediaTranscriber } from './ports/media-ingest.ts'
import type {
  LongFormIndexStageProcessor,
} from './ports/long-form-index-stage-processor.ts'
import type {
  LongFormIndexWorkflowRepository,
} from './ports/long-form-index-workflow-repository.ts'
import type {
  SpeakerDiarizationAudioPreparer,
} from './ports/speaker-diarization-audio-preparer.ts'

function stageCost(
  durationMs: number,
  minorUnitsPerHour: number,
): number {
  return Math.ceil(durationMs * minorUnitsPerHour / 3_600_000)
}

function resultCount(transcript: Readonly<{
  words: readonly unknown[]
  segments: readonly unknown[]
}>): number {
  return Math.max(transcript.words.length, transcript.segments.length, 1)
}

export function createLongFormTranscriptStageProcessor(
  dependencies: {
    repository: LongFormIndexWorkflowRepository
    transcriber: MediaTranscriber
    audio: SpeakerDiarizationAudioPreparer
    createTranscriptId: (transcriptHash: string) => string
    providerVersion: string
    pricingMinorUnitsPerHour: number
    clock?: () => Date
    monotonicClock?: () => number
  },
): LongFormIndexStageProcessor {
  const clock = dependencies.clock ?? (() => new Date())
  const monotonicClock =
    dependencies.monotonicClock ?? (() => performance.now())
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(
      dependencies.providerVersion,
    ) ||
    !Number.isSafeInteger(dependencies.pricingMinorUnitsPerHour) ||
    dependencies.pricingMinorUnitsPerHour < 1 ||
    dependencies.pricingMinorUnitsPerHour > 10_000_000
  ) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Long-form transcription pricing or provider version is invalid',
    )
  }

  return Object.freeze({
    async process(
      input: Parameters<
        LongFormIndexStageProcessor['process']
      >[0],
    ) {
      const { workflow, checkpoint } = input
      if (
        checkpoint.stage !== 'transcript' ||
        checkpoint.execution !== 'process' ||
        checkpoint.status !== 'running'
      ) {
        throw new DomainError(
          'PRECONDITION_REQUIRED',
          'Transcript processor requires a running transcript stage',
        )
      }
      if (
        checkpoint.version.version !== dependencies.providerVersion
      ) {
        throw new DomainError(
          'PERSISTENCE_NOT_CONFIGURED',
          'Transcript adapter version does not match the checkpoint',
        )
      }
      const context =
        await dependencies.repository.readTranscriptStageContext({
          workspaceId: workflow.workspaceId,
          projectId: workflow.projectId,
          workflowId: workflow.id,
        })
      if (
        !context ||
        context.operationId !== input.lease.operationId ||
        context.stageStatus !== 'running' ||
        context.stageInputHash !== checkpoint.inputHash ||
        context.stageIdempotencyKey !== checkpoint.idempotencyKey ||
        context.sourceArtifactId !== workflow.sourceArtifactId ||
        context.sourceArtifactSha256 !==
          workflow.sourceArtifactSha256 ||
        context.sourceManifestId !== workflow.sourceManifestId ||
        context.sourceManifestHash !== workflow.sourceManifestHash ||
        context.durationMs !== workflow.durationMs
      ) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Transcript workflow binding changed before execution',
        )
      }
      const replay =
        await dependencies.repository.findTranscriptStageReplay({
          workspaceId: workflow.workspaceId,
          projectId: workflow.projectId,
          sourceArtifactId: workflow.sourceArtifactId,
          sourceManifestId: workflow.sourceManifestId,
          provider: checkpoint.version.provider,
          model: checkpoint.version.model,
          providerVersion: checkpoint.version.version,
        })
      if (replay) {
        if (!(await input.heartbeat())) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Transcript lease was lost before replay authorization',
          )
        }
        const authorized =
          await dependencies.repository.persistTranscriptWithLease({
            workspaceId: workflow.workspaceId,
            projectId: workflow.projectId,
            workflowId: workflow.id,
            operationId: input.lease.operationId,
            expectedStageInputHash: checkpoint.inputHash,
            expectedStageIdempotencyKey: checkpoint.idempotencyKey,
            leaseOwner: input.lease.owner,
            operationAttempt: input.lease.attempt,
            transcriptId: replay.id,
            transcript: replay.transcript,
            providerVersion: checkpoint.version.version,
            sourceArtifactId: workflow.sourceArtifactId,
            sourceArtifactSha256:
              workflow.sourceArtifactSha256,
            sourceManifestId: workflow.sourceManifestId,
            sourceManifestHash: workflow.sourceManifestHash,
            now: clock().toISOString(),
          })
        if (!authorized) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Transcript lease was lost before replay authorization',
          )
        }
        return Object.freeze({
          outputHash: authorized.transcript.transcriptHash,
          outputEntityId: authorized.id,
          resultCount: resultCount(authorized.transcript),
          costMinorUnits: 0,
          elapsedMs: 0,
        })
      }
      const maximumExpectedCost = stageCost(
        context.durationMs,
        dependencies.pricingMinorUnitsPerHour,
      )
      const remainingWorkflowBudget =
        workflow.budget.maximumCostMinorUnits -
        workflow.summary.costMinorUnits
      if (
        maximumExpectedCost >
          checkpoint.budget.maximumCostMinorUnits ||
        maximumExpectedCost > remainingWorkflowBudget
      ) {
        throw new DomainError(
          'PRECONDITION_REQUIRED',
          'Long-form transcription exceeds its approved cost budget',
        )
      }
      if (!(await input.heartbeat())) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Transcript lease was lost before execution',
        )
      }
      const startedAt = monotonicClock()
      let prepared:
        | Awaited<ReturnType<
            SpeakerDiarizationAudioPreparer['prepare']
          >>
        | undefined
      try {
        prepared = await dependencies.audio.prepare({
          operationId: input.lease.operationId,
          sourceArtifactKey: context.sourceArtifactKey,
          sourceArtifactSha256: context.sourceArtifactSha256,
          sourceArtifactByteSize: context.sourceArtifactByteSize,
          expectedDurationMs: context.durationMs,
          signal: input.signal,
        })
        if (!(await input.heartbeat())) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Transcript lease was lost after audio preparation',
          )
        }
        const transcript = await dependencies.transcriber.transcribe({
          audioPath: prepared.audioPath,
          language: context.language,
          signal: input.signal,
        })
        if (
          transcript.provider !== checkpoint.version.provider ||
          transcript.model !== checkpoint.version.model
        ) {
          throw new DomainError(
            'RENDER_OUTPUT_INVALID',
            'Transcript provider identity does not match the checkpoint',
          )
        }
        if (!(await input.heartbeat())) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Transcript lease was lost after provider execution',
          )
        }
        const elapsedMs = Math.max(
          0,
          Math.ceil(monotonicClock() - startedAt),
        )
        if (elapsedMs > checkpoint.budget.maximumElapsedMs) {
          throw new DomainError(
            'PRECONDITION_REQUIRED',
            'Long-form transcription exceeded its approved time budget',
          )
        }
        const transcriptId = dependencies.createTranscriptId(
          transcript.transcriptHash,
        )
        const persisted =
          await dependencies.repository.persistTranscriptWithLease({
            workspaceId: workflow.workspaceId,
            projectId: workflow.projectId,
            workflowId: workflow.id,
            operationId: input.lease.operationId,
            expectedStageInputHash: checkpoint.inputHash,
            expectedStageIdempotencyKey: checkpoint.idempotencyKey,
            leaseOwner: input.lease.owner,
            operationAttempt: input.lease.attempt,
            transcriptId,
            transcript,
            providerVersion: checkpoint.version.version,
            sourceArtifactId: workflow.sourceArtifactId,
            sourceArtifactSha256:
              workflow.sourceArtifactSha256,
            sourceManifestId: workflow.sourceManifestId,
            sourceManifestHash: workflow.sourceManifestHash,
            now: clock().toISOString(),
          })
        if (!persisted) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Transcript lease was lost before persistence',
          )
        }
        return Object.freeze({
          outputHash: persisted.transcript.transcriptHash,
          outputEntityId: persisted.id,
          resultCount: resultCount(persisted.transcript),
          costMinorUnits: maximumExpectedCost,
          elapsedMs,
        })
      } finally {
        await dependencies.audio.cleanup(
          input.lease.operationId,
        )
      }
    },
  })
}
