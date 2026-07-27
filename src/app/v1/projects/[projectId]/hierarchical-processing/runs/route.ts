import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  executeHierarchicalProcessingService,
} from '@/v2/application/hierarchical-processing'
import { DomainError } from '@/v2/domain/errors'
import {
  createHierarchicalProcessingRepository,
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
  parseHierarchicalProcessingBody,
  presentHierarchicalProcessingRun,
} from '@/v2/public-api/hierarchical-processing-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const idempotencyKey =
      request.headers.get('idempotency-key')?.trim() ?? ''
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseHierarchicalProcessingBody(rawBody)
    const { projectId } = await context.params
    const result = await executeHierarchicalProcessingService({
      repository: createHierarchicalProcessingRepository(),
      clock: () => new Date(),
      monotonicMs: () => performance.now(),
      createId: () =>
        `hierarchical-processing-run-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor: { type: 'api-client', id: actor.clientId },
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        run: presentHierarchicalProcessingRun(result.run),
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
