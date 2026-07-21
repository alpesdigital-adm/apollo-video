import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { resolveRenderElementsService } from '@/v2/application/resolve-render-elements'
import { DomainError } from '@/v2/domain/errors'
import { createRenderElementMapRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function requiredText(request: NextRequest, name: string): string {
  const value = request.nextUrl.searchParams.get(name)?.trim()
  if (!value) throw new DomainError('INVALID_ARGUMENT', `${name} is required`)
  return value
}

function requiredNumber(request: NextRequest, name: string): number {
  const raw = request.nextUrl.searchParams.get(name)
  const value = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(value)) throw new DomainError('INVALID_ARGUMENT', `${name} must be a finite number`)
  return value
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const result = await resolveRenderElementsService({ repository: createRenderElementMapRepository() })({
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId: requiredText(request, 'projectVersionId'),
      proxyArtifactId: requiredText(request, 'proxyArtifactId'),
      proxyHash: requiredText(request, 'proxyHash'),
      frame: requiredNumber(request, 'frame'),
      x: requiredNumber(request, 'x'),
      y: requiredNumber(request, 'y'),
      displayWidth: requiredNumber(request, 'displayWidth'),
      displayHeight: requiredNumber(request, 'displayHeight'),
    })
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
