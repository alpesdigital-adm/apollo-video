import type { NextRequest } from 'next/server'

import {
  authenticateApiClientService,
  type AuthenticatedExternalActor,
} from '../application/authenticate-api-client.ts'
import {
  admitGovernedCapabilityService,
  governanceAnomalyPolicyFromEnvironment,
  governanceDefaultLimitsFromEnvironment,
} from '../application/admit-governed-capability.ts'
import { authenticateUiSessionService } from '../application/authenticate-ui-session.ts'
import type { ApiEnvironment } from '../domain/api-client.ts'
import { DomainError } from '../domain/errors.ts'
import {
  createApiClientRepository,
  createGovernanceAdmissionRepository,
  createUiSessionSecurityRepository,
} from '../infrastructure/repository-factory.ts'
import { nodeApiCredentialCrypto } from '../infrastructure/security/api-credential.ts'
import {
  APOLLO_SESSION_COOKIE,
  isTrustedUiMutationOrigin,
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
import { assertKillSwitchRecoveryAccess } from './kill-switch-access.ts'

export function assertExternalMutationOrigin(
  request: NextRequest,
  actor: AuthenticatedExternalActor,
): void {
  if (actor.authenticationKind !== 'ui-session') return
  const trustProxy = process.env.APOLLO_UI_TRUST_PROXY_HEADERS === 'true'
  const trusted = isTrustedUiMutationOrigin({
    origin: request.headers.get('origin'),
    fetchSite: request.headers.get('sec-fetch-site'),
    host: trustProxy
      ? request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? null
      : request.headers.get('host'),
    protocol: trustProxy
      ? request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? null
      : request.nextUrl.protocol.slice(0, -1),
  })
  if (!trusted) throw new DomainError('AUTH_INVALID', 'UI mutation origin is not authorized')
}

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
  assertKillSwitchRecoveryAccess(actor, capability.id)
  assertCapabilityAccess(FOUNDATION_CAPABILITIES, capability.id, {
    environment,
    actor,
    policy,
  })
  await admitGovernedCapabilityService({
    repository: createGovernanceAdmissionRepository(),
    defaultLimits: governanceDefaultLimitsFromEnvironment(),
    anomalyPolicy: governanceAnomalyPolicyFromEnvironment(),
  })({ actor, capability })
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
