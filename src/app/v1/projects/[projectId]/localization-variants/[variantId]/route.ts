import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { createLocalizationQueries } from '@/v2/application/localization-queries'
import { PrismaLocalizationQueryRepository } from '@/v2/infrastructure/prisma/localization-query-repository'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; variantId: string }> }) { const requestId = resolveRequestId(request); try { const actor = await authenticateExternalRequest(request); requireScope(actor, 'localization:read'); const { projectId, variantId } = await context.params; const variant = await createLocalizationQueries(new PrismaLocalizationQueryRepository()).readVariant({ workspaceId: actor.workspaceId, projectId, variantId }); return NextResponse.json(presentSuccess({ variant }), { headers: publicApiHeaders(requestId) }) } catch (error) { return respondPublicError(error, requestId) } }
