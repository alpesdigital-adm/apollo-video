import type {
  ProofMode,
  ProofModeRun,
} from '../../domain/proof-mode.ts'

export interface PersistedProofModeRun extends ProofModeRun {
  requestFingerprint: string
  idempotencyKey: string
}

export interface ProofModeRunListQuery {
  workspaceId: string
  projectId: string
  proofIntegrityRunId?: string
  format?: '9:16' | '16:9' | '4:5' | '1:1' | '21:9'
  mode?: ProofMode
  manualOverride?: boolean
  limit: number
  cursor?: string
}

export interface ProofModeRunPage {
  runs: readonly Readonly<PersistedProofModeRun>[]
  nextCursor?: string
}

export interface ProofModeRepository {
  findReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedProofModeRun> | null>
  create(input: {
    run: Readonly<ProofModeRun>
    requestFingerprint: string
    idempotencyKey: string
  }): Promise<Readonly<{
    run: Readonly<PersistedProofModeRun>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    projectId: string
    runId: string
  }): Promise<Readonly<PersistedProofModeRun> | null>
  list(
    query: Readonly<ProofModeRunListQuery>,
  ): Promise<Readonly<ProofModeRunPage>>
}
