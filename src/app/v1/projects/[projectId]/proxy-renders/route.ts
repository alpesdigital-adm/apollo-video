import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueProjectProxyRenderService } from '@/v2/application/enqueue-project-proxy-render'
import { createColorPipelineCompilationRepository, createProjectProxyRenderRepository, createPublicOperationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentPublicOperation, presentSuccess } from '@/v2/public-api/presenters'
import { parseProxyRenderBody } from '@/v2/public-api/project-output-variant-request-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    // The optional body names the output (its stable State variant id); an empty body is the single-output request.
    const body = parseProxyRenderBody(await request.text())
    const result = await enqueueProjectProxyRenderService({
      projects: createProjectProxyRenderRepository(), operations: createPublicOperationRepository(),
      colorPipelines: createColorPipelineCompilationRepository(),
      clock: () => new Date(), createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId, projectId, actor,
      ...(body.variantId === undefined ? {} : { variantId: body.variantId }),
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
      traceId: requestId,
    })
    return NextResponse.json(presentSuccess({ operation: presentPublicOperation(result.operation), replayed: result.replayed }), {
      status: 202, headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
