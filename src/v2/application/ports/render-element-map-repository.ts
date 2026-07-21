import type { RenderElementMap } from '../../domain/review-system.ts'

export interface PersistedRenderElementMap {
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  proxyArtifactId: string
  mapHash: string
  map: Readonly<RenderElementMap>
  createdAt: string
}

export interface RenderElementMapRepository {
  persistOrReplay(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    proxyArtifactId: string
    map: Readonly<RenderElementMap>
    createdAt: string
  }): Promise<Readonly<{ record: PersistedRenderElementMap; replayed: boolean }>>
  findExact(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    proxyArtifactId: string
  }): Promise<Readonly<PersistedRenderElementMap> | null>
}
