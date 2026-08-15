import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { readProjectSubtitleConfigurationService, setProjectSubtitleConfigurationService } from '@/v2/application/project-subtitle-configurations'
import { createProjectSubtitleConfigurationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { parseSetProjectSubtitleConfigurationBody, presentProjectSubtitleConfigurationResult } from '@/v2/public-api/project-subtitle-configuration-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try { const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:read'); const { projectId } = await context.params; const variantId = request.nextUrl.searchParams.get('variantId') ?? ''; const value = await readProjectSubtitleConfigurationService({ repository: createProjectSubtitleConfigurationRepository() })({ workspaceId: actor.workspaceId, projectId, variantId }); return NextResponse.json(presentSuccess({ result: value ? presentProjectSubtitleConfigurationResult(value) : null }), { headers: publicApiHeaders(requestId) }) }
  catch (error) { return respondPublicError(error, requestId) }
}
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try { const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:write'); const { projectId } = await context.params; const body = parseSetProjectSubtitleConfigurationBody(await request.json()); const result = await setProjectSubtitleConfigurationService({ repository: createProjectSubtitleConfigurationRepository(), createId: kind => `subtitle-${kind}-${randomUUID()}` })({ ...body, workspaceId: actor.workspaceId, projectId, actor, idempotencyKey: request.headers.get('idempotency-key') ?? '' }); return NextResponse.json(presentSuccess(presentProjectSubtitleConfigurationResult(result)), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) }) }
  // `body` already carries `action` and, for a set, `requested`; the route never
  // resolves a mode itself.
  catch (error) { return respondPublicError(error, requestId) }
}
