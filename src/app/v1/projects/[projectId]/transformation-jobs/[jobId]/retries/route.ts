import { NextRequest, NextResponse } from 'next/server'

import { retryTransformationJobService } from '@/v2/application/transformation-jobs'
import { createProviderJobRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  presentTransformationJob,
  presentTransformationTransport,
} from '@/v2/public-api/transformation-job-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string; jobId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, jobId } = await context.params
    const result = await retryTransformationJobService({
      jobs: createProviderJobRepository(),
      clock: () => new Date(),
    })({ workspaceId: actor.workspaceId, projectId, jobId, actor })
    return NextResponse.json(
      presentSuccess({
        job: presentTransformationJob(result.persisted),
        transport: presentTransformationTransport(result.transportState),
      }),
      { status: 202, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
