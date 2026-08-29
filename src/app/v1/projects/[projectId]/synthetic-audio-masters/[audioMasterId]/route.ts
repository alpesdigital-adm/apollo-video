import { NextRequest, NextResponse } from 'next/server'

import { readSyntheticAudioMasterService } from '@/v2/application/synthetic-audio-masters'
import { createSyntheticAudioMasterRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentSyntheticAudioMaster } from '@/v2/public-api/synthetic-audio-master-contract'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; audioMasterId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, audioMasterId } = await context.params
    const value = await readSyntheticAudioMasterService({ repository: createSyntheticAudioMasterRepository() })({ workspaceId: actor.workspaceId, projectId, audioMasterId, actor })
    return NextResponse.json(presentSuccess({ audioMaster: presentSyntheticAudioMaster(value) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
