import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { runWebhookSigningSecretHygieneService } from '@/v2/application/run-webhook-signing-secret-hygiene'
import { DomainError } from '@/v2/domain/errors'
import { createWebhookSigningSecretHygieneRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'webhooks:admin')
    let body: { limitPerKind?: unknown }
    try { body = await request.json() as typeof body } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (
      typeof body !== 'object' || body === null || Array.isArray(body) ||
      Object.keys(body).join(',') !== 'limitPerKind' || typeof body.limitPerKind !== 'number'
    ) throw new DomainError('INVALID_ARGUMENT', 'Request body must contain only limitPerKind')
    const run = runWebhookSigningSecretHygieneService({
      repository: createWebhookSigningSecretHygieneRepository(),
      clock: () => new Date(),
    })
    const result = await run({ workspaceId: actor.workspaceId, limitPerKind: body.limitPerKind })
    return NextResponse.json(presentSuccess(result), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
