import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { confirmSpeechRemovalService } from '@/v2/application/confirm-speech-removal'
import { enqueueProjectProxyRenderAfterCommandService } from '@/v2/application/enqueue-project-proxy-render'
import { DomainError } from '@/v2/domain/errors'
import {
  createColorPipelineCompilationRepository,
  createEditorialCommandRepository,
  createEditorialRequestRepository,
  createProjectProxyRenderRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { presentEditorialCutApplied } from '@/v2/public-api/editorial-cut-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

const FIELDS = ['baseVersionId', 'baseHash', 'sourceTranscriptId', 'variantId', 'subject', 'adjustments', 'reason']
const ADJUSTMENT_FIELDS = ['passageId', 'startSeconds', 'endSeconds']

/** The adjustments a person made to the passages of the proposal: each names a passage and where it starts and ends instead. The service checks them against the proposal. */
function readAdjustments(value: unknown) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64) throw new DomainError('INVALID_ARGUMENT', 'adjustments must be a list of at most 64 passages')
  return value.map((entry): { passageId: string; startSeconds: number; endSeconds: number } => {
    const adjustment = entry as Record<string, unknown> | null
    if (typeof adjustment !== 'object' || adjustment === null || Array.isArray(adjustment) || Object.keys(adjustment).some((key) => !ADJUSTMENT_FIELDS.includes(key)) ||
      typeof adjustment.passageId !== 'string' || typeof adjustment.startSeconds !== 'number' || typeof adjustment.endSeconds !== 'number') {
      throw new DomainError('INVALID_ARGUMENT', 'Each adjustment must be exactly { passageId, startSeconds, endSeconds }')
    }
    return { passageId: adjustment.passageId, startSeconds: adjustment.startSeconds, endSeconds: adjustment.endSeconds }
  })
}

/** Confirms the cut the Apollo proposed for a subject the request asks to take out of the speech (ADR-160). Human approval for agents; the words are the Apollo's. */
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    assertExternalMutationOrigin(request, actor)
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
    if (Object.keys(body).some((key) => !FIELDS.includes(key))) throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    for (const field of ['baseVersionId', 'baseHash', 'sourceTranscriptId', 'variantId', 'subject']) {
      if (typeof body[field] !== 'string') throw new DomainError('INVALID_ARGUMENT', `${field} must be a string`)
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') throw new DomainError('INVALID_ARGUMENT', 'reason must be a string')
    const adjustments = readAdjustments(body.adjustments)
    const { projectId } = await context.params
    const result = await confirmSpeechRemovalService({
      requests: createEditorialRequestRepository(),
      cuts: createEditorialCommandRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
      createEventId: randomUUID,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      baseVersionId: body.baseVersionId as string,
      baseHash: body.baseHash as string,
      sourceTranscriptId: body.sourceTranscriptId as string,
      variantId: body.variantId as string,
      subject: body.subject as string,
      ...(adjustments !== undefined ? { adjustments } : {}),
      ...(typeof body.reason === 'string' && body.reason.trim() ? { reason: body.reason.trim() } : {}),
      actor,
      idempotency: { clientId: actor.clientId, key: idempotencyKey },
    })
    const proxy = await enqueueProjectProxyRenderAfterCommandService({
      projects: createProjectProxyRenderRepository(),
      operations: createPublicOperationRepository(),
      colorPipelines: createColorPipelineCompilationRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      expectedProjectVersionId: result.version.id,
      actor,
      idempotencyKey: `${idempotencyKey}:proxy`,
      traceId: requestId,
    })
    return NextResponse.json(presentSuccess(presentEditorialCutApplied(result, proxy)), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
