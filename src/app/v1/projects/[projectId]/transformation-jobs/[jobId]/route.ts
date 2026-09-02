import { NextRequest, NextResponse } from 'next/server'

import { readTransformationJobService } from '@/v2/application/transformation-jobs'
import { createProviderJobRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  presentProviderCallbackEvent,
  presentTransformationJob,
} from '@/v2/public-api/transformation-job-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; jobId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, jobId } = await context.params
    const result = await readTransformationJobService({ jobs: createProviderJobRepository() })({
      workspaceId: actor.workspaceId, projectId, jobId, actor,
    })
    return NextResponse.json(
      presentSuccess({
        job: presentTransformationJob(result.persisted),
        // Redacted history: the digest of every callback that was accepted or
        // refused, never the provider payload it carried.
        callbacks: result.callbacks.map(presentProviderCallbackEvent),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
