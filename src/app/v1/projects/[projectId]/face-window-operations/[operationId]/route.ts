import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { DomainError } from '@/v2/domain/errors'
import { createFaceWindowEnvelopeRepository, createFaceWindowRequestContextRepository,
  createPublicOperationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentPublicOperationV2, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

/**
 * Completion means a sealed window envelope exists with faceSafety permanently unknown. The registry's verdict on its
 * producer is recomputed on every read and returned beside it, so evidence that is no longer trusted says so.
 */
export async function GET(request: NextRequest,
  context: { params: Promise<{ projectId: string; operationId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:read')
    const { projectId, operationId } = await context.params
    const record = await createPublicOperationRepository().findById(actor.workspaceId, operationId)
    if (!record || record.operation.projectId !== projectId || record.operation.type !== 'perception-face-run' ||
        record.context.kind !== 'perception-face-run' || record.context.detectorProfile !== 'openvino-face0204-v9') {
      throw new DomainError('PUBLIC_OPERATION_NOT_FOUND', 'Face window operation was not found')
    }
    let stored
    if (record.operation.status === 'succeeded') {
      const reference = await createFaceWindowRequestContextRepository().readEnvelopeId({
        workspaceId: actor.workspaceId, projectId, operationId,
      })
      if (!reference || reference.projectVersionId !== record.operation.target.id) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Completed face window has no matching envelope')
      }
      stored = await createFaceWindowEnvelopeRepository().read({
        id: reference.id, workspaceId: actor.workspaceId, projectId,
        inputVersionId: reference.projectVersionId, now: new Date(),
      })
      if (!stored) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed face window envelope is unavailable')
    }
    return NextResponse.json(presentSuccess({
      operation: presentPublicOperationV2(record.operation, { includeProjectId: true }),
      ...(stored ? { envelope: stored.envelope, producerAuthentication: stored.authentication } : {}),
    }), { status: 200, headers: publicApiHeaders(requestId) })
  } catch (error) { return respondPublicError(error, requestId) }
}
