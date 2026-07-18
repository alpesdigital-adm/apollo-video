import type { NextRequest } from 'next/server'

import { authenticateApiClientService } from '../application/authenticate-api-client.ts'
import { authenticateUiSessionService } from '../application/authenticate-ui-session.ts'
import type { ApiEnvironment } from '../domain/api-client.ts'
import { DomainError } from '../domain/errors.ts'
import { createApiClientRepository } from '../infrastructure/repository-factory.ts'
import { nodeApiCredentialCrypto } from '../infrastructure/security/api-credential.ts'
import {
  APOLLO_SESSION_COOKIE,
  verifyUiSession,
} from '../infrastructure/security/ui-session.ts'
import {
  capabilitiesForAccess,
  defineCapabilityAccessPolicy,
  type PublicCapability,
} from './capability-registry.ts'

export function resolveApiEnvironment(): ApiEnvironment {
  const configured = process.env.APOLLO_API_ENVIRONMENT
  if (!configured) return process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'
  if (configured !== 'sandbox' && configured !== 'production') {
    throw new DomainError('INVALID_ARGUMENT', 'APOLLO_API_ENVIRONMENT is invalid')
  }
  return configured
}

export async function authenticateExternalRequest(request: NextRequest) {
  const repository = createApiClientRepository()
  const environment = resolveApiEnvironment()
  const authorization = request.headers.get('authorization')
  if (!authorization) {
    return authenticateUiSessionService({ repository, environment })(
      verifyUiSession(request.cookies.get(APOLLO_SESSION_COOKIE)?.value),
    )
  }
  const authenticate = authenticateApiClientService({
    repository,
    credentialCrypto: nodeApiCredentialCrypto,
    clock: () => new Date(),
    environment,
  })

  return authenticate(authorization)
}

export function resolveCapabilityAccessPolicy(
  registry: readonly PublicCapability[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  const raw = environment.APOLLO_API_CAPABILITY_POLICY_JSON?.trim()
  if (!raw) return defineCapabilityAccessPolicy({}, registry)

  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    throw new DomainError(
      'INVALID_CAPABILITY_POLICY',
      'Capability access policy configuration is invalid',
    )
  }
  try {
    return defineCapabilityAccessPolicy(input, registry)
  } catch (error) {
    if (error instanceof DomainError && error.code === 'INVALID_CAPABILITY_POLICY') {
      throw new DomainError(
        'INVALID_CAPABILITY_POLICY',
        'Capability access policy configuration is invalid',
      )
    }
    throw error
  }
}

export async function discoverExternalCapabilities(
  request: NextRequest,
  registry: readonly PublicCapability[],
) {
  const environment = resolveApiEnvironment()
  const actor = request.headers.get('authorization') || request.cookies.has(APOLLO_SESSION_COOKIE)
    ? await authenticateExternalRequest(request)
    : undefined
  return capabilitiesForAccess(registry, {
    environment,
    actor,
    policy: resolveCapabilityAccessPolicy(registry),
  })
}
