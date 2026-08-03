import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  commitBatchEditService,
} from '@/v2/application/batch-edits'
import { DomainError } from '@/v2/domain/errors'
import {
  createBatchEditRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  createPreflightCommitTokenIssuerFromEnvironment,
} from '@/v2/infrastructure/security/preflight-commit-token'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  parseCommitBatchEditBody,
  presentBatchEditCommand,
} from '@/v2/public-api/batch-edit-contract'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ batchId: string; preflightId: string }>
  },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const { batchId, preflightId } = await context.params
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseCommitBatchEditBody(rawBody)
    const result = await commitBatchEditService({
      repository: createBatchEditRepository(),
      tokenIssuer: createPreflightCommitTokenIssuerFromEnvironment(),
      clock: () => new Date(),
      createCommandId: () => `batch-edit-command-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      batchId,
      preflightId,
      ...body,
      actor: actor.auditContext.actor,
      idempotencyKey:
        request.headers.get('idempotency-key')?.trim() ?? '',
    })
    return NextResponse.json(
      presentSuccess({
        command: presentBatchEditCommand(result.command),
        replayed: result.replayed,
      }),
      {
        status: result.replayed ? 200 : 201,
        headers: publicApiHeaders(requestId),
      },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
