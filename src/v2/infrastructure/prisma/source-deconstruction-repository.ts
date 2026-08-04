import {
  Prisma,
  type PrismaClient,
  type V2SourceDeconstructionRange,
  type V2SourceDeconstructionReport,
  type V2SourceDeconstructionSegment,
} from '../../../../generated/prisma-v2/index.js'

import type {
  SourceDeconstructionCreateRecord,
  SourceDeconstructionPage,
  SourceDeconstructionReplay,
  SourceDeconstructionRepository,
  SourceDeconstructionSourceContext,
} from '../../application/ports/source-deconstruction-repository.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
} from './external-actor-audit.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  hydrateSourceDeconstructionReport,
  SOURCE_DECONSTRUCTION_ANALYZER_VERSION,
  SOURCE_DECONSTRUCTION_POLICY_VERSION,
  type SourceDeconstructionReport,
} from '../../domain/source-deconstruction.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  hydrateStoredSpeechSegment,
} from './speech-segment-catalog-repository.ts'

interface ReportWithProjection
extends V2SourceDeconstructionReport {
  segments: V2SourceDeconstructionSegment[]
  cleanRanges: V2SourceDeconstructionRange[]
}

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

function reportInclude() {
  return {
    segments: {
      orderBy: [
        { startMs: 'asc' as const },
        { sourceSegmentId: 'asc' as const },
      ],
    },
    cleanRanges: {
      orderBy: { sequence: 'asc' as const },
    },
  }
}

function assertSegmentProjection(
  report: Readonly<SourceDeconstructionReport>,
  rows: readonly V2SourceDeconstructionSegment[],
) {
  if (rows.length !== report.segments.length) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored source deconstruction segment count is inconsistent',
    )
  }
  for (const row of rows) {
    const segment = report.segments.find((candidate) =>
      candidate.id === row.id)
    const reasonCodes = canonicalJson<readonly string[]>(
      row.roleReasonCodesJson,
      `source deconstruction segment ${row.id} reason codes`,
    )
    if (
      !segment ||
      row.workspaceId !== report.workspaceId ||
      row.projectId !== report.projectId ||
      row.reportId !== report.id ||
      row.sourceArtifactId !== report.sourceArtifactId ||
      row.sourceSpeechSegmentId !==
        segment.sourceSpeechSegmentId ||
      row.sourceSegmentId !== segment.sourceSegmentId ||
      row.startMs !== segment.rangeMs[0] ||
      row.endMs !== segment.rangeMs[1] ||
      row.semanticRole !== segment.role ||
      row.roleConfidence !== segment.roleConfidence ||
      stableSerialize(reasonCodes) !==
        stableSerialize(segment.roleReasonCodes) ||
      row.essential !== segment.essential ||
      row.included !== segment.included ||
      row.includedForContext !== segment.includedForContext ||
      row.completeThoughtScore !== segment.completeThoughtScore ||
      row.classification !== segment.classification ||
      row.exactText !== segment.exactText ||
      row.normalizedText !== segment.normalizedText ||
      row.sourceSegmentHash !== segment.segmentHash ||
      row.analysisHash !== segment.analysisHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored source deconstruction segment ${row.id} is inconsistent`,
      )
    }
  }
}

function assertRangeProjection(
  report: Readonly<SourceDeconstructionReport>,
  rows: readonly V2SourceDeconstructionRange[],
) {
  if (rows.length !== report.cleanCandidateRanges.length) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored source deconstruction clean range count is inconsistent',
    )
  }
  for (const row of rows) {
    const candidate = report.cleanCandidateRanges.find((item) =>
      item.id === row.id)
    const sourceSpeechSegmentIds = canonicalJson<readonly string[]>(
      row.sourceSpeechSegmentIdsJson,
      `source deconstruction range ${row.id} segment IDs`,
    )
    const roles = canonicalJson<readonly string[]>(
      row.rolesJson,
      `source deconstruction range ${row.id} roles`,
    )
    const boundaryReasonCodes = canonicalJson<readonly string[]>(
      row.boundaryReasonCodesJson,
      `source deconstruction range ${row.id} reasons`,
    )
    if (
      !candidate ||
      row.workspaceId !== report.workspaceId ||
      row.projectId !== report.projectId ||
      row.reportId !== report.id ||
      row.sequence !== candidate.sequence ||
      row.startMs !== candidate.rangeMs[0] ||
      row.endMs !== candidate.rangeMs[1] ||
      row.speechStartMs !== candidate.speechRangeMs[0] ||
      row.speechEndMs !== candidate.speechRangeMs[1] ||
      stableSerialize(sourceSpeechSegmentIds) !==
        stableSerialize(candidate.sourceSpeechSegmentIds) ||
      stableSerialize(roles) !== stableSerialize(candidate.roles) ||
      row.exactText !== candidate.exactText ||
      row.confidence !== candidate.confidence ||
      row.contextPreserved !== candidate.contextPreserved ||
      stableSerialize(boundaryReasonCodes) !==
        stableSerialize(candidate.boundaryReasonCodes) ||
      row.rangeHash !== candidate.rangeHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored source deconstruction range ${row.id} is inconsistent`,
      )
    }
  }
}

export function hydrateSourceDeconstructionRow(
  row: ReportWithProjection,
): Readonly<SourceDeconstructionReport> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  const report = hydrateSourceDeconstructionReport(
    canonicalJson<SourceDeconstructionReport>(
      row.reportJson,
      `source deconstruction report ${row.id}`,
    ),
  )
  const targetComposition = canonicalJson(
    row.targetCompositionJson,
    `source deconstruction report ${row.id} target composition`,
  )
  const boundaryPolicy = canonicalJson(
    row.boundaryPolicyJson,
    `source deconstruction report ${row.id} boundary policy`,
  )
  if (
    report.id !== row.id ||
    report.workspaceId !== row.workspaceId ||
    report.projectId !== row.projectId ||
    report.sourceArtifactId !== row.sourceArtifactId ||
    report.sourceArtifactSha256 !== row.sourceArtifactSha256 ||
    report.sourceTranscriptId !== row.sourceTranscriptId ||
    report.sourceTranscriptHash !== row.sourceTranscriptHash ||
    report.sourceDurationMs !== row.sourceDurationMs ||
    report.schemaVersion !== row.schemaVersion ||
    row.policyVersion !== SOURCE_DECONSTRUCTION_POLICY_VERSION ||
    row.analyzerVersion !== SOURCE_DECONSTRUCTION_ANALYZER_VERSION ||
    report.desiredRole !== row.desiredRole ||
    report.validationScope !== row.validationScope ||
    stableSerialize(report.targetComposition) !==
      stableSerialize(targetComposition) ||
    calculateCanonicalHash(targetComposition) !==
      row.targetCompositionHash ||
    stableSerialize(report.boundaryPolicy) !==
      stableSerialize(boundaryPolicy) ||
    calculateCanonicalHash(boundaryPolicy) !==
      row.boundaryPolicyHash ||
    report.reportHash !== row.reportHash ||
    report.confidence !== row.confidence ||
    report.editabilityScore !== row.editabilityScore ||
    report.decision !== row.decision ||
    report.contextPreserved !== row.contextPreserved ||
    report.segments.length !== row.segmentCount ||
    report.cleanCandidateRanges.length !== row.cleanRangeCount ||
    report.semanticContaminants.length !==
      row.semanticContaminantCount ||
    report.comparison.cleanDurationMs !== row.cleanDurationMs ||
    report.comparison.removedDurationMs !== row.removedDurationMs ||
    report.createdByClientId !== row.createdByClientId ||
    report.createdAt !== row.createdAt.toISOString()
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored source deconstruction report ${row.id} has inconsistent projections`,
    )
  }
  assertSegmentProjection(report, row.segments)
  assertRangeProjection(report, row.cleanRanges)
  return report
}

function reportData(
  record: Readonly<SourceDeconstructionCreateRecord>,
) {
  const { report } = record
  return {
    id: report.id,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    sourceArtifactId: report.sourceArtifactId,
    sourceArtifactSha256: report.sourceArtifactSha256,
    sourceTranscriptId: report.sourceTranscriptId,
    sourceTranscriptHash: report.sourceTranscriptHash,
    sourceDurationMs: report.sourceDurationMs,
    schemaVersion: report.schemaVersion,
    policyVersion: report.analyzer.policyVersion,
    analyzerVersion: report.analyzer.version,
    desiredRole: report.desiredRole,
    validationScope: report.validationScope,
    targetCompositionJson: stableSerialize(
      report.targetComposition,
    ),
    targetCompositionHash: calculateCanonicalHash(
      report.targetComposition,
    ),
    boundaryPolicyJson: stableSerialize(report.boundaryPolicy),
    boundaryPolicyHash: calculateCanonicalHash(
      report.boundaryPolicy,
    ),
    reportJson: stableSerialize(report),
    reportHash: report.reportHash,
    confidence: report.confidence,
    editabilityScore: report.editabilityScore,
    decision: report.decision,
    contextPreserved: report.contextPreserved,
    segmentCount: report.segments.length,
    cleanRangeCount: report.cleanCandidateRanges.length,
    semanticContaminantCount:
      report.semanticContaminants.length,
    cleanDurationMs: report.comparison.cleanDurationMs,
    removedDurationMs: report.comparison.removedDurationMs,
    requestFingerprint: record.requestFingerprint,
    idempotencyKey: record.idempotencyKey,
    createdByClientId: report.createdByClientId,
    createdAt: new Date(report.createdAt),
    ...externalActorAuditData(
      record.authenticationAudit,
      report.workspaceId,
      report.createdByClientId,
    ),
  }
}

function segmentData(
  report: Readonly<SourceDeconstructionReport>,
) {
  return report.segments.map((segment) => ({
    id: segment.id,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    reportId: report.id,
    sourceArtifactId: report.sourceArtifactId,
    sourceSpeechSegmentId: segment.sourceSpeechSegmentId,
    sourceSegmentId: segment.sourceSegmentId,
    startMs: segment.rangeMs[0],
    endMs: segment.rangeMs[1],
    semanticRole: segment.role,
    roleConfidence: segment.roleConfidence,
    roleReasonCodesJson: stableSerialize(segment.roleReasonCodes),
    essential: segment.essential,
    included: segment.included,
    includedForContext: segment.includedForContext,
    completeThoughtScore: segment.completeThoughtScore,
    classification: segment.classification,
    exactText: segment.exactText,
    normalizedText: segment.normalizedText,
    sourceSegmentHash: segment.segmentHash,
    analysisHash: segment.analysisHash,
  }))
}

function rangeData(
  report: Readonly<SourceDeconstructionReport>,
) {
  return report.cleanCandidateRanges.map((candidate) => ({
    id: candidate.id,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    reportId: report.id,
    sequence: candidate.sequence,
    startMs: candidate.rangeMs[0],
    endMs: candidate.rangeMs[1],
    speechStartMs: candidate.speechRangeMs[0],
    speechEndMs: candidate.speechRangeMs[1],
    sourceSpeechSegmentIdsJson: stableSerialize(
      candidate.sourceSpeechSegmentIds,
    ),
    rolesJson: stableSerialize(candidate.roles),
    exactText: candidate.exactText,
    confidence: candidate.confidence,
    contextPreserved: candidate.contextPreserved,
    boundaryReasonCodesJson: stableSerialize(
      candidate.boundaryReasonCodes,
    ),
    rangeHash: candidate.rangeHash,
  }))
}

function manifestDurationMs(manifestJson: string): number {
  const manifest = canonicalJson<Record<string, unknown>>(
    manifestJson,
    'source artifact manifest',
  )
  const probe = manifest.probe
  if (
    typeof probe !== 'object' ||
    probe === null ||
    Array.isArray(probe) ||
    typeof (probe as Record<string, unknown>).duration !== 'number'
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Source artifact manifest has no valid duration',
    )
  }
  const durationMs = Math.round(
    Number((probe as Record<string, unknown>).duration) * 1_000,
  )
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > 24 * 60 * 60 * 1_000
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Source artifact duration is invalid',
    )
  }
  return durationMs
}

async function assertCurrentSource(
  transaction: Prisma.TransactionClient,
  report: Readonly<SourceDeconstructionReport>,
) {
  const [source, actor] = await Promise.all([
    transaction.v2MediaTranscript.findFirst({
      where: {
        id: report.sourceTranscriptId,
        workspaceId: report.workspaceId,
        projectId: report.projectId,
        sourceArtifactId: report.sourceArtifactId,
        transcriptHash: report.sourceTranscriptHash,
        sourceArtifact: {
          sha256: report.sourceArtifactSha256,
          status: 'available',
        },
      },
      include: {
        sourceArtifact: true,
        sourceManifest: true,
        speechCatalogRuns: {
          where: { active: true },
          orderBy: [
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
          take: 1,
          include: {
            segments: {
              orderBy: { sourceSegmentId: 'asc' },
            },
          },
        },
      },
    }),
    transaction.v2ApiClient.findFirst({
      where: {
        id: report.createdByClientId,
        workspaceId: report.workspaceId,
        status: 'active',
      },
      select: { id: true },
    }),
  ])
  const catalog = source?.speechCatalogRuns[0]
  if (!source || !catalog || !actor) {
    throw new DomainError(
      'SOURCE_DECONSTRUCTION_SOURCE_NOT_FOUND',
      'Source deconstruction context is no longer available',
    )
  }
  if (
    manifestDurationMs(source.sourceManifest.manifestJson) !==
      report.sourceDurationMs ||
    catalog.sourceTranscriptHash !== report.sourceTranscriptHash ||
    catalog.sourceArtifactId !== report.sourceArtifactId ||
    catalog.segments.length !== report.segments.length ||
    !catalog.segments.every((segment) => {
      const projected = report.segments.find((candidate) =>
        candidate.sourceSpeechSegmentId === segment.id)
      return projected?.segmentHash === segment.segmentHash
    })
  ) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Source evidence changed before deconstruction persistence',
    )
  }
}

export class PrismaSourceDeconstructionRepository
implements SourceDeconstructionRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  async loadSourceContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceTranscriptId: string
    actorClientId: string
  }): Promise<Readonly<SourceDeconstructionSourceContext> | null> {
    const [source, actor] = await Promise.all([
      this.prisma.v2MediaTranscript.findFirst({
        where: {
          id: input.sourceTranscriptId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          sourceArtifactId: input.sourceArtifactId,
          sourceArtifact: { status: 'available' },
        },
        include: {
          sourceArtifact: true,
          sourceManifest: true,
          speechCatalogRuns: {
            where: { active: true },
            orderBy: [
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
            take: 1,
            include: {
              segments: {
                orderBy: { sourceSegmentId: 'asc' },
              },
            },
          },
        },
      }),
      this.prisma.v2ApiClient.findFirst({
        where: {
          id: input.actorClientId,
          workspaceId: input.workspaceId,
          status: 'active',
        },
        select: { id: true },
      }),
    ])
    const catalog = source?.speechCatalogRuns[0]
    if (!source || !catalog || !actor || catalog.segments.length === 0) {
      return null
    }
    const sourceDurationMs = manifestDurationMs(
      source.sourceManifest.manifestJson,
    )
    const hydrated = catalog.segments.map(hydrateStoredSpeechSegment)
    if (
      catalog.sourceTranscriptHash !== source.transcriptHash ||
      catalog.sourceArtifactId !== source.sourceArtifactId ||
      hydrated.some((segment) =>
        segment.rangeMs[1] > sourceDurationMs)
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Cataloged speech does not match the source transcript',
      )
    }
    return Object.freeze({
      sourceArtifactId: source.sourceArtifactId,
      sourceArtifactSha256: source.sourceArtifact.sha256,
      sourceTranscriptId: source.id,
      sourceTranscriptHash: source.transcriptHash,
      sourceDurationMs,
      speechEvidence: Object.freeze(hydrated.map((segment) =>
        Object.freeze({
          id: segment.id,
          sourceSegmentId: segment.sourceSegmentId,
          exactText: segment.exactText,
          normalizedText: segment.normalizedText,
          rangeMs: segment.rangeMs,
          completeThoughtScore: segment.completeThoughtScore,
          classification: segment.classification,
          intentions: Object.freeze(segment.intentions.map((intention) =>
            Object.freeze({
              value: intention.value,
              confidence: intention.provenance.confidence,
              provenance:
                `${intention.provenance.provider}@` +
                `${intention.provenance.model}/` +
                intention.provenance.version,
            }))),
          segmentHash: segment.segmentHash,
        }))),
    })
  }

  async findCreateReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<SourceDeconstructionReplay> | null> {
    const row = await this.prisma.v2SourceDeconstructionReport.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        createdByClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      },
      include: reportInclude(),
    })
    if (!row) return null
    if (
      hydrateExternalActorAudit(row, row.createdByClientId).contextHash !==
      input.actorContextHash
    ) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Source deconstruction replay belongs to another authentication context',
      )
    }
    return Object.freeze({
      report: hydrateSourceDeconstructionRow(row),
      requestFingerprint: row.requestFingerprint,
    })
  }

  async create(
    record: Readonly<SourceDeconstructionCreateRecord>,
    attempt = 1,
  ): Promise<Readonly<{
    report: Readonly<SourceDeconstructionReport>
    replayed: boolean
  }>> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const replay =
          await transaction.v2SourceDeconstructionReport.findFirst({
            where: {
              workspaceId: record.report.workspaceId,
              projectId: record.report.projectId,
              createdByClientId: record.report.createdByClientId,
              idempotencyKey: record.idempotencyKey,
            },
            include: reportInclude(),
          })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different source deconstruction request',
            )
          }
          if (
            hydrateExternalActorAudit(replay, replay.createdByClientId)
              .contextHash !== record.authenticationAudit.contextHash
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Source deconstruction replay belongs to another authentication context',
            )
          }
          return Object.freeze({
            report: hydrateSourceDeconstructionRow(replay),
            replayed: true,
          })
        }
        const report = hydrateSourceDeconstructionReport(record.report)
        await assertCurrentSource(transaction, report)
        await transaction.v2SourceDeconstructionReport.create({
          data: reportData({ ...record, report }),
        })
        await transaction.v2SourceDeconstructionSegment.createMany({
          data: segmentData(report),
        })
        await transaction.v2SourceDeconstructionRange.createMany({
          data: rangeData(report),
        })
        const stored =
          await transaction.v2SourceDeconstructionReport.findUniqueOrThrow({
            where: { id: report.id },
            include: reportInclude(),
          })
        return Object.freeze({
          report: hydrateSourceDeconstructionRow(stored),
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
          actorContextHash: record.authenticationAudit.contextHash,
          idempotencyKey: record.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== record.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different source deconstruction request',
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
          'Source deconstruction conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async read(input: {
    workspaceId: string
    projectId: string
    reportId: string
  }): Promise<Readonly<SourceDeconstructionReport> | null> {
    const row = await this.prisma.v2SourceDeconstructionReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      include: reportInclude(),
    })
    return row ? hydrateSourceDeconstructionRow(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<SourceDeconstructionPage>> {
    const cursor = input.cursor
      ? await this.prisma.v2SourceDeconstructionReport.findFirst({
          where: {
            id: input.cursor,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            ...(input.sourceArtifactId
              ? { sourceArtifactId: input.sourceArtifactId }
              : {}),
          },
          select: { id: true, createdAt: true },
        })
      : null
    if (input.cursor && !cursor) {
      throw new DomainError(
        'INVALID_CURSOR',
        'Source deconstruction cursor is invalid',
      )
    }
    const rows = await this.prisma.v2SourceDeconstructionReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.sourceArtifactId
          ? { sourceArtifactId: input.sourceArtifactId }
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
      include: reportInclude(),
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
    })
    return Object.freeze({
      reports: Object.freeze(
        rows.slice(0, input.limit)
          .map(hydrateSourceDeconstructionRow),
      ),
      ...(rows.length > input.limit
        ? { nextCursor: rows[input.limit - 1]!.id }
        : {}),
    })
  }
}
