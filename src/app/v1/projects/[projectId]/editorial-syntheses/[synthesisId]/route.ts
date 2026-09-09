import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { readEditorialSynthesisService } from '@/v2/application/editorial-synthesis'
import { createEditorialSynthesisRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentEditorialSynthesis } from '@/v2/public-api/editorial-synthesis-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * One cut, with every splice justification and the record of which claims kept
 * their qualifiers.
 *
 * The context proof is returned whether or not it found anything, because a
 * proof that only appears on failure cannot be told apart, later, from a check
 * that never ran.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; synthesisId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { synthesisId } = await context.params
    const stored = await readEditorialSynthesisService({
      repository: createEditorialSynthesisRepository(),
    })({ workspaceId: actor.workspaceId, synthesisId })
    return NextResponse.json(
      presentSuccess({
        synthesis: presentEditorialSynthesis(stored.synthesis, stored.createdAt),
      }),
      { status: 200, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
