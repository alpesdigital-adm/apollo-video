import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createMusicMontageServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentMusicMontageRun } from '@/v2/public-api/music-led-montage-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; runId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, runId } = await context.params
    const run = await createMusicMontageServices().runs.findById(actor.workspaceId, projectId, runId)
    if (!run) throw new DomainError('PROJECT_NOT_FOUND', 'Music montage run was not found')
    return NextResponse.json(presentSuccess({ run: presentMusicMontageRun(run) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
