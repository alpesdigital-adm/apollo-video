import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createLongFormIndexWorkflowService,
  listLongFormIndexWorkflowsService,
} from '@/v2/application/long-form-index-workflow'
import { DomainError } from '@/v2/domain/errors'
import {
  createLongFormIndexWorkflowRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  parseCreateLongFormIndexWorkflowBody,
  presentLongFormIndexWorkflow,
  presentLongFormIndexWorkflowPage,
} from '@/v2/public-api/long-form-index-workflow-contract'
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
    const allowed = new Set([
      'status',
      'sourceArtifactId',
      'limit',
      'cursor',
    ])
    for (const name of params.keys()) {
      if (!allowed.has(name) || params.getAll(name).length > 1) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          `${name} is not a supported singular filter`,
        )
      }
    }
    const rawLimit = params.get('limit')
    const page = await listLongFormIndexWorkflowsService({
      repository: createLongFormIndexWorkflowRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      status: params.get('status') as
        | 'queued'
        | 'running'
        | 'partial'
        | 'succeeded'
        | 'failed'
        | null ?? undefined,
      sourceArtifactId:
        params.get('sourceArtifactId') ?? undefined,
      limit: rawLimit === null ? undefined : Number(rawLimit),
      cursor: params.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentLongFormIndexWorkflowPage(page)),
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
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseCreateLongFormIndexWorkflowBody(rawBody)
    const result = await createLongFormIndexWorkflowService({
      repository: createLongFormIndexWorkflowRepository(),
      clock: () => new Date(),
      createWorkflowId: () =>
        `long-form-workflow-${randomUUID()}`,
      createOperationId: () =>
        `operation-long-form-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
      traceId: requestId,
    })
    return NextResponse.json(
      presentSuccess({
        ...presentLongFormIndexWorkflow(result.record),
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 202,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
