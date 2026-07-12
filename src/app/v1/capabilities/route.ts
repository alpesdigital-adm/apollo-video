import { NextRequest, NextResponse } from 'next/server'
import { FOUNDATION_CAPABILITIES, capabilitiesForScopes } from '@/v2/public-api/capability-registry'
import { presentCapability, presentSuccess } from '@/v2/public-api/presenters'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)

  try {
    const authorization = request.headers.get('authorization')
    const scopes = authorization
      ? (await authenticateExternalRequest(request)).scopes
      : new Set<string>()
    const capabilities = capabilitiesForScopes(FOUNDATION_CAPABILITIES, scopes).map(
      presentCapability,
    )

    return NextResponse.json(presentSuccess({ capabilities }), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
