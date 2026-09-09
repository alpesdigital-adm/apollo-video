import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createEditorialSynthesisService,
  listEditorialSynthesesService,
} from '@/v2/application/editorial-synthesis'
import { DomainError } from '@/v2/domain/errors'
import {
  createEditorialSynthesisRepository,
  createStoryPlanRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  parseCreateEditorialSynthesisBody,
  presentEditorialSynthesisSummary,
} from '@/v2/public-api/editorial-synthesis-contract'
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
    const { projectId } = await context.params
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (name !== 'limit' || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    const rawLimit = params.get('limit')
    const syntheses = await listEditorialSynthesesService({
      repository: createEditorialSynthesisRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    })
    return NextResponse.json(
      presentSuccess({
        syntheses: syntheses.map((stored) => presentEditorialSynthesisSummary(stored.synthesis)),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseCreateEditorialSynthesisBody(rawBody)
    const result = await createEditorialSynthesisService({
      repository: createEditorialSynthesisRepository(),
      storyPlans: createStoryPlanRepository(),
      clock: () => new Date(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      synthesisId: body.synthesisId,
      objective: body.objective,
      targetDurationMs: body.targetDurationMs,
      toleranceMs: body.toleranceMs,
      sourceDurationMs: body.sourceDurationMs,
      frameRate: body.frameRate,
      storyPlanId: body.storyPlanId,
      editPlanId: body.editPlanId,
      allowReorder: body.allowReorder,
      ranges: body.ranges,
      joins: body.joins,
    })
    return NextResponse.json(
      presentSuccess({
        synthesis: presentEditorialSynthesisSummary(result.synthesis),
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
