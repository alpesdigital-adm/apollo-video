import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readArtifactInvalidationsService } from '@/v2/application/manual-edit'
import { DomainError } from '@/v2/domain/errors'
import { createManualEditRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  presentArtifactInvalidationViewV2,
  presentSuccess,
} from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const resultVersionId = request.nextUrl.searchParams.get('resultVersionId')?.trim()
    if (
      resultVersionId &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(resultVersionId)
    ) {
      throw new DomainError('INVALID_ARGUMENT', 'resultVersionId is invalid')
    }
    const { projectId } = await context.params
    const result = await readArtifactInvalidationsService({
      repository: createManualEditRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(resultVersionId ? { resultVersionId } : {}),
    })
    return NextResponse.json(presentSuccess(presentArtifactInvalidationViewV2(result)), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
