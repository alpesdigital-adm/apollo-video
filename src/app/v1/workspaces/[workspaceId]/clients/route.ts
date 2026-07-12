import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { requireScope } from '@/v2/application/authenticate-api-client'
import {
  createApiClientAdministrationService,
  listApiClientsService,
} from '@/v2/application/administer-api-clients'
import type { ApiEnvironment } from '@/v2/domain/api-client'
import { DomainError } from '@/v2/domain/errors'
import { createApiClientAdministrationRepository } from '@/v2/infrastructure/repository-factory'
import { nodeApiCredentialCrypto } from '@/v2/infrastructure/security/api-credential'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentApiClient, presentApiCredential, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: { workspaceId: string }
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'clients:admin')
    const limit = Number(request.nextUrl.searchParams.get('limit') ?? '20')
    const clients = await listApiClientsService({
      repository: createApiClientAdministrationRepository(),
    })({ actor, workspaceId: params.workspaceId, limit })
    return NextResponse.json(
      presentSuccess({ clients: clients.map(presentApiClient) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'clients:admin')
    let body: { name?: unknown; environment?: unknown; scopes?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
    }
    if (typeof body.name !== 'string' || !Array.isArray(body.scopes)) {
      throw new DomainError('INVALID_ARGUMENT', 'name and scopes are required')
    }
    if (!body.scopes.every((scope) => typeof scope === 'string')) {
      throw new DomainError('INVALID_ARGUMENT', 'scopes must contain only strings')
    }
    if (
      body.environment !== undefined &&
      body.environment !== 'sandbox' &&
      body.environment !== 'production'
    ) {
      throw new DomainError('INVALID_ARGUMENT', 'environment is invalid')
    }

    const execute = createApiClientAdministrationService({
      repository: createApiClientAdministrationRepository(),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })
    const result = await execute({
      actor,
      workspaceId: params.workspaceId,
      name: body.name,
      environment: body.environment as ApiEnvironment | undefined,
      scopes: body.scopes as string[],
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
    })

    return NextResponse.json(
      presentSuccess({
        client: presentApiClient(result.client),
        credential: presentApiCredential(result.credential),
        token: result.token,
        secretAvailable: result.secretAvailable,
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
