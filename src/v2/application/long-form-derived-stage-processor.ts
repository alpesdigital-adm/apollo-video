import { DomainError } from '../domain/errors.ts'
import {
  calculateCanonicalHash,
} from '../domain/canonical-hash.ts'
import {
  HIERARCHICAL_CHUNK_POLICY_VERSION,
  HIERARCHICAL_COST_POLICY,
  HIERARCHICAL_PROCESSING_POLICY_VERSION,
  type HierarchicalTierVersions,
} from '../domain/hierarchical-processing.ts'
import type {
  LongFormIndexStage,
  LongFormIndexStageCheckpoint,
  LongFormIndexStageVersion,
  LongFormIndexWorkflow,
} from '../domain/long-form-index-workflow.ts'
import {
  LONG_FORM_INDEX_POLICY_VERSION,
  type LongFormChapterInput,
  type LongFormMomentInput,
} from '../domain/long-form-moment.ts'
import {
  createLongFormMomentTranscriptEvidence,
} from '../domain/long-form-transcript-evidence.ts'
import type {
  SpeakerDiarizationRun,
} from '../domain/speaker-diarization.ts'
import {
  catalogLongFormMomentsService,
} from './catalog-long-form-moments.ts'
import {
  executeHierarchicalProcessingService,
} from './hierarchical-processing.ts'
import type {
  HierarchicalProcessingRepository,
  PersistedHierarchicalProcessingRun,
} from './ports/hierarchical-processing-repository.ts'
import type {
  LongFormIndexCreationContext,
  LongFormIndexRepository,
  PersistedLongFormIndexRun,
} from './ports/long-form-index-repository.ts'
import type {
  LongFormIndexStageProcessor,
  LongFormIndexStageResult,
} from './ports/long-form-index-stage-processor.ts'
import type {
  LongFormStagePersistenceFence,
} from './ports/long-form-stage-persistence.ts'
import type {
  SpeakerDiarizationRepository,
} from './ports/speaker-diarization-repository.ts'

const CHUNKS_STAGE_VERSION = Object.freeze({
  provider: 'apollo',
  model: 'overlapping-time-chunks',
  version: '1.0.0',
})
const MOMENTS_STAGE_VERSION = Object.freeze({
  provider: 'apollo',
  model: 'hierarchical-moments',
  version: '1.0.0',
})
const HIERARCHICAL_TIER_VERSIONS =
  Object.freeze<HierarchicalTierVersions>({
    'cheap-signals': Object.freeze({
      provider: 'apollo',
      model: 'transcript-statistics',
      version: '1.0.0',
    }),
    vision: Object.freeze({
      provider: 'apollo',
      model: 'cataloged-visual-observations',
      version: '1.0.0',
    }),
    language: Object.freeze({
      provider: 'apollo',
      model: 'transcript-segmentation',
      version: '1.0.0',
    }),
    aggregation: Object.freeze({
      provider: 'apollo',
      model: 'evidence-preserving-aggregation',
      version: '1.0.0',
    }),
  })

export const DEFAULT_LONG_FORM_DERIVED_STAGE_CONFIGURATION =
  Object.freeze({
    chunks: Object.freeze({
      stageVersion: CHUNKS_STAGE_VERSION,
      tierVersions: HIERARCHICAL_TIER_VERSIONS,
      chunkDurationMs: 300_000,
      overlapMs: 15_000,
      maximumWorkingSetBytes: 256 * 1024 * 1024,
    }),
    moments: Object.freeze({
      stageVersion: MOMENTS_STAGE_VERSION,
      producerConfidence: 1,
    }),
  })

export interface LongFormDerivedStageConfiguration {
  chunks: Readonly<{
    stageVersion: Readonly<LongFormIndexStageVersion>
    tierVersions: Readonly<HierarchicalTierVersions>
    chunkDurationMs: number
    overlapMs: number
    maximumWorkingSetBytes: number
  }>
  moments: Readonly<{
    stageVersion: Readonly<LongFormIndexStageVersion>
    producerConfidence: number
  }>
}

type StageProcessInput = Parameters<
  LongFormIndexStageProcessor['process']
>[0]

export interface LongFormContiguousEvidenceProducer {
  kind:
    | 'transcript-boundary'
    | 'transcript-density'
    | 'rights-integrity'
    | 'audio-analysis'
    | 'visual-analysis'
  produce(input: {
    workspaceId: string
    projectId: string
    indexRunId: string
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
    signal: AbortSignal
    fence: Readonly<LongFormStagePersistenceFence>
  }): Promise<unknown>
}

export interface LongFormContiguousEvaluationProducer {
  produce(input: {
    workspaceId: string
    projectId: string
    indexRunId: string
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
    signal: AbortSignal
    fence: Readonly<LongFormStagePersistenceFence>
  }): Promise<unknown>
}

function sameVersion(
  left: Readonly<LongFormIndexStageVersion>,
  right: Readonly<LongFormIndexStageVersion>,
): boolean {
  return left.provider === right.provider &&
    left.model === right.model &&
    left.version === right.version
}

function assertRunningStage(
  input: StageProcessInput,
  stage: 'chunks' | 'moments',
  expectedVersion: Readonly<LongFormIndexStageVersion>,
): void {
  if (
    input.checkpoint.stage !== stage ||
    input.checkpoint.execution !== 'process' ||
    input.checkpoint.status !== 'running'
  ) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      `Long-form ${stage} processor requires its running stage`,
    )
  }
  if (!sameVersion(input.checkpoint.version, expectedVersion)) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      `Long-form ${stage} processor version is not available`,
    )
  }
  if (input.signal.aborted) {
    throw new DomainError(
      'VERSION_CONFLICT',
      `Long-form ${stage} operation was aborted before execution`,
    )
  }
}

function succeededOutput(
  workflow: Readonly<LongFormIndexWorkflow>,
  stage: LongFormIndexStage,
): Readonly<{
  checkpoint: Readonly<LongFormIndexStageCheckpoint>
  id: string
  hash: string
}> {
  const checkpoint = workflow.stages.find(
    (candidate) => candidate.stage === stage,
  )
  if (
    !checkpoint ||
    checkpoint.status !== 'succeeded' ||
    !checkpoint.outputReference ||
    !checkpoint.outputHash
  ) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      `Long-form ${stage} output is not available`,
    )
  }
  return Object.freeze({
    checkpoint,
    id: checkpoint.outputReference.id,
    hash: checkpoint.outputHash,
  })
}

function effectiveStageBudget(
  workflow: Readonly<LongFormIndexWorkflow>,
  checkpoint: Readonly<LongFormIndexStageCheckpoint>,
  estimatedCostMinorUnits: number,
): Readonly<{
  maximumCostMinorUnits: number
  maximumElapsedMs: number
}> {
  const remainingCost = Math.max(
    0,
    workflow.budget.maximumCostMinorUnits -
      workflow.summary.costMinorUnits,
  )
  const remainingElapsed = Math.max(
    0,
    workflow.budget.maximumElapsedMs -
      workflow.summary.elapsedMs,
  )
  const maximumCostMinorUnits = Math.min(
    checkpoint.budget.maximumCostMinorUnits,
    remainingCost,
  )
  const maximumElapsedMs = Math.min(
    checkpoint.budget.maximumElapsedMs,
    remainingElapsed,
  )
  if (
    estimatedCostMinorUnits > maximumCostMinorUnits ||
    maximumElapsedMs < 1
  ) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      `Long-form ${checkpoint.stage} exceeds its approved budget`,
    )
  }
  return Object.freeze({
    maximumCostMinorUnits,
    maximumElapsedMs,
  })
}

function stageFence(
  input: StageProcessInput,
  stage: 'chunks' | 'moments',
  now: string,
): Readonly<LongFormStagePersistenceFence> {
  return Object.freeze({
    workspaceId: input.workflow.workspaceId,
    projectId: input.workflow.projectId,
    workflowId: input.workflow.id,
    operationId: input.lease.operationId,
    stage,
    expectedStageInputHash: input.checkpoint.inputHash,
    expectedStageIdempotencyKey:
      input.checkpoint.idempotencyKey,
    leaseOwner: input.lease.owner,
    operationAttempt: input.lease.attempt,
    now,
  })
}

function assertIndexingRights(
  run: Readonly<{
    rightsStatus: string
    consentStatus: string
  }>,
): void {
  if (
    run.rightsStatus !== 'approved' ||
    !['approved', 'not-required'].includes(run.consentStatus)
  ) {
    throw new DomainError(
      'ASSET_RIGHTS_BLOCKED',
      'Long-form source rights no longer allow indexing',
    )
  }
}

function assertCurrentIndexingRights(
  rights: Readonly<{
    status: string
    consentStatus: string
    expiresAt?: string
    consentExpiresAt?: string
  }>,
  now: string,
): void {
  const nowMs = Date.parse(now)
  const expiresAtMs = rights.expiresAt
    ? Date.parse(rights.expiresAt)
    : undefined
  const consentExpiresAtMs = rights.consentExpiresAt
    ? Date.parse(rights.consentExpiresAt)
    : undefined
  if (
    !Number.isFinite(nowMs) ||
    (expiresAtMs !== undefined &&
      !Number.isFinite(expiresAtMs)) ||
    (consentExpiresAtMs !== undefined &&
      !Number.isFinite(consentExpiresAtMs))
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Long-form source rights contain an invalid expiry instant',
    )
  }
  if (
    rights.status !== 'approved' ||
    !['approved', 'not-required'].includes(rights.consentStatus) ||
    (expiresAtMs !== undefined && expiresAtMs <= nowMs) ||
    (consentExpiresAtMs !== undefined &&
      consentExpiresAtMs <= nowMs)
  ) {
    throw new DomainError(
      'ASSET_RIGHTS_BLOCKED',
      'Long-form source rights no longer allow indexing',
    )
  }
}

function assertLongFormCreationBinding(
  workflow: Readonly<LongFormIndexWorkflow>,
  context: Readonly<LongFormIndexCreationContext>,
): void {
  if (
    context.sourceArtifactId !== workflow.sourceArtifactId ||
    context.sourceArtifactSha256 !==
      workflow.sourceArtifactSha256 ||
    context.sourceManifestId !== workflow.sourceManifestId ||
    context.sourceManifestHash !== workflow.sourceManifestHash ||
    context.durationMs !== workflow.durationMs
  ) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Long-form source changed before moment indexing',
    )
  }
}

function assertHierarchicalBinding(
  workflow: Readonly<LongFormIndexWorkflow>,
  checkpoint: Readonly<LongFormIndexStageCheckpoint>,
  run: Readonly<PersistedHierarchicalProcessingRun>,
  expectedHash: string,
): void {
  const transcriptOutput = succeededOutput(
    workflow,
    'transcript',
  )
  if (
    run.workspaceId !== workflow.workspaceId ||
    run.projectId !== workflow.projectId ||
    run.sourceArtifactId !== workflow.sourceArtifactId ||
    run.sourceArtifactSha256 !== workflow.sourceArtifactSha256 ||
    run.sourceManifestId !== workflow.sourceManifestId ||
    run.sourceManifestHash !== workflow.sourceManifestHash ||
    run.sourceTranscriptId !== transcriptOutput.id ||
    run.sourceTranscriptHash !== transcriptOutput.hash ||
    run.durationMs !== workflow.durationMs ||
    run.runHash !== expectedHash ||
    run.idempotencyKey !== checkpoint.idempotencyKey
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Hierarchical output does not match its workflow checkpoint',
    )
  }
}

function assertDiarizationBinding(
  workflow: Readonly<LongFormIndexWorkflow>,
  checkpoint: Readonly<LongFormIndexStageCheckpoint>,
  run: Readonly<SpeakerDiarizationRun>,
  expectedHash: string,
): void {
  const transcriptOutput = succeededOutput(
    workflow,
    'transcript',
  )
  if (
    run.workspaceId !== workflow.workspaceId ||
    run.projectId !== workflow.projectId ||
    run.workflowId !== workflow.id ||
    run.sourceArtifactId !== workflow.sourceArtifactId ||
    run.sourceArtifactSha256 !== workflow.sourceArtifactSha256 ||
    run.sourceManifestId !== workflow.sourceManifestId ||
    run.sourceManifestHash !== workflow.sourceManifestHash ||
    run.sourceTranscriptId !== transcriptOutput.id ||
    run.sourceTranscriptHash !== transcriptOutput.hash ||
    run.durationMs !== workflow.durationMs ||
    run.runHash !== expectedHash ||
    run.idempotencyKey !== checkpoint.idempotencyKey
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Diarization output does not match its workflow checkpoint',
    )
  }
}

function overlappingSpeakerIds(
  diarization: Readonly<SpeakerDiarizationRun>,
  rangesMs: readonly (readonly [number, number])[],
): readonly string[] {
  const speakers = new Set<string>()
  for (const range of rangesMs) {
    for (const segment of diarization.segments) {
      if (
        segment.startMs < range[1] &&
        segment.endMs > range[0]
      ) {
        speakers.add(segment.speakerKey)
      }
    }
  }
  if (speakers.size === 0) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Long-form moment has no temporally overlapping speaker evidence',
    )
  }
  return Object.freeze([...speakers].sort())
}

function hierarchyInputs(
  run: Readonly<PersistedHierarchicalProcessingRun>,
  diarization: Readonly<SpeakerDiarizationRun>,
  confidence: number,
): Readonly<{
  chapters: readonly Readonly<LongFormChapterInput>[]
  moments: readonly Readonly<LongFormMomentInput>[]
}> {
  const chapters = Object.freeze(run.aggregation.chapters.map(
    (chapter) => Object.freeze({
      sourceChapterId: chapter.id,
      title: Object.freeze({
        value: chapter.title,
        confidence,
      }),
      topicPath: Object.freeze([chapter.title]),
      rangeMs: chapter.rangeMs,
    }),
  ))
  const moments = Object.freeze(run.aggregation.moments.map(
    (moment) => Object.freeze({
      sourceMomentId: moment.id,
      sourceChapterId: moment.chapterId,
      topic: Object.freeze({
        value: moment.topic,
        confidence,
      }),
      summary: Object.freeze({
        value: moment.summary,
        confidence,
      }),
      speakerIds: overlappingSpeakerIds(
        diarization,
        moment.rangesMs,
      ),
      rangesMs: moment.rangesMs,
      recommendedRangeIndex: 0,
      evidenceSpanIds: moment.evidenceSpanIds,
      salience: moment.salience,
      hookPotential: moment.salience,
      standaloneScore: moment.salience,
      contextScore: moment.salience,
      insightDensity: moment.salience,
      roles: Object.freeze([] as string[]),
      tags: Object.freeze([] as string[]),
    }),
  ))
  return Object.freeze({ chapters, moments })
}

function hierarchicalResult(
  run: Readonly<PersistedHierarchicalProcessingRun>,
): Readonly<LongFormIndexStageResult> {
  return Object.freeze({
    outputHash: run.runHash,
    outputEntityId: run.id,
    resultCount: run.measurement.chunkCount,
    costMinorUnits: run.measurement.cost.minorUnits,
    elapsedMs: run.measurement.elapsedMs,
  })
}

function momentResult(
  run: Readonly<PersistedLongFormIndexRun>,
  elapsedMs: number,
): Readonly<LongFormIndexStageResult> {
  return Object.freeze({
    outputHash: run.recordHash,
    outputEntityId: run.id,
    resultCount: run.momentCount,
    costMinorUnits: 0,
    elapsedMs,
  })
}

function transcriptEvidenceForMoments(
  run: Readonly<PersistedLongFormIndexRun>,
  hierarchical: Readonly<PersistedHierarchicalProcessingRun>,
  createId: (sourceId: string) => string,
) {
  return Object.freeze(run.moments.map((moment) => {
    const sourceMoment = hierarchical.aggregation.moments.find(
      (candidate) => candidate.id === moment.sourceMomentId,
    )
    if (!sourceMoment) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Long-form moment lost its hierarchical transcript source',
      )
    }
    const spans = sourceMoment.evidenceSpanIds.map((spanId) => {
      const span = hierarchical.evidenceSpans.find(
        (candidate) => candidate.id === spanId,
      )
      if (!span) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Long-form moment references missing transcript evidence',
        )
      }
      return span
    })
    return createLongFormMomentTranscriptEvidence({
      id: createId(moment.id),
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      indexRunId: run.id,
      indexRunHash: run.recordHash,
      momentId: moment.id,
      momentHash: moment.momentHash,
      hierarchicalRunId: hierarchical.id,
      hierarchicalRunHash: hierarchical.runHash,
      sourceTranscriptId: hierarchical.sourceTranscriptId,
      sourceTranscriptHash: hierarchical.sourceTranscriptHash,
      spans,
    })
  }))
}

export function createLongFormDerivedStageProcessor(
  dependencies: {
    hierarchical: HierarchicalProcessingRepository
    longForm: LongFormIndexRepository
    diarization: SpeakerDiarizationRepository
    contiguousEvidenceProducers:
      readonly Readonly<LongFormContiguousEvidenceProducer>[]
    contiguousEvaluation:
      Readonly<LongFormContiguousEvaluationProducer>
    createId: (
      kind:
        | 'hierarchical-processing-run'
        | 'long-form-index-run'
        | 'long-form-chapter'
        | 'long-form-moment'
        | 'long-form-transcript-evidence',
      sourceId?: string,
    ) => string
    clock?: () => Date
    monotonicClock?: () => number
    configuration?: Readonly<LongFormDerivedStageConfiguration>
  },
): LongFormIndexStageProcessor {
  const clock = dependencies.clock ?? (() => new Date())
  const monotonicClock =
    dependencies.monotonicClock ?? (() => performance.now())
  const configuration = dependencies.configuration ??
    DEFAULT_LONG_FORM_DERIVED_STAGE_CONFIGURATION
  if (
    !Number.isSafeInteger(
      configuration.chunks.chunkDurationMs,
    ) ||
    configuration.chunks.chunkDurationMs < 60_000 ||
    configuration.chunks.chunkDurationMs > 900_000 ||
    !Number.isSafeInteger(configuration.chunks.overlapMs) ||
    configuration.chunks.overlapMs < 0 ||
    configuration.chunks.overlapMs * 2 >=
      configuration.chunks.chunkDurationMs ||
    !Number.isSafeInteger(
      configuration.chunks.maximumWorkingSetBytes,
    ) ||
    configuration.chunks.maximumWorkingSetBytes < 1 ||
    configuration.chunks.maximumWorkingSetBytes >
      4 * 1024 * 1024 * 1024 ||
    !Number.isFinite(
      configuration.moments.producerConfidence,
    ) ||
    configuration.moments.producerConfidence < 0 ||
    configuration.moments.producerConfidence > 1
  ) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Long-form derived stage configuration is invalid',
    )
  }
  const evidenceKinds =
    dependencies.contiguousEvidenceProducers.map(
      (producer) => producer.kind,
    )
  if (
    evidenceKinds.length !== 5 ||
    new Set(evidenceKinds).size !== 5 ||
    ![
      'transcript-boundary',
      'transcript-density',
      'rights-integrity',
      'audio-analysis',
      'visual-analysis',
    ].every((kind) => evidenceKinds.includes(
      kind as typeof evidenceKinds[number],
    ))
  ) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Long-form moments require all transcript and rights evidence producers',
    )
  }

  const processChunks = async (
    input: StageProcessInput,
  ): Promise<Readonly<LongFormIndexStageResult>> => {
    assertRunningStage(
      input,
      'chunks',
      configuration.chunks.stageVersion,
    )
    const workflow = input.workflow
    const transcriptOutput = succeededOutput(
      workflow,
      'transcript',
    )
    const chunkCount = Math.ceil(
      workflow.durationMs /
        configuration.chunks.chunkDurationMs,
    )
    const estimatedCostMinorUnits =
      Object.values(
        HIERARCHICAL_COST_POLICY.perChunkMinorUnits,
      ).reduce<number>((total, cost) => total + cost, 0) *
      chunkCount
    const budget = effectiveStageBudget(
      workflow,
      input.checkpoint,
      estimatedCostMinorUnits,
    )
    if (!(await input.heartbeat())) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form chunks lease was lost before execution',
      )
    }
    let candidate:
      | Readonly<PersistedHierarchicalProcessingRun>
      | undefined
    const bufferedRepository: HierarchicalProcessingRepository = {
      async readSourceContext(request) {
        const context =
          await dependencies.hierarchical.readSourceContext(request)
        if (input.signal.aborted) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Long-form chunks operation was aborted during source validation',
          )
        }
        if (context) {
          assertCurrentIndexingRights(
            context.rights,
            clock().toISOString(),
          )
        }
        return context
      },
      findIdempotent: (request) =>
        dependencies.hierarchical.findIdempotent(request),
      findRun: (request) =>
        dependencies.hierarchical.findRun(request),
      async persist(run) {
        candidate = run
        return Object.freeze({ run, replayed: false })
      },
      persistWithLongFormLease: (request) =>
        dependencies.hierarchical
          .persistWithLongFormLease(request),
    }
    const execute = executeHierarchicalProcessingService({
      repository: bufferedRepository,
      clock,
      monotonicMs: monotonicClock,
      createId: () =>
        dependencies.createId(
          'hierarchical-processing-run',
        ),
    })
    const built = await execute({
      workspaceId: workflow.workspaceId,
      projectId: workflow.projectId,
      sourceArtifactId: workflow.sourceArtifactId,
      expectedArtifactSha256:
        workflow.sourceArtifactSha256,
      sourceManifestId: workflow.sourceManifestId,
      expectedManifestHash: workflow.sourceManifestHash,
      sourceTranscriptId: transcriptOutput.id,
      expectedTranscriptHash: transcriptOutput.hash,
      processingPolicyVersion:
        HIERARCHICAL_PROCESSING_POLICY_VERSION,
      chunking: Object.freeze({
        policyVersion: HIERARCHICAL_CHUNK_POLICY_VERSION,
        chunkDurationMs:
          configuration.chunks.chunkDurationMs,
        overlapMs: configuration.chunks.overlapMs,
      }),
      tierVersions: configuration.chunks.tierVersions,
      budget: Object.freeze({
        currency: 'USD',
        maxCostMinorUnits: budget.maximumCostMinorUnits,
        maxWorkingSetBytes:
          configuration.chunks.maximumWorkingSetBytes,
        maxElapsedMs: budget.maximumElapsedMs,
      }),
      actor: Object.freeze({
        type: 'api-client',
        id: workflow.createdByClientId,
      }),
      idempotencyKey: input.checkpoint.idempotencyKey,
    })
    assertIndexingRights(built.run)
    if (built.replayed) {
      return hierarchicalResult(built.run)
    }
    if (!candidate) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Long-form chunks produced no persistable output',
      )
    }
    if (
      candidate.measurement.cost.minorUnits >
        budget.maximumCostMinorUnits ||
      candidate.measurement.elapsedMs > budget.maximumElapsedMs
    ) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Long-form chunks exceeded its approved execution budget',
      )
    }
    if (input.signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form chunks operation was aborted before persistence',
      )
    }
    if (!(await input.heartbeat())) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form chunks lease was lost before persistence',
      )
    }
    const persisted =
      await dependencies.hierarchical.persistWithLongFormLease({
        run: candidate,
        fence: stageFence(
          input,
          'chunks',
          clock().toISOString(),
        ),
      })
    if (!persisted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form chunks lease was lost during persistence',
      )
    }
    return hierarchicalResult(persisted.run)
  }

  const processMoments = async (
    input: StageProcessInput,
  ): Promise<Readonly<LongFormIndexStageResult>> => {
    assertRunningStage(
      input,
      'moments',
      configuration.moments.stageVersion,
    )
    const workflow = input.workflow
    const budget = effectiveStageBudget(
      workflow,
      input.checkpoint,
      0,
    )
    if (!(await input.heartbeat())) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form moments lease was lost before execution',
      )
    }
    const chunksOutput = succeededOutput(workflow, 'chunks')
    const diarizationOutput =
      succeededOutput(workflow, 'diarization')
    const [hierarchicalRun, diarizationRun] =
      await Promise.all([
        dependencies.hierarchical.findRun({
          workspaceId: workflow.workspaceId,
          projectId: workflow.projectId,
          runId: chunksOutput.id,
        }),
        dependencies.diarization.findRun({
          workspaceId: workflow.workspaceId,
          projectId: workflow.projectId,
          runId: diarizationOutput.id,
        }),
      ])
    if (input.signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form moments operation was aborted during prerequisite validation',
      )
    }
    if (!hierarchicalRun || !diarizationRun) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Long-form prerequisite output was not found',
      )
    }
    assertHierarchicalBinding(
      workflow,
      chunksOutput.checkpoint,
      hierarchicalRun,
      chunksOutput.hash,
    )
    assertDiarizationBinding(
      workflow,
      diarizationOutput.checkpoint,
      diarizationRun,
      diarizationOutput.hash,
    )
    assertIndexingRights(hierarchicalRun)
    const creationContext =
      await dependencies.longForm.readCreationContext({
        workspaceId: workflow.workspaceId,
        projectId: workflow.projectId,
        sourceArtifactId: workflow.sourceArtifactId,
        sourceManifestId: workflow.sourceManifestId,
      })
    if (!creationContext) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Long-form source is no longer available for moment indexing',
      )
    }
    if (input.signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form moments operation was aborted during rights validation',
      )
    }
    assertLongFormCreationBinding(workflow, creationContext)
    assertCurrentIndexingRights(
      creationContext.rights,
      clock().toISOString(),
    )
    const hierarchy = hierarchyInputs(
      hierarchicalRun,
      diarizationRun,
      configuration.moments.producerConfidence,
    )
    let candidate:
      | Readonly<PersistedLongFormIndexRun>
      | undefined
    const bufferedRepository: LongFormIndexRepository = {
      async readCreationContext(request) {
        if (
          request.workspaceId !== workflow.workspaceId ||
          request.projectId !== workflow.projectId ||
          request.sourceArtifactId !==
            workflow.sourceArtifactId ||
          request.sourceManifestId !== workflow.sourceManifestId
        ) {
          return null
        }
        return creationContext
      },
      findIdempotent: (request) =>
        dependencies.longForm.findIdempotent(request),
      async persist(run) {
        candidate = run
        return Object.freeze({ run, replayed: false })
      },
      persistWithLongFormLease: (request) =>
        dependencies.longForm
          .persistWithLongFormLease(request),
      search: (request) =>
        dependencies.longForm.search(request),
    }
    const startedAt = monotonicClock()
    const catalog = catalogLongFormMomentsService({
      repository: bufferedRepository,
      clock,
      createId: (kind, sourceId) =>
        dependencies.createId(kind, sourceId),
    })
    const built = await catalog({
      workspaceId: workflow.workspaceId,
      projectId: workflow.projectId,
      sourceArtifactId: workflow.sourceArtifactId,
      expectedArtifactSha256:
        workflow.sourceArtifactSha256,
      sourceManifestId: workflow.sourceManifestId,
      expectedManifestHash: workflow.sourceManifestHash,
      indexPolicyVersion: LONG_FORM_INDEX_POLICY_VERSION,
      producer: Object.freeze({
        ...hierarchicalRun.tierVersions.language,
        confidence:
          configuration.moments.producerConfidence,
      }),
      chapters: hierarchy.chapters,
      moments: hierarchy.moments,
      actor: Object.freeze({
        type: 'api-client',
        id: workflow.createdByClientId,
      }),
      idempotencyKey: input.checkpoint.idempotencyKey,
    })
    const elapsedMs = built.replayed
      ? 0
      : Math.max(
          0,
          Math.ceil(monotonicClock() - startedAt),
        )
    assertIndexingRights(built.run)
    let persistedRun = built.run
    const transcriptEvidence = transcriptEvidenceForMoments(
      built.run,
      hierarchicalRun,
      (sourceId) => dependencies.createId(
        'long-form-transcript-evidence',
        sourceId,
      ),
    )
    if (!built.replayed && !candidate) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Long-form moments produced no persistable output',
      )
    }
    if (!built.replayed && elapsedMs > budget.maximumElapsedMs) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Long-form moments exceeded its approved execution budget',
      )
    }
    if (input.signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form moments operation was aborted before persistence',
      )
    }
    if (!(await input.heartbeat())) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form moments lease was lost before persistence',
      )
    }
    if (!built.replayed) {
      const persisted =
        await dependencies.longForm.persistWithLongFormLease({
          run: candidate!,
          transcriptEvidence,
          fence: stageFence(
            input,
            'moments',
            clock().toISOString(),
          ),
        })
      if (!persisted) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Long-form moments lease was lost during persistence',
        )
      }
      persistedRun = persisted.run
    }
    for (const producer of
      dependencies.contiguousEvidenceProducers) {
      if (input.signal.aborted || !(await input.heartbeat())) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Long-form moments lease was lost before contiguous evidence',
        )
      }
      await producer.produce({
        workspaceId: workflow.workspaceId,
        projectId: workflow.projectId,
        indexRunId: persistedRun.id,
        actor: Object.freeze({
          type: 'api-client',
          id: workflow.createdByClientId,
        }),
        idempotencyKey: `${producer.kind}-${calculateCanonicalHash({
          stageIdempotencyKey: input.checkpoint.idempotencyKey,
          indexRunId: persistedRun.id,
          indexRunHash: persistedRun.recordHash,
          evidenceKind: producer.kind,
        }).slice(0, 48)}`,
        signal: input.signal,
        fence: stageFence(
          input,
          'moments',
          clock().toISOString(),
        ),
      })
    }
    if (input.signal.aborted || !(await input.heartbeat())) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form moments lease was lost before contiguous evaluation',
      )
    }
    await dependencies.contiguousEvaluation.produce({
      workspaceId: workflow.workspaceId,
      projectId: workflow.projectId,
      indexRunId: persistedRun.id,
      actor: Object.freeze({
        type: 'api-client',
        id: workflow.createdByClientId,
      }),
      idempotencyKey: `quality-evaluation-${calculateCanonicalHash({
        stageIdempotencyKey: input.checkpoint.idempotencyKey,
        indexRunId: persistedRun.id,
        indexRunHash: persistedRun.recordHash,
        evaluator: 'contiguous-evidence-policy/1.0.0',
      }).slice(0, 48)}`,
      signal: input.signal,
      fence: stageFence(
        input,
        'moments',
        clock().toISOString(),
      ),
    })
    return momentResult(persistedRun, elapsedMs)
  }

  return Object.freeze({
    async process(input: StageProcessInput) {
      if (input.checkpoint.stage === 'chunks') {
        return processChunks(input)
      }
      if (input.checkpoint.stage === 'moments') {
        return processMoments(input)
      }
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Derived long-form processor supports only chunks and moments',
      )
    },
  })
}

export function createLongFormIndexStageRouter(
  processors: Readonly<
    Partial<Record<LongFormIndexStage, LongFormIndexStageProcessor>>
  >,
): LongFormIndexStageProcessor {
  return Object.freeze({
    process(input: StageProcessInput) {
      const processor = processors[input.checkpoint.stage]
      if (!processor) {
        throw new DomainError(
          'PERSISTENCE_NOT_CONFIGURED',
          `Long-form ${input.checkpoint.stage} processor is not configured`,
        )
      }
      return processor.process(input)
    },
  })
}
