import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { createSyntheticAudioMasterService } from '@/v2/application/synthetic-audio-masters'
import { DomainError } from '@/v2/domain/errors'
import { createAssetRightsRepository, createMediaArtifactQueryRepository, createProjectWorkspaceQueryRepository, createProviderJobRepository, createSyntheticAudioMasterRepository, createSyntheticProductionRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseCreateSyntheticAudioMasterBody, presentSyntheticAudioMaster } from '@/v2/public-api/synthetic-audio-master-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseCreateSyntheticAudioMasterBody(raw)
    const result = await createSyntheticAudioMasterService({
      repository: createSyntheticAudioMasterRepository(), projects: createProjectWorkspaceQueryRepository(), profiles: createSyntheticProductionRepository(),
      providerJobs: createProviderJobRepository(), artifacts: createMediaArtifactQueryRepository(), rights: createAssetRightsRepository(),
      clock: () => new Date(), createId: () => `synthetic-audio-master-${randomUUID()}`,
    })({ workspaceId: actor.workspaceId, projectId, ...body, actor, idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '' })
    return NextResponse.json(presentSuccess({ audioMaster: presentSyntheticAudioMaster(result.value), replayed: result.replayed }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
