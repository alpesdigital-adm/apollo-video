import { NextRequest, NextResponse } from 'next/server'

import { readProviderJobService } from '@/v2/application/provider-jobs'
import { createProviderJobRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentProviderJob } from '@/v2/public-api/provider-job-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; jobId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, jobId } = await context.params
    const job = await readProviderJobService({ jobs: createProviderJobRepository() })({
      workspaceId: actor.workspaceId, projectId, jobId, actor,
    })
    return NextResponse.json(presentSuccess({ job: presentProviderJob(job) }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
