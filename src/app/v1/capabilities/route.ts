import { NextRequest, NextResponse } from 'next/server'
import { FOUNDATION_CAPABILITIES } from '@/v2/public-api/capability-registry'
import { presentCapability, presentSuccess } from '@/v2/public-api/presenters'
import { discoverExternalCapabilities } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)

  try {
    const capabilities = (await discoverExternalCapabilities(
      request,
      FOUNDATION_CAPABILITIES,
    )).map(presentCapability)

    return NextResponse.json(presentSuccess({ capabilities }), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
