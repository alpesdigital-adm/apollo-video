import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createSourceCleanupService,
  listSourceCleanupsService,
} from '@/v2/application/source-cleanups'
import { DomainError } from '@/v2/domain/errors'
import {
  createAssetRightsRepository,
  createContaminationReportRepository,
  createMediaArtifactQueryRepository,
  createProjectWorkspaceQueryRepository,
  createSourceCleanupRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  parseCreateSourceCleanupBody,
  presentSourceCleanup,
  presentSourceCleanupPage,
} from '@/v2/public-api/source-cleanup-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

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
    const page = await listSourceCleanupsService({
      repository: createSourceCleanupRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      contaminationReportId:
        request.nextUrl.searchParams.get(
          'contaminationReportId',
        ) ?? undefined,
      findingId:
        request.nextUrl.searchParams.get('findingId') ?? undefined,
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor:
        request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentSourceCleanupPage(page)),
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
    const body = parseCreateSourceCleanupBody(rawBody)
    const result = await createSourceCleanupService({
      repository: createSourceCleanupRepository(),
      contaminationReports: createContaminationReportRepository(),
      mediaArtifacts: createMediaArtifactQueryRepository(),
      rights: createAssetRightsRepository(),
      projects: createProjectWorkspaceQueryRepository(),
      clock: () => new Date(),
      createId: () => `source-cleanup-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor: { type: 'api-client', id: actor.clientId },
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
      traceId: requestId,
    })
    return NextResponse.json(
      presentSuccess({
        cleanup: presentSourceCleanup(result),
        replayed: result.replayed,
      }),
      {
        status: result.replayed
          ? 200
          : result.operation
            ? 202
            : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
