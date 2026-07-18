import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { inspectMediaUploadService } from '@/v2/application/manage-media-upload'
import { createMediaTransferRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ uploadId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'media:write')
    const { uploadId } = await context.params
    const result = await inspectMediaUploadService({ repository: createMediaTransferRepository() })({ workspaceId: actor.workspaceId, clientId: actor.clientId, uploadId })
    return NextResponse.json(presentSuccess({
      upload: { id: result.upload!.id, projectId: result.upload!.projectId, fileName: result.upload!.fileName, rightsConfirmed: result.upload!.rightsConfirmed, kind: result.upload!.kind, size: result.upload!.byteSize, mimeType: result.upload!.mimeType, checksum: result.upload!.expectedSha256, status: result.upload!.status, expiresAt: result.upload!.expiresAt, createdAt: result.upload!.createdAt },
      parts: result.parts,
      missingPartNumbers: result.missingPartNumbers,
    }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
