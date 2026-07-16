import { NextRequest, NextResponse } from 'next/server'

import { FOUNDATION_CAPABILITIES } from '@/v2/public-api/capability-registry'
import { agentToolsForScopes } from '@/v2/public-api/agent-tool-catalog'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const authorization = request.headers.get('authorization')
    const scopes = authorization
      ? (await authenticateExternalRequest(request)).scopes
      : new Set<string>()
    return NextResponse.json(
      presentSuccess({ tools: agentToolsForScopes(FOUNDATION_CAPABILITIES, scopes) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
