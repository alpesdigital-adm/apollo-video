import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createVariantPortfolioPreflightService,
  listVariantPortfolioPreflightsService,
} from '@/v2/application/variant-portfolio-preflights'
import { DomainError } from '@/v2/domain/errors'
import {
  createVariantPortfolioPreflightRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  createPreflightCommitTokenIssuerFromEnvironment,
} from '@/v2/infrastructure/security/preflight-commit-token'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  parseCreateVariantPortfolioPreflightBody,
  presentVariantPortfolioPreflight,
  presentVariantPortfolioPreflightPage,
} from '@/v2/public-api/variant-portfolio-preflight-contract'
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
    const page = await listVariantPortfolioPreflightsService({
      repository: createVariantPortfolioPreflightRepository(),
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
      presentSuccess(presentVariantPortfolioPreflightPage(page)),
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
    const body = parseCreateVariantPortfolioPreflightBody(rawBody)
    const result = await createVariantPortfolioPreflightService({
      repository: createVariantPortfolioPreflightRepository(),
      tokenIssuer: createPreflightCommitTokenIssuerFromEnvironment(),
      clock: () => new Date(),
      createRunId: () =>
        `variant-portfolio-preflight-${randomUUID()}`,
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
        preflight: presentVariantPortfolioPreflight(result.run),
        replayed: result.replayed,
        ...(result.confirmationToken
          ? { confirmationToken: result.confirmationToken }
          : {}),
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
