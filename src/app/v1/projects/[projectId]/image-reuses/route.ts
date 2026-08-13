import { NextRequest, NextResponse } from 'next/server'

import { reuseImageArtifactService } from '@/v2/application/analyze-image-artifact'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import type { ImageUsage } from '@/v2/domain/image-library'
import { createImageAnalysisRepository } from '@/v2/infrastructure/repository-factory'
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
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'artifactId,query,usage') throw new DomainError('INVALID_ARGUMENT', 'Request body must contain only artifactId, query and usage')
    const value = body as Record<string, unknown>
    if (typeof value.artifactId !== 'string' || typeof value.query !== 'string' || typeof value.usage !== 'string') throw new DomainError('INVALID_ARGUMENT', 'Image reuse fields must be strings')
    const { projectId } = await context.params
    const reference = await reuseImageArtifactService({ repository: createImageAnalysisRepository() })({
      workspaceId: actor.workspaceId, projectId, artifactId: value.artifactId, usage: value.usage as ImageUsage, text: value.query,
    })
    return NextResponse.json(presentSuccess(reference), { status: reference.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
