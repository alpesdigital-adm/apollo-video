import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  decideValidationEnvelopeReuseService,
} from '@/v2/application/validation-envelopes'
import { DomainError } from '@/v2/domain/errors'
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
  parseValidationEnvelopeApprovalBody,
  presentValidationEnvelopeReuse,
} from '@/v2/public-api/validation-envelope-contract'

export const dynamic = 'force-dynamic'

export async function POST(
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
    requireScope(actor, 'projects:approve')
    const { projectId, reusePlanId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseValidationEnvelopeApprovalBody(rawBody)
    const result = await decideValidationEnvelopeReuseService({
      repository: createValidationEnvelopeRepository(),
      clock: () => new Date(),
      createDecisionId: () =>
        `validation-envelope-decision-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      reusePlanId,
      ...body,
      actor: actor.auditContext.actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        reuse: presentValidationEnvelopeReuse(result),
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
