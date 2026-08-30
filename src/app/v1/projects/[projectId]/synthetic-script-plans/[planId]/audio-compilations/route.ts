import { NextRequest, NextResponse } from 'next/server'

import { DomainError } from '@/v2/domain/errors'
import { createSyntheticBlockAudioCompilationService } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
import {
  parseCompileBlockAudioBody,
  presentBlockConcatenation,
} from '@/v2/public-api/synthetic-script-plan-contract'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string; planId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    const { projectId, planId } = await context.params
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = parseCompileBlockAudioBody(raw)
    const compile = createSyntheticBlockAudioCompilationService()
    const result = await compile({
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId: body.projectVersionId,
      planId,
      baseVersionId: body.baseVersionId,
      baseHash: body.baseHash,
      settings: body.settings,
      use: body.use,
      market: body.market,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        concatenation: presentBlockConcatenation(result.concatenation),
        audioMasterId: result.audioMasterId,
        replayed: result.replayed,
      }),
      { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) },
    )
  } catch (error) { return respondPublicError(error, requestId) }
}
