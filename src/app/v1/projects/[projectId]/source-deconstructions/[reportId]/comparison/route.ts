import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readSourceDeconstructionService,
} from '@/v2/application/source-deconstructions'
import {
  createSourceDeconstructionRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentSourceDeconstructionComparison,
} from '@/v2/public-api/source-deconstruction-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ projectId: string; reportId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, reportId } = await context.params
    const report = await readSourceDeconstructionService({
      repository: createSourceDeconstructionRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      reportId,
    })
    return NextResponse.json(
      presentSuccess({
        comparison: presentSourceDeconstructionComparison(report),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
