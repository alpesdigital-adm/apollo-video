import type { TransformationBrief } from '../../domain/transformation-brief.ts'
import type {
  TransformationProviderDefinition,
  TransformationProviderHealth,
  TransformationProviderSelection,
} from '../../domain/transformation-provider-registry.ts'

export interface TransformationProviderRegistryRepository {
  persistProvider(input: { provider: Readonly<TransformationProviderDefinition> }): Promise<Readonly<{ provider: Readonly<TransformationProviderDefinition>; replayed: boolean }>>
  listProviders(input: { workspaceId: string }): Promise<readonly Readonly<TransformationProviderDefinition>[]>
  persistHealth(input: { health: Readonly<TransformationProviderHealth> }): Promise<Readonly<{ health: Readonly<TransformationProviderHealth>; replayed: boolean }>>
  readLatestHealth(input: { workspaceId: string; providerIds: readonly string[] }): Promise<readonly Readonly<TransformationProviderHealth>[]>
  persistBrief(input: { brief: Readonly<TransformationBrief> }): Promise<Readonly<{ brief: Readonly<TransformationBrief>; replayed: boolean }>>
  readBrief(input: { workspaceId: string; projectId: string; briefId: string }): Promise<Readonly<TransformationBrief> | null>
  persistSelection(input: { selection: Readonly<TransformationProviderSelection> }): Promise<Readonly<{ selection: Readonly<TransformationProviderSelection>; replayed: boolean }>>
  listSelections(input: { workspaceId: string; projectId: string; briefId?: string }): Promise<readonly Readonly<TransformationProviderSelection>[]>
}

