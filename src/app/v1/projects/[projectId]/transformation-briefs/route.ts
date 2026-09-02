import { NextRequest, NextResponse } from 'next/server'

import { persistTransformationBriefService } from '@/v2/application/transformation-provider-registry'
import { DomainError } from '@/v2/domain/errors'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { createTransformationBrief } from '@/v2/domain/transformation-brief'
import { createTransformationProviderRegistryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseCreateTransformationBriefBody, presentTransformationBrief } from '@/v2/public-api/transformation-brief-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const projectVersionId = request.nextUrl.searchParams.get('projectVersionId')?.trim() || undefined
    const briefs = await createTransformationProviderRegistryRepository().listBriefs({
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId,
    })
    return NextResponse.json(presentSuccess({ briefs: briefs.map(presentTransformationBrief) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseCreateTransformationBriefBody(raw)
    // The brief is content-addressed: persisting the same intent twice yields
    // the same id and the same hash, so this is idempotent by construction.
    const brief = createTransformationBrief({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      createdAt: new Date().toISOString(),
    })
    const result = await persistTransformationBriefService({
      repository: createTransformationProviderRegistryRepository(),
      brief,
    })
    return NextResponse.json(
      presentSuccess({ brief: presentTransformationBrief(result.brief), replayed: result.replayed }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
