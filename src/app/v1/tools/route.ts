import { NextRequest, NextResponse } from 'next/server'

import { FOUNDATION_CAPABILITIES } from '@/v2/public-api/capability-registry'
import { agentToolsForCapabilities } from '@/v2/public-api/agent-tool-catalog'
import { discoverExternalCapabilities } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const capabilities = await discoverExternalCapabilities(request, FOUNDATION_CAPABILITIES)
    return NextResponse.json(
      presentSuccess({ tools: agentToolsForCapabilities(capabilities) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
