import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readManualTimelineService } from '@/v2/application/manual-edit'
import { DomainError } from '@/v2/domain/errors'
import { createManualEditRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const selectedClipId = request.nextUrl.searchParams.get('selectedClipId')?.trim()
    if (selectedClipId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selectedClipId)) {
      throw new DomainError('INVALID_ARGUMENT', 'selectedClipId is invalid')
    }
    const { projectId } = await context.params
    const result = await readManualTimelineService({
      repository: createManualEditRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(selectedClipId ? { selectedClipId } : {}),
    })
    return NextResponse.json(presentSuccess(result), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
