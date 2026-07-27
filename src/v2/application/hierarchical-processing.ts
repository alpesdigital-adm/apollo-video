import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  aggregateHierarchicalMoments,
  chunkLongForm,
  createHierarchicalEvidenceSpans,
  estimateHierarchicalFixture,
  HIERARCHICAL_CHUNK_POLICY_VERSION,
  HIERARCHICAL_COST_POLICY,
  HIERARCHICAL_PROCESSING_POLICY_VERSION,
  HIERARCHICAL_PROCESSING_TIERS,
  normalizeHierarchicalTierVersions,
  planHierarchicalProcessing,
  processCheapSignals,
  processHierarchicalLanguage,
  processHierarchicalVision,
  type HierarchicalAggregation,
  type HierarchicalChunk,
  type HierarchicalEvidenceSpan,
  type HierarchicalLanguageCandidate,
  type HierarchicalTierVersions,
  type HierarchicalVisionObservation,
  type ProcessingTier,
} from '../domain/hierarchical-processing.ts'
import type {
  HierarchicalProcessingBudget,
  HierarchicalProcessingRepository,
  HierarchicalTierExecution,
  PersistedHierarchicalProcessingRun,
} from './ports/hierarchical-processing-repository.ts'

export {
  aggregateHierarchicalMoments,
  chunkLongForm,
  estimateHierarchicalFixture,
  planHierarchicalProcessing,
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA_256 = /^[a-f0-9]{64}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      SHA_256.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    `${field} must be SHA-256`,
  )
  return value.trim().toLowerCase()
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between ${minimum} and ${maximum}`,
  )
  return Number(value)
}

function instant(value: Date, field: string): string {
  assertDomain(
    value instanceof Date && !Number.isNaN(value.getTime()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.toISOString()
}

function normalizedBudget(
  input: Readonly<HierarchicalProcessingBudget>,
): Readonly<HierarchicalProcessingBudget> {
  assertDomain(
    input.currency === 'USD',
    'INVALID_ARGUMENT',
    'budget.currency must be USD',
  )
  return Object.freeze({
    currency: 'USD' as const,
    maxCostMinorUnits: integer(
      input.maxCostMinorUnits,
      'budget.maxCostMinorUnits',
      0,
      10_000_000,
    ),
    maxWorkingSetBytes: integer(
      input.maxWorkingSetBytes,
      'budget.maxWorkingSetBytes',
      1,
      4 * 1024 * 1024 * 1024,
    ),
    maxElapsedMs: integer(
      input.maxElapsedMs,
      'budget.maxElapsedMs',
      1,
      24 * 60 * 60 * 1_000,
    ),
  })
}

function outputHash(
  tier: ProcessingTier,
  outputs: {
    chunks: readonly Readonly<HierarchicalChunk>[]
    evidenceSpans: readonly Readonly<HierarchicalEvidenceSpan>[]
    visionObservations:
      readonly Readonly<HierarchicalVisionObservation>[]
    languageCandidates:
      readonly Readonly<HierarchicalLanguageCandidate>[]
    aggregation: Readonly<HierarchicalAggregation>
  },
): string {
  if (tier === 'cheap-signals') {
    return calculateCanonicalHash({
      chunks: outputs.chunks,
      evidenceSpans: outputs.evidenceSpans,
    })
  }
  if (tier === 'vision') {
    return calculateCanonicalHash(outputs.visionObservations)
  }
  if (tier === 'language') {
    return calculateCanonicalHash(outputs.languageCandidates)
  }
  return outputs.aggregation.aggregationHash
}

function calculateRunHash(
  run: Omit<PersistedHierarchicalProcessingRun, 'runHash' | 'active'>,
): string {
  return calculateCanonicalHash(run)
}

export { calculateRunHash as calculateHierarchicalProcessingRunHash }

function sameSource(
  previous: Readonly<PersistedHierarchicalProcessingRun>,
  current: Readonly<{
    sourceArtifactId: string
    sourceArtifactSha256: string
    sourceManifestId: string
    sourceManifestHash: string
    sourceTranscriptId: string
    sourceTranscriptHash: string
  }>,
): boolean {
  return previous.sourceArtifactId === current.sourceArtifactId &&
    previous.sourceArtifactSha256 === current.sourceArtifactSha256 &&
    previous.sourceManifestId === current.sourceManifestId &&
    previous.sourceManifestHash === current.sourceManifestHash &&
    previous.sourceTranscriptId === current.sourceTranscriptId &&
    previous.sourceTranscriptHash === current.sourceTranscriptHash
}

function previousTierExecution(
  previous: Readonly<PersistedHierarchicalProcessingRun>,
  tier: ProcessingTier,
): Readonly<HierarchicalTierExecution> {
  const execution = previous.tierExecutions.find(
    (item) => item.tier === tier,
  )
  if (!execution) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Previous hierarchical run has no ${tier} execution`,
    )
  }
  return execution
}

function tierCost(tier: ProcessingTier, chunkCount: number): number {
  return HIERARCHICAL_COST_POLICY.perChunkMinorUnits[tier] * chunkCount
}

function estimateRequiredWorkingSet(
  transcriptSegmentCount: number,
  chunkCount: number,
): number {
  return transcriptSegmentCount * 2_048 + chunkCount * 32_768
}

export function executeHierarchicalProcessingService(dependencies: {
  repository: HierarchicalProcessingRepository
  clock: () => Date
  monotonicMs: () => number
  createId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    expectedArtifactSha256: string
    sourceManifestId: string
    expectedManifestHash: string
    sourceTranscriptId: string
    expectedTranscriptHash: string
    processingPolicyVersion: string
    chunking: Readonly<{
      policyVersion: string
      chunkDurationMs: number
      overlapMs: number
    }>
    tierVersions: Readonly<Record<string, unknown>>
    previousRun?: Readonly<{
      id: string
      expectedRunHash: string
    }>
    budget: Readonly<HierarchicalProcessingBudget>
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const source = Object.freeze({
      sourceArtifactId: identity(
        request.sourceArtifactId,
        'sourceArtifactId',
      ),
      sourceArtifactSha256: hash(
        request.expectedArtifactSha256,
        'expectedArtifactSha256',
      ),
      sourceManifestId: identity(
        request.sourceManifestId,
        'sourceManifestId',
      ),
      sourceManifestHash: hash(
        request.expectedManifestHash,
        'expectedManifestHash',
      ),
      sourceTranscriptId: identity(
        request.sourceTranscriptId,
        'sourceTranscriptId',
      ),
      sourceTranscriptHash: hash(
        request.expectedTranscriptHash,
        'expectedTranscriptHash',
      ),
    })
    assertDomain(
      request.processingPolicyVersion ===
        HIERARCHICAL_PROCESSING_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `processingPolicyVersion must be ${HIERARCHICAL_PROCESSING_POLICY_VERSION}`,
    )
    assertDomain(
      request.chunking?.policyVersion ===
        HIERARCHICAL_CHUNK_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `chunking.policyVersion must be ${HIERARCHICAL_CHUNK_POLICY_VERSION}`,
    )
    const chunkDurationMs = integer(
      request.chunking.chunkDurationMs,
      'chunking.chunkDurationMs',
      60_000,
      900_000,
    )
    const overlapMs = integer(
      request.chunking.overlapMs,
      'chunking.overlapMs',
      0,
      60_000,
    )
    assertDomain(
      overlapMs * 2 < chunkDurationMs,
      'INVALID_ARGUMENT',
      'chunking.overlapMs must be less than half the chunk duration',
    )
    const tierVersions = normalizeHierarchicalTierVersions(
      request.tierVersions,
    )
    const budget = normalizedBudget(request.budget)
    assertDomain(
      request.actor?.type === 'api-client',
      'AUTH_INVALID',
      'Hierarchical processing requires an authenticated API client',
    )
    const actorId = identity(request.actor.id, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const previousRun = request.previousRun
      ? Object.freeze({
          id: identity(request.previousRun.id, 'previousRun.id'),
          expectedRunHash: hash(
            request.previousRun.expectedRunHash,
            'previousRun.expectedRunHash',
          ),
        })
      : undefined
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'execute-hierarchical-processing-request/v1',
      workspaceId,
      projectId,
      ...source,
      processingPolicyVersion:
        HIERARCHICAL_PROCESSING_POLICY_VERSION,
      chunking: {
        policyVersion: HIERARCHICAL_CHUNK_POLICY_VERSION,
        chunkDurationMs,
        overlapMs,
      },
      tierVersions,
      previousRun,
      budget,
      actor: { type: 'api-client', id: actorId },
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different hierarchical request',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }
    const context = await dependencies.repository.readSourceContext({
      workspaceId,
      projectId,
      sourceArtifactId: source.sourceArtifactId,
      sourceManifestId: source.sourceManifestId,
      sourceTranscriptId: source.sourceTranscriptId,
      ...(previousRun ? { previousRunId: previousRun.id } : {}),
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Hierarchical processing source was not found',
      )
    }
    if (
      context.sourceArtifactSha256 !== source.sourceArtifactSha256 ||
      context.sourceManifestHash !== source.sourceManifestHash ||
      context.sourceTranscriptHash !== source.sourceTranscriptHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Hierarchical processing source changed before execution',
        {
          currentArtifactSha256: context.sourceArtifactSha256,
          currentManifestHash: context.sourceManifestHash,
          currentTranscriptHash: context.sourceTranscriptHash,
        },
      )
    }
    if (previousRun) {
      assertDomain(
        context.previousRun?.runHash === previousRun.expectedRunHash,
        'VERSION_CONFLICT',
        'Previous hierarchical processing run changed or was not found',
      )
      assertDomain(
        sameSource(context.previousRun, source),
        'VERSION_CONFLICT',
        'Previous hierarchical run belongs to a different source',
      )
    }
    const baseChunks = chunkLongForm({
      artifactId: source.sourceArtifactId,
      durationMs: context.durationMs,
      chunkDurationMs,
      overlapMs,
    })
    const chunkConfigurationChanged = Boolean(
      context.previousRun &&
      (
        context.previousRun.chunkDurationMs !== chunkDurationMs ||
        context.previousRun.overlapMs !== overlapMs ||
        context.previousRun.chunkPolicyVersion !==
          HIERARCHICAL_CHUNK_POLICY_VERSION
      ),
    )
    const plan = planHierarchicalProcessing({
      tierVersions,
      ...(context.previousRun
        ? { previousTierVersions: context.previousRun.tierVersions }
        : {}),
      chunkConfigurationChanged,
    })
    const estimatedCostMinorUnits = plan.executionOrder.reduce(
      (total, tier) => total + tierCost(tier, baseChunks.length),
      0,
    )
    const estimatedWorkingSetBytes = estimateRequiredWorkingSet(
      context.transcriptSegments.length,
      baseChunks.length,
    )
    assertDomain(
      estimatedCostMinorUnits <= budget.maxCostMinorUnits,
      'INVALID_ARGUMENT',
      'Hierarchical processing exceeds the cost budget',
      {
        estimatedCostMinorUnits,
        maxCostMinorUnits: budget.maxCostMinorUnits,
      },
    )
    assertDomain(
      estimatedWorkingSetBytes <= budget.maxWorkingSetBytes,
      'INVALID_ARGUMENT',
      'Hierarchical processing exceeds the memory budget',
      {
        estimatedWorkingSetBytes,
        maxWorkingSetBytes: budget.maxWorkingSetBytes,
      },
    )

    const runId = identity(
      dependencies.createId(),
      'hierarchicalProcessingRunId',
    )
    const createdAt = instant(
      dependencies.clock(),
      'hierarchical processing clock',
    )
    let chunks: readonly Readonly<HierarchicalChunk>[]
    let evidenceSpans: readonly Readonly<HierarchicalEvidenceSpan>[]
    let visionObservations:
      readonly Readonly<HierarchicalVisionObservation>[]
    let languageCandidates:
      readonly Readonly<HierarchicalLanguageCandidate>[]
    let aggregation: Readonly<HierarchicalAggregation>
    const executions: HierarchicalTierExecution[] = []

    const runTier = <T>(
      tier: ProcessingTier,
      process: () => Readonly<T & { workingSetBytes: number }>,
      reuse: () => T,
    ): T => {
      const tierPlan = plan.tiers.find((item) => item.tier === tier)!
      if (tierPlan.status === 'reuse') {
        assertDomain(
          Boolean(context.previousRun),
          'PERSISTENCE_CONFLICT',
          `Cannot reuse ${tier} without a previous run`,
        )
        const previousExecution = previousTierExecution(
          context.previousRun!,
          tier,
        )
        const reused = reuse()
        const reusedHash = outputHash(tier, {
          chunks: tier === 'cheap-signals'
            ? (reused as unknown as {
                chunks: readonly Readonly<HierarchicalChunk>[]
              }).chunks
            : context.previousRun!.chunks,
          evidenceSpans: tier === 'cheap-signals'
            ? (reused as unknown as {
                evidenceSpans:
                  readonly Readonly<HierarchicalEvidenceSpan>[]
              }).evidenceSpans
            : context.previousRun!.evidenceSpans,
          visionObservations: tier === 'vision'
            ? (reused as unknown as {
                observations:
                  readonly Readonly<HierarchicalVisionObservation>[]
              }).observations
            : context.previousRun!.visionObservations,
          languageCandidates: tier === 'language'
            ? (reused as unknown as {
                candidates:
                  readonly Readonly<HierarchicalLanguageCandidate>[]
              }).candidates
            : context.previousRun!.languageCandidates,
          aggregation: tier === 'aggregation'
            ? reused as unknown as HierarchicalAggregation
            : context.previousRun!.aggregation,
        })
        assertDomain(
          reusedHash === previousExecution.outputHash,
          'PERSISTENCE_CONFLICT',
          `Previous ${tier} output failed integrity validation`,
        )
        executions.push(Object.freeze({
          tier,
          sequence: tierPlan.sequence,
          version: tierPlan.version,
          prerequisites: tierPlan.prerequisites,
          status: 'reused' as const,
          reusedFromRunId: context.previousRun!.id,
          startedAt: createdAt,
          completedAt: createdAt,
          elapsedMs: 0,
          workingSetBytes: 0,
          costMinorUnits: 0,
          outputHash: reusedHash,
        }))
        return reused
      }
      const startedAt = instant(
        dependencies.clock(),
        `${tier} start clock`,
      )
      const start = dependencies.monotonicMs()
      const processed = process()
      const elapsedMs = Math.max(
        1,
        Math.ceil(dependencies.monotonicMs() - start),
      )
      const completedAt = instant(
        dependencies.clock(),
        `${tier} completion clock`,
      )
      const typed = processed as unknown as T
      const processedHash = outputHash(tier, {
        chunks: tier === 'cheap-signals'
          ? (processed as unknown as {
              chunks: readonly Readonly<HierarchicalChunk>[]
            }).chunks
          : chunks!,
        evidenceSpans: tier === 'cheap-signals'
          ? (processed as unknown as {
              evidenceSpans:
                readonly Readonly<HierarchicalEvidenceSpan>[]
            }).evidenceSpans
          : evidenceSpans!,
        visionObservations: tier === 'vision'
          ? (processed as unknown as {
              observations:
                readonly Readonly<HierarchicalVisionObservation>[]
            }).observations
          : visionObservations ?? Object.freeze([]),
        languageCandidates: tier === 'language'
          ? (processed as unknown as {
              candidates:
                readonly Readonly<HierarchicalLanguageCandidate>[]
            }).candidates
          : languageCandidates ?? Object.freeze([]),
        aggregation: tier === 'aggregation'
          ? processed as unknown as HierarchicalAggregation
          : aggregation ?? {
              chapters: Object.freeze([]),
              moments: Object.freeze([]),
              evidencePreserved: true,
              aggregationHash: '0'.repeat(64),
            },
      })
      executions.push(Object.freeze({
        tier,
        sequence: tierPlan.sequence,
        version: tierPlan.version,
        prerequisites: tierPlan.prerequisites,
        status: 'processed' as const,
        startedAt,
        completedAt,
        elapsedMs,
        workingSetBytes: processed.workingSetBytes,
        costMinorUnits: tierCost(tier, baseChunks.length),
        outputHash: processedHash,
      }))
      return typed
    }

    const cheap = runTier(
      'cheap-signals',
      () => {
        const spans = createHierarchicalEvidenceSpans({
          transcriptId: source.sourceTranscriptId,
          durationMs: context.durationMs,
          segments: context.transcriptSegments,
          chunks: baseChunks,
        })
        return processCheapSignals({
          chunks: baseChunks,
          evidenceSpans: spans,
        })
      },
      () => ({
        chunks: context.previousRun!.chunks,
        evidenceSpans: context.previousRun!.evidenceSpans,
      }),
    )
    chunks = cheap.chunks
    evidenceSpans = cheap.evidenceSpans

    const vision = runTier(
      'vision',
      () => processHierarchicalVision({
        chunks,
        width: context.probe.width,
        height: context.probe.height,
        fps: context.probe.fps,
        catalogedVisualObservationCount:
          context.catalogedVisualObservationCount,
      }),
      () => ({
        observations: context.previousRun!.visionObservations,
      }),
    )
    visionObservations = vision.observations

    const language = runTier(
      'language',
      () => processHierarchicalLanguage({
        chunks,
        evidenceSpans,
      }),
      () => ({
        candidates: context.previousRun!.languageCandidates,
      }),
    )
    languageCandidates = language.candidates

    const aggregated = runTier(
      'aggregation',
      () => aggregateHierarchicalMoments({
        candidates: languageCandidates,
        evidenceSpans,
      }),
      () => context.previousRun!.aggregation,
    )
    aggregation = Object.freeze({
      chapters: aggregated.chapters,
      moments: aggregated.moments,
      evidencePreserved: true,
      aggregationHash: aggregated.aggregationHash,
    })

    const workingSetBytes = executions.reduce(
      (total, execution) => total + execution.workingSetBytes,
      0,
    )
    const costMinorUnits = executions.reduce(
      (total, execution) => total + execution.costMinorUnits,
      0,
    )
    const elapsedMs = executions.reduce(
      (total, execution) => total + execution.elapsedMs,
      0,
    )
    const fixture = estimateHierarchicalFixture({
      durationMs: context.durationMs,
      chunkCount: chunks.length,
      workingSetBytes,
      costMinorUnits,
      elapsedMs,
    })
    assertDomain(
      workingSetBytes <= budget.maxWorkingSetBytes &&
        elapsedMs <= budget.maxElapsedMs &&
        costMinorUnits <= budget.maxCostMinorUnits,
      'INVALID_ARGUMENT',
      'Hierarchical processing exceeded its execution budget',
      {
        workingSetBytes,
        elapsedMs,
        costMinorUnits,
      },
    )
    const measurementBody = {
      schemaVersion:
        'hierarchical-processing-measurement/v1' as const,
      durationMs: context.durationMs,
      chunkCount: chunks.length,
      evidenceSpanCount: evidenceSpans.length,
      processedTierCount: executions.filter(
        (execution) => execution.status === 'processed',
      ).length,
      reusedTierCount: executions.filter(
        (execution) => execution.status === 'reused',
      ).length,
      workingSetBytes,
      cost: Object.freeze({
        policyVersion: HIERARCHICAL_COST_POLICY.schemaVersion,
        currency: HIERARCHICAL_COST_POLICY.currency,
        minorUnits: costMinorUnits,
      }),
      elapsedMs,
      bounded: fixture.bounded,
    }
    const measurement = Object.freeze({
      ...measurementBody,
      measurementHash: calculateCanonicalHash(measurementBody),
    })
    const content = Object.freeze({
      schemaVersion: 'hierarchical-processing-run/v1' as const,
      id: runId,
      workspaceId,
      projectId,
      ...source,
      durationMs: context.durationMs,
      rightsSnapshotId: context.rights.id,
      rightsStatus: context.rights.status,
      consentStatus: context.rights.consentStatus,
      processingPolicyVersion:
        HIERARCHICAL_PROCESSING_POLICY_VERSION,
      chunkPolicyVersion: HIERARCHICAL_CHUNK_POLICY_VERSION,
      chunkDurationMs,
      overlapMs,
      tierVersions,
      ...(context.previousRun
        ? {
            previousRunId: context.previousRun.id,
            previousRunHash: context.previousRun.runHash,
          }
        : {}),
      plan,
      chunks,
      evidenceSpans,
      visionObservations,
      languageCandidates,
      aggregation,
      tierExecutions: Object.freeze(
        [...executions].sort((left, right) =>
          left.sequence - right.sequence),
      ),
      budget,
      measurement,
      physicalMaterialized: false as const,
      requestFingerprint,
      idempotencyKey: key,
      createdBy: Object.freeze({
        type: 'api-client' as const,
        id: actorId,
      }),
      createdAt,
    })
    const run = Object.freeze({
      ...content,
      runHash: calculateRunHash(content),
      active: true,
    })
    return dependencies.repository.persist(run)
  }
}

export function readHierarchicalProcessingRunService(dependencies: {
  repository: HierarchicalProcessingRepository
}) {
  return async function read(input: {
    workspaceId: string
    projectId: string
    runId: string
  }) {
    const run = await dependencies.repository.findRun({
      workspaceId: identity(input.workspaceId, 'workspaceId'),
      projectId: identity(input.projectId, 'projectId'),
      runId: identity(input.runId, 'runId'),
    })
    if (!run) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Hierarchical processing run was not found',
      )
    }
    return run
  }
}
