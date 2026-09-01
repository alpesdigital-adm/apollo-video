import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requestTransformationJobService } from '@/v2/application/transformation-jobs'
import { DomainError } from '@/v2/domain/errors'
import {
  createAssetRightsRepository,
  createMediaArtifactQueryRepository,
  createProjectWorkspaceQueryRepository,
  createProviderAdapterRegistry,
  createProviderJobRepository,
  createTransformationProviderRegistryRepository,
  transformationAdapterEnvironment,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseRequestTransformationJobBody,
  presentTransformationJob,
} from '@/v2/public-api/transformation-job-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseRequestTransformationJobBody(raw)
    const result = await requestTransformationJobService({
      jobs: createProviderJobRepository(),
      registry: createTransformationProviderRegistryRepository(),
      adapters: createProviderAdapterRegistry(),
      projects: createProjectWorkspaceQueryRepository(),
      artifacts: createMediaArtifactQueryRepository(),
      rights: createAssetRightsRepository(),
      clock: () => new Date(),
      createJobId: () => `provider-job-${randomUUID()}`,
      createTransitionId: () => `provider-transition-${randomUUID()}`,
      // Whether a provider can be driven by webhook is a deployment fact — it
      // needs an inbound secret — so it is read here, not asserted by a caller.
      webhookConfigured: (providerId) => Boolean(transformationAdapterEnvironment(process.env, providerId)?.callbackSecret),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    // 202: the durable job exists and the worker owns it from here. An HTTP
    // request never stays open waiting for a provider to finish.
    return NextResponse.json(
      presentSuccess({ job: presentTransformationJob(result.persisted), replayed: result.replayed }),
      { status: result.replayed ? 200 : 202, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
