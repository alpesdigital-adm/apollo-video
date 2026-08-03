import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createTakeLibraryService,
  listTakeLibrariesService,
} from '@/v2/application/take-libraries'
import { DomainError } from '@/v2/domain/errors'
import {
  createTakeLibraryRepository,
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
  parseCreateTakeLibraryBody,
  presentTakeLibraryPage,
  presentTakeLibraryRun,
} from '@/v2/public-api/take-library-contract'

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
    const page = await listTakeLibrariesService({
      repository: createTakeLibraryRepository(),
    })({
      workspaceId: actor.workspaceId,
      batchId,
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentTakeLibraryPage(page)),
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
    const body = parseCreateTakeLibraryBody(rawBody)
    const result = await createTakeLibraryService({
      repository: createTakeLibraryRepository(),
      clock: () => new Date(),
      createRunId: () => `take-library-${randomUUID()}`,
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
        library: presentTakeLibraryRun(result.run),
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
