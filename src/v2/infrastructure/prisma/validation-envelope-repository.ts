import {
  Prisma,
  type PrismaClient,
  type V2ValidationEnvelopeDecision as DecisionRow,
  type V2ValidationEnvelopeReuse as ReuseRow,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ValidationEnvelopeCreateRecord,
  ValidationEnvelopeDecisionRecord,
  ValidationEnvelopeRepository,
  ValidationEnvelopeReuseRecord,
} from '../../application/ports/validation-envelope-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  VALIDATION_ENVELOPE_DECISION_VERSION,
  VALIDATION_ENVELOPE_POLICY_VERSION,
  VALIDATION_ENVELOPE_REUSE_SCHEMA_VERSION,
  type ValidationEnvelopeDecision,
  type ValidationEnvelopeReusePlan,
} from '../../domain/validation-envelope.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

type ReuseWithDecisions = ReuseRow & {
  decisions: DecisionRow[]
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function canonicalJson<T>(value: string, field: string): Readonly<T> {
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
    Array.isArray(parsed) ||
    stableSerialize(parsed) !== value
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is not canonical`,
    )
  }
  return deepFreeze(parsed as T)
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function normalizedItems(values: readonly string[]): string {
  return `\n${values.join('\n')}\n`
}

function hydrateDecision(
  row: DecisionRow,
): Readonly<ValidationEnvelopeDecision> {
  hydrateExternalActorAudit(row, row.actorClientId)
  const decision = canonicalJson<ValidationEnvelopeDecision>(
    row.decisionJson,
    `validation envelope decision ${row.id}`,
  )
  const {
    decisionHash: _decisionHash,
    ...body
  } = decision
  if (
    decision.schemaVersion !== VALIDATION_ENVELOPE_DECISION_VERSION ||
    decision.id !== row.id ||
    decision.reusePlanId !== row.reusePlanId ||
    decision.sequence !== row.sequence ||
    decision.kind !== row.kind ||
    decision.outcome !== row.outcome ||
    decision.validation !== row.validation ||
    decision.actorClientId !== row.actorClientId ||
    decision.createdAt !== row.createdAt.toISOString() ||
    decision.decisionHash !== row.decisionHash ||
    calculateCanonicalHash(body) !== row.decisionHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored validation envelope decision ${row.id} failed integrity validation`,
    )
  }
  return decision
}

function hydratePlan(
  row: ReuseRow,
): Readonly<ValidationEnvelopeReusePlan> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  const plan = canonicalJson<ValidationEnvelopeReusePlan>(
    row.planJson,
    `validation envelope reuse ${row.id}`,
  )
  const {
    planHash: _planHash,
    ...body
  } = plan
  if (
    plan.schemaVersion !== VALIDATION_ENVELOPE_REUSE_SCHEMA_VERSION ||
    plan.policyVersion !== VALIDATION_ENVELOPE_POLICY_VERSION ||
    plan.id !== row.id ||
    plan.workspaceId !== row.workspaceId ||
    plan.projectId !== row.projectId ||
    plan.batchId !== row.batchId ||
    plan.validatedSegmentId !== row.validatedSegmentId ||
    plan.validatedSegmentHash !== row.validatedSegmentHash ||
    plan.sourceArtifactId !== row.sourceArtifactId ||
    plan.sourceArtifactSha256 !== row.sourceArtifactSha256 ||
    plan.sourceRangeMs[0] !== row.sourceRangeStartMs ||
    plan.sourceRangeMs[1] !== row.sourceRangeEndMs ||
    plan.targetRecipeId !== row.targetRecipeId ||
    plan.targetRecipeHash !== row.targetRecipeHash ||
    plan.objective !== row.objective ||
    stableSerialize(plan.aspectRules) !== row.aspectRulesJson ||
    normalizedItems(plan.protectedAspects) !==
      row.protectedAspectsText ||
    normalizedItems(plan.mutableAspects) !== row.mutableAspectsText ||
    stableSerialize(plan.requestedChanges) !==
      row.requestedChangesJson ||
    plan.requestedChanges.length !== row.requestedChangeCount ||
    normalizedItems(plan.autoProtectedChanges) !==
      row.autoProtectedChangesText ||
    normalizedItems(plan.approvalRequiredChanges) !==
      row.approvalRequiredChangesText ||
    plan.approvalRequired !== row.approvalRequired ||
    plan.initialValidation !== row.initialValidation ||
    stableSerialize(plan.composition) !== row.compositionJson ||
    plan.composition.compositionHash !== row.compositionHash ||
    plan.composition.excessMaterialIncluded !==
      row.excessMaterialIncluded ||
    plan.composition.validatedSourceOutsideEnvelopeIncluded !==
      row.validatedOutsideRangeIncluded ||
    plan.createdByClientId !== row.createdByClientId ||
    plan.createdAt !== row.createdAt.toISOString() ||
    plan.planHash !== row.planHash ||
    calculateCanonicalHash(body) !== row.planHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored validation envelope reuse ${row.id} failed integrity validation`,
    )
  }
  return plan
}

function hydrateRecord(
  row: ReuseWithDecisions,
): Readonly<ValidationEnvelopeReuseRecord> {
  const plan = hydratePlan(row)
  const decisions = Object.freeze(
    row.decisions
      .toSorted((left, right) => left.sequence - right.sequence)
      .map(hydrateDecision),
  )
  if (
    decisions.length < 1 ||
    decisions.length > 2 ||
    decisions[0]?.sequence !== 1 ||
    (decisions.length === 2 && decisions[1]?.sequence !== 2)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored validation envelope reuse ${row.id} has an invalid decision log`,
    )
  }
  return Object.freeze({
    plan,
    decisions,
    currentDecision: decisions.at(-1)!,
  })
}

function planData(record: Readonly<ValidationEnvelopeCreateRecord>, authenticationAudit: Parameters<ValidationEnvelopeRepository['create']>[1]) {
  const { plan } = record
  return {
    id: plan.id,
    workspaceId: plan.workspaceId,
    projectId: plan.projectId,
    batchId: plan.batchId,
    validatedSegmentId: plan.validatedSegmentId,
    validatedSegmentHash: plan.validatedSegmentHash,
    sourceArtifactId: plan.sourceArtifactId,
    sourceArtifactSha256: plan.sourceArtifactSha256,
    sourceRangeStartMs: plan.sourceRangeMs[0],
    sourceRangeEndMs: plan.sourceRangeMs[1],
    targetRecipeId: plan.targetRecipeId,
    targetRecipeHash: plan.targetRecipeHash,
    schemaVersion: plan.schemaVersion,
    policyVersion: plan.policyVersion,
    objective: plan.objective,
    aspectRulesJson: stableSerialize(plan.aspectRules),
    protectedAspectsText: normalizedItems(plan.protectedAspects),
    mutableAspectsText: normalizedItems(plan.mutableAspects),
    requestedChangesJson: stableSerialize(plan.requestedChanges),
    requestedChangeCount: plan.requestedChanges.length,
    autoProtectedChangesText: normalizedItems(
      plan.autoProtectedChanges,
    ),
    approvalRequiredChangesText: normalizedItems(
      plan.approvalRequiredChanges,
    ),
    approvalRequired: plan.approvalRequired,
    initialValidation: plan.initialValidation,
    compositionJson: stableSerialize(plan.composition),
    compositionHash: plan.composition.compositionHash,
    excessMaterialIncluded:
      plan.composition.excessMaterialIncluded,
    validatedOutsideRangeIncluded:
      plan.composition.validatedSourceOutsideEnvelopeIncluded,
    planJson: stableSerialize(plan),
    planHash: plan.planHash,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: plan.createdByClientId,
    ...externalActorAuditData(authenticationAudit, plan.workspaceId, plan.createdByClientId),
    createdAt: new Date(plan.createdAt),
  }
}

function decisionData(
  input: Readonly<ValidationEnvelopeDecisionRecord>,
  scope: { workspaceId: string; projectId: string },
  authenticationAudit: Parameters<ValidationEnvelopeRepository['appendDecision']>[1],
) {
  const { decision } = input
  return {
    id: decision.id,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    reusePlanId: decision.reusePlanId,
    sequence: decision.sequence,
    schemaVersion: decision.schemaVersion,
    kind: decision.kind,
    outcome: decision.outcome,
    validation: decision.validation,
    decisionJson: stableSerialize(decision),
    decisionHash: decision.decisionHash,
    requestFingerprint: input.requestFingerprint,
    idempotencyKey: input.idempotencyKey,
    actorClientId: decision.actorClientId,
    ...externalActorAuditData(authenticationAudit, scope.workspaceId, decision.actorClientId),
    createdAt: new Date(decision.createdAt),
  }
}

async function readWithDecisions(
  transaction: Prisma.TransactionClient | PrismaClient,
  input: {
    workspaceId: string
    projectId: string
    reusePlanId: string
  },
): Promise<ReuseWithDecisions | null> {
  return transaction.v2ValidationEnvelopeReuse.findFirst({
    where: {
      id: input.reusePlanId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    },
    include: {
      decisions: { orderBy: { sequence: 'asc' } },
    },
  })
}

export class PrismaValidationEnvelopeRepository
implements ValidationEnvelopeRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async findCreateReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.prisma.v2ValidationEnvelopeReuse.findUnique({
      where: {
        workspaceId_projectId_createdByClientId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByClientId: input.actorClientId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: {
        decisions: { orderBy: { sequence: 'asc' } },
      },
    })
    if (!row) return null
    const audit = hydrateExternalActorAudit(row, row.createdByClientId)
    if (audit.contextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
    return Object.freeze({
          record: hydrateRecord(row),
          requestFingerprint: row.requestFingerprint,
        })
  }

  async create(
    record: Readonly<ValidationEnvelopeCreateRecord>,
    authenticationAudit: Parameters<ValidationEnvelopeRepository['create']>[1],
    attempt = 1,
  ): ReturnType<ValidationEnvelopeRepository['create']> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay =
          await transaction.v2ValidationEnvelopeReuse.findUnique({
            where: {
              workspaceId_projectId_createdByClientId_idempotencyKey: {
                workspaceId: record.plan.workspaceId,
                projectId: record.plan.projectId,
                createdByClientId: record.plan.createdByClientId,
                idempotencyKey: record.idempotencyKey,
              },
            },
            include: {
              decisions: { orderBy: { sequence: 'asc' } },
            },
          })
        if (replay) {
          const audit = hydrateExternalActorAudit(replay, replay.createdByClientId)
          if (audit.contextHash !== authenticationAudit.contextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different validation envelope request',
            )
          }
          return Object.freeze({
            ...hydrateRecord(replay),
            replayed: true,
          })
        }
        const [validated, recipe, actor] = await Promise.all([
          transaction.v2ValidatedSegment.findFirst({
            where: {
              id: record.plan.validatedSegmentId,
              workspaceId: record.plan.workspaceId,
              projectId: record.plan.projectId,
              validatedSegmentHash:
                record.plan.validatedSegmentHash,
              sourceArtifactId: record.plan.sourceArtifactId,
              sourceArtifactSha256:
                record.plan.sourceArtifactSha256,
            },
            select: { id: true },
          }),
          transaction.v2VariantRecipeRun.findFirst({
            where: {
              id: record.plan.targetRecipeId,
              workspaceId: record.plan.workspaceId,
              projectId: record.plan.projectId,
              batchId: record.plan.batchId,
              runHash: record.plan.targetRecipeHash,
            },
            select: { id: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: record.plan.createdByClientId,
              workspaceId: record.plan.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!validated || !recipe || !actor) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Validation envelope source, recipe or actor changed before commit',
          )
        }
        await transaction.v2ValidationEnvelopeReuse.create({
          data: planData(record, authenticationAudit),
        })
        await transaction.v2ValidationEnvelopeDecision.create({
          data: decisionData({
            decision: record.initialDecision,
            requestFingerprint: record.requestFingerprint,
            idempotencyKey: record.idempotencyKey,
          }, {
            workspaceId: record.plan.workspaceId,
            projectId: record.plan.projectId,
          }, authenticationAudit),
        })
        const persisted = await readWithDecisions(transaction, {
          workspaceId: record.plan.workspaceId,
          projectId: record.plan.projectId,
          reusePlanId: record.plan.id,
        })
        if (!persisted) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Validation envelope commit was not readable',
          )
        }
        return Object.freeze({
          ...hydrateRecord(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.create(record, authenticationAudit, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findCreateReplay({
          workspaceId: record.plan.workspaceId,
          projectId: record.plan.projectId,
          actorClientId: record.plan.createdByClientId,
          idempotencyKey: record.idempotencyKey,
          actorContextHash: authenticationAudit.contextHash,
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different validation envelope request',
            )
          }
          return Object.freeze({
            ...replay.record,
            replayed: true,
          })
        }
      }
      if (
        isPrismaCode(error, 'P2034') ||
        isPrismaCode(error, 'P2002')
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Validation envelope creation conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    projectId: string
    reusePlanId: string
  }) {
    const row = await readWithDecisions(this.prisma, input)
    return row ? hydrateRecord(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    validatedSegmentId?: string
    batchId?: string
    limit: number
    cursor?: string
  }) {
    const cursor = input.cursor
      ? await this.prisma.v2ValidationEnvelopeReuse.findFirst({
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
        'Validation envelope cursor is invalid',
      )
    }
    const rows =
      await this.prisma.v2ValidationEnvelopeReuse.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          ...(input.validatedSegmentId
            ? { validatedSegmentId: input.validatedSegmentId }
            : {}),
          ...(input.batchId ? { batchId: input.batchId } : {}),
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
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        take: input.limit + 1,
        include: {
          decisions: { orderBy: { sequence: 'asc' } },
        },
      })
    const hasNextPage = rows.length > input.limit
    const pageRows = hasNextPage ? rows.slice(0, input.limit) : rows
    const reuses = Object.freeze(pageRows.map(hydrateRecord))
    return Object.freeze({
      reuses,
      ...(hasNextPage && reuses.length > 0
        ? { nextCursor: reuses.at(-1)!.plan.id }
        : {}),
    })
  }

  async findDecisionReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.prisma.v2ValidationEnvelopeDecision
      .findUnique({
        where: {
          workspaceId_projectId_actorClientId_idempotencyKey: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            actorClientId: input.actorClientId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      })
    if (!row) return null
    const audit = hydrateExternalActorAudit(row, row.actorClientId)
    if (audit.contextHash !== input.actorContextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
    return Object.freeze({
          decision: hydrateDecision(row),
          requestFingerprint: row.requestFingerprint,
          idempotencyKey: row.idempotencyKey,
        })
  }

  async appendDecision(
    record: Readonly<ValidationEnvelopeDecisionRecord>,
    authenticationAudit: Parameters<ValidationEnvelopeRepository['appendDecision']>[1],
    attempt = 1,
  ): ReturnType<ValidationEnvelopeRepository['appendDecision']> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const plan =
          await transaction.v2ValidationEnvelopeReuse.findUnique({
            where: { id: record.decision.reusePlanId },
            include: {
              decisions: { orderBy: { sequence: 'asc' } },
            },
          })
        if (!plan) {
          throw new DomainError(
            'VALIDATION_ENVELOPE_NOT_FOUND',
            'Validation envelope reuse was not found',
          )
        }
        const replay =
          await transaction.v2ValidationEnvelopeDecision.findUnique({
            where: {
              workspaceId_projectId_actorClientId_idempotencyKey: {
                workspaceId: plan.workspaceId,
                projectId: plan.projectId,
                actorClientId: record.decision.actorClientId,
                idempotencyKey: record.idempotencyKey,
              },
            },
          })
        if (replay) {
          const audit = hydrateExternalActorAudit(replay, replay.actorClientId)
          if (audit.contextHash !== authenticationAudit.contextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another authenticated actor context')
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different validation envelope decision',
            )
          }
          const replayPlan = await readWithDecisions(transaction, {
            workspaceId: replay.workspaceId,
            projectId: replay.projectId,
            reusePlanId: replay.reusePlanId,
          })
          if (!replayPlan) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Validation envelope decision lost its plan',
            )
          }
          return Object.freeze({
            ...hydrateRecord(replayPlan),
            replayed: true,
          })
        }
        if (
          !plan.approvalRequired ||
          plan.decisions.length !== 1 ||
          record.decision.sequence !== 2
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Validation envelope approval is no longer pending',
          )
        }
        const actor = await transaction.v2ApiClient.findFirst({
          where: {
            id: record.decision.actorClientId,
            workspaceId: plan.workspaceId,
            status: 'active',
          },
          select: { id: true },
        })
        if (!actor) {
          throw new DomainError(
            'API_CLIENT_NOT_FOUND',
            'Validation envelope decision actor is inactive',
          )
        }
        await transaction.v2ValidationEnvelopeDecision.create({
          data: decisionData(record, {
            workspaceId: plan.workspaceId,
            projectId: plan.projectId,
          }, authenticationAudit),
        })
        const persisted = await readWithDecisions(transaction, {
          workspaceId: plan.workspaceId,
          projectId: plan.projectId,
          reusePlanId: plan.id,
        })
        if (!persisted) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Validation envelope decision was not readable',
          )
        }
        return Object.freeze({
          ...hydrateRecord(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.appendDecision(record, authenticationAudit, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const plan = await this.prisma.v2ValidationEnvelopeReuse
          .findUnique({
            where: { id: record.decision.reusePlanId },
            select: { workspaceId: true, projectId: true },
          })
        if (plan) {
          const replay = await this.findDecisionReplay({
            ...plan,
            actorClientId: record.decision.actorClientId,
            idempotencyKey: record.idempotencyKey,
            actorContextHash: authenticationAudit.contextHash,
          })
          if (replay) {
            if (
              replay.requestFingerprint !== record.requestFingerprint
            ) {
              throw new DomainError(
                'IDEMPOTENCY_PAYLOAD_MISMATCH',
                'Idempotency key was used with a different validation envelope decision',
              )
            }
            const result = await this.read({
              ...plan,
              reusePlanId: record.decision.reusePlanId,
            })
            if (result) {
              return Object.freeze({ ...result, replayed: true })
            }
          }
        }
      }
      if (
        isPrismaCode(error, 'P2034') ||
        isPrismaCode(error, 'P2002')
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Validation envelope decision conflicted with another transaction',
        )
      }
      throw error
    }
  }
}
