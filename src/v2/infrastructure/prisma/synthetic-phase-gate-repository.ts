import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import {
  calculateSyntheticPhaseGateRecordHash,
  type SyntheticPhaseGateReport,
} from '../../application/run-synthetic-phase-gate.ts'
import { collectSyntheticPhaseGateEvidence } from '../../application/collect-synthetic-phase-gate-evidence.ts'
import type {
  PersistedSyntheticPhaseGate,
  SyntheticPhaseGateEvidenceQuery,
  SyntheticPhaseGateRepository,
} from '../../application/ports/synthetic-phase-gate-repository.ts'
import {
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  evaluateSyntheticPhaseGate,
} from '../../domain/synthetic-phase-gate.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
} from './external-actor-audit.ts'
import { PrismaSyntheticPhaseGateEvidenceReader } from './synthetic-phase-gate-evidence-reader.ts'

interface TransactionalSyntheticPhaseGateEvidenceReader {
  read(input: Readonly<SyntheticPhaseGateEvidenceQuery>): ReturnType<PrismaSyntheticPhaseGateEvidenceReader['read']>
  readWithClient(
    client: Prisma.TransactionClient,
    input: Readonly<SyntheticPhaseGateEvidenceQuery>,
  ): ReturnType<PrismaSyntheticPhaseGateEvidenceReader['readWithClient']>
}

type GateRow = Prisma.V2SyntheticPhaseGateGetPayload<{
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

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid JSON`,
    )
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function flattenEvidence(report: Readonly<SyntheticPhaseGateReport>) {
  return report.evidence.flatMap((criterion) =>
    criterion.checks.flatMap((check) =>
      check.references.map((reference, ordinal) => ({
        criterion: criterion.criterion,
        checkCode: check.code,
        passed: check.passed,
        evidenceType: reference.type,
        resourceId: reference.id,
        resourceHash: reference.hash,
        ordinal,
      }))))
}

function reportEvidenceInput(value: unknown) {
  if (!Array.isArray(value)) return null
  return value.map((criterion) => {
    const item = record(criterion)
    if (!item || !Array.isArray(item.checks)) return criterion
    return {
      criterion: item.criterion,
      checks: item.checks.flatMap((check) => {
        const candidate = record(check)
        if (!candidate || !Array.isArray(candidate.references)) return [check]
        // The evaluator expands an omitted check into a normalized fail-closed
        // row with no references. That normalized row is report output, not a
        // valid caller/collector input, so omit only that exact representation
        // before replaying the evaluator. The full report is compared below.
        if (candidate.references.length === 0) return []
        return [{
          code: candidate.code,
          passed: candidate.passed,
          references: candidate.references,
        }]
      }),
    }
  })
}

function hydrateGate(row: GateRow): Readonly<PersistedSyntheticPhaseGate> {
  hydrateExternalActorAudit(row, row.createdById)
  const reportValue = record(parseJson(row.reportJson, 'synthetic phase gate report'))
  if (!reportValue || !Array.isArray(reportValue.evidence)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored synthetic phase gate report is invalid',
    )
  }
  const evidenceInput = reportEvidenceInput(reportValue.evidence)
  if (!evidenceInput) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored synthetic phase gate evidence is invalid',
    )
  }
  const report = evaluateSyntheticPhaseGate({
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    projectVersionHash: row.projectVersionHash,
    evidence: evidenceInput as never,
    evaluatedAt: String(reportValue.evaluatedAt),
  })
  if (
    stableSerialize(report) !== row.reportJson ||
    report.fingerprint !== row.reportFingerprint ||
    report.approved !== row.approved ||
    report.covered !== row.covered ||
    report.passed !== row.passed ||
    report.total !== row.total ||
    row.schemaVersion !== 'synthetic-phase-gate/v1' ||
    row.createdByType !== 'api-client'
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored synthetic phase gate report failed integrity validation',
    )
  }
  const expectedEvidence = flattenEvidence(report)
  const storedEvidence = [...row.evidence]
    .sort((left, right) =>
      left.criterion.localeCompare(right.criterion) ||
      left.checkCode.localeCompare(right.checkCode) ||
      left.ordinal - right.ordinal)
    .map(({ criterion, checkCode, passed, evidenceType, resourceId, resourceHash, ordinal }) => ({
      criterion,
      checkCode,
      passed,
      evidenceType,
      resourceId,
      resourceHash,
      ordinal,
    }))
  const sortedExpected = [...expectedEvidence].sort((left, right) =>
    left.criterion.localeCompare(right.criterion) ||
    left.checkCode.localeCompare(right.checkCode) ||
    left.ordinal - right.ordinal)
  if (stableSerialize(storedEvidence) !== stableSerialize(sortedExpected)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored synthetic phase gate evidence rows do not match the report',
    )
  }

  const content = Object.freeze({
    schemaVersion: 'synthetic-phase-gate/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    projectVersionHash: row.projectVersionHash,
    report,
    reportFingerprint: row.reportFingerprint,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  if (calculateSyntheticPhaseGateRecordHash(content) !== row.recordHash) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored synthetic phase gate record hash is inconsistent',
    )
  }
  return Object.freeze({ ...content, recordHash: row.recordHash })
}

export class PrismaSyntheticPhaseGateRepository
implements SyntheticPhaseGateRepository {
  private readonly client: PrismaClient
  private readonly evidenceReader: TransactionalSyntheticPhaseGateEvidenceReader

  constructor(
    client: PrismaClient = getV2PostgresClient(),
    evidenceReader: TransactionalSyntheticPhaseGateEvidenceReader =
      new PrismaSyntheticPhaseGateEvidenceReader(client),
  ) {
    this.client = client
    this.evidenceReader = evidenceReader
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.client.v2SyntheticPhaseGate.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        actorContextHash: input.actorContextHash,
      },
      include: { evidence: true },
    })
    return row ? hydrateGate(row) : null
  }

  async readEvidence(input: Readonly<SyntheticPhaseGateEvidenceQuery>) {
    const sources = await this.evidenceReader.read(input)
    if (!sources) return null
    return Object.freeze({
      projectVersionId: sources.projectVersionId,
      projectVersionHash: sources.projectVersionHash,
      evidence: collectSyntheticPhaseGateEvidence(sources),
    })
  }

  async persist(
    gate: Readonly<PersistedSyntheticPhaseGate>,
    authenticationAudit: Parameters<SyntheticPhaseGateRepository['persist']>[1],
    attempt = 1,
  ): ReturnType<SyntheticPhaseGateRepository['persist']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2SyntheticPhaseGate.findFirst({
          where: {
            workspaceId: gate.workspaceId,
            projectId: gate.projectId,
            idempotencyKey: gate.idempotencyKey,
            actorContextHash: authenticationAudit.contextHash,
          },
          include: { evidence: true },
        })
        if (existing) {
          if (existing.requestFingerprint !== gate.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different synthetic phase gate request',
            )
          }
          return Object.freeze({ gate: hydrateGate(existing), replayed: true })
        }

        const [project, actor] = await Promise.all([
          transaction.v2Project.findFirst({
            where: { id: gate.projectId, workspaceId: gate.workspaceId },
            include: { currentVersion: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: gate.createdBy.id,
              workspaceId: gate.workspaceId,
              status: 'active',
            },
          }),
        ])
        if (!project?.currentVersion || !actor) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Synthetic phase gate commit context is no longer available',
          )
        }
        if (
          project.currentVersion.id !== gate.projectVersionId ||
          project.currentVersion.baseHash !== gate.projectVersionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Synthetic phase gate project version changed before commit',
          )
        }
        const currentSources = await this.evidenceReader.readWithClient(
          transaction,
          {
            workspaceId: gate.workspaceId,
            projectId: gate.projectId,
            projectVersionId: gate.projectVersionId,
            projectVersionHash: gate.projectVersionHash,
            authenticationAudit,
          },
        )
        if (!currentSources) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Synthetic phase gate evidence disappeared before commit',
          )
        }
        const currentReport = evaluateSyntheticPhaseGate({
          workspaceId: gate.workspaceId,
          projectId: gate.projectId,
          projectVersionId: currentSources.projectVersionId,
          projectVersionHash: currentSources.projectVersionHash,
          evidence: collectSyntheticPhaseGateEvidence(currentSources),
          evaluatedAt: gate.report.evaluatedAt,
        })
        if (stableSerialize(currentReport) !== stableSerialize(gate.report)) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Synthetic phase gate evidence changed before commit',
          )
        }
        const evidence = flattenEvidence(gate.report)
        await transaction.v2SyntheticPhaseGate.create({
          data: {
            id: gate.id,
            workspaceId: gate.workspaceId,
            projectId: gate.projectId,
            projectVersionId: gate.projectVersionId,
            projectVersionHash: gate.projectVersionHash,
            schemaVersion: gate.schemaVersion,
            approved: gate.report.approved,
            covered: gate.report.covered,
            passed: gate.report.passed,
            total: gate.report.total,
            reportJson: stableSerialize(gate.report),
            reportFingerprint: gate.reportFingerprint,
            recordHash: gate.recordHash,
            idempotencyKey: gate.idempotencyKey,
            requestFingerprint: gate.requestFingerprint,
            createdByType: gate.createdBy.type,
            createdById: gate.createdBy.id,
            ...externalActorAuditData(
              authenticationAudit,
              gate.workspaceId,
              gate.createdBy.id,
            ),
            createdAt: new Date(gate.createdAt),
          },
        })
        if (evidence.length > 0) {
          await transaction.v2SyntheticPhaseGateEvidence.createMany({
            data: evidence.map((item) => ({
              gateId: gate.id,
              workspaceId: gate.workspaceId,
              ...item,
            })),
          })
        }
        const row = await transaction.v2SyntheticPhaseGate.findUnique({
          where: { id: gate.id },
          include: { evidence: true },
        })
        if (!row) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Synthetic phase gate disappeared during commit',
          )
        }
        return Object.freeze({ gate: hydrateGate(row), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persist(gate, authenticationAudit, attempt + 1)
      }
      if (isPrismaCode(error, 'P2034')) {
        const replay = await this.findIdempotent({
          workspaceId: gate.workspaceId,
          projectId: gate.projectId,
          idempotencyKey: gate.idempotencyKey,
          actorContextHash: authenticationAudit.contextHash,
        })
        if (replay) {
          if (replay.requestFingerprint !== gate.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different synthetic phase gate request',
            )
          }
          return Object.freeze({ gate: replay, replayed: true })
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Synthetic phase gate conflicted with another transaction',
        )
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: gate.workspaceId,
          projectId: gate.projectId,
          idempotencyKey: gate.idempotencyKey,
          actorContextHash: authenticationAudit.contextHash,
        })
        if (replay) {
          if (replay.requestFingerprint !== gate.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different synthetic phase gate request',
            )
          }
          return Object.freeze({ gate: replay, replayed: true })
        }
      }
      throw error
    }
  }

  async list(input: {
    workspaceId: string
    projectId: string
    limit: number
  }) {
    const rows = await this.client.v2SyntheticPhaseGate.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId },
      include: { evidence: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrateGate))
  }
}
