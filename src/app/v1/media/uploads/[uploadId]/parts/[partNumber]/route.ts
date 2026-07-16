import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { recordMediaUploadPartService } from '@/v2/application/manage-media-upload'
import { DomainError } from '@/v2/domain/errors'
import { createMediaTransferRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest, context: { params: Promise<{ uploadId: string; partNumber: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'media:write')
    const { uploadId, partNumber } = await context.params
    let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown> } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const part = await recordMediaUploadPartService({ repository: createMediaTransferRepository() })({
      workspaceId: actor.workspaceId, clientId: actor.clientId, uploadId, partNumber: Number(partNumber),
      byteSize: body.byteSize as string, etag: body.etag as string, checksum: body.checksum as string,
    })
    return NextResponse.json(presentSuccess({ part }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
