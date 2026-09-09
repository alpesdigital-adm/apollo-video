import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { materializeActorAuditContext, requireScope } from '@/v2/application/authenticate-api-client'
import { createLocalizationProfileService } from '@/v2/application/localization-persistence'
import { createLocalizationQueries } from '@/v2/application/localization-queries'
import { DomainError } from '@/v2/domain/errors'
import { PrismaLocalizationQueryRepository } from '@/v2/infrastructure/prisma/localization-query-repository'
import { PrismaLocalizationRepository } from '@/v2/infrastructure/prisma/localization-repository'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try { const actor = await authenticateExternalRequest(request); requireScope(actor, 'localization:read'); const profiles = await createLocalizationQueries(new PrismaLocalizationQueryRepository()).listProfiles({ workspaceId: actor.workspaceId }); return NextResponse.json(presentSuccess({ profiles }), { headers: publicApiHeaders(requestId) }) } catch (error) { return respondPublicError(error, requestId) }
}
export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'localization:run'); assertExternalMutationOrigin(request, actor)
    const body = await request.json().catch(() => { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }) as Record<string, unknown>
    if (typeof body.targetLocale !== 'string' || !Array.isArray(body.allowedModes) || body.allowedModes.some((mode) => typeof mode !== 'string') || (body.market !== undefined && typeof body.market !== 'string')) throw new DomainError('INVALID_ARGUMENT', 'Localization profile body is invalid')
    const result = await createLocalizationProfileService({ repository: new PrismaLocalizationRepository() })({ id: `localization-profile-${randomUUID()}`, workspaceId: actor.workspaceId, targetLocale: body.targetLocale, ...(body.market ? { market: body.market as string } : {}), allowedModes: body.allowedModes as never, actorClientId: actor.clientId, idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '', authenticationAudit: materializeActorAuditContext(actor) })
    return NextResponse.json(presentSuccess(result), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
