import { NextRequest, NextResponse } from 'next/server'

import { projectQuickActionsService } from '@/v2/application/project-quick-actions'
import { DomainError } from '@/v2/domain/errors'
import { createProjectAdministrationRepository } from '@/v2/infrastructure/repository-factory'
import {
  assertExternalMutationOrigin,
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  presentProjectAdministrationResult,
  presentSuccess,
} from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

async function parseBody(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
  }
  if (
    typeof body !== 'object' || body === null || Array.isArray(body) ||
    Object.keys(body).toSorted().join(',') !== 'baseRevision'
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Project restore fields are invalid')
  }
  const value = body as Record<string, unknown>
  if (!Number.isSafeInteger(value.baseRevision)) {
    throw new DomainError('INVALID_ARGUMENT', 'Project restore values are invalid')
  }
  return { baseRevision: value.baseRevision as number }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    assertExternalMutationOrigin(request, actor)
    const body = await parseBody(request)
    const { projectId } = await context.params
    const result = await projectQuickActionsService({
      repository: createProjectAdministrationRepository(),
    })({
      actor,
      projectId,
      action: 'restore',
      baseRevision: body.baseRevision,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(
      presentSuccess(presentProjectAdministrationResult(result)),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
