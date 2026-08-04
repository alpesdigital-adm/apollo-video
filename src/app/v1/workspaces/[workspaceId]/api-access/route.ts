import { NextRequest, NextResponse } from 'next/server'

import {
  changeApiAccessControlService,
  readApiAccessControlService,
} from '@/v2/application/administer-api-access'
import type { ApiAccessAction } from '@/v2/domain/api-access-control'
import { DomainError } from '@/v2/domain/errors'
import { createApiAccessControlRepository } from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ workspaceId: string }>
}

export async function GET(request: NextRequest, props: RouteContext) {
  const params = await props.params
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const access = await readApiAccessControlService({ repository: createApiAccessControlRepository() })({
      actor,
      workspaceId: params.workspaceId,
      targetType: 'workspace',
      targetId: params.workspaceId,
    })
    return NextResponse.json(presentSuccess({ access }), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function PATCH(request: NextRequest, props: RouteContext) {
  const params = await props.params
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    assertExternalMutationOrigin(request, actor)
    const body = await parseBody(request)
    const result = await changeApiAccessControlService({ repository: createApiAccessControlRepository() })({
      actor,
      workspaceId: params.workspaceId,
      targetType: 'workspace',
      targetId: params.workspaceId,
      action: body.action,
      baseRevision: body.baseRevision,
      reason: body.reason,
      confirmed: body.confirmed,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(presentSuccess(result), {
      status: result.replayed ? 200 : 201,
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

async function parseBody(request: NextRequest): Promise<{
  action: ApiAccessAction
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
    Object.keys(body).sort().join(',') !== 'action,baseRevision,confirmed,reason'
  ) throw new DomainError('INVALID_ARGUMENT', 'API access request fields are invalid')
  const value = body as Record<string, unknown>
  if (
    typeof value.action !== 'string' || typeof value.baseRevision !== 'string' ||
    typeof value.reason !== 'string' || value.confirmed !== true
  ) throw new DomainError('INVALID_ARGUMENT', 'API access request values are invalid')
  return value as {
    action: ApiAccessAction
    baseRevision: string
    reason: string
    confirmed: boolean
  }
}
