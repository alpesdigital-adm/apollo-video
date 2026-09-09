import { NextRequest, NextResponse } from 'next/server'
import { materializeActorAuditContext, requireScope } from '@/v2/application/authenticate-api-client'
import { createMusicAnalysisRuntime } from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { presentMusicAnalysisRun } from '@/v2/public-api/music-analysis-contract'
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string; runId: string }> }) { const requestId = resolveRequestId(request); try { const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:write'); assertExternalMutationOrigin(request, actor); const { projectId, runId } = await context.params; const run = await createMusicAnalysisRuntime().runs.cancel({ workspaceId: actor.workspaceId, projectId, runId, now: new Date().toISOString(), authenticationAudit: materializeActorAuditContext(actor) }); return NextResponse.json(presentSuccess({ run: presentMusicAnalysisRun(run) }), { headers: publicApiHeaders(requestId) }) } catch (error) { return respondPublicError(error, requestId) } }
