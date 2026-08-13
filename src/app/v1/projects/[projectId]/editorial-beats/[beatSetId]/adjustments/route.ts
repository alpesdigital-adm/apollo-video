import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { materializeActorAuditContext, requireScope } from '@/v2/application/authenticate-api-client'
import { adjustEditorialBeatService } from '@/v2/application/editorial-beats'
import { DomainError } from '@/v2/domain/errors'
import { createEditorialBeatRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'
export const dynamic = 'force-dynamic'
const FIELDS = new Set(['beatId', 'directorRunId', 'startWordId', 'endWordId', 'reason'])
export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string; beatSetId: string }> }) {
  const requestId = resolveRequestId(request)
  try { const actor = await authenticateExternalRequest(request); requireScope(actor, 'projects:write'); const raw: unknown = await request.json(); if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object'); const input = raw as Record<string, unknown>; if (Object.keys(input).some((key) => !FIELDS.has(key)) || ![input.beatId, input.directorRunId, input.startWordId, input.endWordId, input.reason].every((value) => typeof value === 'string')) throw new DomainError('INVALID_ARGUMENT', 'Editorial beat adjustment request is invalid'); const { projectId, beatSetId } = await context.params; const result = await adjustEditorialBeatService({ repository: createEditorialBeatRepository(), createId: () => `beat-adjustment-${randomUUID()}` })({ workspaceId: actor.workspaceId, projectId, beatSetId, beatId: input.beatId as string, directorRunId: input.directorRunId as string, startWordId: input.startWordId as string, endWordId: input.endWordId as string, reason: input.reason as string, actor: materializeActorAuditContext(actor), idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '' }); return NextResponse.json(presentSuccess({ ...result.adjustment, actor: { clientId: result.adjustment.actor.clientId }, replayed: result.replayed }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) }) } catch (error) { return respondPublicError(error, requestId) }
}
