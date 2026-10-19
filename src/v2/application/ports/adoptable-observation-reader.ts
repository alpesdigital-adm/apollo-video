import type { AdoptableObservationV3 } from '../../domain/output-child-command.ts'

/**
 * Reads, for a project, the persisted and observed ingest receipts of the recordings a new plan consumes that its
 * parent State does not observe. A repository implements it over the receipts every ingest persisted; the receipts are
 * verified against their persisted facts and carry the rights evidence of their source. Nothing is adopted by reading.
 */
export interface AdoptableObservationReader {
  readAdoptableObservations(input: Readonly<{
    workspaceId: string
    projectId: string
    sourceArtifactIds: readonly string[]
  }>): Promise<readonly Readonly<AdoptableObservationV3>[]>
}
