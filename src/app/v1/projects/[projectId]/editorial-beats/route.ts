import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { materializeActorAuditContext, requireScope } from '@/v2/application/authenticate-api-client'
import { deriveEditorialBeatSetService } from '@/v2/application/editorial-beats'
import { DomainError } from '@/v2/domain/errors'
import { createEditorialBeatRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'
const FIELDS = new Set(['projectVersionId', 'transcriptId', 'expectedTranscriptHash', 'signals', 'pauseBoundaryMs', 'maxDurationMs'])
const SIGNAL_FIELDS = new Set(['wordId', 'intent', 'argumentId', 'visualContext'])
function body(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !FIELDS.has(key)) || typeof input.projectVersionId !== 'string' || typeof input.transcriptId !== 'string' || typeof input.expectedTranscriptHash !== 'string' || !Array.isArray(input.signals)) throw new DomainError('INVALID_ARGUMENT', 'Editorial beat request is invalid')
  const signals = input.signals.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `signals[${index}] is invalid`)
    const signal = value as Record<string, unknown>
    if (Object.keys(signal).some((key) => !SIGNAL_FIELDS.has(key)) || typeof signal.wordId !== 'string' || typeof signal.intent !== 'string' || typeof signal.argumentId !== 'string' || typeof signal.visualContext !== 'string') throw new DomainError('INVALID_ARGUMENT', `signals[${index}] is invalid`)
    return { wordId: signal.wordId, intent: signal.intent, argumentId: signal.argumentId, visualContext: signal.visualContext }
  })
  return { projectVersionId: input.projectVersionId, transcriptId: input.transcriptId, expectedTranscriptHash: input.expectedTranscriptHash, signals, ...(input.pauseBoundaryMs !== undefined ? { pauseBoundaryMs: Number(input.pauseBoundaryMs) } : {}), ...(input.maxDurationMs !== undefined ? { maxDurationMs: Number(input.maxDurationMs) } : {}) }
}
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:write')
    const input = body(await request.json()); const { projectId } = await context.params
    const result = await deriveEditorialBeatSetService({ repository: createEditorialBeatRepository(), createId: () => `beat-set-${randomUUID()}` })({ workspaceId: actor.workspaceId, projectId, ...input, actor: materializeActorAuditContext(actor), idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '' })
    return NextResponse.json(presentSuccess({ ...result.set, actor: { clientId: result.set.actor.clientId }, replayed: result.replayed }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
