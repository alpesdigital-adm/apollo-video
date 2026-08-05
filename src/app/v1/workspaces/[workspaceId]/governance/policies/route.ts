import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import {
  listGovernancePoliciesService,
  setGovernancePolicyService,
} from '@/v2/application/governance-policies'
import type { GovernanceLimits, GovernancePolicy } from '@/v2/domain/governance-limits'
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
  params: Promise<{ workspaceId: string }>
}

export async function GET(request: NextRequest, props: RouteContext) {
  const { workspaceId } = await props.params
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const policies = await listGovernancePoliciesService({
      repository: createGovernancePolicyRepository(),
    })({ actor, workspaceId })
    return NextResponse.json(
      presentSuccess({ policies }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest, props: RouteContext) {
  const { workspaceId } = await props.params
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    assertExternalMutationOrigin(request, actor)
    const body = await parseSetBody(request)
    const result = await setGovernancePolicyService({
      repository: createGovernancePolicyRepository(),
      createId: (kind) => `governance-${kind}-${randomUUID()}`,
    })({
      actor,
      workspaceId,
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      environment: body.environment,
      limits: body.limits,
      ...(body.baseRevision ? { baseRevision: body.baseRevision } : {}),
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

async function parseSetBody(request: NextRequest): Promise<{
  scopeType: GovernancePolicy['scopeType']
  scopeId: string
  environment: GovernancePolicy['environment']
  limits: GovernanceLimits
  baseRevision: string | null
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
      'baseRevision,confirmed,environment,limits,reason,scopeId,scopeType'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'governance policy request fields are invalid',
    )
  }
  const value = body as Record<string, unknown>
  const limits = value.limits
  if (
    (value.scopeType !== 'workspace' && value.scopeType !== 'client') ||
    typeof value.scopeId !== 'string' ||
    (value.environment !== 'sandbox' && value.environment !== 'production') ||
    (value.baseRevision !== null && typeof value.baseRevision !== 'string') ||
    typeof value.reason !== 'string' || value.confirmed !== true ||
    typeof limits !== 'object' || limits === null || Array.isArray(limits) ||
    Object.keys(limits).toSorted().join(',') !==
      'maxConcurrency,quotaUnits,requestsPerMinute,spendBudgetMinorUnits' ||
    !Object.values(limits).every((item) => typeof item === 'number')
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'governance policy request values are invalid',
    )
  }
  return value as {
    scopeType: GovernancePolicy['scopeType']
    scopeId: string
    environment: GovernancePolicy['environment']
    limits: GovernanceLimits
    baseRevision: string | null
    reason: string
    confirmed: boolean
  }
}
