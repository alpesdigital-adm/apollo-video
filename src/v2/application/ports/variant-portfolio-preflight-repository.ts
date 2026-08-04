import type {
  CompatibilityGraphRun,
} from '../../domain/compatibility-graph.ts'
import type {
  ExistingVariantRecipeReference,
  VariantPortfolioPolicy,
  VariantPortfolioPreflightRun,
} from '../../domain/variant-portfolio-preflight.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface VariantPortfolioPreflightCreateRecord {
  run: Readonly<VariantPortfolioPreflightRun>
  requestFingerprint: string
  idempotencyKey: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface VariantPortfolioPreflightReplay {
  run: Readonly<VariantPortfolioPreflightRun>
  requestFingerprint: string
}

export interface VariantPortfolioPreflightPage {
  runs: readonly Readonly<VariantPortfolioPreflightRun>[]
  nextCursor?: string
}

export interface VariantPortfolioPreflightRepository {
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
    batchVariantCount: number
    budgetRemainingMinorUnits: number
    existingRecipes:
      readonly Readonly<ExistingVariantRecipeReference>[]
  }>>
  readPolicy(input: {
    workspaceId: string
  }): Promise<Readonly<VariantPortfolioPolicy> | null>
  ensurePolicy(
    policy: Readonly<VariantPortfolioPolicy>,
  ): Promise<Readonly<VariantPortfolioPolicy>>
  findCreateReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<VariantPortfolioPreflightReplay> | null>
  create(
    record: Readonly<VariantPortfolioPreflightCreateRecord>,
  ): Promise<Readonly<{
    run: Readonly<VariantPortfolioPreflightRun>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    batchId: string
    runId: string
  }): Promise<Readonly<VariantPortfolioPreflightRun> | null>
  list(input: {
    workspaceId: string
    batchId: string
    compatibilityGraphId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<VariantPortfolioPreflightPage>>
}
