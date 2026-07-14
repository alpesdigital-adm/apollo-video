import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueAuthorizedRenderService } from '@/v2/application/enqueue-authorized-render'
import { DomainError } from '@/v2/domain/errors'
import {
  createMaterializationAuthorizationRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentPublicOperation, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function parseRequest(body: unknown): { authorizationId: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be a JSON object')
  }
  const value = body as Record<string, unknown>
  if (
    Object.keys(value).length !== 1 ||
    typeof value.authorizationId !== 'string'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Request body must contain only authorizationId',
    )
  }
  return { authorizationId: value.authorizationId }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ artifactId: string; manifestId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:render')
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const { artifactId, manifestId } = await context.params
    const enqueue = enqueueAuthorizedRenderService({
      authorizations: createMaterializationAuthorizationRepository(),
      operations: createPublicOperationRepository(),
      clock: () => new Date(),
      createId: () => `operation-${randomUUID()}`,
    })
    const result = await enqueue({
      workspaceId: actor.workspaceId,
      artifactId,
      manifestId,
      ...parseRequest(body),
      actor: { type: 'api-client', id: actor.clientId },
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        operation: presentPublicOperation(result.operation),
        replayed: result.replayed,
      }),
      { status: 202, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
