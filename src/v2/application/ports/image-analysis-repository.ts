import type { ImageAnalysis } from '../../domain/image-analysis.ts'

export interface ImageAnalysisRepository {
  find(workspaceId: string, artifactId: string): Promise<Readonly<ImageAnalysis> | null>
  persist(analysis: Readonly<ImageAnalysis>): Promise<Readonly<{ analysis: Readonly<ImageAnalysis>; replayed: boolean }>>
}
