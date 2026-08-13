import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import { directorBudgetService } from '@/v2/application/director-budgets'
import {
  createDirectorToolContextResolver,
  createLocalDirectorProposalServices,
  discoverDirectorToolsService,
  executeDirectorToolsService,
} from '@/v2/application/execute-director-tools'
import { hybridSearchService } from '@/v2/application/hybrid-search'
import { DomainError } from '@/v2/domain/errors'
import { createSemanticEmbeddingProvider } from '@/v2/infrastructure/semantic-embedding-provider'
import {
  createAssetRightsRepository,
  createDirectorBudgetRepository,
  createDirectorRunRepository,
  createSandboxProviderExecutionRepository,
  createSemanticSearchRepository,
} from '@/v2/infrastructure/repository-factory'
import { assertExternalMutationOrigin, authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  parseDirectorToolExecutionBody,
  presentDirectorToolExecution,
} from '@/v2/public-api/director-tools-contract'
import { publicApiHeaders, resolveRequestId, respondPublicError } from '@/v2/public-api/errors'
import { presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    return NextResponse.json(presentSuccess(discoverDirectorToolsService()), {
      headers: publicApiHeaders(requestId),
    })
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'projects:write')
    assertExternalMutationOrigin(request, actor)
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    const body = parseDirectorToolExecutionBody(raw)
    const search = hybridSearchService({
      repository: createSemanticSearchRepository(),
      embeddingProvider: createSemanticEmbeddingProvider({
        environment: actor.environment,
        workspaceId: actor.workspaceId,
        clientId: actor.clientId,
        sandboxExecutions: createSandboxProviderExecutionRepository(),
      }),
      clock: () => new Date(),
    })
    const execute = executeDirectorToolsService({
      contexts: createDirectorToolContextResolver({
        directorRuns: createDirectorRunRepository(),
        budgets: createDirectorBudgetRepository(),
        rights: createAssetRightsRepository(),
        clock: () => new Date(),
      }),
      budgets: directorBudgetService({
        repository: createDirectorBudgetRepository(),
        createId: (kind) => `director-${kind}-${randomUUID()}`,
      }),
      services: createLocalDirectorProposalServices({
        searchMedia: (input) => search({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          scope: 'project',
          text: input.query,
          rightsUse: 'editorial-reuse',
          includeBlocked: false,
          limit: input.limit,
          explain: true,
        }),
      }),
    })
    const result = await execute({
      workspaceId: actor.workspaceId,
      projectId: body.projectId,
      runId: body.runId,
      expectedBudgetRevision: body.baseRevision,
      actor,
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
      calls: body.calls,
    })
    return NextResponse.json(
      presentSuccess(presentDirectorToolExecution(result)),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
