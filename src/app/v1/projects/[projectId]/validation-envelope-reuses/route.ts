import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createValidationEnvelopeReuseService,
  listValidationEnvelopeReusesService,
} from '@/v2/application/validation-envelopes'
import { DomainError } from '@/v2/domain/errors'
import {
  createProjectWorkspaceQueryRepository,
  createValidatedSegmentRepository,
  createValidationEnvelopeRepository,
  createVariantRecipeRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseCreateValidationEnvelopeBody,
  presentValidationEnvelopeReuse,
  presentValidationEnvelopeReusePage,
} from '@/v2/public-api/validation-envelope-contract'

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
    const limitValue = request.nextUrl.searchParams.get('limit')
    const page = await listValidationEnvelopeReusesService({
      repository: createValidationEnvelopeRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      validatedSegmentId:
        request.nextUrl.searchParams.get(
          'validatedSegmentId',
        ) ?? undefined,
      batchId:
        request.nextUrl.searchParams.get('batchId') ?? undefined,
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor:
        request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentValidationEnvelopeReusePage(page)),
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
    const body = parseCreateValidationEnvelopeBody(rawBody)
    const result = await createValidationEnvelopeReuseService({
      repository: createValidationEnvelopeRepository(),
      validatedSegments: createValidatedSegmentRepository(),
      variantRecipes: createVariantRecipeRepository(),
      projects: createProjectWorkspaceQueryRepository(),
      clock: () => new Date(),
      createPlanId: () =>
        `validation-envelope-reuse-${randomUUID()}`,
      createDecisionId: () =>
        `validation-envelope-decision-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor: { type: 'api-client', id: actor.clientId },
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        reuse: presentValidationEnvelopeReuse(result),
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
