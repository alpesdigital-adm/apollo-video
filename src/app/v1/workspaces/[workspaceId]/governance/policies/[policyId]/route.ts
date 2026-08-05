import { NextRequest, NextResponse } from 'next/server'

import { deleteGovernancePolicyService } from '@/v2/application/governance-policies'
import { DomainError } from '@/v2/domain/errors'
import { createGovernancePolicyRepository } from '@/v2/infrastructure/repository-factory'
import {
  assertExternalMutationOrigin,
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ workspaceId: string; policyId: string }>
}

export async function DELETE(request: NextRequest, props: RouteContext) {
  const { workspaceId, policyId } = await props.params
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    assertExternalMutationOrigin(request, actor)
    const body = await parseBody(request)
    const result = await deleteGovernancePolicyService({
      repository: createGovernancePolicyRepository(),
    })({
      actor,
      workspaceId,
      policyId,
      baseRevision: body.baseRevision,
      reason: body.reason,
      confirmed: body.confirmed,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(presentSuccess(result), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

async function parseBody(request: NextRequest): Promise<{
  baseRevision: string
  reason: string
  confirmed: boolean
}> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
  }
  if (
    typeof body !== 'object' || body === null || Array.isArray(body) ||
    Object.keys(body).toSorted().join(',') !==
      'baseRevision,confirmed,reason'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'governance policy deletion fields are invalid',
    )
  }
  const value = body as Record<string, unknown>
  if (
    typeof value.baseRevision !== 'string' ||
    typeof value.reason !== 'string' || value.confirmed !== true
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'governance policy deletion values are invalid',
    )
  }
  return value as { baseRevision: string; reason: string; confirmed: boolean }
}
