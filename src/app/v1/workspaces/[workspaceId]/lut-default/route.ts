import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { readWorkspaceLutDefaultService, setWorkspaceLutDefaultService } from '@/v2/application/workspace-luts'
import { DomainError } from '@/v2/domain/errors'
import { createWorkspaceLutRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseSetWorkspaceLutDefaultBody, presentWorkspaceLutDefault, presentWorkspaceLutDefaultVersion } from '@/v2/public-api/workspace-lut-contract'

export const dynamic = 'force-dynamic'
function workspace(pathId: string, actorId: string) { if (pathId !== actorId) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found') }

export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:read')
    const { workspaceId } = await context.params; workspace(workspaceId, actor.workspaceId)
    const value = await readWorkspaceLutDefaultService({ repository: createWorkspaceLutRepository() })({ workspaceId })
    return NextResponse.json(presentSuccess({ default: presentWorkspaceLutDefault(value) }), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:write')
    const { workspaceId } = await context.params; workspace(workspaceId, actor.workspaceId)
    const body = parseSetWorkspaceLutDefaultBody(await request.json())
    const result = await setWorkspaceLutDefaultService({ repository: createWorkspaceLutRepository(), createVersionId: () => `lut-default-${randomUUID()}` })({
      ...body, workspaceId, actor: actor, idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })
    return NextResponse.json(presentSuccess({ defaultVersion: presentWorkspaceLutDefaultVersion(result.value), replayed: result.replayed }), { status: 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
