import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { createSyntheticProductionRunService } from '@/v2/application/synthetic-production'
import { DomainError } from '@/v2/domain/errors'
import {
  createAssetRightsRepository,
  createMediaArtifactQueryRepository,
  createProjectWorkspaceQueryRepository,
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
  parseCreateSyntheticProductionRunBody,
  presentSyntheticProductionRun,
} from '@/v2/public-api/synthetic-production-contract'

export const dynamic = 'force-dynamic'

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
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseCreateSyntheticProductionRunBody(rawBody)
    const result = await createSyntheticProductionRunService({
      repository: createSyntheticProductionRepository(),
      projects: createProjectWorkspaceQueryRepository(),
      artifacts: createMediaArtifactQueryRepository(),
      rights: createAssetRightsRepository(),
      clock: () => new Date(),
      createRunId: () => `synthetic-run-${randomUUID()}`,
      createSnapshotId: () => `snapshot-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        run: presentSyntheticProductionRun(result.run),
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
