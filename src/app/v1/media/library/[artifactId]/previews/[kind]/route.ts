import { NextRequest } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { readMediaLibraryPreviewService } from '@/v2/application/read-media-library-preview'
import { DomainError } from '@/v2/domain/errors'
import { createArtifactContentStorage, createMediaArtifactQueryRepository, createMediaLibraryRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, context: { params: Promise<{ artifactId: string; kind: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'artifacts:read')
    const { artifactId, kind } = await context.params
    if (kind !== 'thumbnail' && kind !== 'waveform') throw new DomainError('INVALID_ARGUMENT', 'Preview kind is invalid')
    const content = await readMediaLibraryPreviewService({ library: createMediaLibraryRepository(), artifacts: createMediaArtifactQueryRepository(), storage: createArtifactContentStorage() })({ workspaceId: actor.workspaceId, itemId: artifactId, kind })
    return new Response(content.body, { headers: { ...publicApiHeaders(requestId), 'Cache-Control': 'private, no-store', 'Content-Type': content.contentType, 'Content-Length': String(content.byteSize), ETag: content.etag, 'X-Content-Type-Options': 'nosniff' } })
  } catch (error) { return respondPublicError(error, requestId) }
}
