import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { readEditorialBeatSetService } from '@/v2/application/editorial-beats'
import { createEditorialBeatRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; beatSetId: string }> }) {
  const requestId = resolveRequestId(request)
  try { const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:read'); const { projectId, beatSetId } = await context.params; const set = await readEditorialBeatSetService({ repository: createEditorialBeatRepository() })({ workspaceId: actor.workspaceId, projectId, beatSetId }); return NextResponse.json(presentSuccess({ ...set, actor: { clientId: set.actor.clientId } }), { headers: publicApiHeaders(requestId) }) } catch (error) { return respondPublicError(error, requestId) }
}
