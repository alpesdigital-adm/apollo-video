import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import type {
  ContaminationReportCreateRecord,
  ContaminationReportPage,
  ContaminationReportReplay,
  ContaminationReportRepository,
} from '../../application/ports/contamination-report-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import {
  CONTAMINATION_POLICY_VERSION,
  CONTAMINATION_REPORT_SCHEMA_VERSION,
  hydrateContaminationReport,
  type ContaminationReport,
  type NormalizedRegion,
} from '../../domain/contamination-report.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  hydrateSourceDeconstructionRow,
} from './source-deconstruction-repository.ts'

const SOURCE_INCLUDE = {
  segments: {
    orderBy: [
      { startMs: 'asc' as const },
      { sourceSegmentId: 'asc' as const },
    ],
  },
  cleanRanges: {
    orderBy: { sequence: 'asc' as const },
  },
} satisfies Prisma.V2SourceDeconstructionReportInclude

export const CONTAMINATION_REPORT_INCLUDE = {
  observations: {
    orderBy: [
      { startMs: 'asc' as const },
      { id: 'asc' as const },
    ],
  },
  protectedRegions: {
    orderBy: [
      { startMs: 'asc' as const },
      { id: 'asc' as const },
    ],
  },
  findings: {
    orderBy: [
      { startMs: 'asc' as const },
      { id: 'asc' as const },
    ],
  },
  overlaps: {
    orderBy: [
      { startMs: 'asc' as const },
      { id: 'asc' as const },
    ],
  },
  sourceDeconstruction: {
    include: SOURCE_INCLUDE,
  },
} satisfies Prisma.V2ContaminationReportInclude

type ReportRow = Prisma.V2ContaminationReportGetPayload<{
  include: typeof CONTAMINATION_REPORT_INCLUDE
}>

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
}

function canonicalJson<T>(
  value: string,
  field: string,
): Readonly<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid JSON`,
    )
  }
  if (stableSerialize(parsed) !== value) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is not canonical JSON`,
    )
  }
  return Object.freeze(parsed as T)
}

function sameRegion(
  region: Readonly<NormalizedRegion> | null,
  row: {
    regionX: number | null
    regionY: number | null
    regionWidth: number | null
    regionHeight: number | null
  },
): boolean {
  return region === null
    ? row.regionX === null &&
      row.regionY === null &&
      row.regionWidth === null &&
      row.regionHeight === null
    : row.regionX === region.x &&
      row.regionY === region.y &&
      row.regionWidth === region.width &&
      row.regionHeight === region.height
}

function assertObservationProjection(
  report: Readonly<ContaminationReport>,
  rows: ReportRow['observations'],
) {
  if (rows.length !== report.observations.length) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored contamination observation count is inconsistent',
    )
  }
  for (const row of rows) {
    const observation = report.observations.find((candidate) =>
      candidate.id === row.id)
    const finding = report.findings.find((candidate) =>
      candidate.observationId === row.id)
    const signals = canonicalJson(
      row.signalsJson,
      `contamination observation ${row.id} signals`,
    )
    if (
      !observation ||
      !finding ||
      row.workspaceId !== report.workspaceId ||
      row.projectId !== report.projectId ||
      row.reportId !== report.id ||
      row.kind !== observation.kind ||
      row.startMs !== observation.rangeMs[0] ||
      row.endMs !== observation.rangeMs[1] ||
      !sameRegion(observation.region, row) ||
      row.confidence !== observation.confidence ||
      row.detectorProvider !== observation.detector.provider ||
      row.detectorModel !== observation.detector.model ||
      row.detectorVersion !== observation.detector.version ||
      row.detectorHash !==
        calculateCanonicalHash(observation.detector) ||
      stableSerialize(signals) !== stableSerialize(observation.signals) ||
      row.signalsHash !==
        calculateCanonicalHash(observation.signals) ||
      row.observationHash !== finding.observationHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored contamination observation ${row.id} is inconsistent`,
      )
    }
  }
}

function assertProtectedRegionProjection(
  report: Readonly<ContaminationReport>,
  rows: ReportRow['protectedRegions'],
) {
  if (rows.length !== report.protectedRegions.length) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored protected-region count is inconsistent',
    )
  }
  for (const row of rows) {
    const region = report.protectedRegions.find((candidate) =>
      candidate.id === row.id)
    if (
      !region ||
      row.workspaceId !== report.workspaceId ||
      row.projectId !== report.projectId ||
      row.reportId !== report.id ||
      row.kind !== region.kind ||
      row.startMs !== region.rangeMs[0] ||
      row.endMs !== region.rangeMs[1] ||
      row.regionX !== region.region.x ||
      row.regionY !== region.region.y ||
      row.regionWidth !== region.region.width ||
      row.regionHeight !== region.region.height ||
      row.confidence !== region.confidence ||
      row.source !== region.source ||
      row.regionHash !== region.regionHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored protected region ${row.id} is inconsistent`,
      )
    }
  }
}

function assertFindingProjection(
  report: Readonly<ContaminationReport>,
  rows: ReportRow['findings'],
) {
  if (rows.length !== report.findings.length) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored contamination finding count is inconsistent',
    )
  }
  for (const row of rows) {
    const finding = report.findings.find((candidate) =>
      candidate.id === row.id)
    const protectedRegionIds = canonicalJson(
      row.protectedRegionIdsJson,
      `contamination finding ${row.id} protected-region IDs`,
    )
    const reasonCodes = canonicalJson(
      row.reasonCodesJson,
      `contamination finding ${row.id} reason codes`,
    )
    if (
      !finding ||
      row.workspaceId !== report.workspaceId ||
      row.projectId !== report.projectId ||
      row.reportId !== report.id ||
      row.observationId !== finding.observationId ||
      row.kind !== finding.kind ||
      row.startMs !== finding.rangeMs[0] ||
      row.endMs !== finding.rangeMs[1] ||
      !sameRegion(finding.region, row) ||
      row.confidence !== finding.confidence ||
      row.overlapsEssentialTime !== finding.overlapsEssentialTime ||
      row.essentialOverlapRatio !== finding.essentialOverlapRatio ||
      stableSerialize(protectedRegionIds) !==
        stableSerialize(finding.protectedRegionIds) ||
      row.protectedRegionIntersectionRatio !==
        finding.protectedRegionIntersectionRatio ||
      row.removalImpact !== finding.removalImpact ||
      row.removalWouldDestroyEssential !==
        finding.removalWouldDestroyEssential ||
      row.requiresHumanReview !== finding.requiresHumanReview ||
      stableSerialize(reasonCodes) !==
        stableSerialize(finding.reasonCodes) ||
      row.observationHash !== finding.observationHash ||
      row.findingHash !== finding.findingHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored contamination finding ${row.id} is inconsistent`,
      )
    }
  }
}

function assertOverlapProjection(
  report: Readonly<ContaminationReport>,
  rows: ReportRow['overlaps'],
) {
  if (rows.length !== report.overlaps.length) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored contamination overlap count is inconsistent',
    )
  }
  for (const row of rows) {
    const overlap = report.overlaps.find((candidate) =>
      candidate.id === row.id)
    if (
      !overlap ||
      row.workspaceId !== report.workspaceId ||
      row.projectId !== report.projectId ||
      row.reportId !== report.id ||
      row.leftFindingId !== overlap.leftFindingId ||
      row.rightFindingId !== overlap.rightFindingId ||
      row.startMs !== overlap.rangeMs[0] ||
      row.endMs !== overlap.rangeMs[1] ||
      row.spatiallyOverlapping !== overlap.spatiallyOverlapping ||
      !sameRegion(overlap.intersectionRegion, {
        regionX: row.intersectionX,
        regionY: row.intersectionY,
        regionWidth: row.intersectionWidth,
        regionHeight: row.intersectionHeight,
      }) ||
      row.confidence !== overlap.confidence ||
      row.overlapHash !== overlap.overlapHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored contamination overlap ${row.id} is inconsistent`,
      )
    }
  }
}

export function hydrateContaminationReportRow(
  row: ReportRow,
): Readonly<ContaminationReport> {
  const source = hydrateSourceDeconstructionRow(
    row.sourceDeconstruction,
  )
  const report = hydrateContaminationReport(
    canonicalJson<ContaminationReport>(
      row.reportJson,
      `contamination report ${row.id}`,
    ),
    source,
  )
  const analyzer = canonicalJson(
    row.analyzerJson,
    `contamination report ${row.id} analyzer`,
  )
  const policy = canonicalJson(
    row.policyJson,
    `contamination report ${row.id} policy`,
  )
  if (
    report.id !== row.id ||
    report.workspaceId !== row.workspaceId ||
    report.projectId !== row.projectId ||
    report.sourceDeconstructionReportId !==
      row.sourceDeconstructionReportId ||
    report.sourceDeconstructionReportHash !==
      row.sourceDeconstructionReportHash ||
    report.sourceArtifactId !== row.sourceArtifactId ||
    report.sourceArtifactSha256 !== row.sourceArtifactSha256 ||
    report.sourceDurationMs !== row.sourceDurationMs ||
    row.schemaVersion !== CONTAMINATION_REPORT_SCHEMA_VERSION ||
    row.policyVersion !== CONTAMINATION_POLICY_VERSION ||
    row.analyzerProvider !== report.analyzer.provider ||
    row.analyzerModel !== report.analyzer.model ||
    row.analyzerVersion !== report.analyzer.version ||
    row.observationBatchHash !==
      report.analyzer.observationBatchHash ||
    stableSerialize(analyzer) !== stableSerialize(report.analyzer) ||
    row.analyzerHash !== calculateCanonicalHash(report.analyzer) ||
    stableSerialize(policy) !== stableSerialize(report.policy) ||
    row.policyHash !== calculateCanonicalHash(report.policy) ||
    row.reportHash !== report.reportHash ||
    row.decision !== report.decision ||
    row.humanReviewRequired !== report.humanReviewRequired ||
    row.confidence !== report.confidence ||
    row.findingCount !== report.summary.findingCount ||
    row.observationCount !== report.summary.observationCount ||
    row.protectedRegionCount !==
      report.summary.protectedRegionCount ||
    row.overlapCount !== report.summary.overlapCount ||
    row.safeCount !== report.summary.safeCount ||
    row.reviewCount !== report.summary.reviewCount ||
    row.destructiveCount !== report.summary.destructiveCount ||
    row.createdByClientId !== report.createdByClientId ||
    row.createdAt.toISOString() !== report.createdAt
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored contamination report ${row.id} has inconsistent projections`,
    )
  }
  assertObservationProjection(report, row.observations)
  assertProtectedRegionProjection(report, row.protectedRegions)
  assertFindingProjection(report, row.findings)
  assertOverlapProjection(report, row.overlaps)
  return report
}

function reportData(
  record: Readonly<ContaminationReportCreateRecord>,
) {
  const { report } = record
  return {
    id: report.id,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    sourceDeconstructionReportId:
      report.sourceDeconstructionReportId,
    sourceDeconstructionReportHash:
      report.sourceDeconstructionReportHash,
    sourceArtifactId: report.sourceArtifactId,
    sourceArtifactSha256: report.sourceArtifactSha256,
    sourceDurationMs: report.sourceDurationMs,
    schemaVersion: report.schemaVersion,
    policyVersion: report.policy.version,
    analyzerProvider: report.analyzer.provider,
    analyzerModel: report.analyzer.model,
    analyzerVersion: report.analyzer.version,
    observationBatchHash: report.analyzer.observationBatchHash,
    analyzerJson: stableSerialize(report.analyzer),
    analyzerHash: calculateCanonicalHash(report.analyzer),
    policyJson: stableSerialize(report.policy),
    policyHash: calculateCanonicalHash(report.policy),
    reportJson: stableSerialize(report),
    reportHash: report.reportHash,
    decision: report.decision,
    humanReviewRequired: report.humanReviewRequired,
    confidence: report.confidence,
    findingCount: report.summary.findingCount,
    observationCount: report.summary.observationCount,
    protectedRegionCount: report.summary.protectedRegionCount,
    overlapCount: report.summary.overlapCount,
    safeCount: report.summary.safeCount,
    reviewCount: report.summary.reviewCount,
    destructiveCount: report.summary.destructiveCount,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: report.createdByClientId,
    createdAt: new Date(report.createdAt),
  }
}

function regionData(
  region: Readonly<NormalizedRegion> | null,
) {
  return region
    ? {
        regionX: region.x,
        regionY: region.y,
        regionWidth: region.width,
        regionHeight: region.height,
      }
    : {
        regionX: null,
        regionY: null,
        regionWidth: null,
        regionHeight: null,
      }
}

function observationData(
  report: Readonly<ContaminationReport>,
) {
  return report.observations.map((observation) => {
    const finding = report.findings.find((candidate) =>
      candidate.observationId === observation.id)
    if (!finding) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Contamination observation ${observation.id} has no finding`,
      )
    }
    return {
      id: observation.id,
      workspaceId: report.workspaceId,
      projectId: report.projectId,
      reportId: report.id,
      kind: observation.kind,
      startMs: observation.rangeMs[0],
      endMs: observation.rangeMs[1],
      ...regionData(observation.region),
      confidence: observation.confidence,
      detectorProvider: observation.detector.provider,
      detectorModel: observation.detector.model,
      detectorVersion: observation.detector.version,
      detectorHash: calculateCanonicalHash(observation.detector),
      signalsJson: stableSerialize(observation.signals),
      signalsHash: calculateCanonicalHash(observation.signals),
      observationHash: finding.observationHash,
    }
  })
}

function protectedRegionData(
  report: Readonly<ContaminationReport>,
) {
  return report.protectedRegions.map((region) => ({
    id: region.id,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    reportId: report.id,
    kind: region.kind,
    startMs: region.rangeMs[0],
    endMs: region.rangeMs[1],
    regionX: region.region.x,
    regionY: region.region.y,
    regionWidth: region.region.width,
    regionHeight: region.region.height,
    confidence: region.confidence,
    source: region.source,
    regionHash: region.regionHash,
  }))
}

function findingData(
  report: Readonly<ContaminationReport>,
) {
  return report.findings.map((finding) => ({
    id: finding.id,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    reportId: report.id,
    observationId: finding.observationId,
    kind: finding.kind,
    startMs: finding.rangeMs[0],
    endMs: finding.rangeMs[1],
    ...regionData(finding.region),
    confidence: finding.confidence,
    overlapsEssentialTime: finding.overlapsEssentialTime,
    essentialOverlapRatio: finding.essentialOverlapRatio,
    protectedRegionIdsJson: stableSerialize(
      finding.protectedRegionIds,
    ),
    protectedRegionIntersectionRatio:
      finding.protectedRegionIntersectionRatio,
    removalImpact: finding.removalImpact,
    removalWouldDestroyEssential:
      finding.removalWouldDestroyEssential,
    requiresHumanReview: finding.requiresHumanReview,
    reasonCodesJson: stableSerialize(finding.reasonCodes),
    observationHash: finding.observationHash,
    findingHash: finding.findingHash,
  }))
}

function overlapData(
  report: Readonly<ContaminationReport>,
) {
  return report.overlaps.map((overlap) => ({
    id: overlap.id,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    reportId: report.id,
    leftFindingId: overlap.leftFindingId,
    rightFindingId: overlap.rightFindingId,
    startMs: overlap.rangeMs[0],
    endMs: overlap.rangeMs[1],
    spatiallyOverlapping: overlap.spatiallyOverlapping,
    intersectionX: overlap.intersectionRegion?.x ?? null,
    intersectionY: overlap.intersectionRegion?.y ?? null,
    intersectionWidth: overlap.intersectionRegion?.width ?? null,
    intersectionHeight: overlap.intersectionRegion?.height ?? null,
    confidence: overlap.confidence,
    overlapHash: overlap.overlapHash,
  }))
}

export class PrismaContaminationReportRepository
implements ContaminationReportRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async findCreateReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<ContaminationReportReplay> | null> {
    const row = await this.prisma.v2ContaminationReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        createdByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      include: CONTAMINATION_REPORT_INCLUDE,
    })
    return row
      ? Object.freeze({
          report: hydrateContaminationReportRow(row),
          requestFingerprint: row.requestFingerprint,
        })
      : null
  }

  async create(
    record: Readonly<ContaminationReportCreateRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    report: Readonly<ContaminationReport>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay = await transaction.v2ContaminationReport.findFirst({
          where: {
            workspaceId: record.report.workspaceId,
            projectId: record.report.projectId,
            createdByClientId: record.report.createdByClientId,
            idempotencyKey: record.idempotencyKey,
          },
          include: CONTAMINATION_REPORT_INCLUDE,
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different contamination request',
            )
          }
          return Object.freeze({
            report: hydrateContaminationReportRow(replay),
            replayed: true,
          })
        }
        const source =
          await transaction.v2SourceDeconstructionReport.findFirst({
            where: {
              id: record.report.sourceDeconstructionReportId,
              workspaceId: record.report.workspaceId,
              projectId: record.report.projectId,
              reportHash:
                record.report.sourceDeconstructionReportHash,
              sourceArtifactId: record.report.sourceArtifactId,
              sourceArtifactSha256:
                record.report.sourceArtifactSha256,
              sourceDurationMs: record.report.sourceDurationMs,
            },
            include: SOURCE_INCLUDE,
          })
        if (!source) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Source deconstruction changed before contamination persistence',
          )
        }
        const report = hydrateContaminationReport(
          record.report,
          hydrateSourceDeconstructionRow(source),
        )
        await transaction.v2ContaminationReport.create({
          data: reportData({ ...record, report }),
        })
        if (report.observations.length > 0) {
          await transaction.v2ContaminationObservation.createMany({
            data: observationData(report),
          })
        }
        if (report.protectedRegions.length > 0) {
          await transaction.v2ContaminationProtectedRegion.createMany({
            data: protectedRegionData(report),
          })
        }
        if (report.findings.length > 0) {
          await transaction.v2ContaminationFinding.createMany({
            data: findingData(report),
          })
        }
        if (report.overlaps.length > 0) {
          await transaction.v2ContaminationOverlap.createMany({
            data: overlapData(report),
          })
        }
        const stored =
          await transaction.v2ContaminationReport.findUniqueOrThrow({
            where: { id: report.id },
            include: CONTAMINATION_REPORT_INCLUDE,
          })
        return Object.freeze({
          report: hydrateContaminationReportRow(stored),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.create(record, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findCreateReplay({
          workspaceId: record.report.workspaceId,
          projectId: record.report.projectId,
          actorClientId: record.report.createdByClientId,
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different contamination request',
            )
          }
          return Object.freeze({
            report: replay.report,
            replayed: true,
          })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Contamination report conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    projectId: string
    reportId: string
  }): Promise<Readonly<ContaminationReport> | null> {
    const row = await this.prisma.v2ContaminationReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      include: CONTAMINATION_REPORT_INCLUDE,
    })
    return row ? hydrateContaminationReportRow(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    sourceDeconstructionReportId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<ContaminationReportPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2ContaminationReport.findFirst({
          where: {
            id: input.cursor,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            ...(input.sourceDeconstructionReportId
              ? {
                  sourceDeconstructionReportId:
                    input.sourceDeconstructionReportId,
                }
              : {}),
          },
          select: { id: true, createdAt: true },
        })
      : null
    if (input.cursor && !cursor) {
      throw new DomainError(
        'INVALID_CURSOR',
        'Contamination report cursor is invalid',
      )
    }
    const rows = await this.prisma.v2ContaminationReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.sourceDeconstructionReportId
          ? {
              sourceDeconstructionReportId:
                input.sourceDeconstructionReportId,
            }
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
      include: CONTAMINATION_REPORT_INCLUDE,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
    })
    return Object.freeze({
      reports: Object.freeze(
        rows.slice(0, input.limit)
          .map(hydrateContaminationReportRow),
      ),
      ...(rows.length > input.limit
        ? { nextCursor: rows[input.limit - 1]!.id }
        : {}),
    })
  }
}
