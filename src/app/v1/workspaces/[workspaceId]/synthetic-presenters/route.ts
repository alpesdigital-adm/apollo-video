import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { listSyntheticPresenterProfilesService } from '@/v2/application/synthetic-presenter-lifecycle'
import { registerSyntheticPresenterProfileService } from '@/v2/application/synthetic-production'
import { DomainError } from '@/v2/domain/errors'
import { presentPresenterSummary } from '@/v2/public-api/synthetic-presenter-lifecycle-contract'
import {
  createMediaArtifactQueryRepository,
  createSyntheticProductionRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseRegisterSyntheticPresenterBody,
  presentSyntheticPresenterProfile,
} from '@/v2/public-api/synthetic-production-contract'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { workspaceId } = await context.params
    if (workspaceId !== actor.workspaceId) {
      throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
    }
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseRegisterSyntheticPresenterBody(rawBody)
    const result = await registerSyntheticPresenterProfileService({
      repository: createSyntheticProductionRepository(),
      artifacts: createMediaArtifactQueryRepository(),
      clock: () => new Date(),
    })({
      workspaceId,
      ...body,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        profile: presentSyntheticPresenterProfile(result.profile),
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

export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { workspaceId } = await context.params
    const presenters = await listSyntheticPresenterProfilesService({
      repository: createSyntheticProductionRepository(),
    })({ workspaceId, actor })
    return NextResponse.json(
      presentSuccess({ presenters: presenters.map(presentPresenterSummary) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
