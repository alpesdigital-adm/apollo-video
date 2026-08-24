import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueProjectProxyRenderService } from '@/v2/application/enqueue-project-proxy-render'
import { readProjectColorPlanService, setProjectColorPlanService } from '@/v2/application/project-color-plans'
import { calculateVersionHash } from '@/v2/application/version-hash'
import {
  createColorPipelineCompilationRepository,
  createProjectColorPlanRepository,
  createProjectProxyRenderRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { parseSetProjectColorPlanBody, presentProjectColorPlanResult } from '@/v2/public-api/project-color-plan-contract'
import { presentPublicOperation, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId } = await context.params
    const value = await readProjectColorPlanService({ repository: createProjectColorPlanRepository() })({ workspaceId: actor.workspaceId, projectId })
    return NextResponse.json(presentSuccess({ result: value ? presentProjectColorPlanResult(value) : null }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId } = await context.params
    const body = parseSetProjectColorPlanBody(await request.json())
    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    const result = await setProjectColorPlanService({
      repository: createProjectColorPlanRepository(),
      createId: (kind) => `project-color-${kind}-${randomUUID()}`,
      createEventId: randomUUID,
    })({ ...body, workspaceId: actor.workspaceId, projectId, actor, idempotencyKey })
    const presented = presentProjectColorPlanResult(result)
    if (result.impact.renderDeferredUntilTimeline) {
      return NextResponse.json(presentSuccess(presented), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
    }
    const proxy = await enqueueProjectProxyRenderService({
      projects: createProjectProxyRenderRepository(), operations: createPublicOperationRepository(),
      colorPipelines: createColorPipelineCompilationRepository(), clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId, projectId, expectedProjectVersionId: result.version.id,
      actor, idempotencyKey: `color-plan-proxy:${calculateVersionHash(idempotencyKey).slice(0, 64)}`,
      traceId: requestId,
    })
    return NextResponse.json(presentSuccess({
      ...presented, operation: presentPublicOperation(proxy.operation), replayed: result.replayed && proxy.replayed,
    }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
