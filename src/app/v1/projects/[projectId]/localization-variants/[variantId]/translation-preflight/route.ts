import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { materializeActorAuditContext, requireScope } from '@/v2/application/authenticate-api-client'
import { preflightLocalizationRunService } from '@/v2/application/localization-translation-worker'
import { DomainError } from '@/v2/domain/errors'
import { PrismaLocalizationRepository } from '@/v2/infrastructure/prisma/localization-repository'
import { PrismaLocalizationRunRepository } from '@/v2/infrastructure/prisma/localization-run-repository'
import { createLocalizationTranslationPricingFromEnvironment, createLocalizationTranslationProviderFromEnvironment } from '@/v2/infrastructure/localization-translation-runtime'
import { createPreflightCommitTokenIssuerFromEnvironment } from '@/v2/infrastructure/security/preflight-commit-token'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string; variantId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'localization:run'); assertExternalMutationOrigin(request, actor)
    const { projectId, variantId } = await context.params
    const body = await request.json().catch(() => { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }) as Record<string, unknown>
    if (!Number.isSafeInteger(body.expectedRevision) || typeof body.expectedHash !== 'string') throw new DomainError('INVALID_ARGUMENT', 'Localization preflight concurrency body is invalid')
    const provider = createLocalizationTranslationProviderFromEnvironment()
    const result = await preflightLocalizationRunService({ localization: new PrismaLocalizationRepository(), runs: new PrismaLocalizationRunRepository(), provider, pricing: createLocalizationTranslationPricingFromEnvironment(), tokenIssuer: createPreflightCommitTokenIssuerFromEnvironment(), createId: randomUUID })({ workspaceId: actor.workspaceId, projectId, variantId, expectedRevision: body.expectedRevision as number, expectedHash: body.expectedHash, actorClientId: actor.clientId, idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '', authenticationAudit: materializeActorAuditContext(actor) })
    return NextResponse.json(presentSuccess(result), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
