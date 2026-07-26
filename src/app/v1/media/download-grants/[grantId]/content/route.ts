import { NextRequest } from 'next/server'

import { authorizeMediaDownloadGrantService } from '@/v2/application/manage-media-download-grant'
import { readArtifactContentService } from '@/v2/application/read-artifact-content'
import { DomainError } from '@/v2/domain/errors'
import {
  createArtifactContentStorage,
  createMediaArtifactQueryRepository,
  createMediaDownloadGrantRepository,
  createMediaDownloadGrantSignerFromEnvironment,
} from '@/v2/infrastructure/repository-factory'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ grantId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const token = request.nextUrl.searchParams.get('token')?.trim() ?? ''
    const claims = createMediaDownloadGrantSignerFromEnvironment().verify(token)
    const { grantId } = await context.params
    if (claims.grantId !== grantId) {
      throw new DomainError('MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant identity is invalid')
    }
    const authorization = await authorizeMediaDownloadGrantService({
      grants: createMediaDownloadGrantRepository(),
    })({
      workspaceId: claims.workspaceId,
      clientId: claims.clientId,
      grantId,
      token,
    })
    if (authorization.artifactId !== claims.artifactId) {
      throw new DomainError('MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download artifact identity is invalid')
    }
    const content = await readArtifactContentService({
      artifacts: createMediaArtifactQueryRepository(),
      storage: createArtifactContentStorage(),
    })({
      workspaceId: claims.workspaceId,
      artifactId: authorization.artifactId,
      rangeHeader: request.headers.get('range'),
    })
    return new Response(content.body, {
      status: content.partial ? 206 : 200,
      headers: {
        ...publicApiHeaders(requestId),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'Content-Type': content.contentType,
        'Content-Length': String(content.byteSize),
        ETag: content.etag,
        ...(content.partial
          ? { 'Content-Range': `bytes ${content.start}-${content.end}/${content.totalByteSize}` }
          : {}),
      },
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
