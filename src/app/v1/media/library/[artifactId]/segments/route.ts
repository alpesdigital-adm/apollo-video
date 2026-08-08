import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { createMediaSegmentService, listMediaSegmentsService } from '@/v2/application/media-segments'
import { DomainError } from '@/v2/domain/errors'
import { createMediaSegmentRepository } from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'artifacts:read')
    const { artifactId } = await context.params
    const result = await listMediaSegmentsService({ repository: createMediaSegmentRepository() })({ workspaceId: actor.workspaceId, artifactId })
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function POST(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'artifacts:write'); assertExternalMutationOrigin(request, actor)
    const body: unknown = await request.json().catch(() => { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new DomainError('INVALID_ARGUMENT', 'Media segment request must be an object')
    const value = body as Record<string, unknown>; const allowed = new Set(['parentSegmentId', 'label', 'description', 'startMs', 'endMs'])
    if (Object.keys(value).some((key) => !allowed.has(key)) || typeof value.label !== 'string' || (value.description !== undefined && typeof value.description !== 'string') || (value.parentSegmentId !== undefined && typeof value.parentSegmentId !== 'string') || !Number.isSafeInteger(value.startMs) || !Number.isSafeInteger(value.endMs)) throw new DomainError('INVALID_ARGUMENT', 'Media segment request fields are invalid')
    const { artifactId } = await context.params
    const result = await createMediaSegmentService({ repository: createMediaSegmentRepository() })({ workspaceId: actor.workspaceId, artifactId, ...(value.parentSegmentId ? { parentSegmentId: value.parentSegmentId as string } : {}), label: value.label, ...(value.description !== undefined ? { description: value.description as string } : {}), startMs: value.startMs as number, endMs: value.endMs as number })
    return NextResponse.json(presentSuccess(result.segment), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
