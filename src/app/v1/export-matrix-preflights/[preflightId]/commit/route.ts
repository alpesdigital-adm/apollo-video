import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { commitExportMatrixService } from '@/v2/application/export-matrices'
import { DomainError } from '@/v2/domain/errors'
import {
  createAssetRightsRepository,
  createColorPipelineCompilationRepository,
  createExportMatrixRepository,
  createProjectFinalExportRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import { createPreflightCommitTokenIssuerFromEnvironment } from '@/v2/infrastructure/security/preflight-commit-token'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ preflightId: string }> }): Promise<NextResponse> {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const body = await request.json() as Record<string, unknown>
    if (Object.keys(body).some((key) => !['commitToken', 'approval'].includes(key)) || typeof body.commitToken !== 'string' || !body.approval || typeof body.approval !== 'object' || Array.isArray(body.approval)) {
      throw new DomainError('INVALID_ARGUMENT', 'commitToken and approval are required')
    }
    const approval = body.approval as Record<string, unknown>
    if (Object.keys(approval).some((key) => !['approved', 'note'].includes(key)) || approval.approved !== true || (approval.note !== undefined && typeof approval.note !== 'string')) {
      throw new DomainError('INVALID_ARGUMENT', 'approval must explicitly confirm the export matrix')
    }
    const { preflightId } = await context.params
    const result = await commitExportMatrixService({
      matrices: createExportMatrixRepository(),
      projects: createProjectFinalExportRepository(),
      rights: createAssetRightsRepository(),
      operations: createPublicOperationRepository(),
      colorPipelines: createColorPipelineCompilationRepository(),
      tokenIssuer: createPreflightCommitTokenIssuerFromEnvironment(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      preflightId,
      commitToken: body.commitToken,
      approval: { approved: true, ...(typeof approval.note === 'string' ? { note: approval.note } : {}) },
      actor,
    })
    return NextResponse.json(presentSuccess(result), { status: 202, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
