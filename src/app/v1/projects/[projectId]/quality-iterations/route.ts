import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import type { ProxyRangeMetric } from '@/v2/application/closed-quality-loop'
import type { PersistedQualityIteration } from '@/v2/application/ports/quality-iteration-repository'
import {
  listQualityIterationsService,
  runQualityIterationService,
  type QualityAssetPlacementInput,
  type QualityRubricEvidenceInput,
} from '@/v2/application/run-quality-iteration'
import { DomainError } from '@/v2/domain/errors'
import { createQualityIterationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function strictRecord(
  value: unknown,
  allowed: readonly string[],
  field: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains an unsupported field`)
  }
  return record
}

function parseBody(value: unknown): {
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
} {
  const body = strictRecord(
    value,
    [
      'projectVersionId',
      'projectVersionHash',
      'proxyReviewId',
      'proxyReviewHash',
      'expectedProxyReviewRevision',
      'assetPlacements',
      'rubricEvidence',
      'rangeMetrics',
      'datasetId',
      'datasetVersion',
      'budgetLimitUnits',
    ],
    'Request body',
  )
  if (
    typeof body.projectVersionId !== 'string' ||
    typeof body.projectVersionHash !== 'string' ||
    typeof body.proxyReviewId !== 'string' ||
    typeof body.proxyReviewHash !== 'string' ||
    typeof body.expectedProxyReviewRevision !== 'number' ||
    !Array.isArray(body.assetPlacements) ||
    !Array.isArray(body.rubricEvidence) ||
    !Array.isArray(body.rangeMetrics) ||
    typeof body.datasetId !== 'string' ||
    typeof body.datasetVersion !== 'number' ||
    typeof body.budgetLimitUnits !== 'number'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Quality iteration request is incomplete',
    )
  }
  const assetPlacements = body.assetPlacements.map((value, index) =>
    strictRecord(
      value,
      ['selectionId', 'startMs', 'endMs'],
      `assetPlacements[${index}]`,
    ))
  const rubricEvidence = body.rubricEvidence.map((value, index) =>
    strictRecord(
      value,
      ['criterionId', 'score', 'evidence'],
      `rubricEvidence[${index}]`,
    ))
  const rangeMetrics = body.rangeMetrics.map((value, index) =>
    strictRecord(
      value,
      ['startMs', 'endMs', 'density'],
      `rangeMetrics[${index}]`,
    ))
  return {
    projectVersionId: body.projectVersionId,
    projectVersionHash: body.projectVersionHash,
    proxyReviewId: body.proxyReviewId,
    proxyReviewHash: body.proxyReviewHash,
    expectedProxyReviewRevision: body.expectedProxyReviewRevision,
    assetPlacements:
      assetPlacements as unknown as readonly QualityAssetPlacementInput[],
    rubricEvidence:
      rubricEvidence as unknown as readonly QualityRubricEvidenceInput[],
    rangeMetrics: rangeMetrics as unknown as readonly ProxyRangeMetric[],
    datasetId: body.datasetId,
    datasetVersion: body.datasetVersion,
    budgetLimitUnits: body.budgetLimitUnits,
  }
}

function presentIteration(iteration: Readonly<PersistedQualityIteration>) {
  return {
    schemaVersion: iteration.schemaVersion,
    id: iteration.id,
    projectId: iteration.projectId,
    projectVersionId: iteration.projectVersionId,
    projectVersionHash: iteration.projectVersionHash,
    iteration: iteration.iteration,
    previousIterationId: iteration.previousIterationId ?? null,
    proxyEvidence: iteration.proxyEvidence,
    assetPlacements: iteration.assetPlacements,
    rubric: iteration.rubric,
    rangeMetrics: iteration.rangeMetrics,
    dataset: iteration.dataset,
    score: iteration.score,
    regression: iteration.regression,
    regressed: iteration.regressed,
    validation: iteration.validation,
    issues: iteration.issues,
    patches: iteration.patches,
    minimalRerenderRangesMs: iteration.minimalRerenderRangesMs,
    fullRerenderRequired: iteration.fullRerenderRequired,
    budget: iteration.budget,
    decision: iteration.decision,
    reportFingerprint: iteration.reportFingerprint,
    recordHash: iteration.recordHash,
    createdBy: iteration.createdBy,
    createdAt: iteration.createdAt,
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const projectVersionId =
      request.nextUrl.searchParams.get('projectVersionId')?.trim() || undefined
    const limitValue = request.nextUrl.searchParams.get('limit')
    const limit = limitValue === null ? undefined : Number(limitValue)
    const iterations = await listQualityIterationsService({
      iterations: createQualityIterationRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(projectVersionId ? { projectVersionId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    })
    return NextResponse.json(
      presentSuccess({ iterations: iterations.map(presentIteration) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseBody(raw)
    const { projectId } = await context.params
    const result = await runQualityIterationService({
      iterations: createQualityIterationRepository(),
      clock: () => new Date(),
      createId: () => `quality-iteration-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor: actor.auditContext.actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        iteration: presentIteration(result.iteration),
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
