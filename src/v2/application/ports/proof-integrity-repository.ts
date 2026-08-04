import type {
  ProofIntegrityOutcome,
  ProofIntegrityRun,
} from '../../domain/proof-integrity.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface PersistedProofIntegrityRun
extends ProofIntegrityRun {
  requestFingerprint: string
  idempotencyKey: string
}

export interface ProofIntegrityRunListQuery {
  workspaceId: string
  projectId: string
  proofNeedRunId?: string
  targetRecipeId?: string
  outcome?: ProofIntegrityOutcome
  readyForAssembly?: boolean
  limit: number
  cursor?: string
}

export interface ProofIntegrityRunPage {
  runs: readonly Readonly<PersistedProofIntegrityRun>[]
  nextCursor?: string
}

export interface ProofIntegrityRepository {
  findReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<PersistedProofIntegrityRun> | null>
  create(input: {
    run: Readonly<ProofIntegrityRun>
    requestFingerprint: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<{
    run: Readonly<PersistedProofIntegrityRun>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    projectId: string
    runId: string
  }): Promise<Readonly<PersistedProofIntegrityRun> | null>
  list(
    query: Readonly<ProofIntegrityRunListQuery>,
  ): Promise<Readonly<ProofIntegrityRunPage>>
}
