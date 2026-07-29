import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createProofNeedRunService,
  listProofNeedRunsService,
} from '@/v2/application/proof-needs'
import { DomainError } from '@/v2/domain/errors'
import {
  createEvidenceSegmentRepository,
  createProofNeedRepository,
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
  parseCreateProofNeedBody,
  presentProofNeedRun,
  presentProofNeedRunPage,
} from '@/v2/public-api/proof-need-contract'

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
    const resolution =
      request.nextUrl.searchParams.get('resolution') ?? undefined
    const page = await listProofNeedRunsService({
      repository: createProofNeedRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      batchId:
        request.nextUrl.searchParams.get('batchId') ?? undefined,
      targetRecipeId:
        request.nextUrl.searchParams.get('targetRecipeId') ??
        undefined,
      resolution: resolution as
        | 'selected-evidence'
        | 'proof-unavailable'
        | 'no-proof-needed'
        | undefined,
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor:
        request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentProofNeedRunPage(page)),
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
    const body = parseCreateProofNeedBody(rawBody)
    const result = await createProofNeedRunService({
      repository: createProofNeedRepository(),
      evidenceSegments: createEvidenceSegmentRepository(),
      variantRecipes: createVariantRecipeRepository(),
      clock: () => new Date(),
      createRunId: () => `proof-need-run-${randomUUID()}`,
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
        run: presentProofNeedRun(result.run),
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
