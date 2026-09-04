import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import {
  calculateSyntheticPhaseGateRecordHash,
  type SyntheticPhaseGateReport,
} from '../../application/run-synthetic-phase-gate.ts'
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

function hydrateGate(row: GateRow): Readonly<PersistedSyntheticPhaseGate> {
  hydrateExternalActorAudit(row, row.createdById)
  const reportValue = record(parseJson(row.reportJson, 'synthetic phase gate report'))
  if (!reportValue || !Array.isArray(reportValue.evidence)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored synthetic phase gate report is invalid',
    )
  }
  const report = evaluateSyntheticPhaseGate({
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    projectVersionHash: row.projectVersionHash,
    evidence: reportValue.evidence as never,
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

  constructor(
    client: PrismaClient = getV2PostgresClient(),
  ) {
    this.client = client
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
    const [project, actor] = await Promise.all([
      this.client.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        include: { currentVersion: true },
      }),
      this.client.v2ApiClient.findFirst({
        where: {
          id: input.actorId,
          workspaceId: input.workspaceId,
          status: 'active',
        },
      }),
    ])
    if (!project?.currentVersion || !actor) return null

    // An empty set is deliberate until each production evidence projection is
    // implemented. It persists a truthful rejected gate instead of promoting
    // isolated tests or caller-authored claims into phase acceptance.
    return Object.freeze({
      projectVersionId: project.currentVersion.id,
      projectVersionHash: project.currentVersion.baseHash,
      evidence: Object.freeze([]),
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
        const evidence = flattenEvidence(gate.report)
        const row = await transaction.v2SyntheticPhaseGate.create({
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
            evidence: {
              create: evidence.map((item) => ({
                workspaceId: gate.workspaceId,
                ...item,
              })),
            },
          },
          include: { evidence: true },
        })
        return Object.freeze({ gate: hydrateGate(row), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persist(gate, authenticationAudit, attempt + 1)
      }
      if (isPrismaCode(error, 'P2034')) {
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
