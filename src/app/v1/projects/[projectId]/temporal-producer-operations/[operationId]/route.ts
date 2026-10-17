import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createTemporalProducerEnvelopeRepository, createTemporalProducerRequestContextRepository, createPublicOperationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentPublicOperationV2, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; operationId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, operationId } = await context.params
    const record = await createPublicOperationRepository().findById(actor.workspaceId, operationId)
    if (!record || record.operation.projectId !== projectId || record.operation.type !== 'perception-temporal-run') {
      throw new DomainError('PUBLIC_OPERATION_NOT_FOUND', 'Temporal producer operation was not found')
    }
    let envelope
    if (record.operation.status === 'succeeded') {
      const reference = await createTemporalProducerRequestContextRepository().readEnvelopeId({
        workspaceId: actor.workspaceId, projectId, operationId,
      })
      if (!reference || reference.projectVersionId !== record.operation.target.id) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Completed producer has no matching envelope')
      }
      envelope = await createTemporalProducerEnvelopeRepository().read({
        id: reference.id, workspaceId: actor.workspaceId, projectId,
        inputVersionId: reference.projectVersionId, now: new Date(),
      })
      if (!envelope) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed producer envelope is unavailable')
    }
    return NextResponse.json(presentSuccess({
      operation: presentPublicOperationV2(record.operation, { includeProjectId: true }),
      ...(envelope ? { envelope } : {}),
    }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
