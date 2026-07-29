import type {
  ProofNeedRun,
  ProofNeedResolution,
} from '../../domain/proof-need.ts'

export interface PersistedProofNeedRun extends ProofNeedRun {
  requestFingerprint: string
  idempotencyKey: string
}

export interface ProofNeedRunListQuery {
  workspaceId: string
  projectId: string
  batchId?: string
  targetRecipeId?: string
  resolution?: ProofNeedResolution
  limit: number
  cursor?: string
}

export interface ProofNeedRunPage {
  runs: readonly Readonly<PersistedProofNeedRun>[]
  nextCursor?: string
}

export interface ProofNeedRepository {
  findReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedProofNeedRun> | null>
  create(input: {
    run: Readonly<ProofNeedRun>
    requestFingerprint: string
    idempotencyKey: string
  }): Promise<Readonly<{
    run: Readonly<PersistedProofNeedRun>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    projectId: string
    runId: string
  }): Promise<Readonly<PersistedProofNeedRun> | null>
  list(
    query: Readonly<ProofNeedRunListQuery>,
  ): Promise<Readonly<ProofNeedRunPage>>
}
