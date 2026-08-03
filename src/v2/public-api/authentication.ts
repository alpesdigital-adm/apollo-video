import type { NextRequest } from 'next/server'

import {
  authenticateApiClientService,
  type AuthenticatedExternalActor,
} from '../application/authenticate-api-client.ts'
import { authenticateUiSessionService } from '../application/authenticate-ui-session.ts'
import type { ApiEnvironment } from '../domain/api-client.ts'
import { DomainError } from '../domain/errors.ts'
import { createApiClientRepository, createUiSessionSecurityRepository } from '../infrastructure/repository-factory.ts'
import { nodeApiCredentialCrypto } from '../infrastructure/security/api-credential.ts'
import {
  APOLLO_SESSION_COOKIE,
  uiSessionNonceHash,
  verifyUiSession,
} from '../infrastructure/security/ui-session.ts'
import {
  FOUNDATION_CAPABILITIES,
  assertCapabilityAccess,
  assertPublicCapabilityQuery,
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
  const capability = assertPublicCapabilityQuery(
    request.method,
    request.nextUrl.pathname,
    request.nextUrl.searchParams,
  )
  const environment = resolveApiEnvironment()
  const policy = resolveCapabilityAccessPolicy(FOUNDATION_CAPABILITIES)
  const repository = createApiClientRepository()
  const authorization = request.headers.get('authorization')
  let actor: AuthenticatedExternalActor
  if (!authorization) {
    const sessionToken = verifyUiSession(request.cookies.get(APOLLO_SESSION_COOKIE)?.value)
    actor = await authenticateUiSessionService({ repository, sessions: createUiSessionSecurityRepository(), environment })(
      sessionToken,
      sessionToken ? uiSessionNonceHash(sessionToken) : undefined,
    )
  } else {
    const authenticate = authenticateApiClientService({
      repository,
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date(),
      environment,
    })
    actor = await authenticate(authorization)
  }
  assertCapabilityAccess(FOUNDATION_CAPABILITIES, capability.id, {
    environment,
    actor,
    policy,
  })
  return actor
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
  assertPublicCapabilityQuery(
    request.method,
    request.nextUrl.pathname,
    request.nextUrl.searchParams,
    registry,
  )
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
