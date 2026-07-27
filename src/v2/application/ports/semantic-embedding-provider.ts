import type {
  SemanticEmbeddingDescriptor,
} from '../../domain/hybrid-search.ts'

export interface SemanticEmbeddingProvider {
  readonly descriptor: Readonly<SemanticEmbeddingDescriptor>
  embed(input: string): Promise<readonly number[]>
}
