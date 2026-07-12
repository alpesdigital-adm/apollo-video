import type { NextRequest } from 'next/server'

import { authenticateApiClientService } from '../application/authenticate-api-client.ts'
import type { ApiEnvironment } from '../domain/api-client.ts'
import { DomainError } from '../domain/errors.ts'
import { createApiClientRepository } from '../infrastructure/repository-factory.ts'
import { nodeApiCredentialCrypto } from '../infrastructure/security/api-credential.ts'

export function resolveApiEnvironment(): ApiEnvironment {
  const configured = process.env.APOLLO_API_ENVIRONMENT
  if (!configured) return process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'
  if (configured !== 'sandbox' && configured !== 'production') {
    throw new DomainError('INVALID_ARGUMENT', 'APOLLO_API_ENVIRONMENT is invalid')
  }
  return configured
}

export async function authenticateExternalRequest(request: NextRequest) {
  const authenticate = authenticateApiClientService({
    repository: createApiClientRepository(),
    credentialCrypto: nodeApiCredentialCrypto,
    clock: () => new Date(),
    environment: resolveApiEnvironment(),
  })

  return authenticate(request.headers.get('authorization'))
}
