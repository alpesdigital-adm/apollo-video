import {
  Prisma,
  type PrismaClient,
  type V2TransformationCriticIssue,
  type V2TransformationCriticMeasurement,
  type V2TransformationCriticReport,
  type V2TransformationFallbackAttempt,
  type V2TransformationFallbackDispatchClaim,
  type V2TransformationFallbackLedger,
} from '../../../../generated/prisma-v2/index.js'

import type { TransformationFallbackDispatchClaim, TransformationQualityRepository } from '../../application/ports/transformation-quality-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertTransformationCriticReport,
  TRANSFORMATION_CRITIC_DIMENSIONS,
  TRANSFORMATION_CRITIC_REPORT_VERSION,
  type TransformationCriticEvaluator,
  type TransformationCriticReport,
} from '../../domain/transformation-critic-report.ts'
import {
  assertTransformationFallbackLedger,
  TRANSFORMATION_FALLBACK_LEDGER_VERSION,
  type TransformationFallbackLedger,
} from '../../domain/transformation-fallback.ts'
import type { TransformationFallback, TransformationPreserve } from '../../domain/transformation-brief.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

type FallbackRow = V2TransformationFallbackLedger & { attempts: V2TransformationFallbackAttempt[] }
type CriticRow = V2TransformationCriticReport & {
  measurements: V2TransformationCriticMeasurement[]
  issues: V2TransformationCriticIssue[]
}

const FALLBACK_INCLUDE = { attempts: true } as const
const CRITIC_INCLUDE = { measurements: true, issues: true } as const

function conflict(message: string): never {
  throw new DomainError('PERSISTENCE_CONFLICT', message)
}

function parsed<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return conflict(`Stored ${field} JSON is invalid`)
  }
}

function hydrateFallback(row: FallbackRow): Readonly<TransformationFallbackLedger> {
  const ladder = parsed<TransformationFallback[]>(row.ladderJson, 'fallback ladder')
  const attempts = [...row.attempts]
    .sort((left, right) => left.sequence - right.sequence)
    .map((attempt) => Object.freeze({
      sequence: attempt.sequence,
      rung: attempt.rung as TransformationFallback,
      ...(attempt.providerJobId ? { providerJobId: attempt.providerJobId } : {}),
      ...(attempt.providerId ? { providerId: attempt.providerId } : {}),
      ...(attempt.artifactId ? { artifactId: attempt.artifactId } : {}),
      ...(attempt.artifactSha256 ? { artifactSha256: attempt.artifactSha256 } : {}),
      outcome: attempt.outcome as TransformationFallbackLedger['attempts'][number]['outcome'],
      intentScoreBps: attempt.intentScoreBps,
      ...(attempt.criticReportHash ? { criticReportHash: attempt.criticReportHash } : {}),
      violatesProtectedContent: attempt.violatesProtectedContent,
      estimatedCostMinorUnits: attempt.estimatedCostMinorUnits,
      observedCostMinorUnits: attempt.observedCostMinorUnits,
      costCurrency: attempt.costCurrency,
      reason: attempt.reason,
      ...(attempt.descendedBecause
        ? { descendedBecause: attempt.descendedBecause as TransformationFallbackLedger['attempts'][number]['descendedBecause'] }
        : {}),
    }))
  const ledger = Object.freeze({
    schemaVersion: TRANSFORMATION_FALLBACK_LEDGER_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    briefId: row.briefId,
    briefHash: row.briefHash,
    ladder: Object.freeze(ladder),
    attempts: Object.freeze(attempts),
    currentRung: row.currentRung as TransformationFallback,
    bestArtifactId: row.bestArtifactId,
    bestArtifactSha256: row.bestArtifactSha256,
    bestIntentScoreBps: row.bestIntentScoreBps,
    incurredCostMinorUnits: row.incurredCostMinorUnits,
    costCurrency: row.costCurrency,
    reviewDecision: row.reviewDecision as TransformationFallbackLedger['reviewDecision'],
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ledgerHash: row.ledgerHash,
  })
  if (stableSerialize(ladder) !== row.ladderJson) conflict('Stored fallback ladder is not canonical')
  return assertTransformationFallbackLedger(ledger)
}

function hydrateCritic(row: CriticRow): Readonly<TransformationCriticReport> {
  const evaluators = parsed<TransformationCriticEvaluator[]>(row.evaluatorsJson, 'transformation critic evaluators')
  const measurementByDimension = new Map(row.measurements.map((measurement) => [measurement.dimension, measurement]))
  const measurements = TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) => {
    const measurement = measurementByDimension.get(dimension)
    if (!measurement) return conflict(`Stored transformation critic measurement ${dimension} is missing`)
    return Object.freeze({
      dimension: measurement.dimension as TransformationCriticReport['measurements'][number]['dimension'],
      status: measurement.status as TransformationCriticReport['measurements'][number]['status'],
      ...(measurement.evaluatorId ? { evaluatorId: measurement.evaluatorId } : {}),
      scoreBps: measurement.scoreBps,
      thresholdBps: measurement.thresholdBps,
      frameRange: measurement.startFrame !== null && measurement.endFrame !== null
        ? Object.freeze({ startFrame: measurement.startFrame, endFrame: measurement.endFrame })
        : null,
      region: measurement.regionJson
        ? Object.freeze(parsed<NonNullable<TransformationCriticReport['measurements'][number]['region']>>(measurement.regionJson, 'transformation critic measurement region'))
        : null,
      ...(measurement.note ? { note: measurement.note } : {}),
    })
  })
  const issues = [...row.issues]
    .sort((left, right) => left.sequence - right.sequence)
    .map((issue) => Object.freeze({
      dimension: issue.dimension as TransformationCriticReport['issues'][number]['dimension'],
      severity: issue.severity as TransformationCriticReport['issues'][number]['severity'],
      frameRange: Object.freeze({ startFrame: issue.startFrame, endFrame: issue.endFrame }),
      region: issue.regionJson
        ? Object.freeze(parsed<NonNullable<TransformationCriticReport['issues'][number]['region']>>(issue.regionJson, 'transformation critic issue region'))
        : null,
      ...(issue.violatedPreserve ? { violatedPreserve: issue.violatedPreserve as TransformationPreserve } : {}),
      description: issue.description,
    }))
  const hardGates = parsed<TransformationCriticReport['hardGates']>(row.hardGatesJson, 'transformation critic hard gates')
  const report = Object.freeze({
    schemaVersion: TRANSFORMATION_CRITIC_REPORT_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    briefId: row.briefId,
    briefHash: row.briefHash,
    providerJobId: row.providerJobId,
    policyId: row.policyId,
    policyHash: row.policyHash,
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    resultArtifactId: row.resultArtifactId,
    resultArtifactSha256: row.resultArtifactSha256,
    evaluators: Object.freeze(evaluators),
    measurements: Object.freeze(measurements),
    issues: Object.freeze(issues),
    hardGates: Object.freeze([...hardGates]),
    decision: row.decision as TransformationCriticReport['decision'],
    action: row.action as TransformationCriticReport['action'],
    confidenceBps: row.confidenceBps,
    intentScoreBps: row.intentScoreBps,
    evaluatedAt: row.evaluatedAt.toISOString(),
    reportHash: row.reportHash,
  })
  if (stableSerialize(evaluators) !== row.evaluatorsJson || stableSerialize(hardGates) !== row.hardGatesJson) {
    conflict('Stored transformation critic JSON projections are not canonical')
  }
  return assertTransformationCriticReport(report)
}

function isUnique(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function hydrateDispatchClaim(row: V2TransformationFallbackDispatchClaim): Readonly<TransformationFallbackDispatchClaim> {
  if (row.rung !== 'generated-cutaway' || !['pending', 'enqueued', 'skipped'].includes(row.outcome)) {
    return conflict('Stored fallback dispatch claim has an unsupported state')
  }
  if ((row.outcome === 'pending') !== (row.settledAt === null)) conflict('Stored fallback dispatch claim settlement is inconsistent')
  if (row.outcome === 'enqueued' && !row.providerJobId) conflict('Stored fallback dispatch claim has no provider job')
  if (row.outcome === 'skipped' && (!row.resultLedgerId || !row.resultLedgerHash || !row.reason)) conflict('Stored fallback skip claim is incomplete')
  return Object.freeze({
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId,
    requestedLedgerId: row.requestedLedgerId, requestedLedgerHash: row.requestedLedgerHash,
    briefId: row.briefId, dispatchRequestHash: row.dispatchRequestHash,
    authenticationAudit: hydrateExternalActorAudit(row, row.actorClientId), rung: row.rung,
    outcome: row.outcome as TransformationFallbackDispatchClaim['outcome'],
    providerJobId: row.providerJobId, resultLedgerId: row.resultLedgerId,
    resultLedgerHash: row.resultLedgerHash, reason: row.reason,
  })
}

export class PrismaTransformationQualityRepository implements TransformationQualityRepository {
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient = getV2PostgresClient()) {
    this.prisma = prisma
  }

  async readFallbackDispatchRequest(input: Parameters<TransformationQualityRepository['readFallbackDispatchRequest']>[0]) {
    const row = await this.prisma.v2TransformationFallbackDispatchRequest.findFirst({
      where: { workspaceId: input.workspaceId, actorClientId: input.actorClientId, idempotencyKey: input.idempotencyKey },
      include: { claim: true },
    })
    if (!row) return null
    return Object.freeze({
      requestFingerprint: row.requestFingerprint,
      authenticationAudit: hydrateExternalActorAudit(row, row.actorClientId),
      claim: hydrateDispatchClaim(row.claim),
    })
  }

  async claimFallbackDispatch(input: Parameters<TransformationQualityRepository['claimFallbackDispatch']>[0]) {
    const auditData = externalActorAuditData(input.authenticationAudit, input.workspaceId, input.authenticationAudit.clientId)
    const execute = (isolationLevel: Prisma.TransactionIsolationLevel) => this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:fallback-public-key:${input.authenticationAudit.clientId}:${input.idempotencyKey}`}, 0))::text AS "lock"
      `)
      const existingRequest = await transaction.v2TransformationFallbackDispatchRequest.findFirst({
        where: { workspaceId: input.workspaceId, actorClientId: input.authenticationAudit.clientId, idempotencyKey: input.idempotencyKey },
        include: { claim: true },
      })
      if (existingRequest) {
        const storedAudit = hydrateExternalActorAudit(existingRequest, existingRequest.actorClientId)
        if (existingRequest.requestFingerprint !== input.requestFingerprint || storedAudit.contextHash !== input.authenticationAudit.contextHash) {
          throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Fallback dispatch idempotency key was already used for a different request')
        }
        return Object.freeze({ claim: hydrateDispatchClaim(existingRequest.claim), requestReplayed: true })
      }
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:fallback-claim:${input.projectId}:${input.ledgerId}:${input.rung}`}, 0))::text AS "lock"
      `)
      let claim = await transaction.v2TransformationFallbackDispatchClaim.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, requestedLedgerId: input.ledgerId, rung: input.rung },
      })
      if (!claim) claim = await transaction.v2TransformationFallbackDispatchClaim.create({ data: {
        id: input.claimId, workspaceId: input.workspaceId, projectId: input.projectId,
        actorClientId: input.authenticationAudit.clientId, ...auditData,
        dispatchRequestHash: input.requestFingerprint,
        requestedLedgerId: input.ledgerId, requestedLedgerHash: input.ledgerHash,
        briefId: input.briefId, rung: input.rung, outcome: 'pending',
        createdAt: new Date(input.createdAt),
      } })
      if (
        claim.requestedLedgerHash !== input.ledgerHash || claim.briefId !== input.briefId ||
        claim.dispatchRequestHash !== input.requestFingerprint || claim.actorContextHash !== input.authenticationAudit.contextHash
      ) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Fallback dispatch rung was already claimed with a different request context')
      }
      await transaction.v2TransformationFallbackDispatchRequest.create({ data: {
        id: input.requestId, workspaceId: input.workspaceId, projectId: input.projectId,
        actorClientId: input.authenticationAudit.clientId, ...auditData,
        idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint,
        claimId: claim.id, createdAt: new Date(input.createdAt),
      } })
      return Object.freeze({ claim: hydrateDispatchClaim(claim), requestReplayed: false })
    }, { isolationLevel })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await execute(Prisma.TransactionIsolationLevel.Serializable) } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !['P2002', 'P2034'].includes(error.code)) throw error
      }
    }
    try {
      return await execute(Prisma.TransactionIsolationLevel.ReadCommitted)
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !['P2002', 'P2034'].includes(error.code)) throw error
      const winner = await this.readFallbackDispatchRequest({ workspaceId: input.workspaceId, actorClientId: input.authenticationAudit.clientId, idempotencyKey: input.idempotencyKey })
      if (!winner) throw new DomainError('PERSISTENCE_CONFLICT', 'Fallback dispatch claim did not converge')
      if (winner.requestFingerprint !== input.requestFingerprint || winner.authenticationAudit.contextHash !== input.authenticationAudit.contextHash) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Fallback dispatch idempotency key was already used for a different request')
      }
      return Object.freeze({ claim: winner.claim, requestReplayed: true })
    }
  }

  async settleFallbackDispatch(input: Parameters<TransformationQualityRepository['settleFallbackDispatch']>[0]) {
    const validateEffect = async (
      transaction: Prisma.TransactionClient,
      current: V2TransformationFallbackDispatchClaim,
    ) => {
      if (input.outcome === 'enqueued') {
        const job = input.providerJobId ? await transaction.v2ProviderJob.findFirst({
          where: { id: input.providerJobId, workspaceId: input.workspaceId, projectId: input.projectId },
          select: { fallbackLedgerId: true, fallbackLedgerHash: true, fallbackRung: true, fallbackDispatchRequestHash: true },
        }) : null
        if (
          !job || job.fallbackLedgerId !== current.requestedLedgerId ||
          job.fallbackLedgerHash !== current.requestedLedgerHash || job.fallbackRung !== current.rung ||
          job.fallbackDispatchRequestHash !== current.dispatchRequestHash
        ) conflict('Fallback dispatch provider job does not match its claim')
        return
      }
      const attempt = input.resultLedgerId ? await transaction.v2TransformationFallbackAttempt.findFirst({
        where: {
          workspaceId: input.workspaceId, ledgerId: input.resultLedgerId, rung: current.rung,
          dispatchRequestHash: current.dispatchRequestHash, actorContextHash: current.actorContextHash,
        },
        select: { id: true },
      }) : null
      if (!attempt || !input.resultLedgerHash) conflict('Fallback skip ledger does not match its claim')
      const ledger = await transaction.v2TransformationFallbackLedger.findFirst({
        where: { id: input.resultLedgerId!, workspaceId: input.workspaceId, projectId: input.projectId, ledgerHash: input.resultLedgerHash },
        select: { id: true },
      })
      if (!ledger) conflict('Fallback skip result ledger is missing')
    }
    const execute = () => this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:fallback-claim-id:${input.claimId}`}, 0))::text AS "lock"
      `)
      const current = await transaction.v2TransformationFallbackDispatchClaim.findFirst({
        where: { id: input.claimId, workspaceId: input.workspaceId, projectId: input.projectId },
      })
      if (!current || current.requestedLedgerId !== input.expectedLedgerId) conflict('Fallback dispatch claim is missing or belongs to another ledger')
      await validateEffect(transaction, current)
      if (current.outcome !== 'pending') {
        const replay = hydrateDispatchClaim(current)
        if (
          replay.outcome !== input.outcome || replay.providerJobId !== (input.providerJobId ?? null) ||
          replay.resultLedgerId !== (input.resultLedgerId ?? null) || replay.resultLedgerHash !== (input.resultLedgerHash ?? null) ||
          replay.reason !== (input.reason ?? null)
        ) conflict('Fallback dispatch claim was settled with a different effect')
        return replay
      }
      const updated = await transaction.v2TransformationFallbackDispatchClaim.update({
        where: { id: current.id },
        data: {
          outcome: input.outcome, providerJobId: input.providerJobId ?? null,
          resultLedgerId: input.resultLedgerId ?? null, resultLedgerHash: input.resultLedgerHash ?? null,
          reason: input.reason ?? null, settledAt: new Date(input.settledAt),
        },
      })
      return hydrateDispatchClaim(updated)
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await execute() } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034') throw error
      }
    }
    const winner = await this.prisma.v2TransformationFallbackDispatchClaim.findFirst({
      where: { id: input.claimId, workspaceId: input.workspaceId, projectId: input.projectId },
    })
    if (!winner || winner.requestedLedgerId !== input.expectedLedgerId) throw new DomainError('PERSISTENCE_CONFLICT', 'Fallback dispatch settlement did not converge')
    const hydrated = hydrateDispatchClaim(winner)
    if (
      hydrated.outcome !== input.outcome || hydrated.providerJobId !== (input.providerJobId ?? null) ||
      hydrated.resultLedgerId !== (input.resultLedgerId ?? null) || hydrated.resultLedgerHash !== (input.resultLedgerHash ?? null) ||
      hydrated.reason !== (input.reason ?? null)
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Fallback dispatch settlement converged to a different effect')
    await this.prisma.$transaction(
      (transaction) => validateEffect(transaction, winner),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    )
    return hydrated
  }

  async recordFallbackLedger(input: Parameters<TransformationQualityRepository['recordFallbackLedger']>[0]) {
    const ledger = assertTransformationFallbackLedger(input.ledger)
    if (ledger.attempts.some((attempt) => attempt.reason.length > 300)) {
      conflict('Fallback attempt reason exceeds its durable storage contract')
    }
    try {
      const replayed = await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${ledger.workspaceId}:transformation-fallback:${ledger.projectId}:${ledger.briefId}`}, 0)
          )::text AS "lock"
        `)
        const existing = await transaction.v2TransformationFallbackLedger.findFirst({
          where: { id: ledger.id, workspaceId: ledger.workspaceId, projectId: ledger.projectId },
          include: FALLBACK_INCLUDE,
        })
        if (existing) {
          const hydrated = hydrateFallback(existing)
          if (hydrated.ledgerHash !== ledger.ledgerHash) conflict('Fallback ledger identity already exists with a different body')
          if (input.dispatch) {
            const dispatch = existing.attempts.find((attempt) => attempt.sequence === input.dispatch!.attemptSequence)
            if (!dispatch?.dispatchRequestHash || !dispatch.actorClientId) conflict('Fallback dispatch replay has no durable request audit')
            const audit = hydrateExternalActorAudit(dispatch, dispatch.actorClientId)
            if (dispatch.dispatchRequestHash !== input.dispatch.requestHash || audit.contextHash !== input.dispatch.authenticationAudit.contextHash) {
              throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Fallback dispatch replay has a different request context')
            }
          }
          return true
        }
        const latest = await transaction.v2TransformationFallbackLedger.findFirst({
          where: { workspaceId: ledger.workspaceId, projectId: ledger.projectId, briefId: ledger.briefId },
          select: { ledgerHash: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        })
        if ((latest?.ledgerHash ?? null) !== input.previousLedgerHash) {
          throw new DomainError('VERSION_CONFLICT', 'Transformation fallback ledger has a newer revision')
        }
        await transaction.v2TransformationFallbackLedger.create({ data: {
          id: ledger.id, workspaceId: ledger.workspaceId, projectId: ledger.projectId,
          projectVersionId: ledger.projectVersionId, schemaVersion: ledger.schemaVersion,
          briefId: ledger.briefId, briefHash: ledger.briefHash,
          ladderJson: stableSerialize([...ledger.ladder]), currentRung: ledger.currentRung,
          bestArtifactId: ledger.bestArtifactId, bestArtifactSha256: ledger.bestArtifactSha256,
          bestIntentScoreBps: ledger.bestIntentScoreBps,
          incurredCostMinorUnits: ledger.incurredCostMinorUnits, costCurrency: ledger.costCurrency,
          reviewDecision: ledger.reviewDecision, sourceArtifactId: ledger.sourceArtifactId,
          sourceArtifactSha256: ledger.sourceArtifactSha256, ledgerHash: ledger.ledgerHash,
          createdAt: new Date(ledger.createdAt), updatedAt: new Date(ledger.updatedAt),
        } })
        if (ledger.attempts.length > 0) await transaction.v2TransformationFallbackAttempt.createMany({
          data: ledger.attempts.map((attempt) => ({
            id: `fallback-attempt-${ledger.ledgerHash.slice(0, 24)}-${attempt.sequence}`,
            workspaceId: ledger.workspaceId, ledgerId: ledger.id, sequence: attempt.sequence,
            rung: attempt.rung, providerJobId: attempt.providerJobId ?? null,
            providerId: attempt.providerId ?? null, artifactId: attempt.artifactId ?? null,
            artifactSha256: attempt.artifactSha256 ?? null, outcome: attempt.outcome,
            intentScoreBps: attempt.intentScoreBps, criticReportHash: attempt.criticReportHash ?? null,
            violatesProtectedContent: attempt.violatesProtectedContent,
            estimatedCostMinorUnits: attempt.estimatedCostMinorUnits,
            observedCostMinorUnits: attempt.observedCostMinorUnits,
            costCurrency: attempt.costCurrency, reason: attempt.reason,
            descendedBecause: attempt.descendedBecause ?? null,
            ...(input.dispatch?.attemptSequence === attempt.sequence ? {
              dispatchRequestHash: input.dispatch.requestHash,
              actorClientId: input.dispatch.authenticationAudit.clientId,
              ...externalActorAuditData(input.dispatch.authenticationAudit, ledger.workspaceId, input.dispatch.authenticationAudit.clientId),
            } : {}),
          })),
        })
        return false
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      if (replayed) {
        const stored = await this.readFallbackLedger({ workspaceId: ledger.workspaceId, projectId: ledger.projectId, ledgerId: ledger.id })
        if (!stored) conflict('Fallback ledger replay disappeared')
        return Object.freeze({ ledger: stored, replayed: true })
      }
      return Object.freeze({ ledger, replayed: false })
    } catch (error) {
      if (!isUnique(error)) throw error
      const stored = await this.readFallbackLedger({ workspaceId: ledger.workspaceId, projectId: ledger.projectId, ledgerId: ledger.id })
      if (!stored || stored.ledgerHash !== ledger.ledgerHash) conflict('Fallback ledger identity already exists with a different body')
      return Object.freeze({ ledger: stored, replayed: true })
    }
  }

  async readFallbackLedger(input: Parameters<TransformationQualityRepository['readFallbackLedger']>[0]) {
    const row = await this.prisma.v2TransformationFallbackLedger.findFirst({
      where: { id: input.ledgerId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: FALLBACK_INCLUDE,
    })
    return row ? hydrateFallback(row) : null
  }

  async readLatestFallbackLedger(input: Parameters<TransformationQualityRepository['readLatestFallbackLedger']>[0]) {
    const row = await this.prisma.v2TransformationFallbackLedger.findFirst({
      where: input, include: FALLBACK_INCLUDE, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    })
    return row ? hydrateFallback(row) : null
  }

  async findFallbackDispatchAttempt(input: Parameters<NonNullable<TransformationQualityRepository['findFallbackDispatchAttempt']>>[0]) {
    const row = await this.prisma.v2TransformationFallbackAttempt.findFirst({
      where: {
        workspaceId: input.workspaceId,
        rung: input.rung,
        dispatchRequestHash: { not: null },
        ledger: { projectId: input.projectId, briefId: input.briefId },
      },
      include: { ledger: { include: FALLBACK_INCLUDE } },
      orderBy: [{ ledger: { updatedAt: 'desc' } }, { sequence: 'desc' }],
    })
    if (!row?.dispatchRequestHash || !row.actorClientId) return null
    return Object.freeze({
      ledger: hydrateFallback(row.ledger),
      requestHash: row.dispatchRequestHash,
      authenticationAudit: hydrateExternalActorAudit(row, row.actorClientId),
    })
  }

  async listFallbackLedgers(input: Parameters<TransformationQualityRepository['listFallbackLedgers']>[0]) {
    const rows = await this.prisma.v2TransformationFallbackLedger.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId }, include: FALLBACK_INCLUDE,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: Math.min(Math.max(input.limit ?? 20, 1), 100),
    })
    return Object.freeze(rows.map(hydrateFallback))
  }

  async recordCriticReport(input: Parameters<TransformationQualityRepository['recordCriticReport']>[0]) {
    const report = assertTransformationCriticReport(input.report)
    if (report.issues.some((issue) => issue.description.length > 500)) {
      conflict('Transformation critic issue description exceeds its durable storage contract')
    }
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.v2TransformationCriticReport.create({ data: {
          id: report.id, workspaceId: report.workspaceId, projectId: report.projectId,
          schemaVersion: report.schemaVersion, briefId: report.briefId, briefHash: report.briefHash,
          providerJobId: report.providerJobId, policyId: report.policyId, policyHash: report.policyHash,
          sourceArtifactId: report.sourceArtifactId, sourceArtifactSha256: report.sourceArtifactSha256,
          resultArtifactId: report.resultArtifactId, resultArtifactSha256: report.resultArtifactSha256,
          evaluatorsJson: stableSerialize([...report.evaluators]), hardGatesJson: stableSerialize([...report.hardGates]),
          hardGateCount: report.hardGates.length, decision: report.decision, action: report.action,
          confidenceBps: report.confidenceBps, intentScoreBps: report.intentScoreBps,
          reportHash: report.reportHash, evaluatedAt: new Date(report.evaluatedAt), createdAt: new Date(report.evaluatedAt),
        } })
        await transaction.v2TransformationCriticMeasurement.createMany({ data: report.measurements.map((measurement) => ({
          id: `transformation-measurement-${report.reportHash.slice(0, 20)}-${measurement.dimension}`,
          workspaceId: report.workspaceId, reportId: report.id, dimension: measurement.dimension,
          status: measurement.status, evaluatorId: measurement.evaluatorId ?? null,
          scoreBps: measurement.scoreBps, thresholdBps: measurement.thresholdBps,
          startFrame: measurement.frameRange?.startFrame ?? null, endFrame: measurement.frameRange?.endFrame ?? null,
          regionJson: measurement.region ? stableSerialize(measurement.region) : null, note: measurement.note ?? null,
        })) })
        if (report.issues.length > 0) await transaction.v2TransformationCriticIssue.createMany({ data: report.issues.map((issue, sequence) => ({
          id: `transformation-issue-${report.reportHash.slice(0, 24)}-${sequence}`,
          workspaceId: report.workspaceId, reportId: report.id, sequence,
          dimension: issue.dimension, severity: issue.severity,
          startFrame: issue.frameRange.startFrame, endFrame: issue.frameRange.endFrame,
          regionJson: issue.region ? stableSerialize(issue.region) : null,
          violatedPreserve: issue.violatedPreserve ?? null, description: issue.description,
        })) })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return Object.freeze({ report, replayed: false })
    } catch (error) {
      if (!isUnique(error)) throw error
      const stored = await this.readCriticReport({ workspaceId: report.workspaceId, projectId: report.projectId, reportId: report.id })
      if (!stored || stored.reportHash !== report.reportHash) conflict('Transformation critic report identity already exists with a different body')
      return Object.freeze({ report: stored, replayed: true })
    }
  }

  async readCriticReport(input: Parameters<TransformationQualityRepository['readCriticReport']>[0]) {
    const row = await this.prisma.v2TransformationCriticReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: CRITIC_INCLUDE,
    })
    return row ? hydrateCritic(row) : null
  }

  async readCriticReportByJob(input: Parameters<TransformationQualityRepository['readCriticReportByJob']>[0]) {
    const row = await this.prisma.v2TransformationCriticReport.findFirst({
      where: input, include: CRITIC_INCLUDE, orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
    })
    return row ? hydrateCritic(row) : null
  }

  async listCriticReports(input: Parameters<TransformationQualityRepository['listCriticReports']>[0]) {
    const rows = await this.prisma.v2TransformationCriticReport.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId }, include: CRITIC_INCLUDE,
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }], take: Math.min(Math.max(input.limit ?? 20, 1), 100),
    })
    return Object.freeze(rows.map(hydrateCritic))
  }
}
