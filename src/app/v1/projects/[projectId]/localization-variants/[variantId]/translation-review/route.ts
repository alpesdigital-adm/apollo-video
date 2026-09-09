import { NextRequest, NextResponse } from 'next/server'
import { materializeActorAuditContext, requireScope } from '@/v2/application/authenticate-api-client'
import { reviewLocalizationTranslationService } from '@/v2/application/localization-persistence'
import { DomainError } from '@/v2/domain/errors'
import { PrismaLocalizationRepository } from '@/v2/infrastructure/prisma/localization-repository'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string; variantId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'localization:run'); assertExternalMutationOrigin(request, actor)
    if (actor.authenticationKind !== 'ui-session') throw new DomainError('AUTH_SCOPE_REQUIRED', 'Translation review requires an authenticated human session')
    const { projectId, variantId } = await context.params
    const body = await request.json().catch(() => { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }) as Record<string, unknown>
    if (!Number.isSafeInteger(body.expectedRevision) || typeof body.expectedHash !== 'string' || !Array.isArray(body.localizedBlocks)) throw new DomainError('INVALID_ARGUMENT', 'Translation review body is invalid')
    const result = await reviewLocalizationTranslationService({ repository: new PrismaLocalizationRepository() })({ workspaceId: actor.workspaceId, projectId, variantId, expectedRevision: body.expectedRevision as number, expectedHash: body.expectedHash, localizedBlocks: body.localizedBlocks as never, actorClientId: actor.clientId, idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '', authenticationAudit: materializeActorAuditContext(actor) })
    return NextResponse.json(presentSuccess(result), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
