import {
  Prisma,
  type PrismaClient,
  type V2ContiguousExtraction,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ContiguousExtractionRepository,
  PersistedContiguousExtraction,
} from '../../application/ports/contiguous-extraction-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import {
  CONTIGUOUS_EXTRACTION_POLICY_VERSION,
  type ContiguousExtractionResult,
  type ContiguousQualityDimension,
  type ContiguousSourceMoment,
} from '../../domain/contiguous-extraction.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

const DIMENSIONS = [
  'selfContained',
  'density',
  'integrity',
  'audio',
  'visual',
] as const satisfies readonly ContiguousQualityDimension[]

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
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
    !parsed.every((item) =>
      typeof item === 'string' && item.trim() === item,
    )
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return Object.freeze(parsed)
}

function hydrate(
  row: V2ContiguousExtraction,
): Readonly<PersistedContiguousExtraction> {
  const result = canonical<ContiguousExtractionResult>(
    row.resultJson,
    'contiguous extraction result',
  )
  const { resultHash: _storedHash, ...body } = result
  const selected = result.candidates.find(
    (candidate) =>
      candidate.candidateHash === result.selectedCandidateHash,
  )
  if (
    result.resultHash !== row.resultHash ||
    calculateCanonicalHash(body) !== row.resultHash ||
    result.id !== row.id ||
    result.workspaceId !== row.workspaceId ||
    result.projectId !== row.projectId ||
    result.policyVersion !== row.policyVersion ||
    result.objective !== row.objective ||
    result.topic !== row.topic ||
    result.targetDurationMs !== row.targetDurationMs ||
    result.toleranceMs !== row.toleranceMs ||
    !selected ||
    selected.sourceIndexRunId !== row.sourceIndexRunId ||
    selected.sourceMomentId !== row.selectedMomentId ||
    selected.sourceEvaluationId !== row.selectedEvaluationId ||
    selected.sourceRangeMs[0] !== row.selectedStartMs ||
    selected.sourceRangeMs[1] !== row.selectedEndMs ||
    selected.candidateHash !== row.selectedCandidateHash ||
    stableSerialize(result.storyPlan) !== row.storyPlanJson ||
    stableSerialize(result.editPlan) !== row.editPlanJson
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored contiguous extraction failed integrity validation',
    )
  }
  return Object.freeze({
    result,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdByClientId,
    }),
    createdAt: row.createdAt.toISOString(),
  })
}

export class PrismaContiguousExtractionRepository
implements ContiguousExtractionRepository {
  constructor(
    private readonly client: PrismaClient = getV2PostgresClient(),
  ) {}

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    createdByClientId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2ContiguousExtraction.findUnique({
      where: {
        workspaceId_projectId_createdByClientId_idempotencyKey:
          input,
      },
    })
    return row ? hydrate(row) : null
  }

  async readCandidateMoments(input: {
    workspaceId: string
    projectId: string
    topic: string
    objective: string
    targetDurationMs: number
    toleranceMs: number
    limit: number
    now: string
  }) {
    const now = new Date(input.now)
    if (Number.isNaN(now.getTime())) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'candidate query instant is invalid',
      )
    }
    const rows =
      await this.client.v2ContiguousMomentEvaluation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          active: true,
          policyVersion: CONTIGUOUS_EXTRACTION_POLICY_VERSION,
          moment: {
            topicNormalized:
              input.topic.toLocaleLowerCase('pt-BR'),
          },
          indexRun: {
            active: true,
            rightsStatus: 'approved',
            consentStatus: {
              in: ['approved', 'not-required'],
            },
          },
        },
        include: {
          moment: true,
          indexRun: {
            include: {
              sourceArtifact: {
                include: { currentRightsSnapshot: true },
              },
              sourceManifest: true,
              rightsSnapshot: true,
            },
          },
        },
        orderBy: [
          { selfContainedScore: 'desc' },
          { densityScore: 'desc' },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
        take: input.limit,
      })
    return Object.freeze(rows.flatMap((row) => {
      const rights = row.indexRun.rightsSnapshot
      const current = row.indexRun.sourceArtifact
        .currentRightsSnapshot
      if (
        !current ||
        current.id !== rights.id ||
        rights.status !== 'approved' ||
        !['approved', 'not-required'].includes(
          rights.consentStatus,
        ) ||
        rights.expiresAt && rights.expiresAt <= now ||
        rights.consentExpiresAt &&
          rights.consentExpiresAt <= now
      ) {
        return []
      }
      const evidenceByDimension = {
        selfContained: row.selfContainedEvidenceJson,
        density: row.densityEvidenceJson,
        integrity: row.integrityEvidenceJson,
        audio: row.audioEvidenceJson,
        visual: row.visualEvidenceJson,
      }
      const valueByDimension = {
        selfContained: row.selfContainedScore,
        density: row.densityScore,
        integrity: row.integrityScore,
        audio: row.audioScore,
        visual: row.visualScore,
      }
      const scores = Object.fromEntries(
        DIMENSIONS.map((dimension) => [
          dimension,
          Object.freeze({
            value: valueByDimension[dimension],
            evidenceRefs: stringArray(
              evidenceByDimension[dimension],
              `${dimension} evidence`,
            ),
          }),
        ]),
      ) as unknown as ContiguousSourceMoment['scores']
      return [Object.freeze({
        id: row.moment.id,
        momentHash: row.moment.momentHash,
        evaluationId: row.id,
        evaluationHash: row.evaluationHash,
        indexRunId: row.indexRun.id,
        sourceArtifactId: row.indexRun.sourceArtifactId,
        sourceArtifactSha256:
          row.indexRun.sourceArtifactSha256,
        sourceManifestId: row.indexRun.sourceManifestId,
        sourceManifestHash: row.indexRun.sourceManifestHash,
        chapterId: row.moment.chapterId,
        topic: row.moment.topicNormalized,
        objectiveTags: stringArray(
          row.objectiveTagsJson,
          'objective tags',
        ),
        recommendedRangeMs: Object.freeze([
          row.moment.recommendedStartMs,
          row.moment.recommendedEndMs,
        ]) as readonly [number, number],
        semanticRangeMs: Object.freeze([
          row.semanticStartMs,
          row.semanticEndMs,
        ]) as readonly [number, number],
        sourceDurationMs: row.indexRun.durationMs,
        rightsSnapshotId: rights.id,
        rightsStatus: rights.status as 'approved',
        consentStatus:
          rights.consentStatus as 'approved' | 'not-required',
        scores,
      })]
    }))
  }

  async persist(
    value: Readonly<PersistedContiguousExtraction>,
    attempt = 1,
  ): ReturnType<ContiguousExtractionRepository['persist']> {
    const result = value.result
    const selected = result.candidates.find(
      (candidate) =>
        candidate.candidateHash === result.selectedCandidateHash,
    )
    if (!selected) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'contiguous extraction selection is invalid',
      )
    }
    try {
      const row = await this.client.$transaction(
        async (transaction) => {
          const [evaluation, actor] = await Promise.all([
            transaction.v2ContiguousMomentEvaluation.findFirst({
              where: {
                id: selected.sourceEvaluationId,
                evaluationHash: selected.sourceEvaluationHash,
                workspaceId: result.workspaceId,
                projectId: result.projectId,
                indexRunId: selected.sourceIndexRunId,
                momentId: selected.sourceMomentId,
                active: true,
                indexRun: {
                  active: true,
                },
              },
              include: {
                indexRun: {
                  include: {
                    sourceArtifact: {
                      include: { currentRightsSnapshot: true },
                    },
                    rightsSnapshot: true,
                  },
                },
              },
            }),
            transaction.v2ApiClient.findFirst({
              where: {
                id: value.createdBy.id,
                workspaceId: result.workspaceId,
                status: 'active',
              },
              select: { id: true },
            }),
          ])
          const rights = evaluation?.indexRun.rightsSnapshot
          const current = evaluation?.indexRun.sourceArtifact
            .currentRightsSnapshot
          const committedAt = new Date(value.createdAt)
          if (
            !evaluation ||
            !actor ||
            !rights ||
            !current ||
            current.id !== rights.id ||
            rights.status !== 'approved' ||
            !['approved', 'not-required'].includes(
              rights.consentStatus,
            ) ||
            rights.expiresAt && rights.expiresAt <= committedAt ||
            rights.consentExpiresAt &&
              rights.consentExpiresAt <= committedAt
          ) {
            throw new DomainError(
              'ASSET_RIGHTS_BLOCKED',
              'Contiguous extraction source is no longer authorized',
            )
          }
          return transaction.v2ContiguousExtraction.create({
            data: {
              id: result.id,
              workspaceId: result.workspaceId,
              projectId: result.projectId,
              sourceIndexRunId: selected.sourceIndexRunId,
              selectedMomentId: selected.sourceMomentId,
              selectedEvaluationId: selected.sourceEvaluationId,
              policyVersion: result.policyVersion,
              objective: result.objective,
              topic: result.topic,
              targetDurationMs: result.targetDurationMs,
              toleranceMs: result.toleranceMs,
              selectedStartMs: selected.sourceRangeMs[0],
              selectedEndMs: selected.sourceRangeMs[1],
              selectedCandidateHash: selected.candidateHash,
              storyPlanJson: stableSerialize(result.storyPlan),
              editPlanJson: stableSerialize(result.editPlan),
              resultJson: stableSerialize(result),
              resultHash: result.resultHash,
              requestFingerprint: value.requestFingerprint,
              idempotencyKey: value.idempotencyKey,
              createdByClientId: value.createdBy.id,
              createdAt: new Date(value.createdAt),
            },
          })
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel.Serializable,
        },
      )
      return Object.freeze({
        extraction: hydrate(row),
        replayed: false,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persist(value, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: result.workspaceId,
          projectId: result.projectId,
          createdByClientId: value.createdBy.id,
          idempotencyKey: value.idempotencyKey,
        })
        if (replay) {
          if (
            replay.requestFingerprint !== value.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with another contiguous extraction request',
            )
          }
          return Object.freeze({
            extraction: replay,
            replayed: true,
          })
        }
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Contiguous extraction persistence conflicted repeatedly',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    projectId: string
    extractionId: string
  }) {
    const row = await this.client.v2ContiguousExtraction.findFirst({
      where: {
        id: input.extractionId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
    })
    return row ? hydrate(row) : null
  }
}
