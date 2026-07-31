import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { readWorkspaceLutService, setWorkspaceLutStatusService } from '@/v2/application/workspace-luts'
import { DomainError } from '@/v2/domain/errors'
import { createWorkspaceLutRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseSetWorkspaceLutStatusBody, presentWorkspaceLutLifecycle, presentWorkspaceLutStatusCommand } from '@/v2/public-api/workspace-lut-contract'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string; lutId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:read')
    const { workspaceId, lutId } = await context.params
    if (workspaceId !== actor.workspaceId) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
    const record = await readWorkspaceLutService({ repository: createWorkspaceLutRepository() })({ workspaceId, lutId })
    return NextResponse.json(presentSuccess({ lifecycle: presentWorkspaceLutLifecycle(record) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string; lutId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:write')
    const { workspaceId, lutId } = await context.params
    if (workspaceId !== actor.workspaceId) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
    const body = parseSetWorkspaceLutStatusBody(await request.json())
    const result = await setWorkspaceLutStatusService({ repository: createWorkspaceLutRepository(), createCommandId: () => `lut-status-${randomUUID()}` })({
      ...body, workspaceId, lutId, actor: { type: 'api-client', id: actor.clientId }, idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(presentSuccess({ lifecycle: presentWorkspaceLutLifecycle(result.record), command: presentWorkspaceLutStatusCommand(result.command), replayed: result.replayed }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
