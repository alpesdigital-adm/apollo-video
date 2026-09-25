import type { SyntheticBuildAttestation } from '../../domain/synthetic-build-attestation.ts'

export interface SyntheticBuildAttestationBinding {
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  productionRunId: string
  publicOperationId: string
  planSnapshotId: string
  planSnapshotHash: string
  renderManifestId: string
  renderManifestHash: string
  runtimeCommitSha: string
  runtimeTreeHash: string
  runtimeContractGraphHash: string
  runtimeToolchainHash: string
  runtimeRenderBundleHash: string
  runtimeIdentityHash: string
}

export interface PersistedSyntheticBuildAttestation {
  attestation: Readonly<SyntheticBuildAttestation>
  requestFingerprint: string
  idempotencyKey: string
}

export interface SyntheticBuildAttestationRepository {
  readBinding(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    productionRunId: string
    publicOperationId: string
    renderManifestId: string
  }): Promise<Readonly<SyntheticBuildAttestationBinding> | null>
  findReplay(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSyntheticBuildAttestation> | null>
  create(input: {
    attestation: Readonly<SyntheticBuildAttestation>
    requestFingerprint: string
    idempotencyKey: string
  }): Promise<Readonly<{
    record: Readonly<PersistedSyntheticBuildAttestation>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    projectId: string
    attestationId: string
  }): Promise<Readonly<PersistedSyntheticBuildAttestation> | null>
}

export interface SyntheticBuildAttestationRunner {
  run(input?: { signal?: AbortSignal }): Promise<Readonly<{
    identity: Readonly<{
      commitSha: string
      treeHash: string
      contractGraphHash: string
      toolchainHash: string
      renderBundleHash: string
    }>
    checks: readonly Readonly<{
      code: 'architecture' | 'domain-language' | 'provider-swap' | 'compiler-render-contracts'
      command: string
      exitCode: number
      logHash: string
      startedAt: string
      completedAt: string
    }>[]
    startedAt: string
    completedAt: string
  }>>
}
