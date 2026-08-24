import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { enqueueProviderJobService } from '@/v2/application/provider-jobs'
import { DomainError } from '@/v2/domain/errors'
import {
  createAssetRightsRepository,
  createMediaArtifactQueryRepository,
  createProjectWorkspaceQueryRepository,
  createProviderJobRepository,
  createSyntheticProductionRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseEnqueueProviderJobBody, presentProviderJob } from '@/v2/public-api/provider-job-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseEnqueueProviderJobBody(raw)
    const result = await enqueueProviderJobService({
      jobs: createProviderJobRepository(),
      profiles: createSyntheticProductionRepository(),
      projects: createProjectWorkspaceQueryRepository(),
      artifacts: createMediaArtifactQueryRepository(),
      rights: createAssetRightsRepository(),
      clock: () => new Date(),
      createJobId: () => `provider-job-${randomUUID()}`,
      createTransitionId: () => `provider-transition-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId, projectId, ...body, actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(presentSuccess({ job: presentProviderJob(result.persisted), replayed: result.replayed }), {
      status: result.replayed ? 200 : 202,
      headers: publicApiHeaders(requestId),
    })
  } catch (error) { return respondPublicError(error, requestId) }
}
