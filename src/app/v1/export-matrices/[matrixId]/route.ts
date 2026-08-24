import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readExportMatrixService } from '@/v2/application/export-matrices'
import { createExportMatrixRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ matrixId: string }> }): Promise<NextResponse> {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { matrixId } = await context.params
    const matrix = await readExportMatrixService({ matrices: createExportMatrixRepository() })({ workspaceId: actor.workspaceId, matrixId })
    return NextResponse.json(presentSuccess({ matrix }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
