import type {
  ContiguousExtractionResult,
  ContiguousSourceMoment,
} from '../../domain/contiguous-extraction.ts'

export interface PersistedContiguousExtraction {
  result: Readonly<ContiguousExtractionResult>
  requestFingerprint: string
  idempotencyKey: string
  createdBy: Readonly<{
    type: 'api-client'
    id: string
  }>
  createdAt: string
}

export interface ContiguousExtractionRepository {
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    createdByClientId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedContiguousExtraction> | null>
  readCandidateMoments(input: {
    workspaceId: string
    projectId: string
    topic: string
    objective: string
    targetDurationMs: number
    toleranceMs: number
    limit: number
    now: string
  }): Promise<readonly Readonly<ContiguousSourceMoment>[]>
  persist(
    value: Readonly<PersistedContiguousExtraction>,
  ): Promise<Readonly<{
    extraction: Readonly<PersistedContiguousExtraction>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    projectId: string
    extractionId: string
  }): Promise<Readonly<PersistedContiguousExtraction> | null>
}
