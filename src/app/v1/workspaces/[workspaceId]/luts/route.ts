import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { importWorkspaceLutService, listWorkspaceLutsService } from '@/v2/application/workspace-luts'
import { DomainError } from '@/v2/domain/errors'
import { FfmpegLutPreviewGenerator } from '@/v2/infrastructure/media/ffmpeg-lut-preview-generator'
import { createWorkspaceLutRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseImportWorkspaceLutBody, presentWorkspaceLut } from '@/v2/public-api/workspace-lut-contract'

export const dynamic = 'force-dynamic'
function sameWorkspace(pathWorkspaceId: string, actorWorkspaceId: string) {
  if (pathWorkspaceId !== actorWorkspaceId) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
}

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { workspaceId } = await context.params
    sameWorkspace(workspaceId, actor.workspaceId)
    const body = parseImportWorkspaceLutBody(await request.json())
    const result = await importWorkspaceLutService({
      repository: createWorkspaceLutRepository(), preview: new FfmpegLutPreviewGenerator(),
      createVersionId: () => `lut-version-${randomUUID()}`,
    })({ ...body, workspaceId, actor: { type: 'api-client', id: actor.clientId }, idempotencyKey: request.headers.get('idempotency-key') ?? '' })
    return NextResponse.json(presentSuccess({ lut: presentWorkspaceLut(result.value.record), replayed: result.replayed }), { status: 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { workspaceId } = await context.params
    sameWorkspace(workspaceId, actor.workspaceId)
    const rawStatus = request.nextUrl.searchParams.get('status') ?? undefined
    const rawLimit = request.nextUrl.searchParams.get('limit')
    const records = await listWorkspaceLutsService({ repository: createWorkspaceLutRepository() })({ workspaceId, ...(rawStatus ? { status: rawStatus as 'active' | 'inactive' } : {}), ...(rawLimit ? { limit: Number(rawLimit) } : {}) })
    return NextResponse.json(presentSuccess({ items: records.map(presentWorkspaceLut) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
