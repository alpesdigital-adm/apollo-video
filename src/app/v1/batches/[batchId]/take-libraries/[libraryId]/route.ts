import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readTakeLibraryService,
} from '@/v2/application/take-libraries'
import {
  createTakeLibraryRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  presentTakeLibraryRun,
} from '@/v2/public-api/take-library-contract'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ batchId: string; libraryId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId, libraryId } = await context.params
    const library = await readTakeLibraryService({
      repository: createTakeLibraryRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      runId: libraryId,
    })
    return NextResponse.json(
      presentSuccess({
        library: presentTakeLibraryRun(library),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
