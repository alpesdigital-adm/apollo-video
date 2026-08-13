import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readMontageAlternativeRunService } from '@/v2/application/select-montage-candidate'
import { createMontageAlternativeRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentMontageAlternativeRun } from '@/v2/public-api/montage-alternative-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; runId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, runId } = await context.params
    const run = await readMontageAlternativeRunService({ repository: createMontageAlternativeRepository() })({ workspaceId: actor.workspaceId, projectId, runId })
    return NextResponse.json(presentSuccess({ run: presentMontageAlternativeRun(run) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
