import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { readWorkspaceLutVersionService } from '@/v2/application/workspace-luts'
import { DomainError } from '@/v2/domain/errors'
import { createWorkspaceLutRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentWorkspaceLutVersion } from '@/v2/public-api/workspace-lut-contract'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string; lutId: string; version: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:read')
    const { workspaceId, lutId, version } = await context.params
    if (workspaceId !== actor.workspaceId) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
    const value = await readWorkspaceLutVersionService({ repository: createWorkspaceLutRepository() })({ workspaceId, lutId, version: Number(version) })
    return NextResponse.json(presentSuccess({ version: presentWorkspaceLutVersion(value) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
