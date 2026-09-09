import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readCaptureProtocolService } from '@/v2/application/capture-protocol'
import { DomainError } from '@/v2/domain/errors'
import { createCaptureProtocolRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentCaptureProtocol } from '@/v2/public-api/capture-protocol-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ protocolId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    for (const name of request.nextUrl.searchParams.keys()) {
      throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported filter`)
    }
    const { protocolId } = await context.params
    const protocol = await readCaptureProtocolService({
      repository: createCaptureProtocolRepository(),
    })({ protocolId })
    return NextResponse.json(
      presentSuccess({ protocol: presentCaptureProtocol(protocol) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
