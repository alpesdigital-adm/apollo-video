import { NextRequest } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readArtifactContentService } from '@/v2/application/read-artifact-content'
import { createArtifactContentStorage, createMediaArtifactQueryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'artifacts:read')
    const { artifactId } = await context.params
    const content = await readArtifactContentService({
      artifacts: createMediaArtifactQueryRepository(),
      storage: createArtifactContentStorage(),
    })({ workspaceId: actor.workspaceId, artifactId, rangeHeader: request.headers.get('range') })
    return new Response(content.body, {
      status: content.partial ? 206 : 200,
      headers: {
        ...publicApiHeaders(requestId),
        'Accept-Ranges': 'bytes',
        'Content-Type': content.contentType,
        'Content-Length': String(content.byteSize),
        ETag: content.etag,
        ...(content.partial ? { 'Content-Range': `bytes ${content.start}-${content.end}/${content.totalByteSize}` } : {}),
      },
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
