import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createAddMulticamMatchRangeOverrideService } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { derivationVersion } from '@/v2/public-api/capture-derivation-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import {
  parseMatchRangeOverrideBody,
  presentMatchOverrideResult,
} from '@/v2/public-api/multicam-color-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { projectId, sessionId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseMatchRangeOverrideBody(rawBody)
    // `<sessionId>:match:v<n>` is parsed rather than a bare number being
    // accepted, so a fence computed against another session's chain — or
    // against the sync diagnostic when the caller meant the match plan — is
    // refused here instead of matching by accident on the version number.
    const basePlanVersion = derivationVersion(body.baseVersionId, sessionId, 'match', 'baseVersionId')
    const result = await createAddMulticamMatchRangeOverrideService()({
      workspaceId: actor.workspaceId,
      projectId,
      sessionId,
      basePlanVersion,
      basePlanHash: body.baseHash,
      projectBaseVersionId: body.projectBaseVersionId,
      projectBaseHash: body.projectBaseHash,
      override: body.override,
      actor,
    })
    return NextResponse.json(
      presentSuccess(presentMatchOverrideResult(result)),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
