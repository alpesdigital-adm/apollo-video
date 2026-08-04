import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  evaluateRetrievalScaleService,
  hybridSearchService,
} from '@/v2/application/hybrid-search'
import { DomainError } from '@/v2/domain/errors'
import {
  createSemanticEmbeddingProvider,
} from '@/v2/infrastructure/semantic-embedding-provider'
import {
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
  parseRetrievalScaleEvaluationBody,
  presentRetrievalScaleEvaluation,
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
    const body = parseRetrievalScaleEvaluationBody(rawBody)
    const { projectId } = await context.params
    const repository = createSemanticSearchRepository()
    const embeddingProvider = createSemanticEmbeddingProvider()
    const clock = () => new Date()
    const search = hybridSearchService({
      repository,
      embeddingProvider,
      clock,
    })
    const result = await evaluateRetrievalScaleService({
      repository,
      search,
      clock,
      monotonicClock: () => performance.now(),
      createId: () => `retrieval-scale-evaluation-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor,
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        evaluation: presentRetrievalScaleEvaluation(result.evaluation),
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
