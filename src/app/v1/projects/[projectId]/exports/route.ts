import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { enqueueProjectFinalExportService } from '@/v2/application/enqueue-project-final-export'
import { DomainError } from '@/v2/domain/errors'
import {
  createAssetRightsRepository,
  createProjectFinalExportRepository,
  createPublicOperationRepository,
} from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentPublicOperation, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const body = await request.json() as Record<string, unknown>
    if (Object.keys(body).some((key) => !['projectVersionId', 'projectVersionHash', 'format', 'approval'].includes(key))) {
      throw new DomainError('INVALID_ARGUMENT', 'Request body contains an unsupported field')
    }
    if (
      typeof body.projectVersionId !== 'string' ||
      typeof body.projectVersionHash !== 'string' ||
      typeof body.format !== 'string' ||
      typeof body.approval !== 'object' || body.approval === null || Array.isArray(body.approval)
    ) throw new DomainError('INVALID_ARGUMENT', 'projectVersionId, projectVersionHash, format and approval are required')
    const approval = body.approval as Record<string, unknown>
    if (
      Object.keys(approval).some((key) => !['approved', 'note'].includes(key)) ||
      approval.approved !== true ||
      (approval.note !== undefined && typeof approval.note !== 'string')
    ) throw new DomainError('INVALID_ARGUMENT', 'approval must explicitly confirm the final export')
    const { projectId } = await context.params
    const result = await enqueueProjectFinalExportService({
      projects: createProjectFinalExportRepository(),
      rights: createAssetRightsRepository(),
      operations: createPublicOperationRepository(),
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId: body.projectVersionId,
      projectVersionHash: body.projectVersionHash,
      format: body.format,
      approval: { approved: true, ...(typeof approval.note === 'string' ? { note: approval.note } : {}) },
      actor: { type: 'api-client', id: actor.clientId },
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(presentSuccess({
      operation: presentPublicOperation(result.operation),
      approval: result.context.kind === 'project-final-export' ? result.context.approval : undefined,
      outputSpec: result.context.kind === 'project-final-export' ? result.context.outputSpec : undefined,
      replayed: result.replayed,
    }), { status: 202, headers: publicApiHeaders(requestId) })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
