import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import {
  portableContiguousEvidenceSource,
  type ContiguousEvidenceRepository,
  type ContiguousEvidenceSource,
  type PersistedContiguousEvidenceRun,
} from '../../application/ports/contiguous-evidence-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import {
  createContiguousEvaluationEvidence,
} from '../../domain/contiguous-evaluation-evidence.ts'
import {
  createLongFormMomentTranscriptEvidence,
} from '../../domain/long-form-transcript-evidence.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertProjectAnalysisFenceBinding,
} from '../../application/project-analysis-execution.ts'
import {
  hydrateProjectAnalysisExecution,
  projectAnalysisExecutionData,
} from './project-analysis-execution.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type DatabaseClient = PrismaClient | Prisma.TransactionClient
type RunRow = Prisma.V2ContiguousEvidenceRunGetPayload<{
  include: { evidence: true }
}>

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
    if (stableSerialize(parsed) !== value) throw new Error('non-canonical')
    return Object.freeze(parsed)
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
}

async function readSourceWithClient(
  client: DatabaseClient,
  input: {
    workspaceId: string
    projectId: string
    indexRunId: string
    now: string
  },
): Promise<Readonly<ContiguousEvidenceSource> | null> {
  const now = new Date(input.now)
  if (Number.isNaN(now.getTime())) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'contiguous evidence instant is invalid',
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
        include: { transcriptEvidence: true },
      },
    },
  })
  if (!row) return null
  const rights = row.rightsSnapshot
  const current = row.sourceArtifact.currentRightsSnapshot
  if (
    !current ||
    row.sourceArtifact.status !== 'available' ||
    !['video', 'audio'].includes(row.sourceArtifact.mediaType) ||
    current.id !== rights.id ||
    rights.status !== 'approved' ||
    !['approved', 'not-required'].includes(rights.consentStatus) ||
    (rights.expiresAt && rights.expiresAt <= now) ||
    (rights.consentExpiresAt && rights.consentExpiresAt <= now)
  ) {
    throw new DomainError(
      'ASSET_RIGHTS_BLOCKED',
      'Contiguous evidence source is no longer authorized',
    )
  }
  return Object.freeze({
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    indexRunId: row.id,
    indexRunHash: row.recordHash,
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    sourceArtifactKey: row.sourceArtifact.artifactKey,
    sourceArtifactByteSize:
      row.sourceArtifact.byteSize.toString(),
    sourceManifestId: row.sourceManifestId,
    sourceManifestHash: row.sourceManifestHash,
    sourceDurationMs: row.durationMs,
    rightsSnapshotId: rights.id,
    rightsStatus: 'approved' as const,
    consentStatus:
      rights.consentStatus as 'approved' | 'not-required',
    moments: Object.freeze(row.moments.map((moment) => {
      const transcriptEvidence = moment.transcriptEvidence
        ? createLongFormMomentTranscriptEvidence({
            id: moment.transcriptEvidence.id,
            workspaceId:
              moment.transcriptEvidence.workspaceId,
            projectId: moment.transcriptEvidence.projectId,
            indexRunId:
              moment.transcriptEvidence.indexRunId,
            indexRunHash:
              moment.transcriptEvidence.indexRunHash,
            momentId: moment.transcriptEvidence.momentId,
            momentHash:
              moment.transcriptEvidence.momentHash,
            hierarchicalRunId:
              moment.transcriptEvidence.hierarchicalRunId,
            hierarchicalRunHash:
              moment.transcriptEvidence.hierarchicalRunHash,
            sourceTranscriptId:
              moment.transcriptEvidence.sourceTranscriptId,
            sourceTranscriptHash:
              moment.transcriptEvidence.sourceTranscriptHash,
            spans: canonical(
              moment.transcriptEvidence.spansJson,
              `long-form transcript spans ${moment.id}`,
            ),
          })
        : undefined
      return Object.freeze({
        id: moment.id,
        momentHash: moment.momentHash,
        recommendedRangeMs: Object.freeze([
          moment.recommendedStartMs,
          moment.recommendedEndMs,
        ]) as readonly [number, number],
        ...(transcriptEvidence
          ? { transcriptEvidence }
          : {}),
      })
    })),
  })
}

function hydrate(row: RunRow): Readonly<PersistedContiguousEvidenceRun> {
  const run = canonical<PersistedContiguousEvidenceRun>(
    row.runJson,
    `contiguous evidence run ${row.id}`,
  )
  const { runHash: _runHash, ...runBody } = run
  const execution = hydrateProjectAnalysisExecution(
    row,
    row.createdByClientId,
    'moments',
  )
  const evidence = row.evidence
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => createContiguousEvaluationEvidence({
      id: item.id,
      sourceIndexRunId: item.indexRunId,
      sourceIndexRunHash: item.indexRunHash,
      sourceMomentId: item.momentId,
      sourceMomentHash: item.momentHash,
      kind: item.kind as
        PersistedContiguousEvidenceRun['evidence'][number]['kind'],
      dimensions: canonical(
        item.dimensionsJson,
        `contiguous evidence dimensions ${item.id}`,
      ),
      rangeMs: [item.startMs, item.endMs],
      producer: Object.freeze({
        provider: item.producerProvider,
        model: item.producerModel,
        version: item.producerVersion,
        inputHash: item.producerInputHash,
        outputHash: item.producerOutputHash,
      }),
      facts: canonical(
        item.factsJson,
        `contiguous evidence facts ${item.id}`,
      ),
    }))
  if (
    row.workspaceId !== run.workspaceId ||
    row.projectId !== run.projectId ||
    row.sourceIndexRunId !== run.sourceIndexRunId ||
    row.sourceIndexRunHash !== run.sourceIndexRunHash ||
    row.analyzerKind !== run.analyzer.kind ||
    row.analyzerProvider !== run.analyzer.provider ||
    row.analyzerModel !== run.analyzer.model ||
    row.analyzerVersion !== run.analyzer.version ||
    row.evidenceCount !== run.evidence.length ||
    row.requestFingerprint !== run.requestFingerprint ||
    row.idempotencyKey !== run.idempotencyKey ||
    row.createdByClientId !== run.createdBy.id ||
    row.createdAt.toISOString() !== run.createdAt ||
    row.runHash !== run.runHash ||
    calculateCanonicalHash(runBody) !== run.runHash ||
    stableSerialize(run.authenticationAudit) !==
      stableSerialize(execution.authenticationAudit) ||
    stableSerialize(run.provenance) !==
      stableSerialize(execution.provenance) ||
    stableSerialize([...evidence].sort((left, right) =>
      left.id.localeCompare(right.id))) !==
      stableSerialize([...run.evidence].sort((left, right) =>
        left.id.localeCompare(right.id)))
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored contiguous evidence run failed integrity validation',
    )
  }
  return Object.freeze({ ...run, ...execution })
}

function assertRunBinding(
  run: Readonly<PersistedContiguousEvidenceRun>,
  source: Readonly<ContiguousEvidenceSource>,
): void {
  const analyzerInputHash = calculateCanonicalHash({
    schemaVersion: 'contiguous-evidence-analyzer-input/v1',
    analyzer: run.analyzer,
    source: portableContiguousEvidenceSource(source),
  })
  const requestFingerprint = calculateCanonicalHash({
    schemaVersion: 'produce-contiguous-evidence-request/v2',
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    indexRunId: run.sourceIndexRunId,
    sourceIndexRunHash: source.indexRunHash,
    analyzer: run.analyzer,
    analyzerInputHash,
    actorContextHash: run.authenticationAudit.contextHash,
    provenance: run.provenance,
  })
  if (
    run.sourceIndexRunHash !== source.indexRunHash ||
    run.requestFingerprint !== requestFingerprint ||
    run.evidence.length !== source.moments.length ||
    new Set(run.evidence.map((item) => item.sourceMomentId)).size !==
      source.moments.length
  ) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Contiguous evidence source changed before persistence',
    )
  }
  for (const item of run.evidence) {
    const moment = source.moments.find((candidate) =>
      candidate.id === item.sourceMomentId)
    const rebuilt = createContiguousEvaluationEvidence({
      ...item,
    })
    if (
      !moment ||
      item.sourceIndexRunId !== source.indexRunId ||
      item.sourceIndexRunHash !== source.indexRunHash ||
      item.sourceMomentHash !== moment.momentHash ||
      item.kind !== run.analyzer.kind ||
      item.producer.provider !== run.analyzer.provider ||
      item.producer.model !== run.analyzer.model ||
      item.producer.version !== run.analyzer.version ||
      item.rangeMs[1] > source.sourceDurationMs ||
      rebuilt.evidenceHash !== item.evidenceHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous evidence output changed before persistence',
      )
    }
  }
}

export class PrismaContiguousEvidenceRepository
implements ContiguousEvidenceRepository {
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
    actorContextHash: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2ContiguousEvidenceRun.findUnique({
      where: {
        workspaceId_projectId_sourceIndexRunId_createdByClientId_idempotencyKey:
          {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            sourceIndexRunId: input.sourceIndexRunId,
            createdByClientId: input.createdByClientId,
            idempotencyKey: input.idempotencyKey,
          },
      },
      include: { evidence: true },
    })
    if (!row) return null
    const run = hydrate(row)
    if (run.authenticationAudit.contextHash !== input.actorContextHash) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Contiguous evidence key belongs to another authentication context',
      )
    }
    return run
  }

  async persistWithLongFormLease(
    input: Parameters<
      ContiguousEvidenceRepository['persistWithLongFormLease']
    >[0],
  ): ReturnType<
    ContiguousEvidenceRepository['persistWithLongFormLease']
  > {
    if (
      input.fence.stage !== 'moments' ||
      input.fence.workspaceId !== input.run.workspaceId ||
      input.fence.projectId !== input.run.projectId
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous evidence fence does not match its run',
      )
    }
    assertProjectAnalysisFenceBinding(input.run, input.fence)
    return this.persistInternal(input.run, input.fence)
  }

  private async persistInternal(
    run: Readonly<PersistedContiguousEvidenceRun>,
    fence: Parameters<
      ContiguousEvidenceRepository['persistWithLongFormLease']
    >[0]['fence'],
    attempt = 1,
  ): ReturnType<
    ContiguousEvidenceRepository['persistWithLongFormLease']
  > {
    const fenceNow = new Date(fence.now)
    if (Number.isNaN(fenceNow.getTime())) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Contiguous evidence fence instant is invalid',
      )
    }
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
              'Contiguous evidence source or actor is unavailable',
            )
          }
          {
            const [operation, stage] = await Promise.all([
              transaction.v2PublicOperation.findFirst({
                where: {
                  id: fence.operationId,
                  workspaceId: run.workspaceId,
                  type: 'long-form-index',
                  status: 'running',
                  leaseOwner: fence.leaseOwner,
                  attempt: fence.operationAttempt,
                  leaseExpiresAt: { gt: fenceNow },
                  clientId: run.authenticationAudit.clientId,
                  actorContextHash: run.authenticationAudit.contextHash,
                },
                select: { id: true },
              }),
              transaction.v2LongFormIndexStageCheckpoint.findFirst({
                where: {
                  workflowId: fence.workflowId,
                  workspaceId: run.workspaceId,
                  projectId: run.projectId,
                  stage: 'moments',
                  status: 'running',
                  inputHash: fence.expectedStageInputHash,
                  idempotencyKey:
                    fence.expectedStageIdempotencyKey,
                  workflow: {
                    operationId: fence.operationId,
                  },
                },
                select: { id: true },
              }),
            ])
            if (!operation || !stage) return null
          }
          assertRunBinding(run, source)
          await transaction.v2ContiguousEvaluationEvidence.updateMany({
            where: {
              workspaceId: run.workspaceId,
              indexRunId: run.sourceIndexRunId,
              kind: run.analyzer.kind,
              active: true,
            },
            data: { active: false },
          })
          const created = await transaction.v2ContiguousEvidenceRun.create({
            data: {
              id: run.id,
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              sourceIndexRunId: run.sourceIndexRunId,
              sourceIndexRunHash: run.sourceIndexRunHash,
              analyzerKind: run.analyzer.kind,
              analyzerProvider: run.analyzer.provider,
              analyzerModel: run.analyzer.model,
              analyzerVersion: run.analyzer.version,
              evidenceCount: run.evidence.length,
              requestFingerprint: run.requestFingerprint,
              idempotencyKey: run.idempotencyKey,
              createdByClientId: run.createdBy.id,
              ...projectAnalysisExecutionData(
                run,
                run.workspaceId,
                run.createdBy.id,
                'moments',
              ),
              createdAt: new Date(run.createdAt),
              runJson: stableSerialize(run),
              runHash: run.runHash,
            },
          })
          await transaction.v2ContiguousEvaluationEvidence.createMany({
            data: run.evidence.map((item) => ({
              id: item.id,
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              runId: run.id,
              indexRunId: item.sourceIndexRunId,
              indexRunHash: item.sourceIndexRunHash,
              momentId: item.sourceMomentId,
              momentHash: item.sourceMomentHash,
              kind: item.kind,
              dimensionsJson: stableSerialize(item.dimensions),
              startMs: item.rangeMs[0],
              endMs: item.rangeMs[1],
              producerProvider: item.producer.provider,
              producerModel: item.producer.model,
              producerVersion: item.producer.version,
              producerInputHash: item.producer.inputHash,
              producerOutputHash: item.producer.outputHash,
              factsJson: stableSerialize(item.facts),
              evidenceHash: item.evidenceHash,
              active: true,
              createdAt: new Date(run.createdAt),
            })),
          })
          return transaction.v2ContiguousEvidenceRun.findUniqueOrThrow({
            where: { id: created.id },
            include: { evidence: true },
          })
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel.Serializable,
        },
      )
      if (!row) return null
      return Object.freeze({ run: hydrate(row), replayed: false })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistInternal(run, fence, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          sourceIndexRunId: run.sourceIndexRunId,
          createdByClientId: run.createdBy.id,
          actorContextHash: run.authenticationAudit.contextHash,
          idempotencyKey: run.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== run.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Contiguous evidence key was used with another source or analyzer',
            )
          }
          return Object.freeze({ run: replay, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Contiguous evidence persistence conflicted repeatedly',
        )
      }
      throw error
    }
  }
}
