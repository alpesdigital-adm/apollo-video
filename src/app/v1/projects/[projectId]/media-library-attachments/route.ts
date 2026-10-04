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
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'baseVersionHash,baseVersionId,selection' || !('selection' in body) || !('baseVersionId' in body) || !('baseVersionHash' in body) || typeof body.baseVersionId !== 'string' || typeof body.baseVersionHash !== 'string' || typeof body.selection !== 'object' || body.selection === null || Array.isArray(body.selection)) {
      throw new DomainError('INVALID_ARGUMENT', 'Request must contain selection and the base project version')
    }
    const selection = body.selection as Record<string, unknown>
    if (selection.kind !== 'asset' && selection.kind !== 'segment') throw new DomainError('INVALID_ARGUMENT', 'Selection kind is invalid')
    if (Object.keys(selection).sort().join(',') !== [selection.kind === 'asset' ? 'artifactId' : 'segmentId', 'kind'].sort().join(',')) throw new DomainError('INVALID_ARGUMENT', 'Selection shape is invalid')
    const selectedId = selection.kind === 'asset' ? selection.artifactId : selection.segmentId
    if (typeof selectedId !== 'string') throw new DomainError('INVALID_ARGUMENT', 'Selection ID is invalid')
    const { projectId } = await context.params
    const reference = await attachMediaLibraryItemService({ repository: createMediaLibraryRepository() })({
      workspaceId: actor.workspaceId, projectId,
      selection: selection.kind === 'asset' ? { kind: 'asset', artifactId: selectedId } : { kind: 'segment', segmentId: selectedId },
      baseVersionId: body.baseVersionId, baseVersionHash: body.baseVersionHash,
      idempotencyKey: request.headers.get('idempotency-key') ?? '', actor,
    })
    return NextResponse.json(presentSuccess(reference), { status: reference.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
