import { NextRequest, NextResponse } from 'next/server'

import { materializeActorAuditContext, requireScope } from '@/v2/application/authenticate-api-client'
import { calculateCanonicalHash } from '@/v2/domain/canonical-hash'
import { DomainError } from '@/v2/domain/errors'
import { createMusicMontageServices } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import { parseMusicMontageBody, presentMusicMontageRun } from '@/v2/public-api/music-led-montage-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const idempotencyKey = request.headers.get('idempotency-key')?.trim()
    if (!idempotencyKey || idempotencyKey.length > 128) throw new DomainError('INVALID_ARGUMENT', 'A bounded Idempotency-Key header is required')
    const { projectId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseMusicMontageBody(raw)
    const identity = calculateCanonicalHash({ workspaceId: actor.workspaceId, projectId, clientId: actor.clientId, idempotencyKey })
    const result = await createMusicMontageServices().compile({
      ...body, workspaceId: actor.workspaceId, projectId,
      runId: `music-run-${identity.slice(0, 32)}`, planId: `music-plan-${identity.slice(0, 32)}`,
      actorClientId: actor.clientId, idempotencyKey, authenticationAudit: materializeActorAuditContext(actor),
    })
    return NextResponse.json(presentSuccess({ run: presentMusicMontageRun(result.run), replayed: result.replayed }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
