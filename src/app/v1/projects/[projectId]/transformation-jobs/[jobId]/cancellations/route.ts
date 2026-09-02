import { NextRequest, NextResponse } from 'next/server'

import { cancelTransformationJobService } from '@/v2/application/transformation-jobs'
import {
  createProviderAdapterRegistry,
  createProviderJobRepository,
} from '@/v2/infrastructure/repository-factory'
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
    const result = await cancelTransformationJobService({
      jobs: createProviderJobRepository(),
      adapters: createProviderAdapterRegistry(),
      clock: () => new Date(),
    })({ workspaceId: actor.workspaceId, projectId, jobId, actor })
    return NextResponse.json(
      presentSuccess({
        job: presentTransformationJob(result.persisted),
        transport: presentTransformationTransport(result.transportState),
        // Honest about what was actually asked of the provider. A job reported
        // cancelled that is still running is still billing.
        providerSupportsCancellation: result.supported,
      }),
      { status: 202, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
