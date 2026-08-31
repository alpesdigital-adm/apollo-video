import type { TransformationProviderRegistryRepository } from './ports/transformation-provider-registry-repository.ts'
import { assertTransformationBrief, type TransformationBrief } from '../domain/transformation-brief.ts'
import {
  createTransformationProviderDefinition,
  createTransformationProviderHealth,
  routeTransformationProvider,
  type TransformationProviderDefinition,
  type TransformationProviderHealth,
  type TransformationRoutingPolicy,
} from '../domain/transformation-provider-registry.ts'
import { assertDomain } from '../domain/errors.ts'

export async function registerTransformationProviderService(input: {
  repository: TransformationProviderRegistryRepository
  provider: Parameters<typeof createTransformationProviderDefinition>[0]
}) {
  const provider = createTransformationProviderDefinition(input.provider)
  return input.repository.persistProvider({ provider })
}

export async function recordTransformationProviderHealthService(input: {
  repository: TransformationProviderRegistryRepository
  health: Parameters<typeof createTransformationProviderHealth>[0]
}) {
  const health = createTransformationProviderHealth(input.health)
  const providers = await input.repository.listProviders({ workspaceId: health.workspaceId })
  assertDomain(providers.some((provider) => provider.id === health.providerId), 'INVALID_ARGUMENT', 'Health references an unknown provider')
  return input.repository.persistHealth({ health })
}

export async function persistTransformationBriefService(input: {
  repository: TransformationProviderRegistryRepository
  brief: Readonly<TransformationBrief>
}) {
  return input.repository.persistBrief({ brief: assertTransformationBrief(input.brief) })
}

export async function routeTransformationBriefService(input: {
  repository: TransformationProviderRegistryRepository
  workspaceId: string
  projectId: string
  briefId: string
  policy: Readonly<TransformationRoutingPolicy>
  createdAt: string
}) {
  const brief = await input.repository.readBrief({ workspaceId: input.workspaceId, projectId: input.projectId, briefId: input.briefId })
  assertDomain(brief, 'INVALID_ARGUMENT', 'TransformationBrief was not found')
  const providers = await input.repository.listProviders({ workspaceId: input.workspaceId })
  const health = await input.repository.readLatestHealth({ workspaceId: input.workspaceId, providerIds: providers.map((provider) => provider.id) })
  const selection = routeTransformationProvider({ brief, providers, health, policy: input.policy, createdAt: input.createdAt })
  return input.repository.persistSelection({ selection })
}

export async function listTransformationProvidersService(input: {
  repository: TransformationProviderRegistryRepository
  workspaceId: string
}): Promise<readonly Readonly<TransformationProviderDefinition>[]> {
  return input.repository.listProviders(input)
}

export async function readTransformationProviderHealthService(input: {
  repository: TransformationProviderRegistryRepository
  workspaceId: string
  providerIds: readonly string[]
}): Promise<readonly Readonly<TransformationProviderHealth>[]> {
  return input.repository.readLatestHealth(input)
}

