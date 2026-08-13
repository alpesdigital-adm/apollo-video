import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { putPerceptionTimelineService, readPerceptionTimelineRangeService } from '@/v2/application/perception-timelines'
import { DomainError } from '@/v2/domain/errors'
import { PERCEPTION_KINDS, type PerceptionKind, type PerceptionObservation, type PerceptionRange } from '@/v2/domain/perception-timeline'
import { createPerceptionTimelineRepository } from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

function integer(value: string | null, field: string) {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be a non-negative integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new DomainError('INVALID_ARGUMENT', `${field} is outside the safe integer range`)
  return parsed
}

function kinds(value: string | null): readonly PerceptionKind[] | undefined {
  if (value === null) return undefined
  const parsed = value.split(',')
  if (
    parsed.length < 1 || new Set(parsed).size !== parsed.length ||
    parsed.some((kind) => !PERCEPTION_KINDS.includes(kind as PerceptionKind))
  ) throw new DomainError('INVALID_ARGUMENT', 'kinds contains an unsupported perception kind')
  return Object.freeze(parsed as PerceptionKind[])
}

function requestBody(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
  const body = value as Record<string, unknown>
  const allowed = ['projectVersionId', 'baseRevision', 'durationMs', 'observations', 'coverage']
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
  if (
    typeof body.projectVersionId !== 'string' ||
    !(body.baseRevision === null || typeof body.baseRevision === 'string') ||
    !Number.isSafeInteger(body.durationMs) ||
    !Array.isArray(body.observations) || !Array.isArray(body.coverage)
  ) throw new DomainError('INVALID_ARGUMENT', 'Perception timeline request is invalid')
  return {
    projectVersionId: body.projectVersionId,
    baseRevision: body.baseRevision as string | null,
    durationMs: body.durationMs as number,
    observations: body.observations as PerceptionObservation[],
    coverage: body.coverage as { kind: PerceptionKind; ranges: readonly PerceptionRange[] }[],
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const unsupported = [...request.nextUrl.searchParams.keys()].filter((key) => !['startMs', 'endMs', 'kinds'].includes(key))
    if (unsupported.length) throw new DomainError('INVALID_ARGUMENT', 'Query contains an unsupported parameter')
    for (const key of request.nextUrl.searchParams.keys()) {
      if (request.nextUrl.searchParams.getAll(key).length !== 1) {
        throw new DomainError('INVALID_ARGUMENT', `Query parameter ${key} must be supplied once`)
      }
    }
    const { projectId } = await context.params
    const requestedKinds = kinds(request.nextUrl.searchParams.get('kinds'))
    const result = await readPerceptionTimelineRangeService({ repository: createPerceptionTimelineRepository() })({
      workspaceId: actor.workspaceId,
      projectId,
      ...(request.nextUrl.searchParams.has('startMs') ? { startMs: integer(request.nextUrl.searchParams.get('startMs'), 'startMs') } : {}),
      ...(request.nextUrl.searchParams.has('endMs') ? { endMs: integer(request.nextUrl.searchParams.get('endMs'), 'endMs') } : {}),
      ...(requestedKinds ? { kinds: requestedKinds } : {}),
    })
    return NextResponse.json(presentSuccess(result), { headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    assertExternalMutationOrigin(request, actor)
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    let raw: unknown
    try { raw = await request.json() } catch { throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON') }
    const body = requestBody(raw)
    const { projectId } = await context.params
    const result = await putPerceptionTimelineService({
      repository: createPerceptionTimelineRepository(),
      clock: () => new Date(),
      createId: () => `perception-timeline-${randomUUID()}`,
    })({ workspaceId: actor.workspaceId, projectId, ...body, idempotencyKey, actor })
    return NextResponse.json(presentSuccess({
      id: result.timeline.id,
      projectId: result.timeline.projectId,
      projectVersionId: result.timeline.projectVersionId,
      timeline: result.timeline.timeline,
      createdAt: result.timeline.createdAt,
      replayed: result.replayed,
    }), { status: result.replayed ? 200 : 201, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
