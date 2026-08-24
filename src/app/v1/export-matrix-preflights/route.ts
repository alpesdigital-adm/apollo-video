import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { createExportMatrixPreflightService } from '@/v2/application/export-matrices'
import { DomainError } from '@/v2/domain/errors'
import { createExportMatrixCapacityProviderFromEnvironment } from '@/v2/infrastructure/export-matrix-capacity'
import {
  createAssetRightsRepository,
  createColorPipelineCompilationRepository,
  createExportMatrixRepository,
  createProjectFinalExportRepository,
} from '@/v2/infrastructure/repository-factory'
import { createPreflightCommitTokenIssuerFromEnvironment } from '@/v2/infrastructure/security/preflight-commit-token'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const body = await request.json() as Record<string, unknown>
    if (Object.keys(body).some((key) => !['cells', 'limits'].includes(key)) || !Array.isArray(body.cells) || !body.limits || typeof body.limits !== 'object' || Array.isArray(body.limits)) {
      throw new DomainError('INVALID_ARGUMENT', 'cells and limits are required')
    }
    const limits = body.limits as Record<string, unknown>
    if (Object.keys(limits).some((key) => !['maximumCostMinorUnits', 'maximumStorageBytes'].includes(key)) || !Number.isSafeInteger(limits.maximumCostMinorUnits) || !Number.isSafeInteger(limits.maximumStorageBytes)) {
      throw new DomainError('INVALID_ARGUMENT', 'limits are invalid')
    }
    const cells = body.cells.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', 'Export matrix cell is invalid')
      const cell = value as Record<string, unknown>
      if (Object.keys(cell).some((key) => !['recipeId', 'projectId', 'projectVersionId', 'projectVersionHash', 'format', 'locale'].includes(key)) ||
        !['recipeId', 'projectId', 'projectVersionId', 'projectVersionHash', 'format', 'locale'].every((key) => typeof cell[key] === 'string')) {
        throw new DomainError('INVALID_ARGUMENT', 'Export matrix cell fields are invalid')
      }
      return cell as unknown as { recipeId: string; projectId: string; projectVersionId: string; projectVersionHash: string; format: '9:16' | '16:9' | '4:5' | '1:1' | '21:9'; locale: string }
    })
    const result = await createExportMatrixPreflightService({
      matrices: createExportMatrixRepository(),
      projects: createProjectFinalExportRepository(),
      rights: createAssetRightsRepository(),
      colorPipelines: createColorPipelineCompilationRepository(),
      capacity: createExportMatrixCapacityProviderFromEnvironment(),
      tokenIssuer: createPreflightCommitTokenIssuerFromEnvironment(),
      clock: () => new Date(),
      createPreflightId: () => `preflight-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      cells,
      requestedMaximumCostMinorUnits: limits.maximumCostMinorUnits as number,
      requestedMaximumStorageBytes: limits.maximumStorageBytes as number,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(presentSuccess({
      preflightId: result.record.id,
      preflight: result.record.preflight,
      ...(result.commitToken ? { commitToken: result.commitToken } : {}),
      replayed: result.replayed,
    }), { status: 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
