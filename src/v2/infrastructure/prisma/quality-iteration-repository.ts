import {
  Prisma,
  type PrismaClient,
} from '../../../../generated/prisma-v2/index.js'

import {
  compileQualityPatches,
  createQualityReport,
  validateQuality,
  type QualityIssue,
  type QualityTerminalReason,
} from '../../application/closed-quality-loop.ts'
import type {
  PersistedQualityIteration,
  QualityAssetPlacementEvidence,
  QualityIterationRepository,
  QualityProxyEvidence,
  QualityRubricEvidence,
} from '../../application/ports/quality-iteration-repository.ts'
import {
  calculateClosedQualityReportFingerprint,
  calculateQualityIterationRecordHash,
  resolveQualityReferenceDataset,
} from '../../application/run-quality-iteration.ts'
import { stableSerialize } from '../../application/version-hash.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  resolveStrategicRubric,
  type RubricCriterionId,
} from '../../domain/strategic-rubric.ts'
import {
  STRATEGIC_OBJECTIVES,
  type StrategicObjectiveId,
} from '../../domain/strategic-objective.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { hydrateAssetSelection } from './asset-selection-repository.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { hydrateProxyReview } from './proxy-review-repository.ts'

type StoredQualityIteration = Prisma.V2QualityIterationGetPayload<{
  include: { assetSelections: true }
}>

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/
const TERMINAL_REASONS = new Set<QualityTerminalReason>([
  'approval',
  'convergence',
  'budget',
  'uncorrectable',
  'human_review',
])

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid JSON`)
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
  return value
}

function canonical(value: unknown, serialized: string, field: string): void {
  if (stableSerialize(value) !== serialized) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is not canonical`)
  }
}

function parseIssues(value: string): readonly Readonly<QualityIssue>[] {
  const parsed = array(parseJson(value, 'quality issues'), 'quality issues')
  const normalized = validateQuality({
    technical: parsed as QualityIssue[],
    policy: [],
    integrity: [],
    assets: [],
    proxy: [],
  }).issues
  canonical(normalized, value, 'quality issues')
  return normalized
}

function parseProxyEvidence(value: string): Readonly<QualityProxyEvidence> {
  const parsed = record(parseJson(value, 'proxy evidence'), 'proxy evidence')
  const spec = record(parsed.spec, 'proxy evidence spec')
  if (
    typeof parsed.id !== 'string' ||
    !ID_PATTERN.test(parsed.id) ||
    typeof parsed.reviewHash !== 'string' ||
    !SHA_256_PATTERN.test(parsed.reviewHash) ||
    !Number.isSafeInteger(parsed.revision) ||
    Number(parsed.revision) < 1 ||
    !['blocked', 'warning-ack-required', 'ready-for-final'].includes(String(parsed.status)) ||
    typeof parsed.finalAllowed !== 'boolean' ||
    !Number.isSafeInteger(spec.width) ||
    Number(spec.width) < 1 ||
    !Number.isSafeInteger(spec.height) ||
    Number(spec.height) < 1 ||
    spec.codec !== 'h264' ||
    spec.container !== 'mp4' ||
    spec.quality !== 'review' ||
    spec.reusableRanges !== true
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy evidence is invalid')
  }
  const technicalIssues = validateQuality({
    technical: array(parsed.technicalIssues, 'proxy technical issues') as QualityIssue[],
    policy: [],
    integrity: [],
    assets: [],
    proxy: [],
  }).issues
  const criticIssues = validateQuality({
    technical: array(parsed.criticIssues, 'proxy critic issues') as QualityIssue[],
    policy: [],
    integrity: [],
    assets: [],
    proxy: [],
  }).issues
  const evidence = Object.freeze({
    id: parsed.id,
    reviewHash: parsed.reviewHash,
    revision: parsed.revision as number,
    status: parsed.status as QualityProxyEvidence['status'],
    finalAllowed: parsed.finalAllowed,
    spec: Object.freeze({
      width: spec.width as number,
      height: spec.height as number,
      codec: 'h264' as const,
      container: 'mp4' as const,
      quality: 'review' as const,
      reusableRanges: true as const,
    }),
    technicalIssues,
    criticIssues,
  })
  canonical(evidence, value, 'proxy evidence')
  return evidence
}

function parsePlacements(
  value: string,
): readonly Readonly<QualityAssetPlacementEvidence>[] {
  const parsed = array(parseJson(value, 'asset placements'), 'asset placements')
  if (parsed.length > 100) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset placements exceed bounds')
  }
  const placements = parsed.map((candidate, index) => {
    const item = record(candidate, `asset placement ${index}`)
    const rangeMs = item.rangeMs
    if (
      typeof item.selectionId !== 'string' ||
      !ID_PATTERN.test(item.selectionId) ||
      typeof item.selectionHash !== 'string' ||
      !SHA_256_PATTERN.test(item.selectionHash) ||
      !Array.isArray(rangeMs) ||
      rangeMs.length !== 2 ||
      !rangeMs.every((part) => Number.isSafeInteger(part) && part >= 0) ||
      Number(rangeMs[1]) <= Number(rangeMs[0]) ||
      typeof item.selectedArtifactId !== 'string' ||
      !ID_PATTERN.test(item.selectedArtifactId) ||
      !['library', 'stock', 'generated'].includes(String(item.selectedSource)) ||
      !['relevance', 'continuity', 'quality', 'novelty'].every((field) =>
        typeof item[field] === 'number' &&
        Number.isFinite(item[field]) &&
        Number(item[field]) >= 0 &&
        Number(item[field]) <= 1) ||
      typeof item.rightsApproved !== 'boolean' ||
      !Array.isArray(item.rightsReasonCodes) ||
      !item.rightsReasonCodes.every((code) =>
        typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(code)) ||
      ((item.rightsSnapshotId === undefined) !==
        (item.rightsSnapshotHash === undefined)) ||
      (item.rightsSnapshotId !== undefined &&
        (typeof item.rightsSnapshotId !== 'string' ||
          !ID_PATTERN.test(item.rightsSnapshotId))) ||
      (item.rightsSnapshotHash !== undefined &&
        (typeof item.rightsSnapshotHash !== 'string' ||
          !SHA_256_PATTERN.test(item.rightsSnapshotHash)))
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset placement is invalid')
    }
    return Object.freeze({
      selectionId: item.selectionId,
      selectionHash: item.selectionHash,
      rangeMs: Object.freeze([rangeMs[0], rangeMs[1]] as [number, number]),
      selectedArtifactId: item.selectedArtifactId,
      selectedSource: item.selectedSource as QualityAssetPlacementEvidence['selectedSource'],
      relevance: item.relevance as number,
      continuity: item.continuity as number,
      quality: item.quality as number,
      novelty: item.novelty as number,
      rightsApproved: item.rightsApproved,
      rightsReasonCodes: Object.freeze([...item.rightsReasonCodes] as string[]),
      ...(item.rightsSnapshotId
        ? { rightsSnapshotId: item.rightsSnapshotId as string }
        : {}),
      ...(item.rightsSnapshotHash
        ? { rightsSnapshotHash: item.rightsSnapshotHash as string }
        : {}),
    })
  })
  if (new Set(placements.map((placement) => placement.selectionId)).size !== placements.length) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored asset placements are duplicated')
  }
  const normalized = Object.freeze(placements)
  canonical(normalized, value, 'asset placements')
  return normalized
}

function parseRubric(value: string) {
  const parsed = record(parseJson(value, 'quality rubric'), 'quality rubric')
  if (
    typeof parsed.id !== 'string' ||
    !ID_PATTERN.test(parsed.id) ||
    !Number.isSafeInteger(parsed.version) ||
    typeof parsed.objective !== 'string' ||
    !STRATEGIC_OBJECTIVES.some((objective) => objective.id === parsed.objective) ||
    typeof parsed.threshold !== 'number' ||
    !Number.isFinite(parsed.threshold)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality rubric is invalid')
  }
  const objective = parsed.objective as StrategicObjectiveId
  const rubric = resolveStrategicRubric(objective)
  if (
    parsed.id !== rubric.id ||
    parsed.version !== rubric.version ||
    parsed.threshold !== rubric.threshold
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality rubric version is stale')
  }
  const evidence = array(parsed.evidence, 'quality rubric evidence').map(
    (candidate, index) => {
      const item = record(candidate, `quality rubric evidence ${index}`)
      if (
        typeof item.criterionId !== 'string' ||
        !rubric.criteria.some((criterion) => criterion.id === item.criterionId) ||
        typeof item.score !== 'number' ||
        !Number.isFinite(item.score) ||
        item.score < 0 ||
        item.score > 100 ||
        !Array.isArray(item.evidence) ||
        item.evidence.length < 1 ||
        !item.evidence.every((entry) =>
          typeof entry === 'string' && entry.length >= 1 && entry.length <= 500)
      ) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality rubric evidence is invalid')
      }
      return Object.freeze({
        criterionId: item.criterionId,
        score: item.score,
        evidence: Object.freeze([...item.evidence] as string[]),
      }) as Readonly<QualityRubricEvidence>
    },
  )
  if (
    evidence.length !== rubric.criteria.length ||
    new Set(evidence.map((item) => item.criterionId)).size !== rubric.criteria.length
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality rubric evidence is incomplete')
  }
  const normalized = Object.freeze({
    id: rubric.id,
    version: rubric.version,
    objective,
    threshold: rubric.threshold,
    evidence: Object.freeze(evidence),
  })
  canonical(normalized, value, 'quality rubric')
  return normalized
}

function parseRangeMetrics(value: string) {
  const parsed = array(parseJson(value, 'range metrics'), 'range metrics')
  if (parsed.length > 200) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored range metrics exceed bounds')
  }
  const metrics = parsed.map((candidate, index) => {
    const item = record(candidate, `range metric ${index}`)
    if (
      !Number.isSafeInteger(item.startMs) ||
      Number(item.startMs) < 0 ||
      !Number.isSafeInteger(item.endMs) ||
      Number(item.endMs) <= Number(item.startMs) ||
      typeof item.density !== 'number' ||
      !Number.isFinite(item.density) ||
      item.density < 0 ||
      item.density > 1
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored range metric is invalid')
    }
    return Object.freeze({
      startMs: item.startMs as number,
      endMs: item.endMs as number,
      density: item.density,
    })
  })
  const normalized = Object.freeze(metrics)
  canonical(normalized, value, 'range metrics')
  return normalized
}

function parseDataset(value: string, objective: StrategicObjectiveId) {
  const parsed = record(parseJson(value, 'quality dataset'), 'quality dataset')
  const current = resolveQualityReferenceDataset(objective)
  if (
    parsed.id !== current.id ||
    parsed.version !== current.version ||
    parsed.baselineScore !== current.baselineScore ||
    parsed.fingerprint !== current.fingerprint
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality dataset is invalid')
  }
  canonical(current, value, 'quality dataset')
  return current
}

function parseBudget(value: string) {
  const parsed = record(parseJson(value, 'quality budget'), 'quality budget')
  if (
    !Number.isSafeInteger(parsed.limitUnits) ||
    Number(parsed.limitUnits) < 1 ||
    Number(parsed.limitUnits) > 1_000 ||
    !Number.isSafeInteger(parsed.consumedUnits) ||
    Number(parsed.consumedUnits) < 0 ||
    Number(parsed.consumedUnits) > Number(parsed.limitUnits) ||
    !Number.isSafeInteger(parsed.remainingUnits) ||
    Number(parsed.remainingUnits) !==
      Number(parsed.limitUnits) - Number(parsed.consumedUnits) ||
    !Number.isSafeInteger(parsed.iterationCostUnits) ||
    Number(parsed.iterationCostUnits) < 0
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality budget is invalid')
  }
  const budget = Object.freeze({
    limitUnits: parsed.limitUnits as number,
    consumedUnits: parsed.consumedUnits as number,
    remainingUnits: parsed.remainingUnits as number,
    iterationCostUnits: parsed.iterationCostUnits as number,
  })
  canonical(budget, value, 'quality budget')
  return budget
}

export function hydrateQualityIteration(
  row: StoredQualityIteration,
): Readonly<PersistedQualityIteration> {
  const proxyEvidence = parseProxyEvidence(row.proxyEvidenceJson)
  const assetPlacements = parsePlacements(row.assetPlacementsJson)
  const rubric = parseRubric(row.rubricJson)
  const rangeMetrics = parseRangeMetrics(row.rangeMetricsJson)
  const dataset = parseDataset(row.datasetJson, rubric.objective)
  const issues = parseIssues(row.issuesJson)
  const validation = validateQuality({
    technical: issues.filter((issue) => issue.category === 'technical'),
    policy: issues.filter((issue) => issue.category === 'policy'),
    integrity: issues.filter((issue) => issue.category === 'integrity'),
    assets: issues.filter((issue) => issue.category === 'asset'),
    proxy: issues.filter((issue) => issue.category === 'editorial'),
  })
  const storedValidation = record(
    parseJson(row.validationJson, 'quality validation'),
    'quality validation',
  )
  const normalizedValidation = Object.freeze({
    valid: validation.valid,
    finalBlocked: validation.finalBlocked,
    hardIssueCount: validation.hardIssues.length,
    warningIssueCount: validation.warningIssues.length,
    hardByCategory: validation.hardByCategory,
  })
  canonical(normalizedValidation, row.validationJson, 'quality validation')
  const patches = compileQualityPatches(issues)
  canonical(patches.patches, row.patchesJson, 'quality patches')
  canonical(
    patches.minimalRerenderRangesMs,
    row.rerenderRangesJson,
    'quality rerender ranges',
  )
  if (patches.fullRerenderRequired !== row.fullRerenderRequired) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality rerender mode is invalid')
  }
  const score = Number((
    rubric.evidence.reduce((sum, evidence) => {
      const weight = resolveStrategicRubric(rubric.objective).criteria.find(
        (criterion) => criterion.id === evidence.criterionId as RubricCriterionId,
      )?.weight
      if (weight === undefined) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality criterion has no weight')
      }
      return sum + evidence.score * weight
    }, 0)
  ).toFixed(2))
  const report = createQualityReport({
    versionId: row.projectVersionId,
    datasetId: dataset.id,
    score,
    baselineScore: dataset.baselineScore,
    issues,
  })
  const budget = parseBudget(row.budgetJson)
  const terminalReason = row.terminalReason as QualityTerminalReason | null
  if (
    (row.decisionContinue && terminalReason !== null) ||
    (!row.decisionContinue && (
      terminalReason === null || !TERMINAL_REASONS.has(terminalReason)
    ))
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality decision is invalid')
  }
  const decision = Object.freeze({
    continue: row.decisionContinue,
    terminalReason,
  })
  const reportFingerprint = calculateClosedQualityReportFingerprint({
    projectVersionId: row.projectVersionId,
    projectVersionHash: row.projectVersionHash,
    iteration: row.iteration,
    ...(row.previousIterationId ? { previousIterationId: row.previousIterationId } : {}),
    proxyEvidence,
    assetPlacements,
    rubric,
    rangeMetrics,
    dataset,
    score,
    regression: report.regression,
    regressed: report.regressed,
    validation: normalizedValidation,
    issues,
    patches: patches.patches,
    minimalRerenderRangesMs: patches.minimalRerenderRangesMs,
    fullRerenderRequired: patches.fullRerenderRequired,
    budget,
    decision,
  })
  const links = [...row.assetSelections].sort((left, right) => left.ordinal - right.ordinal)
  if (
    links.length !== assetPlacements.length ||
    links.some((link, index) =>
      link.ordinal !== index ||
      link.assetSelectionId !== assetPlacements[index]?.selectionId ||
      link.selectionHash !== assetPlacements[index]?.selectionHash)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality asset links are invalid')
  }
  if (
    row.proxyReviewId !== proxyEvidence.id ||
    row.proxyReviewHash !== proxyEvidence.reviewHash ||
    row.proxyReviewRevision !== proxyEvidence.revision ||
    row.score !== score ||
    row.regression !== report.regression ||
    row.regressed !== report.regressed ||
    row.reportFingerprint !== reportFingerprint ||
    storedValidation.valid !== normalizedValidation.valid
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality iteration failed recomputation')
  }
  const content: Omit<PersistedQualityIteration, 'recordHash'> = Object.freeze({
    schemaVersion: 'quality-iteration/v1',
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    projectVersionHash: row.projectVersionHash,
    iteration: row.iteration,
    ...(row.previousIterationId ? { previousIterationId: row.previousIterationId } : {}),
    proxyEvidence,
    assetPlacements,
    rubric,
    rangeMetrics,
    dataset,
    score,
    regression: report.regression,
    regressed: report.regressed,
    validation: normalizedValidation,
    issues,
    patches: patches.patches,
    minimalRerenderRangesMs: patches.minimalRerenderRangesMs,
    fullRerenderRequired: patches.fullRerenderRequired,
    budget,
    decision,
    reportFingerprint,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    createdBy: Object.freeze({
      type: row.createdByType as 'api-client',
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  if (
    row.createdByType !== 'api-client' ||
    calculateQualityIterationRecordHash(content) !== row.recordHash
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored quality iteration hash is inconsistent')
  }
  return Object.freeze({ ...content, recordHash: row.recordHash })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaQualityIterationRepository implements QualityIterationRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2QualityIteration.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { assetSelections: true },
    })
    return row ? hydrateQualityIteration(row) : null
  }

  async readContext(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    proxyReviewId: string
    assetSelectionIds: readonly string[]
  }) {
    const [project, proxyRow, selectionRows, previousRow] = await Promise.all([
      this.client.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        include: { currentVersion: true },
      }),
      this.client.v2ProxyReview.findFirst({
        where: {
          id: input.proxyReviewId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
        },
      }),
      this.client.v2AssetSelection.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
          id: { in: [...input.assetSelectionIds] },
        },
      }),
      this.client.v2QualityIteration.findFirst({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
        },
        orderBy: { iteration: 'desc' },
        include: { assetSelections: true },
      }),
    ])
    if (!project || !proxyRow) return null
    if (
      !project.currentVersion ||
      !project.objective ||
      !project.format ||
      !project.locale ||
      selectionRows.length !== input.assetSelectionIds.length
    ) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Quality iteration requires current version, objective, format and exact evidence',
      )
    }
    const selectedArtifactIds = selectionRows
      .map((selection) => selection.selectedArtifactId)
      .filter((artifactId): artifactId is string => artifactId !== null)
    const artifacts = await this.client.v2MediaArtifact.findMany({
      where: {
        workspaceId: input.workspaceId,
        id: { in: selectedArtifactIds },
      },
      include: { currentRightsSnapshot: true },
    })
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
    const currentRightsByArtifact = new Map(
      selectedArtifactIds.map((artifactId) => {
        const snapshot = artifactById.get(artifactId)?.currentRightsSnapshot
        return [
          artifactId,
          snapshot ? hydrateAssetRights(snapshot) : null,
        ] as const
      }),
    )
    return Object.freeze({
      workspaceId: project.workspaceId,
      projectId: project.id,
      projectVersionId: project.currentVersion.id,
      projectVersionHash: project.currentVersion.baseHash,
      objective: project.objective,
      format: project.format,
      locale: project.locale,
      proxyReview: hydrateProxyReview(proxyRow),
      assetSelections: Object.freeze(selectionRows.map(hydrateAssetSelection)),
      currentRightsByArtifact,
      previousIteration: previousRow ? hydrateQualityIteration(previousRow) : null,
    })
  }

  async persist(
    iteration: Readonly<PersistedQualityIteration>,
    serializationAttempt = 1,
  ): ReturnType<QualityIterationRepository['persist']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const key = {
          workspaceId_projectId_idempotencyKey: {
            workspaceId: iteration.workspaceId,
            projectId: iteration.projectId,
            idempotencyKey: iteration.idempotencyKey,
          },
        }
        const existing = await transaction.v2QualityIteration.findUnique({
          where: key,
          include: { assetSelections: true },
        })
        if (existing) {
          if (existing.requestFingerprint !== iteration.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different quality iteration request',
            )
          }
          return Object.freeze({
            iteration: hydrateQualityIteration(existing),
            replayed: true,
          })
        }
        const [project, proxyReview, selections, rightsArtifacts, previous] = await Promise.all([
          transaction.v2Project.findFirst({
            where: { id: iteration.projectId, workspaceId: iteration.workspaceId },
            include: { currentVersion: true },
          }),
          transaction.v2ProxyReview.findFirst({
            where: {
              id: iteration.proxyEvidence.id,
              workspaceId: iteration.workspaceId,
              projectId: iteration.projectId,
              projectVersionId: iteration.projectVersionId,
            },
          }),
          transaction.v2AssetSelection.findMany({
            where: {
              workspaceId: iteration.workspaceId,
              projectId: iteration.projectId,
              projectVersionId: iteration.projectVersionId,
              id: { in: iteration.assetPlacements.map((item) => item.selectionId) },
            },
          }),
          transaction.v2MediaArtifact.findMany({
            where: {
              workspaceId: iteration.workspaceId,
              id: {
                in: iteration.assetPlacements.map(
                  (placement) => placement.selectedArtifactId,
                ),
              },
            },
            include: { currentRightsSnapshot: true },
          }),
          transaction.v2QualityIteration.findFirst({
            where: {
              workspaceId: iteration.workspaceId,
              projectId: iteration.projectId,
              projectVersionId: iteration.projectVersionId,
            },
            orderBy: { iteration: 'desc' },
            include: { assetSelections: true },
          }),
        ])
        if (
          !project?.currentVersion ||
          !project.locale ||
          project.currentVersion.id !== iteration.projectVersionId ||
          project.currentVersion.baseHash !== iteration.projectVersionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Project version changed before quality iteration commit',
          )
        }
        if (
          !proxyReview ||
          proxyReview.reviewHash !== iteration.proxyEvidence.reviewHash ||
          proxyReview.revision !== iteration.proxyEvidence.revision ||
          proxyReview.status !== iteration.proxyEvidence.status ||
          proxyReview.finalAllowed !== iteration.proxyEvidence.finalAllowed
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Proxy review changed before quality iteration commit',
          )
        }
        const selectionById = new Map(selections.map((selection) => [selection.id, selection]))
        if (
          selections.length !== iteration.assetPlacements.length ||
          iteration.assetPlacements.some((placement) =>
            selectionById.get(placement.selectionId)?.selectionHash !==
              placement.selectionHash)
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Asset selection changed before quality iteration commit',
          )
        }
        const rightsArtifactById = new Map(
          rightsArtifacts.map((artifact) => [artifact.id, artifact]),
        )
        for (const placement of iteration.assetPlacements) {
          const artifact = rightsArtifactById.get(placement.selectedArtifactId)
          const snapshot = artifact?.currentRightsSnapshot
            ? hydrateAssetRights(artifact.currentRightsSnapshot)
            : null
          const use = evaluateAssetUse(snapshot, {
            workspaceId: iteration.workspaceId,
            use: 'rendering',
            locale: project.locale,
          }, new Date(iteration.createdAt))
          if (
            !artifact ||
            (snapshot?.id ?? undefined) !== placement.rightsSnapshotId ||
            (snapshot?.snapshotHash ?? undefined) !== placement.rightsSnapshotHash ||
            (use.outcome === 'allow') !== placement.rightsApproved ||
            stableSerialize(use.reasonCodes) !==
              stableSerialize(placement.rightsReasonCodes)
          ) {
            throw new DomainError(
              'ASSET_RIGHTS_BLOCKED',
              'Asset rights changed before quality iteration commit',
              { artifactId: placement.selectedArtifactId },
            )
          }
        }
        const expectedPreviousId = previous?.id
        if (
          expectedPreviousId !== iteration.previousIterationId ||
          (previous?.iteration ?? 0) + 1 !== iteration.iteration
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Quality iteration sequence changed before commit',
          )
        }
        await transaction.v2QualityIteration.create({
          data: {
            id: iteration.id,
            workspaceId: iteration.workspaceId,
            projectId: iteration.projectId,
            projectVersionId: iteration.projectVersionId,
            projectVersionHash: iteration.projectVersionHash,
            iteration: iteration.iteration,
            previousIterationId: iteration.previousIterationId,
            proxyReviewId: iteration.proxyEvidence.id,
            proxyReviewHash: iteration.proxyEvidence.reviewHash,
            proxyReviewRevision: iteration.proxyEvidence.revision,
            proxyEvidenceJson: stableSerialize(iteration.proxyEvidence),
            assetPlacementsJson: stableSerialize(iteration.assetPlacements),
            rubricJson: stableSerialize(iteration.rubric),
            rangeMetricsJson: stableSerialize(iteration.rangeMetrics),
            datasetJson: stableSerialize(iteration.dataset),
            score: iteration.score,
            regression: iteration.regression,
            regressed: iteration.regressed,
            validationJson: stableSerialize(iteration.validation),
            issuesJson: stableSerialize(iteration.issues),
            patchesJson: stableSerialize(iteration.patches),
            rerenderRangesJson: stableSerialize(iteration.minimalRerenderRangesMs),
            fullRerenderRequired: iteration.fullRerenderRequired,
            budgetJson: stableSerialize(iteration.budget),
            decisionContinue: iteration.decision.continue,
            terminalReason: iteration.decision.terminalReason,
            reportFingerprint: iteration.reportFingerprint,
            recordHash: iteration.recordHash,
            idempotencyKey: iteration.idempotencyKey,
            requestFingerprint: iteration.requestFingerprint,
            createdByType: iteration.createdBy.type,
            createdById: iteration.createdBy.id,
            createdAt: new Date(iteration.createdAt),
          },
        })
        if (iteration.assetPlacements.length > 0) {
          await transaction.v2QualityIterationAssetSelection.createMany({
            data: iteration.assetPlacements.map((placement, ordinal) => ({
              qualityIterationId: iteration.id,
              workspaceId: iteration.workspaceId,
              assetSelectionId: placement.selectionId,
              selectionHash: placement.selectionHash,
              ordinal,
            })),
          })
        }
        const row = await transaction.v2QualityIteration.findUniqueOrThrow({
          where: { id: iteration.id },
          include: { assetSelections: true },
        })
        return Object.freeze({
          iteration: hydrateQualityIteration(row),
          replayed: false,
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) {
        return this.persist(iteration, serializationAttempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: iteration.workspaceId,
          projectId: iteration.projectId,
          idempotencyKey: iteration.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== iteration.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different quality iteration request',
            )
          }
          return Object.freeze({ iteration: replay, replayed: true })
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Quality iteration collided with persisted state',
        )
      }
      throw error
    }
  }

  async list(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    limit: number
  }) {
    const rows = await this.client.v2QualityIteration.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      include: { assetSelections: true },
    })
    return Object.freeze(rows.map(hydrateQualityIteration))
  }
}
