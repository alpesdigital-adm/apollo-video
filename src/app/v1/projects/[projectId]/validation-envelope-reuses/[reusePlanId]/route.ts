import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  readValidationEnvelopeReuseService,
} from '@/v2/application/validation-envelopes'
import {
  createValidationEnvelopeRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  presentValidationEnvelopeReuse,
} from '@/v2/public-api/validation-envelope-contract'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      projectId: string
      reusePlanId: string
    }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, reusePlanId } = await context.params
    const reuse = await readValidationEnvelopeReuseService({
      repository: createValidationEnvelopeRepository(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      reusePlanId,
    })
    return NextResponse.json(
      presentSuccess({
        reuse: presentValidationEnvelopeReuse(reuse),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
