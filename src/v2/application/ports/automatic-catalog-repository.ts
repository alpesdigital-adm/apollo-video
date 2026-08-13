import type { AutomaticCatalogCandidate, AutomaticCatalogRecord } from '../../domain/automatic-catalog.ts'

export interface AutomaticCatalogRepository {
  find(workspaceId: string, artifactId: string): Promise<AutomaticCatalogRecord | null>
  inspect(input: { workspaceId: string; artifactId: string; manifestId: string }): Promise<AutomaticCatalogCandidate | null>
  persist(input: {
    candidate: AutomaticCatalogCandidate
    rightsSnapshotId: string
    rightsSnapshotHash: string
    createdAt: string
  }): Promise<Readonly<{ record: AutomaticCatalogRecord; replayed: boolean }>>
}
