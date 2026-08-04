import type {
  ContiguousEvaluationDecision,
  ContiguousEvaluationMomentSource,
  ContiguousEvaluationProvider,
  ContiguousEvaluationRepository,
  ContiguousEvaluationSource,
  PersistedContiguousEvaluationRun,
} from './ports/contiguous-evaluation-provider.ts'
import {
  calculateCanonicalHash,
} from '../domain/canonical-hash.ts'
import {
  CONTIGUOUS_EXTRACTION_POLICY_VERSION,
  createContiguousMomentEvaluation,
  type ContiguousQualityDimension,
} from '../domain/contiguous-extraction.ts'
import { DomainError } from '../domain/errors.ts'
import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import type {
  LongFormStagePersistenceFence,
} from './ports/long-form-stage-persistence.ts'
import {
  createProjectAnalysisExecutionContext,
  projectAnalysisProvenanceFromFence,
} from './project-analysis-execution.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const DIMENSIONS = [
  'selfContained',
  'density',
  'integrity',
  'audio',
  'visual',
] as const satisfies readonly ContiguousQualityDimension[]

function identity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value.trim())) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value.trim()
}

function hash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a lowercase SHA-256`,
    )
  }
  return value
}

function providerIdentity(
  provider: ContiguousEvaluationProvider['identity'],
) {
  const normalized = {
    provider: provider.provider?.trim(),
    model: provider.model?.trim(),
    version: provider.version?.trim(),
  }
  if (
    !TOKEN.test(normalized.provider) ||
    !TOKEN.test(normalized.model) ||
    !TOKEN.test(normalized.version)
  ) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Contiguous evaluation provider identity is invalid',
    )
  }
  return Object.freeze(normalized)
}

function assertSource(
  source: Readonly<ContiguousEvaluationSource>,
  expected: {
    workspaceId: string
    projectId: string
    indexRunId: string
  },
): void {
  if (
    source.workspaceId !== expected.workspaceId ||
    source.projectId !== expected.projectId ||
    source.indexRunId !== expected.indexRunId ||
    !HASH.test(source.indexRunHash) ||
    !Number.isSafeInteger(source.sourceDurationMs) ||
    source.sourceDurationMs < 1_000 ||
    source.sourceDurationMs > 43_200_000 ||
    source.rightsStatus !== 'approved' ||
    !['approved', 'not-required'].includes(source.consentStatus) ||
    source.moments.length < 1 ||
    source.moments.length > 10_000 ||
    new Set(source.moments.map((moment) => moment.id)).size !==
      source.moments.length
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Contiguous evaluation source is invalid or unauthorized',
    )
  }
  const sourceIdentities = [
    source.sourceArtifactId,
    source.sourceManifestId,
    source.rightsSnapshotId,
  ]
  const sourceHashes = [
    source.sourceArtifactSha256,
    source.sourceManifestHash,
  ]
  if (
    sourceIdentities.some((value) => !ID.test(value)) ||
    sourceHashes.some((value) => !HASH.test(value)) ||
    source.moments.some((moment) => {
      const recommended = moment.recommendedRangeMs
      const evidenceIds = moment.evidence.map((item) => item.id)
      return (
        !ID.test(moment.id) ||
        !HASH.test(moment.momentHash) ||
        !ID.test(moment.chapterId) ||
        typeof moment.topic !== 'string' ||
        moment.topic.trim().length < 1 ||
        moment.topic.trim().length > 500 ||
        !Array.isArray(recommended) ||
        recommended.length !== 2 ||
        !Number.isSafeInteger(recommended[0]) ||
        !Number.isSafeInteger(recommended[1]) ||
        recommended[0] < 0 ||
        recommended[1] <= recommended[0] ||
        recommended[1] > source.sourceDurationMs ||
        moment.evidence.length < 5 ||
        moment.evidence.length > 160 ||
        new Set(evidenceIds).size !== evidenceIds.length ||
        moment.evidence.some((evidence) =>
          !ID.test(evidence.id) ||
          evidence.sourceIndexRunId !== source.indexRunId ||
          evidence.sourceIndexRunHash !== source.indexRunHash ||
          evidence.sourceMomentId !== moment.id ||
          evidence.sourceMomentHash !== moment.momentHash ||
          !HASH.test(evidence.evidenceHash) ||
          !TOKEN.test(evidence.producer?.provider) ||
          !TOKEN.test(evidence.producer?.model) ||
          !TOKEN.test(evidence.producer?.version) ||
          !HASH.test(evidence.producer?.inputHash) ||
          !HASH.test(evidence.producer?.outputHash) ||
          !Array.isArray(evidence.dimensions) ||
          evidence.dimensions.length < 1 ||
          evidence.dimensions.some((dimension) =>
            !DIMENSIONS.includes(dimension),
          ) ||
          new Set(evidence.dimensions).size !==
            evidence.dimensions.length ||
          !Array.isArray(evidence.rangeMs) ||
          evidence.rangeMs.length !== 2 ||
          !Number.isSafeInteger(evidence.rangeMs[0]) ||
          !Number.isSafeInteger(evidence.rangeMs[1]) ||
          evidence.rangeMs[0] < 0 ||
          evidence.rangeMs[1] <= evidence.rangeMs[0] ||
          evidence.rangeMs[1] > source.sourceDurationMs ||
          typeof evidence.facts !== 'object' ||
          evidence.facts === null ||
          Array.isArray(evidence.facts) ||
          Object.values(evidence.facts).some((fact) =>
            !['string', 'number', 'boolean'].includes(typeof fact) ||
            (typeof fact === 'number' && !Number.isFinite(fact)),
          ),
        )
      )
    })
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Contiguous evaluation evidence bundle is invalid',
    )
  }
}

function assertDecisionCoverage(
  source: readonly Readonly<ContiguousEvaluationMomentSource>[],
  decisions: readonly Readonly<ContiguousEvaluationDecision>[],
): void {
  if (
    decisions.some((decision) =>
      typeof decision !== 'object' ||
      decision === null ||
      Array.isArray(decision),
    ) ||
    decisions.length !== source.length ||
    new Set(decisions.map((decision) => decision.momentId)).size !==
      decisions.length ||
    source.some((moment) =>
      !decisions.some((decision) => decision.momentId === moment.id),
    )
  ) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      'Contiguous evaluator must decide every source moment exactly once',
    )
  }
}

function validateEvidence(
  moment: Readonly<ContiguousEvaluationMomentSource>,
  dimension: ContiguousQualityDimension,
  references: readonly string[],
): void {
  if (
    !Array.isArray(references) ||
    references.length < 1 ||
    references.length > 32 ||
    new Set(references).size !== references.length ||
    references.some((reference) =>
      !moment.evidence.some((evidence) =>
        evidence.id === reference &&
        evidence.dimensions.includes(dimension),
      ),
    )
  ) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      `Contiguous evaluator cited invalid ${dimension} evidence`,
    )
  }
}

function normalizeDecisions(
  source: Readonly<ContiguousEvaluationSource>,
  decisions: readonly Readonly<ContiguousEvaluationDecision>[],
) {
  if (!Array.isArray(decisions)) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      'Contiguous evaluator response is invalid',
    )
  }
  assertDecisionCoverage(source.moments, decisions)
  const normalized = decisions.map((decision) => {
    const moment = source.moments.find(
      (candidate) => candidate.id === decision.momentId,
    )!
    if (
      decision.status !== 'evaluated' &&
      decision.status !== 'rejected'
    ) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Contiguous evaluator decision status is invalid',
      )
    }
    if (decision.status === 'rejected') {
      if (![
        'NO_SEMANTIC_WINDOW',
        'INSUFFICIENT_TRANSCRIPT_EVIDENCE',
        'INSUFFICIENT_AUDIO_EVIDENCE',
        'INSUFFICIENT_VISUAL_EVIDENCE',
        'INTEGRITY_BLOCKED',
      ].includes(decision.reason)) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'Contiguous evaluator rejection reason is invalid',
        )
      }
      if (
        !Array.isArray(decision.evidenceRefs) ||
        decision.evidenceRefs.some((reference: unknown) =>
          typeof reference !== 'string') ||
        decision.evidenceRefs.length < 1 ||
        decision.evidenceRefs.length > 32
      ) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'Contiguous evaluator rejection evidence is invalid',
        )
      }
      const evidenceRefs = [...decision.evidenceRefs]
      if (
        evidenceRefs.length < 1 ||
        evidenceRefs.length > 32 ||
        new Set(evidenceRefs).size !== evidenceRefs.length ||
        evidenceRefs.some((reference) =>
          !moment.evidence.some((evidence) =>
            evidence.id === reference),
        )
      ) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'Contiguous evaluator rejection evidence is invalid',
        )
      }
      return Object.freeze({
        status: 'rejected' as const,
        momentId: moment.id,
        reason: decision.reason,
        evidenceRefs: Object.freeze(evidenceRefs),
      })
    }
    if (
      !Array.isArray(decision.objectiveTags) ||
      decision.objectiveTags.length < 1 ||
      decision.objectiveTags.length > 32 ||
      decision.objectiveTags.some((tag: unknown) =>
        typeof tag !== 'string' ||
        tag.trim().length < 1 ||
        tag.trim().length > 120,
      ) ||
      new Set(decision.objectiveTags).size !==
        decision.objectiveTags.length ||
      !Array.isArray(decision.semanticRangeMs) ||
      decision.semanticRangeMs.length !== 2 ||
      !Number.isSafeInteger(decision.semanticRangeMs[0]) ||
      !Number.isSafeInteger(decision.semanticRangeMs[1]) ||
      decision.semanticRangeMs[0] < 0 ||
      decision.semanticRangeMs[1] <= decision.semanticRangeMs[0] ||
      decision.semanticRangeMs[1] > source.sourceDurationMs ||
      decision.semanticRangeMs[0] >
        moment.recommendedRangeMs[0] ||
      decision.semanticRangeMs[1] <
        moment.recommendedRangeMs[1] ||
      typeof decision.scores !== 'object' ||
      decision.scores === null
    ) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Contiguous evaluator result is incomplete',
      )
    }
    for (const dimension of DIMENSIONS) {
      const observation = decision.scores[dimension]
      if (
        !observation ||
        !Number.isFinite(observation.value) ||
        observation.value < 0 ||
        observation.value > 1
      ) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          `Contiguous evaluator ${dimension} score is invalid`,
        )
      }
      validateEvidence(
        moment,
        dimension,
        observation.evidenceRefs,
      )
    }
    return Object.freeze({
      status: 'evaluated' as const,
      momentId: moment.id,
      objectiveTags: Object.freeze([...decision.objectiveTags]),
      semanticRangeMs: Object.freeze(
        [...decision.semanticRangeMs],
      ) as readonly [number, number],
      scores: Object.freeze(Object.fromEntries(
        DIMENSIONS.map((dimension) => [
          dimension,
          Object.freeze({
            value: decision.scores[dimension].value,
            evidenceRefs: Object.freeze([
              ...decision.scores[dimension].evidenceRefs,
            ]),
          }),
        ]),
      )) as typeof decision.scores,
    })
  })
  if (!normalized.some((decision) =>
    decision.status === 'evaluated')) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      'Contiguous evaluator found no eligible semantic window',
    )
  }
  return Object.freeze(normalized)
}

export function produceContiguousEvaluationsService(
  dependencies: {
    repository: ContiguousEvaluationRepository
    provider: ContiguousEvaluationProvider
    createRunId: () => string
    createEvaluationId: (momentId: string) => string
    clock?: () => Date
  },
) {
  const provider = providerIdentity(dependencies.provider.identity)
  const clock = dependencies.clock ?? (() => new Date())
  return async function produce(request: {
    workspaceId: string
    projectId: string
    indexRunId: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
    idempotencyKey: string
    signal?: AbortSignal
    fence: Readonly<LongFormStagePersistenceFence>
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const indexRunId = identity(request.indexRunId, 'indexRunId')
    if (
      request.fence.workspaceId !== workspaceId ||
      request.fence.projectId !== projectId ||
      request.fence.stage !== 'moments'
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous evaluation fence does not match the moments request',
      )
    }
    const execution = createProjectAnalysisExecutionContext({
      workspaceId,
      authenticationAudit: request.authenticationAudit,
      provenance: projectAnalysisProvenanceFromFence(request.fence),
      expectedStage: 'moments',
    })
    const actorId = identity(
      execution.authenticationAudit.clientId,
      'authenticationAudit.clientId',
    )
    const idempotencyKey = identity(
      request.idempotencyKey,
      'idempotencyKey',
    )
    const createdAt = clock().toISOString()
    const source = await dependencies.repository.readSource({
      workspaceId,
      projectId,
      indexRunId,
      now: createdAt,
    })
    if (!source) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Contiguous evaluation source was not found',
      )
    }
    assertSource(source, { workspaceId, projectId, indexRunId })
    const producerInputHash = calculateCanonicalHash({
      policyVersion: CONTIGUOUS_EXTRACTION_POLICY_VERSION,
      provider,
      source,
    })
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'produce-contiguous-evaluations-request/v2',
      workspaceId,
      projectId,
      indexRunId,
      sourceIndexRunHash: source.indexRunHash,
      producerInputHash,
      actorContextHash: execution.authenticationAudit.contextHash,
      provenance: execution.provenance,
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      sourceIndexRunId: indexRunId,
      createdByClientId: actorId,
      actorContextHash: execution.authenticationAudit.contextHash,
      idempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Contiguous evaluation key was used with another source',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }
    const signal = request.signal ?? new AbortController().signal
    if (signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous evaluation was aborted before provider execution',
      )
    }
    const decisions = normalizeDecisions(
      source,
      await dependencies.provider.evaluate(source, signal),
    )
    if (signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous evaluation was aborted before persistence',
      )
    }
    const producerOutputHash = calculateCanonicalHash({
      policyVersion: CONTIGUOUS_EXTRACTION_POLICY_VERSION,
      provider,
      decisions,
    })
    const producerRecord = Object.freeze({
      ...provider,
      inputHash: producerInputHash,
      outputHash: producerOutputHash,
    })
    const evaluations = Object.freeze(decisions.flatMap((decision) => {
      if (decision.status === 'rejected') return []
      const moment = source.moments.find(
        (candidate) => candidate.id === decision.momentId,
      )!
      return [createContiguousMomentEvaluation({
        id: moment.id,
        momentHash: moment.momentHash,
        evaluationId: identity(
          dependencies.createEvaluationId(moment.id),
          'created evaluation ID',
        ),
        evaluationProducer: producerRecord,
        indexRunId: source.indexRunId,
        sourceArtifactId: source.sourceArtifactId,
        sourceArtifactSha256: hash(
          source.sourceArtifactSha256,
          'sourceArtifactSha256',
        ),
        sourceManifestId: source.sourceManifestId,
        sourceManifestHash: hash(
          source.sourceManifestHash,
          'sourceManifestHash',
        ),
        chapterId: moment.chapterId,
        topic: moment.topic,
        objectiveTags: decision.objectiveTags,
        recommendedRangeMs: moment.recommendedRangeMs,
        semanticRangeMs: decision.semanticRangeMs,
        sourceDurationMs: source.sourceDurationMs,
        rightsSnapshotId: source.rightsSnapshotId,
        rightsStatus: 'approved',
        consentStatus:
          source.consentStatus as 'approved' | 'not-required',
        scores: decision.scores,
      })]
    }))
    const runBody = {
      id: identity(dependencies.createRunId(), 'created run ID'),
      workspaceId,
      projectId,
      sourceIndexRunId: indexRunId,
      sourceIndexRunHash: source.indexRunHash,
      producer: producerRecord,
      decisions,
      evaluations,
      requestFingerprint,
      idempotencyKey,
      createdBy: Object.freeze({
        type: 'api-client' as const,
        id: actorId,
      }),
      authenticationAudit: execution.authenticationAudit,
      provenance: execution.provenance,
      createdAt,
    }
    const run: Readonly<PersistedContiguousEvaluationRun> =
      Object.freeze({
        ...runBody,
        runHash: calculateCanonicalHash(runBody),
      })
    const persisted =
      await dependencies.repository.persistWithLongFormLease({
        run,
        fence: request.fence,
      })
    if (!persisted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous evaluation lease was lost before persistence',
      )
    }
    return persisted
  }
}
