import { NextRequest, NextResponse } from 'next/server'

import { receiveMediaUploadContentService } from '@/v2/application/receive-media-upload-content'
import { DomainError } from '@/v2/domain/errors'
import { createLocalMediaUploadStorageFromEnvironment } from '@/v2/infrastructure/media/local-media-upload-storage'
import { createMediaTransferRepository } from '@/v2/infrastructure/repository-factory'
import { createMediaUploadSessionAuthorizerFromEnvironment } from '@/v2/infrastructure/security/media-upload-session-signer'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PUT(request: NextRequest, context: { params: Promise<{ uploadId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const { uploadId } = await context.params
    const tokenValues = request.nextUrl.searchParams.getAll('token')
    const partValues = request.nextUrl.searchParams.getAll('partNumber')
    for (const name of request.nextUrl.searchParams.keys()) {
      if (!['token', 'partNumber'].includes(name)) throw new DomainError('INVALID_ARGUMENT', `${name} is not supported`)
    }
    if (tokenValues.length !== 1 || partValues.length > 1) throw new DomainError('INVALID_ARGUMENT', 'Signed upload URL is invalid')
    const authorization = createMediaUploadSessionAuthorizerFromEnvironment().authorize(tokenValues[0]!)
    if (authorization.uploadId !== uploadId) throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Signed upload target does not match')
    const partNumber = partValues.length === 1 ? Number(partValues[0]) : undefined
    if (authorization.mode === 'single' ? partNumber !== undefined : !Number.isInteger(partNumber)) {
      throw new DomainError('INVALID_ARGUMENT', 'partNumber does not match upload mode')
    }
    const body = request.body
    if (!body) throw new DomainError('INVALID_ARGUMENT', 'Upload body is required')
    const mimeType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    const checksum = request.headers.get('x-apollo-content-sha256')?.trim().toLowerCase() ?? ''
    const contentLengthValue = request.headers.get('content-length')
    const contentLength = contentLengthValue === null ? undefined : Number(contentLengthValue)
    if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength <= 0)) {
      throw new DomainError('INVALID_ARGUMENT', 'Content-Length is invalid')
    }
    const result = await receiveMediaUploadContentService({
      repository: createMediaTransferRepository(),
      storage: createLocalMediaUploadStorageFromEnvironment(),
    })({
      workspaceId: authorization.workspaceId,
      clientId: authorization.clientId,
      uploadId,
      mode: authorization.mode,
      maxParts: authorization.maxParts,
      ...(partNumber !== undefined ? { partNumber } : {}),
      mimeType,
      expectedSha256: checksum,
      body,
      ...(contentLength !== undefined ? { contentLength } : {}),
    })
    return NextResponse.json(presentSuccess(result), { status: 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
