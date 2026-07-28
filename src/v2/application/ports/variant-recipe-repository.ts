import type {
  CompatibilityGraphRun,
} from '../../domain/compatibility-graph.ts'
import type {
  VariantRecipeRun,
} from '../../domain/variant-recipe.ts'

export interface VariantRecipeCreateRecord {
  run: Readonly<VariantRecipeRun>
  requestFingerprint: string
  idempotencyKey: string
}

export interface VariantRecipeReplay {
  run: Readonly<VariantRecipeRun>
  requestFingerprint: string
}

export interface VariantRecipePage {
  runs: readonly Readonly<VariantRecipeRun>[]
  nextCursor?: string
}

export interface VariantRecipeRepository {
  loadCreationContext(input: {
    workspaceId: string
    batchId: string
    compatibilityGraphId: string
    expectedCompatibilityGraphRunHash: string
    actorClientId: string
  }): Promise<Readonly<{
    projectId: string
    objective: string
    compatibilityGraph: Readonly<CompatibilityGraphRun>
  }>>
  findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<VariantRecipeReplay> | null>
  create(
    record: Readonly<VariantRecipeCreateRecord>,
  ): Promise<Readonly<{
    run: Readonly<VariantRecipeRun>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }): Promise<Readonly<VariantRecipeRun> | null>
  list(input: {
    workspaceId: string
    batchId: string
    compatibilityGraphId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<VariantRecipePage>>
}
