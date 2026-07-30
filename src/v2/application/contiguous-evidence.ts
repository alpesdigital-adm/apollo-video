import type {
  ContiguousEvidenceAnalyzer,
  ContiguousEvidenceRepository,
  ContiguousEvidenceSource,
  PersistedContiguousEvidenceRun,
} from './ports/contiguous-evidence-repository.ts'
import {
  calculateCanonicalHash,
} from '../domain/canonical-hash.ts'
import {
  createContiguousEvaluationEvidence,
} from '../domain/contiguous-evaluation-evidence.ts'
import { DomainError } from '../domain/errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

function identity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value.trim())) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value.trim()
}

function analyzerIdentity(
  value: ContiguousEvidenceAnalyzer['identity'],
) {
  const normalized = Object.freeze({
    provider: value?.provider?.trim(),
    model: value?.model?.trim(),
    version: value?.version?.trim(),
    kind: value?.kind,
  })
  if (
    !TOKEN.test(normalized.provider) ||
    !TOKEN.test(normalized.model) ||
    !TOKEN.test(normalized.version) ||
    ![
      'transcript-boundary',
      'transcript-density',
      'rights-integrity',
      'audio-analysis',
      'visual-analysis',
    ].includes(normalized.kind)
  ) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Contiguous evidence analyzer identity is invalid',
    )
  }
  return normalized
}

function assertSource(
  source: Readonly<ContiguousEvidenceSource>,
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
    !ID.test(source.sourceArtifactId) ||
    !HASH.test(source.sourceArtifactSha256) ||
    !ID.test(source.sourceManifestId) ||
    !HASH.test(source.sourceManifestHash) ||
    !ID.test(source.rightsSnapshotId) ||
    source.rightsStatus !== 'approved' ||
    !['approved', 'not-required'].includes(source.consentStatus) ||
    !Number.isSafeInteger(source.sourceDurationMs) ||
    source.sourceDurationMs < 1_000 ||
    source.sourceDurationMs > 43_200_000 ||
    source.moments.length < 1 ||
    source.moments.length > 10_000 ||
    new Set(source.moments.map((moment) => moment.id)).size !==
      source.moments.length ||
    source.moments.some((moment) =>
      !ID.test(moment.id) ||
      !HASH.test(moment.momentHash) ||
      !Array.isArray(moment.recommendedRangeMs) ||
      moment.recommendedRangeMs.length !== 2 ||
      !Number.isSafeInteger(moment.recommendedRangeMs[0]) ||
      !Number.isSafeInteger(moment.recommendedRangeMs[1]) ||
      moment.recommendedRangeMs[0] < 0 ||
      moment.recommendedRangeMs[1] <=
        moment.recommendedRangeMs[0] ||
      moment.recommendedRangeMs[1] > source.sourceDurationMs,
    )
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Contiguous evidence source is invalid or unauthorized',
    )
  }
}

export function produceContiguousEvidenceService(
  dependencies: {
    repository: ContiguousEvidenceRepository
    analyzer: ContiguousEvidenceAnalyzer
    createRunId: () => string
    createEvidenceId: (momentId: string) => string
    clock?: () => Date
  },
) {
  const analyzer = analyzerIdentity(dependencies.analyzer.identity)
  const clock = dependencies.clock ?? (() => new Date())
  return async function produce(request: {
    workspaceId: string
    projectId: string
    indexRunId: string
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
    signal?: AbortSignal
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const indexRunId = identity(request.indexRunId, 'indexRunId')
    const actorId = identity(request.actor?.id, 'actor.id')
    const idempotencyKey = identity(
      request.idempotencyKey,
      'idempotencyKey',
    )
    if (request.actor?.type !== 'api-client') {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'actor.type must be api-client',
      )
    }
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
        'Contiguous evidence source was not found',
      )
    }
    assertSource(source, { workspaceId, projectId, indexRunId })
    const analyzerInputHash = calculateCanonicalHash({
      schemaVersion: 'contiguous-evidence-analyzer-input/v1',
      analyzer,
      source,
    })
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'produce-contiguous-evidence-request/v1',
      workspaceId,
      projectId,
      indexRunId,
      sourceIndexRunHash: source.indexRunHash,
      analyzer,
      analyzerInputHash,
      actorId,
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      sourceIndexRunId: indexRunId,
      createdByClientId: actorId,
      idempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Contiguous evidence key was used with another source or analyzer',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }
    const signal = request.signal ?? new AbortController().signal
    if (signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous evidence was aborted before analyzer execution',
      )
    }
    const observations = await dependencies.analyzer.analyze(
      source,
      signal,
    )
    if (
      signal.aborted ||
      !Array.isArray(observations) ||
      observations.length !== source.moments.length ||
      observations.some((item) =>
        typeof item !== 'object' ||
        item === null ||
        Array.isArray(item),
      ) ||
      new Set(observations.map((item) => item.momentId)).size !==
        observations.length ||
      source.moments.some((moment) =>
        !observations.some((item) => item.momentId === moment.id),
      )
    ) {
      throw new DomainError(
        signal.aborted ? 'VERSION_CONFLICT' : 'RENDER_OUTPUT_INVALID',
        signal.aborted
          ? 'Contiguous evidence was aborted before persistence'
          : 'Contiguous analyzer must cover every source moment exactly once',
      )
    }
    const evidence = Object.freeze(observations.map((observation) => {
      const moment = source.moments.find(
        (candidate) => candidate.id === observation.momentId,
      )!
      const outputHash = calculateCanonicalHash({
        schemaVersion: 'contiguous-evidence-analyzer-output/v1',
        analyzer,
        observation,
      })
      return createContiguousEvaluationEvidence({
        id: identity(
          dependencies.createEvidenceId(moment.id),
          'created evidence ID',
        ),
        sourceIndexRunId: source.indexRunId,
        sourceIndexRunHash: source.indexRunHash,
        sourceMomentId: moment.id,
        sourceMomentHash: moment.momentHash,
        kind: analyzer.kind,
        dimensions: observation.dimensions,
        rangeMs: observation.rangeMs,
        producer: Object.freeze({
          provider: analyzer.provider,
          model: analyzer.model,
          version: analyzer.version,
          inputHash: calculateCanonicalHash({
            analyzerInputHash,
            momentId: moment.id,
            momentHash: moment.momentHash,
          }),
          outputHash,
        }),
        facts: observation.facts,
      })
    }))
    if (evidence.some((item) =>
      item.rangeMs[1] > source.sourceDurationMs)) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Contiguous analyzer returned evidence outside the source',
      )
    }
    const runBody = {
      id: identity(dependencies.createRunId(), 'created run ID'),
      workspaceId,
      projectId,
      sourceIndexRunId: indexRunId,
      sourceIndexRunHash: source.indexRunHash,
      analyzer,
      evidence,
      requestFingerprint,
      idempotencyKey,
      createdBy: Object.freeze({
        type: 'api-client' as const,
        id: actorId,
      }),
      createdAt,
    }
    const run: Readonly<PersistedContiguousEvidenceRun> =
      Object.freeze({
        ...runBody,
        runHash: calculateCanonicalHash(runBody),
      })
    return dependencies.repository.persist(run)
  }
}
