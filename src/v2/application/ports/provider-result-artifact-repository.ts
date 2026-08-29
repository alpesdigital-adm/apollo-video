export const PROVIDER_RESULT_ARTIFACT_SCHEMA_VERSION = 'provider-result-artifact/v1' as const

export const PROVIDER_RESULT_ARTIFACT_ROLES = [
  'primary-audio',
  'primary-video',
  'alignment-evidence',
] as const

export type ProviderResultArtifactRole = (typeof PROVIDER_RESULT_ARTIFACT_ROLES)[number]

/**
 * One artifact a provider effect produced, content-addressed and bound to the
 * durable job, the provider's own reference for the effect, and the versioned
 * adapter identity that produced it. A job can own several rows (audio plus
 * alignment evidence), each with a distinct role.
 */
export interface ProviderResultArtifactRecord {
  id: string
  workspaceId: string
  projectId: string
  jobId: string
  schemaVersion: typeof PROVIDER_RESULT_ARTIFACT_SCHEMA_VERSION
  role: ProviderResultArtifactRole
  providerJobRef: string
  artifactId: string
  artifactSha256: string
  byteSize: number
  mediaType: 'audio' | 'video' | 'data'
  container: string
  adapterId: string
  adapterVersion: string
  modelRef?: string
  adapterConfigHash: string
  inputHash: string
  authorizationHash: string
  scriptHash?: string
  observedCost?: Readonly<{ currency: string; costMinorUnits: number }>
  completedAt: string
  createdAt: string
}

export interface ProviderResultArtifactRepository {
  /**
   * Persist every artifact of one provider result atomically, or replay the
   * previously stored rows when the same (jobId, role) set already exists
   * with identical content identity. Divergent replays must fail closed.
   */
  persistOrReplay(input: {
    records: readonly Readonly<ProviderResultArtifactRecord>[]
  }): Promise<Readonly<{ records: readonly Readonly<ProviderResultArtifactRecord>[]; replayed: boolean }>>
  listByJob(input: {
    workspaceId: string
    projectId: string
    jobId: string
  }): Promise<readonly Readonly<ProviderResultArtifactRecord>[]>
}
