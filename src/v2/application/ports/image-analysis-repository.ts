import type { ImageAnalysis } from '../../domain/image-analysis.ts'
import type { ImageReuseCandidate, ImageReuseReference, ImageReuseSearchQuery } from '../../domain/image-library.ts'

export interface ImageAnalysisRepository {
  find(workspaceId: string, artifactId: string): Promise<Readonly<ImageAnalysis> | null>
  persist(analysis: Readonly<ImageAnalysis>): Promise<Readonly<{ analysis: Readonly<ImageAnalysis>; replayed: boolean }>>
  searchReusable(query: ImageReuseSearchQuery, now: Date): Promise<readonly Readonly<ImageReuseCandidate>[]>
  reuse(input: {
    workspaceId: string
    projectId: string
    artifactId: string
    usage: ImageReuseSearchQuery['usage']
    text: string
    createdAt: string
  }): Promise<Readonly<ImageReuseReference>>
}
