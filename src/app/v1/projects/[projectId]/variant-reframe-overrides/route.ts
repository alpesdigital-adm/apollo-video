import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { applyVariantReframeOverrideService, listVariantReframeOverridesService } from '@/v2/application/variant-reframe-overrides'
import { createVariantReframeOverrideRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseApplyVariantReframeOverrideBody, presentVariantReframeOverrideResult } from '@/v2/public-api/variant-reframe-override-contract'
import { carryOverAfterCommand } from '@/v2/infrastructure/carry-over-after-command'

export const dynamic = 'force-dynamic'

/** The current manual reframes (heads) of one output variant, named by its stable variant id. */
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const variantId = request.nextUrl.searchParams.get('variantId') ?? ''
    const overrides = await listVariantReframeOverridesService({ repository: createVariantReframeOverrideRepository() })({
      workspaceId: actor.workspaceId, projectId, variantId,
    })
    return NextResponse.json(presentSuccess({ variantId, overrides: [...overrides] }), { headers: publicApiHeaders(requestId) })
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
    // `body` is closed: the route never decides a range, a variant or a crop itself.
    const body = parseApplyVariantReframeOverrideBody(await request.json())
    const result = await applyVariantReframeOverrideService({
      repository: createVariantReframeOverrideRepository(),
      createId: (kind) => `variant-reframe-${kind}-${randomUUID()}`,
    })({
      ...body,
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    // The other outputs of the project keep the render and the approval they had when nothing they are drawn from changed (best effort: the
    // Command has committed and answers regardless).
    await carryOverAfterCommand({
      workspaceId: actor.workspaceId, projectId, versionId: result.version.id, commandId: result.command.id,
      affectedVariantIds: result.impact.affectedVariantIds, actor, traceId: requestId,
    })
    return NextResponse.json(
      presentSuccess(presentVariantReframeOverrideResult(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
