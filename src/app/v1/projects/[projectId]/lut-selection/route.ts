import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueProjectProxyRenderService } from '@/v2/application/enqueue-project-proxy-render'
import { readProjectLutSelectionService, setProjectLutSelectionService } from '@/v2/application/project-lut-selections'
import { createColorPipelineCompilationRepository, createProjectLutSelectionRepository, createProjectProxyRenderRepository, createPublicOperationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { parseSetProjectLutSelectionBody, presentProjectLutSelectionResult } from '@/v2/public-api/project-lut-selection-contract'
import { presentPublicOperation, presentSuccess } from '@/v2/public-api/presenters'
import { calculateVersionHash } from '@/v2/application/version-hash'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:read'); const { projectId } = await context.params
    const value = await readProjectLutSelectionService({ repository: createProjectLutSelectionRepository() })({ workspaceId: actor.workspaceId, projectId })
    return NextResponse.json(presentSuccess({ result: value ? presentProjectLutSelectionResult(value) : null }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:write'); const { projectId } = await context.params
    const body = parseSetProjectLutSelectionBody(await request.json())
    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    const result = await setProjectLutSelectionService({ repository: createProjectLutSelectionRepository(), createId: (kind) => `project-lut-${kind}-${randomUUID()}`, createEventId: () => randomUUID() })({
      ...body, workspaceId: actor.workspaceId, projectId, actor: actor, idempotencyKey,
    })
    const presented = presentProjectLutSelectionResult(result)
    if (result.impact.renderDeferredUntilTimeline) {
      return NextResponse.json(presentSuccess(presented), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
    }
    const proxy = await enqueueProjectProxyRenderService({
      projects: createProjectProxyRenderRepository(), operations: createPublicOperationRepository(),
      colorPipelines: createColorPipelineCompilationRepository(), clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId, projectId, expectedProjectVersionId: result.version.id,
      actor: actor.auditContext.actor,
      idempotencyKey: `lut-proxy:${calculateVersionHash(idempotencyKey).slice(0, 64)}`,
      traceId: requestId,
    })
    return NextResponse.json(presentSuccess({
      ...presented, operation: presentPublicOperation(proxy.operation),
      replayed: result.replayed && proxy.replayed,
    }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
