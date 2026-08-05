import { DomainError } from '../domain/errors.ts'
import type {
  LongFormIndexStageProcessor,
} from './ports/long-form-index-stage-processor.ts'
import type {
  SpeakerDiarizationAudioPreparer,
} from './ports/speaker-diarization-audio-preparer.ts'
import type {
  SpeakerDiarizationProvider,
} from './ports/speaker-diarization-provider.ts'
import type {
  ProviderRuntimeRouter,
} from './ports/provider-runtime-router.ts'
import type {
  SpeakerDiarizationRepository,
} from './ports/speaker-diarization-repository.ts'
import {
  persistSpeakerDiarizationService,
} from './speaker-diarization.ts'

function stageCost(
  usageSeconds: number,
  minorUnitsPerHour: number,
): number {
  return Math.ceil(
    usageSeconds * minorUnitsPerHour / 3_600,
  )
}

function replayResult(
  run: Awaited<
    ReturnType<SpeakerDiarizationRepository['findReplay']>
  >,
) {
  if (!run) return undefined
  return Object.freeze({
    outputHash: run.runHash,
    outputEntityId: run.id,
    resultCount: run.segmentCount,
    costMinorUnits: run.costMinorUnits,
    elapsedMs: run.elapsedMs,
  })
}

function transcriptOutput(
  workflow: Parameters<
    LongFormIndexStageProcessor['process']
  >[0]['workflow'],
): Readonly<{ id: string; hash: string }> {
  const checkpoint = workflow.stages.find(
    (candidate) => candidate.stage === 'transcript',
  )
  if (
    !checkpoint ||
    checkpoint.status !== 'succeeded' ||
    !checkpoint.outputReference ||
    !checkpoint.outputHash
  ) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      'Speaker diarization requires a persisted transcript output',
    )
  }
  return Object.freeze({
    id: checkpoint.outputReference.id,
    hash: checkpoint.outputHash,
  })
}

export function createSpeakerDiarizationStageProcessor(
  dependencies: {
    repository: SpeakerDiarizationRepository
    providers: Pick<ProviderRuntimeRouter, 'resolveDiarization'>
    audio: SpeakerDiarizationAudioPreparer
    createRunId: () => string
    clock?: () => Date
    monotonicClock?: () => number
  },
): LongFormIndexStageProcessor {
  const clock = dependencies.clock ?? (() => new Date())
  const monotonicClock =
    dependencies.monotonicClock ?? (() => performance.now())
  const persist = persistSpeakerDiarizationService({
    repository: dependencies.repository,
    createRunId: dependencies.createRunId,
    clock,
  })

  return Object.freeze({
    async process(
      input: Parameters<
        LongFormIndexStageProcessor['process']
      >[0],
    ) {
      const { workflow, checkpoint } = input
      if (
        checkpoint.stage !== 'diarization' ||
        checkpoint.execution !== 'process' ||
        checkpoint.status !== 'running'
      ) {
        throw new DomainError(
          'PRECONDITION_REQUIRED',
          'Speaker diarization processor requires a running diarization stage',
        )
      }
      const runtime = dependencies.providers.resolveDiarization(
        input.authenticationAudit,
      )
      if (
        checkpoint.version.provider !== runtime.identity.provider ||
        checkpoint.version.model !== runtime.identity.model ||
        checkpoint.version.version !== runtime.identity.version
      ) {
        throw new DomainError(
          'PERSISTENCE_NOT_CONFIGURED',
          'Diarization provider does not match the authenticated environment',
        )
      }
      const transcript = transcriptOutput(workflow)
      const context =
        await dependencies.repository.readSourceContext({
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
        context.sourceTranscriptId !==
          transcript.id ||
        context.sourceTranscriptHash !==
          transcript.hash ||
        context.durationMs !== workflow.durationMs
      ) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Speaker diarization workflow binding changed before execution',
        )
      }
      const existing = await dependencies.repository.findReplay({
        workspaceId: workflow.workspaceId,
        workflowId: workflow.id,
        actorContextHash: context.authenticationAudit.contextHash,
        idempotencyKey: checkpoint.idempotencyKey,
      })
      if (existing) {
        if (
          existing.sourceArtifactSha256 !==
            workflow.sourceArtifactSha256 ||
          existing.sourceManifestHash !== workflow.sourceManifestHash ||
          existing.sourceTranscriptHash !==
            transcript.hash ||
          existing.provider.id !== checkpoint.version.provider ||
          existing.provider.model !== checkpoint.version.model ||
          existing.provider.version !== checkpoint.version.version
          || existing.authenticationAudit.contextHash !==
            context.authenticationAudit.contextHash
        ) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Persisted diarization replay does not match its checkpoint',
          )
        }
        return replayResult(existing)!
      }
      const maximumExpectedCost = stageCost(
        Math.ceil(context.durationMs / 1_000),
        runtime.pricingMinorUnitsPerHour,
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
          'Speaker diarization exceeds its approved cost budget',
        )
      }
      if (!(await input.heartbeat())) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Speaker diarization lease was lost before execution',
        )
      }
      const startedAt = monotonicClock()
      let prepared:
        | Awaited<ReturnType<
            SpeakerDiarizationAudioPreparer['prepare']
          >>
        | undefined
      let result:
        | Awaited<ReturnType<SpeakerDiarizationProvider['diarize']>>
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
            'Speaker diarization lease was lost after audio preparation',
          )
        }
        result = await runtime.create().diarize({
          audioPath: prepared.audioPath,
          language: context.language,
          expectedDurationMs: prepared.durationMs,
          signal: input.signal,
        })
        if (!(await input.heartbeat())) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Speaker diarization lease was lost after provider execution',
          )
        }
      } finally {
        await dependencies.audio.cleanup(input.lease.operationId)
      }
      if (!prepared || !result) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'Speaker diarization did not produce a result',
        )
      }
      if (
        result.provider.id !== checkpoint.version.provider ||
        result.provider.model !== checkpoint.version.model ||
        result.provider.version !== checkpoint.version.version
      ) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'Speaker diarization provider version does not match the checkpoint',
        )
      }
      const costMinorUnits = stageCost(
        result.usageSeconds,
        runtime.pricingMinorUnitsPerHour,
      )
      const elapsedMs = Math.max(
        0,
        Math.ceil(monotonicClock() - startedAt),
      )
      if (
        costMinorUnits > checkpoint.budget.maximumCostMinorUnits ||
        costMinorUnits > remainingWorkflowBudget ||
        elapsedMs > checkpoint.budget.maximumElapsedMs
      ) {
        throw new DomainError(
          'PRECONDITION_REQUIRED',
          'Speaker diarization exceeded its approved execution budget',
        )
      }
      const persisted = await persist({
        workspaceId: workflow.workspaceId,
        projectId: workflow.projectId,
        workflowId: workflow.id,
        expectedStageInputHash: checkpoint.inputHash,
        providerInput: Object.freeze({
          sha256: prepared.sha256,
          byteSize: prepared.byteSize,
          durationMs: prepared.durationMs,
          preparation: prepared.preparation,
        }),
        provider: result.provider,
        segments: result.segments,
        usageSeconds: result.usageSeconds,
        costMinorUnits,
        elapsedMs,
        lease: input.lease,
      })
      return Object.freeze({
        outputHash: persisted.run.runHash,
        outputEntityId: persisted.run.id,
        resultCount: persisted.run.segmentCount,
        costMinorUnits: persisted.run.costMinorUnits,
        elapsedMs: persisted.run.elapsedMs,
      })
    },
  })
}
