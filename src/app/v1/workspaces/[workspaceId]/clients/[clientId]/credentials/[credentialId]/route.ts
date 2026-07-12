import { NextRequest, NextResponse } from 'next/server'

import { revokeApiCredentialService } from '@/v2/application/administer-api-clients'
import { requireScope } from '@/v2/application/authenticate-api-client'
import { createApiClientAdministrationRepository } from '@/v2/infrastructure/repository-factory'
import { authenticateExternalRequest } from '@/v2/public-api/authentication'
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from '@/v2/public-api/errors'
import { presentApiCredential, presentSuccess } from '@/v2/public-api/presenters'

export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ workspaceId: string; clientId: string; credentialId: string }>
}

export async function DELETE(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  const requestId = resolveRequestId(request)
  try {
    const actor = await authenticateExternalRequest(request)
    requireScope(actor, 'clients:admin')
    const execute = revokeApiCredentialService({
      repository: createApiClientAdministrationRepository(),
      clock: () => new Date(),
    })
    const credential = await execute({
      actor,
      workspaceId: params.workspaceId,
      targetClientId: params.clientId,
      credentialId: params.credentialId,
    })
    return NextResponse.json(
      presentSuccess({ credential: presentApiCredential(credential) }),
      { headers: publicApiHeaders(requestId) },
    )
  } catch (error) {
    return respondPublicError(error, requestId)
  }
}
