import {
  compileQualityPatches,
  createQualityReport,
  critiqueAsset,
  critiqueProxy,
  decideQualityIteration,
  validateQuality,
  type ProxyRangeMetric,
  type QualityIssue,
} from './closed-quality-loop.ts'
import type {
  PersistedQualityIteration,
  QualityAssetPlacementEvidence,
  QualityIterationRepository,
  QualityRubricEvidence,
} from './ports/quality-iteration-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  STRATEGIC_RUBRIC_REFERENCE_SET,
  createQualityReport as createStrategicQualityReport,
  resolveStrategicRubric,
} from '../domain/strategic-rubric.ts'
import {
  STRATEGIC_OBJECTIVES,
  type StrategicObjectiveId,
} from '../domain/strategic-objective.ts'
import type { ProxyOutputFormat } from './render-workflow.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY_PATTERN = /^[\x21-\x7E]{8,128}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/

export interface QualityAssetPlacementInput {
  selectionId: string
  startMs: number
  endMs: number
}

export interface QualityRubricEvidenceInput {
  criterionId: string
  score: number
  evidence: readonly string[]
}

function identity(value: string, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} must be a string`)
  const normalized = value.trim()
  assertDomain(ID_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function sha256(value: string, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} must be a string`)
  const normalized = value.trim().toLowerCase()
  assertDomain(SHA_256_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field} must be a SHA-256 hash`)
  return normalized
}

function idempotencyKey(value: string): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', 'Idempotency-Key must be a string')
  const normalized = value.trim()
  assertDomain(
    IDEMPOTENCY_PATTERN.test(normalized),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return normalized
}

function normalizePlacements(
  values: readonly QualityAssetPlacementInput[],
): readonly Readonly<QualityAssetPlacementInput>[] {
  assertDomain(
    Array.isArray(values) && values.length <= 100,
    'INVALID_ARGUMENT',
    'assetPlacements must contain at most 100 entries',
  )
  const normalized = values.map((value, index) => {
    assertDomain(
      typeof value === 'object' && value !== null && !Array.isArray(value),
      'INVALID_ARGUMENT',
      `assetPlacements[${index}] must be an object`,
    )
    assertDomain(
      Number.isSafeInteger(value.startMs) &&
        value.startMs >= 0 &&
        Number.isSafeInteger(value.endMs) &&
        value.endMs > value.startMs,
      'INVALID_ARGUMENT',
      `assetPlacements[${index}] range is invalid`,
    )
    return Object.freeze({
      selectionId: identity(value.selectionId, `assetPlacements[${index}].selectionId`),
      startMs: value.startMs,
      endMs: value.endMs,
    })
  }).sort((left, right) =>
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.selectionId.localeCompare(right.selectionId))
  assertDomain(
    new Set(normalized.map((value) => value.selectionId)).size === normalized.length,
    'INVALID_ARGUMENT',
    'assetPlacements selection identities must be unique',
  )
  return Object.freeze(normalized)
}

function normalizeRangeMetrics(
  values: readonly ProxyRangeMetric[],
): readonly Readonly<ProxyRangeMetric>[] {
  assertDomain(
    Array.isArray(values) && values.length <= 200,
    'INVALID_ARGUMENT',
    'rangeMetrics must contain at most 200 entries',
  )
  const normalized = values.map((value, index) => {
    assertDomain(
      typeof value === 'object' && value !== null && !Array.isArray(value),
      'INVALID_ARGUMENT',
      `rangeMetrics[${index}] must be an object`,
    )
    assertDomain(
      Number.isSafeInteger(value.startMs) &&
        value.startMs >= 0 &&
        Number.isSafeInteger(value.endMs) &&
        value.endMs > value.startMs &&
        typeof value.density === 'number' &&
        Number.isFinite(value.density) &&
        value.density >= 0 &&
        value.density <= 1,
      'INVALID_ARGUMENT',
      `rangeMetrics[${index}] is invalid`,
    )
    return Object.freeze({
      startMs: value.startMs,
      endMs: value.endMs,
      density: value.density,
    })
  }).sort((left, right) =>
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.density - right.density)
  return Object.freeze(normalized)
}

function normalizeRubricEvidence(
  objective: StrategicObjectiveId,
  values: readonly QualityRubricEvidenceInput[],
): readonly Readonly<QualityRubricEvidence>[] {
  assertDomain(Array.isArray(values), 'INVALID_ARGUMENT', 'rubricEvidence must be an array')
  const rubric = resolveStrategicRubric(objective)
  const expected = new Set(rubric.criteria.map((criterion) => criterion.id))
  const normalized = values.map((value, index) => {
    assertDomain(
      typeof value === 'object' && value !== null && !Array.isArray(value),
      'INVALID_ARGUMENT',
      `rubricEvidence[${index}] must be an object`,
    )
    const criterionId = value.criterionId?.trim()
    assertDomain(
      typeof criterionId === 'string' && expected.has(criterionId as never),
      'INVALID_ARGUMENT',
      `rubricEvidence[${index}].criterionId is not part of the current rubric`,
    )
    assertDomain(
      typeof value.score === 'number' &&
        Number.isFinite(value.score) &&
        value.score >= 0 &&
        value.score <= 100,
      'INVALID_ARGUMENT',
      `rubricEvidence[${index}].score must be between 0 and 100`,
    )
    assertDomain(
      Array.isArray(value.evidence) &&
        value.evidence.length >= 1 &&
        value.evidence.length <= 20,
      'INVALID_ARGUMENT',
      `rubricEvidence[${index}].evidence must contain 1 to 20 entries`,
    )
    const evidence = value.evidence.map((item: string, evidenceIndex: number) => {
      assertDomain(
        typeof item === 'string' &&
          item.trim().length >= 1 &&
          item.trim().length <= 500,
        'INVALID_ARGUMENT',
        `rubricEvidence[${index}].evidence[${evidenceIndex}] is invalid`,
      )
      return item.trim()
    })
    return Object.freeze({
      criterionId,
      score: Number(value.score.toFixed(2)),
      evidence: Object.freeze(evidence),
    })
  }).sort((left, right) => left.criterionId.localeCompare(right.criterionId))
  assertDomain(
    normalized.length === expected.size &&
      new Set(normalized.map((value) => value.criterionId)).size === expected.size,
    'INVALID_ARGUMENT',
    'rubricEvidence must contain every current rubric criterion exactly once',
  )
  return Object.freeze(normalized)
}

function importedProxyIssue(issue: {
  code: string
  severity: 'hard' | 'warning'
  category: 'technical' | 'policy' | 'integrity' | 'editorial'
  message: string
  rangeMs?: readonly [number, number]
  targetId?: string
  correctable: boolean
}): Readonly<QualityIssue> {
  return Object.freeze({
    code: issue.code,
    severity: issue.severity,
    category: issue.category,
    message: issue.message,
    ...(issue.rangeMs ? { rangeMs: Object.freeze([...issue.rangeMs] as [number, number]) } : {}),
    ...(issue.targetId ? { targetId: issue.targetId } : {}),
    correctable: issue.correctable,
  })
}

export function resolveQualityReferenceDataset(objective: StrategicObjectiveId) {
  const rubric = resolveStrategicRubric(objective)
  const references = STRATEGIC_RUBRIC_REFERENCE_SET
    .filter((reference) => reference.objective === objective)
    .map((reference) => ({
      id: reference.id,
      quality: reference.quality,
      expectedBand: reference.expectedBand,
    }))
  const content = Object.freeze({
    schemaVersion: 'quality-reference-dataset/v1' as const,
    id: `apollo-${objective}-reference`,
    version: 1,
    objective,
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    baselineScore: rubric.threshold,
    references,
  })
  return Object.freeze({
    id: content.id,
    version: content.version,
    baselineScore: content.baselineScore,
    fingerprint: calculateCanonicalHash(content),
  })
}

export function calculateQualityIterationRecordHash(
  iteration: Omit<PersistedQualityIteration, 'recordHash'>,
): string {
  return calculateCanonicalHash(iteration)
}

type QualityReportFingerprintInput = Pick<
  PersistedQualityIteration,
  | 'projectVersionId'
  | 'projectVersionHash'
  | 'iteration'
  | 'previousIterationId'
  | 'proxyEvidence'
  | 'assetPlacements'
  | 'rubric'
  | 'rangeMetrics'
  | 'dataset'
  | 'score'
  | 'regression'
  | 'regressed'
  | 'validation'
  | 'issues'
  | 'patches'
  | 'minimalRerenderRangesMs'
  | 'fullRerenderRequired'
  | 'budget'
  | 'decision'
>

export function calculateClosedQualityReportFingerprint(
  input: QualityReportFingerprintInput,
): string {
  return calculateCanonicalHash({
    schemaVersion: 'closed-quality-report/v1',
    ...input,
  })
}

export function runQualityIterationService(dependencies: {
  iterations: QualityIterationRepository
  clock: () => Date
  createId: () => string
}) {
  return async function run(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    proxyReviewId: string
    proxyReviewHash: string
    expectedProxyReviewRevision: number
    assetPlacements: readonly QualityAssetPlacementInput[]
    rubricEvidence: readonly QualityRubricEvidenceInput[]
    rangeMetrics: readonly ProxyRangeMetric[]
    datasetId: string
    datasetVersion: number
    budgetLimitUnits: number
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = identity(request.projectVersionId, 'projectVersionId')
    const projectVersionHash = sha256(request.projectVersionHash, 'projectVersionHash')
    const proxyReviewId = identity(request.proxyReviewId, 'proxyReviewId')
    const proxyReviewHash = sha256(request.proxyReviewHash, 'proxyReviewHash')
    assertDomain(
      Number.isSafeInteger(request.expectedProxyReviewRevision) &&
        request.expectedProxyReviewRevision >= 1,
      'INVALID_ARGUMENT',
      'expectedProxyReviewRevision must be a positive integer',
    )
    assertDomain(
      Number.isSafeInteger(request.datasetVersion) && request.datasetVersion >= 1,
      'INVALID_ARGUMENT',
      'datasetVersion must be a positive integer',
    )
    assertDomain(
      Number.isSafeInteger(request.budgetLimitUnits) &&
        request.budgetLimitUnits >= 1 &&
        request.budgetLimitUnits <= 1_000,
      'INVALID_ARGUMENT',
      'budgetLimitUnits must be between 1 and 1000',
    )
    assertDomain(
      request.actor.type === 'api-client',
      'INVALID_ARGUMENT',
      'Quality iteration actor is invalid',
    )
    const actorId = identity(request.actor.id, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const placements = normalizePlacements(request.assetPlacements)
    const rangeMetrics = normalizeRangeMetrics(request.rangeMetrics)
    const rawRubricEvidence = Array.isArray(request.rubricEvidence)
      ? request.rubricEvidence
      : []
    const datasetId = identity(request.datasetId, 'datasetId')
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'quality-iteration-request/v1',
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
      proxyReviewId,
      proxyReviewHash,
      expectedProxyReviewRevision: request.expectedProxyReviewRevision,
      assetPlacements: placements,
      rubricEvidence: rawRubricEvidence,
      rangeMetrics,
      datasetId,
      datasetVersion: request.datasetVersion,
      budgetLimitUnits: request.budgetLimitUnits,
      actor: { type: 'api-client', id: actorId },
    })
    const replay = await dependencies.iterations.findIdempotent({
      workspaceId,
      projectId,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different quality iteration request',
        )
      }
      return Object.freeze({ iteration: replay, replayed: true })
    }

    const context = await dependencies.iterations.readContext({
      workspaceId,
      projectId,
      projectVersionId,
      proxyReviewId,
      assetSelectionIds: placements.map((placement) => placement.selectionId),
    })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project or quality evidence was not found')
    if (
      context.projectVersionId !== projectVersionId ||
      context.projectVersionHash !== projectVersionHash
    ) {
      throw new DomainError('VERSION_CONFLICT', 'Quality iteration base version is stale', {
        currentVersionId: context.projectVersionId,
        currentVersionHash: context.projectVersionHash,
      })
    }
    if (
      context.proxyReview.reviewHash !== proxyReviewHash ||
      context.proxyReview.revision !== request.expectedProxyReviewRevision ||
      context.proxyReview.projectVersionId !== projectVersionId
    ) {
      throw new DomainError('VERSION_CONFLICT', 'Proxy review changed before quality evaluation', {
        currentReviewHash: context.proxyReview.reviewHash,
        currentRevision: context.proxyReview.revision,
      })
    }
    const objective = context.objective as StrategicObjectiveId
    assertDomain(
      STRATEGIC_OBJECTIVES.some((candidate) => candidate.id === objective),
      'PRECONDITION_REQUIRED',
      'Project objective is required for quality evaluation',
    )
    const format = context.format as ProxyOutputFormat
    assertDomain(
      ['9:16', '16:9', '4:5', '1:1', '21:9'].includes(format),
      'PRECONDITION_REQUIRED',
      'Project output format is required for quality evaluation',
    )
    const rubricEvidence = normalizeRubricEvidence(objective, rawRubricEvidence)
    const evaluatedAt = dependencies.clock()
    assertDomain(
      !Number.isNaN(evaluatedAt.getTime()),
      'INVALID_ARGUMENT',
      'Quality iteration clock is invalid',
    )
    const dataset = resolveQualityReferenceDataset(objective)
    if (dataset.id !== datasetId || dataset.version !== request.datasetVersion) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Requested quality reference dataset is not current for the project objective',
        {
          currentDatasetId: dataset.id,
          currentDatasetVersion: dataset.version,
          currentDatasetFingerprint: dataset.fingerprint,
        },
      )
    }
    if (
      context.previousIteration &&
      context.previousIteration.budget.limitUnits !== request.budgetLimitUnits
    ) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Quality iteration budget cannot change inside one project version',
      )
    }
    if (
      context.previousIteration?.decision.terminalReason &&
      context.previousIteration.proxyEvidence.reviewHash === proxyReviewHash
    ) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Terminal quality iteration requires new immutable proxy evidence',
      )
    }

    const assetSelectionById = new Map(
      context.assetSelections.map((selection) => [selection.id, selection]),
    )
    const assetPlacements: Readonly<QualityAssetPlacementEvidence>[] = placements.map(
      (placement) => {
        const selection = assetSelectionById.get(placement.selectionId)
        if (
          !selection ||
          selection.projectVersionId !== projectVersionId ||
          selection.projectVersionHash !== projectVersionHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Asset selection does not belong to the exact quality project version',
            { selectionId: placement.selectionId },
          )
        }
        if (
          selection.result.decision !== 'use_asset' ||
          !selection.result.selectedId ||
          !selection.result.source
        ) {
          throw new DomainError(
            'PRECONDITION_REQUIRED',
            'A no-insert asset selection cannot be placed into a quality iteration',
            { selectionId: placement.selectionId },
          )
        }
        const evaluation = selection.result.evaluations.find(
          (candidate) => candidate.candidateId === selection.result.selectedId,
        )
        const selectedCandidate = selection.candidates.find(
          (candidate) => candidate.id === selection.result.selectedId,
        )
        const rights = selection.rightsEvidence.find(
          (candidate) => candidate.artifactId === selection.result.selectedId,
        )
        if (!evaluation || !selectedCandidate || !rights) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Selected asset lost its quality or rights evidence',
          )
        }
        const currentRights = context.currentRightsByArtifact.get(
          selection.result.selectedId,
        ) ?? null
        const currentUse = evaluateAssetUse(currentRights, {
          workspaceId,
          use: 'rendering',
          locale: context.locale,
        }, evaluatedAt)
        return Object.freeze({
          selectionId: selection.id,
          selectionHash: selection.selectionHash,
          rangeMs: Object.freeze([placement.startMs, placement.endMs] as const),
          selectedArtifactId: selection.result.selectedId,
          selectedSource: selection.result.source,
          relevance: evaluation.dimensions.relevance,
          continuity: evaluation.dimensions.continuity,
          quality: evaluation.dimensions.quality,
          novelty: selectedCandidate.novelty,
          rightsApproved: currentUse.outcome === 'allow',
          rightsReasonCodes: currentUse.reasonCodes,
          ...(currentRights
            ? {
                rightsSnapshotId: currentRights.id,
                rightsSnapshotHash: currentRights.snapshotHash,
              }
            : {}),
        })
      },
    )
    const assetIssues = assetPlacements.flatMap((placement) =>
      critiqueAsset({
        relevance: placement.relevance,
        continuity: placement.continuity,
        quality: placement.quality,
        rightsApproved: placement.rightsApproved,
        novelty: placement.novelty,
        rangeMs: placement.rangeMs,
        assetId: placement.selectedArtifactId,
      }))
    const importedIssues = [
      ...context.proxyReview.technicalIssues,
      ...context.proxyReview.criticIssues,
    ].map(importedProxyIssue)
    const proxyCriticIssues = critiqueProxy({
      format,
      spec: context.proxyReview.spec,
      rubric: Object.fromEntries(
        rubricEvidence.map((evidence) => [evidence.criterionId, evidence.score / 100]),
      ),
      ranges: rangeMetrics,
    })
    const technical = importedIssues.filter((issue) => issue.category === 'technical')
    const policy = importedIssues.filter((issue) => issue.category === 'policy')
    const integrity = importedIssues.filter((issue) => issue.category === 'integrity')
    const validation = validateQuality({
      technical,
      policy,
      integrity,
      assets: assetIssues,
      proxy: [
        ...importedIssues.filter((issue) => !['technical', 'policy', 'integrity'].includes(issue.category)),
        ...proxyCriticIssues,
      ],
    })
    const patches = compileQualityPatches(validation.issues)
    const rubric = resolveStrategicRubric(objective)
    const hasHardCode = (fragment: string) =>
      validation.hardIssues.some((issue) => issue.code.includes(fragment))
    const strategicReport = createStrategicQualityReport({
      objective,
      evidence: rubricEvidence as never,
      gates: {
        narrativeIntegrity: !validation.hardIssues.some((issue) => issue.category === 'integrity'),
        legibility: !hasHardCode('LEGIBILITY') && !hasHardCode('SUBTITLE'),
        rights: !validation.hardIssues.some((issue) => issue.category === 'policy'),
        ctaPresent:
          !rubric.requiredGates.includes('cta-required') ||
          (rubricEvidence.find((evidence) => evidence.criterionId === 'cta-clarity')?.score ?? 0) > 0,
      },
      evaluatedAt: evaluatedAt.toISOString(),
    })
    const report = createQualityReport({
      versionId: projectVersionId,
      datasetId: dataset.id,
      score: strategicReport.score,
      baselineScore: dataset.baselineScore,
      issues: validation.issues,
    })
    const previous = context.previousIteration
    const iterationNumber = (previous?.iteration ?? 0) + 1
    const iterationCostUnits =
      patches.patches.length + (patches.fullRerenderRequired ? 2 : 0)
    const consumedUnits = Math.min(
      request.budgetLimitUnits,
      (previous?.budget.consumedUnits ?? 0) + iterationCostUnits,
    )
    const remainingUnits = request.budgetLimitUnits - consumedUnits
    const scoreDelta = previous
      ? Number((strategicReport.score - previous.score).toFixed(4))
      : Number((strategicReport.score - dataset.baselineScore).toFixed(4))
    const approved =
      validation.valid &&
      strategicReport.passed &&
      context.proxyReview.finalAllowed
    const decision = decideQualityIteration({
      approved,
      scoreDelta,
      remainingBudget: remainingUnits,
      issues: validation.issues,
      iteration: iterationNumber,
    })
    const createdAtDate = evaluatedAt
    const id = identity(dependencies.createId(), 'qualityIteration.id')
    const proxyEvidence = Object.freeze({
      id: context.proxyReview.id,
      reviewHash: context.proxyReview.reviewHash,
      revision: context.proxyReview.revision,
      status: context.proxyReview.status,
      finalAllowed: context.proxyReview.finalAllowed,
      spec: context.proxyReview.spec,
      technicalIssues: Object.freeze(
        context.proxyReview.technicalIssues.map(importedProxyIssue),
      ),
      criticIssues: Object.freeze(
        context.proxyReview.criticIssues.map(importedProxyIssue),
      ),
    })
    const rubricSnapshot = Object.freeze({
      id: rubric.id,
      version: rubric.version,
      objective,
      threshold: rubric.threshold,
      evidence: rubricEvidence,
    })
    const validationSnapshot = Object.freeze({
      valid: validation.valid,
      finalBlocked: validation.finalBlocked,
      hardIssueCount: validation.hardIssues.length,
      warningIssueCount: validation.warningIssues.length,
      hardByCategory: validation.hardByCategory,
    })
    const budget = Object.freeze({
      limitUnits: request.budgetLimitUnits,
      consumedUnits,
      remainingUnits,
      iterationCostUnits,
    })
    const reportFingerprint = calculateClosedQualityReportFingerprint({
      projectVersionId,
      projectVersionHash,
      iteration: iterationNumber,
      ...(previous ? { previousIterationId: previous.id } : {}),
      proxyEvidence,
      assetPlacements: Object.freeze(assetPlacements),
      rubric: rubricSnapshot,
      rangeMetrics,
      dataset,
      score: strategicReport.score,
      regression: report.regression,
      regressed: report.regressed,
      validation: validationSnapshot,
      issues: validation.issues,
      patches: patches.patches,
      minimalRerenderRangesMs: patches.minimalRerenderRangesMs,
      fullRerenderRequired: patches.fullRerenderRequired,
      budget,
      decision,
    })
    const content: Omit<PersistedQualityIteration, 'recordHash'> = Object.freeze({
      schemaVersion: 'quality-iteration/v1',
      id,
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
      iteration: iterationNumber,
      ...(previous ? { previousIterationId: previous.id } : {}),
      proxyEvidence,
      assetPlacements: Object.freeze(assetPlacements),
      rubric: rubricSnapshot,
      rangeMetrics,
      dataset,
      score: strategicReport.score,
      regression: report.regression,
      regressed: report.regressed,
      validation: validationSnapshot,
      issues: validation.issues,
      patches: patches.patches,
      minimalRerenderRangesMs: patches.minimalRerenderRangesMs,
      fullRerenderRequired: patches.fullRerenderRequired,
      budget,
      decision,
      reportFingerprint,
      idempotencyKey: key,
      requestFingerprint,
      createdBy: Object.freeze({ type: 'api-client', id: actorId }),
      createdAt: createdAtDate.toISOString(),
    })
    const iteration: PersistedQualityIteration = Object.freeze({
      ...content,
      recordHash: calculateQualityIterationRecordHash(content),
    })
    return dependencies.iterations.persist(iteration)
  }
}

export function listQualityIterationsService(dependencies: {
  iterations: QualityIterationRepository
}) {
  return async function list(request: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    limit?: number
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = request.projectVersionId
      ? identity(request.projectVersionId, 'projectVersionId')
      : undefined
    const limit = request.limit ?? 50
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be between 1 and 100',
    )
    return dependencies.iterations.list({
      workspaceId,
      projectId,
      ...(projectVersionId ? { projectVersionId } : {}),
      limit,
    })
  }
}
