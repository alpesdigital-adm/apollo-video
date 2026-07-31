import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readColorPipelineCompilationService } from '@/v2/application/color-pipeline-compilations'
import { createColorPipelineCompilationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentColorPipelineCompilation } from '@/v2/public-api/color-pipeline-compilation-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; compilationId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, compilationId } = await context.params
    const value = await readColorPipelineCompilationService({
      repository: createColorPipelineCompilationRepository(),
    })({ workspaceId: actor.workspaceId, projectId, compilationId })
    return NextResponse.json(
      presentSuccess({ compilation: presentColorPipelineCompilation(value) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
