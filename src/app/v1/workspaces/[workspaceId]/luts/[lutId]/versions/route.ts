import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { createWorkspaceLutVersionService } from '@/v2/application/workspace-luts'
import { DomainError } from '@/v2/domain/errors'
import { FfmpegLutPreviewGenerator } from '@/v2/infrastructure/media/ffmpeg-lut-preview-generator'
import { createWorkspaceLutRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseCreateWorkspaceLutVersionBody, presentWorkspaceLut } from '@/v2/public-api/workspace-lut-contract'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string; lutId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:write')
    const { workspaceId, lutId } = await context.params
    if (workspaceId !== actor.workspaceId) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
    const body = parseCreateWorkspaceLutVersionBody(await request.json())
    const result = await createWorkspaceLutVersionService({
      repository: createWorkspaceLutRepository(), preview: new FfmpegLutPreviewGenerator(),
      createVersionId: () => `lut-version-${randomUUID()}`,
    })({ ...body, workspaceId, lutId, actor: { type: 'api-client', id: actor.clientId }, idempotencyKey: request.headers.get('idempotency-key') ?? '' })
    return NextResponse.json(presentSuccess({ lut: presentWorkspaceLut(result.value.record), replayed: result.replayed }), { status: 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
