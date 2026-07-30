import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readContiguousExtractionService,
} from '@/v2/application/contiguous-extraction'
import {
  createContiguousExtractionRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentContiguousExtraction,
} from '@/v2/public-api/contiguous-extraction-contract'
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
    params: Promise<{
      projectId: string
      extractionId: string
    }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, extractionId } = await context.params
    const extraction = await readContiguousExtractionService({
      repository: createContiguousExtractionRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      extractionId,
    })
    return NextResponse.json(
      presentSuccess({
        extraction: presentContiguousExtraction(extraction),
      }),
      {
        status: 200,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
