import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { attachMediaLibraryItemService } from '@/v2/application/media-library'
import { DomainError } from '@/v2/domain/errors'
import { createMediaLibraryRepository } from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    assertExternalMutationOrigin(request, actor)
    const body: unknown = await request.json().catch(() => { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') })
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || !('artifactId' in body) || typeof body.artifactId !== 'string') {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must contain only artifactId')
    }
    const { projectId } = await context.params
    const reference = await attachMediaLibraryItemService({ repository: createMediaLibraryRepository() })({
      workspaceId: actor.workspaceId, projectId, artifactId: body.artifactId,
    })
    return NextResponse.json(presentSuccess(reference), { status: reference.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
