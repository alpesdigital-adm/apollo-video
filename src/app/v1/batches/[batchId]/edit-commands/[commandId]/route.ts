import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readBatchEditCommandService,
} from '@/v2/application/batch-edits'
import {
  createBatchEditRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  presentBatchEditCommand,
} from '@/v2/public-api/batch-edit-contract'
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
    params: Promise<{ batchId: string; commandId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId, commandId } = await context.params
    const command = await readBatchEditCommandService({
      repository: createBatchEditRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      commandId,
    })
    return NextResponse.json(
      presentSuccess({
        command: presentBatchEditCommand(command),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
