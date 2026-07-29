import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readProofModeRunService,
} from '@/v2/application/proof-mode'
import {
  createProofModeRepository,
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
  presentProofModeRun,
} from '@/v2/public-api/proof-mode-contract'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ projectId: string; runId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, runId } = await context.params
    const run = await readProofModeRunService({
      repository: createProofModeRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      runId,
    })
    return NextResponse.json(
      presentSuccess({ run: presentProofModeRun(run) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
