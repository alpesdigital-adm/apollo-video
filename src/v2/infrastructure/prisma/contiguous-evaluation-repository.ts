import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ContiguousEvaluationDecision,
  ContiguousEvaluationRepository,
  ContiguousEvaluationSource,
  PersistedContiguousEvaluationRun,
} from '../../application/ports/contiguous-evaluation-provider.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import {
  CONTIGUOUS_EXTRACTION_POLICY_VERSION,
  calculateContiguousMomentEvaluationHash,
  type ContiguousQualityDimension,
} from '../../domain/contiguous-extraction.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type DatabaseClient = PrismaClient | Prisma.TransactionClient
type RunWithEvaluations =
  Prisma.V2ContiguousEvaluationRunGetPayload<{
    include: { evaluations: true }
  }>

const DIMENSIONS = [
  'selfContained',
  'density',
  'integrity',
  'audio',
  'visual',
] as const satisfies readonly ContiguousQualityDimension[]

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function canonical<T>(value: string, field: string): Readonly<T> {
  try {
    const parsed = JSON.parse(value) as T
    if (stableSerialize(parsed) !== value) {
      throw new Error('non-canonical')
    }
    return Object.freeze(parsed)
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
}

function stringArray(
  value: string,
  field: string,
): readonly string[] {
  const parsed = canonical<unknown>(value, field)
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) =>
      typeof item !== 'string' || item.trim() !== item,
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return Object.freeze(parsed)
}

function facts(
  value: string,
  field: string,
): Readonly<Record<string, string | number | boolean>> {
  const parsed = canonical<unknown>(value, field)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((item) =>
      !['string', 'number', 'boolean'].includes(typeof item) ||
      (typeof item === 'number' && !Number.isFinite(item)),
    )
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return Object.freeze(
    parsed as Record<string, string | number | boolean>,
  )
}

async function readSourceWithClient(
  client: DatabaseClient,
  input: {
    workspaceId: string
    projectId: string
    indexRunId: string
    now: string
  },
): Promise<Readonly<ContiguousEvaluationSource> | null> {
  const now = new Date(input.now)
  if (Number.isNaN(now.getTime())) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'contiguous evaluation instant is invalid',
    )
  }
  const row = await client.v2LongFormIndexRun.findFirst({
    where: {
      id: input.indexRunId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      active: true,
    },
    include: {
      rightsSnapshot: true,
      sourceArtifact: {
        include: { currentRightsSnapshot: true },
      },
      moments: {
        orderBy: { ordinal: 'asc' },
        include: {
          contiguousEvaluationEvidence: {
            where: { active: true },
            orderBy: [
              { startMs: 'asc' },
              { kind: 'asc' },
              { id: 'asc' },
            ],
          },
        },
      },
    },
  })
  if (!row) return null
  const rights = row.rightsSnapshot
  const current = row.sourceArtifact.currentRightsSnapshot
  if (
    !current ||
    current.id !== rights.id ||
    rights.status !== 'approved' ||
    !['approved', 'not-required'].includes(
      rights.consentStatus,
    ) ||
    (rights.expiresAt && rights.expiresAt <= now) ||
    (rights.consentExpiresAt &&
      rights.consentExpiresAt <= now)
  ) {
    throw new DomainError(
      'ASSET_RIGHTS_BLOCKED',
      'Contiguous evaluation source is no longer authorized',
    )
  }
  return Object.freeze({
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    indexRunId: row.id,
    indexRunHash: row.recordHash,
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    sourceManifestId: row.sourceManifestId,
    sourceManifestHash: row.sourceManifestHash,
    sourceDurationMs: row.durationMs,
    rightsSnapshotId: rights.id,
    rightsStatus: 'approved' as const,
    consentStatus:
      rights.consentStatus as 'approved' | 'not-required',
    moments: Object.freeze(row.moments.map((moment) =>
      Object.freeze({
        id: moment.id,
        momentHash: moment.momentHash,
        chapterId: moment.chapterId,
        topic: moment.topicNormalized,
        recommendedRangeMs: Object.freeze([
          moment.recommendedStartMs,
          moment.recommendedEndMs,
        ]) as readonly [number, number],
        evidence: Object.freeze(
          moment.contiguousEvaluationEvidence.map((evidence) =>
            Object.freeze({
              id: evidence.id,
              sourceIndexRunId: evidence.indexRunId,
              sourceIndexRunHash: evidence.indexRunHash,
              sourceMomentId: evidence.momentId,
              sourceMomentHash: evidence.momentHash,
              kind: evidence.kind as
                ContiguousEvaluationSource['moments'][number][
                  'evidence'
                ][number]['kind'],
              dimensions: stringArray(
                evidence.dimensionsJson,
                `contiguous evidence ${evidence.id} dimensions`,
              ) as readonly ContiguousQualityDimension[],
              rangeMs: Object.freeze([
                evidence.startMs,
                evidence.endMs,
              ]) as readonly [number, number],
              producer: Object.freeze({
                provider: evidence.producerProvider,
                model: evidence.producerModel,
                version: evidence.producerVersion,
                inputHash: evidence.producerInputHash,
                outputHash: evidence.producerOutputHash,
              }),
              evidenceHash: evidence.evidenceHash,
              facts: facts(
                evidence.factsJson,
                `contiguous evidence ${evidence.id} facts`,
              ),
            }),
          ),
        ),
      }),
    )),
  })
}

function sameProducer(
  left: PersistedContiguousEvaluationRun['producer'],
  right: PersistedContiguousEvaluationRun['producer'],
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.version === right.version &&
    left.inputHash === right.inputHash &&
    left.outputHash === right.outputHash
  )
}

function assertEvaluationRows(
  run: Readonly<PersistedContiguousEvaluationRun>,
  rows: RunWithEvaluations['evaluations'],
): void {
  if (rows.length !== run.evaluations.length) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored contiguous evaluation rows are incomplete',
    )
  }
  for (const evaluation of run.evaluations) {
    const row = rows.find((candidate) =>
      candidate.id === evaluation.evaluationId)
    const score = evaluation.scores
    if (
      !row ||
      row.workspaceId !== run.workspaceId ||
      row.projectId !== run.projectId ||
      row.runId !== run.id ||
      row.indexRunId !== run.sourceIndexRunId ||
      row.momentId !== evaluation.id ||
      row.policyVersion !==
        CONTIGUOUS_EXTRACTION_POLICY_VERSION ||
      row.semanticStartMs !== evaluation.semanticRangeMs[0] ||
      row.semanticEndMs !== evaluation.semanticRangeMs[1] ||
      row.evaluationHash !== evaluation.evaluationHash ||
      row.selfContainedScore !== score.selfContained.value ||
      row.densityScore !== score.density.value ||
      row.integrityScore !== score.integrity.value ||
      row.audioScore !== score.audio.value ||
      row.visualScore !== score.visual.value ||
      row.objectiveTagsJson !==
        stableSerialize(evaluation.objectiveTags) ||
      DIMENSIONS.some((dimension) =>
        row[`${dimension}EvidenceJson`] !==
          stableSerialize(score[dimension].evidenceRefs),
      ) ||
      !sameProducer(
        {
          provider: row.producerProvider,
          model: row.producerModel,
          version: row.producerVersion,
          inputHash: row.producerInputHash,
          outputHash: row.producerOutputHash,
        },
        run.producer,
      )
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored contiguous evaluation row failed integrity validation',
      )
    }
  }
}

function hydrate(
  row: RunWithEvaluations,
): Readonly<PersistedContiguousEvaluationRun> {
  const run = canonical<PersistedContiguousEvaluationRun>(
    row.runJson,
    `contiguous evaluation run ${row.id}`,
  )
  const { runHash: _storedHash, ...body } = run
  if (
    stableSerialize(run.decisions) !== row.decisionsJson ||
    calculateCanonicalHash(body) !== run.runHash ||
    run.runHash !== row.runHash ||
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.sourceIndexRunId !== row.sourceIndexRunId ||
    run.sourceIndexRunHash !== row.sourceIndexRunHash ||
    run.producer.provider !== row.producerProvider ||
    run.producer.model !== row.producerModel ||
    run.producer.version !== row.producerVersion ||
    run.producer.inputHash !== row.producerInputHash ||
    run.producer.outputHash !== row.producerOutputHash ||
    run.evaluations.length !== row.evaluationCount ||
    run.decisions.filter((decision) =>
      decision.status === 'rejected').length !== row.rejectedCount ||
    run.requestFingerprint !== row.requestFingerprint ||
    run.idempotencyKey !== row.idempotencyKey ||
    run.createdBy.id !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored contiguous evaluation run failed integrity validation',
    )
  }
  assertEvaluationRows(run, row.evaluations)
  return run
}

function assertDecisionEvidence(
  source: Readonly<ContiguousEvaluationSource>,
  decision: Readonly<ContiguousEvaluationDecision>,
): void {
  const moment = source.moments.find((candidate) =>
    candidate.id === decision.momentId)
  if (!moment) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Contiguous evaluation moment changed before persistence',
    )
  }
  if (decision.status === 'rejected') {
    if (decision.evidenceRefs.some((reference) =>
      !moment.evidence.some((evidence) =>
        evidence.id === reference))) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous rejection evidence changed before persistence',
      )
    }
    return
  }
  for (const dimension of DIMENSIONS) {
    if (decision.scores[dimension].evidenceRefs.some((reference) =>
      !moment.evidence.some((evidence) =>
        evidence.id === reference &&
        evidence.dimensions.includes(dimension)))) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous score evidence changed before persistence',
      )
    }
  }
}

function assertRunBinding(
  run: Readonly<PersistedContiguousEvaluationRun>,
  source: Readonly<ContiguousEvaluationSource>,
): void {
  const providerIdentity = {
    provider: run.producer.provider,
    model: run.producer.model,
    version: run.producer.version,
  }
  const inputHash = calculateCanonicalHash({
    policyVersion: CONTIGUOUS_EXTRACTION_POLICY_VERSION,
    provider: providerIdentity,
    source,
  })
  const outputHash = calculateCanonicalHash({
    policyVersion: CONTIGUOUS_EXTRACTION_POLICY_VERSION,
    provider: providerIdentity,
    decisions: run.decisions,
  })
  const requestFingerprint = calculateCanonicalHash({
    schemaVersion: 'produce-contiguous-evaluations-request/v1',
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    indexRunId: run.sourceIndexRunId,
    sourceIndexRunHash: source.indexRunHash,
    producerInputHash: inputHash,
    actorId: run.createdBy.id,
  })
  if (
    run.sourceIndexRunHash !== source.indexRunHash ||
    run.producer.inputHash !== inputHash ||
    run.producer.outputHash !== outputHash ||
    run.requestFingerprint !== requestFingerprint ||
    run.decisions.length !== source.moments.length ||
    new Set(run.decisions.map((decision) =>
      decision.momentId)).size !== source.moments.length ||
    run.evaluations.length !==
      run.decisions.filter((decision) =>
        decision.status === 'evaluated').length
  ) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Contiguous evaluation source changed before persistence',
    )
  }
  run.decisions.forEach((decision) =>
    assertDecisionEvidence(source, decision))
  for (const evaluation of run.evaluations) {
    const decision = run.decisions.find((candidate) =>
      candidate.status === 'evaluated' &&
      candidate.momentId === evaluation.id)
    const moment = source.moments.find((candidate) =>
      candidate.id === evaluation.id)
    if (
      !decision ||
      decision.status !== 'evaluated' ||
      !moment ||
      evaluation.indexRunId !== source.indexRunId ||
      evaluation.momentHash !== moment.momentHash ||
      evaluation.chapterId !== moment.chapterId ||
      evaluation.topic !== moment.topic ||
      evaluation.sourceArtifactId !== source.sourceArtifactId ||
      evaluation.sourceArtifactSha256 !==
        source.sourceArtifactSha256 ||
      evaluation.sourceManifestId !== source.sourceManifestId ||
      evaluation.sourceManifestHash !== source.sourceManifestHash ||
      evaluation.rightsSnapshotId !== source.rightsSnapshotId ||
      !sameProducer(evaluation.evaluationProducer, run.producer) ||
      calculateContiguousMomentEvaluationHash({
        momentId: evaluation.id,
        momentHash: evaluation.momentHash,
        indexRunId: evaluation.indexRunId,
        objectiveTags: evaluation.objectiveTags,
        semanticRangeMs: evaluation.semanticRangeMs,
        scores: evaluation.scores,
        producer: evaluation.evaluationProducer,
      }) !== evaluation.evaluationHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous evaluation output changed before persistence',
      )
    }
  }
}

export class PrismaContiguousEvaluationRepository
implements ContiguousEvaluationRepository {
  constructor(
    private readonly client: PrismaClient = getV2PostgresClient(),
  ) {}

  readSource(input: {
    workspaceId: string
    projectId: string
    indexRunId: string
    now: string
  }) {
    return readSourceWithClient(this.client, input)
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    sourceIndexRunId: string
    createdByClientId: string
    idempotencyKey: string
  }) {
    const row =
      await this.client.v2ContiguousEvaluationRun.findUnique({
        where: {
          workspaceId_projectId_sourceIndexRunId_createdByClientId_idempotencyKey:
            input,
        },
        include: { evaluations: true },
      })
    return row ? hydrate(row) : null
  }

  async persist(
    run: Readonly<PersistedContiguousEvaluationRun>,
    attempt = 1,
  ): ReturnType<ContiguousEvaluationRepository['persist']> {
    try {
      const row = await this.client.$transaction(
        async (transaction) => {
          const [source, actor] = await Promise.all([
            readSourceWithClient(transaction, {
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              indexRunId: run.sourceIndexRunId,
              now: run.createdAt,
            }),
            transaction.v2ApiClient.findFirst({
              where: {
                id: run.createdBy.id,
                workspaceId: run.workspaceId,
                status: 'active',
              },
              select: { id: true },
            }),
          ])
          if (!source || !actor) {
            throw new DomainError(
              'VERSION_CONFLICT',
              'Contiguous evaluation source or actor is unavailable',
            )
          }
          assertRunBinding(run, source)
          const evaluatedMomentIds = run.evaluations.map(
            (evaluation) => evaluation.id,
          )
          await transaction.v2ContiguousMomentEvaluation.updateMany({
            where: {
              workspaceId: run.workspaceId,
              momentId: { in: evaluatedMomentIds },
              active: true,
            },
            data: { active: false },
          })
          const created = await transaction
            .v2ContiguousEvaluationRun.create({
              data: {
                id: run.id,
                workspaceId: run.workspaceId,
                projectId: run.projectId,
                sourceIndexRunId: run.sourceIndexRunId,
                sourceIndexRunHash: run.sourceIndexRunHash,
                policyVersion:
                  CONTIGUOUS_EXTRACTION_POLICY_VERSION,
                producerProvider: run.producer.provider,
                producerModel: run.producer.model,
                producerVersion: run.producer.version,
                producerInputHash: run.producer.inputHash,
                producerOutputHash: run.producer.outputHash,
                decisionsJson: stableSerialize(run.decisions),
                evaluationCount: run.evaluations.length,
                rejectedCount: run.decisions.filter((decision) =>
                  decision.status === 'rejected').length,
                requestFingerprint: run.requestFingerprint,
                idempotencyKey: run.idempotencyKey,
                createdByClientId: run.createdBy.id,
                createdAt: new Date(run.createdAt),
                runJson: stableSerialize(run),
                runHash: run.runHash,
              },
            })
          await transaction.v2ContiguousMomentEvaluation.createMany({
            data: run.evaluations.map((evaluation) => ({
              id: evaluation.evaluationId,
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              runId: run.id,
              indexRunId: run.sourceIndexRunId,
              momentId: evaluation.id,
              policyVersion:
                CONTIGUOUS_EXTRACTION_POLICY_VERSION,
              objectiveTagsJson:
                stableSerialize(evaluation.objectiveTags),
              semanticStartMs: evaluation.semanticRangeMs[0],
              semanticEndMs: evaluation.semanticRangeMs[1],
              selfContainedScore:
                evaluation.scores.selfContained.value,
              densityScore: evaluation.scores.density.value,
              integrityScore: evaluation.scores.integrity.value,
              audioScore: evaluation.scores.audio.value,
              visualScore: evaluation.scores.visual.value,
              selfContainedEvidenceJson: stableSerialize(
                evaluation.scores.selfContained.evidenceRefs,
              ),
              densityEvidenceJson: stableSerialize(
                evaluation.scores.density.evidenceRefs,
              ),
              integrityEvidenceJson: stableSerialize(
                evaluation.scores.integrity.evidenceRefs,
              ),
              audioEvidenceJson: stableSerialize(
                evaluation.scores.audio.evidenceRefs,
              ),
              visualEvidenceJson: stableSerialize(
                evaluation.scores.visual.evidenceRefs,
              ),
              producerProvider: run.producer.provider,
              producerModel: run.producer.model,
              producerVersion: run.producer.version,
              producerInputHash: run.producer.inputHash,
              producerOutputHash: run.producer.outputHash,
              evaluationHash: evaluation.evaluationHash,
              active: true,
              createdAt: new Date(run.createdAt),
            })),
          })
          return transaction.v2ContiguousEvaluationRun.findUniqueOrThrow({
            where: { id: created.id },
            include: { evaluations: true },
          })
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel.Serializable,
        },
      )
      return Object.freeze({
        run: hydrate(row),
        replayed: false,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persist(run, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          sourceIndexRunId: run.sourceIndexRunId,
          createdByClientId: run.createdBy.id,
          idempotencyKey: run.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== run.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Contiguous evaluation key was used with another source',
            )
          }
          return Object.freeze({ run: replay, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Contiguous evaluation persistence conflicted repeatedly',
        )
      }
      throw error
    }
  }
}
