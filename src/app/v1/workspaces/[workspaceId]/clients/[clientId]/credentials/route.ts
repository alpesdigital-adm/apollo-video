import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { rotateApiCredentialService } from '@/v2/application/administer-api-clients'
import { requireScope } from '@/v2/application/authenticate-api-client'
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
  params: Promise<{ workspaceId: string; clientId: string }>
}

export async function POST(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'clients:admin')
    const rawBody = await request.text()
    let body: { overlapSeconds?: unknown } = {}
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody) as typeof body
      } catch {
        throw new DomainError('INVALID_ARGUMENT', 'Request body must be valid JSON')
      }
    }
    if (body.overlapSeconds !== undefined && typeof body.overlapSeconds !== 'number') {
      throw new DomainError('INVALID_ARGUMENT', 'overlapSeconds must be a number')
    }

    const execute = rotateApiCredentialService({
      repository: createApiClientAdministrationRepository(),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    })
    const result = await execute({
      actor,
      workspaceId: params.workspaceId,
      targetClientId: params.clientId,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
      overlapSeconds: body.overlapSeconds as number | undefined,
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
