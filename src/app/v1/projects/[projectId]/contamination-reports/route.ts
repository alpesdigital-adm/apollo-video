import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createContaminationReportService,
  listContaminationReportsService,
} from '@/v2/application/contamination-reports'
import { DomainError } from '@/v2/domain/errors'
import {
  createContaminationReportRepository,
  createSourceDeconstructionRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  parseCreateContaminationReportBody,
  presentContaminationReport,
  presentContaminationReportPage,
} from '@/v2/public-api/contamination-report-contract'
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
    const page = await listContaminationReportsService({
      repository: createContaminationReportRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      sourceDeconstructionReportId:
        request.nextUrl.searchParams.get(
          'sourceDeconstructionReportId',
        ) ?? undefined,
      limit: limitValue === null ? undefined : Number(limitValue),
      cursor:
        request.nextUrl.searchParams.get('cursor') ?? undefined,
    })
    return NextResponse.json(
      presentSuccess(presentContaminationReportPage(page)),
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
    const body = parseCreateContaminationReportBody(rawBody)
    const result = await createContaminationReportService({
      repository: createContaminationReportRepository(),
      sourceRepository: createSourceDeconstructionRepository(),
      clock: () => new Date(),
      createId: () =>
        `contamination-report-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor: actor.auditContext.actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        report: presentContaminationReport(result.report),
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
