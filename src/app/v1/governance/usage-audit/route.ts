import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { listGovernanceUsageAuditService } from '@/v2/application/list-governance-usage-audit'
import { createPublicOperationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'clients:admin')
    const result = await listGovernanceUsageAuditService({ operations: createPublicOperationRepository() })({ workspaceId: actor.workspaceId, limit: Number(request.nextUrl.searchParams.get('limit') ?? '20'), after: request.nextUrl.searchParams.get('after') ?? undefined })
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
