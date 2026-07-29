import {
  Prisma,
  type PrismaClient,
  type V2ProofModePlan,
  type V2ProofModeRun,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedProofModeRun,
  ProofModeRepository,
} from '../../application/ports/proof-mode-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  hydrateProofModeRun,
  type ProofModePlan,
  type ProofModeRun,
} from '../../domain/proof-mode.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type RunWithPlans = V2ProofModeRun & {
  plans: V2ProofModePlan[]
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

function lineList(values: readonly string[]): string {
  return `\n${values.join('\n')}\n`
}

function hydrateRecord(
  row: RunWithPlans,
): Readonly<PersistedProofModeRun> {
  const run = hydrateProofModeRun(
    canonicalValue<ProofModeRun>(
      row.runJson,
      `ProofMode run ${row.id}`,
    ),
  )
  if (
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.batchId !== row.batchId ||
    run.proofIntegrityRunId !== row.proofIntegrityRunId ||
    run.proofIntegrityRunHash !== row.proofIntegrityRunHash ||
    run.proofNeedRunId !== row.proofNeedRunId ||
    run.proofNeedRunHash !== row.proofNeedRunHash ||
    run.schemaVersion !== row.schemaVersion ||
    run.policyVersion !== row.policyVersion ||
    lineList(run.formats) !== row.formatsText ||
    run.summary.formatCount !== row.formatCount ||
    run.rhythm !== row.rhythm ||
    run.summary.approvedEvidenceCount !==
      row.approvedEvidenceCount ||
    run.summary.planCount !== row.planCount ||
    run.summary.automaticCount !== row.automaticCount ||
    run.summary.manualOverrideCount !== row.manualOverrideCount ||
    run.summary.cutawayCount !== row.cutawayCount ||
    run.summary.splitScreenCount !== row.splitScreenCount ||
    run.summary.proofCardCount !== row.proofCardCount ||
    run.summary.allIntegrityBindingsPreserved !==
      row.allIntegrityBindingsPreserved ||
    run.summary.readyForCompilation !== row.readyForCompilation ||
    run.runHash !== row.runHash ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString() ||
    run.plans.length !== row.plans.length
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ProofMode run ${row.id} failed integrity validation`,
    )
  }
  const orderedRows = row.plans.toSorted(
    (left, right) => left.sequence - right.sequence,
  )
  for (let index = 0; index < run.plans.length; index += 1) {
    const plan = run.plans[index]!
    const stored = orderedRows[index]!
    const persisted = canonicalValue<ProofModePlan>(
      stored.planJson,
      `ProofMode plan ${stored.id}`,
    )
    if (
      stableSerialize(persisted) !== stableSerialize(plan) ||
      stored.id !== plan.id ||
      stored.workspaceId !== run.workspaceId ||
      stored.projectId !== run.projectId ||
      stored.runId !== run.id ||
      stored.proofIntegrityRunId !== run.proofIntegrityRunId ||
      stored.proofIntegrityEvaluationId !==
        plan.proofIntegrityEvaluationId ||
      stored.proofIntegrityEvaluationHash !==
        plan.proofIntegrityEvaluationHash ||
      stored.proofNeedRunId !== run.proofNeedRunId ||
      stored.proofNeedItemId !== plan.proofNeedItemId ||
      stored.proofNeedItemHash !== plan.proofNeedItemHash ||
      stored.claimText !== plan.claimText ||
      stored.sourceEvidenceId !== plan.sourceEvidenceId ||
      stored.sourceEvidenceHash !== plan.sourceEvidenceHash ||
      stored.sourceArtifactId !== plan.sourceArtifactId ||
      stored.sourceMediaType !== plan.sourceMediaType ||
      stored.sequence !== plan.sequence ||
      stored.format !== plan.format ||
      stored.rhythm !== plan.rhythm ||
      stored.mode !== plan.mode ||
      stored.selection !== plan.selection ||
      stored.contextRequired !== plan.contextRequired ||
      stored.identificationRequired !==
        plan.identificationRequired ||
      stored.reasonCodesText !== lineList(plan.reasonCodes) ||
      stored.reasonCount !== plan.reasonCodes.length ||
      stored.presentationJson !==
        stableSerialize(plan.presentation) ||
      stored.presentationHash !==
        plan.presentation.presentationHash ||
      stored.timingJson !== stableSerialize(plan.timing) ||
      stored.timingHash !== plan.timing.timingHash ||
      stored.layoutJson !== stableSerialize(plan.layout) ||
      stored.layoutHash !== plan.layout.layoutHash ||
      stored.planHash !== plan.planHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored ProofMode plan ${stored.id} failed integrity validation`,
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
  run: Readonly<ProofModeRun>
  requestFingerprint: string
  idempotencyKey: string
}) {
  const { run } = input
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    batchId: run.batchId,
    proofIntegrityRunId: run.proofIntegrityRunId,
    proofIntegrityRunHash: run.proofIntegrityRunHash,
    proofNeedRunId: run.proofNeedRunId,
    proofNeedRunHash: run.proofNeedRunHash,
    schemaVersion: run.schemaVersion,
    policyVersion: run.policyVersion,
    formatsText: lineList(run.formats),
    formatCount: run.summary.formatCount,
    rhythm: run.rhythm,
    approvedEvidenceCount: run.summary.approvedEvidenceCount,
    planCount: run.summary.planCount,
    automaticCount: run.summary.automaticCount,
    manualOverrideCount: run.summary.manualOverrideCount,
    cutawayCount: run.summary.cutawayCount,
    splitScreenCount: run.summary.splitScreenCount,
    proofCardCount: run.summary.proofCardCount,
    allIntegrityBindingsPreserved:
      run.summary.allIntegrityBindingsPreserved,
    readyForCompilation: run.summary.readyForCompilation,
    runJson: stableSerialize(run),
    runHash: run.runHash,
    requestFingerprint: input.requestFingerprint,
    idempotencyKey: input.idempotencyKey,
    createdByClientId: run.createdByClientId,
    createdAt: new Date(run.createdAt),
  }
}

function planData(
  run: Readonly<ProofModeRun>,
  plan: Readonly<ProofModePlan>,
) {
  return {
    id: plan.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    runId: run.id,
    proofIntegrityRunId: run.proofIntegrityRunId,
    proofIntegrityEvaluationId:
      plan.proofIntegrityEvaluationId,
    proofIntegrityEvaluationHash:
      plan.proofIntegrityEvaluationHash,
    proofNeedRunId: run.proofNeedRunId,
    proofNeedItemId: plan.proofNeedItemId,
    proofNeedItemHash: plan.proofNeedItemHash,
    claimText: plan.claimText,
    sourceEvidenceId: plan.sourceEvidenceId,
    sourceEvidenceHash: plan.sourceEvidenceHash,
    sourceArtifactId: plan.sourceArtifactId,
    sourceMediaType: plan.sourceMediaType,
    sequence: plan.sequence,
    format: plan.format,
    rhythm: plan.rhythm,
    mode: plan.mode,
    selection: plan.selection,
    contextRequired: plan.contextRequired,
    identificationRequired: plan.identificationRequired,
    reasonCodesText: lineList(plan.reasonCodes),
    reasonCount: plan.reasonCodes.length,
    presentationJson: stableSerialize(plan.presentation),
    presentationHash: plan.presentation.presentationHash,
    timingJson: stableSerialize(plan.timing),
    timingHash: plan.timing.timingHash,
    layoutJson: stableSerialize(plan.layout),
    layoutHash: plan.layout.layoutHash,
    planJson: stableSerialize(plan),
    planHash: plan.planHash,
  }
}

async function readWithPlans(
  client: Prisma.TransactionClient | PrismaClient,
  input: {
    workspaceId: string
    projectId: string
    runId: string
  },
): Promise<RunWithPlans | null> {
  return client.v2ProofModeRun.findFirst({
    where: {
      id: input.runId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    },
    include: { plans: { orderBy: { sequence: 'asc' } } },
  })
}

async function assertSourcesCurrent(
  transaction: Prisma.TransactionClient,
  run: Readonly<ProofModeRun>,
) {
  const [integrity, proofNeed, actor] = await Promise.all([
    transaction.v2ProofIntegrityRun.findFirst({
      where: {
        id: run.proofIntegrityRunId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        batchId: run.batchId,
        proofNeedRunId: run.proofNeedRunId,
        proofNeedRunHash: run.proofNeedRunHash,
        runHash: run.proofIntegrityRunHash,
        readyForAssembly: true,
      },
      include: { evaluations: true },
    }),
    transaction.v2ProofNeedRun.findFirst({
      where: {
        id: run.proofNeedRunId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        batchId: run.batchId,
        runHash: run.proofNeedRunHash,
      },
      include: { items: true },
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
  if (!integrity || !proofNeed || !actor) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'ProofMode inputs or actor changed before commit',
    )
  }
  const evaluatedAt = new Date(run.createdAt)
  for (const plan of run.plans) {
    const evaluation = integrity.evaluations.find((candidate) =>
      candidate.id === plan.proofIntegrityEvaluationId)
    const item = proofNeed.items.find((candidate) =>
      candidate.id === plan.proofNeedItemId)
    if (
      !evaluation ||
      evaluation.evaluationHash !==
        plan.proofIntegrityEvaluationHash ||
      evaluation.outcome !== 'approved' ||
      !evaluation.allowedForAssembly ||
      evaluation.proofNeedItemId !== plan.proofNeedItemId ||
      evaluation.proofNeedItemHash !== plan.proofNeedItemHash ||
      evaluation.selectedEvidenceId !== plan.sourceEvidenceId ||
      evaluation.selectedEvidenceHash !== plan.sourceEvidenceHash ||
      evaluation.presentationHash !==
        plan.presentation.presentationHash ||
      !item ||
      item.itemHash !== plan.proofNeedItemHash ||
      item.claimText !== plan.claimText ||
      item.selectedEvidenceId !== plan.sourceEvidenceId ||
      item.selectedEvidenceHash !== plan.sourceEvidenceHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        `Proof source ${plan.proofNeedItemId} changed before commit`,
      )
    }
    const evidence = await transaction.v2EvidenceSegment.findFirst({
      where: {
        id: plan.sourceEvidenceId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        evidenceHash: plan.sourceEvidenceHash,
        sourceArtifactId: plan.sourceArtifactId,
        requiresContext: plan.contextRequired,
      },
      include: {
        sourceArtifact: {
          include: { currentRightsSnapshot: true },
        },
      },
    })
    const artifact = evidence?.sourceArtifact
    const rights = artifact?.currentRightsSnapshot
    if (
      !evidence ||
      !artifact ||
      !rights ||
      artifact.status !== 'available' ||
      artifact.mediaType !== plan.sourceMediaType ||
      artifact.currentRightsSnapshotId !==
        evidence.rightsSnapshotId ||
      rights.status !== 'approved' ||
      rights.expiresAt !== null &&
        rights.expiresAt <= evaluatedAt ||
      rights.consentExpiresAt !== null &&
        rights.consentExpiresAt <= evaluatedAt
    ) {
      throw new DomainError(
        'ASSET_RIGHTS_BLOCKED',
        `Proof source ${plan.sourceEvidenceId} is no longer current`,
      )
    }
  }
}

export class PrismaProofModeRepository
implements ProofModeRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async findReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
  }) {
    const row = await this.prisma.v2ProofModeRun.findUnique({
      where: {
        workspaceId_projectId_createdByClientId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByClientId: input.actorClientId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { plans: { orderBy: { sequence: 'asc' } } },
    })
    return row ? hydrateRecord(row) : null
  }

  async create(
    input: {
      run: Readonly<ProofModeRun>
      requestFingerprint: string
      idempotencyKey: string
    },
    attempt = 1,
  ): ReturnType<ProofModeRepository['create']> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2ProofModeRun.findUnique({
          where: {
            workspaceId_projectId_createdByClientId_idempotencyKey: {
              workspaceId: input.run.workspaceId,
              projectId: input.run.projectId,
              createdByClientId: input.run.createdByClientId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          include: { plans: { orderBy: { sequence: 'asc' } } },
        })
        if (replay) {
          if (replay.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different ProofMode request',
            )
          }
          return Object.freeze({
            run: hydrateRecord(replay),
            replayed: true,
          })
        }
        await assertSourcesCurrent(transaction, input.run)
        await transaction.v2ProofModeRun.create({
          data: runData(input),
        })
        await transaction.v2ProofModePlan.createMany({
          data: input.run.plans.map((plan) =>
            planData(input.run, plan)),
        })
        const persisted = await readWithPlans(transaction, {
          workspaceId: input.run.workspaceId,
          projectId: input.run.projectId,
          runId: input.run.id,
        })
        if (!persisted) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'ProofMode commit was not readable',
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
        })
        if (replay) {
          if (replay.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different ProofMode request',
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
          'ProofMode creation conflicted with another transaction',
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
    const row = await readWithPlans(this.prisma, input)
    return row ? hydrateRecord(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    proofIntegrityRunId?: string
    format?: '9:16' | '16:9' | '4:5' | '1:1' | '21:9'
    mode?: 'cutaway' | 'split-screen' | 'proof-card'
    manualOverride?: boolean
    limit: number
    cursor?: string
  }) {
    const cursor = input.cursor
      ? await this.prisma.v2ProofModeRun.findFirst({
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
        'ProofMode cursor is invalid',
      )
    }
    const rows = await this.prisma.v2ProofModeRun.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.proofIntegrityRunId
          ? { proofIntegrityRunId: input.proofIntegrityRunId }
          : {}),
        ...(
          input.format ||
          input.mode ||
          input.manualOverride !== undefined
            ? {
                plans: {
                  some: {
                    ...(input.format
                      ? { format: input.format }
                      : {}),
                    ...(input.mode ? { mode: input.mode } : {}),
                    ...(input.manualOverride !== undefined
                      ? {
                          selection: input.manualOverride
                            ? 'manual-override'
                            : 'automatic',
                        }
                      : {}),
                  },
                },
              }
            : {}
        ),
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
      include: { plans: { orderBy: { sequence: 'asc' } } },
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
