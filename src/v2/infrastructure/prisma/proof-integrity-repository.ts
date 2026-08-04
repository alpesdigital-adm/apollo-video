import {
  Prisma,
  type PrismaClient,
  type V2ProofIntegrityEvaluation,
  type V2ProofIntegrityRun,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedProofIntegrityRun,
  ProofIntegrityRepository,
} from '../../application/ports/proof-integrity-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  hydrateProofIntegrityRun,
  type ProofIntegrityEvaluation,
  type ProofIntegrityRun,
} from '../../domain/proof-integrity.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

type RunWithEvaluations = V2ProofIntegrityRun & {
  evaluations: V2ProofIntegrityEvaluation[]
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function canonicalValue<T>(
  value: string,
  field: string,
): Readonly<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid JSON`,
    )
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    stableSerialize(parsed) !== value
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is not canonical`,
    )
  }
  return deepFreeze(parsed as T)
}

function normalizedReasons(
  evaluation: Readonly<ProofIntegrityEvaluation>,
): string {
  const reasons = evaluation.issue?.reasonCodes ?? []
  return reasons.length === 0 ? '' : `\n${reasons.join('\n')}\n`
}

function hydrateRecord(
  row: RunWithEvaluations,
): Readonly<PersistedProofIntegrityRun> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  const run = hydrateProofIntegrityRun(
    canonicalValue<ProofIntegrityRun>(
      row.runJson,
      `ProofIntegrity run ${row.id}`,
    ),
  )
  if (
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.batchId !== row.batchId ||
    run.targetRecipeId !== row.targetRecipeId ||
    run.targetRecipeHash !== row.targetRecipeHash ||
    run.proofNeedRunId !== row.proofNeedRunId ||
    run.proofNeedRunHash !== row.proofNeedRunHash ||
    run.schemaVersion !== row.schemaVersion ||
    run.policyVersion !== row.policyVersion ||
    run.summary.evaluationCount !== row.evaluationCount ||
    run.summary.approvedCount !== row.approvedCount ||
    run.summary.blockedCount !== row.blockedCount ||
    run.summary.notApplicableCount !== row.notApplicableCount ||
    run.summary.hardIssueCount !== row.hardIssueCount ||
    run.summary.fabricationSuggestionCount !==
      row.fabricationSuggestionCount ||
    run.summary.readyForAssembly !== row.readyForAssembly ||
    run.runHash !== row.runHash ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString() ||
    run.evaluations.length !== row.evaluations.length
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ProofIntegrity run ${row.id} failed integrity validation`,
    )
  }

  const orderedRows = row.evaluations.toSorted(
    (left, right) => left.sequence - right.sequence,
  )
  for (let index = 0; index < run.evaluations.length; index += 1) {
    const evaluation = run.evaluations[index]!
    const stored = orderedRows[index]!
    const persisted = canonicalValue<ProofIntegrityEvaluation>(
      stored.evaluationJson,
      `ProofIntegrity evaluation ${stored.id}`,
    )
    if (
      stableSerialize(persisted) !== stableSerialize(evaluation) ||
      stored.id !== evaluation.id ||
      stored.workspaceId !== run.workspaceId ||
      stored.projectId !== run.projectId ||
      stored.runId !== run.id ||
      stored.proofNeedRunId !== run.proofNeedRunId ||
      stored.proofNeedItemId !== evaluation.proofNeedItemId ||
      stored.proofNeedItemHash !== evaluation.proofNeedItemHash ||
      stored.sequence !== evaluation.sequence ||
      stored.proofNeedResolution !==
        evaluation.proofNeedResolution ||
      stored.selectedEvidenceId !==
        (evaluation.selectedEvidenceId ?? null) ||
      stored.selectedEvidenceHash !==
        (evaluation.selectedEvidenceHash ?? null) ||
      stored.outcome !== evaluation.outcome ||
      stored.allowedForAssembly !== evaluation.allowedForAssembly ||
      stored.recipeContextJson !==
        (evaluation.recipeContext
          ? stableSerialize(evaluation.recipeContext)
          : null) ||
      stored.recipeContextHash !==
        (evaluation.recipeContext?.contextHashBinding ?? null) ||
      stored.useJson !== stableSerialize(evaluation.use) ||
      stored.comparisonsJson !==
        stableSerialize(evaluation.comparisons) ||
      stored.comparisonCount !== evaluation.comparisons.length ||
      stored.reasonCodesText !== normalizedReasons(evaluation) ||
      stored.reasonCount !==
        (evaluation.issue?.reasonCodes.length ?? 0) ||
      stored.presentationJson !==
        (evaluation.presentation
          ? stableSerialize(evaluation.presentation)
          : null) ||
      stored.presentationHash !==
        (evaluation.presentation?.presentationHash ?? null) ||
      stored.issueJson !==
        (evaluation.issue ? stableSerialize(evaluation.issue) : null) ||
      stored.issueHash !== (evaluation.issue?.issueHash ?? null) ||
      stored.fabricationSuggested !== false ||
      stored.evaluatedAt.toISOString() !== evaluation.evaluatedAt ||
      stored.evaluationHash !== evaluation.evaluationHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored ProofIntegrity evaluation ${stored.id} failed integrity validation`,
      )
    }
  }

  return Object.freeze({
    ...run,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
  })
}

function runData(input: {
  run: Readonly<ProofIntegrityRun>
  requestFingerprint: string
  idempotencyKey: string
  authenticationAudit: Parameters<ProofIntegrityRepository['create']>[0]['authenticationAudit']
}) {
  const { run } = input
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    batchId: run.batchId,
    targetRecipeId: run.targetRecipeId,
    targetRecipeHash: run.targetRecipeHash,
    proofNeedRunId: run.proofNeedRunId,
    proofNeedRunHash: run.proofNeedRunHash,
    schemaVersion: run.schemaVersion,
    policyVersion: run.policyVersion,
    evaluationCount: run.summary.evaluationCount,
    approvedCount: run.summary.approvedCount,
    blockedCount: run.summary.blockedCount,
    notApplicableCount: run.summary.notApplicableCount,
    hardIssueCount: run.summary.hardIssueCount,
    fabricationSuggestionCount:
      run.summary.fabricationSuggestionCount,
    readyForAssembly: run.summary.readyForAssembly,
    runJson: stableSerialize(run),
    runHash: run.runHash,
    requestFingerprint: input.requestFingerprint,
    idempotencyKey: input.idempotencyKey,
    createdByClientId: run.createdByClientId,
    ...externalActorAuditData(input.authenticationAudit, run.workspaceId, run.createdByClientId),
    createdAt: new Date(run.createdAt),
  }
}

function evaluationData(
  run: Readonly<ProofIntegrityRun>,
  evaluation: Readonly<ProofIntegrityEvaluation>,
) {
  return {
    id: evaluation.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    runId: run.id,
    proofNeedRunId: run.proofNeedRunId,
    proofNeedItemId: evaluation.proofNeedItemId,
    proofNeedItemHash: evaluation.proofNeedItemHash,
    sequence: evaluation.sequence,
    proofNeedResolution: evaluation.proofNeedResolution,
    selectedEvidenceId: evaluation.selectedEvidenceId,
    selectedEvidenceHash: evaluation.selectedEvidenceHash,
    outcome: evaluation.outcome,
    allowedForAssembly: evaluation.allowedForAssembly,
    recipeContextJson: evaluation.recipeContext
      ? stableSerialize(evaluation.recipeContext)
      : undefined,
    recipeContextHash:
      evaluation.recipeContext?.contextHashBinding,
    useJson: stableSerialize(evaluation.use),
    comparisonsJson: stableSerialize(evaluation.comparisons),
    comparisonCount: evaluation.comparisons.length,
    reasonCodesText: normalizedReasons(evaluation),
    reasonCount: evaluation.issue?.reasonCodes.length ?? 0,
    presentationJson: evaluation.presentation
      ? stableSerialize(evaluation.presentation)
      : undefined,
    presentationHash: evaluation.presentation?.presentationHash,
    issueJson: evaluation.issue
      ? stableSerialize(evaluation.issue)
      : undefined,
    issueHash: evaluation.issue?.issueHash,
    fabricationSuggested: false,
    evaluatedAt: new Date(evaluation.evaluatedAt),
    evaluationJson: stableSerialize(evaluation),
    evaluationHash: evaluation.evaluationHash,
  }
}

async function readWithEvaluations(
  client: Prisma.TransactionClient | PrismaClient,
  input: {
    workspaceId: string
    projectId: string
    runId: string
  },
): Promise<RunWithEvaluations | null> {
  return client.v2ProofIntegrityRun.findFirst({
    where: {
      id: input.runId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    },
    include: {
      evaluations: { orderBy: { sequence: 'asc' } },
    },
  })
}

function comparison(
  evaluation: Readonly<ProofIntegrityEvaluation>,
  dimension: 'rights' | 'consent',
) {
  return evaluation.comparisons.find(
    (entry) => entry.dimension === dimension,
  )
}

async function assertSourcesCurrent(
  transaction: Prisma.TransactionClient,
  run: Readonly<ProofIntegrityRun>,
) {
  const [proofNeed, recipe, actor] = await Promise.all([
    transaction.v2ProofNeedRun.findFirst({
      where: {
        id: run.proofNeedRunId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        batchId: run.batchId,
        targetRecipeId: run.targetRecipeId,
        targetRecipeHash: run.targetRecipeHash,
        runHash: run.proofNeedRunHash,
      },
      include: { items: true },
    }),
    transaction.v2VariantRecipeRun.findFirst({
      where: {
        id: run.targetRecipeId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        batchId: run.batchId,
        runHash: run.targetRecipeHash,
      },
      select: {
        id: true,
        compatibilityGraphId: true,
      },
    }),
    transaction.v2ApiClient.findFirst({
      where: {
        id: run.createdByClientId,
        workspaceId: run.workspaceId,
        status: 'active',
      },
      select: { id: true },
    }),
  ])
  if (!proofNeed || !recipe || !actor) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'ProofIntegrity inputs or actor changed before commit',
    )
  }

  for (const evaluation of run.evaluations) {
    const item = proofNeed.items.find(
      (candidate) => candidate.id === evaluation.proofNeedItemId,
    )
    if (
      !item ||
      item.itemHash !== evaluation.proofNeedItemHash ||
      item.resolution !== evaluation.proofNeedResolution ||
      item.selectedEvidenceId !==
        (evaluation.selectedEvidenceId ?? null) ||
      item.selectedEvidenceHash !==
        (evaluation.selectedEvidenceHash ?? null)
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        `ProofNeed item ${evaluation.proofNeedItemId} changed before ProofIntegrity commit`,
      )
    }

    if (evaluation.recipeContext) {
      const node = await transaction.v2CompatibilityGraphNode.findFirst({
        where: {
          id: evaluation.recipeContext.nodeId,
          workspaceId: run.workspaceId,
          graphId: recipe.compatibilityGraphId,
          nodeHash: evaluation.recipeContext.nodeHash,
          contextHash: evaluation.recipeContext.contextHash,
        },
        select: { id: true },
      })
      if (!node) {
        throw new DomainError(
          'VERSION_CONFLICT',
          `Recipe node ${evaluation.recipeContext.nodeId} changed before ProofIntegrity commit`,
        )
      }
    }

    if (!evaluation.selectedEvidenceId) continue
    const evidence = await transaction.v2EvidenceSegment.findFirst({
      where: {
        id: evaluation.selectedEvidenceId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        evidenceHash: evaluation.selectedEvidenceHash,
      },
      include: {
        sourceArtifact: {
          include: { currentRightsSnapshot: true },
        },
      },
    })
    const rights = evidence?.sourceArtifact.currentRightsSnapshot
    if (!evidence || !rights) {
      throw new DomainError(
        'VERSION_CONFLICT',
        `Evidence ${evaluation.selectedEvidenceId} changed before ProofIntegrity commit`,
      )
    }

    const evaluatedAt = Date.parse(evaluation.evaluatedAt)
    const rightsExpired =
      rights.expiresAt !== null &&
      rights.expiresAt.getTime() <= evaluatedAt
    const consentExpired =
      rights.consentExpiresAt !== null &&
      rights.consentExpiresAt.getTime() <= evaluatedAt
    const rightsComparison = comparison(evaluation, 'rights')
    const consentComparison = comparison(evaluation, 'consent')
    const expectedRightsOutcome = rightsExpired
      ? 'expired'
      : rights.status === 'approved' &&
          rights.id === evidence.rightsSnapshotId
        ? 'match'
        : 'mismatch'
    const consentRequirement =
      evaluation.recipeContext?.consentRequirement ?? 'approved'
    const consentAllowed = consentRequirement ===
      'approved-or-not-required'
      ? ['approved', 'not-required'].includes(rights.consentStatus)
      : rights.consentStatus === 'approved'
    const expectedConsentOutcome = consentExpired
      ? 'expired'
      : consentAllowed ? 'match' : 'mismatch'
    if (
      !rightsComparison ||
      !consentComparison ||
      stableSerialize(rightsComparison.actual) !==
        stableSerialize([rights.status]) ||
      stableSerialize(consentComparison.actual) !==
        stableSerialize([rights.consentStatus]) ||
      rightsComparison.outcome !== expectedRightsOutcome ||
      consentComparison.outcome !== expectedConsentOutcome
    ) {
      throw new DomainError(
        'ASSET_RIGHTS_BLOCKED',
        `Evidence ${evaluation.selectedEvidenceId} rights changed before ProofIntegrity commit`,
      )
    }
  }
}

export class PrismaProofIntegrityRepository
implements ProofIntegrityRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async findReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.prisma.v2ProofIntegrityRun.findUnique({
      where: {
        workspaceId_projectId_createdByClientId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByClientId: input.actorClientId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: {
        evaluations: { orderBy: { sequence: 'asc' } },
      },
    })
    if (!row) return null
    const audit = hydrateExternalActorAudit(row, row.createdByClientId)
    if (audit.contextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
    return hydrateRecord(row)
  }

  async create(
    input: {
      run: Readonly<ProofIntegrityRun>
      requestFingerprint: string
      idempotencyKey: string
      authenticationAudit: Parameters<ProofIntegrityRepository['create']>[0]['authenticationAudit']
    },
    attempt = 1,
  ): ReturnType<ProofIntegrityRepository['create']> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay =
          await transaction.v2ProofIntegrityRun.findUnique({
            where: {
              workspaceId_projectId_createdByClientId_idempotencyKey: {
                workspaceId: input.run.workspaceId,
                projectId: input.run.projectId,
                createdByClientId: input.run.createdByClientId,
                idempotencyKey: input.idempotencyKey,
              },
            },
            include: {
              evaluations: { orderBy: { sequence: 'asc' } },
            },
          })
        if (replay) {
          const audit = hydrateExternalActorAudit(replay, replay.createdByClientId)
          if (audit.contextHash !== input.authenticationAudit.contextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
          if (replay.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different ProofIntegrity request',
            )
          }
          return Object.freeze({
            run: hydrateRecord(replay),
            replayed: true,
          })
        }

        await assertSourcesCurrent(transaction, input.run)
        await transaction.v2ProofIntegrityRun.create({
          data: runData(input),
        })
        await transaction.v2ProofIntegrityEvaluation.createMany({
          data: input.run.evaluations.map((evaluation) =>
            evaluationData(input.run, evaluation)),
        })
        const persisted = await readWithEvaluations(transaction, {
          workspaceId: input.run.workspaceId,
          projectId: input.run.projectId,
          runId: input.run.id,
        })
        if (!persisted) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'ProofIntegrity commit was not readable',
          )
        }
        return Object.freeze({
          run: hydrateRecord(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.create(input, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findReplay({
          workspaceId: input.run.workspaceId,
          projectId: input.run.projectId,
          actorClientId: input.run.createdByClientId,
          idempotencyKey: input.idempotencyKey,
          actorContextHash: input.authenticationAudit.contextHash,
        })
        if (replay) {
          if (replay.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different ProofIntegrity request',
            )
          }
          return Object.freeze({ run: replay, replayed: true })
        }
      }
      if (
        isPrismaCode(error, 'P2034') ||
        isPrismaCode(error, 'P2002')
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'ProofIntegrity creation conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    projectId: string
    runId: string
  }) {
    const row = await readWithEvaluations(this.prisma, input)
    return row ? hydrateRecord(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    proofNeedRunId?: string
    targetRecipeId?: string
    outcome?: ProofIntegrityEvaluation['outcome']
    readyForAssembly?: boolean
    limit: number
    cursor?: string
  }) {
    const cursor = input.cursor
      ? await this.prisma.v2ProofIntegrityRun.findFirst({
          where: {
            id: input.cursor,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
          },
          select: { id: true, createdAt: true },
        })
      : null
    if (input.cursor && !cursor) {
      throw new DomainError(
        'INVALID_CURSOR',
        'ProofIntegrity cursor is invalid',
      )
    }
    const rows = await this.prisma.v2ProofIntegrityRun.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.proofNeedRunId
          ? { proofNeedRunId: input.proofNeedRunId }
          : {}),
        ...(input.targetRecipeId
          ? { targetRecipeId: input.targetRecipeId }
          : {}),
        ...(input.outcome
          ? { evaluations: { some: { outcome: input.outcome } } }
          : {}),
        ...(input.readyForAssembly !== undefined
          ? { readyForAssembly: input.readyForAssembly }
          : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                {
                  createdAt: cursor.createdAt,
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      include: {
        evaluations: { orderBy: { sequence: 'asc' } },
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
    })
    const hasMore = rows.length > input.limit
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows
    return Object.freeze({
      runs: Object.freeze(pageRows.map(hydrateRecord)),
      ...(hasMore
        ? { nextCursor: pageRows.at(-1)!.id }
        : {}),
    })
  }
}
