import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueProjectDirectorRunService } from '@/v2/application/enqueue-project-director-run'
import { DomainError } from '@/v2/domain/errors'
import {
  createDirectorRunRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  assertExternalMutationOrigin,
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  presentPublicOperationV2,
  presentSuccess,
} from '@/v2/public-api/presenters'
import type { StrategicObjectiveId } from '@/v2/domain/strategic-objective'
import { parseDesiredActionInput } from '@/v2/domain/desired-action'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    assertExternalMutationOrigin(request, actor)
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be an object')
    }
    const record = body as Record<string, unknown>
    if (Object.keys(record).some((key) =>
      !['baseVersionId', 'baseHash', 'reason', 'objective', 'desiredAction'].includes(key))) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    }
    if (
      typeof record.baseVersionId !== 'string' ||
      typeof record.baseHash !== 'string' ||
      (record.reason !== undefined && typeof record.reason !== 'string') ||
      (record.objective !== undefined && typeof record.objective !== 'string')
    ) throw new DomainError('INVALID_ARGUMENT', 'Director operation request is invalid')
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    const { projectId } = await context.params
    const result = await enqueueProjectDirectorRunService({
      directorRuns: createDirectorRunRepository(),
      operations: createPublicOperationRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      baseVersionId: record.baseVersionId,
      baseHash: record.baseHash,
      actor,
      idempotencyKey,
      traceId: requestId,
      ...(record.objective !== undefined
        ? { objective: record.objective as StrategicObjectiveId }
        : {}),
      ...(record.desiredAction !== undefined
        ? { desiredAction: parseDesiredActionInput(record.desiredAction) }
        : {}),
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
    })
    return NextResponse.json(
      presentSuccess({
        operation: presentPublicOperationV2(result.operation, {
          includeProjectId: true,
        }),
        replayed: result.replayed,
      }),
      { status: 202, headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
