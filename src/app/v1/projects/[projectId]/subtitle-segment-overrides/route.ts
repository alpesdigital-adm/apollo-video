import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  applySubtitleSegmentOverrideService,
  listSubtitleSegmentOverridesService,
  readSubtitleSegmentOverrideService,
} from '@/v2/application/subtitle-segment-overrides'
import { createSubtitleSegmentOverrideRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseApplySubtitleSegmentOverrideBody,
  presentSubtitleSegmentOverrideResult,
} from '@/v2/public-api/subtitle-segment-override-contract'

export const dynamic = 'force-dynamic'

/**
 * Without `segmentId` this lists every head exception of the variant — the same list
 * the compiler applies. With `segmentId` it reads that one segment's head.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const variantId = request.nextUrl.searchParams.get('variantId') ?? ''
    const segmentId = request.nextUrl.searchParams.get('segmentId')
    const repository = createSubtitleSegmentOverrideRepository()
    if (segmentId === null) {
      const overrides = await listSubtitleSegmentOverridesService({ repository })({
        workspaceId: actor.workspaceId, projectId, variantId,
      })
      return NextResponse.json(
        presentSuccess({ overrides: [...overrides] }),
        { headers: publicApiHeaders(requestId) },
      )
    }
    const value = await readSubtitleSegmentOverrideService({ repository })({
      workspaceId: actor.workspaceId, projectId, variantId, segmentId,
    })
    return NextResponse.json(
      presentSuccess({ result: value ? presentSubtitleSegmentOverrideResult(value) : null }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    // `body` already carries `action` and, for a set, the canonical dimensions; the
    // route never decides a range, a variant or a protection level itself.
    const body = parseApplySubtitleSegmentOverrideBody(await request.json())
    const result = await applySubtitleSegmentOverrideService({
      repository: createSubtitleSegmentOverrideRepository(),
      createId: (kind) => `subtitle-segment-${kind}-${randomUUID()}`,
    })({
      ...body,
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(
      presentSuccess(presentSubtitleSegmentOverrideResult(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
