import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { readWorkspaceLutPreviewService } from '@/v2/application/workspace-luts'
import { DomainError } from '@/v2/domain/errors'
import { createWorkspaceLutRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { resolveRequestId, respondPublicError } from '@/v2/public-api/errors'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string; lutId: string; version: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { workspaceId, lutId, version } = await context.params
    if (workspaceId !== actor.workspaceId) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
    const value = await readWorkspaceLutPreviewService({ repository: createWorkspaceLutRepository() })({ workspaceId, lutId, version: Number(version) })
    return new NextResponse(Buffer.from(value.png), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(value.png.byteLength), etag: `"sha256-${value.sha256}"`, 'cache-control': 'private, max-age=31536000, immutable', 'x-request-id': requestId } })
  } catch (error) { return respondPublicError(error, requestId) }
}
