import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  evaluateHybridRetrievalService,
  hybridSearchService,
} from '@/v2/application/hybrid-search'
import { DomainError } from '@/v2/domain/errors'
import {
  createSemanticEmbeddingProvider,
} from '@/v2/infrastructure/semantic-embedding-provider'
import {
  createSandboxProviderExecutionRepository,
  createSemanticSearchRepository,
} from '@/v2/infrastructure/repository-factory'
import {
  authenticateExternalRequest,
} from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import {
  parseRetrievalEvaluationBody,
  presentRetrievalEvaluation,
} from '@/v2/public-api/hybrid-search-contract'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    const idempotencyKey =
      request.headers.get('idempotency-key')?.trim() ?? ''
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseRetrievalEvaluationBody(rawBody)
    const { projectId } = await context.params
    const repository = createSemanticSearchRepository()
    const embeddingProvider = createSemanticEmbeddingProvider({
      environment: actor.environment,
      workspaceId: actor.workspaceId,
      clientId: actor.clientId,
      sandboxExecutions: createSandboxProviderExecutionRepository(),
    })
    const clock = () => new Date()
    const search = hybridSearchService({
      repository,
      embeddingProvider,
      clock,
    })
    const result = await evaluateHybridRetrievalService({
      repository,
      search,
      clock,
      createId: () => `retrieval-evaluation-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor,
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        evaluation: presentRetrievalEvaluation(result.evaluation),
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
