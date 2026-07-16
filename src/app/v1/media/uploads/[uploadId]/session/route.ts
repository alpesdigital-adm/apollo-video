import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { issueMediaUploadSessionService } from '@/v2/application/issue-media-upload-session'
import {
  createMediaTransferRepository,
  createMediaUploadSessionSignerFromEnvironment,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ uploadId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'media:write')
    const { uploadId } = await context.params
    const result = await issueMediaUploadSessionService({
      repository: createMediaTransferRepository(),
      signer: createMediaUploadSessionSignerFromEnvironment(),
    })({ workspaceId: actor.workspaceId, clientId: actor.clientId, uploadId })
    return NextResponse.json(presentSuccess({
      uploadId: result.upload.id,
      session: result.session,
    }), { headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
