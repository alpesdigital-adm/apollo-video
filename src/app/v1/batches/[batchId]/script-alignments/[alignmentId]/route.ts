import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readScriptAlignmentService,
} from '@/v2/application/script-alignments'
import {
  createScriptAlignmentRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  presentScriptAlignmentRun,
} from '@/v2/public-api/script-alignment-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ batchId: string; alignmentId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId, alignmentId } = await context.params
    const alignment = await readScriptAlignmentService({
      repository: createScriptAlignmentRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      runId: alignmentId,
    })
    return NextResponse.json(
      presentSuccess({
        alignment: presentScriptAlignmentRun(alignment),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
