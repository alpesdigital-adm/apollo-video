import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { hybridSearchService } from '@/v2/application/hybrid-search'
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
  parseHybridSearchQueryBody,
  presentSemanticSearchDocument,
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
    requireScope(actor, 'projects:read')
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Request body must be valid JSON',
      )
    }
    const body = parseHybridSearchQueryBody(rawBody)
    const { projectId } = await context.params
    const result = await hybridSearchService({
      repository: createSemanticSearchRepository(),
      embeddingProvider: createSemanticEmbeddingProvider({
        environment: actor.environment,
        workspaceId: actor.workspaceId,
        clientId: actor.clientId,
        sandboxExecutions: createSandboxProviderExecutionRepository(),
      }),
      clock: () => new Date(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
    })
    return NextResponse.json(
      presentSuccess({
        schemaVersion: result.schemaVersion,
        query: result.query,
        queryHash: result.queryHash,
        resultSetHash: result.resultSetHash,
        semantic: result.semantic,
        rerankPolicyVersion: result.rerankPolicyVersion,
        results: result.results.map((entry) => ({
          document: presentSemanticSearchDocument(
            entry.document,
          ),
          score: entry.score,
          scoreBreakdown: entry.scoreBreakdown,
          matchedBy: entry.matchedBy,
          blockedReasons: entry.blockedReasons,
          eligibleForReuse: entry.eligibleForReuse,
          rerankPolicyVersion: entry.rerankPolicyVersion,
        })),
        evaluatedAt: result.evaluatedAt,
      }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
