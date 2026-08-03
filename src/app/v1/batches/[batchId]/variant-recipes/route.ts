import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createVariantRecipeService,
  listVariantRecipesService,
} from '@/v2/application/variant-recipes'
import { DomainError } from '@/v2/domain/errors'
import {
  createVariantRecipeRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  parseCreateVariantRecipeBody,
  presentVariantRecipe,
  presentVariantRecipePage,
} from '@/v2/public-api/variant-recipe-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ batchId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { batchId } = await context.params
    const limitValue = request.nextUrl.searchParams.get('limit')
    const page = await listVariantRecipesService({
      repository: createVariantRecipeRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      compatibilityGraphId:
        request.nextUrl.searchParams.get('compatibilityGraphId') ??
        undefined,
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentVariantRecipePage(page)),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ batchId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { batchId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseCreateVariantRecipeBody(rawBody)
    const result = await createVariantRecipeService({
      repository: createVariantRecipeRepository(),
      clock: () => new Date(),
      createRunId: () => `variant-recipe-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      batchId,
      ...body,
      actor: actor.auditContext.actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        recipe: presentVariantRecipe(result.run),
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
