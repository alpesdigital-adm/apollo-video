import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { beginMediaUploadService } from '@/v2/application/begin-media-upload'
import { DomainError } from '@/v2/domain/errors'
import { createMediaTransferRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'media:write')
    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    let body: Record<string, unknown>
    try { body = await request.json() as Record<string, unknown> } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const result = await beginMediaUploadService({ repository: createMediaTransferRepository() })({
      workspaceId: actor.workspaceId, clientId: actor.clientId, idempotencyKey,
      kind: body.kind as 'video' | 'audio' | 'image', size: body.size as string,
      mimeType: body.mimeType as string, checksum: body.checksum as string,
    })
    return NextResponse.json(presentSuccess({
      upload: {
        id: result.upload.id, kind: result.upload.kind, size: result.upload.byteSize,
        mimeType: result.upload.mimeType, checksum: result.upload.expectedSha256,
        status: result.upload.status, expiresAt: result.upload.expiresAt, createdAt: result.upload.createdAt,
      },
      replayed: result.replayed,
    }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
