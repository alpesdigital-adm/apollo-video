import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { listCaptureProtocolsService } from '@/v2/application/capture-protocol'
import { DomainError } from '@/v2/domain/errors'
import { createCaptureProtocolRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  parseCaptureScenario,
  presentCaptureProtocolSummary,
} from '@/v2/public-api/capture-protocol-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const params = request.nextUrl.searchParams
    for (const name of params.keys()) {
      if (name !== 'scenario' || params.getAll(name).length > 1) {
        throw new DomainError('INVALID_ARGUMENT', `${name} is not a supported singular filter`)
      }
    }
    const raw = params.get('scenario')
    const scenario = raw === null ? null : parseCaptureScenario(raw, 'scenario')
    const protocols = await listCaptureProtocolsService({
      repository: createCaptureProtocolRepository(),
    })()
    const selected = scenario === null
      ? protocols
      : protocols.filter((protocol) => protocol.scenario === scenario)
    return NextResponse.json(
      presentSuccess({ protocols: selected.map(presentCaptureProtocolSummary) }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
