import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  catalogSemanticSearchDocumentService,
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
  parseCatalogSemanticSearchBody,
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
    const body = parseCatalogSemanticSearchBody(rawBody)
    const { projectId } = await context.params
    const result = await catalogSemanticSearchDocumentService({
      repository: createSemanticSearchRepository(),
      embeddingProvider: createSemanticEmbeddingProvider({
        environment: actor.environment,
        workspaceId: actor.workspaceId,
        clientId: actor.clientId,
        sandboxExecutions: createSandboxProviderExecutionRepository(),
      }),
      clock: () => new Date(),
      createId: () => `semantic-document-${randomUUID()}`,
    })({
      workspaceId: actor.workspaceId,
      projectId,
      ...body,
      actor,
      idempotencyKey,
    })
    return NextResponse.json(
      presentSuccess({
        document: presentSemanticSearchDocument(result.document),
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
