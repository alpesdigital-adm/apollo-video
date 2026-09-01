import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { NoveltyBudgetRepository } from '../../application/ports/novelty-budget-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertNoveltyBudgetDecision,
  createNoveltyBudgetPolicy,
  NOVELTY_BUDGET_DECISION_VERSION,
  type NoveltyBudgetDecision,
  type NoveltyBudgetDecisionLine,
  type NoveltyBudgetPolicy,
  type NoveltyGroup,
} from '../../domain/novelty-budget.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function hydratePolicy(row: {
  id: string; totalUnits: number; windowUnits: number; windowFrames: number
  cooldownFrames: number; minimumSeparationFrames: number; maximumPerGroup: number
  diversityFloor: number; baseUnitsJson: string; unitsPerSecond: number
  proximityPenaltyBps: number; repetitionPenaltyBps: number; policyHash: string
}): Readonly<NoveltyBudgetPolicy> {
  let baseUnitsByGroup: Record<NoveltyGroup, number>
  try {
    baseUnitsByGroup = JSON.parse(row.baseUnitsJson) as Record<NoveltyGroup, number>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored novelty policy ${row.id} has invalid base units JSON`)
  }
  const policy = createNoveltyBudgetPolicy({
    id: row.id,
    totalUnits: row.totalUnits,
    windowUnits: row.windowUnits,
    windowFrames: row.windowFrames,
    cooldownFrames: row.cooldownFrames,
    minimumSeparationFrames: row.minimumSeparationFrames,
    maximumPerGroup: row.maximumPerGroup,
    diversityFloor: row.diversityFloor,
    baseUnitsByGroup,
    unitsPerSecond: row.unitsPerSecond,
    proximityPenaltyBps: row.proximityPenaltyBps,
    repetitionPenaltyBps: row.repetitionPenaltyBps,
  })
  // Rebuilding the policy from its columns and comparing the hash catches a
  // column edited behind the aggregate's back — the whole point of storing the
  // hash beside the fields it covers.
  if (policy.policyHash !== row.policyHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored novelty policy ${row.id} does not match its hash`)
  }
  return policy
}

type LineRow = {
  candidateId: string; briefId: string; effectGroup: string; outcome: string
  chargedUnits: number; grossUnits: number; penaltyUnits: number
  consumedBeforeUnits: number; remainingUnits: number; densityUnits: number
  reason: string; blockedBecause: string | null; sequence: number
}

function hydrateDecision(row: {
  id: string; workspaceId: string; projectId: string; projectVersionId: string
  treatmentPlanId: string; storyPlanId: string; policyId: string; policyHash: string
  acceptedUnits: number; penalizedUnits: number; blockedCount: number; densityUnits: number
  treatment: string; decisionHash: string; evaluatedAt: Date
  lines: LineRow[]
}): Readonly<NoveltyBudgetDecision> {
  const lines = [...row.lines]
    .sort((left, right) => left.sequence - right.sequence)
    .map((line): Readonly<NoveltyBudgetDecisionLine> => Object.freeze({
      candidateId: line.candidateId,
      briefId: line.briefId,
      group: line.effectGroup as NoveltyGroup,
      outcome: line.outcome as NoveltyBudgetDecisionLine['outcome'],
      chargedUnits: line.chargedUnits,
      grossUnits: line.grossUnits,
      penaltyUnits: line.penaltyUnits,
      consumedBeforeUnits: line.consumedBeforeUnits,
      remainingUnits: line.remainingUnits,
      densityUnits: line.densityUnits,
      reason: line.reason,
      ...(line.blockedBecause ? { blockedBecause: line.blockedBecause as NoveltyBudgetDecisionLine['blockedBecause'] } : {}),
    }))
  return assertNoveltyBudgetDecision(Object.freeze({
    schemaVersion: NOVELTY_BUDGET_DECISION_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    treatmentPlanId: row.treatmentPlanId,
    storyPlanId: row.storyPlanId,
    policyId: row.policyId,
    policyHash: row.policyHash,
    lines: Object.freeze(lines),
    acceptedUnits: row.acceptedUnits,
    penalizedUnits: row.penalizedUnits,
    blockedCount: row.blockedCount,
    densityUnits: row.densityUnits,
    treatment: row.treatment as NoveltyBudgetDecision['treatment'],
    evaluatedAt: row.evaluatedAt.toISOString(),
    decisionHash: row.decisionHash,
  }))
}

export class PrismaNoveltyBudgetRepository implements NoveltyBudgetRepository {
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient = getV2PostgresClient()) {
    this.prisma = prisma
  }

  async persistPolicy(input: Parameters<NoveltyBudgetRepository['persistPolicy']>[0]) {
    const existing = await this.prisma.v2NoveltyBudgetPolicy.findFirst({
      where: { workspaceId: input.workspaceId, policyHash: input.policy.policyHash },
    })
    if (existing) return Object.freeze({ policy: hydratePolicy(existing), replayed: true })
    try {
      const row = await this.prisma.v2NoveltyBudgetPolicy.create({
        data: {
          id: input.policy.id,
          workspaceId: input.workspaceId,
          schemaVersion: input.policy.schemaVersion,
          totalUnits: input.policy.totalUnits,
          windowUnits: input.policy.windowUnits,
          windowFrames: input.policy.windowFrames,
          cooldownFrames: input.policy.cooldownFrames,
          minimumSeparationFrames: input.policy.minimumSeparationFrames,
          maximumPerGroup: input.policy.maximumPerGroup,
          diversityFloor: input.policy.diversityFloor,
          baseUnitsJson: stableSerialize(input.policy.baseUnitsByGroup),
          unitsPerSecond: input.policy.unitsPerSecond,
          proximityPenaltyBps: input.policy.proximityPenaltyBps,
          repetitionPenaltyBps: input.policy.repetitionPenaltyBps,
          policyHash: input.policy.policyHash,
          createdAt: new Date(input.createdAt),
        },
      })
      return Object.freeze({ policy: hydratePolicy(row), replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const replay = await this.prisma.v2NoveltyBudgetPolicy.findFirst({
        where: { workspaceId: input.workspaceId, policyHash: input.policy.policyHash },
      })
      if (!replay) throw new DomainError('VERSION_CONFLICT', 'Novelty policy id already exists with a different body')
      return Object.freeze({ policy: hydratePolicy(replay), replayed: true })
    }
  }

  async persistDecision(input: Parameters<NoveltyBudgetRepository['persistDecision']>[0]) {
    const decision = assertNoveltyBudgetDecision(input.decision)
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.v2NoveltyBudgetDecision.create({
          data: {
            id: decision.id,
            workspaceId: decision.workspaceId,
            projectId: decision.projectId,
            projectVersionId: decision.projectVersionId,
            schemaVersion: decision.schemaVersion,
            treatmentPlanId: decision.treatmentPlanId,
            storyPlanId: decision.storyPlanId,
            policyId: decision.policyId,
            policyHash: decision.policyHash,
            acceptedUnits: decision.acceptedUnits,
            penalizedUnits: decision.penalizedUnits,
            blockedCount: decision.blockedCount,
            densityUnits: decision.densityUnits,
            treatment: decision.treatment,
            decisionHash: decision.decisionHash,
            evaluatedAt: new Date(decision.evaluatedAt),
            createdAt: new Date(input.createdAt),
          },
        })
        // createMany rather than a nested create: the composite foreign key
        // shares `workspaceId` with the parent, and Prisma refuses to write a
        // column it believes the relation already owns.
        await transaction.v2NoveltyBudgetDecisionLine.createMany({
          data: decision.lines.map((line, sequence) => ({
            id: `${decision.id}-line-${sequence}`,
            workspaceId: decision.workspaceId,
            decisionId: decision.id,
            sequence,
            candidateId: line.candidateId,
            briefId: line.briefId,
            effectGroup: line.group,
            outcome: line.outcome,
            chargedUnits: line.chargedUnits,
            grossUnits: line.grossUnits,
            penaltyUnits: line.penaltyUnits,
            consumedBeforeUnits: line.consumedBeforeUnits,
            remainingUnits: line.remainingUnits,
            densityUnits: line.densityUnits,
            reason: line.reason.slice(0, 300),
            blockedBecause: line.blockedBecause ?? null,
          })),
        })
        return Object.freeze({ decision, replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      // The decision id is derived from its own hash, so a collision means the
      // identical decision is already stored. That is convergence, not conflict.
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.readDecision({
        workspaceId: decision.workspaceId,
        projectId: decision.projectId,
        decisionId: decision.id,
      })
      if (!stored || stored.decisionHash !== decision.decisionHash) {
        throw new DomainError('VERSION_CONFLICT', 'Novelty decision id already exists with a different body')
      }
      return Object.freeze({ decision: stored, replayed: true })
    }
  }

  async readDecision(input: Parameters<NoveltyBudgetRepository['readDecision']>[0]) {
    const row = await this.prisma.v2NoveltyBudgetDecision.findFirst({
      where: { id: input.decisionId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: { lines: true },
    })
    return row ? hydrateDecision(row) : null
  }

  async findBriefVerdict(input: Parameters<NoveltyBudgetRepository['findBriefVerdict']>[0]) {
    const row = await this.prisma.v2NoveltyBudgetDecisionLine.findFirst({
      where: {
        workspaceId: input.workspaceId,
        briefId: input.briefId,
        decision: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
        },
      },
      include: { decision: { select: { id: true, decisionHash: true, policyId: true, evaluatedAt: true } } },
      // Newest decision wins: a re-evaluation after the plan changed is the one
      // that governs, not the first verdict ever recorded for this brief.
      orderBy: [{ decision: { evaluatedAt: 'desc' } }, { sequence: 'asc' }],
    })
    if (!row) return null
    return Object.freeze({
      decisionId: row.decision.id,
      decisionHash: row.decision.decisionHash,
      policyId: row.decision.policyId,
      outcome: row.outcome as 'accepted' | 'penalized' | 'blocked',
      chargedUnits: row.chargedUnits,
      densityUnits: row.densityUnits,
      reason: row.reason,
      ...(row.blockedBecause ? { blockedBecause: row.blockedBecause } : {}),
    })
  }

  async listDecisions(input: Parameters<NoveltyBudgetRepository['listDecisions']>[0]) {
    const rows = await this.prisma.v2NoveltyBudgetDecision.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId },
      include: { lines: true },
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(input.limit ?? 20, 1), 100),
    })
    return Object.freeze(rows.map(hydrateDecision))
  }
}
