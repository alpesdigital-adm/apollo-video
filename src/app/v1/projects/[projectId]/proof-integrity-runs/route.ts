import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createProofIntegrityRunService,
  listProofIntegrityRunsService,
} from '@/v2/application/proof-integrity'
import { DomainError } from '@/v2/domain/errors'
import {
  createCompatibilityGraphRepository,
  createEvidenceSegmentRepository,
  createProofIntegrityRepository,
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
  parseCreateProofIntegrityBody,
  presentProofIntegrityRun,
  presentProofIntegrityRunPage,
} from '@/v2/public-api/proof-integrity-contract'

export const dynamic = 'force-dynamic'

function optionalBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new DomainError(
    'INVALID_ARGUMENT',
    'readyForAssembly must be true or false',
  )
}

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
    const outcome =
      request.nextUrl.searchParams.get('outcome') ?? undefined
    const page = await listProofIntegrityRunsService({
      repository: createProofIntegrityRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      proofNeedRunId:
        request.nextUrl.searchParams.get('proofNeedRunId') ??
        undefined,
      targetRecipeId:
        request.nextUrl.searchParams.get('targetRecipeId') ??
        undefined,
      outcome: outcome as
        | 'approved'
        | 'blocked'
        | 'not-applicable'
        | undefined,
      readyForAssembly: optionalBoolean(
        request.nextUrl.searchParams.get('readyForAssembly'),
      ),
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor:
        request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentProofIntegrityRunPage(page)),
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
    const body = parseCreateProofIntegrityBody(rawBody)
    const result = await createProofIntegrityRunService({
      repository: createProofIntegrityRepository(),
      proofNeeds: createProofNeedRepository(),
      variantRecipes: createVariantRecipeRepository(),
      compatibilityGraphs: createCompatibilityGraphRepository(),
      evidenceSegments: createEvidenceSegmentRepository(),
      clock: () => new Date(),
      createRunId: () => `proof-integrity-run-${randomUUID()}`,
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
        run: presentProofIntegrityRun(result.run),
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
